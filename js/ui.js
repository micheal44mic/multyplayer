// UI: Brush Studio (popup con preview live e tab per categoria), toolbar,
// swatch, scorciatoie, export PNG.

import { brush } from './brush.js';
import { hexToRgb, clamp } from './util.js';
import { CHUNK } from './store.js';
import { ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { BrushPreview } from './brush_preview.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./brush.js').Tool} Tool */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

// Valori di fabbrica del pennello (colore e tool esclusi): "Reimposta pennello".
const BRUSH_DEFAULTS = (() => {
  const { color, tool, ...rest } = brush;
  return rest;
})();

/**
 * Riga di un pannello: sezione ({sec}), toggle ({toggle}) o slider completo.
 * dep: la riga è attiva solo se ritorna true (rinfrescata quando un toggle
 * cambia). renderer: riga speciale costruita con accesso all'App.
 * @typedef {Object} RowDef
 * @property {string} [sec]
 * @property {boolean} [renderer]
 * @property {{label: string, hint?: string, get: () => boolean, set: (v: boolean) => void}} [toggle]
 * @property {string} [id]
 * @property {string} [label]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {() => number} [get]
 * @property {(v: number) => void} [set]
 * @property {(v: number) => string} [fmt]
 * @property {boolean} [log]
 * @property {() => boolean} [dep]
 * @property {HTMLInputElement} [_input]
 * @property {() => void} [_refresh]
 */

// Icone delle tab (path 24x24, fill currentColor).
const ICONS = {
  base: '<path d="M20.7 3.3c-1-1-2.7-.9-3.6.1L9 11.5l3.5 3.5 8.1-8.1c1-1 1.1-2.6.1-3.6zM8 13c-2 0-3.5 1.6-3.5 3.5 0 1.5-1.2 2.2-2.5 2.5 1 1.3 2.7 2 4.5 2 2.8 0 5-2.2 5-5L8 13z"/>',
  shape: '<path d="M12 4C6.5 4 2 7.6 2 12s4.5 8 10 8 10-3.6 10-8-4.5-8-10-8zm0 2c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z"/>',
  scatter: '<path d="M7 3.5a2.2 2.2 0 1 1-.01 0zM16.5 5.5a2.8 2.8 0 1 1-.01 0zM5.5 12.5a2.8 2.8 0 1 1-.01 0zM14 13a3.6 3.6 0 1 1-.01 0z"/>',
  jitter: '<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  color: '<path d="M12 2.5s6.5 7 6.5 11.4a6.5 6.5 0 1 1-13 0C5.5 9.5 12 2.5 12 2.5z"/>',
  more: '<path fill-rule="evenodd" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4c0 .6 0 1.1-.1 1.6l2 1.6-2 3.5-2.4-1a8 8 0 0 1-2.8 1.6L15.3 22H8.7l-.4-2.7a8 8 0 0 1-2.8-1.6l-2.4 1-2-3.5 2-1.6A8.6 8.6 0 0 1 3 12c0-.6 0-1.1.1-1.6l-2-1.6 2-3.5 2.4 1a8 8 0 0 1 2.8-1.6L8.7 2h6.6l.4 2.7a8 8 0 0 1 2.8 1.6l2.4-1 2 3.5-2 1.6c.1.5.1 1 .1 1.6z"/>',
};

// Slider: min/max/step sono valori UI; get/set convertono da/verso il modello.
/** @type {{id: string, label: string, icon: string, rows: RowDef[]}[]} */
const TABS = [
  { id: 'base', label: 'Base', icon: ICONS.base, rows: [
    { id: 'size', label: 'Dimensione', min: 1, max: 512, step: 1, get: () => brush.size, set: v => brush.size = v, fmt: v => v + ' px', log: true },
    { id: 'opacity', label: 'Opacità', min: 1, max: 100, step: 1, get: () => brush.opacity * 100, set: v => brush.opacity = v / 100, fmt: v => v + '%' },
    { id: 'soft', label: 'Morbidezza', min: 0, max: 100, step: 1, get: () => (1 - brush.hardness) * 100, set: v => brush.hardness = 1 - v / 100, fmt: v => v + '%' },
    { id: 'smooth', label: 'Stabilizzazione', min: 0, max: 100, step: 1, get: () => brush.smoothing * 100, set: v => brush.smoothing = v / 100, fmt: v => v + '%' },
    { id: 'spacing', label: 'Spaziatura', min: 0.1, max: 300, step: 0.1, get: () => brush.spacing * 100, set: v => brush.spacing = v / 100, fmt: v => v.toFixed(1) + '%', log: true },
    { toggle: { label: 'Accumula opacità', hint: 'ON: ogni stamp si somma nel tratto · OFF: tratto a opacità uniforme', get: () => brush.buildup, set: v => brush.buildup = v } },
  ] },
  { id: 'shape', label: 'Forma', icon: ICONS.shape, rows: [
    { id: 'roundness', label: 'Rotondità', min: 5, max: 100, step: 1, get: () => brush.roundness * 100, set: v => brush.roundness = v / 100, fmt: v => v + '%' },
    { id: 'angle', label: 'Angolo', min: 0, max: 360, step: 1, get: () => brush.angle, set: v => brush.angle = v, fmt: v => v + '°' },
  ] },
  { id: 'scatter', label: 'Scatter', icon: ICONS.scatter, rows: [
    { toggle: { label: 'Scatter', hint: 'ogni stamp diventa una nuvola di particelle', get: () => brush.scatter, set: v => brush.scatter = v } },
    { id: 'pdens', label: 'Densità', min: 25, max: 300, step: 1, dep: () => brush.scatter, get: () => brush.particleDensity, set: v => brush.particleDensity = v, fmt: v => `${v}% · ${Math.max(1, Math.min(12, Math.round(4 * v / 100)))} pt` },
    { id: 'psize', label: 'Dimensione particelle', min: 5, max: 200, step: 1, dep: () => brush.scatter, get: () => brush.particleSize, set: v => brush.particleSize = v, fmt: v => v + '%' },
    { id: 'pdev', label: 'Deviazione', min: -100, max: 100, step: 1, dep: () => brush.scatter, get: () => brush.particleDeviation, set: v => brush.particleDeviation = v, fmt: v => (v > 0 ? '+' : '') + v + '%' },
  ] },
  { id: 'jitter', label: 'Jitter', icon: ICONS.jitter, rows: [
    { id: 'jpos', label: 'Jitter posizione', min: 0, max: 100, step: 1, get: () => brush.jitterPos * 100, set: v => brush.jitterPos = v / 100, fmt: v => v + '%' },
    { id: 'jsize', label: 'Jitter spessore', min: 0, max: 100, step: 1, get: () => brush.jitterSize * 100, set: v => brush.jitterSize = v / 100, fmt: v => v + '%' },
    { id: 'jop', label: 'Jitter opacità', min: 0, max: 100, step: 1, get: () => brush.jitterOpacity * 100, set: v => brush.jitterOpacity = v / 100, fmt: v => v + '%' },
    { id: 'jspc', label: 'Jitter spaziatura', min: 0, max: 100, step: 1, get: () => brush.jitterSpacing * 100, set: v => brush.jitterSpacing = v / 100, fmt: v => v + '%' },
    { id: 'jang', label: 'Jitter angolo', min: 0, max: 100, step: 1, get: () => brush.jitterAngle * 100, set: v => brush.jitterAngle = v / 100, fmt: v => v + '%' },
  ] },
  { id: 'color', label: 'Colore', icon: ICONS.color, rows: [
    { id: 'jbri', label: 'Jitter luminosità', min: 0, max: 100, step: 1, get: () => brush.jitterBright * 100, set: v => brush.jitterBright = v / 100, fmt: v => v + '%' },
    { id: 'jsat', label: 'Jitter saturazione', min: 0, max: 100, step: 1, get: () => brush.jitterSat * 100, set: v => brush.jitterSat = v / 100, fmt: v => v + '%' },
  ] },
  { id: 'more', label: 'Altro', icon: ICONS.more, rows: [
    { sec: 'Pressione' },
    { toggle: { label: 'Pressione → dimensione', get: () => brush.pressureSize, set: v => brush.pressureSize = v } },
    { toggle: { label: 'Pressione → opacità', get: () => brush.pressureOpacity, set: v => brush.pressureOpacity = v } },
    { sec: 'Renderer' },
    { renderer: true },
  ] },
];

// Lista piatta per sync (scorciatoie [ ] e reset).
const ALL_ROWS = TABS.flatMap(t => t.rows);

export class UI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.studio = document.getElementById('studio');
    this.backdrop = document.getElementById('studio-backdrop');
    this.badge = document.getElementById('bs-badge');
    this.cursorEl = document.getElementById('cursor');
    this.zoomLabel = document.getElementById('zoom-label');
    this.zoomOutBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-zoom-out'));
    this.zoomInBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-zoom-in'));
    /** @type {string[]} */
    this.recentColors = [];
    this.preview = new BrushPreview(/** @type {HTMLCanvasElement} */ (document.getElementById('bs-preview')));
    /** @type {(() => void)[]} */
    this._depRefresh = [];
    /** @type {(() => void)[]} */
    this._toggleSync = [];
    this._buildStudio();
    this._bindToolbar();
    this._bindKeys();
  }

  // ---- Brush Studio ----

  _buildStudio() {
    const tabsNav = document.getElementById('bs-tabs');
    const panes = document.getElementById('bs-panes');

    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = 'bs-tab';
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${tab.icon}</svg><span>${tab.label}</span>`;
      btn.addEventListener('click', () => this._selectTab(tab.id));
      btn.dataset.tab = tab.id;
      tabsNav.appendChild(btn);

      const pane = document.createElement('div');
      pane.className = 'bs-pane';
      pane.dataset.tab = tab.id;
      for (const def of tab.rows) {
        if (def.sec) pane.appendChild(this._buildSection(def.sec));
        else if (def.renderer) pane.appendChild(this._buildRendererToggle());
        else if (def.toggle) pane.appendChild(this._buildToggle(def.toggle));
        else pane.appendChild(this._buildSlider(def));
      }
      panes.appendChild(pane);
    }
    this._selectTab('base');

    document.getElementById('bs-reset').addEventListener('click', () => this._resetBrush());
    document.getElementById('studio-close').addEventListener('click', () => this.toggleStudio(false));
    this.backdrop.addEventListener('click', () => this.toggleStudio(false));
    this._updateBadge();
  }

  /** @param {string} id */
  _selectTab(id) {
    for (const el of document.querySelectorAll('.bs-tab')) {
      el.classList.toggle('active', /** @type {HTMLElement} */ (el).dataset.tab === id);
    }
    for (const el of document.querySelectorAll('.bs-pane')) {
      el.classList.toggle('active', /** @type {HTMLElement} */ (el).dataset.tab === id);
    }
  }

  /** @param {string} title */
  _buildSection(title) {
    const h = document.createElement('div');
    h.className = 'p-section';
    h.textContent = title;
    return h;
  }

  /** @param {{label: string, hint?: string, get: () => boolean, set: (v: boolean) => void}} t */
  _buildToggle(t) {
    const lab = document.createElement('label');
    lab.className = 'p-toggle';
    const span = document.createElement('span');
    span.textContent = t.label;
    if (t.hint) {
      const hint = document.createElement('span');
      hint.className = 'p-hint';
      hint.textContent = t.hint;
      span.appendChild(hint);
    }
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = t.get();
    input.addEventListener('change', () => {
      t.set(input.checked);
      this._refreshDeps();
      this._settingChanged();
    });
    this._toggleSync.push(() => { input.checked = t.get(); });
    const knob = document.createElement('span');
    knob.className = 'knob';
    lab.append(span, input, knob);
    return lab;
  }

  // Presentazione desynchronized (bassa latenza vs stabilità): stato App,
  // non pennello — fuori dal reset, persistito a parte.
  _buildRendererToggle() {
    const lab = document.createElement('label');
    lab.className = 'p-toggle';
    const span = document.createElement('span');
    span.textContent = 'Bassa latenza (desync)';
    const hint = document.createElement('span');
    hint.className = 'p-hint';
    hint.textContent = 'ON: penna più reattiva · OFF se il tratto lampeggia (Chrome)';
    span.appendChild(hint);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.app.desync;
    input.addEventListener('change', () => this.app.setDesynchronized(input.checked));
    const knob = document.createElement('span');
    knob.className = 'knob';
    lab.append(span, input, knob);
    return lab;
  }

  /** @param {RowDef} def */
  _buildSlider(def) {
    const row = document.createElement('div');
    row.className = 'p-row';
    if (def.dep) {
      const dep = def.dep;
      const apply = () => row.classList.toggle('p-off', !dep());
      this._depRefresh.push(apply);
      apply();
    }
    const head = document.createElement('div');
    head.className = 'p-row-head';
    const name = document.createElement('span');
    name.textContent = def.label;
    const val = document.createElement('span');
    val.className = 'p-val';
    head.append(name, val);

    const input = document.createElement('input');
    input.type = 'range';
    // slider logaritmico per size e spacing (range enormi)
    if (def.log) {
      input.min = String(Math.log(def.min));
      input.max = String(Math.log(def.max));
      input.step = String((Math.log(def.max) - Math.log(def.min)) / 500);
      input.value = String(Math.log(clamp(def.get(), def.min, def.max)));
    } else {
      input.min = String(def.min); input.max = String(def.max); input.step = String(def.step);
      input.value = String(def.get());
    }
    const refresh = () => {
      const v = def.log ? Math.exp(parseFloat(input.value)) : parseFloat(input.value);
      val.textContent = def.fmt(def.step >= 1 ? Math.round(v) : v);
    };
    input.addEventListener('input', () => {
      let v = def.log ? Math.exp(parseFloat(input.value)) : parseFloat(input.value);
      if (def.step >= 1) v = Math.round(v);
      def.set(clamp(v, def.min, def.max));
      refresh();
      this._settingChanged();
    });
    refresh();

    // stepper -/+ (passo singolo; per i log almeno uno step, ~10% altrimenti)
    /** @param {number} dir */
    const stepBy = (dir) => {
      let v;
      if (def.log) {
        const cur = def.get();
        const raw = dir > 0 ? cur * 1.1 : cur / 1.1;
        v = dir > 0 ? Math.max(cur + def.step, raw) : Math.min(cur - def.step, raw);
      } else {
        v = def.get() + dir * def.step;
      }
      v = def.step >= 1 ? Math.round(v) : Math.round(v / def.step) * def.step;
      v = clamp(v, def.min, def.max);
      def.set(v);
      input.value = String(def.log ? Math.log(v) : v);
      refresh();
      this._settingChanged();
    };
    const minus = document.createElement('button');
    minus.className = 'p-step';
    minus.textContent = '−';
    minus.addEventListener('click', () => stepBy(-1));
    const plus = document.createElement('button');
    plus.className = 'p-step';
    plus.textContent = '+';
    plus.addEventListener('click', () => stepBy(1));

    const slider = document.createElement('div');
    slider.className = 'p-slider';
    slider.append(minus, input, plus);

    row.append(head, slider);
    def._input = input;
    def._refresh = refresh;
    return row;
  }

  _refreshDeps() { for (const f of this._depRefresh) f(); }

  // Ogni modifica a un setting: badge + preview (debounce a rAF nel preview).
  _settingChanged() {
    this._updateBadge();
    this.preview.schedule();
  }

  _updateBadge() {
    this.badge.textContent = `${brush.size} px · ${Math.round(brush.opacity * 100)}%`;
  }

  _resetBrush() {
    Object.assign(brush, BRUSH_DEFAULTS);
    this.syncSliders();
    this._refreshDeps();
    this._settingChanged();
  }

  /** @param {boolean} [force] */
  toggleStudio(force) {
    const open = force !== undefined ? force : !this.studio.classList.contains('open');
    this.studio.classList.toggle('open', open);
    this.backdrop.hidden = !open;
    if (open) {
      this._updateBadge();
      this.preview.render();
    }
  }

  syncSliders() {
    for (const def of ALL_ROWS) {
      if (!def._input) continue;
      def._input.value = String(def.log ? Math.log(clamp(def.get(), def.min, def.max)) : def.get());
      def._refresh();
    }
    for (const f of this._toggleSync) f();
  }

  // ---- toolbar / scorciatoie ----

  _bindToolbar() {
    const app = this.app;
    /** @type {Record<string, Tool>} */
    const tools = { 'tool-brush': 'brush', 'tool-eraser': 'eraser', 'tool-pan': 'pan' };
    for (const [id, tool] of Object.entries(tools)) {
      document.getElementById(id).addEventListener('click', () => this.setTool(tool));
    }

    const colorInput = /** @type {HTMLInputElement} */ (document.getElementById('color'));
    colorInput.addEventListener('input', () => {
      hexToRgb(colorInput.value, brush.color);
      this.preview.schedule();
    });
    colorInput.addEventListener('change', () => this._pushSwatch(colorInput.value));

    document.getElementById('btn-undo').addEventListener('click', () => app.undo());
    document.getElementById('btn-redo').addEventListener('click', () => app.redo());
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (confirm('Cancellare tutto il disegno?')) app.clearAll();
    });
    document.getElementById('btn-export').addEventListener('click', () => exportPng(app.docStore));
    document.getElementById('btn-resetview').addEventListener('click', () => app.camera.reset());
    this.zoomOutBtn.addEventListener('click', () => this._zoomBy(0.8));
    this.zoomInBtn.addEventListener('click', () => this._zoomBy(1.25));
    document.getElementById('btn-hud').addEventListener('click', () => app.hud.toggle());
    document.getElementById('btn-panel').addEventListener('click', () => this.toggleStudio());
  }

  /** @param {number} factor */
  _zoomBy(factor) {
    const cam = this.app.camera;
    cam.zoomAt(cam.w / 2, cam.h / 2, factor);
  }

  /** @param {Tool} tool */
  setTool(tool) {
    brush.tool = tool;
    for (const [id, t] of [['tool-brush', 'brush'], ['tool-eraser', 'eraser'], ['tool-pan', 'pan']]) {
      document.getElementById(id).classList.toggle('active', t === tool);
    }
    this.app.canvas.classList.toggle('panning', tool === 'pan');
  }

  /** @param {string} hex */
  _pushSwatch(hex) {
    if (this.recentColors[0] === hex) return;
    this.recentColors = [hex, ...this.recentColors.filter(c => c !== hex)].slice(0, 6);
    const wrap = document.getElementById('swatches');
    wrap.textContent = '';
    for (const c of this.recentColors) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        /** @type {HTMLInputElement} */ (document.getElementById('color')).value = c;
        hexToRgb(c, brush.color);
        this.preview.schedule();
      });
      wrap.appendChild(b);
    }
  }

  _bindKeys() {
    const app = this.app;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); app.undo(); }
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); app.redo(); }
      else if (k === 'b') this.setTool('brush');
      else if (k === 'e') this.setTool('eraser');
      else if (k === 'h') this.setTool('pan');
      else if (k === 'p') this.toggleStudio();
      else if (k === 'escape') this.toggleStudio(false);
      else if (k === '`' || k === '\\') app.hud.toggle();
      else if (k === '0') app.camera.reset();
      else if (k === '[') { brush.size = clamp(Math.round(brush.size / 1.15), 1, 512); this.syncSliders(); this._settingChanged(); }
      else if (k === ']') { brush.size = clamp(Math.round(brush.size * 1.15) , 1, 512); this.syncSliders(); this._settingChanged(); }
      else if (k === '+' || k === '=') app.camera.zoomAt(app.camera.w / 2, app.camera.h / 2, 1.25);
      else if (k === '-') app.camera.zoomAt(app.camera.w / 2, app.camera.h / 2, 0.8);
    });
  }

  // Anello cursore: dimensione pennello in px schermo
  /** @param {import('./input.js').InputManager} input @param {import('./camera.js').Camera} camera */
  updateCursor(input, camera) {
    const el = this.cursorEl;
    const h = input.hover;
    const show = h.visible && brush.tool !== 'pan' && !input.gesture;
    el.style.display = show ? 'block' : 'none';
    if (!show) return;
    const d = Math.max(4, brush.size * camera.zoom);
    el.style.width = d + 'px';
    el.style.height = d + 'px';
    el.style.left = h.x + 'px';
    el.style.top = h.y + 'px';
  }

  /** @param {number} zoom */
  updateZoomLabel(zoom) {
    this.zoomLabel.textContent = (zoom * 100).toFixed(zoom < 0.1 ? 1 : 0) + '%';
    this.zoomOutBtn.disabled = zoom <= ZOOM_MIN;
    this.zoomInBtn.disabled = zoom >= ZOOM_MAX;
  }

  /** @param {import('./undo.js').UndoManager} undoMgr */
  updateUndoButtons(undoMgr) {
    /** @type {HTMLButtonElement} */ (document.getElementById('btn-undo')).disabled = !undoMgr.canUndo;
    /** @type {HTMLButtonElement} */ (document.getElementById('btn-redo')).disabled = !undoMgr.canRedo;
  }
}

// Export PNG: bounding box dei chunk non vuoti, compositato su bianco.
/** @param {ChunkStore} docStore */
export function exportPng(docStore) {
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
  let any = false;
  for (const c of docStore.map.values()) {
    // un chunk può esistere ma essere tutto trasparente (dopo gomma/undo)
    let empty = true;
    const d = c.data;
    for (let o = 3; o < d.length; o += 4) if (d[o] !== 0) { empty = false; break; }
    if (empty) continue;
    any = true;
    if (c.cx < cx0) cx0 = c.cx;
    if (c.cy < cy0) cy0 = c.cy;
    if (c.cx > cx1) cx1 = c.cx;
    if (c.cy > cy1) cy1 = c.cy;
  }
  if (!any) { alert('Niente da esportare: il canvas è vuoto.'); return; }

  const w = (cx1 - cx0 + 1) * CHUNK, h = (cy1 - cy0 + 1) * CHUNK;
  if (w > 16384 || h > 16384) {
    alert(`Disegno troppo esteso per un singolo PNG (${w}×${h}). Limite 16384px per lato.`);
    return;
  }

  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const img = ctx.createImageData(CHUNK, CHUNK);
  for (const c of docStore.map.values()) {
    if (c.cx < cx0 || c.cx > cx1 || c.cy < cy0 || c.cy > cy1) continue;
    const s = c.data, d = img.data;
    // premultiplied su bianco -> opaco: out = c + 255*(1-a)
    for (let o = 0; o < s.length; o += 4) {
      const inv = 255 - s[o + 3];
      d[o] = Math.min(255, s[o] + inv);
      d[o + 1] = Math.min(255, s[o + 1] + inv);
      d[o + 2] = Math.min(255, s[o + 2] + inv);
      d[o + 3] = 255;
    }
    ctx.putImageData(img, (c.cx - cx0) * CHUNK, (c.cy - cy0) * CHUNK);
  }

  cnv.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fable-paint.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}
