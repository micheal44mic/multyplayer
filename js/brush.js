// Pennello: stato delle impostazioni + StampCache.
// Le maschere sono alpha 0..255 antialiasate, generate per bucket di
// (raggio, durezza, roundness, angolo) e riusate: generare è O(size²), riusare è un blit.

import { clamp } from './util.js';

/** @typedef {'brush'|'eraser'|'blur'|'liquify'|'select'|'move'|'pan'|'pen'} Tool */

/**
 * @typedef {Object} Brush
 * @property {number} size
 * @property {number} opacity
 * @property {number} hardness
 * @property {number} smoothing
 * @property {'smart'|'rope'} stabilizationMode
 * @property {boolean} stabilizationDebug
 * @property {number} pressureSize
 * @property {number} pressureCurveX
 * @property {number} pressureCurveY
 * @property {number} spacing
 * @property {number} roundness
 * @property {number} angle
 * @property {number} rotation
 * @property {import('./shape.js').BrushShape|null} shape
 * @property {boolean} shapeInvert
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
 * @property {boolean} aquaEnabled
 * @property {number} aquaColorMix
 * @property {number} aquaWetness
 * @property {boolean} aquaLighten
 * @property {boolean} buildup
 * @property {number} taperStart
 * @property {number} taperEnd
 * @property {import('./texture.js').BrushTexture|null} texture
 * @property {boolean} textureOn
 * @property {number} textureScale
 * @property {number} textureAngle
 * @property {number} textureDepth
 * @property {number} textureFloor
 * @property {number} textureContrast
 * @property {boolean} textureInvert
 * @property {boolean} textureMoving
 * @property {boolean} textureUseColor
 * @property {number} blurSize
 * @property {number} blurStrength
 * @property {number} blurOpacity
 * @property {number} blurSoftness
 * @property {number} blurDrag
 * @property {'push'|'twirlR'|'twirlL'|'pinch'|'expand'|'crystals'|'edge'|'reconstruct'} liquifyMode
 * @property {number} liquifySize
 * @property {number} liquifyPressure
 * @property {number} liquifyDistortion
 * @property {number} liquifyMomentum
 * @property {import('./util.js').Rgb} color
 * @property {Tool} tool
 */

/** @type {Brush} */
export const brush = {
  size: 24,            // diametro in px documento
  opacity: 1.0,        // wash: opacità del tratto; buildup: opacità di ogni stamp
  hardness: 0.85,      // 1 = bordo duro, 0 = airbrush (morbidezza = 1 - hardness)
  smoothing: 0.15,     // forza dello stabilizzatore
  stabilizationMode: 'smart', // smart = Magma-style; rope = legacy lazy brush
  stabilizationDebug: false,  // overlay locale: raw vs punto stabilizzato
  // Stylus: curva pressione in stile Brush Studio. Size Pressure positivo
  // lascia una base fissa e fa crescere il resto con la pressione.
  pressureSize: 0.55,    // -1..1: quanto la pressione influenza la dimensione
  pressureCurveX: 0.36,  // punto di controllo della curva pressione
  pressureCurveY: 0.68,
  spacing: 0.04,       // frazione del diametro (0.001 .. 3.0)
  roundness: 1.0,      // 1 = tondo, <1 = ellisse
  angle: 0,            // gradi
  rotation: 0,         // -1..1: quanto lo stamp segue la direzione del tratto
                       // (+1 = segue, -1 = ruota al contrario, 0 = angolo fisso)
  shape: null,         // BrushShape importata: lo stamp campiona la sua alpha
                       // invece del disco procedurale (durezza ignorata;
                       // rotondità e angolo schiacciano/ruotano il riquadro)
  shapeInvert: false,  // inverte l'alpha DENTRO il riquadro dello stamp
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
  // Aqua/glass: ogni stamp campiona il colore gia' presente sotto la punta e
  // ricalcola il proprio colore. Non c'e' memoria direzionale tipo smudge.
  aquaEnabled: false,
  aquaColorMix: 0,      // 0..1: brush color -> colore medio sotto lo stamp
  aquaWetness: 0.5,     // 0..1: quanta informazione locale resta visibile nel colore
  aquaLighten: false,   // schiarisce la velatura con una variante screen
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
  textureAngle: 0,     // gradi: rotazione della grana/texture
  textureDepth: 0.5,   // 0..1: quanto la grana scava l'alpha
  textureFloor: 0.25,  // 0..1: alpha minima residua dove la texture è nera
  textureContrast: 1,  // contrasto attorno al grigio medio (0..3)
  textureInvert: false,
  textureMoving: false, // false: grana fissa sul canvas (carta); true: segue lo stamp
  textureUseColor: false, // true: il tratto usa i colori della texture, non il colore pennello
  // Tool Sfoca: impostazioni indipendenti dal pennello pittorico.
  blurSize: 64,        // diametro in px documento
  blurStrength: 1,     // 0.05..2: moltiplica il raggio gaussiano interno
  blurOpacity: 1,      // 0..1: quanto il risultato sfocato entra nel layer (non il drag)
  blurSoftness: 0.65,  // 0..1: bordo duro -> morbido
  blurDrag: 0,         // 0..1: quanto il colore viene trascinato dal gesto
  // Tool Liquify: stesso vocabolario di Procreate (Size/Pressure/Distortion/Momentum).
  liquifyMode: 'push',
  liquifySize: 120,       // diametro in px documento
  liquifyPressure: 0.68,  // forza massima del pennello liquify
  liquifyDistortion: 0,   // caos/jaggedness per Push/Twirl/Crystals/Edge
  liquifyMomentum: 0,     // overshoot dopo il rilascio
  color: { r: 26, g: 26, b: 31 },
  tool: 'brush',       // 'brush' | 'eraser' | 'blur' | 'liquify' | 'select' | 'move' | 'pan'
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

// Mezzo lato dello stamp procedurale/da shape per i valori GIA' bucketed.
// Unica fonte della taglia: la usano i generatori E la simulazione di
// creazione chunk del raster worker (raster_shared.js) — parità garantita.
/** @param {number} r */
function procHalf(r) { return Math.ceil(r) + 1; }
/** @param {number} r @param {number} ro @param {number} a */
function shapeHalf(r, ro, a) {
  // mezzo ingombro del riquadro (semilati r, r·ro) ruotato: il quadrato dello
  // stamp deve contenerlo (a 45° gli angoli escono dal raggio)
  const ac = Math.abs(Math.cos(a)), as = Math.abs(Math.sin(a));
  const ex = r * (ac + ro * as);
  const ey = r * (as + ro * ac);
  return Math.ceil(Math.max(ex, ey)) + 1;
}

/**
 * Bucketing di raggio/durezza/rotondità/angolo + geometria dello stamp.
 * Fattorizzato da getStamp: chiave cache (senza il tag shape), valori del
 * bucket e ingombro (half/size) escono da un unico posto.
 * @param {number} radius @param {number} hardness @param {number} roundness
 * @param {number} angleRad @param {import('./shape.js').BrushShape|null} [shape]
 */
export function stampParams(radius, hardness, roundness, angleRad, shape = null) {
  const rB = Math.max(0, Math.round(Math.log(Math.max(0.5, radius)) / RADIUS_LOG));
  const hB = shape ? 0 : Math.round(hardness * 12); // la shape ignora la durezza
  const roB = Math.round(roundness * 8);
  // L'angolo conta solo se il dab non è tondo (con una shape conta sempre:
  // anche a rotondità piena il riquadro non è un disco)
  const aB = !shape && roB >= 8 ? 0 : (Math.round(((angleRad % TWO_PI) + TWO_PI) % TWO_PI / (TWO_PI / 32)) & 31);
  const key = (rB << 16) | (hB << 12) | (roB << 8) | aB;
  const r = Math.exp(rB * RADIUS_LOG);          // raggio del bucket
  const h = clamp(hB / 12, 0, 1);
  const ro = clamp(roB / 8, 0.05, 1);
  const a = aB * (TWO_PI / 32);
  const half = shape ? shapeHalf(r, ro, a) : procHalf(r);
  return { key, r, h, ro, a, half, size: half * 2 };
}

// Identità stabile di una shape importata: entra nella chiave della cache
// (l'oggetto shape è immutabile, cambiare shape = nuovo oggetto = nuovi stamp).
/** @type {WeakMap<object, number>} */
const shapeTags = new WeakMap();
let nextShapeTag = 1;

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
  }

  // Ritorna {size, half, mask, r} con mask Uint8Array(size*size).
  /**
   * @param {number} radius @param {number} hardness @param {number} roundness @param {number} angleRad
   * @param {import('./shape.js').BrushShape|null} [shape] @param {boolean} [shapeInvert]
   */
  getStamp(radius, hardness, roundness, angleRad, shape = null, shapeInvert = false) {
    const p = stampParams(radius, hardness, roundness, angleRad, shape);
    let key = p.key;
    if (shape) {
      let tag = shapeTags.get(shape);
      if (tag === undefined) { tag = nextShapeTag++; shapeTags.set(shape, tag); }
      // bit 23+: rB resta sotto i 7 bit (raggio max 2000 -> rB ~88), i campi
      // procedurali non ci arrivano mai
      key += (tag * 2 + (shapeInvert ? 1 : 0)) * 0x800000;
    }

    let s = this.map.get(key);
    if (s !== undefined) {
      // LRU: reinserisci in coda
      this.map.delete(key);
      this.map.set(key, s);
      return s;
    }

    s = shape ? generateShapeStamp(p.r, p.ro, p.a, shape, shapeInvert, this.heap)
      : generateStamp(p.r, p.h, p.ro, p.a, this.heap);

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
  const half = procHalf(r);
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

/**
 * Stamp da shape importata: il quadrato della shape (lato = diametro) viene
 * schiacciato dalla rotondità e ruotato dall'angolo, poi campionato bilineare
 * sul livello mip adatto al passo — la shape resta antialiasata a qualunque
 * diametro. Bordo 0: fuori dal riquadro la shape non esiste, e l'inversione
 * (applicata al texel) sfuma comunque a 0 sul bordo del riquadro.
 * @param {number} r @param {number} roundness @param {number} angle
 * @param {import('./shape.js').BrushShape} shape @param {boolean} invert
 * @param {import('./wasm_core.js').WasmHeap|null} heap
 * @returns {Stamp}
 */
function generateShapeStamp(r, roundness, angle, shape, invert, heap) {
  const half = shapeHalf(r, roundness, angle);
  const size = half * 2;
  const ptr = heap ? heap.alloc(size * size) : 0;
  const mask = heap ? heap.u8(ptr, size * size) : new Uint8Array(size * size);
  if (ptr) mask.fill(0); // lo slot riusato può contenere una maschera vecchia

  // livello mip dal passo di campionamento (texel livello 0 per px documento)
  const step = Math.max(shape.w / (2 * r), shape.h / (2 * r * Math.max(0.05, roundness)));
  let level = 0;
  while (level + 1 < shape.mips.length && step >= (2 << level)) level++;
  const data = shape.mips[level];
  const lw = shape.mw[level], lh = shape.mh[level];
  const kx = lw / (2 * r), ky = lh / (2 * r);

  // texel con bordo 0 e inversione (l'inversione vive DENTRO il riquadro)
  /** @param {number} tx @param {number} ty */
  const at = (tx, ty) => (tx < 0 || ty < 0 || tx >= lw || ty >= lh) ? 0
    : invert ? 255 - data[ty * lw + tx] : data[ty * lw + tx];

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
      // bx,by ∈ [-r, r] dentro il riquadro -> uv del livello mip
      const u = (bx + r) * kx - 0.5;
      const v = (by + r) * ky - 0.5;
      const iu = Math.floor(u), iv = Math.floor(v);
      if (iu < -1 || iv < -1 || iu >= lw || iv >= lh) continue;
      const fu = u - iu, fv = v - iv;
      const top = at(iu, iv) * (1 - fu) + at(iu + 1, iv) * fu;
      const bot = at(iu, iv + 1) * (1 - fu) + at(iu + 1, iv + 1) * fu;
      const a = top * (1 - fv) + bot * fv;
      if (a > 0) mask[i] = (a + 0.5) | 0;
    }
  }
  return { size, half, mask, ptr, r };
}
