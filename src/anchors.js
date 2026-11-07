// World-anchored item bookkeeping. Detections arrive (with some latency) in the
// coordinates of the frame they were computed on; we convert them to world
// coordinates using that frame's camera transform, merge them with existing
// anchors, and the renderer projects anchors into the current frame.
import { invert, mapBox } from './vision/tracker.js';
import { iou } from './vision/imageops.js';

let nextId = 1;

export class AnchorSet {
  constructor() { this.reset(); }

  reset() {
    this.items = [];
  }

  /** Items that count toward the total. */
  get counted() {
    return this.items.filter((a) => !a.excluded && (a.manual || a.hits >= 2));
  }

  /**
   * @param boxes detections in frame-k working coordinates
   * @param Tk    world -> frame-k transform at capture time
   * @param W,H   working frame size
   */
  ingest(boxes, Tk, W, H) {
    const inv = invert(Tk);
    const obs = boxes.map((b) => ({ ...mapBox(inv, b), score: b.score }));
    const used = new Set();
    // expected: anchors whose centre was inside frame k
    for (const a of this.items) {
      const p = mapBox(Tk, a);
      // only fully-visible anchors can be "missed": edge items are often not detected
      const m = 2;
      a._visible = p.x > m && p.y > m && p.x + p.w < W - m && p.y + p.h < H - m;
    }
    // greedy association by IoU (in world space)
    const pairs = [];
    for (let i = 0; i < this.items.length; i++) for (let j = 0; j < obs.length; j++) {
      const v = iou(this.items[i], obs[j]);
      if (v > 0.2) pairs.push([v, i, j]);
    }
    pairs.sort((p, q) => q[0] - p[0]);
    const matchedA = new Set();
    for (const [, i, j] of pairs) {
      if (matchedA.has(i) || used.has(j)) continue;
      matchedA.add(i); used.add(j);
      const a = this.items[i], o = obs[j];
      const k = a.hits < 3 ? 0.5 : 0.25;
      a.x += (o.x - a.x) * k; a.y += (o.y - a.y) * k;
      a.w += (o.w - a.w) * k; a.h += (o.h - a.h) * k;
      a.hits++; a.misses = 0; a.score = o.score;
    }
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i];
      if (matchedA.has(i) || !a._visible || a.manual) continue;
      a.misses++;
    }
    this.items = this.items.filter((a) => a.manual || a.primary || a.excluded || !(a.misses >= (a.hits >= 4 ? 10 : 4)));
    for (let j = 0; j < obs.length; j++) {
      if (used.has(j)) continue;
      // don't spawn a duplicate right on top of an existing anchor
      if (this.items.some((a) => iou(a, obs[j]) > 0.15)) continue;
      this.items.push({ id: nextId++, ...obs[j], hits: 1, misses: 0, born: performance.now() });
    }
    // merge anchors that drifted onto each other (keep the better-established one)
    const drop = new Set();
    for (let i = 0; i < this.items.length; i++) for (let j = i + 1; j < this.items.length; j++) {
      const a = this.items[i], b = this.items[j];
      if (drop.has(a) || drop.has(b) || iou(a, b) < 0.35) continue;
      const keepA = a.manual || a.primary || (!b.manual && !b.primary && a.hits >= b.hits);
      drop.add(keepA ? b : a);
    }
    if (drop.size) this.items = this.items.filter((a) => !drop.has(a));
  }

  /** Tap on an existing anchor toggles exclusion; returns the anchor or null. */
  hitTest(wx, wy) {
    let best = null, bd = Infinity;
    for (const a of this.items) {
      if (wx < a.x || wy < a.y || wx > a.x + a.w || wy > a.y + a.h) continue;
      const d = Math.hypot(wx - (a.x + a.w / 2), wy - (a.y + a.h / 2));
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  addManual(box) {
    const a = { id: nextId++, ...box, hits: 99, misses: 0, manual: true, born: performance.now() };
    this.items.push(a);
    return a;
  }
}
