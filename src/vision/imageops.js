// Small, dependency-free image helpers shared by the worker and the main thread.

export function toGray(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

/** Area-averaging resize when shrinking, bilinear when enlarging. */
export function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  if (fx >= 1 && fy >= 1) {
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        let s = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < sh; yy++) {
          const row = yy * sw;
          for (let xx = x0; xx < x1 && xx < sw; xx++) { s += src[row + xx]; n++; }
        }
        out[y * dw + x] = n ? s / n : 0;
      }
    }
    return out;
  }
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = sy | 0, ay = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = sx | 0, ax = sx - x0;
      const i = y0 * sw + x0;
      out[y * dw + x] =
        (src[i] * (1 - ax) + src[i + 1] * ax) * (1 - ay) +
        (src[i + sw] * (1 - ax) + src[i + sw + 1] * ax) * ay;
    }
  }
  return out;
}

const HUE_BINS = 12, SAT_BINS = 3, GRAY_BINS = 4;
export const HIST_SIZE = HUE_BINS * SAT_BINS + GRAY_BINS;

/** Hue/saturation histogram (with separate bins for greys) of a box, normalised to sum 1. */
export function colorHist(rgba, w, h, bx, by, bw, bh) {
  const hist = new Float32Array(HIST_SIZE);
  const x0 = Math.max(0, Math.round(bx)), y0 = Math.max(0, Math.round(by));
  const x1 = Math.min(w, Math.round(bx + bw)), y1 = Math.min(h, Math.round(by + bh));
  const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 600)));
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4;
      const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      const s = mx === 0 ? 0 : d / mx;
      if (s < 0.18 || mx < 0.12) {
        hist[HUE_BINS * SAT_BINS + Math.min(GRAY_BINS - 1, (mx * GRAY_BINS) | 0)]++;
      } else {
        let hue;
        if (mx === r) hue = ((g - b) / d + 6) % 6;
        else if (mx === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        const hb = Math.min(HUE_BINS - 1, ((hue / 6) * HUE_BINS) | 0);
        const sb = Math.min(SAT_BINS - 1, (((s - 0.18) / 0.82) * SAT_BINS) | 0);
        hist[hb * SAT_BINS + sb]++;
      }
      n++;
    }
  }
  if (n) for (let i = 0; i < HIST_SIZE; i++) hist[i] /= n;
  return hist;
}

/** Bhattacharyya coefficient: 1 = identical colour distribution. */
export function histSimilarity(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}

export function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * Guess the bounding box of the object under a tap. Products are made of several
 * colour patches (body, label, logo), so we grow colour regions from seeds around
 * the tap, drop regions that are clearly background (huge, or shelf-wide), union
 * the rest, then pull in further patches found inside that box.
 */
export function boxFromTap(rgba, w, h, px, py) {
  px = Math.max(0, Math.min(w - 1, Math.round(px)));
  py = Math.max(0, Math.min(h - 1, Math.round(py)));
  let u = objectComponent(rgba, w, h, px, py);
  if (!u) u = patchUnion(rgba, w, h, px, py);
  const minSide = Math.min(w, h) * 0.05;
  let box;
  if (u && (u.x1 - u.x0) >= minSide * 0.6 && (u.y1 - u.y0) >= minSide * 0.6) {
    const bw = u.x1 - u.x0 + 1, bh = u.y1 - u.y0 + 1;
    box = { x: u.x0 - bw * 0.04, y: u.y0 - bh * 0.04, w: bw * 1.08, h: bh * 1.08 };
    if (box.w < minSide) { box.x -= (minSide - box.w) / 2; box.w = minSide; }
    if (box.h < minSide) { box.y -= (minSide - box.h) / 2; box.h = minSide; }
  } else {
    const f = Math.round(Math.min(w, h) * 0.16);
    box = { x: px - f / 2, y: py - f * 0.7, w: f, h: f * 1.4 };
  }
  return clampBox(box, w, h);
}

/**
 * Mark "background" (big uniform areas: back wall, shelf edges, price strips), then
 * take the connected blob of non-background pixels under the tap.
 */
function objectComponent(rgba, w, h, px, py) {
  const area = w * h;
  const labels = new Int32Array(w * h);
  const bg = new Uint8Array(w * h);
  let label = 1;
  const bgLabels = new Set();
  const step = Math.max(4, Math.round(Math.min(w, h) / 40));
  for (let y = step >> 1; y < h; y += step) for (let x = step >> 1; x < w; x += step) {
    if (labels[y * w + x]) continue;
    const l = label++;
    const r = grow(rgba, w, h, x, y, 24, area, labels, l);
    if (r.count > area * 0.03 || (r.x1 - r.x0) > w * 0.4 || (r.y1 - r.y0) > h * 0.6) {
      bgLabels.add(l);
    }
  }
  for (let i = 0; i < labels.length; i++) if (bgLabels.has(labels[i])) bg[i] = 1;
  // close 1-2 px seams (blurred edges between big areas) so blobs don't leak into each other
  dilate(bg, w, h); dilate(bg, w, h);
  // start from the tap, or the nearest non-background pixel
  let sx = -1, sy = -1;
  for (let r = 0; r <= 6 && sx < 0; r++) for (let dy = -r; dy <= r && sx < 0; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = px + dx, y = py + dy;
    if (x >= 0 && y >= 0 && x < w && y < h && !bg[y * w + x]) { sx = x; sy = y; break; }
  }
  if (sx < 0) return null;
  const seen = new Uint8Array(w * h);
  const stack = [sy * w + sx]; seen[sy * w + sx] = 1;
  let count = 0, x0 = sx, x1 = sx, y0 = sy, y1 = sy;
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    if (++count > area * 0.12) return null;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (x > 0 && !seen[p - 1] && !bg[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
    if (x < w - 1 && !seen[p + 1] && !bg[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !seen[p - w] && !bg[p - w]) { seen[p - w] = 1; stack.push(p - w); }
    if (y < h - 1 && !seen[p + w] && !bg[p + w]) { seen[p + w] = 1; stack.push(p + w); }
  }
  if ((x1 - x0) > w * 0.45 || (y1 - y0) > h * 0.6 || count < 12) return null;
  // undo the dilation shrink
  return { x0: Math.max(0, x0 - 2), y0: Math.max(0, y0 - 2), x1: Math.min(w - 1, x1 + 2), y1: Math.min(h - 1, y1 + 2) };
}

function dilate(m, w, h) {
  const src = m.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (src[i]) continue;
    if ((x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) m[i] = 1;
  }
}

/** Fallback when products touch each other: union of small colour patches near the tap. */
function patchUnion(rgba, w, h, px, py) {
  const area = w * h, maxA = area * 0.08;
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const accepted = [];
  const ok = (r) => r.count >= 6 && r.count <= maxA && (r.x1 - r.x0) < w * 0.5 && (r.y1 - r.y0) < h * 0.6;
  const seedAt = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h || labels[y * w + x]) return null;
    const r = grow(rgba, w, h, x, y, 30, maxA * 1.2, labels, nextLabel++);
    return ok(r) ? r : null;
  };
  const d = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (const [dx, dy] of [[0, 0], [-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, d], [-d, d], [d, -d]]) {
    const r = seedAt(px + dx, py + dy);
    if (r) accepted.push(r);
  }
  if (!accepted.length) return null;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const r of accepted) { x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
  return { x0, y0, x1, y1 };
}

function grow(rgba, w, h, px, py, tol, limit, labels, label) {
  // seed colour = mean of 3x3 around the seed
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = Math.min(w - 1, Math.max(0, px + dx)), y = Math.min(h - 1, Math.max(0, py + dy));
    const i = (y * w + x) * 4; sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; sn++;
  }
  sr /= sn; sg /= sn; sb /= sn;
  const tol2 = tol * tol;
  const stack = [py * w + px];
  labels[py * w + px] = label;
  let count = 0, x0 = px, x1 = px, y0 = py, y1 = py;
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p / w) | 0;
    count++;
    if (count > limit) break;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const q of nb) {
      if (q < 0 || labels[q]) continue;
      const i = q * 4;
      const dr = rgba[i] - sr, dg = rgba[i + 1] - sg, db = rgba[i + 2] - sb;
      if (dr * dr + dg * dg + db * db <= tol2) { labels[q] = label; stack.push(q); }
    }
  }
  return { count, x0, x1, y0, y1 };
}

export function clampBox(b, w, h) {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, w: Math.max(4, Math.min(w, b.x + b.w) - x), h: Math.max(4, Math.min(h, b.y + b.h) - y) };
}

export function cropRGBA(rgba, w, h, box) {
  const bx = Math.round(box.x), by = Math.round(box.y);
  const bw = Math.max(1, Math.round(box.w)), bh = Math.max(1, Math.round(box.h));
  const out = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    const sy = Math.min(h - 1, by + y);
    for (let x = 0; x < bw; x++) {
      const sx = Math.min(w - 1, bx + x);
      const si = (sy * w + sx) * 4, di = (y * bw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
  }
  return { rgba: out, w: bw, h: bh };
}
