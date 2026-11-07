// Demo mode: a procedurally drawn store shelf "filmed" by a moving virtual camera.
// Lets you try the whole app on a laptop (or test it) without a real camera.
// The stream is a genuine 60 fps MediaStream, so the app uses it exactly like a camera.

export const DEMO_PRODUCTS = [
  { key: 'cola', name: 'Fizz Cola 330ml', w: 62, h: 118, body: '#d7262e', band: '#ffffff', text: 'FIZZ', tc: '#ffffff', shape: 'can' },
  { key: 'cereal', name: 'Sunny Oats', w: 104, h: 150, body: '#f6b419', band: '#1d3fb8', text: 'OATS', tc: '#1d3fb8', shape: 'box' },
  { key: 'water', name: 'Alpine Water 1L', w: 58, h: 168, body: '#9fd8f2', band: '#0a5c9e', text: 'AQUA', tc: '#ffffff', shape: 'bottle' },
  { key: 'tea', name: 'Green Leaf Tea', w: 92, h: 112, body: '#1c7a45', band: '#e8f2c4', text: 'TEA', tc: '#1c7a45', shape: 'box' },
  { key: 'chips', name: 'Crunch Chips', w: 96, h: 132, body: '#6a2bbf', band: '#ffd400', text: 'CRUNCH', tc: '#6a2bbf', shape: 'bag' },
];

// shelf layout: [productKey, count] per shelf row
const LAYOUT = [
  [['cola', 9], ['tea', 5]],
  [['cereal', 6], ['chips', 5]],
  [['water', 10], ['cola', 4]],
];

const WORLD_W = 1900, ROW_H = 260, WORLD_H = LAYOUT.length * ROW_H + 120;

export function demoCounts() {
  const c = {};
  for (const row of LAYOUT) for (const [k, n] of row) c[k] = (c[k] || 0) + n;
  return c;
}

function drawProduct(g, p, x, y) {
  g.save();
  g.translate(x, y);
  const { w, h } = p;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, shade(p.body, -0.25));
  grad.addColorStop(0.35, shade(p.body, 0.15));
  grad.addColorStop(1, shade(p.body, -0.35));
  g.fillStyle = grad;
  g.beginPath();
  if (p.shape === 'bottle') {
    g.moveTo(w * 0.36, 0); g.lineTo(w * 0.64, 0); g.lineTo(w * 0.64, h * 0.12);
    g.quadraticCurveTo(w, h * 0.2, w, h * 0.32); g.lineTo(w, h); g.lineTo(0, h); g.lineTo(0, h * 0.32);
    g.quadraticCurveTo(0, h * 0.2, w * 0.36, h * 0.12); g.closePath();
  } else if (p.shape === 'can') {
    g.roundRect(0, 0, w, h, [10, 10, 6, 6]);
  } else if (p.shape === 'bag') {
    g.moveTo(0, 6); g.lineTo(w, 6); g.lineTo(w - 4, h); g.lineTo(4, h); g.closePath();
  } else g.rect(0, 0, w, h);
  g.fill();
  // label band
  g.fillStyle = p.band;
  g.fillRect(p.shape === 'bottle' ? 0 : 4, h * 0.42, w - (p.shape === 'bottle' ? 0 : 8), h * 0.26);
  g.fillStyle = p.tc === p.band ? '#000' : p.tc;
  g.font = `900 ${Math.round(Math.min(w / (p.text.length * 0.62), h * 0.17))}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = p.band === '#ffffff' || p.band === '#e8f2c4' || p.band === '#ffd400' ? p.body : '#fff';
  g.fillText(p.text, w / 2, h * 0.55);
  // logo dot + stripes for texture
  g.fillStyle = p.band;
  g.beginPath(); g.arc(w / 2, h * 0.24, Math.min(w, h) * 0.13, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(w * 0.12, h * 0.05, w * 0.08, h * 0.9);
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(0, h * 0.8, w, h * 0.05);
  g.restore();
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
  const t = k < 0 ? 0 : 255, f = Math.abs(k);
  r = Math.round(r + (t - r) * f); gg = Math.round(gg + (t - gg) * f); b = Math.round(b + (t - b) * f);
  return `rgb(${r},${gg},${b})`;
}

const INSTANCES = [];
function buildWorld() {
  INSTANCES.length = 0;
  const c = document.createElement('canvas');
  c.width = WORLD_W; c.height = WORLD_H;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, WORLD_H);
  bg.addColorStop(0, '#d9d4c7'); bg.addColorStop(1, '#bdb6a6');
  g.fillStyle = bg; g.fillRect(0, 0, WORLD_W, WORLD_H);
  // back-panel pegboard texture helps tracking like a real store wall
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 12; y < WORLD_H; y += 24) for (let x = 12; x < WORLD_W; x += 24) g.fillRect(x, y, 3, 3);
  const byKey = Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.key, p]));
  LAYOUT.forEach((row, r) => {
    const base = 60 + (r + 1) * ROW_H;
    let x = 50;
    for (const [k, n] of row) {
      const p = byKey[k];
      for (let i = 0; i < n; i++) {
        drawProduct(g, p, x, base - p.h - 14);
        INSTANCES.push({ key: k, x, y: base - p.h - 14, w: p.w, h: p.h });
        x += p.w + 12;
      }
      x += 46;
    }
    // shelf plank + price strip
    g.fillStyle = '#3b3f46'; g.fillRect(0, base - 14, WORLD_W, 22);
    g.fillStyle = '#f2f2f2'; g.fillRect(0, base + 8, WORLD_W, 20);
    g.fillStyle = '#222';
    for (let x2 = 60; x2 < WORLD_W; x2 += 180) { g.font = '700 13px system-ui'; g.fillText('€' + (1 + ((x2 * 7) % 9) + 0.99).toFixed(2), x2, base + 23); }
  });
  return c;
}

/** Returns { stream, stop } — a 60 fps MediaStream of a camera panning across the shelf. */
export function startDemoStream({ width = 1280, height = 720 } = {}) {
  const world = buildWorld();
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  let raf = 0, running = true, view = null;
  const t0 = performance.now();
  const draw = (now) => {
    if (!running) return;
    const t = (now - t0) / 1000;
    // viewport ~62% of world width (portrait: ~34%), gently panning / zooming / swaying like a hand-held phone
    const zoom = 1.0 + 0.08 * Math.sin(t * 0.31);
    const vw = (WORLD_W * (height > width ? 0.36 : 0.62)) / zoom, vh = vw * (height / width);
    let cx = WORLD_W / 2 + (WORLD_W - vw) * 0.5 * Math.sin(t * 0.22) + 6 * Math.sin(t * 2.3);
    let cy = WORLD_H / 2 + (WORLD_H - vh) * 0.45 * Math.sin(t * 0.17 + 1) + 4 * Math.cos(t * 2.9);
    cx = Math.max(vw / 2, Math.min(WORLD_W - vw / 2, cx));
    cy = Math.max(vh / 2, Math.min(WORLD_H - vh / 2, cy));
    g.drawImage(world, cx - vw / 2, cy - vh / 2, vw, vh, 0, 0, width, height);
    view = { x0: cx - vw / 2, y0: cy - vh / 2, k: width / vw };
    // subtle vignette + sensor noise
    const v = g.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.9);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.28)');
    g.fillStyle = v; g.fillRect(0, 0, width, height);
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  const stream = c.captureStream(60);
  return {
    stream,
    /** Ground truth for tests: video-pixel boxes of a product currently in frame. */
    locate(key) {
      if (!view) return [];
      return INSTANCES.map((i, id) => ({ ...i, id })).filter((i) => i.key === key).map((i) => ({ id: i.id, x: (i.x - view.x0) * view.k, y: (i.y - view.y0) * view.k, w: i.w * view.k, h: i.h * view.k }))
        .filter((b) => b.x > 0 && b.y > 0 && b.x + b.w < width && b.y + b.h < height);
    },
    pause(v) { running = !v; if (!v) raf = requestAnimationFrame(draw); },
    stop() { running = false; cancelAnimationFrame(raf); stream.getTracks().forEach((tr) => tr.stop()); },
  };
}
