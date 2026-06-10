// UI: pannello pennello, toolbar, swatch, scorciatoie, export PNG.

import { brush } from './brush.js';
import { hexToRgb, clamp } from './util.js';
import { CHUNK } from './store.js';
import { ZOOM_MIN, ZOOM_MAX } from './camera.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./brush.js').Tool} Tool */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

/**
 * Voce del pannello: o una sezione ({sec}) o uno slider completo.
 * @typedef {Object} SliderDef
 * @property {string} [sec]
 * @property {string} [id]
 * @property {string} [label]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {() => number} [get]
 * @property {(v: number) => void} [set]
 * @property {(v: number) => string} [fmt]
 * @property {boolean} [log]
 * @property {HTMLInputElement} [_input]
 * @property {() => void} [_refresh]
 */

// Slider: min/max/step sono valori UI; to/from convertono da/verso il modello.
/** @type {SliderDef[]} */
const SLIDERS = [
  { sec: 'Base' },
  { id: 'size', label: 'Dimensione', min: 1, max: 512, step: 1, get: () => brush.size, set: v => brush.size = v, fmt: v => v + ' px', log: true },
  { id: 'opacity', label: 'Opacità', min: 1, max: 100, step: 1, get: () => brush.opacity * 100, set: v => brush.opacity = v / 100, fmt: v => v + '%' },
  { id: 'soft', label: 'Morbidezza', min: 0, max: 100, step: 1, get: () => (1 - brush.hardness) * 100, set: v => brush.hardness = 1 - v / 100, fmt: v => v + '%' },
  { id: 'smooth', label: 'Stabilizzazione', min: 0, max: 100, step: 1, get: () => brush.smoothing * 100, set: v => brush.smoothing = v / 100, fmt: v => v + '%' },
  { id: 'spacing', label: 'Spaziatura', min: 0.1, max: 300, step: 0.1, get: () => brush.spacing * 100, set: v => brush.spacing = v / 100, fmt: v => v.toFixed(1) + '%', log: true },

  { sec: 'Forma' },
  { id: 'roundness', label: 'Rotondità', min: 5, max: 100, step: 1, get: () => brush.roundness * 100, set: v => brush.roundness = v / 100, fmt: v => v + '%' },
  { id: 'angle', label: 'Angolo', min: 0, max: 360, step: 1, get: () => brush.angle, set: v => brush.angle = v, fmt: v => v + '°' },

  { sec: 'Scatter e jitter' },
  { id: 'scatter', label: 'Scatter', min: 0, max: 100, step: 1, get: () => brush.scatter * 100, set: v => brush.scatter = v / 100, fmt: v => v + '%' },
  { id: 'jpos', label: 'Jitter posizione', min: 0, max: 100, step: 1, get: () => brush.jitterPos * 100, set: v => brush.jitterPos = v / 100, fmt: v => v + '%' },
  { id: 'jsize', label: 'Jitter spessore', min: 0, max: 100, step: 1, get: () => brush.jitterSize * 100, set: v => brush.jitterSize = v / 100, fmt: v => v + '%' },
  { id: 'jop', label: 'Jitter opacità', min: 0, max: 100, step: 1, get: () => brush.jitterOpacity * 100, set: v => brush.jitterOpacity = v / 100, fmt: v => v + '%' },
  { id: 'jspc', label: 'Jitter spaziatura', min: 0, max: 100, step: 1, get: () => brush.jitterSpacing * 100, set: v => brush.jitterSpacing = v / 100, fmt: v => v + '%' },
  { id: 'jang', label: 'Jitter angolo', min: 0, max: 100, step: 1, get: () => brush.jitterAngle * 100, set: v => brush.jitterAngle = v / 100, fmt: v => v + '%' },

  { sec: 'Colore dinamico' },
  { id: 'jbri', label: 'Jitter luminosità', min: 0, max: 100, step: 1, get: () => brush.jitterBright * 100, set: v => brush.jitterBright = v / 100, fmt: v => v + '%' },
  { id: 'jsat', label: 'Jitter saturazione', min: 0, max: 100, step: 1, get: () => brush.jitterSat * 100, set: v => brush.jitterSat = v / 100, fmt: v => v + '%' },
];

/** @typedef {{id: string, label: string, hint?: string, get: () => boolean, set: (v: boolean) => void}} ToggleDef */
/** @type {ToggleDef[]} */
const TOGGLES = [
  { id: 'buildup', label: 'Accumula opacità', hint: 'ON: ogni stamp si somma nel tratto · OFF: tratto a opacità uniforme', get: () => brush.buildup, set: v => brush.buildup = v },
  { id: 'psize', label: 'Pressione → dimensione', get: () => brush.pressureSize, set: v => brush.pressureSize = v },
  { id: 'pop', label: 'Pressione → opacità', get: () => brush.pressureOpacity, set: v => brush.pressureOpacity = v },
];

export class UI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('panel');
    this.cursorEl = document.getElementById('cursor');
    this.zoomLabel = document.getElementById('zoom-label');
    this.zoomOutBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-zoom-out'));
    this.zoomInBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-zoom-in'));
    /** @type {string[]} */
    this.recentColors = [];
    this._buildPanel();
    this._bindToolbar();
    this._bindKeys();
  }

  _buildPanel() {
    const body = document.getElementById('panel-body');
    const frag = document.createDocumentFragment();

    // toggle in testa (il buildup è concettualmente importante)
    for (const t of TOGGLES) {
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
      input.addEventListener('change', () => t.set(input.checked));
      const knob = document.createElement('span');
      knob.className = 'knob';
      lab.append(span, input, knob);
      frag.appendChild(lab);
    }

    for (const def of SLIDERS) {
      if (def.sec) {
        const h = document.createElement('div');
        h.className = 'p-section';
        h.textContent = def.sec;
        frag.appendChild(h);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'p-row';
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
      });
      refresh();

      row.append(head, input);
      frag.appendChild(row);
      def._input = input;
      def._refresh = refresh;
    }

    // Renderer: presentazione desynchronized (bassa latenza vs stabilità).
    // Il cambio ricrea canvas e contesto al volo, il disegno resta intatto.
    {
      const sec = document.createElement('div');
      sec.className = 'p-section';
      sec.textContent = 'Renderer';
      frag.appendChild(sec);

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
      frag.appendChild(lab);
    }

    body.appendChild(frag);
  }

  syncSliders() {
    for (const def of SLIDERS) {
      if (!def._input) continue;
      def._input.value = String(def.log ? Math.log(clamp(def.get(), def.min, def.max)) : def.get());
      def._refresh();
    }
  }

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
    document.getElementById('btn-panel').addEventListener('click', () => this.panel.classList.toggle('open'));
    document.getElementById('panel-close').addEventListener('click', () => this.panel.classList.remove('open'));
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
      else if (k === 'p') this.panel.classList.toggle('open');
      else if (k === '`' || k === '\\') app.hud.toggle();
      else if (k === '0') app.camera.reset();
      else if (k === '[') { brush.size = clamp(Math.round(brush.size / 1.15), 1, 512); this.syncSliders(); }
      else if (k === ']') { brush.size = clamp(Math.round(brush.size * 1.15) , 1, 512); this.syncSliders(); }
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
