// Scanner engine: camera frames -> motion tracking -> matching (worker) -> world anchors -> AR overlay.
import { MotionTracker, apply, invert, mapBox, IDENTITY } from './vision/tracker.js';
import { boxFromTap, cropRGBA, clampBox } from './vision/imageops.js';
import { AnchorSet } from './anchors.js';
import { drawOverlay } from './overlay.js';

const WORK_LONG = 384; // working resolution (long side) for vision

export class Scanner {
  constructor(video, canvas, { onState } = {}) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onState = onState || (() => {});
    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d', { willReadFrequently: true });
    this.tracker = new MotionTracker();
    this.anchors = new AnchorSet();
    this.worker = new Worker(new URL('./vision/vision.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data);
    this.mode = 'select'; // 'select' | 'confirm' | 'counting'
    this.sensitivity = 0.5;
    this.locked = false;
    this.showDebug = false;
    this.exemplars = [];
    this.history = new Map();
    this.frameId = 0;
    this.busy = false;
    this.T = { ...IDENTITY };
    this.stats = { camFps: 0, uiFps: 0, detectMs: 0, quality: 1 };
    this._camCount = 0; this._uiCount = 0; this._statT = performance.now();
    this.pending = null; // selection box (working coords) awaiting confirmation
    this.primaryId = null;
    this.label = { name: '', thumb: null };
    this.running = false;
  }

  start() {
    this.running = true;
    const v = this.video;
    const onFrame = () => {
      if (!this.running) return;
      this._processFrame();
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
    const loop = (t) => {
      if (!this.running) return;
      if (!v.requestVideoFrameCallback) this._processFrame();
      this._render(t);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.worker.terminate();
  }

  // ---------- frame pipeline ----------
  _processFrame() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return;
    const k = WORK_LONG / Math.max(v.videoWidth, v.videoHeight);
    const W = Math.round(v.videoWidth * k) & ~1, H = Math.round(v.videoHeight * k) & ~1;
    if (this.work.width !== W || this.work.height !== H) {
      this.work.width = W; this.work.height = H;
      this.tracker.reset();
    }
    this.W = W; this.H = H; this.k = k;
    this.wctx.drawImage(v, 0, 0, W, H);
    const img = this.wctx.getImageData(0, 0, W, H);
    this.rgba = img.data;
    this._camCount++;

    if (this.mode !== 'select' || this.pending) {
      // half-res grayscale for motion tracking
      const tw = W >> 1, th = H >> 1, d = img.data;
      const g = new Float32Array(tw * th);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const i = (2 * y * W + 2 * x) * 4, j = i + W * 4;
        g[y * tw + x] = (d[i] + d[i + 4] + d[j] + d[j + 4]) * 0.0745 + (d[i + 1] + d[i + 5] + d[j + 1] + d[j + 5]) * 0.1465 + (d[i + 2] + d[i + 6] + d[j + 2] + d[j + 6]) * 0.0285;
      }
      this.T = this.tracker.update(g, tw, th, 2);
      this.stats.quality = this.tracker.quality;
    }
    const id = ++this.frameId;
    this.history.set(id, this.T);
    if (this.history.size > 240) this.history.delete(id - 240);

    if (this.mode === 'counting' && !this.busy && !this.locked && this.exemplars.length) {
      this.busy = true;
      const buf = img.data.buffer.slice(0);
      this.worker.postMessage({ type: 'detect', frameId: id, w: W, h: H, rgba: buf, sensitivity: this.sensitivity }, [buf]);
    }
  }

  _onWorker(m) {
    if (m.type !== 'detections') return;
    this.busy = false;
    this.stats.detectMs = this.stats.detectMs * 0.8 + m.ms * 0.2;
    const Tk = this.history.get(m.frameId);
    if (!Tk || this.mode !== 'counting' || this.locked) return;
    this.lastBoxes = m.boxes;
    this.lastBoxesT = Tk;
    const before = this.anchors.counted.length;
    this.anchors.ingest(m.boxes, Tk, this.W, this.H);
    const after = this.anchors.counted.length;
    if (after !== before) this._emit({ countChanged: after - before });
  }

  _emit(extra = {}) {
    const counted = this.anchors.counted;
    const inView = counted.filter((a) => this._isVisible(a)).length;
    this.onState({ mode: this.mode, count: counted.length, inView, locked: this.locked, ...extra });
  }

  _isVisible(a) {
    const p = mapBox(this.T, a);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    return cx > 0 && cy > 0 && cx < this.W && cy < this.H;
  }

  // ---------- coordinates ----------
  _view() {
    const r = this.canvas.getBoundingClientRect();
    const v = this.video;
    const sc = Math.max(r.width / v.videoWidth, r.height / v.videoHeight);
    const ox = (r.width - v.videoWidth * sc) / 2, oy = (r.height - v.videoHeight * sc) / 2;
    // working -> screen factor
    const f = sc / this.k;
    return { r, f, ox, oy };
  }
  screenToWork(sx, sy) {
    const { r, f, ox, oy } = this._view();
    return [(sx - r.left - ox) / f, (sy - r.top - oy) / f];
  }

  // ---------- user actions ----------
  /** Tap (or drag box) during selection. Returns a preview data URL of the crop. */
  selectAt(sx, sy, sx2, sy2) {
    if (!this.rgba) return null;
    let box;
    const [x, y] = this.screenToWork(sx, sy);
    if (sx2 != null) {
      const [x2, y2] = this.screenToWork(sx2, sy2);
      box = clampBox({ x: Math.min(x, x2), y: Math.min(y, y2), w: Math.abs(x2 - x), h: Math.abs(y2 - y) }, this.W, this.H);
    } else {
      box = boxFromTap(this.rgba, this.W, this.H, x, y);
    }
    this.tracker.reset();
    this.T = { ...IDENTITY };
    this.pending = { ...box, crop: cropRGBA(this.rgba, this.W, this.H, box), born: performance.now() };
    this.mode = 'confirm';
    this._emit();
    return cropToDataURL(this.pending.crop);
  }

  cancelSelection() {
    this.pending = null;
    this.mode = 'select';
    this._emit();
  }

  /** Begin counting from the pending selection (world frame = frame at selection time). */
  confirmSelection(name) {
    const p = this.pending;
    if (!p) return null;
    this.label = { name, thumb: cropToImage(p.crop) };
    this.anchors.reset();
    // pending box is in the frame at selection time; tracker world == that frame
    const a = this.anchors.addManual({ x: p.x, y: p.y, w: p.w, h: p.h });
    a.manual = false; a.hits = 2; a.primary = true;
    this.primaryId = a.id;
    this.exemplars = [p.crop];
    this._sendExemplars(false);
    this.pending = null;
    this.mode = 'counting';
    this._emit();
    return { crop: p.crop, dataURL: cropToDataURL(p.crop) };
  }

  /** Start counting a saved product straight away. */
  async startWithTemplate(name, dataURL) {
    const crop = await dataURLToCrop(dataURL);
    this.label = { name, thumb: cropToImage(crop) };
    this.anchors.reset();
    this.tracker.reset();
    this.T = { ...IDENTITY };
    this.primaryId = null;
    this.exemplars = [crop];
    this._sendExemplars(true);
    this.mode = 'counting';
    this._emit();
  }

  _sendExemplars(wide) {
    this.wide = wide || this.wide;
    this.worker.postMessage({
      type: 'setExemplars', wide: this.wide,
      exemplars: this.exemplars.map((c) => ({ w: c.w, h: c.h, rgba: c.rgba.buffer.slice(0) })),
    });
  }

  /** Tap during counting: toggle an item off/on, or add a missed one. */
  tapCounting(sx, sy) {
    const [x, y] = this.screenToWork(sx, sy);
    const [wx, wy] = apply(invert(this.T), x, y);
    const hit = this.anchors.hitTest(wx, wy);
    if (hit) {
      if (hit.manual && !hit.primary) this.anchors.items = this.anchors.items.filter((a) => a !== hit);
      else hit.excluded = !hit.excluded;
      this._emit({ countChanged: hit.excluded ? -1 : 1 });
      return hit.excluded ? 'removed' : 'restored';
    }
    // add a missed item, sized like the typical counted item
    const ref = this.anchors.counted[0];
    const w = ref ? ref.w : 30, h = ref ? ref.h : 50;
    const added = this.anchors.addManual({ x: wx - w / 2, y: wy - h / 2, w, h });
    // also learn from it so similar misses get found automatically
    if (this.exemplars.length < 4 && this.rgba) {
      const box = clampBox(mapBox(this.T, added), this.W, this.H);
      this.exemplars.push(cropRGBA(this.rgba, this.W, this.H, box));
      this._sendExemplars();
    }
    this._emit({ countChanged: 1 });
    return 'added';
  }

  setLocked(v) { this.locked = v; this._emit(); }

  rescan() {
    this.anchors.items = this.anchors.items.filter((a) => a.primary || a.manual);
    this._emit();
  }

  newSelection() {
    this.anchors.reset();
    this.exemplars = [];
    this.wide = false;
    this.pending = null;
    this.locked = false;
    this.mode = 'select';
    this._emit();
  }

  /** JPEG of camera + AR layer as seen on screen, at most maxW pixels wide. */
  snapshot(maxW = 480) {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const k = Math.min(1, maxW / cw);
    const c = document.createElement('canvas');
    c.width = Math.round(cw * k); c.height = Math.round(ch * k);
    const g = c.getContext('2d');
    const { f, ox, oy } = this._view();
    const sc = f * this.k;
    try {
      g.drawImage(this.video, ox * k, oy * k, this.video.videoWidth * sc * k, this.video.videoHeight * sc * k);
      g.drawImage(this.canvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.75);
    } catch { return undefined; }
  }

  // ---------- rendering ----------
  _render(now) {
    this._uiCount++;
    if (now - this._statT > 1000) {
      const dt = (now - this._statT) / 1000;
      this.stats.camFps = Math.round(this._camCount / dt);
      this.stats.uiFps = Math.round(this._uiCount / dt);
      this._camCount = 0; this._uiCount = 0; this._statT = now;
      if (this.mode === 'counting') this._emit();
    }
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(c.clientWidth * dpr), ch = Math.round(c.clientHeight * dpr);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    if (!this.W || !this.video.videoWidth) return;
    drawOverlay(this.ctx, this, this._view(), now);
  }
}

// ---------- helpers ----------
export function cropToDataURL(crop) {
  const c = document.createElement('canvas');
  c.width = crop.w; c.height = crop.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(crop.rgba), crop.w, crop.h), 0, 0);
  return c.toDataURL('image/png');
}
function cropToImage(crop) {
  const c = document.createElement('canvas');
  c.width = crop.w; c.height = crop.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(crop.rgba), crop.w, crop.h), 0, 0);
  return c;
}
async function dataURLToCrop(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, rgba: g.getImageData(0, 0, c.width, c.height).data };
}
