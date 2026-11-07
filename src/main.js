import { store } from './store.js';
import { Scanner } from './scanner.js';
import { openCamera, stopStream } from './camera.js';
import { startDemoStream, DEMO_PRODUCTS } from './demo/shelfSim.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- navigation ----------------
function go(id) {
  $$('.screen').forEach((s) => s.toggleAttribute('data-active', s.id === id));
  if (id === 'menu') renderMenu();
  if (id === 'library') renderLibrary();
  if (id === 'history') renderHistory();
  if (id === 'settings') renderSettings();
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
const buzz = (ms = 12) => store.settings.haptics && navigator.vibrate?.(ms);

// ---------------- menu ----------------
function renderMenu() {
  const s = store.stats();
  $('#menu-stats').innerHTML = [
    [s.products, 'products'], [s.scans, 'counts saved'], [s.last ? s.last.count : '–', s.last ? esc(s.last.name) : 'last count'],
  ].map(([b, l]) => `<div class="stat glass"><b>${b}</b><small>${l}</small></div>`).join('');
}

// ---------------- scanner session ----------------
const session = { scanner: null, stream: null, demo: null, product: null, template: null, count: 0 };

async function startScan({ demo = false, product = null } = {}) {
  await endScan();
  go('scan');
  $('#cam-error').hidden = true;
  const video = $('#video');
  try {
    if (demo) {
      session.demo = startDemoStream(innerHeight > innerWidth ? { width: 720, height: 1280 } : { width: 1280, height: 720 });
      session.stream = session.demo.stream;
    } else {
      session.stream = await openCamera({ fps: store.settings.fps, resolution: store.settings.resolution });
    }
  } catch (err) {
    $('#cam-error-text').textContent = err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again.'
      : err.name === 'NotFoundError' ? 'No camera was found on this device.'
      : `Could not open the camera${err.name ? ` (${err.name})` : ''}. ${err.message || ''}`;
    $('#cam-error').hidden = false;
    $('#reticle').style.opacity = 0; $('#hint').style.opacity = 0;
    return;
  }
  video.srcObject = session.stream;
  await video.play().catch(() => {});
  const sc = new Scanner(video, $('#overlay'), { onState });
  sc.sensitivity = store.settings.sensitivity;
  sc.showDebug = store.settings.debug;
  session.scanner = sc;
  session.product = null; session.template = null; session.count = 0;
  $('#sens').value = sc.sensitivity; $('#sens-out').textContent = Math.round(sc.sensitivity * 100) + '%';
  $('#perf').hidden = !store.settings.showPerf;
  $('#tune').hidden = true;
  sc.start();
  if (product) {
    session.product = product; session.template = product.template;
    await sc.startWithTemplate(product.name, product.template);
  } else onState({ mode: 'select', count: 0, inView: 0 });
  startPerfLoop();
  window.__scanner = sc; window.__demo = session.demo; // handy for debugging / automated tests
}

async function endScan() {
  session.scanner?.stop();
  session.scanner = null;
  session.demo ? session.demo.stop() : stopStream(session.stream);
  session.demo = null; session.stream = null;
  $('#video').srcObject = null;
  $('#sheet').hidden = true;
}

let lastCount = 0;
function onState(st) {
  const counting = st.mode === 'counting';
  $('#dock').hidden = !counting;
  $('#reticle').style.opacity = st.mode === 'select' ? 1 : 0;
  $('#hint').style.opacity = counting ? 0 : 1;
  if (st.mode === 'select') $('#hint').textContent = 'Tap a product, or drag a box around it';
  if (st.mode === 'confirm') $('#hint').textContent = 'Name it and start counting';
  const name = session.scanner?.label.name;
  $('#title-text').textContent = counting ? (name || 'Counting') : st.mode === 'confirm' ? 'Object captured' : 'Select a product';
  if (counting) {
    const n = $('#count-num');
    if (st.count !== lastCount) {
      n.textContent = st.count;
      n.classList.add('bump'); setTimeout(() => n.classList.remove('bump'), 180);
      if (st.count > lastCount) buzz(8);
      lastCount = st.count;
    }
    $('#count-inview').textContent = `${st.inView} in view`;
    const q = session.scanner?.stats.quality ?? 1;
    const tr = $('#count-track');
    tr.textContent = st.locked ? 'Count locked' : q > 0.35 ? 'AR tracking' : 'Move slower';
    tr.classList.toggle('weak', q <= 0.35);
    $('#btn-lock').classList.toggle('on', !!st.locked);
    $('#btn-lock span').textContent = st.locked ? 'Locked' : 'Lock';
    session.count = st.count;
  } else lastCount = -1;
}

let perfRaf;
function startPerfLoop() {
  cancelAnimationFrame(perfRaf);
  let last = 0;
  const tick = (t) => {
    const sc = session.scanner;
    if (!sc) return;
    if (t - last > 500) {
      last = t;
      $('#perf-cam').textContent = sc.stats.camFps || '--';
      $('#perf-ui').textContent = sc.stats.uiFps || '--';
      $('#perf').classList.toggle('warn', sc.stats.camFps && sc.stats.camFps < 50);
    }
    perfRaf = requestAnimationFrame(tick);
  };
  perfRaf = requestAnimationFrame(tick);
}

// --- gestures on the camera stage: tap = auto-select, drag = draw box ---
(() => {
  const stage = $('#stage'), box = $('#dragbox');
  let start = null, dragging = false;
  stage.addEventListener('pointerdown', (e) => {
    if (!session.scanner) return;
    start = { x: e.clientX, y: e.clientY }; dragging = false;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!start || session.scanner?.mode !== 'select') return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!dragging && Math.hypot(dx, dy) > 14) dragging = true;
    if (dragging) {
      box.hidden = false;
      Object.assign(box.style, { left: Math.min(start.x, e.clientX) + 'px', top: Math.min(start.y, e.clientY) + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
    }
  });
  stage.addEventListener('pointerup', (e) => {
    const sc = session.scanner;
    if (!start || !sc) return;
    box.hidden = true;
    const s = start; start = null;
    if (sc.mode === 'select') {
      const url = dragging ? sc.selectAt(s.x, s.y, e.clientX, e.clientY) : sc.selectAt(e.clientX, e.clientY);
      if (url) openSheet(url);
    } else if (sc.mode === 'counting' && !dragging) {
      const r = sc.tapCounting(e.clientX, e.clientY);
      buzz(r === 'removed' ? [10, 40, 10] : 15);
      toast(r === 'removed' ? 'Removed from count' : r === 'restored' ? 'Added back' : 'Added missed item');
    }
  });
  stage.addEventListener('pointercancel', () => { start = null; box.hidden = true; });
})();

function openSheet(url) {
  buzz(20);
  $('#sheet-thumb').src = url;
  const input = $('#sheet-name');
  input.value = '';
  const names = store.products.map((p) => p.name).slice(0, 8);
  const demoNames = session.demo ? DEMO_PRODUCTS.map((p) => p.name) : [];
  $('#sheet-suggest').innerHTML = [...new Set([...names, ...demoNames])].map((n) => `<button data-name="${esc(n)}">${esc(n)}</button>`).join('');
  $('#sheet').hidden = false;
}

$('#sheet-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-name]');
  if (b) $('#sheet-name').value = b.dataset.name;
});
$('#sheet-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') actions.confirm(); });

// ---------------- library / history / settings ----------------
const icon = {
  scan: '<svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>',
};

function renderLibrary() {
  const list = $('#library-list'), ps = store.products;
  list.innerHTML = ps.length ? ps.map((p) => `
    <div class="item glass" data-id="${p.id}">
      <img src="${p.template}" alt="" />
      <div class="meta"><b>${esc(p.name)}</b><small>${p.lastCount != null ? `Last count ${p.lastCount} · ` : ''}${new Date(p.updated).toLocaleDateString()}</small></div>
      <div class="acts"><button data-act="rename" aria-label="Rename">${icon.edit}</button><button data-act="delete" aria-label="Delete">${icon.del}</button><button class="go" data-act="scan" aria-label="Scan">${icon.scan}</button></div>
    </div>`).join('')
    : `<div class="empty glass"><b>No saved products yet</b>Scan a product and press Save. Its name and look are stored here so you can count it again with one tap.</div>`;
}
$('#library-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.item').dataset.id, p = store.product(id);
  if (b.dataset.act === 'scan') startScan({ product: p, demo: !!p.demo });
  if (b.dataset.act === 'rename') { const n = prompt('Product name', p.name); if (n?.trim()) { store.renameProduct(id, n.trim()); renderLibrary(); } }
  if (b.dataset.act === 'delete' && confirm(`Delete “${p.name}” from the library?`)) { store.deleteProduct(id); renderLibrary(); }
});

function renderHistory() {
  const list = $('#history-list'), scans = store.scans;
  if (!scans.length) { list.innerHTML = `<div class="empty glass"><b>No counts yet</b>Saved counts appear here with a photo, the product name and the time.</div>`; return; }
  let html = '', day = '';
  for (const s of scans) {
    const d = new Date(s.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (d !== day) { html += `<p class="day">${d}</p>`; day = d; }
    html += `<div class="item glass" data-id="${s.id}">${s.photo ? `<img src="${s.photo}" alt="" />` : '<div class="ph"></div>'}
      <div class="meta"><b>${esc(s.name)}</b><small>${new Date(s.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>
      <span class="num">${s.count}</span><div class="acts"><button data-act="delete" aria-label="Delete">${icon.del}</button></div></div>`;
  }
  list.innerHTML = html;
}
$('#history-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act=delete]'); if (!b) return;
  store.deleteScan(b.closest('.item').dataset.id); renderHistory();
});

function renderSettings() {
  const s = store.settings;
  $$('.seg[data-setting]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(s[seg.dataset.setting]) === b.dataset.v)));
  $$('input[data-setting]').forEach((i) => { if (i.type === 'checkbox') i.checked = !!s[i.dataset.setting]; else i.value = s[i.dataset.setting]; });
}
$('#settings').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button'); if (!b) return;
  store.setSetting(b.parentElement.dataset.setting, Number(b.dataset.v)); renderSettings();
});
$('#settings').addEventListener('change', (e) => {
  const i = e.target.closest('input[data-setting]'); if (!i) return;
  store.setSetting(i.dataset.setting, i.type === 'checkbox' ? i.checked : Number(i.value));
});

// ---------------- actions ----------------
const actions = {
  'start-camera': () => startScan(),
  'start-demo': () => startScan({ demo: true }),
  'exit-scan': async () => { await endScan(); go('menu'); },
  retake: () => { $('#sheet').hidden = true; session.scanner?.cancelSelection(); },
  confirm: () => {
    const sc = session.scanner; if (!sc) return;
    const name = $('#sheet-name').value.trim();
    const res = sc.confirmSelection(name);
    $('#sheet').hidden = true;
    session.template = res?.dataURL; session.product = null;
    lastCount = -1;
    toast(name ? `Counting “${name}”` : 'Counting matching items…');
  },
  'toggle-lock': () => { const sc = session.scanner; if (sc) { sc.setLocked(!sc.locked); buzz(); } },
  'toggle-tune': () => { $('#tune').hidden = !$('#tune').hidden; },
  rescan: () => { session.scanner?.rescan(); toast('Recounting…'); },
  'new-select': () => { session.scanner?.newSelection(); $('#tune').hidden = true; },
  'save-count': () => {
    const sc = session.scanner; if (!sc) return;
    let name = sc.label.name;
    if (!name) {
      name = prompt('Name this product', '')?.trim();
      if (!name) return;
      sc.label.name = name;
      $('#title-text').textContent = name;
    }
    const p = store.upsertProduct({ id: session.product?.id, name, template: session.template });
    if (session.demo) { p.demo = true; }
    session.product = p;
    const photo = sc.snapshot(480);
    store.addScan({ productId: p.id, name, count: sc.anchors.counted.length, photo });
    $('#flash').classList.remove('go'); void $('#flash').offsetWidth; $('#flash').classList.add('go');
    buzz([15, 50, 15]);
    toast(`Saved ${sc.anchors.counted.length} × ${name}`);
  },
  'export-csv': () => {
    const rows = [['date', 'product', 'count'], ...store.scans.map((s) => [new Date(s.date).toISOString(), s.name, s.count])];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `shelf-counts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  },
  'reset-all': () => { if (confirm('Erase all products, counts and settings?')) { store.resetAll(); renderSettings(); toast('All data erased'); } },
};

$('#sens').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (session.scanner) session.scanner.sensitivity = v;
  $('#sens-out').textContent = Math.round(v * 100) + '%';
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a && actions[a.dataset.action]) { actions[a.dataset.action](); return; }
  const g = e.target.closest('[data-go]');
  if (g) go(g.dataset.go);
});

document.addEventListener('visibilitychange', () => { session.demo?.pause(document.hidden); });

if ('serviceWorker' in navigator && location.protocol === 'https:' && !location.hostname.match(/^(localhost|127\.)/)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

renderMenu();
