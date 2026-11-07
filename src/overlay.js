// AR overlay renderer (Canvas 2D, redrawn every display frame).
import { mapBox } from './vision/tracker.js';

const CYAN = '#3cf0ff', VIOLET = '#9b6bff', GREEN = '#3dffa8', RED = '#ff4d6d';

export function drawOverlay(g, s, view, now) {
  const { f, ox, oy } = view;
  const toScreen = (b) => ({ x: b.x * f + ox, y: b.y * f + oy, w: b.w * f, h: b.h * f });

  if (s.mode === 'confirm' && s.pending) {
    const b = toScreen(mapBox(s.T, s.pending));
    const t = Math.min(1, (now - s.pending.born) / 350);
    drawSelect(g, b, t, now);
    return;
  }
  if (s.mode !== 'counting') return;

  if (s.showDebug && s.lastBoxes) {
    g.strokeStyle = 'rgba(255,255,0,.6)'; g.lineWidth = 1;
    // raw detections are drawn where they were found (frame k), useful to see latency
    for (const b of s.lastBoxes) { const r = toScreen(b); g.strokeRect(r.x, r.y, r.w, r.h); }
  }

  const counted = s.anchors.counted.slice().sort((a, b) => a.id - b.id);
  const order = new Map(counted.map((a, i) => [a, i + 1]));
  const vis = [];

  for (const a of s.anchors.items) {
    // smooth the world-space box (detections jitter a little); projection stays exact
    if (!a.d) a.d = { x: a.x, y: a.y, w: a.w, h: a.h };
    a.d.x += (a.x - a.d.x) * 0.3; a.d.y += (a.y - a.d.y) * 0.3;
    a.d.w += (a.w - a.d.w) * 0.3; a.d.h += (a.h - a.d.h) * 0.3;
    const b = toScreen(mapBox(s.T, a.d));
    if (b.x + b.w < -40 || b.y + b.h < -80 || b.x > g.canvas.clientWidth + 40 || b.y > g.canvas.clientHeight + 40) continue;
    const n = order.get(a);
    if (a.excluded) drawExcluded(g, b);
    else if (n) { drawItem(g, b, n, a, now); vis.push({ a, b }); }
    else drawTentative(g, b);
  }

  // floating product label above the primary item (or the top-most visible item)
  if (!vis.length) return;
  let target = vis.find((v) => v.a.primary) || vis.reduce((p, q) => (q.b.y < p.b.y ? q : p));
  drawLabel(g, s, target.b, counted.length, vis.length, now);
}

function corners(g, b, len, color, lw) {
  const L = Math.min(len, b.w / 3, b.h / 3);
  g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(b.x, b.y + L); g.lineTo(b.x, b.y); g.lineTo(b.x + L, b.y);
  g.moveTo(b.x + b.w - L, b.y); g.lineTo(b.x + b.w, b.y); g.lineTo(b.x + b.w, b.y + L);
  g.moveTo(b.x + b.w, b.y + b.h - L); g.lineTo(b.x + b.w, b.y + b.h); g.lineTo(b.x + b.w - L, b.y + b.h);
  g.moveTo(b.x + L, b.y + b.h); g.lineTo(b.x, b.y + b.h); g.lineTo(b.x, b.y + b.h - L);
  g.stroke();
}

function drawItem(g, b, n, a, now) {
  const age = (now - (a.born || 0)) / 400;
  const pop = age < 1 ? 1 + 0.25 * Math.sin(age * Math.PI) : 1;
  g.save();
  g.fillStyle = a.manual ? 'rgba(61,255,168,.10)' : 'rgba(60,240,255,.08)';
  g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 8); g.fill();
  g.shadowColor = a.manual ? GREEN : CYAN; g.shadowBlur = 12;
  corners(g, b, 16, a.manual ? GREEN : CYAN, 2.5);
  g.restore();

  // pin: stem + numbered bubble floating above the item
  const cx = b.x + b.w / 2, top = b.y;
  const r = 11 * pop, by = top - 18 - r;
  g.save();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(cx, top); g.lineTo(cx, by + r); g.stroke();
  const grad = g.createLinearGradient(cx - r, by - r, cx + r, by + r);
  grad.addColorStop(0, a.manual ? GREEN : CYAN); grad.addColorStop(1, VIOLET);
  g.fillStyle = grad; g.shadowColor = 'rgba(60,240,255,.7)'; g.shadowBlur = 10;
  g.beginPath(); g.arc(cx, by, r, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.fillStyle = '#04121c';
  g.font = `800 ${n > 99 ? 9 : 11}px "Space Grotesk", system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), cx, by + 0.5);
  g.restore();
}

function drawTentative(g, b) {
  g.save();
  g.setLineDash([4, 5]); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.2;
  g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 8); g.stroke();
  g.restore();
}

function drawExcluded(g, b) {
  g.save();
  g.strokeStyle = 'rgba(255,77,109,.75)'; g.lineWidth = 2;
  g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 8); g.stroke();
  const m = Math.min(b.w, b.h) * 0.25, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  g.beginPath(); g.moveTo(cx - m, cy - m); g.lineTo(cx + m, cy + m); g.moveTo(cx + m, cy - m); g.lineTo(cx - m, cy + m); g.stroke();
  g.restore();
}

function drawSelect(g, b, t, now) {
  g.save();
  const pulse = 0.5 + 0.5 * Math.sin(now / 220);
  g.fillStyle = `rgba(155,107,255,${0.12 + 0.08 * pulse})`;
  g.beginPath(); g.roundRect(b.x, b.y, b.w, b.h, 10); g.fill();
  g.shadowColor = VIOLET; g.shadowBlur = 18;
  const e = 1 - (1 - t) ** 3, grow = (1 - e) * 30;
  corners(g, { x: b.x - grow, y: b.y - grow, w: b.w + 2 * grow, h: b.h + 2 * grow }, 22, '#fff', 3);
  g.restore();
}

function drawLabel(g, s, b, total, inView, now) {
  const name = s.label.name || 'Selected product';
  const bob = Math.sin(now / 600) * 2;
  const cx = b.x + b.w / 2;
  const padX = 12, thumb = 40, H = 58;
  g.save();
  g.font = '700 15px "Space Grotesk", system-ui, sans-serif';
  const nameW = Math.min(200, g.measureText(name).width);
  g.font = '800 26px "Space Grotesk", system-ui, sans-serif';
  const cntW = g.measureText(String(total)).width;
  const W = padX * 2 + thumb + 10 + Math.max(nameW, 90) + 14 + cntW + 10;
  const vw = g.canvas.clientWidth;
  let x = Math.max(10, Math.min(vw - W - 10, cx - W / 2));
  let y = b.y - 52 - H + bob;
  if (y < 70) y = 70;

  // leader line from card to the item's pin
  g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1.5; g.setLineDash([3, 4]);
  g.beginPath(); g.moveTo(Math.max(x + 16, Math.min(x + W - 16, cx)), y + H); g.lineTo(cx, b.y - 40); g.stroke();
  g.setLineDash([]);

  // glass card
  g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillStyle = 'rgba(12,16,32,.72)';
  g.beginPath(); g.roundRect(x, y, W, H, 18); g.fill();
  g.shadowColor = 'transparent';
  const border = g.createLinearGradient(x, y, x + W, y + H);
  border.addColorStop(0, CYAN); border.addColorStop(1, VIOLET);
  g.strokeStyle = border; g.lineWidth = 1.5;
  g.beginPath(); g.roundRect(x + 0.75, y + 0.75, W - 1.5, H - 1.5, 17.5); g.stroke();

  // thumbnail
  if (s.label.thumb) {
    g.save();
    g.beginPath(); g.roundRect(x + padX, y + 9, thumb, thumb, 10); g.clip();
    const t = s.label.thumb, k = Math.max(thumb / t.width, thumb / t.height);
    g.drawImage(t, x + padX + (thumb - t.width * k) / 2, y + 9 + (thumb - t.height * k) / 2, t.width * k, t.height * k);
    g.restore();
  }
  const tx = x + padX + thumb + 10;
  g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = '700 15px "Space Grotesk", system-ui, sans-serif';
  g.fillText(ellipsize(g, name, 200), tx, y + 26);
  g.fillStyle = 'rgba(200,215,255,.75)';
  g.font = '500 12px "Inter", system-ui, sans-serif';
  g.fillText(`${inView} in view${s.locked ? ' · locked' : ''}`, tx, y + 44);
  const grad = g.createLinearGradient(x + W - cntW - 20, 0, x + W, 0);
  grad.addColorStop(0, CYAN); grad.addColorStop(1, VIOLET);
  g.fillStyle = grad;
  g.font = '800 26px "Space Grotesk", system-ui, sans-serif';
  g.textAlign = 'right';
  g.fillText(String(total), x + W - padX, y + 38);
  g.restore();
}

function ellipsize(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  while (text.length > 1 && g.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}
