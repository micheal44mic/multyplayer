// PANNELLO EFFETTI — blur gaussiano/movimento/radiale, rumore, grana,
// soglia, halftone. Sessione a ✓/✗ con anteprima GPU e auto-annullo: il ciclo di vita
// vive nella base FxSessionTool (fx_session.js), qui solo pannello, voci e
// parametri dei singoli effetti. Si apre dal bottone nel rail sotto Sposta.

import { FxSessionTool, PAD } from './fx_session.js';
import { FX_SIGMA_MAX } from './renderer_gl.js';
import { gaussianBlurBuffer, motionBlurBuffer, zoomBlurBuffer, noiseBuffer, grainBuffer, thresholdBuffer, halftoneBuffer } from './fx_blur.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./renderer_gl.js').FxFrame} FxFrame */
/** @typedef {'gauss'|'motion'|'zoom'|'noise'|'grain'|'thresh'|'halftone'} FxKind */

// icone outline (stile rail: stroke 1.6, round)
const ICON_DROP = '<svg viewBox="0 0 24 24"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>';
const ICON_WIND = '<svg viewBox="0 0 24 24"><path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/></svg>';
const ICON_RADIAL = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
const ICON_NOISE = '<svg viewBox="0 0 24 24"><circle cx="5" cy="5" r="1"/><circle cx="13" cy="4" r="1"/><circle cx="19" cy="7" r="1"/><circle cx="8" cy="10" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="4" cy="15" r="1"/><circle cx="11" cy="17" r="1"/><circle cx="20" cy="17" r="1"/><circle cx="7" cy="21" r="1"/><circle cx="15" cy="21" r="1"/></svg>';
const ICON_FILM = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/></svg>';
const ICON_CONTRAST = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>';
const ICON_HALFTONE = '<svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="3"/><circle cx="16.5" cy="6.5" r="1.8"/><circle cx="11.5" cy="14" r="2.4"/><circle cx="19" cy="17" r="1.2"/><circle cx="5" cy="18.5" r="1.4"/></svg>';

const FX_DEFS = /** @type {Record<FxKind, {icon: string, label: string, pad?: boolean, cpu: (data: Uint8ClampedArray, s: any, b: import('./boards.js').Board, d: any) => void}>} */ ({
  gauss: {
    icon: ICON_DROP, label: 'Gaussian Blur', pad: true,
    cpu: (data, s) => gaussianBlurBuffer(data, s.texW, s.texH, s.sigma),
  },
  motion: {
    icon: ICON_WIND, label: 'Motion Blur', pad: true,
    cpu: (data, s, b, d) => motionBlurBuffer(data, s.texW, s.texH, d.angle, s.dist),
  },
  zoom: {
    icon: ICON_RADIAL, label: 'Radial Blur', pad: true,
    cpu: (data, s, b, d) => zoomBlurBuffer(data, s.texW, s.texH, d.cx - s.texX, d.cy - s.texY, d.k),
  },
  noise: {
    icon: ICON_NOISE, label: 'Noise',
    cpu: (data, s, b, d) => noiseBuffer(data, s.texW, s.texH, d.amount,
      d.colorMix, s.grainSize, d.roughness, s.seed),
  },
  grain: {
    icon: ICON_FILM, label: 'Film Grain',
    cpu: (data, s, b, d) => grainBuffer(data, s.texW, s.texH, d.amount,
      s.grainSize, d.roughness, s.seed),
  },
  thresh: {
    icon: ICON_CONTRAST, label: 'Threshold',
    cpu: (data, s, b, d) => thresholdBuffer(data, s.texW, s.texH, d.thresh),
  },
  halftone: {
    icon: ICON_HALFTONE, label: 'Halftone',
    cpu: (data, s, b, d) => halftoneBuffer(data, s.texW, s.texH,
      s.radius, d.spacing, d.angle, d.colorMix, s.texX - b.x, s.texY - b.y),
  },
});

const FX_ORDER = /** @type {FxKind[]} */ (Object.keys(FX_DEFS));

/** @typedef {'rowSigma'|'rowHalftoneRadius'|'rowAngle'|'rowDist'|'rowStrength'|'rowCtrX'|'rowCtrY'|'rowAmount'|'rowColor'|'rowGrainSize'|'rowRoughness'|'rowThresh'} FxRowProp */
/** @typedef {'sigma'|'radius'|'angle'|'dist'|'strength'|'ctrX'|'ctrY'|'amount'|'colorMix'|'grainSize'|'roughness'|'thresh'} FxStateKey */

/** @type {[FxRowProp, FxKind[]][]} */
const FX_ROW_VISIBILITY = [
  ['rowSigma', ['gauss']],
  ['rowHalftoneRadius', ['halftone']],
  ['rowAngle', ['motion', 'halftone']],
  ['rowDist', ['motion']],
  ['rowStrength', ['zoom']],
  ['rowCtrX', ['zoom']],
  ['rowCtrY', ['zoom']],
  ['rowAmount', ['noise', 'grain']],
  ['rowColor', ['noise', 'halftone']],
  ['rowGrainSize', ['noise', 'grain']],
  ['rowRoughness', ['noise', 'grain']],
  ['rowThresh', ['thresh']],
];

/** @type {[FxRowProp, string, number, number, string, FxStateKey][]} */
const FX_SLIDER_ROWS = [
  ['rowSigma', 'Radius', 1, FX_SIGMA_MAX, ' px', 'sigma'],
  ['rowHalftoneRadius', 'Radius', 1, 64, ' px', 'radius'],
  ['rowAngle', 'Angle', 0, 360, '°', 'angle'],
  ['rowDist', 'Distance', 2, 2 * PAD, ' px', 'dist'],
  ['rowStrength', 'Intensity', 1, 100, '%', 'strength'],
  ['rowCtrX', 'Center X', 0, 100, '%', 'ctrX'],
  ['rowCtrY', 'Center Y', 0, 100, '%', 'ctrY'],
  ['rowAmount', 'Amount', 1, 100, '%', 'amount'],
  ['rowColor', 'Color', 0, 100, '%', 'colorMix'],
  ['rowGrainSize', 'Size', 1, 32, ' px', 'grainSize'],
  ['rowRoughness', 'Roughness', 0, 100, '%', 'roughness'],
  ['rowThresh', 'Level', 0, 255, '', 'thresh'],
];

export class FxTool extends FxSessionTool {
  /** @param {App} app */
  constructor(app) {
    super(app, 'fxpanel', 'tool-fx', 'fx-close');
    this._build();
  }

  _build() {
    const body = document.getElementById('fx-body');

    // lista degli effetti
    this.listEl = this._makeItemList(FX_ORDER, FX_DEFS, (kind) => this._onPick(kind));

    // parametri (visibili in sessione; righe per kind)
    this.paramsEl = document.createElement('div');
    this.paramsEl.className = 'fx-params';
    this.paramsEl.hidden = true;
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'fx-title';
    const rows = FX_SLIDER_ROWS.map(([prop, label, min, max, suffix, stateKey]) => {
      const row = this._sliderRow(label, min, max, suffix,
        (s, v) => { s[stateKey] = v; }, (s) => s[stateKey]);
      /** @type {any} */ (this)[prop] = row;
      return row;
    });
    this.paramsEl.append(this.titleEl, ...rows.map((row) => row.root), this._makeActions());

    body.append(this.listEl, this._makeHint(), this.paramsEl);
  }

  /** @param {FxKind} kind */
  _onPick(kind) {
    if (!this._pickGuard()) return;
    // hull: blur con spargimento tappato = bbox+PAD; zoom = board intero
    // (le striature raggiungono tutto); puntuali = bbox secco
    const pad = FX_DEFS[kind].pad ? PAD : 0;
    const ok = this._beginSession(kind, pad, kind === 'zoom', {
      sigma: 8, radius: 3, angle: kind === 'halftone' ? 22 : 0,
      dist: 60, strength: 50, ctrX: 50, ctrY: 50,
      amount: 28, colorMix: 0, grainSize: kind === 'noise' ? 1 : 4,
      roughness: kind === 'noise' ? 90 : 42, thresh: 128,
      // pattern stabile per tutta la sessione, diverso a ogni apertura
      seed: (this._stamp * 137.213) % 251,
    });
    if (!ok) return this._flash('The layer is empty: nothing to apply.');
    this._sig = '';
    this._refresh();
  }

  /** @param {any} s @param {import('./boards.js').Board} b */
  _params(s, b) {
    return {
      sigma: s.sigma,
      radius: s.radius,
      spacing: s.radius * 2,
      angle: s.angle * Math.PI / 180,
      dist: s.dist,
      k: s.strength / 100 * 0.3,
      cx: b.x + s.ctrX / 100 * b.w,
      cy: b.y + s.ctrY / 100 * b.h,
      amount: s.amount / 100 * (s.kind === 'grain' ? 0.34 : 0.5),
      colorMix: s.colorMix / 100,
      grainSize: s.grainSize,
      roughness: s.roughness / 100,
      seed: s.seed,
      thresh: s.thresh / 255,
    };
  }

  /** @param {Uint8ClampedArray} data @param {any} s @param {import('./boards.js').Board} b */
  _cpuApply(data, s, b) {
    const d = this._params(s, b);
    const kind = /** @type {FxKind} */ (s.kind);
    (FX_DEFS[kind] || FX_DEFS.thresh).cpu(data, s, b, d);
  }

  // Riallinea il pannello allo stato (firma: zero lavoro DOM a regime).
  _refresh() {
    const layer = this.app.layerMgr.active;
    const s = this._session;
    const sig = `${layer ? layer.id : 0}|${layer ? layer.kind : ''}|` +
      `${layer && layer.visible ? 1 : 0}|${s ? s.kind + s.stamp : '-'}`;
    if (sig === this._sig) return;
    this._sig = sig;
    const inSession = s !== null;
    this.listEl.hidden = inSession;
    this.paramsEl.hidden = !inSession;
    if (inSession) {
      const kind = /** @type {FxKind} */ (s.kind);
      this.titleEl.innerHTML = FX_DEFS[kind].icon + `<span>${FX_DEFS[kind].label}</span>`;
      for (const [prop, kinds] of FX_ROW_VISIBILITY) {
        const row = /** @type {any} */ (this)[prop];
        row.root.hidden = !kinds.includes(kind);
        row.refresh(s);
      }
    }
    this._hintFor(layer, inSession);
  }
}
