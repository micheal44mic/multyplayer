// Brush presets: recipe catalog on top of the existing brush engine.
// A preset is applied over the initial factory state; user color and tool stay.

import { brush } from './brush.js';
import { defaultGrainTexture } from './texture.js';

/** @typedef {import('./brush.js').Brush} Brush */

const FACTORY = (() => {
  const { color, tool, texture, stabilizationMode, stabilizationDebug, ...rest } = brush;
  return rest;
})();

/** @type {import('./texture.js').BrushTexture|null} */
let _grain = null;
const grain = () => _grain || (_grain = defaultGrainTexture());

/**
 * @typedef {Object} BrushPreset
 * @property {string} id
 * @property {string} categoryId
 * @property {string} name
 * @property {boolean} [premium]
 * @property {boolean} [grain]
 * @property {Partial<Brush>} brush
 */

/**
 * @typedef {Object} BrushCategory
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {BrushPreset[]} items
 */

const ICONS = {
  simple: '<svg viewBox="0 0 24 24"><path d="M4 15c4-6 12-6 16 0"/><path d="M5 18h14"/></svg>',
  sketch: '<svg viewBox="0 0 24 24"><path d="m5 19 10.5-10.5 3 3L8 22H5v-3z"/><path d="m13.5 6.5 2-2a2.1 2.1 0 0 1 3 3l-2 2"/></svg>',
  ink: '<svg viewBox="0 0 24 24"><path d="m12 2 4 8-4 12-4-12 4-8z"/><path d="M8 10h8"/><path d="M12 14v8"/></svg>',
  comic: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M11 4v16"/><path d="M15 15h2"/></svg>',
  airbrush: '<svg viewBox="0 0 24 24"><path d="M7 8h10"/><path d="M8 8c0 3-2 4-2 7"/><path d="M16 8c0 3 2 4 2 7"/><path d="M10 15h4"/><circle cx="5" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="12" cy="3.5" r="1"/></svg>',
  watercolorFlat: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M8.5 17.5c2 1.2 5 1.2 7 0"/></svg>',
  watercolorTexture: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><circle cx="10" cy="13" r="1"/><circle cx="14" cy="16" r="1"/><circle cx="13.5" cy="10.5" r="1"/></svg>',
  paint: '<svg viewBox="0 0 24 24"><path d="M6 20c4-1 8-1 12 0"/><path d="M8 16V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v11"/><path d="M8 8h8"/></svg>',
  dry: '<svg viewBox="0 0 24 24"><path d="m5 19 8-16 6 6-8 10H5z"/><path d="M9 15h5"/><path d="M11 11h6"/></svg>',
  fx: '<svg viewBox="0 0 24 24"><path d="M12 2 14.5 9 22 12l-7.5 3L12 22l-2.5-7L2 12l7.5-3L12 2z"/><path d="M19 3v4"/><path d="M21 5h-4"/></svg>',
};

const PREMIUM_INDEXES = new Set([2, 5, 8]);
const DEFAULT_PRESET_SMOOTHING = 0.15;

/** @param {number} n @param {number} min @param {number} max */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** @param {string} s */
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * @param {string} categoryId
 * @param {string[]} names
 * @param {(i: number) => Partial<Brush>} recipe
 * @param {Set<number>} grainIndexes
 * @returns {BrushPreset[]}
 */
function makePresets(categoryId, names, recipe, grainIndexes = new Set()) {
  return names.map((name, i) => ({
    id: `${categoryId}-${slug(name)}`,
    categoryId,
    name,
    premium: PREMIUM_INDEXES.has(i),
    grain: grainIndexes.has(i),
    brush: recipe(i),
  }));
}

/**
 * @param {keyof typeof ICONS} id
 * @param {string} label
 * @param {string[]} names
 * @param {(i: number) => Partial<Brush>} recipe
 * @param {Set<number>} [grainIndexes]
 * @returns {BrushCategory}
 */
function category(id, label, names, recipe, grainIndexes = new Set()) {
  return { id, label, icon: ICONS[id], items: makePresets(id, names, recipe, grainIndexes) };
}

const simpleNames = [
  'Dip Pen (Soft)', 'Dip Pen (Hard)', 'Dip Pen (Bleed)', 'Felt Tip Pen (Soft)', 'Felt Tip Pen (Hard)',
  'Pen (Fade)', 'Digital Pen', 'Round Brush', 'Clean Liner', 'Tiny Detail',
];
const sketchNames = [
  'Graphite HB', 'Graphite 2B', 'Graphite 6B', 'Blue Sketch', 'Red Layout',
  'Mechanical Pencil', 'Rough Pencil', 'Charcoal Pencil', 'Dusty Sketch', 'Soft Smudge Pencil',
];
const inkNames = [
  'India Ink', 'Nib Thin', 'Nib Bold', 'Calligraphy Flat', 'Calligraphy Tilt',
  'Ink Bleed', 'Dry Ink', 'Sumi Brush', 'Pocket Brush', 'Tapered Inker',
];
const comicNames = [
  'Comic Liner', 'Panel Border', 'Manga G Pen', 'Speed Line', 'Balloon Pen',
  'Halftone Dust', 'Black Fill Brush', 'Cross Hatch', 'Screentone Scratch', 'Action Swoosh',
];
const airbrushNames = [
  'Soft Air', 'Hard Air', 'Fine Mist', 'Wide Mist', 'Spray Can',
  'Nozzle Splatter', 'Glow Fog', 'Dust Cloud', 'Paint Speckle', 'Velvet Spray',
];
const watercolorFlatNames = [
  'Flat Wash', 'Round Wash', 'Wet Edge', 'Transparent Wash', 'Soft Bloom',
  'Loaded Brush', 'Light Glaze', 'Broad Mop', 'Tide Mark', 'Clean Water',
];
const watercolorTextureNames = [
  'Paper Grain Wash', 'Salt Bloom', 'Granular Blue', 'Dry Paper Drag', 'Pigment Pool',
  'Rough Wash', 'Stain Edge', 'Cloudy Wash', 'Cold Press', 'Backrun',
];
const paintNames = [
  'Acrylic Round', 'Acrylic Flat', 'Gouache Cream', 'Oil Round', 'Oil Bristle',
  'Impasto Flat', 'Palette Knife', 'Poster Paint', 'Wet Blend', 'Chunky Paint',
];
const dryNames = [
  'Charcoal Block', 'Willow Charcoal', 'Soft Pastel', 'Oil Pastel', 'Chalk Stick',
  'Conte Crayon', 'Dry Marker', 'Crayon Wax', 'Rough Chalk', 'Powder Pastel',
];
const fxNames = [
  'Glitter', 'Spark Dust', 'Neon Mist', 'Confetti', 'Star Trail',
  'Pixel Spray', 'Ash Particles', 'Rainbow Noise', 'Bokeh Dots', 'Magic Grain',
];

/** @type {BrushCategory[]} */
export const BRUSH_CATEGORIES = [
  category('simple', 'Simple', simpleNames, (i) => ({
      size: [3, 28, 10, 8, 8, 42, 8, 24, 5, 2][i],
      hardness: [0.72, 1, 0.62, 0.86, 1, 0.05, 0.92, 0.82, 1, 1][i],
      opacity: [1, 1, 0.82, 0.95, 1, 0.72, 1, 0.9, 1, 1][i],
      spacing: [0.018, 0.012, 0.035, 0.02, 0.018, 0.014, 0.018, 0.03, 0.014, 0.01][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      taperStart: [0, 0.1, 0.2, 0.55, 0.75, 0.15, 0.25, 0.8, 0, 0][i],
      taperEnd: [0, 0.1, 0.15, 0.55, 0.75, 0.15, 0.25, 0.8, 0, 0][i],
      jitterOpacity: i === 2 ? 0.16 : 0,
    })),
  category('sketch', 'Sketch', sketchNames, (i) => ({
      size: [5, 7, 12, 6, 6, 4, 9, 16, 22, 28][i],
      hardness: [0.72, 0.62, 0.48, 0.7, 0.7, 0.82, 0.58, 0.45, 0.35, 0.25][i],
      opacity: [0.72, 0.82, 0.92, 0.66, 0.66, 0.86, 0.78, 0.88, 0.42, 0.34][i],
      spacing: [0.045, 0.05, 0.055, 0.045, 0.045, 0.03, 0.06, 0.075, 0.08, 0.07][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      textureOn: true,
      textureDepth: [0.44, 0.55, 0.66, 0.4, 0.4, 0.34, 0.62, 0.82, 0.72, 0.6][i],
      textureScale: [0.42, 0.46, 0.5, 0.44, 0.44, 0.38, 0.48, 0.7, 0.82, 0.92][i],
      textureFloor: [0.28, 0.22, 0.16, 0.32, 0.32, 0.3, 0.18, 0.1, 0.14, 0.18][i],
      jitterPos: [0.01, 0.02, 0.04, 0.02, 0.02, 0, 0.06, 0.1, 0.12, 0.08][i],
      taperStart: [0.1, 0.12, 0.18, 0.16, 0.16, 0.08, 0.2, 0.35, 0.7, 0.8][i],
    }), new Set([0, 1, 2, 5, 6, 7, 8, 9])),
  category('ink', 'Ink', inkNames, (i) => ({
      size: [14, 4, 22, 30, 34, 18, 13, 46, 26, 9][i],
      hardness: [1, 1, 1, 0.96, 0.96, 0.72, 0.88, 0.62, 0.9, 1][i],
      opacity: [1, 1, 1, 1, 1, 0.9, 0.84, 0.92, 1, 1][i],
      spacing: [0.012, 0.01, 0.012, 0.018, 0.018, 0.03, 0.05, 0.035, 0.016, 0.012][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      roundness: [1, 1, 1, 0.24, 0.18, 0.9, 0.82, 0.72, 0.52, 1][i],
      angle: [0, 0, 0, 34, 52, 0, 0, 12, 28, 0][i],
      taperStart: [0.08, 0, 0.08, 0.55, 0.62, 0.2, 0.05, 0.3, 0.2, 0][i],
      taperEnd: [0.08, 0, 0.08, 0.55, 0.62, 0.16, 0.05, 0.25, 0.2, 0][i],
      jitterOpacity: i === 5 || i === 6 ? 0.12 : 0,
    }), new Set([5, 6])),
  category('comic', 'Comic', comicNames, (i) => ({
      size: [6, 18, 13, 5, 10, 34, 80, 8, 22, 42][i],
      hardness: [1, 1, 1, 1, 0.94, 0.72, 1, 0.9, 0.74, 0.96][i],
      opacity: [1, 1, 1, 0.95, 1, 0.42, 1, 0.86, 0.68, 1][i],
      spacing: [0.012, 0.012, 0.014, 0.025, 0.018, 0.08, 0.01, 0.09, 0.075, 0.012][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      scatter: [false, false, false, false, false, true, false, true, true, false][i],
      particleDensity: [100, 100, 100, 100, 100, 180, 100, 120, 165, 100][i],
      particleSize: [50, 50, 50, 50, 50, 28, 50, 42, 34, 50][i],
      jitterPos: [0, 0, 0, 0.02, 0, 0.42, 0, 0.18, 0.34, 0][i],
      taperStart: [0, 1, 0.08, 0, 0.4, 1, 1, 0.1, 0.2, 0.2][i],
      taperEnd: [0, 1, 0.08, 0, 0.4, 1, 1, 0.1, 0.2, 0.05][i],
    }), new Set([5, 7, 8])),
  category('airbrush', 'Airbrush', airbrushNames, (i) => ({
      size: [64, 42, 28, 120, 70, 76, 110, 150, 48, 88][i],
      hardness: [0.02, 0.42, 0.08, 0, 0.18, 0.28, 0, 0.03, 0.48, 0.08][i],
      opacity: [0.26, 0.38, 0.22, 0.18, 0.34, 0.48, 0.2, 0.14, 0.52, 0.3][i],
      buildup: true,
      spacing: [0.012, 0.018, 0.018, 0.014, 0.07, 0.08, 0.012, 0.025, 0.07, 0.015][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      scatter: [false, false, false, false, true, true, false, true, true, false][i],
      particleDensity: [100, 100, 100, 100, 220, 240, 100, 160, 180, 100][i],
      particleSize: [50, 50, 50, 50, 26, 34, 50, 44, 30, 50][i],
      jitterPos: [0, 0, 0.08, 0, 0.5, 0.62, 0, 0.46, 0.54, 0][i],
      taperStart: 1,
      taperEnd: 1,
    })),
  category('watercolorFlat', 'Watercolor (Flat)', watercolorFlatNames, (i) => ({
      size: [74, 52, 44, 92, 86, 42, 64, 120, 58, 34][i],
      hardness: [0.12, 0.18, 0.08, 0.06, 0.02, 0.22, 0.1, 0.04, 0.18, 0][i],
      opacity: [0.42, 0.5, 0.48, 0.32, 0.28, 0.64, 0.26, 0.38, 0.46, 0.18][i],
      spacing: [0.035, 0.034, 0.042, 0.035, 0.03, 0.025, 0.04, 0.038, 0.05, 0.03][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      textureOn: true,
      textureDepth: [0.24, 0.28, 0.34, 0.18, 0.22, 0.3, 0.2, 0.26, 0.38, 0.14][i],
      textureScale: [1.4, 1.3, 1.55, 1.7, 1.8, 1.1, 1.6, 1.35, 1.2, 2][i],
      textureFloor: [0.42, 0.38, 0.34, 0.48, 0.45, 0.36, 0.5, 0.4, 0.32, 0.56][i],
      aquaEnabled: true,
      aquaColorMix: [0.52, 0.62, 0.7, 0.48, 0.58, 0.44, 0.72, 0.66, 0.76, 0.82][i],
      aquaWetness: [0.42, 0.46, 0.54, 0.5, 0.62, 0.36, 0.56, 0.58, 0.48, 0.72][i],
      aquaLighten: [true, true, true, true, true, false, true, true, false, true][i],
      taperStart: [0.65, 0.58, 0.5, 0.74, 0.82, 0.42, 0.78, 0.7, 0.4, 0.88][i],
      taperEnd: [0.65, 0.58, 0.5, 0.74, 0.82, 0.42, 0.78, 0.7, 0.4, 0.88][i],
    }), new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])),
  category('watercolorTexture', 'Watercolor (Texture)', watercolorTextureNames, (i) => ({
      size: [70, 84, 56, 38, 66, 92, 44, 110, 78, 58][i],
      hardness: [0.1, 0.04, 0.16, 0.34, 0.08, 0.12, 0.22, 0.06, 0.14, 0.08][i],
      opacity: [0.42, 0.35, 0.58, 0.62, 0.44, 0.4, 0.52, 0.3, 0.48, 0.36][i],
      spacing: [0.044, 0.05, 0.046, 0.06, 0.04, 0.052, 0.038, 0.048, 0.044, 0.052][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      textureOn: true,
      textureDepth: [0.62, 0.82, 0.76, 0.72, 0.68, 0.78, 0.64, 0.58, 0.8, 0.86][i],
      textureScale: [1.1, 1.8, 0.85, 0.62, 1.35, 1.05, 0.92, 1.55, 1.2, 1.6][i],
      textureFloor: [0.22, 0.12, 0.18, 0.16, 0.2, 0.18, 0.24, 0.26, 0.12, 0.1][i],
      textureContrast: [1.35, 1.8, 1.55, 1.5, 1.45, 1.7, 1.4, 1.3, 1.75, 1.9][i],
      aquaEnabled: true,
      aquaColorMix: [0.64, 0.78, 0.56, 0.42, 0.68, 0.72, 0.5, 0.82, 0.62, 0.74][i],
      aquaWetness: [0.5, 0.72, 0.44, 0.32, 0.56, 0.66, 0.4, 0.7, 0.52, 0.76][i],
      aquaLighten: [true, true, false, false, true, true, false, true, true, true][i],
      jitterOpacity: [0.08, 0.18, 0.12, 0.16, 0.1, 0.18, 0.08, 0.12, 0.2, 0.22][i],
      taperStart: 0.55,
      taperEnd: 0.55,
    }), new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])),
  category('paint', 'Paint', paintNames, (i) => ({
      size: [34, 52, 42, 38, 28, 72, 58, 44, 64, 86][i],
      hardness: [0.72, 0.86, 0.52, 0.6, 0.74, 0.9, 0.96, 0.78, 0.42, 0.82][i],
      opacity: [0.92, 0.96, 0.82, 0.9, 0.88, 1, 0.94, 0.88, 0.7, 1][i],
      spacing: [0.026, 0.024, 0.03, 0.032, 0.052, 0.018, 0.02, 0.026, 0.022, 0.028][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      roundness: [1, 0.34, 0.9, 0.88, 0.62, 0.28, 0.2, 0.9, 0.72, 0.52][i],
      angle: [0, 12, 0, 0, 18, 8, 18, 0, 0, 26][i],
      textureOn: [false, false, true, true, true, true, true, false, true, true][i],
      textureDepth: [0.5, 0.5, 0.36, 0.42, 0.64, 0.52, 0.58, 0.5, 0.3, 0.62][i],
      textureScale: [1, 1, 0.92, 1.1, 0.62, 0.8, 0.7, 1, 1.2, 0.72][i],
      textureFloor: [0.25, 0.25, 0.34, 0.3, 0.16, 0.18, 0.14, 0.25, 0.36, 0.12][i],
      taperStart: [0.7, 0.92, 0.76, 0.7, 0.55, 1, 0.95, 0.74, 0.65, 0.88][i],
      taperEnd: [0.7, 0.92, 0.76, 0.7, 0.55, 1, 0.95, 0.74, 0.65, 0.88][i],
    }), new Set([2, 3, 4, 5, 6, 8, 9])),
  category('dry', 'Dry Media', dryNames, (i) => ({
      size: [26, 18, 34, 38, 30, 16, 22, 24, 42, 58][i],
      hardness: [0.42, 0.52, 0.34, 0.58, 0.46, 0.64, 0.7, 0.62, 0.38, 0.28][i],
      opacity: [0.86, 0.78, 0.72, 0.8, 0.82, 0.88, 0.78, 0.76, 0.74, 0.56][i],
      spacing: [0.09, 0.08, 0.075, 0.065, 0.078, 0.064, 0.055, 0.07, 0.085, 0.09][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      textureOn: true,
      textureDepth: [0.88, 0.72, 0.8, 0.58, 0.76, 0.66, 0.54, 0.7, 0.84, 0.9][i],
      textureScale: [0.78, 0.72, 1.15, 0.9, 1.05, 0.65, 0.55, 0.82, 1.25, 1.45][i],
      textureFloor: [0.08, 0.12, 0.14, 0.22, 0.12, 0.16, 0.24, 0.18, 0.1, 0.08][i],
      textureContrast: [1.6, 1.45, 1.55, 1.3, 1.5, 1.4, 1.25, 1.45, 1.65, 1.8][i],
      jitterPos: [0.12, 0.08, 0.16, 0.08, 0.12, 0.06, 0.04, 0.1, 0.16, 0.2][i],
      jitterSize: [0.1, 0.06, 0.12, 0.08, 0.1, 0.05, 0.04, 0.08, 0.12, 0.16][i],
      taperStart: [0.34, 0.22, 0.62, 0.76, 0.6, 0.28, 0.5, 0.55, 0.7, 0.8][i],
    }), new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])),
  category('fx', 'FX', fxNames, (i) => ({
      size: [38, 28, 86, 52, 32, 18, 42, 34, 74, 46][i],
      hardness: [0.88, 0.78, 0.02, 0.9, 0.76, 1, 0.54, 0.82, 0.08, 0.48][i],
      opacity: [0.9, 0.82, 0.34, 0.92, 0.86, 0.78, 0.56, 0.72, 0.28, 0.62][i],
      buildup: [false, false, true, false, false, false, true, false, true, true][i],
      spacing: [0.12, 0.1, 0.018, 0.14, 0.11, 0.08, 0.12, 0.08, 0.16, 0.08][i],
      smoothing: DEFAULT_PRESET_SMOOTHING,
      scatter: true,
      particleDensity: [160, 190, 100, 220, 145, 180, 130, 210, 95, 180][i],
      particleSize: [55, 42, 50, 38, 46, 34, 28, 44, 70, 36][i],
      particleDeviation: [30, 18, 0, -20, 42, -30, -15, 22, 50, 0][i],
      jitterPos: [0.4, 0.36, 0.08, 0.52, 0.34, 0.22, 0.46, 0.32, 0.5, 0.38][i],
      jitterSize: [0.5, 0.44, 0.08, 0.46, 0.36, 0.18, 0.52, 0.42, 0.58, 0.5][i],
      jitterOpacity: [0.3, 0.36, 0.12, 0.3, 0.26, 0.18, 0.44, 0.38, 0.46, 0.34][i],
      jitterBright: [0.28, 0.22, 0.15, 0.25, 0.35, 0.12, 0.2, 0.5, 0.2, 0.28][i],
      jitterSat: [0.2, 0.18, 0.12, 0.28, 0.32, 0.1, 0.16, 0.55, 0.16, 0.26][i],
      taperStart: 1,
      taperEnd: 1,
    }), new Set([9])),
];

/** @type {BrushPreset[]} */
export const BRUSH_PRESETS = BRUSH_CATEGORIES.flatMap((category) => category.items);

/** @param {string} id @returns {BrushPreset|undefined} */
export function findPreset(id) {
  return BRUSH_PRESETS.find((preset) => preset.id === id);
}

/** @param {BrushPreset} p @returns {Brush} */
export function presetConfig(p) {
  const cfg = /** @type {Brush} */ ({
    ...FACTORY,
    texture: p.grain ? grain() : null,
    color: { r: 18, g: 18, b: 22 },
    tool: 'brush',
    ...p.brush,
  });
  cfg.size = clamp(cfg.size, 1, 2000);
  cfg.opacity = clamp(cfg.opacity, 0.01, 1);
  return cfg;
}

/** @param {BrushPreset} p */
export function applyPreset(p) {
  Object.assign(brush, FACTORY, { texture: p.grain ? grain() : null }, p.brush);
  brush.size = clamp(brush.size, 1, 2000);
  brush.opacity = clamp(brush.opacity, 0.01, 1);
}
