// Local persistence (stays on the device).
const KEY = 'shelfsense.v1';

const DEFAULTS = {
  products: [],
  scans: [],
  settings: { sensitivity: 0.5, fps: 60, resolution: 720, showPerf: true, haptics: true, debug: false },
};

let state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) return { ...DEFAULTS, ...s, settings: { ...DEFAULTS.settings, ...s.settings } };
  } catch { /* ignore */ }
  return structuredClone(DEFAULTS);
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch {
    // storage full: drop the oldest scan photos and retry
    for (const s of state.scans) if (s.photo) { delete s.photo; break; }
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
  }
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const store = {
  get settings() { return state.settings; },
  setSetting(k, v) { state.settings[k] = v; save(); },
  get products() { return state.products.slice().sort((a, b) => b.updated - a.updated); },
  get scans() { return state.scans.slice().sort((a, b) => b.date - a.date); },
  product(id) { return state.products.find((p) => p.id === id); },
  findByName(name) { return state.products.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()); },

  upsertProduct({ id, name, template }) {
    let p = id && this.product(id);
    if (!p) p = this.findByName(name);
    if (p) { p.name = name; if (template) p.template = template; p.updated = Date.now(); }
    else {
      p = { id: uid(), name, template, created: Date.now(), updated: Date.now() };
      state.products.push(p);
    }
    save();
    return p;
  },
  renameProduct(id, name) {
    const p = this.product(id); if (!p) return;
    p.name = name; p.updated = Date.now();
    for (const s of state.scans) if (s.productId === id) s.name = name;
    save();
  },
  deleteProduct(id) {
    state.products = state.products.filter((p) => p.id !== id);
    save();
  },
  addScan({ productId, name, count, photo }) {
    const s = { id: uid(), productId, name, count, date: Date.now(), photo };
    state.scans.push(s);
    const p = this.product(productId); if (p) { p.lastCount = count; p.updated = Date.now(); }
    save();
    return s;
  },
  deleteScan(id) { state.scans = state.scans.filter((s) => s.id !== id); save(); },
  clearScans() { state.scans = []; save(); },
  resetAll() { state = structuredClone(DEFAULTS); save(); },
  stats() {
    const last = this.scans[0];
    return { products: state.products.length, scans: state.scans.length, items: state.scans.reduce((n, s) => n + s.count, 0), last };
  },
};
