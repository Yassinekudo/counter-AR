// Vision worker: finds every item on the frame that matches the selected product.
// Runs off the main thread so the camera and AR overlay stay at full frame rate.
//
// Pipeline per frame:
//   1. grayscale + integral images
//   2. multi-scale normalised cross-correlation (NCC) against each exemplar
//   3. peak picking + colour-histogram verification
//   4. non-maximum suppression
import { toGray, resizeGray, colorHist, histSimilarity, iou } from './imageops.js';

/** @type {{w:number,h:number,gray:Float32Array,hist:Float32Array}[]} */
let exemplars = [];

const NARROW = [0.8, 0.9, 1.0, 1.12, 1.25];
const WIDE = [0.6, 0.7, 0.8, 0.9, 1.0, 1.12, 1.25, 1.4, 1.6];
let SCALES = NARROW;
const COARSE_SIDE = 12; // template's short side in the coarse search image

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'setExemplars') {
    SCALES = msg.wide ? WIDE : NARROW;
    exemplars = msg.exemplars.map((ex) => {
      const rgba = new Uint8ClampedArray(ex.rgba);
      return { w: ex.w, h: ex.h, gray: toGray(rgba, ex.w, ex.h), hist: colorHist(rgba, ex.w, ex.h, 0, 0, ex.w, ex.h) };
    });
    self.postMessage({ type: 'ready' });
  } else if (msg.type === 'detect') {
    const t0 = performance.now();
    const rgba = new Uint8ClampedArray(msg.rgba);
    const boxes = exemplars.length ? detect(rgba, msg.w, msg.h, msg.sensitivity ?? 0.5) : [];
    self.postMessage({ type: 'detections', frameId: msg.frameId, boxes, ms: performance.now() - t0 });
  }
};

function detect(rgba, W, H, sensitivity) {
  const gray = toGray(rgba, W, H);
  // NCC threshold: higher sensitivity -> lower threshold -> more matches.
  const nccThr = 0.8 - 0.3 * sensitivity;
  const histThr = 0.74 - 0.24 * sensitivity;
  let cands = [];

  for (const ex of exemplars) {
    const s = Math.min(1, COARSE_SIDE / Math.min(ex.w, ex.h));
    const fw = Math.max(8, Math.round(W * s));
    const fh = Math.max(8, Math.round(H * s));
    const small = resizeGray(gray, W, H, fw, fh);
    const integ = integrals(small, fw, fh);

    for (const k of SCALES) {
      const tw = Math.round(ex.w * s * k);
      const th = Math.round(ex.h * s * k);
      if (tw < 5 || th < 5 || tw >= fw || th >= fh) continue;
      const tmpl = normTemplate(resizeGray(ex.gray, ex.w, ex.h, tw, th));
      if (!tmpl) continue;
      const map = nccMap(small, fw, fh, integ, tmpl, tw, th);
      const mw = fw - tw + 1;
      const mh = fh - th + 1;
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          const v = map[y * mw + x];
          if (v < nccThr) continue;
          if (!isLocalMax(map, mw, mh, x, y, v)) continue;
          const bx = x / s, by = y / s, bw = tw / s, bh = th / s;
          const hs = histSimilarity(ex.hist, colorHist(rgba, W, H, bx, by, bw, bh));
          if (hs < histThr) continue;
          cands.push({ x: bx, y: by, w: bw, h: bh, score: 0.6 * v + 0.4 * hs });
        }
      }
    }
  }
  return nms(cands, 0.3);
}

function integrals(img, w, h) {
  const W1 = w + 1;
  const sum = new Float64Array(W1 * (h + 1));
  const sq = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      rs += v; rq += v * v;
      const i = (y + 1) * W1 + x + 1;
      sum[i] = sum[i - W1] + rs;
      sq[i] = sq[i - W1] + rq;
    }
  }
  return { sum, sq, W1 };
}

function normTemplate(t) {
  const n = t.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += t[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (t[i] - m) ** 2;
  if (v / n < 25) return null; // texture-less template: NCC meaningless
  const d = Math.sqrt(v);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (t[i] - m) / d;
  return out;
}

function nccMap(img, w, h, { sum, sq, W1 }, t, tw, th) {
  const mw = w - tw + 1, mh = h - th + 1, n = tw * th;
  const out = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const a = y * W1 + x, b = a + tw, c = (y + th) * W1 + x, d = c + tw;
      const s = sum[d] - sum[b] - sum[c] + sum[a];
      const q = sq[d] - sq[b] - sq[c] + sq[a];
      const varN = q - (s * s) / n;
      if (varN < n * 16) { out[y * mw + x] = -1; continue; }
      let acc = 0, ti = 0;
      for (let yy = 0; yy < th; yy++) {
        let p = (y + yy) * w + x;
        for (let xx = 0; xx < tw; xx++) acc += t[ti++] * img[p++];
      }
      out[y * mw + x] = acc / Math.sqrt(varN);
    }
  }
  return out;
}

function isLocalMax(map, mw, mh, x, y, v) {
  for (let dy = -2; dy <= 2; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= mh) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      if ((dx || dy) && xx >= 0 && xx < mw && map[yy * mw + xx] > v) return false;
    }
  }
  return true;
}

function overlapSmall(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / Math.min(a.w * a.h, b.w * b.h);
}

function nms(c, thr) {
  c.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of c) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let ok = true;
    for (const k of keep) {
      const inside = cx > k.x && cx < k.x + k.w && cy > k.y && cy < k.y + k.h;
      if (inside || iou(b, k) > thr || overlapSmall(b, k) > 0.35) { ok = false; break; }
    }
    if (ok) keep.push(b);
  }
  return keep;
}
