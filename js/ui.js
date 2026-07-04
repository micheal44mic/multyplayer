// UI: Brush Studio (popup con preview live e tab per categoria), toolbar,
// swatch, scorciatoie, export PNG.

import { brush } from './brush.js';
import { hexToRgb, clamp } from './util.js';
import { ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { BrushPreview } from './brush_preview.js';
import { textureFromFile, defaultGrainTexture } from './texture.js';
import { shapeFromFile } from './shape.js';
import { TextUI } from './text_ui.js';
import { SvgUI } from './svg_ui.js';
import { LayersUI } from './layers_ui.js';
import { PresetsUI } from './presets_ui.js';
import { MockupUI } from './mockup_ui.js';
import { SpaceNodes } from './space_nodes.js';
import { drawLayerStack } from './layer_composite.js';
import { track } from './telemetry.js';
import { createRangeRow } from './panel_controls.js';
import { cssColorToHex } from './pen_tool.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./brush.js').Tool} Tool */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {'draw'|'spaces'} RailMode */

const TOOL_BUTTONS = /** @type {[string, Tool][]} */ ([
  ['tool-brush', 'brush'], ['tool-eraser', 'eraser'], ['tool-blur', 'blur'],
  ['tool-liquify', 'liquify'], ['tool-pen', 'pen'], ['tool-select', 'select'], ['tool-move', 'move'], ['tool-pan', 'pan'],
]);
const SIMPLE_TOOL_BUTTONS = TOOL_BUTTONS.filter(([, t]) => !['brush', 'blur', 'liquify', 'pen'].includes(t));
/** @typedef {'draw'|'add'|'remove'|'nodes'} PenSubTool */
const PEN_SUBTOOL_BUTTONS = /** @type {[string, PenSubTool][]} */ ([
  ['pen-tool-draw', 'draw'], ['pen-tool-add', 'add'],
  ['pen-tool-remove', 'remove'], ['pen-tool-nodes', 'nodes'],
]);
const PAINT_TOOLS = new Set(['brush', 'eraser', 'blur', 'liquify']);
const SELECT_KIND_BUTTONS = [['sel-kind-color', 'color'], ['sel-kind-lasso', 'lasso'], ['sel-kind-polygon', 'polygon']];
const SELECT_OP_BUTTONS = [['sel-op-replace', 'replace'], ['sel-op-add', 'add'], ['sel-op-subtract', 'subtract']];
const SPACES_BLOCKED_KEYS = new Set([
  'b', 'e', 'r', 'q', 'w', 'v', 'h', 'n', 'p', 't', 'l',
  'enter', 'escape', 'delete', 'backspace', '0', '[', ']', '+', '=', '-', ' ',
]);
const SPACES_ZOOM_MAX = 4.3;

/** @param {EventTarget|null} target */
function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== 'range';
}

// Valori di fabbrica del pennello (colore e tool esclusi): "Reimposta pennello".
const BRUSH_DEFAULTS = (() => {
  const {
    color, tool,
    blurSize, blurStrength, blurOpacity, blurSoftness, blurDrag,
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
 * @property {boolean} [pressureCurve] riga speciale: editor della curva pressione
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
  stylus: '<path d="m4 18.5 1.5-4.7L16.8 2.5a2.2 2.2 0 0 1 3.1 3.1L8.6 16.9 4 18.5z"/><path d="m14.8 4.5 3 3"/><path d="M3 21h18"/>',
  scatter: '<path d="M7 3.5a2.2 2.2 0 1 1-.01 0zM16.5 5.5a2.8 2.8 0 1 1-.01 0zM5.5 12.5a2.8 2.8 0 1 1-.01 0zM14 13a3.6 3.6 0 1 1-.01 0z"/>',
  jitter: '<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  color: '<path d="M12 2.5s6.5 7 6.5 11.4a6.5 6.5 0 1 1-13 0C5.5 9.5 12 2.5 12 2.5z"/>',
  aqua: '<path d="M12 2.5s6.5 7 6.5 11.4a6.5 6.5 0 1 1-13 0C5.5 9.5 12 2.5 12 2.5z"/><path d="M8 15c2.8 1.7 5.2 1.7 8 0"/><path d="M9 11c1.8 1 4.2 1 6 0"/>',
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
    { toggle: { label: 'Stabilization debug', hint: 'Shows raw pointer, stabilized point, and lag while drawing', get: () => brush.stabilizationDebug, set: v => brush.stabilizationDebug = v } },
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
  { id: 'stylus', label: 'Stylus', icon: ICONS.stylus, rows: [
    { pressureCurve: true },
    { id: 'pressureSize', label: 'Size Pressure', min: -100, max: 100, step: 1, get: () => brush.pressureSize * 100, set: v => brush.pressureSize = v / 100, fmt: v => v > 0 ? `+${v}%` : `${v}%` },
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
  { id: 'aqua', label: 'Aqua', icon: ICONS.aqua, rows: [
    { toggle: { label: 'Aqua sampling', get: () => brush.aquaEnabled, set: v => brush.aquaEnabled = v } },
    { id: 'aqmix', label: 'Color Mix', min: 0, max: 100, step: 1, dep: () => brush.aquaEnabled, get: () => (brush.aquaColorMix ?? 0) * 100, set: v => brush.aquaColorMix = v / 100, fmt: v => v + '%' },
    { id: 'aqwet', label: 'Water Glass', min: 0, max: 100, step: 1, dep: () => brush.aquaEnabled, get: () => (brush.aquaWetness ?? 0.5) * 100, set: v => brush.aquaWetness = v / 100, fmt: v => v + '%' },
    { toggle: { label: 'Lighter Watercolor', get: () => brush.aquaLighten, set: v => brush.aquaLighten = v }, dep: () => brush.aquaEnabled },
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
  { id: 'blurOpacity', label: 'Opacity', min: 0, max: 100, step: 1, get: () => (brush.blurOpacity ?? 1) * 100, set: v => brush.blurOpacity = v / 100, fmt: v => v + '%' },
  { id: 'blurSoftness', label: 'Softness', min: 0, max: 100, step: 1, get: () => brush.blurSoftness * 100, set: v => brush.blurSoftness = v / 100, fmt: v => v + '%' },
  { id: 'blurDrag', label: 'Drag', min: 0, max: 100, step: 1, get: () => (brush.blurDrag ?? 0) * 100, set: v => brush.blurDrag = v / 100, fmt: v => v + '%' },
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
    this.aiPanel = document.getElementById('aipanel');
    this.aiPrompt = /** @type {HTMLTextAreaElement} */ (document.getElementById('ai-prompt'));
    this.aiModel = /** @type {HTMLSelectElement} */ (document.getElementById('ai-model'));
    this.aiGenerateBtn = /** @type {HTMLButtonElement} */ (document.getElementById('ai-generate'));
    this.aiStatus = document.getElementById('ai-status');
    this.blurPopup = document.getElementById('blurpopup');
    this.liquifyPopup = document.getElementById('liquifypopup');
    this.penPopup = document.getElementById('penpopup');
    this.badge = document.getElementById('bs-badge');
    this.cursorEl = document.getElementById('cursor');
    this.zoomLabel = document.getElementById('zoom-label');
    this.zoomOutBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-zoom-out'));
    this.zoomInBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-zoom-in'));
    this._cursorKey = '';
    this._stabKey = '';
    this._zoomKey = '';
    /** @type {string[]} */
    this.recentColors = [];
    this.preview = new BrushPreview(/** @type {HTMLCanvasElement} */ (document.getElementById('bs-preview')));
    /** @type {(() => void)[]} */
    this._depRefresh = [];
    /** @type {(() => void)[]} */
    this._toggleSync = [];
    /** @type {(() => void)[]} */
    this._pressureCurveSync = [];
    /** @type {(() => void)|null} */
    this._texRefresh = null;
    /** @type {(() => void)|null} */
    this._shapeRefresh = null;
    /** @type {HTMLButtonElement[]} */
    this._liquifyModeBtns = [];
    /** @type {RailMode} */
    this.railMode = 'draw';
    /** @type {Tool} */
    this._toolBeforeSpaces = brush.tool;
    /** @type {HTMLElement|null} */
    this._railEl = null;
    /** @type {HTMLElement|null} */
    this._railModeToggle = null;
    /** @type {HTMLElement|null} */
    this._railDraw = null;
    /** @type {HTMLElement|null} */
    this._railSpaces = null;
    /** @type {HTMLElement|null} */
    this._railPen = null;
    /** @type {Tool} */
    this._toolBeforePen = 'brush';
    /** @type {PenSubTool} */
    this._penSubTool = 'draw';
    /** @type {{root: HTMLElement, sync: () => void}|null} */
    this._penControls = null;
    /** @type {HTMLElement|null} */
    this._spacesCreateMenu = null;
    /** @type {HTMLButtonElement|null} */
    this._spaceAddBtn = null;
    this.spaceNodes = new SpaceNodes(app);
    // _syncRailMode gira solo al primo toggle: senza questo il layer resta [hidden]
    // e i nodi (stress test, persistenza) sono invisibili finché non si entra in Spaces.
    this.spaceNodes.setVisible(true, false);
    this.layersUI = new LayersUI(app);
    this.textUI = new TextUI(app);
    this.svgUI = new SvgUI(app);
    this.presetsUI = new PresetsUI(this);
    this.mockups = new MockupUI(app, this);
    this._buildStudio();
    this._buildBlurPopup();
    this._buildLiquifyPopup();
    this._buildPenPopup();
    this._bindToolbar();
    this._bindAiPanel();
    this._buildSideSliders();
    this._bindKeys();
    this._bindImageImport();
    this.app.planesEl.classList.toggle('painting', PAINT_TOOLS.has(brush.tool));
    this._buildStabilizationDebug();
  }

  get spacesMode() {
    return this.railMode === 'spaces';
  }

  /** @param {RailMode} mode @param {{ force?: boolean }} [options] */
  setRailMode(mode, options = {}) {
    const force = !!options.force;
    if (!force && this.railMode === mode) return true;
    const enteringSpaces = mode === 'spaces' && this.railMode !== 'spaces';
    const leavingSpaces = mode === 'draw' && this.railMode === 'spaces';
    if (enteringSpaces && !this._confirmSpacesSwitch()) return false;
    if (enteringSpaces) {
      this._toolBeforeSpaces = brush.tool;
      this._cancelDrawingForSpaces();
    }
    this.railMode = mode;
    this._syncRailMode();
    if (mode === 'spaces') this._clearActiveToolUi();
    else if (leavingSpaces || force) this.setTool(this._toolBeforeSpaces);
    if (this.app._rafPending !== undefined) {
      this.app.boards.bump();
      this.app.planes.invalidate();
      this.app.requestFrame();
    }
    return true;
  }

  _confirmSpacesSwitch() {
    const msg = this._spacesSwitchWarning();
    return !msg || confirm(msg);
  }

  _spacesSwitchWarning() {
    const app = this.app;
    if (app.fx?.pending || app.layerStyle?.pending) {
      return 'Switch to Spaces?\n\nYour current effect preview will be discarded.';
    }
    if (app.fillUI?.pending) {
      return 'Switch to Spaces?\n\nYour current fill preview will be discarded.';
    }
    if (app.transform?.pending || app.transform?.dragging) {
      return 'Switch to Spaces?\n\nYour current transform will be canceled.';
    }
    if (app.lassoSession) {
      return 'Switch to Spaces?\n\nYour current selection in progress will be canceled.';
    }
    if (app.strokeLive || app.engine?.active || app.blurSession || app.liquifySession) {
      return 'Switch to Spaces?\n\nYour current in-progress stroke will be canceled.';
    }
    return '';
  }

  _cancelDrawingForSpaces() {
    const app = this.app;
    if ((app.pendingCommit || app.commitJob) && !(app.engine?.active || app.blurSession || app.liquifySession)) {
      app._flushPendingStroke();
    } else if (app.strokeLive || app.engine?.active || app.blurSession || app.liquifySession) {
      app.cancelStroke();
    }
    app.cancelLasso();
    app.selection.clear();
    app.transform?.cancel();
    if (app.fillUI) app.fillUI.dismiss();
    if (app.fxTools) for (const tool of app.fxTools) tool.openPanel(false);
    app.penTool?.finishPath();
    this.toggleStudio(false);
    this.toggleBlurPopup(false);
    this.toggleLiquifyPopup(false);
    this.togglePenPopup(false);
    this.textUI.open(false);
    this.svgUI.open(false);
    this.layersUI.open(false);
    app.stressTest?.open(false);
    this.presetsUI.open(false);
    this.mockups.open(false);
  }

  _syncRailMode() {
    const spaces = this.spacesMode;
    const rail = this._railEl;
    const toggle = this._railModeToggle;
    if (rail) rail.dataset.railMode = this.railMode;
    if (toggle) {
      toggle.dataset.railMode = this.railMode;
      toggle.setAttribute('aria-pressed', String(spaces));
      const label = spaces ? 'Torna a Disegno' : 'Passa a Spaces';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
    if (this._railSpaces) this._railSpaces.hidden = !spaces;
    this._syncPenRail();
    document.body.classList.toggle('spaces-mode', spaces);
    this.app.planesEl.classList.toggle('spaces-mode', spaces);
    this.app.camera.maxZoom = spaces ? SPACES_ZOOM_MAX : ZOOM_MAX;
    if (this.app.camera.zoom > this.app.camera.maxZoom) {
      const cam = this.app.camera;
      cam.zoomAt(cam.ox + cam.w / 2, cam.oy + cam.h / 2, this.app.camera.maxZoom / cam.zoom);
    }
    this.spaceNodes.setVisible(true, spaces);
    if (!spaces) this.toggleSpacesCreateMenu(false);
    if (spaces) this._hideBrushCursor();
  }

  _clearActiveToolUi() {
    for (const [id] of TOOL_BUTTONS) document.getElementById(id).classList.remove('active');
    this.app.planesEl.classList.remove('panning', 'moving', 'painting', 'fill-tap');
    document.getElementById('select-opts').hidden = true;
  }

  _syncPenRail() {
    const pen = !this.spacesMode && brush.tool === 'pen';
    if (this._railEl) this._railEl.classList.toggle('pen-rail', pen);
    if (this._railDraw) this._railDraw.hidden = this.spacesMode || pen;
    if (this._railPen) this._railPen.hidden = !pen;
    if (this._railModeToggle) this._railModeToggle.hidden = pen;
  }

  /** @param {PenSubTool} sub */
  _setPenSubTool(sub) {
    this._penSubTool = sub;
    const pen = this.app.penTool;
    if (pen) {
      pen.subTool = sub;
      if (sub !== 'draw') pen.finishPath();
    }
    for (const [id, s] of PEN_SUBTOOL_BUTTONS) {
      document.getElementById(id).classList.toggle('active', s === sub);
    }
  }

  _bindAiPanel() {
    const app = this.app;
    const close = document.getElementById('ai-close');
    const syncGenerate = () => {
      this.aiGenerateBtn.disabled = app.aiGenerating || !this.aiPrompt.value.trim();
    };
    close.addEventListener('click', () => this.openAiPanel(false));
    try {
      const saved = localStorage.getItem('fable-paint.ai-model');
      if (saved && [...this.aiModel.options].some((o) => o.value === saved)) this.aiModel.value = saved;
    } catch { /* storage unavailable */ }
    this.aiModel.addEventListener('change', () => {
      try { localStorage.setItem('fable-paint.ai-model', this.aiModel.value); } catch { /* storage unavailable */ }
    });
    this.aiPrompt.addEventListener('input', syncGenerate);
    this.aiPrompt.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.aiGenerateBtn.click();
      }
    });
    this.aiGenerateBtn.addEventListener('click', async () => {
      const prompt = this.aiPrompt.value.trim();
      if (!prompt) return;
      this.aiStatus.textContent = '';
      const ok = await app.generateAiFill(prompt, this.aiModel.value);
      if (ok) this.aiStatus.textContent = 'Fatto';
      syncGenerate();
    });
    syncGenerate();
  }

  /** @param {boolean} open */
  openAiPanel(open = true) {
    this.aiPanel.classList.toggle('open', open);
    if (open) {
      this.aiStatus.textContent = '';
      queueMicrotask(() => this.aiPrompt.focus());
    }
  }

  /** @param {boolean} busy */
  setAiBusy(busy) {
    this.aiGenerateBtn.disabled = busy || !this.aiPrompt.value.trim();
    this.aiStatus.textContent = busy ? 'Genero...' : '';
  }

  _buildStabilizationDebug() {
    const ns = 'http://www.w3.org/2000/svg';
    const wrap = document.createElement('div');
    wrap.id = 'stab-debug';
    wrap.hidden = true;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(ns, 'line');
    line.classList.add('sd-line');
    const raw = document.createElementNS(ns, 'circle');
    raw.classList.add('sd-raw');
    raw.setAttribute('r', '5');
    const filtered = document.createElementNS(ns, 'circle');
    filtered.classList.add('sd-filtered');
    filtered.setAttribute('r', '5');
    svg.append(line, raw, filtered);
    const panel = document.createElement('div');
    panel.className = 'sd-panel';
    wrap.append(svg, panel);
    document.body.appendChild(wrap);
    this._stabDebug = { wrap, line, raw, filtered, panel, a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
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
        else if (def.pressureCurve) pane.appendChild(this._buildPressureCurveRow());
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

  _buildPressureCurveRow() {
    const row = document.createElement('div');
    row.className = 'p-row p-curve';

    const head = document.createElement('div');
    head.className = 'p-row-head';
    const label = document.createElement('span');
    label.textContent = 'Pressure Curve';
    const val = document.createElement('span');
    val.className = 'p-val';
    head.append(label, val);

    const body = document.createElement('div');
    body.className = 'p-curve-body';
    const pad = document.createElement('div');
    pad.className = 'p-curve-pad';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    const grid = document.createElementNS(ns, 'path');
    grid.classList.add('pc-grid');
    grid.setAttribute('d', 'M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100');
    const diag = document.createElementNS(ns, 'path');
    diag.classList.add('pc-diag');
    diag.setAttribute('d', 'M0 100L100 0');
    const curve = document.createElementNS(ns, 'path');
    curve.classList.add('pc-curve');
    const dot = document.createElementNS(ns, 'circle');
    dot.classList.add('pc-dot');
    dot.setAttribute('r', '5');
    svg.append(grid, diag, curve, dot);
    pad.appendChild(svg);

    const side = document.createElement('div');
    side.className = 'p-curve-side';
    const linear = document.createElement('button');
    linear.type = 'button';
    linear.className = 'p-tex-btn';
    linear.textContent = 'Linear';
    linear.title = 'Reset pressure response';
    linear.addEventListener('click', () => {
      brush.pressureCurveX = 0.5;
      brush.pressureCurveY = 0.5;
      render();
      this._settingChanged();
    });
    side.appendChild(linear);
    body.append(pad, side);
    row.append(head, body);

    const render = () => {
      const x = clamp(brush.pressureCurveX ?? 0.36, 0.05, 0.95);
      const y = clamp(brush.pressureCurveY ?? 0.68, 0.05, 0.95);
      brush.pressureCurveX = x;
      brush.pressureCurveY = y;
      const sx = x * 100, sy = 100 - y * 100;
      curve.setAttribute('d', `M0 100 Q${sx} ${sy} 100 0`);
      dot.setAttribute('cx', String(sx));
      dot.setAttribute('cy', String(sy));
      const diff = y - x;
      val.textContent = Math.abs(diff) < 0.06 ? 'Linear' : diff > 0 ? 'Soft' : 'Firm';
    };

    /** @param {PointerEvent} e */
    const setFromPointer = (e) => {
      const r = pad.getBoundingClientRect();
      brush.pressureCurveX = clamp((e.clientX - r.left) / Math.max(1, r.width), 0.05, 0.95);
      brush.pressureCurveY = clamp(1 - (e.clientY - r.top) / Math.max(1, r.height), 0.05, 0.95);
      render();
      this._settingChanged();
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      setFromPointer(e);
      e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!pad.hasPointerCapture(e.pointerId)) return;
      setFromPointer(e);
      e.preventDefault();
    });
    this._pressureCurveSync.push(render);
    render();
    return row;
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
      this.layersUI.open(false);
      this.textUI.open(false);
      this.svgUI.open(false);
      this.toggleBlurPopup(false);
      this.toggleLiquifyPopup(false);
      this.togglePenPopup(false);
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
    for (const f of this._pressureCurveSync) f();
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
      this.togglePenPopup(false);
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
      this.togglePenPopup(false);
      this.presetsUI.open(false);
      this.syncLiquifyPopup();
      this._positionLiquifyPopup();
    }
  }

  _positionLiquifyPopup() {
    this._positionToolPopup(this.liquifyPopup, 'tool-liquify', 330, 310);
  }

  _positionBlurPopup() {
    this._positionToolPopup(this.blurPopup, 'tool-blur', 300, 245);
  }

  /**
   * @param {() => import('./layers.js').Layer|null} getLayer
   * @returns {{root: HTMLElement, sync: () => void}}
   */
  buildPenStyleControls(getLayer) {
    const pen = this.app.penTool;
    const root = document.createElement('div');
    root.className = 'pen-controls';
    /** @param {string} label */
    const row = (label) => {
      const r = document.createElement('div');
      r.className = 'pen-row';
      const s = document.createElement('span');
      s.textContent = label;
      r.appendChild(s);
      root.appendChild(r);
      return r;
    };
    const arm = () => pen.beginStyleEdit(getLayer());
    const done = () => pen.commitStyleEdit();
    /** @param {any} patch */
    const apply = (patch) => pen.applyStyle(patch, getLayer());

    const strokeIn = document.createElement('input');
    strokeIn.type = 'color';
    strokeIn.title = 'Stroke color';
    row('Stroke').appendChild(strokeIn);

    const widthIn = document.createElement('input');
    widthIn.type = 'range';
    widthIn.min = '1';
    widthIn.max = '64';
    widthIn.step = '1';
    widthIn.title = 'Stroke width';
    const widthVal = document.createElement('span');
    widthVal.className = 'pen-val';
    row('Width').append(widthIn, widthVal);

    const fillOn = document.createElement('input');
    fillOn.type = 'checkbox';
    fillOn.title = 'Fill on/off';
    const fillIn = document.createElement('input');
    fillIn.type = 'color';
    fillIn.title = 'Fill color';
    row('Fill').append(fillOn, fillIn);

    /** @param {string} label @param {[string, string][]} opts @param {(v: string) => any} patchOf */
    const seg = (label, opts, patchOf) => {
      /** @type {HTMLButtonElement[]} */
      const btns = [];
      const wrap = document.createElement('div');
      wrap.className = 'pen-align';
      for (const [v, text] of opts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pen-align-btn';
        b.textContent = text;
        b.dataset.v = v;
        b.addEventListener('click', () => {
          arm();
          apply(patchOf(v));
          done();
          sync();
        });
        btns.push(b);
        wrap.appendChild(b);
      }
      row(label).appendChild(wrap);
      return btns;
    };
    const alignBtns = seg('Align',
      [['center', 'Center'], ['inside', 'Inside'], ['outside', 'Outside']],
      (v) => ({ align: v }));
    const cornerBtns = seg('Corners',
      [['round', 'Rounded'], ['sharp', 'Sharp']],
      (v) => ({ corners: v }));
    const dashBtns = seg('Dash',
      [['solid', 'Solid'], ['dashed', 'Dashed']],
      (v) => {
        if (v === 'solid') return { dash: 0 };
        const st = pen.readActiveStyle(getLayer()) || pen.style;
        return {
          dash: st.dash > 0 ? st.dash : (pen.style.dash > 0 ? pen.style.dash : 12),
          gap: st.gap > 0 ? st.gap : (pen.style.gap > 0 ? pen.style.gap : 6),
        };
      });

    const dashIn = document.createElement('input');
    dashIn.type = 'range';
    dashIn.min = '1';
    dashIn.max = '64';
    dashIn.step = '1';
    dashIn.title = 'Dash length';
    const dashVal = document.createElement('span');
    dashVal.className = 'pen-val';
    const dashRow = row('Length');
    dashRow.append(dashIn, dashVal);

    const gapIn = document.createElement('input');
    gapIn.type = 'range';
    gapIn.min = '1';
    gapIn.max = '64';
    gapIn.step = '1';
    gapIn.title = 'Gap length';
    const gapVal = document.createElement('span');
    gapVal.className = 'pen-val';
    const gapRow = row('Gap');
    gapRow.append(gapIn, gapVal);

    for (const el of [strokeIn, widthIn, fillOn, fillIn, dashIn, gapIn]) {
      el.addEventListener('pointerdown', arm);
      el.addEventListener('focus', arm);
      el.addEventListener('change', done);
    }
    strokeIn.addEventListener('input', () => apply({ stroke: strokeIn.value }));
    widthIn.addEventListener('input', () => {
      widthVal.textContent = widthIn.value;
      apply({ width: Number(widthIn.value) });
    });
    const applyFill = () => apply({ fill: fillOn.checked ? fillIn.value : 'none' });
    fillOn.addEventListener('input', applyFill);
    fillIn.addEventListener('input', applyFill);
    dashIn.addEventListener('input', () => {
      dashVal.textContent = dashIn.value;
      apply({ dash: Number(dashIn.value) });
    });
    gapIn.addEventListener('input', () => {
      gapVal.textContent = gapIn.value;
      apply({ gap: Number(gapIn.value) });
    });

    const sync = () => {
      if (pen.styleEditing) return;
      const st = pen.readActiveStyle(getLayer()) || pen.style;
      strokeIn.value = cssColorToHex(st.stroke, '#1A1A1F');
      const w = Math.max(1, Math.round(st.width));
      widthIn.value = String(w);
      widthVal.textContent = String(w);
      const hasFill = !!st.fill && st.fill !== 'none';
      fillOn.checked = hasFill;
      if (hasFill) fillIn.value = cssColorToHex(st.fill, '#4D7CFE');
      for (const b of alignBtns) b.classList.toggle('active', b.dataset.v === (st.align || 'center'));
      for (const b of cornerBtns) b.classList.toggle('active', b.dataset.v === (st.corners || 'round'));
      const dashed = (st.dash || 0) > 0;
      for (const b of dashBtns) b.classList.toggle('active', b.dataset.v === (dashed ? 'dashed' : 'solid'));
      dashRow.hidden = !dashed;
      gapRow.hidden = !dashed;
      if (dashed) {
        const dv = Math.max(1, Math.round(st.dash));
        const gv = Math.max(1, Math.round(st.gap));
        dashIn.value = String(dv);
        dashVal.textContent = String(dv);
        gapIn.value = String(gv);
        gapVal.textContent = String(gv);
      }
    };
    return { root, sync };
  }

  _buildPenPopup() {
    const panel = this.penPopup;
    panel.textContent = '';
    const head = this._toolPopupHead('Pen', () => this.togglePenPopup(false));
    const body = document.createElement('div');
    body.className = 'blur-body';
    this._penControls = this.buildPenStyleControls(() => this.app.penTool.layer);
    body.appendChild(this._penControls.root);
    panel.append(head, body);
    this._bindToolPopupDismiss(panel, ['tool-pen', 'pen-tool-draw'],
      () => this.togglePenPopup(false), () => this._positionPenPopup());
  }

  syncPenPopup() {
    this._penControls?.sync();
  }

  /** @param {boolean} [force] */
  togglePenPopup(force) {
    const panel = this.penPopup;
    const open = force !== undefined ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) {
      this.toggleStudio(false);
      this.toggleBlurPopup(false);
      this.toggleLiquifyPopup(false);
      this.presetsUI.open(false);
      this.syncPenPopup();
      this._positionPenPopup();
    }
  }

  _positionPenPopup() {
    const anchor = this._railPen && !this._railPen.hidden ? 'pen-tool-draw' : 'tool-pen';
    this._positionToolPopup(this.penPopup, anchor, 250, 245);
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
   * @param {string|string[]} btnId
   * @param {() => void} closeFn
   * @param {() => void} positionFn
   */
  _bindToolPopupDismiss(panel, btnId, closeFn, positionFn) {
    document.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('open')) return;
      const t = /** @type {Node|null} */ (e.target);
      const btns = (Array.isArray(btnId) ? btnId : [btnId])
        .map(id => document.getElementById(id))
        .filter(Boolean);
      if (t && (panel.contains(t) || btns.some(btn => btn.contains(t)))) return;
      closeFn();
    });
    window.addEventListener('resize', () => {
      if (panel.classList.contains('open')) positionFn();
    });
  }

  /** @param {boolean} [force] */
  toggleSpacesCreateMenu(force) {
    const menu = this._spacesCreateMenu;
    if (!menu) return;
    const open = this.spacesMode && (force !== undefined ? force : menu.hidden);
    menu.hidden = !open;
    menu.classList.toggle('open', open);
    if (this._spaceAddBtn) this._spaceAddBtn.setAttribute('aria-expanded', String(open));
    if (open) this._positionSpacesCreateMenu();
  }

  _positionSpacesCreateMenu() {
    const menu = this._spacesCreateMenu;
    const btn = this._spaceAddBtn;
    if (!menu || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 292;
    const h = menu.offsetHeight || 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right + 10;
    let top = r.top + r.height / 2 - h / 2;
    if (left + w > vw - 8) {
      left = r.left + r.width / 2 - w / 2;
      top = r.top - h - 10;
    }
    if (top < 8) top = r.bottom + 10;
    menu.style.left = Math.max(8, Math.min(left, vw - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
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
    const rail = document.getElementById('toolrail');
    const railModeToggle = document.getElementById('toolspace-toggle');
    const railDraw = /** @type {HTMLElement} */ (document.querySelector('.rail-panel-draw'));
    const railSpaces = /** @type {HTMLElement} */ (document.querySelector('.rail-panel-spaces'));
    const railPen = /** @type {HTMLElement} */ (document.querySelector('.rail-panel-pen'));
    const spaceAddBtn = /** @type {HTMLButtonElement} */ (document.querySelector('.space-add'));
    const spacesCreateMenu = document.getElementById('spaces-create-menu');
    this._railEl = rail;
    this._railModeToggle = railModeToggle;
    this._railDraw = railDraw;
    this._railSpaces = railSpaces;
    this._railPen = railPen;
    this._spaceAddBtn = spaceAddBtn;
    this._spacesCreateMenu = spacesCreateMenu;
    railModeToggle.addEventListener('click', () => {
      this.setRailMode(this.spacesMode ? 'draw' : 'spaces');
    });
    spaceAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSpacesCreateMenu();
    });
    spacesCreateMenu.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement|null} */ (e.target instanceof HTMLElement ? e.target : null);
      const item = target?.closest('[data-space-create]');
      if (!(item instanceof HTMLElement)) return;
      e.preventDefault();
      const kind = item.dataset.spaceCreate;
      if (kind === 'text' || kind === 'image') {
        this.spaceNodes.createNodeAtView(kind);
        this.toggleSpacesCreateMenu(false);
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!spacesCreateMenu || spacesCreateMenu.hidden) return;
      const t = /** @type {Node|null} */ (e.target);
      if (t && (spacesCreateMenu.contains(t) || spaceAddBtn.contains(t))) return;
      this.toggleSpacesCreateMenu(false);
    });
    window.addEventListener('resize', () => {
      if (spacesCreateMenu && !spacesCreateMenu.hidden) this._positionSpacesCreateMenu();
    });
    this.setRailMode('draw', { force: true });
    for (const [id, tool] of SIMPLE_TOOL_BUTTONS) on(id, () => this.setTool(tool));
    // Pennello: singolo click seleziona e apre/chiude la libreria preset.
    on('tool-brush', () => {
      if (this.spacesMode) return;
      const wasOpen = this.presetsUI.isOpen;
      if (brush.tool !== 'brush') this.setTool('brush');
      this.presetsUI.open(!wasOpen);
    });
    on('tool-blur', () => {
      if (this.spacesMode) return;
      if (brush.tool === 'blur') this.toggleBlurPopup();
      else this.setTool('blur');
    });
    on('tool-liquify', () => {
      if (this.spacesMode) return;
      if (brush.tool === 'liquify') this.toggleLiquifyPopup();
      else this.setTool('liquify');
    });
    on('tool-pen', () => {
      if (this.spacesMode) return;
      if (brush.tool === 'pen') this.togglePenPopup();
      else this.setTool('pen');
    });
    on('pen-back', () => this.setTool(this._toolBeforePen));
    on('pen-tool-draw', () => {
      if (this._penSubTool !== 'draw') this._setPenSubTool('draw');
      else this.togglePenPopup();
    });
    on('pen-tool-add', () => this._setPenSubTool('add'));
    on('pen-tool-remove', () => this._setPenSubTool('remove'));
    on('pen-tool-nodes', () => this._setPenSubTool('nodes'));

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
    on('sel-ai', () => {
      if (!app.selection.active) {
        alert('Seleziona prima un area.');
        return;
      }
      this.openAiPanel(true);
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
    on('btn-text', () => { app.stressTest?.open(false); this.textUI.placeAtView(); });
    on('btn-layers', () => { app.stressTest?.open(false); this.layersUI.toggle(); });
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
    if (this.spacesMode) return;
    const prev = brush.tool;
    brush.tool = tool;
    if (prev === 'move' && tool !== 'move' && this.app.transform?.active) {
      this.app.transform.confirm();
    }
    if (prev === 'liquify' && tool !== 'liquify') {
      this.app._flushPendingStroke();
      this.app.liquifyClearBaseline();
    }
    if (prev === 'pen' && tool !== 'pen') this.app.penTool.finishPath();
    if (tool === 'pen' && prev !== 'pen') {
      this._toolBeforePen = prev;
      this._setPenSubTool('draw');
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
    this.app.planesEl.classList.toggle('painting', PAINT_TOOLS.has(tool));
    document.getElementById('select-opts').hidden = tool !== 'select';
    if (tool === 'select') this.syncSelectOptions();
    if (tool !== 'brush') this.presetsUI.open(false);
    if (tool !== 'blur') this.toggleBlurPopup(false);
    if (tool !== 'liquify') this.toggleLiquifyPopup(false);
    if (tool !== 'pen') this.togglePenPopup(false);
    if (tool === 'blur' || tool === 'liquify') this.toggleStudio(false);
    this._syncPenRail();
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
      if (isTextEntryTarget(e.target)) return;
      if (this.spacesMode) {
        if (k === ' ') app.input.spaceHeld = false;
        if (k === 't' || k === 'i') {
          e.preventDefault();
          this.spaceNodes.createNodeAtView(k === 'i' ? 'image' : 'text');
          this.toggleSpacesCreateMenu(false);
          return;
        }
        if (k === 'escape') {
          e.preventDefault();
          if (this.spaceNodes.cancelLink()) return;
          if (this._spacesCreateMenu && !this._spacesCreateMenu.hidden) this.toggleSpacesCreateMenu(false);
          else this.spaceNodes.select(0);
          return;
        }
        if ((k === 'delete' || k === 'backspace') && this.spaceNodes.deleteSelected()) {
          e.preventDefault();
          return;
        }
        if (SPACES_BLOCKED_KEYS.has(k) ||
          ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y' || k === 'd'))) {
          e.preventDefault();
        }
        return;
      }
      if (k === 'delete' && app.transform.deletePins()) {
        e.preventDefault();
        return;
      }
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
      else if (k === 'n') this.setTool('pen');
      else if (k === 'p') this.toggleStudio();
      else if (k === 't') { app.stressTest?.open(false); this.textUI.placeAtView(); }
      else if (k === 'l') { app.stressTest?.open(false); this.layersUI.toggle(); }
      else if (k === 'enter') {
        if (app.finishPolygonLasso()) { e.preventDefault(); }
        else if (app.penTool.creating) { e.preventDefault(); app.penTool.finishPath(); }
        else if (app.transform.pending) { e.preventDefault(); app.transform.confirm(true); }
        else if (app.fx.pending) { e.preventDefault(); app.fx.confirm(); }
        else if (app.layerStyle.pending) { e.preventDefault(); app.layerStyle.confirm(); }
      }
      else if (k === 'escape') { app.penTool.finishPath(); app.cancelLasso(); app.selection.clear(); app.transform.cancel(); app.fx.escape(); app.layerStyle.escape(); if (app.fillUI) app.fillUI.dismiss(); this.toggleStudio(false); this.toggleBlurPopup(false); this.toggleLiquifyPopup(false); this.togglePenPopup(false); this.textUI.open(false); this.svgUI.open(false); this.layersUI.open(false); app.stressTest?.open(false); this.presetsUI.open(false); this.mockups.open(false); }
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
    // select e pen usano il crosshair CSS: il cerchio-pennello non c'entra
    const show = !this.spacesMode && h.visible && brush.tool !== 'pan' && brush.tool !== 'move' &&
      brush.tool !== 'select' && brush.tool !== 'pen' && !input.gesture;
    if (!show) {
      this._hideBrushCursor();
      return;
    }
    const d = Math.max(4, (brush.tool === 'blur' ? brush.blurSize : brush.tool === 'liquify' ? brush.liquifySize : brush.size) * camera.zoom);
    const dia = Math.round(d * 10) / 10;
    const x = Math.round(h.x * 10) / 10;
    const y = Math.round(h.y * 10) / 10;
    const key = `1|${brush.tool}|${dia}|${x}|${y}`;
    if (this._cursorKey === key) return;
    this._cursorKey = key;
    el.style.display = 'block';
    el.style.width = dia + 'px';
    el.style.height = dia + 'px';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  _hideBrushCursor() {
    if (this._cursorKey === '0') return;
    this._cursorKey = '0';
    this.cursorEl.style.display = 'none';
  }

  /** @param {import('./input.js').InputManager} input @param {import('./camera.js').Camera} camera @param {import('./stroke.js').StrokeEngine} engine */
  updateStabilizationDebug(input, camera, engine) {
    const dbg = this._stabDebug;
    if (!dbg) return;
    const d = engine.debug;
    const show = brush.stabilizationDebug && d && d.active &&
      Number.isFinite(d.rawX) && Number.isFinite(d.rawY) &&
      Number.isFinite(d.outX) && Number.isFinite(d.outY);
    if (!show) {
      if (this._stabKey !== '0') {
        this._stabKey = '0';
        dbg.wrap.hidden = true;
      }
      return;
    }

    camera.worldToScreen(d.rawX, d.rawY, dbg.a);
    camera.worldToScreen(d.outX, d.outY, dbg.b);
    const ax = Math.round(dbg.a.x * 10) / 10;
    const ay = Math.round(dbg.a.y * 10) / 10;
    const bx = Math.round(dbg.b.x * 10) / 10;
    const by = Math.round(dbg.b.y * 10) / 10;

    const flags = [];
    if (d.gated) flags.push('gate');
    if (d.clamped) flags.push('clamp');
    const lag = d.lagCss.toFixed(2);
    const max = d.maxLagCss > 0 ? d.maxLagCss.toFixed(2) : '0.00';
    const speed = Math.round(d.speedCssS);
    const text = `${d.mode} ${Math.round(d.strength * 100)}% | lag ${lag}/${max}px | ${speed}px/s${flags.length ? ' | ' + flags.join('+') : ''}`;
    const left = Math.max(8, Math.min(window.innerWidth - 260, ax + 14));
    const top = Math.max(8, Math.min(window.innerHeight - 44, ay + 14));
    const key = `1|${ax}|${ay}|${bx}|${by}|${left}|${top}|${text}`;
    if (this._stabKey === key) return;
    this._stabKey = key;
    dbg.wrap.hidden = false;
    dbg.line.setAttribute('x1', String(ax));
    dbg.line.setAttribute('y1', String(ay));
    dbg.line.setAttribute('x2', String(bx));
    dbg.line.setAttribute('y2', String(by));
    dbg.raw.setAttribute('cx', String(ax));
    dbg.raw.setAttribute('cy', String(ay));
    dbg.filtered.setAttribute('cx', String(bx));
    dbg.filtered.setAttribute('cy', String(by));
    dbg.panel.textContent = text;
    dbg.panel.style.left = left + 'px';
    dbg.panel.style.top = top + 'px';
  }

  /** @param {number} zoom @param {number} [maxZoom] */
  updateZoomLabel(zoom, maxZoom = ZOOM_MAX) {
    const text = (zoom * 100).toFixed(zoom < 0.1 ? 1 : 0) + '%';
    const outDisabled = zoom <= ZOOM_MIN;
    const inDisabled = zoom >= maxZoom;
    const key = `${text}|${outDisabled ? 1 : 0}|${inDisabled ? 1 : 0}`;
    if (this._zoomKey === key) return;
    this._zoomKey = key;
    this.zoomLabel.textContent = text;
    this.zoomOutBtn.disabled = outDisabled;
    this.zoomInBtn.disabled = inDisabled;
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
export async function exportPng(app) {
  track('png_export_attempt');
  const board = app.boards.active;
  const mgr = board.mgr;
  const w = board.w, h = board.h;

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
  await drawLayerStack(ctx, board, mgr.layers, {
    onSvgError: (err, layer) => {
      console.error(err);
      track('png_export_svg_failed', { layerId: layer.id });
    },
  });

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
