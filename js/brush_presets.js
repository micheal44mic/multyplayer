// PRESET PENNELLI — ricette pronte sopra il motore esistente: ogni preset è
// un parziale di Brush applicato SOPRA i valori di fabbrica (ciò che non
// dichiara torna al default: passare da Spray a Penna spegne lo scatter).
// Colore e strumento non vengono mai toccati. I preset con grana usano la
// texture procedurale di default (creata pigramente, una sola volta).

import { brush } from './brush.js';
import { defaultGrainTexture } from './texture.js';

/** @typedef {import('./brush.js').Brush} Brush */

// Fotografia di fabbrica al load del modulo, PRIMA di qualunque modifica
// utente (gli import girano tutti prima dell'interazione).
const FACTORY = (() => {
  const { color, tool, texture, ...rest } = brush;
  return rest;
})();

/** @type {import('./texture.js').BrushTexture|null} */
let _grain = null;
const grain = () => _grain || (_grain = defaultGrainTexture());

/**
 * @typedef {Object} BrushPreset
 * @property {string} name
 * @property {boolean} [grain] usa la grana procedurale (texture ancorata)
 * @property {Partial<Brush>} brush parziale applicato sopra i default
 */

/** @type {BrushPreset[]} */
export const BRUSH_PRESETS = [
  { name: 'Penna', brush: {
    size: 18, hardness: 0.9, spacing: 0.03, smoothing: 0.45,
  } },
  { name: 'Matita', grain: true, brush: {
    size: 7, opacity: 0.85, hardness: 0.75, spacing: 0.05, smoothing: 0.25,
    textureOn: true, textureDepth: 0.65, textureScale: 0.45, textureFloor: 0.2,
    taperStart: 0.15,
  } },
  { name: 'China', brush: {
    size: 12, hardness: 1, spacing: 0.015, smoothing: 0.6,
  } },
  { name: 'Calligrafia', brush: {
    size: 28, hardness: 0.95, roundness: 0.22, angle: 38, spacing: 0.02,
    smoothing: 0.55, taperStart: 0.6, taperEnd: 0.6,
  } },
  { name: 'Pennarello', brush: {
    size: 34, hardness: 0.72, opacity: 0.9, spacing: 0.025, smoothing: 0.3,
    taperStart: 0.9, taperEnd: 0.9,
  } },
  { name: 'Evidenziatore', brush: {
    size: 90, hardness: 0.92, opacity: 0.32, roundness: 0.32, smoothing: 0.4,
    taperStart: 1, taperEnd: 1,
  } },
  { name: 'Airbrush', brush: {
    size: 100, hardness: 0, opacity: 0.3, buildup: true, spacing: 0.012,
    smoothing: 0.3, taperStart: 1, taperEnd: 1,
  } },
  { name: 'Acquerello', grain: true, brush: {
    size: 56, hardness: 0.18, opacity: 0.5, spacing: 0.03, smoothing: 0.4,
    textureOn: true, textureDepth: 0.4, textureScale: 1.5, textureFloor: 0.35,
    taperStart: 0.5, taperEnd: 0.5,
  } },
  { name: 'Carboncino', grain: true, brush: {
    size: 20, hardness: 0.55, opacity: 0.95, spacing: 0.045,
    textureOn: true, textureDepth: 0.85, textureScale: 0.7, textureFloor: 0.06,
    textureContrast: 1.5, jitterPos: 0.04, taperStart: 0.2,
  } },
  { name: 'Gessetto', grain: true, brush: {
    size: 30, hardness: 0.45, opacity: 0.85,
    textureOn: true, textureDepth: 0.75, textureScale: 1.1, textureFloor: 0.12,
    textureInvert: true, taperStart: 0.85, taperEnd: 0.85,
  } },
  { name: 'Spray', brush: {
    size: 60, hardness: 0.4, opacity: 0.45, buildup: true, spacing: 0.07,
    scatter: true, particleDensity: 220, particleSize: 30, particleDeviation: -40,
    jitterPos: 0.55, jitterOpacity: 0.5, jitterSize: 0.4,
    taperStart: 1, taperEnd: 1,
  } },
  { name: 'Glitter', brush: {
    size: 44, hardness: 0.85, spacing: 0.12,
    scatter: true, particleDensity: 160, particleSize: 55, particleDeviation: 30,
    jitterPos: 0.4, jitterSize: 0.5, jitterOpacity: 0.3, jitterAngle: 0.5,
    jitterBright: 0.35, jitterSat: 0.25,
    taperStart: 1, taperEnd: 1,
  } },
];

// Configurazione completa del preset (per le anteprime): fabbrica + preset,
// con colore fisso scuro e tool brush — NON tocca il pennello vero.
/** @param {BrushPreset} p @returns {Brush} */
export function presetConfig(p) {
  return /** @type {Brush} */ ({
    ...FACTORY,
    texture: p.grain ? grain() : null,
    color: { r: 36, g: 39, b: 51 },
    tool: 'brush',
    ...p.brush,
  });
}

// Applica il preset al pennello vero: tutto torna di fabbrica tranne ciò che
// il preset dichiara; colore e strumento dell'utente restano com'erano.
/** @param {BrushPreset} p */
export function applyPreset(p) {
  Object.assign(brush, FACTORY, { texture: p.grain ? grain() : null }, p.brush);
}
