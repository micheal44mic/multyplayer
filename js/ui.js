// UI: Brush Studio (popup con preview live e tab per categoria), toolbar,
// swatch, scorciatoie, export PNG.

import { brush } from './brush.js';
import { hexToRgb, clamp } from './util.js';
import { CHUNK } from './store.js';
import { ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { BrushPreview } from './brush_preview.js';
import { textureFromFile, defaultGrainTexture } from './texture.js';
import { shapeFromFile } from './shape.js';
import { TextUI } from './text_ui.js';
import { LayersUI } from './layers_ui.js';
import { PresetsUI } from './presets_ui.js';
import { MockupUI } from './mockup_ui.js';
import { drawTextDocument } from './text_layer.js';
import { refreshClipBases } from './layers.js';
import { C2D_MODE } from './renderer_2d.js';
import { track } from './telemetry.js';
import { createRangeRow } from './panel_controls.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./brush.js').Tool} Tool */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

const TOOL_BUTTONS = /** @type {[string, Tool][]} */ ([
  ['tool-brush', 'brush'], ['tool-eraser', 'eraser'], ['tool-blur', 'blur'],
  ['tool-liquify', 'liquify'], ['tool-select', 'select'], ['tool-move', 'move'], ['tool-pan', 'pan'],
]);
const SIMPLE_TOOL_BUTTONS = TOOL_BUTTONS.filter(([, t]) => !['brush', 'blur', 'liquify'].includes(t));
const SELECT_KIND_BUTTONS = [['sel-kind-color', 'color'], ['sel-kind-lasso', 'lasso'], ['sel-kind-polygon', 'polygon']];
const SELECT_OP_BUTTONS = [['sel-op-replace', 'replace'], ['sel-op-add', 'add'], ['sel-op-subtract', 'subtract']];

// Valori di fabbrica del pennello (colore e tool esclusi): "Reimposta pennello".
const BRUSH_DEFAULTS = (() => {
  const {
    color, tool,
    blurSize, blurStrength, blurOpacity, blurSoftness,
    liquifyMode, liquifySize, liquifyPressure, liquifyDistortion, liquifyMomentum,
    ...rest
  } = brush;
  return rest;
})();

/**
 * Riga di un pannello: sezione ({sec}), toggle ({toggle}) o slider completo.
 * dep: la riga è attiva solo se ritorna true (rinfrescata quando un toggle
 * cambia). renderer: riga speciale costruita con accesso all'App.
 * @typedef {Object} RowDef
 * @property {string} [sec]
 * @property {boolean} [renderer]
 * @property {boolean} [texture] riga speciale: import/gestione texture
 * @property {boolean} [shape] riga speciale: import/gestione shape dello stamp
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
 * @property {(v: number) => number} [snap] quantizza il valore dello slider
 * @property {(cur: number, dir: number) => number} [stepFn] passo custom per stepper/scorciatoie
 * @property {() => boolean} [dep]
 * @property {HTMLInputElement} [_input]
 * @property {() => void} [_refresh]
 */

// Dimensione pennello: continua fino a 500 px, poi tappe fisse per i formati
// giganti (sfondi). 500 è inclusa così appena oltre il limite continuo lo
// slider non salta subito a 1000.
const SIZE_STOPS = [500, 1000, 1200, 1600, 2000];
const SIZE_MAX = 2000;

/** Snap: sotto 500 libero, sopra alla tappa più vicina (in scala log, come lo slider). @param {number} v */
function snapSize(v) {
  if (v <= 500) return v;
  let best = SIZE_MAX, bd = Infinity;
  for (const s of SIZE_STOPS) {
    const d = Math.abs(Math.log(v / s));
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** Passo relativo (stepper e tasti [ ]): ~10% sotto 500, di tappa in tappa sopra. @param {number} cur @param {number} dir */
function stepSize(cur, dir) {
  if (dir > 0) {
    if (cur >= 500) {
      for (const s of SIZE_STOPS) if (s > cur) return s;
      return SIZE_MAX;
    }
    return Math.min(500, Math.max(cur + 1, Math.round(cur * 1.1)));
  }
  if (cur > 500) {
    for (let i = SIZE_STOPS.length - 1; i >= 0; i--) if (SIZE_STOPS[i] < cur) return SIZE_STOPS[i];
    return 500;
  }
  return Math.max(1, Math.min(cur - 1, Math.round(cur / 1.1)));
}

// Icone delle tab (path 24x24, fill currentColor).
const ICONS = {
  base: '<path d="M20.7 3.3c-1-1-2.7-.9-3.6.1L9 11.5l3.5 3.5 8.1-8.1c1-1 1.1-2.6.1-3.6zM8 13c-2 0-3.5 1.6-3.5 3.5 0 1.5-1.2 2.2-2.5 2.5 1 1.3 2.7 2 4.5 2 2.8 0 5-2.2 5-5L8 13z"/>',
  shape: '<path d="M12 4C6.5 4 2 7.6 2 12s4.5 8 10 8 10-3.6 10-8-4.5-8-10-8zm0 2c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z"/>',
  texture: '<path fill-rule="evenodd" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h14V5H5z"/><circle cx="8.5" cy="8.5" r="1.7"/><circle cx="14.5" cy="7.5" r="1.1"/><circle cx="17" cy="11" r="1.3"/><circle cx="7.5" cy="14.5" r="1.2"/><circle cx="12" cy="12" r="1"/><circle cx="14" cy="16.5" r="1.8"/>',
  scatter: '<path d="M7 3.5a2.2 2.2 0 1 1-.01 0zM16.5 5.5a2.8 2.8 0 1 1-.01 0zM5.5 12.5a2.8 2.8 0 1 1-.01 0zM14 13a3.6 3.6 0 1 1-.01 0z"/>',
  jitter: '<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  color: '<path d="M12 2.5s6.5 7 6.5 11.4a6.5 6.5 0 1 1-13 0C5.5 9.5 12 2.5 12 2.5z"/>',
  more: '<path fill-rule="evenodd" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4c0 .6 0 1.1-.1 1.6l2 1.6-2 3.5-2.4-1a8 8 0 0 1-2.8 1.6L15.3 22H8.7l-.4-2.7a8 8 0 0 1-2.8-1.6l-2.4 1-2-3.5 2-1.6A8.6 8.6 0 0 1 3 12c0-.6 0-1.1.1-1.6l-2-1.6 2-3.5 2.4 1a8 8 0 0 1 2.8-1.6L8.7 2h6.6l.4 2.7a8 8 0 0 1 2.8 1.6l2.4-1 2 3.5-2 1.6c.1.5.1 1 .1 1.6z"/>',
};

// Slider: min/max/step sono valori UI; get/set convertono da/verso il modello.
/** @type {{id: string, label: string, icon: string, rows: RowDef[]}[]} */
const TABS = [
  { id: 'base', label: 'Base', icon: ICONS.base, rows: [
    { id: 'size', label: 'Size', min: 1, max: SIZE_MAX, step: 1, get: () => brush.size, set: v => brush.size = v, fmt: v => v + ' px', log: true, snap: snapSize, stepFn: stepSize },
    { id: 'opacity', label: 'Opacity', min: 1, max: 100, step: 1, get: () => brush.opacity * 100, set: v => brush.opacity = v / 100, fmt: v => v + '%' },
    { id: 'soft', label: 'Softness', min: 0, max: 100, step: 1, dep: () => !brush.shape, get: () => (1 - brush.hardness) * 100, set: v => brush.hardness = 1 - v / 100, fmt: v => v + '%' },
    { id: 'smooth', label: 'Stabilization', min: 0, max: 100, step: 1, get: () => brush.smoothing * 100, set: v => brush.smoothing = v / 100, fmt: v => v + '%' },
    { id: 'spacing', label: 'Spacing', min: 0.1, max: 300, step: 0.1, get: () => brush.spacing * 100, set: v => brush.spacing = v / 100, fmt: v => v.toFixed(1) + '%', log: true },
    { toggle: { label: 'Buildup', hint: 'ON: each stamp adds up within the stroke · OFF: uniform stroke opacity', get: () => brush.buildup, set: v => brush.buildup = v } },
  ] },
  { id: 'shape', label: 'Shape', icon: ICONS.shape, rows: [
    { shape: true },
    { toggle: { label: 'Invert', hint: 'filled ↔ empty inside the stamp bounds', get: () => brush.shapeInvert, set: v => brush.shapeInvert = v }, dep: () => !!brush.shape },
    { id: 'roundness', label: 'Roundness', min: 5, max: 100, step: 1, get: () => brush.roundness * 100, set: v => brush.roundness = v / 100, fmt: v => v + '%' },
    { id: 'angle', label: 'Angle', min: 0, max: 360, step: 1, get: () => brush.angle, set: v => brush.angle = v, fmt: v => v + '°' },
    // quota della direzione del gesto sommata all'angolo: a ±100 lo stamp
    // segue il tratto (col segno), a 0 resta fisso
    { id: 'rot', label: 'Rotation', min: -100, max: 100, step: 1, get: () => brush.rotation * 100, set: v => brush.rotation = v / 100, fmt: v => v >= 100 ? 'follows stroke' : v <= -100 ? 'reverse' : (v > 0 ? '+' : '') + v + '%' },
  ] },
  { id: 'texture', label: 'Texture', icon: ICONS.texture, rows: [
    { texture: true },
    { toggle: { label: 'Texture enabled', hint: 'grain modulates the alpha of every stamp', get: () => brush.textureOn, set: v => brush.textureOn = v }, dep: () => !!brush.texture },
    { id: 'txscale', label: 'Scale', min: 10, max: 400, step: 1, log: true, dep: () => !!brush.texture && brush.textureOn, get: () => brush.textureScale * 100, set: v => brush.textureScale = v / 100, fmt: v => Math.round(v) + '%' },
    { id: 'txangle', label: 'Angle', min: 0, max: 360, step: 1, dep: () => !!brush.texture && brush.textureOn, get: () => brush.textureAngle || 0, set: v => brush.textureAngle = v, fmt: v => v + '°' },
    { id: 'txdepth', label: 'Depth', min: 0, max: 100, step: 1, dep: () => !!brush.texture && brush.textureOn, get: () => brush.textureDepth * 100, set: v => brush.textureDepth = v / 100, fmt: v => v + '%' },
    { id: 'txcontrast', label: 'Contrast', min: 10, max: 300, step: 1, dep: () => !!brush.texture && brush.textureOn, get: () => brush.textureContrast * 100, set: v => brush.textureContrast = v / 100, fmt: v => v + '%' },
    { id: 'txfloor', label: 'Minimum tone', min: 0, max: 100, step: 1, dep: () => !!brush.texture && brush.textureOn, get: () => brush.textureFloor * 100, set: v => brush.textureFloor = v / 100, fmt: v => v + '%' },
    { toggle: { label: 'Invert', hint: 'dark = filled instead of empty', get: () => brush.textureInvert, set: v => brush.textureInvert = v }, dep: () => !!brush.texture && brush.textureOn },
    { toggle: { label: 'Follow stroke', hint: 'OFF: grain stays fixed on the canvas (paper) · ON: texture follows every stamp', get: () => brush.textureMoving, set: v => brush.textureMoving = v }, dep: () => !!brush.texture && brush.textureOn },
    { toggle: { label: 'Texture colors', hint: 'the stroke uses image colors instead of the brush color', get: () => brush.textureUseColor, set: v => brush.textureUseColor = v }, dep: () => !!brush.texture && brush.textureOn },
  ] },
  { id: 'scatter', label: 'Scatter', icon: ICONS.scatter, rows: [
    { toggle: { label: 'Scatter', hint: 'each stamp becomes a cloud of particles', get: () => brush.scatter, set: v => brush.scatter = v } },
    { id: 'pdens', label: 'Density', min: 25, max: 300, step: 1, dep: () => brush.scatter, get: () => brush.particleDensity, set: v => brush.particleDensity = v, fmt: v => `${v}% · ${Math.max(1, Math.min(12, Math.round(4 * v / 100)))} pt` },
    { id: 'psize', label: 'Particle size', min: 5, max: 200, step: 1, dep: () => brush.scatter, get: () => brush.particleSize, set: v => brush.particleSize = v, fmt: v => v + '%' },
    { id: 'pdev', label: 'Deviation', min: -100, max: 100, step: 1, dep: () => brush.scatter, get: () => brush.particleDeviation, set: v => brush.particleDeviation = v, fmt: v => (v > 0 ? '+' : '') + v + '%' },
  ] },
  { id: 'jitter', label: 'Jitter', icon: ICONS.jitter, rows: [
    { id: 'jpos', label: 'Position jitter', min: 0, max: 100, step: 1, get: () => brush.jitterPos * 100, set: v => brush.jitterPos = v / 100, fmt: v => v + '%' },
    { id: 'jsize', label: 'Width jitter', min: 0, max: 100, step: 1, get: () => brush.jitterSize * 100, set: v => brush.jitterSize = v / 100, fmt: v => v + '%' },
    { id: 'jop', label: 'Opacity jitter', min: 0, max: 100, step: 1, get: () => brush.jitterOpacity * 100, set: v => brush.jitterOpacity = v / 100, fmt: v => v + '%' },
    { id: 'jspc', label: 'Spacing jitter', min: 0, max: 100, step: 1, get: () => brush.jitterSpacing * 100, set: v => brush.jitterSpacing = v / 100, fmt: v => v + '%' },
    { id: 'jang', label: 'Angle jitter', min: 0, max: 100, step: 1, get: () => brush.jitterAngle * 100, set: v => brush.jitterAngle = v / 100, fmt: v => v + '%' },
  ] },
  { id: 'color', label: 'Color', icon: ICONS.color, rows: [
    { id: 'jbri', label: 'Brightness jitter', min: 0, max: 100, step: 1, get: () => brush.jitterBright * 100, set: v => brush.jitterBright = v / 100, fmt: v => v + '%' },
    { id: 'jsat', label: 'Saturation jitter', min: 0, max: 100, step: 1, get: () => brush.jitterSat * 100, set: v => brush.jitterSat = v / 100, fmt: v => v + '%' },
  ] },
  { id: 'more', label: 'More', icon: ICONS.more, rows: [
    // Punte del tratto: % dello spessore base ai vertici. La lunghezza delle
    // punte non si imposta: la decide la velocità del gesto agli estremi
    // (tratto posato = corte e smussate, frustata = lunghe); vedi stroke.js.
    { sec: 'Stroke Dynamics' },
    { id: 'tstart', label: 'Start width', min: 0, max: 100, step: 1, get: () => brush.taperStart * 100, set: v => brush.taperStart = v / 100, fmt: v => v + '%' },
    { id: 'tend', label: 'End width', min: 0, max: 100, step: 1, get: () => brush.taperEnd * 100, set: v => brush.taperEnd = v / 100, fmt: v => v + '%' },
    { sec: 'Renderer' },
    { renderer: true },
  ] },
];

// Lista piatta per sync (scorciatoie [ ] e reset).
const ALL_ROWS = TABS.flatMap(t => t.rows);

/** @type {RowDef[]} */
const BLUR_ROWS = [
  { id: 'blurSize', label: 'Size', min: 1, max: SIZE_MAX, step: 1, get: () => brush.blurSize, set: v => brush.blurSize = v, fmt: v => v + ' px', log: true, snap: snapSize, stepFn: stepSize },
  { id: 'blurOpacity', label: 'Opacity', min: 1, max: 100, step: 1, get: () => (brush.blurOpacity ?? 1) * 100, set: v => brush.blurOpacity = v / 100, fmt: v => v + '%' },
  { id: 'blurSoftness', label: 'Softness', min: 0, max: 100, step: 1, get: () => brush.blurSoftness * 100, set: v => brush.blurSoftness = v / 100, fmt: v => v + '%' },
];

const LIQUIFY_MODES = [
  ['push', 'Push'],
  ['twirlR', 'Twirl R'],
  ['twirlL', 'Twirl L'],
  ['pinch', 'Pinch'],
  ['expand', 'Expand'],
  ['crystals', 'Crystals'],
  ['edge', 'Edge'],
  ['reconstruct', 'Reconstruct'],
];

/** @type {RowDef[]} */
const LIQUIFY_ROWS = [
  { id: 'liquifySize', label: 'Size', min: 1, max: SIZE_MAX, step: 1, get: () => brush.liquifySize, set: v => brush.liquifySize = v, fmt: v => v + ' px', log: true, snap: snapSize, stepFn: stepSize },
  { id: 'liquifyPressure', label: 'Pressure', min: 1, max: 100, step: 1, get: () => (brush.liquifyPressure ?? 0.68) * 100, set: v => brush.liquifyPressure = v / 100, fmt: v => v + '%' },
  { id: 'liquifyDistortion', label: 'Distortion', min: 0, max: 100, step: 1, get: () => (brush.liquifyDistortion ?? 0) * 100, set: v => brush.liquifyDistortion = v / 100, fmt: v => v + '%' },
  { id: 'liquifyMomentum', label: 'Momentum', min: 0, max: 100, step: 1, get: () => (brush.liquifyMomentum ?? 0) * 100, set: v => brush.liquifyMomentum = v / 100, fmt: v => v + '%' },
];

export class UI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.studio = document.getElementById('studio');
    this.backdrop = document.getElementById('studio-backdrop');
    this.blurPopup = document.getElementById('blurpopup');
    this.liquifyPopup = document.getElementById('liquifypopup');
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
    /** @type {(() => void)|null} */
    this._texRefresh = null;
    /** @type {(() => void)|null} */
    this._shapeRefresh = null;
    /** @type {HTMLButtonElement[]} */
    this._liquifyModeBtns = [];
    this.layersUI = new LayersUI(app);
    this.textUI = new TextUI(app);
    this.presetsUI = new PresetsUI(this);
    this.mockups = new MockupUI(app, this);
    this._buildStudio();
    this._buildBlurPopup();
    this._buildLiquifyPopup();
    this._bindToolbar();
    this._buildSideSliders();
    this._bindKeys();
    this._bindImageImport();
  }

  // ---- slider rapidi (touch): i controlli primari sul bordo sinistro ----
  // Visibili solo su pointer coarse (CSS): seguono il tool attivo.
  // riallineano studio e badge come le scorciatoie [ e ].
  _buildSideSliders() {
    const wrap = document.getElementById('sidesliders');
    const preview = document.createElement('div');
    preview.id = 'ss-preview';
    const previewHead = document.createElement('div');
    previewHead.className = 'ss-preview-head';
    const previewBody = document.createElement('div');
    previewBody.className = 'ss-preview-body';
    const previewMark = document.createElement('div');
    previewMark.className = 'ss-preview-mark';
    previewBody.appendChild(previewMark);
    preview.append(previewHead, previewBody);
    document.body.appendChild(preview);
    /** @type {ReturnType<typeof setTimeout>|null} */
    let previewTimer = null;

    /** @param {HTMLElement} track @param {string} title @param {number} t */
    const showPreview = (track, title, t) => {
      if (previewTimer) clearTimeout(previewTimer);
      const label = brush.tool === 'liquify' && title === 'Opacity' ? 'Pressure'
        : brush.tool === 'liquify' && title === 'Softness' ? 'Distortion'
          : title;
      const pct = Math.round(clamp(t, 0, 1) * 100);
      const r = track.getBoundingClientRect();
      const top = clamp(r.top + r.height / 2, 142, window.innerHeight - 118);
      const size = clamp(brush.tool === 'blur' ? brush.blurSize : brush.tool === 'liquify' ? brush.liquifySize : brush.size, 1, SIZE_MAX);
      const sizeT = clamp(Math.log(size) / Math.log(SIZE_MAX), 0, 1);
      const mark = Math.round(5 + Math.pow(sizeT, 0.82) * 76);
      const roundness = brush.tool === 'blur' || brush.tool === 'liquify' ? 1 : clamp(brush.roundness || 1, 0.05, 1);
      const alpha = brush.tool === 'blur'
        ? clamp(brush.blurOpacity ?? 1, 0, 1)
        : brush.tool === 'liquify'
          ? clamp(brush.liquifyPressure ?? 0.68, 0, 1)
        : clamp(brush.opacity, 0, 1);
      const softness = brush.tool === 'blur'
        ? clamp(brush.blurSoftness ?? 0.65, 0, 1)
        : brush.tool === 'liquify'
          ? clamp(brush.liquifyDistortion ?? 0, 0, 1)
        : clamp(1 - brush.hardness, 0, 1);
      const hardness = 1 - softness;
      const hardStop = Math.round(18 + hardness * 58);
      const featherStop = Math.min(98, hardStop + Math.round(18 + (1 - hardness) * 18));
      preview.style.top = top + 'px';
      preview.classList.toggle('opacity', label !== 'Size');
      previewHead.textContent = title === 'Size' ? `${label} ${size} px` : `${label} ${pct}%`;
      previewMark.style.width = mark + 'px';
      previewMark.style.height = Math.max(4, Math.round(mark * roundness)) + 'px';
      previewMark.style.transform = `rotate(${brush.tool === 'blur' || brush.tool === 'liquify' ? 0 : brush.angle || 0}deg)`;
      previewMark.style.background =
        `radial-gradient(circle, rgba(0,0,0,${alpha}) 0 ${hardStop}%, ` +
        `rgba(0,0,0,${alpha * 0.36}) ${featherStop}%, rgba(0,0,0,0) 100%)`;
      preview.classList.add('show');
    };
    const hidePreview = () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => preview.classList.remove('show'), 560);
    };

    /** @param {string} title @param {() => number} get01 @param {(t: number) => void} apply @param {() => boolean} [visible] */
    const mk = (title, get01, apply, visible) => {
      const track = document.createElement('div');
      track.className = 'ss-track';
      track.title = title;
      track.setAttribute('aria-label', title);
      const fill = document.createElement('div');
      fill.className = 'ss-fill';
      const thumb = document.createElement('div');
      thumb.className = 'ss-thumb';
      track.append(fill, thumb);
      const sync = () => {
        const show = visible ? visible() : true;
        track.hidden = !show;
        if (!show) return;
        const t = clamp(get01(), 0, 1);
        fill.style.setProperty('--ss-fill', String(Math.sqrt(t)));
        thumb.style.top = ((1 - t) * 100) + '%';
      };
      /** @param {PointerEvent} e */
      const onPoint = (e) => {
        const r = track.getBoundingClientRect();
        const t = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
        apply(t);
        this.syncSliders();
        if (brush.tool === 'blur') this._blurSettingChanged();
        else if (brush.tool === 'liquify') this._liquifySettingChanged();
        else this._settingChanged();
        showPreview(track, title, t);
      };
      track.addEventListener('pointerdown', (e) => {
        track.setPointerCapture(e.pointerId);
        onPoint(e);
      });
      track.addEventListener('pointermove', (e) => {
        if (track.hasPointerCapture(e.pointerId)) onPoint(e);
      });
      track.addEventListener('pointerup', hidePreview);
      track.addEventListener('pointercancel', hidePreview);
      track.addEventListener('lostpointercapture', hidePreview);
      wrap.appendChild(track);
      return sync;
    };
    // dimensione sulla stessa scala log dello slider in studio
    const lnMax = Math.log(SIZE_MAX);
    /** @type {(() => void)[]} */
    this._ssSync = [
      () => wrap.classList.toggle('has-softness', brush.tool === 'blur' || brush.tool === 'liquify'),
      mk('Size',
        () => Math.log(clamp(brush.tool === 'blur' ? brush.blurSize : brush.tool === 'liquify' ? brush.liquifySize : brush.size, 1, SIZE_MAX)) / lnMax,
        (t) => {
          const size = Math.round(Math.exp(t * lnMax));
          if (brush.tool === 'blur') brush.blurSize = size;
          else if (brush.tool === 'liquify') brush.liquifySize = size;
          else brush.size = size;
        }),
      mk('Opacity',
        () => brush.tool === 'blur' ? (brush.blurOpacity ?? 1) : brush.tool === 'liquify' ? (brush.liquifyPressure ?? 0.68) : brush.opacity,
        (t) => {
          if (brush.tool === 'blur') brush.blurOpacity = Math.round(t * 100) / 100;
          else if (brush.tool === 'liquify') brush.liquifyPressure = Math.round(t * 100) / 100;
          else brush.opacity = Math.round(t * 100) / 100;
        }),
      mk('Softness',
        () => brush.tool === 'liquify' ? (brush.liquifyDistortion ?? 0) : brush.blurSoftness,
        (t) => {
          if (brush.tool === 'liquify') brush.liquifyDistortion = Math.round(t * 100) / 100;
          else brush.blurSoftness = Math.round(t * 100) / 100;
        },
        () => brush.tool === 'blur' || brush.tool === 'liquify'),
    ];
    for (const f of this._ssSync) f();
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
        else if (def.texture) pane.appendChild(this._buildTextureRow());
        else if (def.shape) pane.appendChild(this._buildShapeRow());
        else if (def.toggle) pane.appendChild(this._buildToggle(def.toggle, def.dep));
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

  /**
   * @param {{label: string, hint?: string, get: () => boolean, set: (v: boolean) => void}} t
   * @param {(() => boolean)} [dep]
   */
  _buildToggle(t, dep) {
    const lab = document.createElement('label');
    lab.className = 'p-toggle';
    if (dep) {
      const apply = () => lab.classList.toggle('p-off', !dep());
      this._depRefresh.push(apply);
      apply();
    }
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
    span.textContent = 'Low Latency (desync)';
    const hint = document.createElement('span');
    hint.className = 'p-hint';
    hint.textContent = 'ON: more responsive pen · OFF if strokes flicker (Chrome)';
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

  /**
   * @param {(file: File) => Promise<void>|void} onFile
   * @returns {{wrap: HTMLDivElement, thumb: HTMLCanvasElement, name: HTMLDivElement, meta: HTMLDivElement, file: HTMLInputElement, mkBtn: (label: string, title: string, fn: () => void) => HTMLButtonElement}}
   */
  _buildBrushAssetRow(onFile) {
    const wrap = document.createElement('div');
    wrap.className = 'p-texture';

    const thumb = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
    thumb.className = 'p-tex-thumb';
    thumb.width = 96; thumb.height = 96;

    const info = document.createElement('div');
    info.className = 'p-tex-info';
    const name = document.createElement('div');
    name.className = 'p-tex-name';
    const meta = document.createElement('div');
    meta.className = 'p-tex-meta';

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      try {
        await onFile(f);
      } catch {
        alert('The image is invalid or unreadable.');
      }
    });

    const btns = document.createElement('div');
    btns.className = 'p-tex-btns';
    /** @param {string} label @param {string} title @param {EventListener} fn */
    const mkBtn = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'p-tex-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      btns.appendChild(b);
      return b;
    };

    info.append(name, meta, btns);
    wrap.append(thumb, info, file);
    return { wrap, thumb, name, meta, file, mkBtn };
  }

  // Riga texture: thumbnail + nome + import da file / grana di default /
  // rimozione. La texture vive su brush.texture (vedi texture.js).
  _buildTextureRow() {
    const { wrap, thumb, name, meta, file, mkBtn } = this._buildBrushAssetRow(async (f) => {
      this._setTexture(await textureFromFile(f));
    });

    mkBtn('Import…', 'Import an image as a texture', () => file.click());
    mkBtn('Paper Grain', 'Default procedural grain', () => this._setTexture(defaultGrainTexture()));
    const del = mkBtn('✕', 'Remove texture', () => {
      brush.texture = null;
      brush.textureOn = false;
      this.syncSliders();
      this._refreshDeps();
      this._settingChanged();
    });
    del.classList.add('danger');

    this._texRefresh = () => {
      const tex = brush.texture;
      const ctx = thumb.getContext('2d');
      ctx.clearRect(0, 0, thumb.width, thumb.height);
      if (tex) {
        // thumbnail dal livello mip più vicino alla taglia (niente ImageData
        // giganti per texture native grandi), a colori
        let level = 0;
        while (level + 1 < tex.rgbMips.length &&
          tex.mw[level] > thumb.width * 2 && tex.mh[level] > thumb.height * 2) level++;
        const lw = tex.mw[level], lh = tex.mh[level], rgb = tex.rgbMips[level];
        const tmp = document.createElement('canvas');
        tmp.width = lw; tmp.height = lh;
        const tctx = tmp.getContext('2d');
        const img = tctx.createImageData(lw, lh);
        const d = img.data;
        for (let i = 0, o = 0; i < lw * lh; i++, o += 4) {
          d[o] = rgb[i * 3];
          d[o + 1] = rgb[i * 3 + 1];
          d[o + 2] = rgb[i * 3 + 2];
          d[o + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0, thumb.width, thumb.height);
        name.textContent = tex.name;
        meta.textContent = `${tex.w}×${tex.h}`;
        del.disabled = false;
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, thumb.width, thumb.height);
        name.textContent = 'No texture';
        meta.textContent = 'import an image or use grain';
        del.disabled = true;
      }
    };
    this._texRefresh();

    return wrap;
  }

  // Riga shape: thumbnail + nome + import da file / rimozione. La shape vive
  // su brush.shape (vedi shape.js): l'immagine cotta in quadrato ≤1024
  // sostituisce il disco procedurale dello stamp (alpha riconosciuta, oppure
  // luminanza per le immagini opache — bianco = pieno).
  _buildShapeRow() {
    const { wrap, thumb, name, meta, file, mkBtn } = this._buildBrushAssetRow(async (f) => {
      brush.shape = await shapeFromFile(f);
      this.syncSliders();
      this._refreshDeps();
      this._settingChanged();
    });

    mkBtn('Import…', 'Import an image as the stamp shape', () => file.click());
    const del = mkBtn('✕', 'Remove shape (back to round)', () => {
      brush.shape = null;
      brush.shapeInvert = false;
      this.syncSliders();
      this._refreshDeps();
      this._settingChanged();
    });
    del.classList.add('danger');

    this._shapeRefresh = () => {
      const shape = brush.shape;
      const ctx = thumb.getContext('2d');
      ctx.clearRect(0, 0, thumb.width, thumb.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, thumb.width, thumb.height);
      if (shape) {
        // thumbnail dal livello mip più vicino alla taglia: alpha come
        // inchiostro scuro su bianco (la sorgente, non l'inversione)
        let level = 0;
        while (level + 1 < shape.mips.length &&
          shape.mw[level] > thumb.width * 2 && shape.mh[level] > thumb.height * 2) level++;
        const lw = shape.mw[level], lh = shape.mh[level], a = shape.mips[level];
        const tmp = document.createElement('canvas');
        tmp.width = lw; tmp.height = lh;
        const tctx = tmp.getContext('2d');
        const img = tctx.createImageData(lw, lh);
        const d = img.data;
        for (let i = 0, o = 0; i < lw * lh; i++, o += 4) {
          d[o] = 26; d[o + 1] = 26; d[o + 2] = 31;
          d[o + 3] = a[i];
        }
        tctx.putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0, thumb.width, thumb.height);
        name.textContent = shape.name;
        meta.textContent = `${shape.w}×${shape.h}`;
        del.disabled = false;
      } else {
        // il tondo procedurale di default
        ctx.fillStyle = '#1a1a1f';
        ctx.beginPath();
        ctx.arc(thumb.width / 2, thumb.height / 2, thumb.width * 0.38, 0, Math.PI * 2);
        ctx.fill();
        name.textContent = 'Round (default)';
        meta.textContent = 'import an image as a shape';
        del.disabled = true;
      }
    };
    this._shapeRefresh();

    return wrap;
  }

  /** @param {import('./texture.js').BrushTexture} tex */
  _setTexture(tex) {
    brush.texture = tex;
    brush.textureOn = true;
    this.syncSliders();
    this._refreshDeps();
    this._settingChanged();
  }

  /** @param {RowDef} def */
  _buildSlider(def) {
    return this._buildRangeRow(def, () => this._settingChanged(), {
      depRefresh: this._depRefresh,
      refreshOnSnapChange: false,
    });
  }

  /**
   * Riga slider condivisa da Brush Studio, Blur e Liquify.
   * @param {RowDef} def
   * @param {() => void} onChanged
   * @param {{depRefresh?: (() => void)[]|null, refreshOnSnapChange?: boolean}} [opts]
   */
  _buildRangeRow(def, onChanged, opts = {}) {
    const { depRefresh = null, refreshOnSnapChange = true } = opts;
    const control = createRangeRow({
      label: def.label,
      min: def.min,
      max: def.max,
      step: def.step,
      get: def.get,
      set: def.set,
      fmt: def.fmt,
      log: def.log,
      snap: def.snap,
      stepFn: def.stepFn,
      dep: def.dep,
      depRefresh,
      refreshOnSnapChange,
      onChanged,
      steppers: true,
      clampOnSet: true,
      formatFromInput: true,
      syncLogClamp: true,
    });
    def._input = control.input;
    def._refresh = control.refresh;
    return control.row;
  }

  _refreshDeps() { for (const f of this._depRefresh) f(); }

  // Ogni modifica a un setting: badge + preview (debounce a rAF nel preview)
  // + slider rapidi laterali (due scritture di stile, idempotente).
  _settingChanged() {
    this._updateBadge();
    this.preview.schedule();
    if (this._ssSync) for (const f of this._ssSync) f();
  }

  _updateBadge() {
    this.badge.textContent = `${brush.size} px · ${Math.round(brush.opacity * 100)}%`;
  }

  _resetBrush() {
    Object.assign(brush, BRUSH_DEFAULTS);
    this.syncSliders();
    this.syncBlurPopup();
    this._refreshDeps();
    this._settingChanged();
  }

  /** @param {boolean} [force] */
  toggleStudio(force) {
    const open = force !== undefined ? force : !this.studio.classList.contains('open');
    this.studio.classList.toggle('open', open);
    this.backdrop.hidden = !open;
    if (open) {
      this.presetsUI.open(false);
      this.toggleBlurPopup(false);
      this.toggleLiquifyPopup(false);
      this._updateBadge();
      this.preview.render();
    }
  }

  /** @param {RowDef[]} rows */
  _syncRangeRows(rows) {
    for (const def of rows) {
      if (!def._input) continue;
      def._input.value = String(def.log ? Math.log(clamp(def.get(), def.min, def.max)) : def.get());
      def._refresh();
    }
  }

  syncSliders() {
    this._syncRangeRows(ALL_ROWS);
    for (const f of this._toggleSync) f();
    if (this._texRefresh) this._texRefresh();
    if (this._shapeRefresh) this._shapeRefresh();
  }

  // ---- Blur tool popup ----

  _buildBlurPopup() {
    const panel = this.blurPopup;
    panel.textContent = '';

    const head = this._toolPopupHead('Blur', () => this.toggleBlurPopup(false));

    const body = document.createElement('div');
    body.className = 'blur-body';
    for (const row of BLUR_ROWS) {
      body.appendChild(this._buildRangeRow(row, () => this._blurSettingChanged()));
    }

    panel.append(head, body);
    this._bindToolPopupDismiss(panel, 'tool-blur',
      () => this.toggleBlurPopup(false), () => this._positionBlurPopup());
  }

  _blurSettingChanged() {
    this.syncBlurPopup();
    if (this._ssSync) for (const f of this._ssSync) f();
  }

  syncBlurPopup() {
    this._syncRangeRows(BLUR_ROWS);
  }

  /** @param {boolean} [force] */
  toggleBlurPopup(force) {
    const panel = this.blurPopup;
    const open = force !== undefined ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) {
      this.toggleStudio(false);
      this.toggleLiquifyPopup(false);
      this.presetsUI.open(false);
      this.syncBlurPopup();
      this._positionBlurPopup();
    }
  }

  // ---- Liquify tool popup ----

  _buildLiquifyPopup() {
    const panel = this.liquifyPopup;
    panel.textContent = '';

    const head = this._toolPopupHead('Liquify', () => this.toggleLiquifyPopup(false));

    const modes = document.createElement('div');
    modes.className = 'liquify-modes';
    this._liquifyModeBtns.length = 0;
    for (const [id, label] of LIQUIFY_MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.mode = id;
      b.addEventListener('click', () => {
        brush.liquifyMode = /** @type {any} */ (id);
        this._syncLiquifyModes();
        this._liquifySettingChanged();
      });
      this._liquifyModeBtns.push(b);
      modes.appendChild(b);
    }

    const body = document.createElement('div');
    body.className = 'blur-body';
    for (const row of LIQUIFY_ROWS) {
      body.appendChild(this._buildRangeRow(row, () => this._liquifySettingChanged()));
    }

    const actions = document.createElement('div');
    actions.className = 'liquify-actions';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      if (this.app.liquifyResetActive()) this._liquifySettingChanged();
    });
    actions.appendChild(reset);

    panel.append(head, modes, body, actions);
    this._syncLiquifyModes();
    this._bindToolPopupDismiss(panel, 'tool-liquify',
      () => this.toggleLiquifyPopup(false), () => this._positionLiquifyPopup());
  }

  _syncLiquifyModes() {
    for (const b of this._liquifyModeBtns) {
      const active = b.dataset.mode === brush.liquifyMode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
  }

  _liquifySettingChanged() {
    this.syncLiquifyPopup();
    if (this._ssSync) for (const f of this._ssSync) f();
  }

  syncLiquifyPopup() {
    this._syncLiquifyModes();
    this._syncRangeRows(LIQUIFY_ROWS);
  }

  /** @param {boolean} [force] */
  toggleLiquifyPopup(force) {
    const panel = this.liquifyPopup;
    const open = force !== undefined ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) {
      this.toggleStudio(false);
      this.toggleBlurPopup(false);
      this.presetsUI.open(false);
      this.syncLiquifyPopup();
      this._positionLiquifyPopup();
    }
  }

  _positionLiquifyPopup() {
    this._positionToolPopup(this.liquifyPopup, 'tool-liquify', 330, 310);
  }

  _positionBlurPopup() {
    this._positionToolPopup(this.blurPopup, 'tool-blur', 300, 190);
  }

  /** @param {string} title @param {() => void} closeFn */
  _toolPopupHead(title, closeFn) {
    const head = document.createElement('div');
    head.className = 'blur-head';
    const label = document.createElement('span');
    label.textContent = title;
    const close = document.createElement('button');
    close.className = 'tb-btn';
    close.type = 'button';
    close.title = 'Close';
    close.textContent = '✕';
    close.addEventListener('click', closeFn);
    head.append(label, close);
    return head;
  }

  /**
   * @param {HTMLElement} panel
   * @param {string} btnId
   * @param {() => void} closeFn
   * @param {() => void} positionFn
   */
  _bindToolPopupDismiss(panel, btnId, closeFn, positionFn) {
    document.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('open')) return;
      const t = /** @type {Node|null} */ (e.target);
      const btn = document.getElementById(btnId);
      if (t && (panel.contains(t) || btn.contains(t))) return;
      closeFn();
    });
    window.addEventListener('resize', () => {
      if (panel.classList.contains('open')) positionFn();
    });
  }

  /**
   * @param {HTMLElement} panel
   * @param {string} btnId
   * @param {number} fallbackW
   * @param {number} fallbackH
   */
  _positionToolPopup(panel, btnId, fallbackW, fallbackH) {
    const btn = document.getElementById(btnId);
    const r = btn.getBoundingClientRect();
    const w = panel.offsetWidth || fallbackW;
    const h = panel.offsetHeight || fallbackH;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right + 10;
    let top = r.top + r.height / 2 - h / 2;
    if (left + w > vw - 8) {
      left = r.left + r.width / 2 - w / 2;
      top = r.top - h - 10;
    }
    if (top < 8) top = r.bottom + 10;
    panel.style.left = Math.max(8, Math.min(left, vw - w - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
  }

  // ---- toolbar / scorciatoie ----

  _bindToolbar() {
    const app = this.app;
    /** @param {string} id @param {() => void} fn */
    const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
    for (const [id, tool] of SIMPLE_TOOL_BUTTONS) on(id, () => this.setTool(tool));
    // Pennello: singolo click seleziona e apre/chiude la libreria preset.
    on('tool-brush', () => {
      const wasOpen = this.presetsUI.isOpen;
      if (brush.tool !== 'brush') this.setTool('brush');
      this.presetsUI.open(!wasOpen);
    });
    on('tool-blur', () => {
      if (brush.tool === 'blur') this.toggleBlurPopup();
      else this.setTool('blur');
    });
    on('tool-liquify', () => {
      if (brush.tool === 'liquify') this.toggleLiquifyPopup();
      else this.setTool('liquify');
    });

    // opzioni del tool Selezione: lo slider ricampiona la selezione viva
    for (const [id, kind] of SELECT_KIND_BUTTONS) {
      on(id, () => {
        app.cancelLasso();
        app.selection.kind = /** @type {any} */ (kind);
        this.syncSelectOptions();
      });
    }
    for (const [id, op] of SELECT_OP_BUTTONS) {
      on(id, () => {
        app.selection.operation = /** @type {any} */ (op);
        this.syncSelectOptions();
      });
    }
    on('sel-finish', () => app.finishPolygonLasso());
    const tolRange = /** @type {HTMLInputElement} */ (document.getElementById('sel-tol'));
    const tolVal = document.getElementById('sel-tol-val');
    tolRange.value = String(app.selection.tolerance);
    tolVal.textContent = tolRange.value;
    tolRange.addEventListener('input', () => {
      app.selection.tolerance = Number(tolRange.value);
      tolVal.textContent = tolRange.value;
      app.reselectTolerance();
    });
    on('sel-clear', () => {
      app.cancelLasso();
      app.selection.clear();
    });
    // cestino: come Canc da tastiera (unico modo su touch, dove Canc non esiste)
    on('sel-delete', () => app.deleteSelected());

    const colorInput = /** @type {HTMLInputElement} */ (document.getElementById('color'));
    colorInput.addEventListener('input', () => {
      hexToRgb(colorInput.value, brush.color);
      this.preview.schedule();
    });
    colorInput.addEventListener('change', () => this._pushSwatch(colorInput.value));

    on('btn-undo', () => app.undo());
    on('btn-redo', () => app.redo());
    on('btn-clear', () => {
      if (confirm('Clear the entire drawing?')) app.clearAll();
    });
    on('btn-export', () => exportPng(app));
    on('btn-resetview', () => app.fitActiveBoard());
    on('btn-addboard', () => app.addBoard());
    on('btn-mockup', () => this.mockups.toggle());
    // specchio verticale: toggle del disegno riflesso (guida e asse li
    // gestisce l'App nel frame loop; il tratto già in corso non cambia)
    const mirrorBtn = document.getElementById('btn-mirror');
    mirrorBtn.addEventListener('click', () => {
      app.mirrorV = !app.mirrorV;
      mirrorBtn.classList.toggle('active', app.mirrorV);
      mirrorBtn.setAttribute('aria-pressed', String(app.mirrorV));
    });
    const patternBtn = document.getElementById('btn-pattern');
    const patternRepeatBtn = document.getElementById('btn-pattern-repeat');
    const syncPatternControls = () => {
      patternBtn.classList.toggle('active', app.patternMode);
      patternBtn.setAttribute('aria-pressed', String(app.patternMode));
      const repeatActive = app.patternMode && app.patternView === 'repeat';
      patternRepeatBtn.classList.toggle('active', repeatActive);
      patternRepeatBtn.setAttribute('aria-pressed', String(repeatActive));
    };
    patternBtn.addEventListener('click', () => {
      app.patternMode = !app.patternMode;
      syncPatternControls();
    });
    patternRepeatBtn.addEventListener('click', () => {
      if (!app.patternMode) {
        app.patternMode = true;
        app.patternView = 'repeat';
      } else {
        app.patternView = app.patternView === 'repeat' ? 'wrap' : 'repeat';
      }
      syncPatternControls();
    });
    syncPatternControls();
    this.zoomOutBtn.addEventListener('click', () => this._zoomBy(0.8));
    this.zoomInBtn.addEventListener('click', () => this._zoomBy(1.25));
    on('btn-text', () => this.textUI.placeAtView());
    on('btn-layers', () => this.layersUI.toggle());
    on('btn-panel', () => this.toggleStudio());
    this.syncSelectOptions();
  }

  /** @param {number} factor */
  _zoomBy(factor) {
    const cam = this.app.camera;
    cam.zoomAt(cam.ox + cam.w / 2, cam.oy + cam.h / 2, factor);
  }

  syncSelectOptions() {
    const sel = this.app.selection;
    const opts = document.getElementById('select-opts');
    opts.classList.toggle('is-color', sel.kind === 'color');
    for (const [id, kind] of SELECT_KIND_BUTTONS) {
      const b = document.getElementById(id);
      const active = sel.kind === kind;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
    for (const [id, op] of SELECT_OP_BUTTONS) {
      const b = document.getElementById(id);
      const active = sel.operation === op;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
    const finish = /** @type {HTMLButtonElement} */ (document.getElementById('sel-finish'));
    const polygon = sel.kind === 'polygon';
    finish.hidden = !polygon;
    finish.disabled = !(polygon && this.app.lassoSession && this.app.lassoSession.points.length >= 3);
  }

  /** @param {Tool} tool */
  setTool(tool) {
    const prev = brush.tool;
    brush.tool = tool;
    if (prev === 'move' && tool !== 'move' && this.app.transform.active) {
      this.app.transform.confirm();
    }
    if (prev === 'liquify' && tool !== 'liquify') {
      this.app._flushPendingStroke();
      this.app.liquifyClearBaseline();
    }
    // cambiare strumento congeda il ColorDrop: modalità spenta, pillola
    // e slider della soglia spariscono
    if (this.app.fillUI) this.app.fillUI.dismiss();
    if (tool !== 'select') this.app.cancelLasso();
    for (const [id, t] of TOOL_BUTTONS) {
      document.getElementById(id).classList.toggle('active', t === tool);
    }
    this.app.planesEl.classList.toggle('panning', tool === 'pan');
    this.app.planesEl.classList.toggle('moving', tool === 'move');
    document.getElementById('select-opts').hidden = tool !== 'select';
    if (tool === 'select') this.syncSelectOptions();
    if (tool !== 'brush') this.presetsUI.open(false);
    if (tool !== 'blur') this.toggleBlurPopup(false);
    if (tool !== 'liquify') this.toggleLiquifyPopup(false);
    if (tool === 'blur' || tool === 'liquify') this.toggleStudio(false);
    if (this._ssSync) for (const f of this._ssSync) f();
  }

  // Il pennello è cambiato da fuori (preset applicato): riallinea studio,
  // badge e anteprima.
  notifyBrushChanged() {
    this.syncSliders();
    this.syncBlurPopup();
    this.syncLiquifyPopup();
    this._refreshDeps();
    this._settingChanged();
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
      const k = e.key.toLowerCase();
      if (document.body.classList.contains('home-open')) return;
      if (k === 'delete' && app.transform.deletePins()) {
        e.preventDefault();
        return;
      }
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.target instanceof HTMLSelectElement) return;
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); app.undo(); }
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); app.redo(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); app.cancelLasso(); app.selection.clear(); }
      else if (k === 'b') {
        // come il bottone: gia' pennello -> apre la libreria
        if (brush.tool === 'brush') this.presetsUI.open(true);
        else this.setTool('brush');
      }
      else if (k === 'e') this.setTool('eraser');
      else if (k === 'r') this.setTool('blur');
      else if (k === 'q') this.setTool('liquify');
      else if (k === 'w') this.setTool('select');
      else if (k === 'v') this.setTool('move');
      else if (k === 'h') this.setTool('pan');
      else if (k === 'p') this.toggleStudio();
      else if (k === 't') this.textUI.placeAtView();
      else if (k === 'l') this.layersUI.toggle();
      else if (k === 'enter') {
        if (app.finishPolygonLasso()) { e.preventDefault(); }
        else if (app.transform.pending) { e.preventDefault(); app.transform.confirm(true); }
        else if (app.fx.pending) { e.preventDefault(); app.fx.confirm(); }
        else if (app.layerStyle.pending) { e.preventDefault(); app.layerStyle.confirm(); }
      }
      else if (k === 'escape') { app.cancelLasso(); app.selection.clear(); app.transform.cancel(); app.fx.escape(); app.layerStyle.escape(); if (app.fillUI) app.fillUI.dismiss(); this.toggleStudio(false); this.toggleBlurPopup(false); this.toggleLiquifyPopup(false); this.textUI.open(false); this.layersUI.open(false); this.presetsUI.open(false); this.mockups.open(false); }
      else if (k === 'delete' || k === 'backspace') {
        // Canc: prima le puntine della Marionetta (se il tab è attivo),
        // poi i pixel selezionati; preventDefault anche a vuoto
        // (Backspace altrimenti naviga indietro su alcuni browser)
        if (app.transform.deletePins()) e.preventDefault();
        else if (app.selection.active) { e.preventDefault(); app.deleteSelected(); }
      }
      else if (k === '0') app.fitActiveBoard();
      else if (k === '[') {
        if (brush.tool === 'blur') { brush.blurSize = stepSize(brush.blurSize, -1); this._blurSettingChanged(); }
        else if (brush.tool === 'liquify') { brush.liquifySize = stepSize(brush.liquifySize, -1); this._liquifySettingChanged(); }
        else { brush.size = stepSize(brush.size, -1); this.syncSliders(); this._settingChanged(); }
      }
      else if (k === ']') {
        if (brush.tool === 'blur') { brush.blurSize = stepSize(brush.blurSize, 1); this._blurSettingChanged(); }
        else if (brush.tool === 'liquify') { brush.liquifySize = stepSize(brush.liquifySize, 1); this._liquifySettingChanged(); }
        else { brush.size = stepSize(brush.size, 1); this.syncSliders(); this._settingChanged(); }
      }
      else if (k === '+' || k === '=') {
        app.camera.zoomAt(app.camera.ox + app.camera.w / 2, app.camera.oy + app.camera.h / 2, 1.25);
      }
      else if (k === '-') {
        app.camera.zoomAt(app.camera.ox + app.camera.w / 2, app.camera.oy + app.camera.h / 2, 0.8);
      }
    });
  }

  _bindImageImport() {
    const app = this.app;
    /** @param {DataTransfer|null} dt */
    const hasFiles = (dt) => !!dt && Array.from(dt.types || []).includes('Files');
    /** @param {FileList|File[]} files */
    const firstImage = (files) => {
      for (const f of Array.from(files)) {
        if (!f.type || f.type.startsWith('image/')) return f;
      }
      return null;
    };
    /** @param {DataTransferItemList|null} items */
    const firstImageItem = (items) => {
      if (!items) return null;
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue;
        if (item.type && !item.type.startsWith('image/')) continue;
        const f = item.getAsFile();
        if (f) return f;
      }
      return null;
    };

    app.planesEl.addEventListener('dragover', (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    app.planesEl.addEventListener('drop', (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const f = firstImage(e.dataTransfer.files);
      if (f) app.importImageLayer(f);
      else alert('Drop an image file.');
    });

    window.addEventListener('paste', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return;
      const f = e.clipboardData &&
        (firstImage(e.clipboardData.files) || firstImageItem(e.clipboardData.items));
      if (!f) return;
      e.preventDefault();
      app.importImageLayer(f);
    });
  }

  // Anello cursore: dimensione pennello in px schermo
  /** @param {import('./input.js').InputManager} input @param {import('./camera.js').Camera} camera */
  updateCursor(input, camera) {
    const el = this.cursorEl;
    const h = input.hover;
    // select usa il crosshair CSS: il cerchio-pennello non c'entra
    const show = h.visible && brush.tool !== 'pan' && brush.tool !== 'move' &&
      brush.tool !== 'select' && !input.gesture;
    el.style.display = show ? 'block' : 'none';
    if (!show) return;
    const d = Math.max(4, (brush.tool === 'blur' ? brush.blurSize : brush.tool === 'liquify' ? brush.liquifySize : brush.size) * camera.zoom);
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

// Export PNG del canvas ATTIVO, alla sua risoluzione esatta (es. 2048×2048):
// i suoi livelli visibili compositati in ordine su bianco — raster con la
// loro opacità, testo ridisegnato come vettore (bordo+ombra).
/** @param {import('./main.js').App} app */
export function exportPng(app) {
  track('png_export_attempt');
  const board = app.boards.active;
  const mgr = board.mgr;
  const x0 = board.x, y0 = board.y, w = board.w, h = board.h;

  let any = false;
  for (const layer of mgr.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.kind === 'raster') {
      for (const c of layer.store.map.values()) {
        if (c.touched) { any = true; break; }
      }
    } else {
      any = true;
    }
    if (any) break;
  }
  if (!any) {
    track('png_export_empty');
    alert('Nothing to export: the canvas is empty.');
    return;
  }

  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const tmp = document.createElement('canvas');
  tmp.width = CHUNK; tmp.height = CHUNK;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(CHUNK, CHUNK);

  // chunk del livello su target (alpha del target già impostata dal chiamante)
  /** @type {(target: CanvasRenderingContext2D, layer: import('./layers.js').Layer) => void} */
  const drawRaster = (target, layer) => {
    for (const c of layer.store.map.values()) {
      const s = c.data, d = img.data;
      let empty = true;
      // premultiplied -> straight (composizione via drawImage, non su bianco)
      for (let o = 0; o < s.length; o += 4) {
        const a = s[o + 3];
        if (a === 0) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0; continue; }
        empty = false;
        const inv = 255 / a;
        d[o] = Math.min(255, s[o] * inv);
        d[o + 1] = Math.min(255, s[o + 1] * inv);
        d[o + 2] = Math.min(255, s[o + 2] * inv);
        d[o + 3] = a;
      }
      if (empty) continue;
      tctx.putImageData(img, 0, 0);
      target.drawImage(tmp, c.cx * CHUNK - x0, c.cy * CHUNK - y0);
    }
  };

  // maschere di ritaglio: stesse regole dello schermo — semantica di GRUPPO
  // (base con source-over, figli con source-atop: l'alpha resta della base,
  // il colore dei figli la sostituisce — niente frange del colore della base)
  refreshClipBases(mgr.layers);
  /** @type {HTMLCanvasElement|null} */
  let clipTemp = null;
  const layers = mgr.layers;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.visible || layer.opacity <= 0) continue;
    // membro di un gruppo: lo disegna il pass della sua base (base nascosta
    // o a opacità 0 = gruppo invisibile)
    if (layer.kind === 'raster' && layer.clip && layer.clipBase) continue;
    if (layer.kind !== 'raster') {
      // stessa resa dell'SVG: bordo sotto il fill, ombra sulla sagoma
      drawTextDocument(ctx, layer.item, layer.style, x0, y0, layer.opacity);
      continue;
    }
    // base di un gruppo? figli = catena contigua di clippati sopra
    let gEnd = i + 1;
    while (gEnd < layers.length &&
      layers[gEnd].clip && layers[gEnd].clipBase === layer) gEnd++;
    if (gEnd > i + 1) {
      if (!clipTemp) {
        clipTemp = document.createElement('canvas');
        clipTemp.width = w; clipTemp.height = h;
      }
      const cctx = clipTemp.getContext('2d');
      cctx.globalCompositeOperation = 'source-over';
      cctx.globalAlpha = 1;
      cctx.clearRect(0, 0, w, h);
      cctx.globalAlpha = layer.opacity;
      drawRaster(cctx, layer);
      cctx.globalCompositeOperation = 'source-atop';
      for (let j = i + 1; j < gEnd; j++) {
        const child = layers[j];
        if (!child.visible || child.opacity <= 0) continue;
        cctx.globalAlpha = child.opacity;
        drawRaster(cctx, child);
      }
      cctx.globalCompositeOperation = 'source-over';
      cctx.globalAlpha = 1;
      ctx.globalAlpha = 1;
      // il metodo di fusione della base si applica al gruppo intero
      ctx.globalCompositeOperation = C2D_MODE[layer.mode || 'normal'] || 'source-over';
      ctx.drawImage(clipTemp, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      i = gEnd - 1;
      continue;
    }
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = C2D_MODE[layer.mode || 'normal'] || 'source-over';
    drawRaster(ctx, layer);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;

  cnv.toBlob((blob) => {
    if (!blob) {
      track('png_export_failed', { reason: 'blob_null' });
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${board.name.replace(/[\\/:*?"<>|]/g, '_')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    track('png_export_success', { width: w, height: h, bytes: blob.size });
  }, 'image/png');
}
