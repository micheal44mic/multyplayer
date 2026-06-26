// STILE LIVELLO — pannello con gli stili del livello: Traccia (contorno del
// bordo dell'alpha con posizione esterna/centrale/interna, colore e
// dimensione; EDT euclidea in 2 pass, vedi FS_DIST_V/FS_STROKE) e Colore
// (sostituzione della tinta con alpha intatta, FS_TINT). Sessione a ✓/✗ con
// anteprima GPU e auto-annullo (base FxSessionTool): il ✓ rasterizza lo
// stile nel livello con undo a tile-diff. Si apre dal bottone nel rail
// subito sotto Sposta.

import { FxSessionTool, PAD } from './fx_session.js';
import { strokeBuffer, tintBuffer } from './fx_blur.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {'stroke'|'tint'} LsKind */

const ICON_STROKE = '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="7" height="7" rx="1"/><rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3.2 2.6"/></svg>';
const ICON_BUCKET = '<svg viewBox="0 0 24 24"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/></svg>';
const POS_LABELS = ['Outside', 'Center', 'Inside'];

/** @type {Record<LsKind, {icon: string, label: string}>} */
const LS_META = {
  stroke: { icon: ICON_STROKE, label: 'Stroke' },
  tint: { icon: ICON_BUCKET, label: 'Color' },
};
const LS_ORDER = /** @type {LsKind[]} */ (['stroke', 'tint']);

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
    this._build();
  }

  _build() {
    const body = document.getElementById('ls-body');

    // lista degli stili
    this.listEl = this._makeItemList(LS_ORDER, LS_META, (kind) => this._onPick(kind));

    // parametri
    this.paramsEl = document.createElement('div');
    this.paramsEl.className = 'fx-params';
    this.paramsEl.hidden = true;
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'fx-title';

    // posizione: tre bottoni a segmenti (solo traccia)
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

    // colore della traccia
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

    this.paramsEl.append(this.titleEl, seg, this.rowW.root, colorRow, this._makeActions());
    body.append(this.listEl, this._makeHint(), this.paramsEl);
  }

  /** @param {LsKind} kind */
  _onPick(kind) {
    if (!this._pickGuard()) return;
    // colore iniziale = colore corrente del pennello
    const color = /** @type {HTMLInputElement} */ (document.getElementById('color')).value || '#1a1a1f';
    // traccia: l'anello esterno si spande fino a 60 px << PAD; colore:
    // operazione puntuale, hull secco
    const ok = this._beginSession(kind, kind === 'stroke' ? PAD : 0, false,
      { strokeW: 8, strokePos: 0, strokeColor: color });
    if (!ok) return this._flash('The layer is empty.');
    this._sig = '';
    this._refresh();
  }

  /** @param {any} s */
  _params(s) {
    const [r, g, b] = hexRgb(s.strokeColor);
    if (s.kind === 'tint') return { strokeR: r, strokeG: g, strokeB: b };
    return { strokeW: s.strokeW, strokePos: s.strokePos, strokeR: r, strokeG: g, strokeB: b };
  }

  /** @param {Uint8ClampedArray} data @param {any} s */
  _cpuApply(data, s) {
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
      this.segEl.hidden = kind !== 'stroke';
      this.rowW.root.hidden = kind !== 'stroke';
      this.rowW.refresh(s);
      this.colorInput.value = s.strokeColor;
      for (const b of this.posBtns) {
        b.classList.toggle('active', Number(b.dataset.pos) === s.strokePos);
      }
    }
    this._hintFor(layer, inSession);
  }
}
