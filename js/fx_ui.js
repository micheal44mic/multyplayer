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

/** @type {Record<FxKind, {icon: string, label: string}>} */
const FX_META = {
  gauss: { icon: ICON_DROP, label: 'Gaussian Blur' },
  motion: { icon: ICON_WIND, label: 'Motion Blur' },
  zoom: { icon: ICON_RADIAL, label: 'Radial Blur' },
  noise: { icon: ICON_NOISE, label: 'Noise' },
  grain: { icon: ICON_FILM, label: 'Film Grain' },
  thresh: { icon: ICON_CONTRAST, label: 'Threshold' },
  halftone: { icon: ICON_HALFTONE, label: 'Halftone' },
};

export class FxTool extends FxSessionTool {
  /** @param {App} app */
  constructor(app) {
    super(app, 'fxpanel', 'tool-fx', 'fx-close');
    this._build();
  }

  _build() {
    const body = document.getElementById('fx-body');

    // lista degli effetti
    this.listEl = document.createElement('div');
    this.listEl.className = 'fx-list';
    for (const kind of /** @type {FxKind[]} */ (['gauss', 'motion', 'zoom', 'noise', 'grain', 'thresh', 'halftone'])) {
      const b = document.createElement('button');
      b.className = 'fx-item';
      b.type = 'button';
      b.innerHTML = FX_META[kind].icon + `<span>${FX_META[kind].label}</span>`;
      b.addEventListener('click', () => this._onPick(kind));
      this.listEl.appendChild(b);
    }

    // parametri (visibili in sessione; righe per kind)
    this.paramsEl = document.createElement('div');
    this.paramsEl.className = 'fx-params';
    this.paramsEl.hidden = true;
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'fx-title';
    this.rowSigma = this._sliderRow('Radius', 1, FX_SIGMA_MAX, ' px',
      (s, v) => { s.sigma = v; }, (s) => s.sigma);
    this.rowHalftoneRadius = this._sliderRow('Radius', 1, 64, ' px',
      (s, v) => { s.radius = v; }, (s) => s.radius);
    this.rowAngle = this._sliderRow('Angle', 0, 360, '°',
      (s, v) => { s.angle = v; }, (s) => s.angle);
    this.rowDist = this._sliderRow('Distance', 2, 2 * PAD, ' px',
      (s, v) => { s.dist = v; }, (s) => s.dist);
    this.rowStrength = this._sliderRow('Intensity', 1, 100, '%',
      (s, v) => { s.strength = v; }, (s) => s.strength);
    this.rowCtrX = this._sliderRow('Center X', 0, 100, '%',
      (s, v) => { s.ctrX = v; }, (s) => s.ctrX);
    this.rowCtrY = this._sliderRow('Center Y', 0, 100, '%',
      (s, v) => { s.ctrY = v; }, (s) => s.ctrY);
    this.rowAmount = this._sliderRow('Amount', 1, 100, '%',
      (s, v) => { s.amount = v; }, (s) => s.amount);
    this.rowColor = this._sliderRow('Color', 0, 100, '%',
      (s, v) => { s.colorMix = v; }, (s) => s.colorMix);
    this.rowGrainSize = this._sliderRow('Size', 1, 32, ' px',
      (s, v) => { s.grainSize = v; }, (s) => s.grainSize);
    this.rowRoughness = this._sliderRow('Roughness', 0, 100, '%',
      (s, v) => { s.roughness = v; }, (s) => s.roughness);
    this.rowThresh = this._sliderRow('Level', 0, 255, '',
      (s, v) => { s.thresh = v; }, (s) => s.thresh);
    this.paramsEl.append(this.titleEl, this.rowSigma.root, this.rowHalftoneRadius.root,
      this.rowAngle.root, this.rowDist.root, this.rowStrength.root, this.rowCtrX.root,
      this.rowCtrY.root, this.rowAmount.root, this.rowColor.root,
      this.rowGrainSize.root, this.rowRoughness.root, this.rowThresh.root, this._makeActions());

    body.append(this.listEl, this._makeHint(), this.paramsEl);
  }

  /** @param {FxKind} kind */
  _onPick(kind) {
    if (!this._pickGuard()) return;
    // hull: blur con spargimento tappato = bbox+PAD; zoom = board intero
    // (le striature raggiungono tutto); puntuali = bbox secco
    const pad = kind === 'gauss' || kind === 'motion' ? PAD
      : kind === 'zoom' ? PAD : 0;
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
    if (s.kind === 'gauss') gaussianBlurBuffer(data, s.texW, s.texH, s.sigma);
    else if (s.kind === 'motion') motionBlurBuffer(data, s.texW, s.texH, d.angle, s.dist);
    else if (s.kind === 'zoom') zoomBlurBuffer(data, s.texW, s.texH, d.cx - s.texX, d.cy - s.texY, d.k);
    else if (s.kind === 'noise') noiseBuffer(data, s.texW, s.texH, d.amount,
      d.colorMix, s.grainSize, d.roughness, s.seed);
    else if (s.kind === 'grain') grainBuffer(data, s.texW, s.texH, d.amount,
      s.grainSize, d.roughness, s.seed);
    else if (s.kind === 'halftone') halftoneBuffer(data, s.texW, s.texH,
      s.radius, d.spacing, d.angle, d.colorMix, s.texX - b.x, s.texY - b.y);
    else thresholdBuffer(data, s.texW, s.texH, d.thresh);
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
      this.titleEl.innerHTML = FX_META[kind].icon + `<span>${FX_META[kind].label}</span>`;
      this.rowSigma.root.hidden = kind !== 'gauss';
      this.rowHalftoneRadius.root.hidden = kind !== 'halftone';
      this.rowAngle.root.hidden = kind !== 'motion' && kind !== 'halftone';
      this.rowDist.root.hidden = kind !== 'motion';
      this.rowStrength.root.hidden = kind !== 'zoom';
      this.rowCtrX.root.hidden = kind !== 'zoom';
      this.rowCtrY.root.hidden = kind !== 'zoom';
      this.rowAmount.root.hidden = kind !== 'noise' && kind !== 'grain';
      this.rowColor.root.hidden = kind !== 'noise' && kind !== 'halftone';
      this.rowGrainSize.root.hidden = kind !== 'noise' && kind !== 'grain';
      this.rowRoughness.root.hidden = kind !== 'noise' && kind !== 'grain';
      this.rowThresh.root.hidden = kind !== 'thresh';
      for (const r of [this.rowSigma, this.rowHalftoneRadius, this.rowAngle, this.rowDist,
        this.rowStrength, this.rowCtrX, this.rowCtrY,
        this.rowAmount, this.rowColor, this.rowGrainSize, this.rowRoughness,
        this.rowThresh]) r.refresh(s);
    }
    this._hintFor(layer, inSession);
  }
}
