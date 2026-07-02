// STILE LIVELLO — pannello con effetti rasterizzati a conferma. Ogni voce
// apre una sessione live: il renderer mostra un quad cotto temporaneo, ✓
// scrive il risultato nei chunk con undo, ✕ butta via l'anteprima.

import { FxSessionTool, PAD } from './fx_session.js';
import { strokeBuffer, tintBuffer } from './fx_blur.js';
import { createRangeRow } from './panel_controls.js';
import { DEFAULT_BEVEL_EMBOSS, normalizeBevel, bevelEmbossBuffer } from './layer_styles.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {'bevelEmboss'|'stroke'|'tint'} LsKind */

const BEVEL_PAD = 280;
const ICON_STROKE = '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="7" height="7" rx="1"/><rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3.2 2.6"/></svg>';
const ICON_BUCKET = '<svg viewBox="0 0 24 24"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/></svg>';
const ICON_BEVEL = '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="M5 5h14l-4 4H9z"/><path d="M5 5l4 4v6l-4 4z"/><path d="M19 5v14l-4-4V9z" opacity=".45"/></svg>';
const POS_LABELS = ['Outside', 'Center', 'Inside'];
const BLEND_OPTIONS = ['normal', 'multiply', 'screen', 'overlay', 'softlight', 'darken', 'lighten', 'difference', 'add'];

/** @type {Record<LsKind, {icon: string, label: string}>} */
const LS_META = {
  bevelEmboss: { icon: ICON_BEVEL, label: 'Bevel & Emboss' },
  stroke: { icon: ICON_STROKE, label: 'Stroke' },
  tint: { icon: ICON_BUCKET, label: 'Color' },
};
const LS_ORDER = /** @type {LsKind[]} */ (['bevelEmboss', 'stroke', 'tint']);

/** @param {string} hex @returns {[number, number, number]} 0..1 */
function hexRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

export class LayerStyleTool extends FxSessionTool {
  /** @param {App} app */
  constructor(app) {
    super(app, 'lspanel', 'tool-style', 'ls-close');
    /** @type {{sync: (s:any) => void}[]} */
    this.bevelControls = [];
    this._build();
  }

  _build() {
    const body = document.getElementById('ls-body');
    this.listEl = this._makeItemList(LS_ORDER, LS_META, (kind) => this._onPick(kind));

    this.paramsEl = document.createElement('div');
    this.paramsEl.className = 'fx-params';
    this.paramsEl.hidden = true;
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'fx-title';

    this.strokeBox = document.createElement('div');
    this.strokeBox.className = 'fx-params';
    const seg = document.createElement('div');
    seg.className = 'ls-seg';
    this.segEl = seg;
    /** @type {HTMLButtonElement[]} */
    this.posBtns = [];
    POS_LABELS.forEach((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.pos = String(i);
      b.addEventListener('click', () => {
        const s = this._session;
        if (!s) return;
        s.strokePos = i;
        for (const x of this.posBtns) x.classList.toggle('active', x === b);
      });
      seg.appendChild(b);
      this.posBtns.push(b);
    });
    this.rowW = this._sliderRow('Size', 1, 60, ' px',
      (s, v) => { s.strokeW = v; }, (s) => s.strokeW);
    const colorRow = document.createElement('label');
    colorRow.className = 'tp-colorrow';
    const colorLab = document.createElement('span');
    colorLab.textContent = 'Color';
    this.colorInput = document.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.value = '#1a1a1f';
    this.colorInput.addEventListener('input', () => {
      const s = this._session;
      if (s) s.strokeColor = this.colorInput.value;
    });
    colorRow.append(colorLab, this.colorInput);
    this.strokeBox.append(seg, this.rowW.root, colorRow);

    this.bevelBox = document.createElement('div');
    this.bevelBox.className = 'fx-params';
    this._buildBevelControls();

    this.paramsEl.append(this.titleEl, this.strokeBox, this.bevelBox, this._makeActions());
    body.append(this.listEl, this._makeHint(), this.paramsEl);
  }

  _buildBevelControls() {
    this.bevelBox.append(
      this._selectRow('Style', [
        ['inner', 'Inner Bevel'],
        ['outer', 'Outer Bevel'],
        ['emboss', 'Emboss'],
        ['pillow', 'Pillow Emboss'],
      ], (b) => b.style, (v) => this._setBevel({ style: v })),
      this._selectRow('Technique', [
        ['smooth', 'Smooth'],
        ['chisel-hard', 'Chisel Hard'],
        ['chisel-soft', 'Chisel Soft'],
      ], (b) => b.technique, (v) => this._setBevel({ technique: v })),
      this._selectRow('Direction', [['up', 'Up'], ['down', 'Down']], (b) => b.direction, (v) => this._setBevel({ direction: v })),
      this._range('Depth', 1, 1000, 1, '%', (b) => b.depth, (v) => this._setBevel({ depth: v })),
      this._range('Size', 0, 250, 1, ' px', (b) => b.size, (v) => this._setBevel({ size: v })),
      this._range('Soften', 0, 16, 1, ' px', (b) => b.soften, (v) => this._setBevel({ soften: v })),
      this._range('Angle', 0, 360, 1, ' deg', (b) => b.angle, (v) => this._setBevel({ angle: v })),
      this._range('Altitude', 0, 90, 1, ' deg', (b) => b.altitude, (v) => this._setBevel({ altitude: v })),
      this._selectRow('Gloss', [
        ['linear', 'Linear'], ['rounded', 'Rounded'], ['cone', 'Cone'],
        ['cove-deep', 'Cove Deep'], ['cove-shallow', 'Cove Shallow'],
        ['ring', 'Ring'], ['ring-double', 'Ring Double'],
        ['sawtooth', 'Sawtooth'], ['steps', 'Steps'],
      ], (b) => b.glossContour, (v) => this._setBevel({ glossContour: v })),
      this._selectRow('Highlight', BLEND_OPTIONS.map((v) => [v, v]), (b) => b.highlightMode, (v) => this._setBevel({ highlightMode: v })),
      this._colorRow('Highlight Color', (b) => b.highlightColor, (v) => this._setBevel({ highlightColor: v })),
      this._range('Highlight Opacity', 0, 100, 1, '%', (b) => b.highlightOpacity, (v) => this._setBevel({ highlightOpacity: v })),
      this._selectRow('Shadow', BLEND_OPTIONS.map((v) => [v, v]), (b) => b.shadowMode, (v) => this._setBevel({ shadowMode: v })),
      this._colorRow('Shadow Color', (b) => b.shadowColor, (v) => this._setBevel({ shadowColor: v })),
      this._range('Shadow Opacity', 0, 100, 1, '%', (b) => b.shadowOpacity, (v) => this._setBevel({ shadowOpacity: v })),
    );
  }

  /** @param {LsKind} kind */
  _onPick(kind) {
    if (!this._pickGuard()) return;
    const color = /** @type {HTMLInputElement} */ (document.getElementById('color')).value || '#1a1a1f';
    const params = kind === 'bevelEmboss'
      ? { bevel: normalizeBevel(DEFAULT_BEVEL_EMBOSS) }
      : { strokeW: 8, strokePos: 0, strokeColor: color };
    const ok = this._beginSession(kind, kind === 'stroke' ? PAD : kind === 'bevelEmboss' ? BEVEL_PAD : 0, false, params);
    if (!ok) return this._flash('The layer is empty.');
    this._sig = '';
    this._refresh();
  }

  /** @param {string} label @param {[string,string][]} options @param {(b:any)=>string} get @param {(v:string)=>void} set */
  _selectRow(label, options, get, set) {
    const row = document.createElement('label');
    row.className = 'tp-colorrow';
    const span = document.createElement('span');
    span.textContent = label;
    const sel = document.createElement('select');
    for (const [value, text] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => set(sel.value));
    row.append(span, sel);
    this.bevelControls.push({ sync: (s) => { if (s.bevel) sel.value = get(s.bevel); } });
    return row;
  }

  /** @param {string} label @param {(b:any)=>string} get @param {(v:string)=>void} set */
  _colorRow(label, get, set) {
    const row = document.createElement('label');
    row.className = 'tp-colorrow';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.addEventListener('input', () => set(input.value));
    row.append(span, input);
    this.bevelControls.push({ sync: (s) => { if (s.bevel) input.value = get(s.bevel); } });
    return row;
  }

  /** @param {string} label @param {number} min @param {number} max @param {number} step @param {string} suffix @param {(b:any)=>number} get @param {(v:number)=>void} set */
  _range(label, min, max, step, suffix, get, set) {
    const control = createRangeRow({
      label, min, max, step,
      get: () => {
        const s = this._session;
        return s && s.bevel ? get(s.bevel) : min;
      },
      set,
      fmt: (v) => Math.round(v) + suffix,
      formatFromInput: true,
      initialSync: false,
      beforeInput: () => !!(this._session && this._session.bevel),
    });
    this.bevelControls.push({ sync: (s) => { if (s.bevel) control.sync(get(s.bevel)); } });
    return control.row;
  }

  /** @param {Partial<any>} patch */
  _setBevel(patch) {
    const s = this._session;
    if (!s || !s.bevel) return;
    s.bevel = normalizeBevel({ ...s.bevel, ...patch });
  }

  /** @param {any} s */
  _params(s) {
    if (s.kind === 'bevelEmboss') return { bevel: s.bevel };
    const [r, g, b] = hexRgb(s.strokeColor);
    if (s.kind === 'tint') return { strokeR: r, strokeG: g, strokeB: b };
    return { strokeW: s.strokeW, strokePos: s.strokePos, strokeR: r, strokeG: g, strokeB: b };
  }

  /** @param {Uint8ClampedArray} data @param {any} s */
  _cpuApply(data, s) {
    if (s.kind === 'bevelEmboss') {
      bevelEmbossBuffer(data, s.texW, s.texH, s.bevel);
      return;
    }
    const [r, g, b] = hexRgb(s.strokeColor);
    if (s.kind === 'tint') tintBuffer(data, s.texW, s.texH, r, g, b);
    else strokeBuffer(data, s.texW, s.texH, s.strokeW, s.strokePos, r, g, b);
  }

  _refresh() {
    const layer = this.app.layerMgr.active;
    const s = this._session;
    const sig = `${layer ? layer.id : 0}|${layer ? layer.kind : ''}|` +
      `${layer && layer.visible ? 1 : 0}|${s ? s.kind + s.stamp + '.' + s.strokePos : '-'}`;
    if (sig === this._sig) return;
    this._sig = sig;
    const inSession = s !== null;
    this.listEl.hidden = inSession;
    this.paramsEl.hidden = !inSession;
    if (inSession) {
      const kind = /** @type {LsKind} */ (s.kind);
      this.titleEl.innerHTML = LS_META[kind].icon + `<span>${LS_META[kind].label}</span>`;
      this.strokeBox.hidden = kind === 'bevelEmboss';
      this.bevelBox.hidden = kind !== 'bevelEmboss';
      this.segEl.hidden = kind !== 'stroke';
      this.rowW.root.hidden = kind !== 'stroke';
      if (kind === 'bevelEmboss') {
        for (const c of this.bevelControls) c.sync(s);
      } else {
        this.rowW.refresh(s);
        this.colorInput.value = s.strokeColor;
        for (const b of this.posBtns) b.classList.toggle('active', Number(b.dataset.pos) === s.strokePos);
      }
    }
    this._hintFor(layer, inSession);
  }
}
