// Pennello: stato delle impostazioni + StampCache.
// Le maschere sono alpha 0..255 antialiasate, generate per bucket di
// (raggio, durezza, roundness, angolo) e riusate: generare è O(size²), riusare è un blit.

import { clamp } from './util.js';

/** @typedef {'brush'|'eraser'|'move'|'pan'} Tool */

/**
 * @typedef {Object} Brush
 * @property {number} size
 * @property {number} opacity
 * @property {number} hardness
 * @property {number} smoothing
 * @property {number} spacing
 * @property {number} roundness
 * @property {number} angle
 * @property {boolean} scatter
 * @property {number} particleSize
 * @property {number} particleDensity
 * @property {number} particleDeviation
 * @property {number} jitterPos
 * @property {number} jitterSize
 * @property {number} jitterOpacity
 * @property {number} jitterSpacing
 * @property {number} jitterAngle
 * @property {number} jitterBright
 * @property {number} jitterSat
 * @property {boolean} buildup
 * @property {number} taperStart
 * @property {number} taperEnd
 * @property {import('./texture.js').BrushTexture|null} texture
 * @property {boolean} textureOn
 * @property {number} textureScale
 * @property {number} textureDepth
 * @property {number} textureFloor
 * @property {number} textureContrast
 * @property {boolean} textureInvert
 * @property {boolean} textureMoving
 * @property {boolean} textureUseColor
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
  scatter: false,        // ogni stamp diventa una nuvola di particelle
  particleSize: 50,      // % del raggio del dab (con scatter ON)
  particleDensity: 100,  // % -> particelle per stamp (100% = 4, range 1..12)
  particleDeviation: 0,  // % -100..100: >0 addensa al centro, <0 verso il bordo
  jitterPos: 0,        // 0..1, offset casuale radiale in unità di diametro (con
                       // scatter ON estende il raggio della nuvola)
  jitterSize: 0,       // 0..1
  jitterOpacity: 0,    // 0..1
  jitterSpacing: 0,    // 0..1
  jitterAngle: 0,      // 0..1 (1 = ±180°)
  jitterBright: 0,     // 0..1 (luminosità HSV)
  jitterSat: 0,        // 0..1 (saturazione HSV)
  buildup: false,      // true: l'opacità di ogni stamp si accumula nello stroke
  // Punte del tratto: rapporto di spessore al vertice d'inizio/fine (0 =
  // punta vera, 1 = nessuna punta). La LUNGHEZZA delle punte non si imposta:
  // la decide la velocità del gesto agli estremi (stroke.js) — frustata =
  // punte lunghe, gesto posato = corte e smussate.
  taperStart: 0,       // 0..1, rapporto al vertice d'inizio
  taperEnd: 0,         // 0..1, rapporto al vertice di fine
  // Texture/grana: modula l'alpha della maschera di ogni stamp (vedi
  // texture.js per l'asset e raster.js per il campionamento antialiasato).
  texture: null,       // BrushTexture importata o grana di default; null = off
  textureOn: false,    // interruttore (attivo solo con una texture caricata)
  textureScale: 1,     // 1 = px texture : px documento; <1 grana più fitta
  textureDepth: 0.5,   // 0..1: quanto la grana scava l'alpha
  textureFloor: 0.25,  // 0..1: alpha minima residua dove la texture è nera
  textureContrast: 1,  // contrasto attorno al grigio medio (0..3)
  textureInvert: false,
  textureMoving: false, // false: grana fissa sul canvas (carta); true: segue lo stamp
  textureUseColor: false, // true: il tratto usa i colori della texture, non il colore pennello
  color: { r: 26, g: 26, b: 31 },
  tool: 'brush',       // 'brush' | 'eraser' | 'move' | 'pan'
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
 * Con il core wasm attivo la mask è una vista sulla memoria lineare (offset
 * ptr, così il modulo la legge direttamente); ptr = 0 = buffer JS.
 * @typedef {Object} Stamp
 * @property {number} size
 * @property {number} half
 * @property {Uint8Array} mask
 * @property {number} ptr
 * @property {number} r
 */

export class StampCache {
  /** @param {number} [maxEntries] @param {import('./wasm_core.js').WasmHeap|null} [heap] */
  constructor(maxEntries = 160, heap = null) {
    /** @type {Map<number, Stamp>} */
    this.map = new Map();
    this.max = maxEntries;
    this.bytes = 0; // i formati giganti hanno maschere da MB: bound anche in byte
    this.heap = heap;
    this.generated = 0; // contatore per HUD
    this.genMs = 0;     // tempo cumulativo in generateStamp (il profiler legge i delta)
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
    const t0 = performance.now();
    s = generateStamp(r, h, ro, a, this.heap);
    this.genMs += performance.now() - t0;
    this.generated++;

    this.map.set(key, s);
    this.bytes += s.size * s.size;
    // evict dei meno recenti (primi della Map); lo slot wasm torna libero.
    // Bound per entry E per byte: l'entry appena inserita è l'ultima, mai evicted.
    while (this.map.size > 1 && (this.map.size > this.max || this.bytes > (96 << 20))) {
      const oldest = this.map.keys().next().value;
      const old = this.map.get(oldest);
      this.map.delete(oldest);
      this.bytes -= old.size * old.size;
      if (this.heap && old.ptr) this.heap.free(old.ptr, old.size * old.size);
    }
    return s;
  }

  clear() {
    if (this.heap) {
      for (const s of this.map.values()) {
        if (s.ptr) this.heap.free(s.ptr, s.size * s.size);
      }
    }
    this.map.clear();
    this.bytes = 0;
  }

  // memory.grow ha staccato il buffer wasm: rigenera le viste delle maschere.
  refreshViews() {
    if (!this.heap) return;
    for (const s of this.map.values()) s.mask = this.heap.u8(s.ptr, s.size * s.size);
  }
}

/**
 * @param {number} r @param {number} hardness @param {number} roundness @param {number} angle
 * @param {import('./wasm_core.js').WasmHeap|null} heap
 * @returns {Stamp}
 */
function generateStamp(r, hardness, roundness, angle, heap) {
  const half = Math.ceil(r) + 1;
  const size = half * 2;
  const ptr = heap ? heap.alloc(size * size) : 0;
  const mask = heap ? heap.u8(ptr, size * size) : new Uint8Array(size * size);
  if (ptr) mask.fill(0); // lo slot riusato può contenere una maschera vecchia
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
  return { size, half, mask, ptr, r };
}
