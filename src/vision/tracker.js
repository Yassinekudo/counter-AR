// Camera-motion tracker. Every camera frame it follows ~60 feature points with
// pyramidal Lucas-Kanade optical flow and fits a similarity transform
// (pan, zoom, roll) between consecutive frames. Chaining those transforms gives a
// stable "world" coordinate frame: AR labels stored in world coordinates stay
// glued to the shelf while the phone moves.

/** Similarity transform: x' = a*x - b*y + tx ; y' = b*x + a*y + ty */
export const IDENTITY = { a: 1, b: 0, tx: 0, ty: 0 };

export function apply(T, x, y) {
  return [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty];
}
export function compose(A, B) { // A after B
  return {
    a: A.a * B.a - A.b * B.b,
    b: A.b * B.a + A.a * B.b,
    tx: A.a * B.tx - A.b * B.ty + A.tx,
    ty: A.b * B.tx + A.a * B.ty + A.ty,
  };
}
export function invert(T) {
  const s = T.a * T.a + T.b * T.b;
  const a = T.a / s, b = -T.b / s;
  return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty) };
}
export function scaleOf(T) { return Math.hypot(T.a, T.b); }
export function mapBox(T, box) {
  const [cx, cy] = apply(T, box.x + box.w / 2, box.y + box.h / 2);
  const s = scaleOf(T);
  return { x: cx - (box.w * s) / 2, y: cy - (box.h * s) / 2, w: box.w * s, h: box.h * s };
}

const GRID_X = 10, GRID_Y = 8, WIN = 4, ITERS = 8;

export class MotionTracker {
  constructor() { this.reset(); }

  reset() {
    this.prev = null; // pyramid of previous frame
    this.world = { ...IDENTITY }; // world -> current frame
    this.quality = 1;
  }

  /**
   * @param {Float32Array} gray  tracking-resolution grayscale frame
   * @param {number} scaleToWork multiply tracker coords by this to get working coords
   * @returns {{a,b,tx,ty}} world->current-frame transform in working coordinates
   */
  update(gray, w, h, scaleToWork) {
    const pyr = buildPyramid(gray, w, h);
    if (this.prev && this.prev[0].w === w && this.prev[0].h === h) {
      const pts = pickFeatures(this.prev[0]);
      const src = [], dst = [];
      for (const [x, y] of pts) {
        const r = trackPoint(this.prev, pyr, x, y);
        if (r) { src.push(x, y); dst.push(r[0], r[1]); }
      }
      const fit = ransacSimilarity(src, dst);
      if (fit && fit.inliers >= 6) {
        // tracker coords -> working coords
        const T = { a: fit.T.a, b: fit.T.b, tx: fit.T.tx * scaleToWork, ty: fit.T.ty * scaleToWork };
        this.world = compose(T, this.world);
        this.quality = this.quality * 0.8 + 0.2 * Math.min(1, fit.inliers / 20);
      } else {
        this.quality *= 0.8;
      }
    }
    this.prev = pyr;
    return this.world;
  }
}

function buildPyramid(g, w, h) {
  const levels = [grad({ img: g, w, h })];
  let cur = levels[0];
  for (let l = 1; l < 3; l++) {
    const nw = cur.w >> 1, nh = cur.h >> 1;
    if (nw < 24 || nh < 24) break;
    const out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * cur.w + 2 * x;
      out[y * nw + x] = (cur.img[i] + cur.img[i + 1] + cur.img[i + cur.w] + cur.img[i + cur.w + 1]) * 0.25;
    }
    cur = grad({ img: out, w: nw, h: nh });
    levels.push(cur);
  }
  return levels;
}

function grad(L) {
  const { img, w, h } = L;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (img[i + 1] - img[i - 1]) * 0.5;
    gy[i] = (img[i + w] - img[i - w]) * 0.5;
  }
  L.gx = gx; L.gy = gy;
  return L;
}

/** Best corner (min eigenvalue proxy) in each grid cell. */
function pickFeatures(L) {
  const { w, h, gx, gy } = L;
  const pts = [];
  const cw = (w - 2 * (WIN + 2)) / GRID_X, ch = (h - 2 * (WIN + 2)) / GRID_Y;
  for (let gyi = 0; gyi < GRID_Y; gyi++) for (let gxi = 0; gxi < GRID_X; gxi++) {
    let best = 40, bx = -1, by = -1;
    const x0 = Math.round(WIN + 2 + gxi * cw), y0 = Math.round(WIN + 2 + gyi * ch);
    for (let y = y0; y < y0 + ch; y += 2) for (let x = x0; x < x0 + cw; x += 2) {
      let sxx = 0, syy = 0, sxy = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = (y + dy) * w + x + dx;
        sxx += gx[i] * gx[i]; syy += gy[i] * gy[i]; sxy += gx[i] * gy[i];
      }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const minEig = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      if (minEig > best) { best = minEig; bx = x; by = y; }
    }
    if (bx >= 0) pts.push([bx, by]);
  }
  return pts;
}

function sample(img, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - ax) + img[i + 1] * ax) * (1 - ay) + (img[i + w] * (1 - ax) + img[i + w + 1] * ax) * ay;
}

/** Pyramidal Lucas-Kanade for one point. Returns new position or null if lost. */
function trackPoint(P, Q, x, y) {
  let dx = 0, dy = 0;
  for (let l = P.length - 1; l >= 0; l--) {
    const A = P[l], B = Q[l], s = 1 / (1 << l);
    const px = x * s, py = y * s;
    dx *= 2; dy *= 2;
    if (l === P.length - 1) { dx = 0; dy = 0; }
    let sxx = 0, syy = 0, sxy = 0;
    const n = (2 * WIN + 1) ** 2;
    const tg = new Float32Array(n), tgx = new Float32Array(n), tgy = new Float32Array(n);
    let k = 0;
    for (let wy = -WIN; wy <= WIN; wy++) for (let wx = -WIN; wx <= WIN; wx++, k++) {
      tg[k] = sample(A.img, A.w, A.h, px + wx, py + wy);
      const gxv = sample(A.gx, A.w, A.h, px + wx, py + wy), gyv = sample(A.gy, A.w, A.h, px + wx, py + wy);
      tgx[k] = gxv; tgy[k] = gyv;
      sxx += gxv * gxv; syy += gyv * gyv; sxy += gxv * gyv;
    }
    const det = sxx * syy - sxy * sxy;
    if (det < 1e-3) return null;
    for (let it = 0; it < ITERS; it++) {
      let bx = 0, by = 0; k = 0;
      for (let wy = -WIN; wy <= WIN; wy++) for (let wx = -WIN; wx <= WIN; wx++, k++) {
        const diff = tg[k] - sample(B.img, B.w, B.h, px + wx + dx, py + wy + dy);
        bx += diff * tgx[k]; by += diff * tgy[k];
      }
      const ux = (syy * bx - sxy * by) / det, uy = (sxx * by - sxy * bx) / det;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < 0.0009) break;
    }
  }
  const nx = x + dx, ny = y + dy;
  const L = Q[0];
  if (nx < WIN || ny < WIN || nx > L.w - WIN - 1 || ny > L.h - WIN - 1) return null;
  // residual check
  let err = 0;
  for (let wy = -WIN; wy <= WIN; wy += 2) for (let wx = -WIN; wx <= WIN; wx += 2) {
    err += Math.abs(sample(P[0].img, L.w, L.h, x + wx, y + wy) - sample(L.img, L.w, L.h, nx + wx, ny + wy));
  }
  if (err / 25 > 22) return null;
  return [nx, ny];
}

function fitLS(src, dst, idx) {
  let n = 0, sx = 0, sy = 0, dx = 0, dy = 0;
  for (const i of idx) { sx += src[2 * i]; sy += src[2 * i + 1]; dx += dst[2 * i]; dy += dst[2 * i + 1]; n++; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (const i of idx) {
    const ux = src[2 * i] - sx, uy = src[2 * i + 1] - sy, vx = dst[2 * i] - dx, vy = dst[2 * i + 1] - dy;
    num1 += ux * vx + uy * vy; num2 += ux * vy - uy * vx; den += ux * ux + uy * uy;
  }
  if (den < 1e-6) return null;
  const a = num1 / den, b = num2 / den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

function ransacSimilarity(src, dst) {
  const n = src.length / 2;
  if (n < 4) return null;
  const all = [...Array(n).keys()];
  let best = null, bestIn = [];
  const thr2 = 1.2 * 1.2;
  for (let it = 0; it < 40; it++) {
    const i = (Math.random() * n) | 0;
    let j = (Math.random() * n) | 0;
    if (i === j) j = (j + 1) % n;
    const T = fitLS(src, dst, [i, j]);
    if (!T) continue;
    const s = Math.hypot(T.a, T.b);
    if (s < 0.8 || s > 1.25) continue;
    const inl = [];
    for (let k = 0; k < n; k++) {
      const px = T.a * src[2 * k] - T.b * src[2 * k + 1] + T.tx;
      const py = T.b * src[2 * k] + T.a * src[2 * k + 1] + T.ty;
      if ((px - dst[2 * k]) ** 2 + (py - dst[2 * k + 1]) ** 2 < thr2) inl.push(k);
    }
    if (inl.length > bestIn.length) { bestIn = inl; best = T; }
  }
  // also try pure-translation hypothesis from all points (robust for tiny motions)
  if (!best) return null;
  const T = fitLS(src, dst, bestIn.length >= 3 ? bestIn : all) || best;
  return { T, inliers: bestIn.length };
}
