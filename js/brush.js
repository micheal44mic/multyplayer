// Pennello: stato delle impostazioni + StampCache.
// Le maschere sono alpha 0..255 antialiasate, generate per bucket di
// (raggio, durezza, roundness, angolo) e riusate: generare è O(size²), riusare è un blit.

import { clamp } from './util.js';

/** @typedef {'brush'|'eraser'|'pan'} Tool */

/**
 * @typedef {Object} Brush
 * @property {number} size
 * @property {number} opacity
 * @property {number} hardness
 * @property {number} smoothing
 * @property {number} spacing
 * @property {number} roundness
 * @property {number} angle
 * @property {number} scatter
 * @property {number} jitterPos
 * @property {number} jitterSize
 * @property {number} jitterOpacity
 * @property {number} jitterSpacing
 * @property {number} jitterAngle
 * @property {number} jitterBright
 * @property {number} jitterSat
 * @property {boolean} buildup
 * @property {boolean} pressureSize
 * @property {boolean} pressureOpacity
 * @property {import('./util.js').Rgb} color
 * @property {Tool} tool
 */

/** @type {Brush} */
export const brush = {
  size: 24,            // diametro in px documento
  opacity: 1.0,        // wash: opacità del tratto; buildup: opacità di ogni stamp
  hardness: 0.85,      // 1 = bordo duro, 0 = airbrush (morbidezza = 1 - hardness)
  smoothing: 0.35,     // forza dello stabilizzatore
  spacing: 0.04,       // frazione del diametro (0.001 .. 3.0)
  roundness: 1.0,      // 1 = tondo, <1 = ellisse
  angle: 0,            // gradi
  scatter: 0,          // 0..1, offset perpendicolare in unità di diametro
  jitterPos: 0,        // 0..1, offset casuale radiale in unità di diametro
  jitterSize: 0,       // 0..1
  jitterOpacity: 0,    // 0..1
  jitterSpacing: 0,    // 0..1
  jitterAngle: 0,      // 0..1 (1 = ±180°)
  jitterBright: 0,     // 0..1 (luminosità HSV)
  jitterSat: 0,        // 0..1 (saturazione HSV)
  buildup: false,      // true: l'opacità di ogni stamp si accumula nello stroke
  pressureSize: true,
  pressureOpacity: false,
  color: { r: 26, g: 26, b: 31 },
  tool: 'brush',       // 'brush' | 'eraser' | 'pan'
};

// Falloff radiale condiviso da stamp e capsule: dist in px, r raggio, h durezza.
// Banda AA di almeno 1px anche con durezza 1.
/** @param {number} dist @param {number} r @param {number} h */
export function falloff(dist, r, h) {
  const core = r * h;
  let w = r - core;
  if (w < 1) w = 1;
  let t = (dist - core) / w;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t); // smoothstep discendente
}

const RADIUS_LOG = Math.log(1.09); // bucket di raggio a passi del 9%
const TWO_PI = Math.PI * 2;

/**
 * @typedef {Object} Stamp
 * @property {number} size
 * @property {number} half
 * @property {Uint8Array} mask
 * @property {number} r
 */

export class StampCache {
  /** @param {number} [maxEntries] */
  constructor(maxEntries = 160) {
    /** @type {Map<number, Stamp>} */
    this.map = new Map();
    this.max = maxEntries;
    this.generated = 0; // contatore per HUD
  }

  // Ritorna {size, half, mask, r} con mask Uint8Array(size*size).
  /** @param {number} radius @param {number} hardness @param {number} roundness @param {number} angleRad */
  getStamp(radius, hardness, roundness, angleRad) {
    const rB = Math.max(0, Math.round(Math.log(Math.max(0.5, radius)) / RADIUS_LOG));
    const hB = Math.round(hardness * 12);
    const roB = Math.round(roundness * 8);
    // L'angolo conta solo se il dab non è tondo
    const aB = roB >= 8 ? 0 : (Math.round(((angleRad % TWO_PI) + TWO_PI) % TWO_PI / (TWO_PI / 32)) & 31);
    const key = (rB << 16) | (hB << 12) | (roB << 8) | aB;

    let s = this.map.get(key);
    if (s !== undefined) {
      // LRU: reinserisci in coda
      this.map.delete(key);
      this.map.set(key, s);
      return s;
    }

    const r = Math.exp(rB * RADIUS_LOG);          // raggio del bucket
    const h = clamp(hB / 12, 0, 1);
    const ro = clamp(roB / 8, 0.05, 1);
    const a = aB * (TWO_PI / 32);
    s = generateStamp(r, h, ro, a);
    this.generated++;

    this.map.set(key, s);
    if (this.map.size > this.max) {
      // evict del meno recente (primo della Map)
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return s;
  }

  clear() { this.map.clear(); }
}

/**
 * @param {number} r @param {number} hardness @param {number} roundness @param {number} angle
 * @returns {Stamp}
 */
function generateStamp(r, hardness, roundness, angle) {
  const half = Math.ceil(r) + 1;
  const size = half * 2;
  const mask = new Uint8Array(size * size);
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const invRo = 1 / roundness;
  let i = 0;
  for (let y = 0; y < size; y++) {
    const py = y + 0.5 - half;
    for (let x = 0; x < size; x++, i++) {
      const px = x + 0.5 - half;
      // ruota nello spazio del pennello e schiaccia y per la roundness
      const bx = px * cos - py * sin;
      const by = (px * sin + py * cos) * invRo;
      const d = Math.sqrt(bx * bx + by * by);
      const a = falloff(d, r, hardness);
      if (a > 0) mask[i] = (a * 255 + 0.5) | 0;
    }
  }
  return { size, half, mask, r };
}
