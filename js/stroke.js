// STROKE PIPELINE — pura matematica, nessun pixel.
// Smoother -> Sampler (accumulatore di spacing) -> dinamica delle punte ->
// descrittori in coda. La coda è un ring buffer Float32 preallocato: il
// rasterizer la drena col suo budget.

import { clamp, lerp, rgbToHsv, hsvToRgb, mulberry32 } from './util.js';
import { buildTextureLut, buildTextureColorLut } from './texture.js';

/** @typedef {import('./brush.js').Brush} Brush */

/**
 * Fotografia immutabile del pennello per la durata di uno stroke.
 * @typedef {Object} Snap
 * @property {number} baseR
 * @property {number} diam
 * @property {number} opacity
 * @property {number} hardness
 * @property {number} roundness
 * @property {import('./shape.js').BrushShape|null} shape forma importata dello stamp (null = tonda)
 * @property {boolean} shapeInvert
 * @property {number} baseAngle
 * @property {number} rotation -1..1: quota della direzione del tratto sommata all'angolo
 * @property {number} spacing
 * @property {number} smoothing
 * @property {boolean} scatter
 * @property {number} partN particelle per stamp (1 se scatter off)
 * @property {number} partSize raggio particella come frazione del raggio dab
 * @property {number} partDev -1..1: >0 addensa al centro, <0 verso il bordo
 * @property {number} jPos
 * @property {number} jSize
 * @property {number} jOp
 * @property {number} jSpacing
 * @property {number} jAngle
 * @property {number} jBright
 * @property {number} jSat
 * @property {boolean} buildup
 * @property {number} alphaCompPow
 * @property {number} taperStart rapporto di spessore al vertice d'inizio (0..1)
 * @property {number} taperEnd rapporto di spessore al vertice di fine (0..1)
 * @property {number} speedScale px documento -> px CSS (zoom camera al pen-down)
 * @property {import('./texture.js').BrushTexture|null} tex texture/grana (null = off)
 * @property {number} texScale
 * @property {number} texAngle
 * @property {number} texCos
 * @property {number} texSin
 * @property {boolean} texMoving
 * @property {Uint8Array|null} texLut luminanza -> fattore alpha 0..255
 * @property {boolean} texColor il tratto usa i colori della texture
 * @property {Uint8Array|null} texColorLut canale -> canale con contrasto
 * @property {number} colR
 * @property {number} colG
 * @property {number} colB
 * @property {import('./util.js').Hsv} hsv
 * @property {boolean} eraser
 * @property {boolean} continuous
 * @property {number} globalOpacity
 * @property {number} seed
 * @property {() => number} rng
 * @property {import('./util.js').Rgb} tmpRgb
 */

export const T_DAB = 0;
export const T_SEG = 1;
const STRIDE = 10;
const TWO_PI_STROKE = Math.PI * 2;

// Sotto questa frazione di spacing, in modalità wash, l'unione dei dab tondi
// è geometricamente identica a una catena di capsule -> via continua.
const CONTINUOUS_THRESHOLD = 0.05;
// In buildup lo spacing di rasterizzazione viene clampato e l'alpha compensata
// analiticamente: stessa copertura accumulata, 30x meno lavoro nel caso 0.1%.
const MIN_BUILDUP_SPACING = 0.03;

// Dinamica delle punte (modello "pennellata a cerchi"). La lunghezza di ogni
// punta è velocità × SENS_MS: una frustata lascia punte lunghe, un gesto
// posato corte. La velocità è misurata agli ESTREMI del gesto su una finestra
// di SW_MS (o SW_PTS punti filtrati a SW_FILTER px CSS).
// Punta d'INIZIO: le emissioni vengono trattenute finché la finestra non si
// chiude (~70 ms), poi lunghezza e rapporto della punta sono congelati e il
// tratto parte già col profilo esatto — niente secondo pass sull'attacco.
// Punta di FINE: non può essere disegnata live (la fine non è nota): il
// tratto arriva pieno fino alla punta — zero ritardo — e ogni emissione viene
// registrata; al pen-up il chiamante svuota i SOLI chunk coperti dalla punta
// (endPassRect) e replay(), clippato lì dal rasterizer, ridisegna il cono
// finale: costo ∝ area della punta, non del tratto intero.
// Tetti: ogni punta al massimo TIP_MAX_FRAC del tratto, le due insieme
// TIP_SUM_FRAC. Se i tetti accorciano la punta d'inizio rispetto a quella
// disegnata live (tratto corto), il replay rifà il tratto intero: costo
// comunque piccolo, il tratto è corto.
const SENS_MS = 250;   // ms: lunghezza punta = velocità × SENS_MS
const VFULL = 1.5;     // px CSS/ms: a questa velocità il vertice raggiunge il rapporto impostato
const EXTRA = 0.35;    // pavimento extra a velocità zero: lento = moncone
const SW_MS = 70;      // ms: finestra di misura della velocità agli estremi
const SW_PTS = 10;     // ...o al massimo 10 punti filtrati
const SW_FILTER = 1.5; // px CSS: distanza minima tra punti per la misura
const TIP_MAX_FRAC = 0.65; // ogni punta: al massimo 65% della lunghezza del tratto
const TIP_SUM_FRAC = 0.95; // le due insieme: al massimo 95%
const MIN_R_PX = 0.06; // raggio sotto cui il dab non si stampa: la punta finisce a zero
const REPLAY_MIN_GAP_PX = 0.5; // passo minimo del ricampionamento delle punte
// dir: angolo di direzione UNWRAPPATO al momento dell'emissione — il replay
// del corpo deve ristampare gli stessi identici dab del live (rotazione
// inclusa), i chunk al confine della punta non devono mostrare cuciture.
const REC_STRIDE = 6;    // registro: x, y, m, mP, burn, dir
const REC_MAX = 1 << 21; // tetto del registro (~50MB): oltre, niente pass finale

// Snap rapido "draw and hold": dopo una breve pausa una linea quasi dritta,
// o un anello quasi chiuso, diventa geometria perfetta. Dopo l'aggancio il
// punto finale/maniglia puo' muoversi liberamente: non si ricontrolla piu'
// la forma originale.
const SNAP_HOLD_MS = 260;
const SNAP_SAMPLE_CSS = 0.6;
const SNAP_STILL_CSS = 2.5;
const LINE_MIN_CSS = 24;
const LINE_DEV_CSS = 7;
const LINE_DEV_BRUSH = 0.45;
const LINE_PATH_RATIO = 1.08;
const ELLIPSE_MIN_CSS = 28;
const ELLIPSE_CLOSE_CSS = 26;
const ELLIPSE_RADIAL_ERR = 0.22;
const ELLIPSE_MAX_ERR = 0.48;
const ELLIPSE_MIN_SWEEP = Math.PI * 1.55;
const CIRCLE_RATIO = 0.86;
const ELLIPSE_MIN_RATIO = 0.16;

// Stabilizzazione "agganciata alla punta": un filtro One Euro pulisce il
// tremolio lento, ma un tether in px schermo impedisce l'effetto elastico.
const STAB_FAST_CUTOFF_HZ = 48;
const STAB_SLOW_CUTOFF_HZ = 0.7;
const STAB_SPEED_BOOST_HZ = 42;
const STAB_VELOCITY_FAST_HZ = 18;
const STAB_VELOCITY_SLOW_HZ = 2.2;
const STAB_MAX_LAG_CSS = 3.25;

// Salto massimo di raggio tra due emissioni consecutive: oltre, si inseriscono
// dab intermedi interpolati — i gradini del bordo restano sub-pixel dovunque
// il raggio cambia (punte, pressione). Lo spacing dell'utente resta il ritmo
// base: a raggio costante non si aggiunge nulla.
const MAX_R_STEP_PX = 0.5;
// ...ma SOLO dove gli stamp consecutivi si sovrappongono (il tratto è un
// nastro continuo, la smerlatura si vede). Se il passo supera questa frazione
// della somma dei raggi, i tondi sono separati di proposito (spacing alto):
// le punte devono scalarli, non fonderli con un ponte di dab intermedi.
const SUBDIV_OVERLAP = 0.75;

// Profilo della punta: ease-out quartico 1-(1-x)^4 ("curvatura punta" 4).
// Pendenza piena in x=0 — lo spessore cresce subito appena lasciato il
// vertice — e tangente nulla in x=1: il raccordo col corpo pieno è senza
// stacco.
/** @param {number} x 0 al vertice, 1 al corpo */
function easeTip(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const t = 1 - x;
  return 1 - t * t * t * t;
}

// Fattore di spessore a distanza d dal vertice di una punta lunga len:
// th al vertice, 1 da len in poi.
/** @param {number} d @param {number} len @param {number} th */
function tipFactor(d, len, th) {
  if (d >= len) return 1;
  return th + (1 - th) * easeTip(d / len);
}

// Rapporto al vertice: il valore impostato più un pavimento EXTRA che
// svanisce con la velocità (S-curve fino a VFULL) — un'estremità posata
// lascia un moncone, solo la frustata arriva al valore scelto (0 = punta
// vera), come un pennello fisico.
/** @param {number} setting rapporto impostato (0..1) @param {number} velCss px CSS/ms */
function tipRatio(setting, velCss) {
  let k = velCss / VFULL;
  k = k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
  return setting + (1 - k) * EXTRA * (1 - setting);
}

export class DabQueue {
  /** @param {number} [cap] */
  constructor(cap = 1 << 15) {
    this.cap = cap;
    this.buf = new Float32Array(cap * STRIDE);
    this.head = 0;   // indice entry di lettura
    this.tail = 0;   // indice entry di scrittura
    this.count = 0;
    // Specchio verticale: x dell'asse in coordinate documento (null = off).
    // Ogni entry accodata viene duplicata riflessa qui, l'unico imbuto della
    // pipeline: vale per live, replay della punta e quindi commit e undo
    // senza altri punti di aggancio. Fotografato dall'App al pen-down.
    /** @type {number|null} */
    this.mirrorX = null;
    // Pattern seamless: ogni entry viene ripetuta sui tile adiacenti, poi il
    // rasterizer clippa al canvas attivo. Basta a far rientrare sui bordi
    // opposti tutto cio' che esce dalla tile.
    /** @type {{x: number, y: number, w: number, h: number}|null} */
    this.patternTile = null;
  }
  get free() { return this.cap - this.count; }
  _grow() {
    const nb = new Float32Array(this.cap * 2 * STRIDE);
    // ricompatta dall'head
    for (let i = 0; i < this.count; i++) {
      const src = ((this.head + i) % this.cap) * STRIDE;
      nb.set(this.buf.subarray(src, src + STRIDE), i * STRIDE);
    }
    this.buf = nb; this.cap *= 2; this.head = 0; this.tail = this.count;
  }
  /**
   * @param {number} t @param {number} a @param {number} b @param {number} c @param {number} d
   * @param {number} e @param {number} f @param {number} g @param {number} h @param {number} i
   */
  push(t, a, b, c, d, e, f, g, h, i) {
    this._putRepeated(t, a, b, c, d, e, f, g, h, i);
    const ax = this.mirrorX;
    if (ax !== null) {
      const m2 = ax * 2;
      if (t === T_DAB) {
        // dab: x riflessa, angolo π-θ (la riflessione di una direzione θ
        // sull'asse verticale). Lo stamp in sé non viene flippato: per
        // ellissi e tonde è esatto, una shape asimmetrica segue comunque
        // la direzione specchiata del tratto.
        this._putRepeated(t, m2 - a, b, c, d, Math.PI - e, f, g, h, i);
      } else {
        // capsula: entrambi gli estremi riflessi (entry autosufficiente,
        // l'interleave con la catena originale non cuce niente)
        this._putRepeated(t, m2 - a, b, c, d, m2 - e, f, g, h, i);
      }
    }
  }
  /**
   * @param {number} t @param {number} a @param {number} b @param {number} c @param {number} d
   * @param {number} e @param {number} f @param {number} g @param {number} h @param {number} i
   */
  _putRepeated(t, a, b, c, d, e, f, g, h, i) {
    const tile = this.patternTile;
    if (!tile || tile.w <= 0 || tile.h <= 0) {
      this._put(t, a, b, c, d, e, f, g, h, i);
      return;
    }
    const xs = [-tile.w, 0, tile.w];
    const ys = [-tile.h, 0, tile.h];
    for (const ox of xs) {
      for (const oy of ys) {
        if (!this._repeatHitsTile(t, a, b, c, e, f, g, ox, oy, tile)) continue;
        if (t === T_DAB) this._put(t, a + ox, b + oy, c, d, e, f, g, h, i);
        else this._put(t, a + ox, b + oy, c, d, e + ox, f + oy, g, h, i);
      }
    }
  }
  /**
   * @param {number} t @param {number} a @param {number} b @param {number} c
   * @param {number} e @param {number} f @param {number} g
   * @param {number} ox @param {number} oy
   * @param {{x: number, y: number, w: number, h: number}} tile
   */
  _repeatHitsTile(t, a, b, c, e, f, g, ox, oy, tile) {
    let x0, y0, x1, y1;
    if (t === T_DAB) {
      const pad = c * 1.5 + 4;
      x0 = a + ox - pad; y0 = b + oy - pad;
      x1 = a + ox + pad; y1 = b + oy + pad;
    } else {
      const pad = Math.max(c, g) + 4;
      x0 = Math.min(a, e) + ox - pad; y0 = Math.min(b, f) + oy - pad;
      x1 = Math.max(a, e) + ox + pad; y1 = Math.max(b, f) + oy + pad;
    }
    return x1 >= tile.x && y1 >= tile.y &&
      x0 <= tile.x + tile.w - 1 && y0 <= tile.y + tile.h - 1;
  }
  /**
   * @param {number} t @param {number} a @param {number} b @param {number} c @param {number} d
   * @param {number} e @param {number} f @param {number} g @param {number} h @param {number} i
   */
  _put(t, a, b, c, d, e, f, g, h, i) {
    if (this.count === this.cap) this._grow();
    const o = this.tail * STRIDE, q = this.buf;
    q[o] = t; q[o + 1] = a; q[o + 2] = b; q[o + 3] = c; q[o + 4] = d;
    q[o + 5] = e; q[o + 6] = f; q[o + 7] = g; q[o + 8] = h; q[o + 9] = i;
    this.tail = (this.tail + 1) % this.cap;
    this.count++;
  }
  peekOffset() { return this.head * STRIDE; }
  pop() { this.head = (this.head + 1) % this.cap; this.count--; }
  clear() { this.head = 0; this.tail = 0; this.count = 0; }
}

let strokeSeed = 1;

// Catmull-Rom centripetale (Barry-Goldman) valutata al parametro t.
// I nodi arrivano già con epsilon: i punti duplicati ai bordi del tratto
// non degenerano. Scrive in out (zero allocazioni).
/**
 * @param {{x: number, y: number}} p0 @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2 @param {{x: number, y: number}} p3
 * @param {number} t0 @param {number} t1 @param {number} t2 @param {number} t3
 * @param {number} t @param {{x: number, y: number}} out
 */
function crEval(p0, p1, p2, p3, t0, t1, t2, t3, t, out) {
  const f01 = 1 / (t1 - t0), f12 = 1 / (t2 - t1), f23 = 1 / (t3 - t2);
  const a1x = (p0.x * (t1 - t) + p1.x * (t - t0)) * f01;
  const a1y = (p0.y * (t1 - t) + p1.y * (t - t0)) * f01;
  const a2x = (p1.x * (t2 - t) + p2.x * (t - t1)) * f12;
  const a2y = (p1.y * (t2 - t) + p2.y * (t - t1)) * f12;
  const a3x = (p2.x * (t3 - t) + p3.x * (t - t2)) * f23;
  const a3y = (p2.y * (t3 - t) + p3.y * (t - t2)) * f23;
  const f02 = 1 / (t2 - t0), f13 = 1 / (t3 - t1);
  const b1x = (a1x * (t2 - t) + a2x * (t - t0)) * f02;
  const b1y = (a1y * (t2 - t) + a2y * (t - t0)) * f02;
  const b2x = (a2x * (t3 - t) + a3x * (t - t1)) * f13;
  const b2y = (a2y * (t3 - t) + a3y * (t - t1)) * f13;
  out.x = (b1x * (t2 - t) + b2x * (t - t1)) * f12;
  out.y = (b1y * (t2 - t) + b2y * (t - t1)) * f12;
  return out;
}

/** @param {number} cutoffHz @param {number} dtMs */
function filterAlpha(cutoffHz, dtMs) {
  const dt = clamp(dtMs, 1, 64) * 0.001;
  const tau = 1 / (TWO_PI_STROKE * Math.max(0.001, cutoffHz));
  return 1 / (1 + tau / dt);
}

// Sotto questa deviazione (px documento) la corda è indistinguibile dalla
// curva: niente suddivisione, costo zero rispetto a prima.
const CURVE_TOL = 0.25;

export class StrokeEngine {
  /** @param {DabQueue} queue */
  constructor(queue) {
    this.q = queue;
    this.active = false;
    /** @type {Snap|null} */
    this.snap = null;
    this.dabsEmitted = 0;
    // stato smoother
    this._sx = 0; this._sy = 0; this._sp = 0;
    this._rx = 0; this._ry = 0; this._rt = 0;
    this._svx = 0; this._svy = 0;
    // stato sampler
    this._lx = 0; this._ly = 0; this._lp = 0;     // ultimo punto campionato
    this._gapLeft = 0;
    this._dirX = 1; this._dirY = 0;               // direzione corrente del tratto
    this._dirA = 0;                               // ...come angolo UNWRAPPATO (radianti,
                                                  // continuo: niente flip a ±π con la
                                                  // rotazione parziale; può accumulare giri)
    this._moved = 0;                              // distanza campionata totale
    // dinamica delle punte
    this._t0 = 0;                                 // tempo pen-down
    this._held = false;                           // emissioni trattenute (finestra d'inizio aperta)
    /** @type {number[]} */
    this._hw = [];                                // input trattenuti: x, y, p, t per punto
    this._swMinD = 0;                             // filtro distanza (px documento) per la misura
    this._swDist = 0;                             // finestra d'inizio: distanza filtrata accumulata
    this._swN = 0;                                // ... e punti accettati
    this._swX = 0; this._swY = 0; this._swT = 0;  // ultimo punto accettato dal filtro
    this._la = 1; this._th0 = 1;                  // punta d'inizio congelata alla chiusura della finestra
    this._tipMin = 2;                             // lunghezza minima punta (px documento)
    this._trX = new Float64Array(SW_PTS + 2);     // ring degli ultimi punti accettati (velocità di fine)
    this._trY = new Float64Array(SW_PTS + 2);
    this._trT = new Float64Array(SW_PTS + 2);
    this._trN = 0;                                // contatore logico del ring
    // registro delle emissioni per il pass finale: (x, y, m, mP, burn) —
    // m = moltiplicatore emesso, mP = sola pressione (per ricampionare con
    // altri coni), burn = 1 se nel live è seguito un rng() di jitterSpacing
    this._rec = new Float32Array(1024 * REC_STRIDE);
    this._recCap = 1024;
    this._recN = 0;
    this._lemX = 0; this._lemY = 0; this._lemM = -1; // ultima emissione live (per la suddivisione; -1 = nessuna)
    this._lemP = 1;                               // ... e il suo moltiplicatore di sola pressione
    this._enX = 0; this._enY = 0; this._enValid = false; // ultima emissione discreta (per l'alpha buildup)
    this._D = 0;                                  // lunghezza della polilinea registrata (px documento)
    this._laX = 0; this._lbX = 0;                 // lunghezze esatte delle punte dopo i tetti
    this._th1 = 0;                                // rapporto al vertice di fine
    this._full = false;                           // il replay rifà il tratto intero (tetti sull'attacco)
    this.endPassNeeded = false;                   // il chiamante deve fare drop+replay
    this._segStarted = false;                     // via continua: primo nodo emesso
    this._fx = 0; this._fy = 0; this._fr = 0;     // ultimo nodo emesso
    // curva: ring degli ultimi 4 punti stabilizzati. Il segmento q1->q2 viene
    // emesso come Catmull-Rom quando arriva il punto successivo (lag di un
    // evento, ~5 ms): tra punti radi (mano veloce) niente più poligoni.
    this._cq = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }];
    this._cqN = 0;
    this._cm = { x: 0, y: 0 }; // out riusato per crEval
    // stato dello snap rapido (linea/cerchio/ellisse)
    this._snapMode = false;
    this._snapKind = '';
    this._snapEligible = false;
    this._snapDirty = false;
    this._straightSX = 0; this._straightSY = 0; this._straightSP = 1; this._straightST = 0;
    this._straightEX = 0; this._straightEY = 0; this._straightEP = 1; this._straightET = 0;
    this._straightLastX = 0; this._straightLastY = 0;
    this._straightStillX = 0; this._straightStillY = 0; this._straightStillT = 0;
    this._straightPath = 0;
    this._straightN = 0; this._straightCap = 128;
    this._straightX = new Float64Array(this._straightCap);
    this._straightY = new Float64Array(this._straightCap);
    this._snapCx = 0; this._snapCy = 0;
    this._snapRx = 0; this._snapRy = 0; this._snapAngle = 0;
    this._snapUx = 1; this._snapUy = 0; this._snapVx = 0; this._snapVy = 1;
  }

  // Fotografa il pennello: lo stroke è deterministico e indipendente
  // da cambi di impostazioni a metà tratto. seed: rng fisso (preview del
  // pennello — scatter/jitter identici a ogni re-render, niente sfarfallio).
  // t: timeStamp dell'evento (stesso orologio di performance.now()).
  // speedScale: zoom camera, così la velocità è quella fisica del gesto
  // (px CSS/ms) e non dipende da quanto si è zoomati.
  /**
   * @param {number} x @param {number} y @param {number} p @param {number} t
   * @param {Brush} brush @param {number} [seed] @param {number} [speedScale]
   */
  begin(x, y, p, t, brush, seed, speedScale = 1) {
    const rngSeed = seed !== undefined ? seed >>> 0 : (strokeSeed = (strokeSeed * 1103515245 + 12345) >>> 0);
    const baseR = Math.max(0.5, brush.size * 0.5);
    const eraser = brush.tool === 'eraser';
    const hsv = rgbToHsv(brush.color.r, brush.color.g, brush.color.b, { h: 0, s: 0, v: 0 });

    // Con profondità zero la texture serve comunque se presta i suoi colori
    // al tratto.
    const tex = brush.textureOn && brush.texture &&
      (brush.textureDepth > 0.0001 || (brush.textureUseColor && !eraser))
      ? brush.texture : null;
    let texAngle = ((brush.textureAngle || 0) % 360) * Math.PI / 180;
    if (texAngle < 0) texAngle += TWO_PI_STROKE;
    if (texAngle >= TWO_PI_STROKE - 1e-9) texAngle = 0;

    const noJitter = !brush.scatter && brush.jitterPos === 0 && brush.jitterSize === 0 &&
      brush.jitterOpacity === 0 && brush.jitterSpacing === 0 &&
      brush.jitterBright === 0 && brush.jitterSat === 0;
    // La grana ancorata al canvas modula ogni pixel allo stesso modo
    // qualunque sia il dab che lo copre: l'unione wash dei dab resta una
    // catena di capsule anche texturizzata (capsule_tex legge il fattore dai
    // tile). Solo la grana moving (che segue lo stamp) forza la via discreta.
    // ...e la shape importata forza la via discreta: le capsule sanno
    // interpolare solo dischi.
    const continuous = !brush.shape && !brush.buildup && noJitter && brush.roundness >= 0.999 &&
      brush.spacing < CONTINUOUS_THRESHOLD && (!tex || !brush.textureMoving);

    // compensazione alpha per il clamp di spacing in buildup
    let rasterSpacing = brush.spacing;
    let alphaCompPow = 1;
    if (brush.buildup && brush.spacing < MIN_BUILDUP_SPACING) {
      rasterSpacing = MIN_BUILDUP_SPACING;
      alphaCompPow = MIN_BUILDUP_SPACING / brush.spacing;
    }

    this.snap = {
      baseR,
      diam: baseR * 2,
      opacity: brush.opacity,
      hardness: eraser ? Math.min(brush.hardness, 0.95) : brush.hardness,
      roundness: brush.roundness,
      shape: brush.shape || null,
      shapeInvert: !!brush.shapeInvert,
      baseAngle: brush.angle * Math.PI / 180,
      rotation: clamp(brush.rotation || 0, -1, 1),
      spacing: rasterSpacing,
      smoothing: brush.smoothing,
      scatter: brush.scatter,
      partN: brush.scatter ? Math.max(1, Math.min(12, Math.round(4 * brush.particleDensity / 100))) : 1,
      partSize: Math.max(0.02, brush.particleSize / 100),
      partDev: clamp(brush.particleDeviation / 100, -1, 1),
      jPos: brush.jitterPos,
      jSize: brush.jitterSize,
      jOp: brush.jitterOpacity,
      jSpacing: brush.jitterSpacing,
      jAngle: brush.jitterAngle,
      jBright: brush.jitterBright,
      jSat: brush.jitterSat,
      buildup: brush.buildup,
      alphaCompPow,
      taperStart: clamp(brush.taperStart, 0, 1),
      taperEnd: clamp(brush.taperEnd, 0, 1),
      speedScale,
      tex,
      texScale: clamp(brush.textureScale || 1, 0.05, 16),
      texAngle,
      texCos: Math.cos(texAngle),
      texSin: Math.sin(texAngle),
      texMoving: !!brush.textureMoving,
      texLut: tex ? buildTextureLut(brush.textureDepth, brush.textureContrast,
        brush.textureFloor, brush.textureInvert) : null,
      // la gomma non ha colore: la modalità colore si applica solo al pennello
      texColor: !!(tex && brush.textureUseColor && !eraser),
      texColorLut: tex && brush.textureUseColor && !eraser
        ? buildTextureColorLut(brush.textureContrast) : null,
      colR: eraser ? 255 : brush.color.r,
      colG: eraser ? 255 : brush.color.g,
      colB: eraser ? 255 : brush.color.b,
      hsv,
      eraser,
      continuous,
      // opacità globale applicata al composito (e allo shader live):
      // wash -> slider; buildup -> 1 (l'accumulo è già nei dab)
      globalOpacity: brush.buildup ? 1 : brush.opacity,
      seed: rngSeed,
      rng: mulberry32(rngSeed),
      tmpRgb: { r: 0, g: 0, b: 0 },
    };

    this.active = true;
    this.dabsEmitted = 0;
    this._sx = x; this._sy = y; this._sp = p;
    this._rx = x; this._ry = y; this._rt = t;
    this._svx = 0; this._svy = 0;
    this._lx = x; this._ly = y; this._lp = p;
    this._dirX = 1; this._dirY = 0;
    this._dirA = 0;
    this._moved = 0;
    this._recN = 0;
    this._lemM = -1;
    this._enValid = false;
    this.endPassNeeded = false;
    this._full = false;
    this._segStarted = false;
    this._cqN = 0;
    this._straightBegin(x, y, p, t);
    // misura della velocità: finestra d'inizio + ring di fine
    this._t0 = t;
    this._tipMin = Math.max(2, brush.size * 0.06);
    this._swMinD = SW_FILTER / speedScale;
    this._swDist = 0; this._swN = 1;
    this._swX = x; this._swY = y; this._swT = t;
    this._trN = 0;
    this._trPush(x, y, t);
    this._la = 1; this._th0 = 1;
    this._hw.length = 0;
    if (this.snap.taperStart >= 1) {
      // punta d'inizio spenta: nessuna attesa, si emette subito
      this._held = false;
      this._emitFirst(x, y, p);
    } else {
      this._held = true;
      this._hw.push(x, y, p, t);
    }
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  move(x, y, p, t) {
    if (!this.active) return;
    if (this._snapMode || this._tryActivateSnap(t)) {
      this._snapSetHandle(x, y, p, t);
      return;
    }
    this._straightTrack(x, y, p, t);
    // misura della velocità sui punti grezzi, filtrati a SW_FILTER px CSS
    // (il jitter sub-pixel della mano non deve sporcare i timestamp)
    const d = Math.hypot(x - this._swX, y - this._swY);
    if (d >= this._swMinD) {
      if (this._held) { this._swDist += d; this._swN++; }
      this._swX = x; this._swY = y; this._swT = t;
      this._trPush(x, y, t);
    }
    if (this._held) {
      this._hw.push(x, y, p, t);
      if (t - this._t0 >= SW_MS || this._swN > SW_PTS) this._closeWindow();
      return;
    }
    this._moveBody(x, y, p, t);
  }

  // Stabilizer: filtra il tremolio senza lasciare la punta "al guinzaglio".
  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _moveBody(x, y, p, t) {
    const amount = Math.sqrt(clamp(this.snap.smoothing, 0, 1));
    if (amount <= 0.0001) {
      this._sx = x; this._sy = y; this._sp = p;
      this._rx = x; this._ry = y; this._rt = t;
      this._pushPoint(x, y, p);
      return;
    }

    const dt = clamp(t - this._rt || 16, 1, 64);
    const vx = (x - this._rx) / dt;
    const vy = (y - this._ry) / dt;
    this._rx = x; this._ry = y; this._rt = t;

    const va = filterAlpha(lerp(STAB_VELOCITY_FAST_HZ, STAB_VELOCITY_SLOW_HZ, amount), dt);
    this._svx += (vx - this._svx) * va;
    this._svy += (vy - this._svy) * va;
    const speedCss = Math.hypot(this._svx, this._svy) * this.snap.speedScale;

    const cutoff = lerp(STAB_FAST_CUTOFF_HZ, STAB_SLOW_CUTOFF_HZ, amount) +
      speedCss * STAB_SPEED_BOOST_HZ * amount;
    const a = filterAlpha(cutoff, dt);
    this._sx += (x - this._sx) * a;
    this._sy += (y - this._sy) * a;
    this._sp += (p - this._sp) * a;

    const maxLag = lerp(0.25, STAB_MAX_LAG_CSS, amount) /
      Math.max(0.001, this.snap.speedScale);
    const lx = x - this._sx, ly = y - this._sy;
    const lag = Math.hypot(lx, ly);
    if (lag > maxLag) {
      const keep = maxLag / lag;
      this._sx = x - lx * keep;
      this._sy = y - ly * keep;
    }
    this._pushPoint(this._sx, this._sy, this._sp);
  }

  // Chiude la finestra di velocità d'inizio: congela lunghezza e rapporto
  // della punta, poi emette gli input trattenuti attraverso la pipeline
  // normale — il profilo disegnato live è già quello esatto, l'attacco non
  // ha bisogno di un secondo pass (salvo i tetti sui tratti corti).
  _closeWindow() {
    const s = this.snap;
    const dt = this._swT - this._t0;
    const v = dt > 0 ? this._swDist / dt : 0; // px documento/ms
    this._la = Math.max(this._tipMin, v * SENS_MS);
    this._th0 = tipRatio(s.taperStart, v * s.speedScale);
    this._held = false;
    const hw = this._hw;
    this._emitFirst(hw[0], hw[1], hw[2]);
    for (let i = 4; i < hw.length; i += 4) this._moveBody(hw[i], hw[i + 1], hw[i + 2], hw[i + 3]);
    hw.length = 0;
  }

  // Primo nodo della curva + primo dab/dot (al pen-down se la punta d'inizio
  // è spenta, altrimenti al flush della finestra).
  /** @param {number} x @param {number} y @param {number} p */
  _emitFirst(x, y, p) {
    const s = this.snap;
    this._pushPoint(x, y, p);
    const mP = this._pressMult(p);
    const m = mP * this._th0; // fattore della punta in s=0
    this._emitLive(x, y, m, mP, !s.continuous);
    if (!s.continuous) this._gapLeft = this._nextGap(Math.max(0.25, s.baseR * m));
  }

  // Chiamato dal frame loop: a penna ferma i pointermove non arrivano e la
  // finestra d'inizio resterebbe aperta — la si chiude a tempo, così il dot
  // di pen-down appare dopo SW_MS (al pavimento di velocità zero).
  /** @param {number} now */
  tick(now) {
    if (this.active && this._held && now - this._t0 >= SW_MS) this._closeWindow();
    if (this.active) this._tryActivateSnap(now);
  }

  // Catch-up: a fine tratto lo stabilizzatore raggiunge il punto grezzo;
  // poi si calcolano le punte esatte per il pass finale.
  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  end(x, y, p, t) {
    if (!this.active) return;
    if (this._held) this._closeWindow();
    if (this._snapMode || this._tryActivateSnap(t)) {
      this._snapSetHandle(x, y, p, t);
      this.active = false;
      this.endPassNeeded = false;
      return;
    }
    this._moveBody(x, y, p, t);
    if (this.snap.smoothing > 0 && Math.hypot(this._sx - x, this._sy - y) > 0.05) {
      this._sx = x; this._sy = y; this._sp = p;
      this._pushPoint(x, y, p);
    }
    this._flushCurve();
    this.active = false;

    // serve il pass finale? (il chiamante fa drop dei chunk della punta —
    // o di tutto il buffer se _full — e poi replay())
    const s = this.snap;
    this.endPassNeeded = false;
    if (this._moved < 1 || this._recN < 2 || this._recN >= REC_MAX) return;
    this._trPush(x, y, t);
    const ve = this._endSpeed(t);
    const r = this._rec;
    let D = 0;
    for (let i = REC_STRIDE; i < this._recN * REC_STRIDE; i += REC_STRIDE) {
      D += Math.hypot(r[i] - r[i - REC_STRIDE], r[i + 1] - r[i - REC_STRIDE + 1]);
    }
    this._D = D;
    let la = Math.min(this._la, TIP_MAX_FRAC * D);
    let lb = Math.min(Math.max(this._tipMin, ve * SENS_MS), TIP_MAX_FRAC * D);
    if (la + lb > TIP_SUM_FRAC * D) {
      const k = TIP_SUM_FRAC * D / (la + lb);
      la *= k; lb *= k;
    }
    this._laX = la; this._lbX = lb;
    this._th1 = tipRatio(s.taperEnd, ve * s.speedScale);
    // i tetti hanno accorciato la punta d'inizio già disegnata live? allora
    // l'attacco è sbagliato e si rifà il tratto intero (succede solo sui
    // tratti corti: costo piccolo)
    this._full = s.taperStart < 1 && la < this._la - 0.01;
    this.endPassNeeded = this._th1 < 1 || this._full;
  }

  cancel() {
    this.active = false; this._held = false; this._hw.length = 0;
    this._cqN = 0; this._recN = 0; this.endPassNeeded = false;
    this._snapMode = false; this._snapDirty = false; this._straightN = 0;
  }

  get snapMode() { return this._snapMode; }
  get snapDirty() { return this._snapDirty; }
  get snapKind() { return this._snapKind; }
  get straightMode() { return this._snapMode; }
  get straightDirty() { return this._snapDirty; }

  // Accoda la geometria perfetta corrente nel DabQueue. Il chiamante svuota
  // prima la preview live, cosi' spostare la maniglia costa un rerender/frame.
  emitSnap() {
    const s = this.snap;
    if (!s || !this._snapMode) return false;
    if (this._snapKind === 'ellipse' || this._snapKind === 'circle') {
      return this._emitEllipseSnap();
    }
    return this._emitLineSnap();
  }

  emitStraight() { return this.emitSnap(); }

  _emitLineSnap() {
    const s = this.snap;
    const dx = this._straightEX - this._straightSX;
    const dy = this._straightEY - this._straightSY;
    if (dx * dx + dy * dy > 0.0001) this._setDir(Math.atan2(dy, dx));
    const t0 = s.taperStart < 1 ? tipRatio(s.taperStart, 0) : 1;
    const t1 = s.taperEnd < 1 ? tipRatio(s.taperEnd, 0) : 1;
    const r0 = Math.max(0.25, s.baseR * this._pressMult(this._straightSP) * t0);
    const r1 = Math.max(0.25, s.baseR * this._pressMult(this._straightEP) * t1);
    this.q.push(T_SEG, this._straightSX, this._straightSY, r0, 1,
      this._straightEX, this._straightEY, r1, 1, 0);
    this.dabsEmitted++;
    this._snapDirty = false;
    return true;
  }

  _emitEllipseSnap() {
    const s = this.snap;
    const rx = this._snapRx, ry = this._snapRy;
    if (rx < 0.5 || ry < 0.5) return false;
    const h = Math.pow(rx - ry, 2) / Math.pow(rx + ry, 2);
    const circumference = Math.PI * (rx + ry) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
    const n = Math.max(28, Math.min(256, Math.ceil(circumference / Math.max(4, s.baseR))));
    const ux = this._snapUx, uy = this._snapUy, vx = this._snapVx, vy = this._snapVy;
    let px = this._snapCx + ux * rx;
    let py = this._snapCy + uy * rx;
    const m = this._pressMult((this._straightSP + this._straightEP) * 0.5);
    const r = Math.max(0.25, s.baseR * m);
    for (let i = 1; i <= n; i++) {
      const a = i * TWO_PI_STROKE / n;
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = this._snapCx + ux * rx * ca + vx * ry * sa;
      const y = this._snapCy + uy * rx * ca + vy * ry * sa;
      this.q.push(T_SEG, px, py, r, 1, x, y, r, 1, 0);
      px = x; py = y;
    }
    this.dabsEmitted += n;
    this._snapDirty = false;
    return true;
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _straightBegin(x, y, p, t) {
    this._snapMode = false;
    this._snapKind = '';
    this._snapDirty = false;
    this._snapEligible = !!this.snap.continuous;
    this._straightSX = x; this._straightSY = y; this._straightSP = p; this._straightST = t;
    this._straightEX = x; this._straightEY = y; this._straightEP = p; this._straightET = t;
    this._straightLastX = x; this._straightLastY = y;
    this._straightStillX = x; this._straightStillY = y; this._straightStillT = t;
    this._straightPath = 0;
    this._straightN = 0;
    this._straightPush(x, y);
    this._snapCx = x; this._snapCy = y; this._snapRx = 0; this._snapRy = 0; this._snapAngle = 0;
    this._snapUx = 1; this._snapUy = 0; this._snapVx = 0; this._snapVy = 1;
  }

  /** @param {number} x @param {number} y */
  _straightPush(x, y) {
    if (this._straightN === this._straightCap) {
      const nx = new Float64Array(this._straightCap * 2);
      const ny = new Float64Array(this._straightCap * 2);
      nx.set(this._straightX); ny.set(this._straightY);
      this._straightX = nx; this._straightY = ny; this._straightCap *= 2;
    }
    this._straightX[this._straightN] = x;
    this._straightY[this._straightN] = y;
    this._straightN++;
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _straightTrack(x, y, p, t) {
    const invScale = 1 / Math.max(0.001, this.snap.speedScale);
    const sample = SNAP_SAMPLE_CSS * invScale;
    const still = SNAP_STILL_CSS * invScale;
    this._straightEX = x; this._straightEY = y; this._straightEP = p; this._straightET = t;
    const dx = x - this._straightLastX, dy = y - this._straightLastY;
    const d = Math.hypot(dx, dy);
    if (d >= sample) {
      this._straightPath += d;
      this._straightLastX = x; this._straightLastY = y;
      this._straightPush(x, y);
    }
    const sx = x - this._straightStillX, sy = y - this._straightStillY;
    if (sx * sx + sy * sy >= still * still) {
      this._straightStillX = x; this._straightStillY = y; this._straightStillT = t;
    }
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _snapSetHandle(x, y, p, t) {
    if (this._snapKind === 'ellipse' || this._snapKind === 'circle') {
      this._ellipseSetHandle(x, y, p, t);
      return;
    }
    this._straightSetEnd(x, y, p, t);
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _straightSetEnd(x, y, p, t) {
    const dx = x - this._straightEX, dy = y - this._straightEY;
    this._straightEX = x; this._straightEY = y; this._straightEP = p; this._straightET = t;
    if (dx * dx + dy * dy > 0.0001) this._snapDirty = true;
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _ellipseSetHandle(x, y, p, t) {
    const dx = x - this._straightEX, dy = y - this._straightEY;
    this._straightEX = x; this._straightEY = y; this._straightEP = p; this._straightET = t;
    const invScale = 1 / Math.max(0.001, this.snap.speedScale);
    const minMove = SNAP_STILL_CSS * invScale;
    if (dx * dx + dy * dy < minMove * minMove) return;
    const hx = x - this._snapCx, hy = y - this._snapCy;
    const minR = Math.max(ELLIPSE_MIN_CSS * invScale * 0.35, this.snap.baseR * 1.2);
    if (this._snapKind === 'circle') {
      const r = Math.max(minR, Math.hypot(hx, hy));
      this._snapRx = r; this._snapRy = r;
      this._snapDirty = true;
      return;
    }
    const u = Math.abs(hx * this._snapUx + hy * this._snapUy) / Math.max(1, this._snapRx);
    const v = Math.abs(hx * this._snapVx + hy * this._snapVy) / Math.max(1, this._snapRy);
    const scale = Math.max(0.15, Math.hypot(u, v));
    this._snapRx = Math.max(minR, this._snapRx * scale);
    this._snapRy = Math.max(minR, this._snapRy * scale);
    this._snapDirty = true;
  }

  /** @param {number} now */
  _tryActivateSnap(now) {
    if (!this._snapEligible || this._snapMode || !this.active) return false;
    if (now - this._straightStillT < SNAP_HOLD_MS) return false;
    if (this._straightLooksLinear()) {
      this._snapKind = 'line';
      this._snapMode = true;
      this._snapDirty = true;
      this.endPassNeeded = false;
      return true;
    }
    const ellipse = this._looksLikeEllipse();
    if (!ellipse) return false;
    this._snapKind = ellipse.kind;
    this._snapCx = ellipse.cx; this._snapCy = ellipse.cy;
    this._snapRx = ellipse.rx; this._snapRy = ellipse.ry; this._snapAngle = ellipse.angle;
    this._snapUx = Math.cos(ellipse.angle); this._snapUy = Math.sin(ellipse.angle);
    this._snapVx = -this._snapUy; this._snapVy = this._snapUx;
    this._snapMode = true;
    this._snapDirty = true;
    this.endPassNeeded = false;
    return true;
  }

  _straightLooksLinear() {
    const s = this.snap;
    if (!s || this._straightN < 2) return false;
    const dx = this._straightEX - this._straightSX;
    const dy = this._straightEY - this._straightSY;
    const chord = Math.hypot(dx, dy);
    const invScale = 1 / Math.max(0.001, s.speedScale);
    const minLen = Math.max(LINE_MIN_CSS * invScale, s.baseR * 1.5);
    if (chord < minLen) return false;
    const tol = Math.max(LINE_DEV_CSS * invScale, s.baseR * LINE_DEV_BRUSH);
    const maxPath = chord + Math.max(tol * 2, chord * (LINE_PATH_RATIO - 1));
    if (this._straightPath > maxPath) return false;
    const invChord = 1 / chord;
    let maxDev = 0;
    for (let i = 1; i < this._straightN - 1; i++) {
      const px = this._straightX[i] - this._straightSX;
      const py = this._straightY[i] - this._straightSY;
      const dev = Math.abs(px * dy - py * dx) * invChord;
      if (dev > maxDev) maxDev = dev;
      if (maxDev > tol) return false;
    }
    return true;
  }

  _looksLikeEllipse() {
    const s = this.snap;
    if (!s || this._straightN < 10) return null;
    const invScale = 1 / Math.max(0.001, s.speedScale);
    const closeD = Math.hypot(this._straightEX - this._straightSX, this._straightEY - this._straightSY);

    let sx = 0, sy = 0;
    const n = this._straightN;
    for (let i = 0; i < n; i++) { sx += this._straightX[i]; sy += this._straightY[i]; }
    const mx = sx / n, my = sy / n;
    let cxx = 0, cxy = 0, cyy = 0;
    for (let i = 0; i < n; i++) {
      const x = this._straightX[i] - mx, y = this._straightY[i] - my;
      cxx += x * x; cxy += x * y; cyy += y * y;
    }
    const angle0 = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let ux = Math.cos(angle0), uy = Math.sin(angle0);
    let vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this._straightX[i] - mx, y = this._straightY[i] - my;
      const u = x * ux + y * uy, v = x * vx + y * vy;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    let rx = (maxU - minU) * 0.5;
    let ry = (maxV - minV) * 0.5;
    let cx = mx + ux * ((minU + maxU) * 0.5) + vx * ((minV + maxV) * 0.5);
    let cy = my + uy * ((minU + maxU) * 0.5) + vy * ((minV + maxV) * 0.5);
    let angle = angle0;
    if (ry > rx) {
      const tr = rx; rx = ry; ry = tr;
      angle += Math.PI * 0.5;
      ux = Math.cos(angle); uy = Math.sin(angle);
      vx = -uy; vy = ux;
    }

    const minR = Math.max(ELLIPSE_MIN_CSS * invScale, s.baseR * 1.4);
    if (rx < minR || ry < minR) return null;
    const ratio = ry / rx;
    if (ratio < ELLIPSE_MIN_RATIO) return null;
    const closeLimit = Math.max(ELLIPSE_CLOSE_CSS * invScale, ry * 0.65, rx * 0.18);
    if (closeD > closeLimit) return null;

    let errSum = 0, errMax = 0, sweep = 0, prevA = 0;
    for (let i = 0; i < n; i++) {
      const x = this._straightX[i] - cx, y = this._straightY[i] - cy;
      const u = x * ux + y * uy, v = x * vx + y * vy;
      const rr = Math.sqrt((u / rx) * (u / rx) + (v / ry) * (v / ry));
      const err = Math.abs(rr - 1);
      errSum += err;
      if (err > errMax) errMax = err;
      const a = Math.atan2(v / ry, u / rx);
      if (i > 0) {
        let d = a - prevA;
        if (d > Math.PI || d < -Math.PI) d -= Math.round(d / TWO_PI_STROKE) * TWO_PI_STROKE;
        sweep += Math.abs(d);
      }
      prevA = a;
    }
    const errMean = errSum / n;
    if (sweep < ELLIPSE_MIN_SWEEP || errMean > ELLIPSE_RADIAL_ERR || errMax > ELLIPSE_MAX_ERR) return null;
    const h = Math.pow(rx - ry, 2) / Math.pow(rx + ry, 2);
    const circumference = Math.PI * (rx + ry) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
    if (this._straightPath < circumference * 0.45 || this._straightPath > circumference * 1.9) return null;

    if (ratio >= CIRCLE_RATIO) {
      const r = (rx + ry) * 0.5;
      return { kind: 'circle', cx, cy, rx: r, ry: r, angle: 0 };
    }
    return { kind: 'ellipse', cx, cy, rx, ry, angle };
  }

  // ---- misura della velocità agli estremi ----

  /** @param {number} x @param {number} y @param {number} t */
  _trPush(x, y, t) {
    const i = this._trN % this._trX.length;
    this._trX[i] = x; this._trY[i] = y; this._trT[i] = t;
    this._trN++;
  }

  // Velocità di fine: media sugli ultimi punti del ring entro SW_MS/SW_PTS.
  // Il primo punto FUORI dalla finestra (appena oltre) entra come confine.
  /** @param {number} tEnd @returns {number} px documento/ms */
  _endSpeed(tEnd) {
    const cap = this._trX.length, total = this._trN;
    const n = Math.min(total, cap);
    if (n < 2) return 0;
    /** @type {(k: number) => number} */
    const at = (k) => ((k % cap) + cap) % cap;
    const last = total - 1;
    let i = last - 1;
    while (i > total - n && tEnd - this._trT[at(i)] < SW_MS && last - i < SW_PTS) i--;
    let dist = 0;
    for (let k = i; k < last; k++) {
      dist += Math.hypot(this._trX[at(k + 1)] - this._trX[at(k)],
        this._trY[at(k + 1)] - this._trY[at(k)]);
    }
    const dt = this._trT[at(last)] - this._trT[at(i)];
    return dt > 0 ? dist / dt : 0;
  }

  // ---- pass finale ----

  // Secondo pass al pen-up (il chiamante ha appena svuotato i chunk della
  // punta, o tutto il buffer se _full): ri-emette il registro applicando i
  // coni esatti. Stesso seed del pass live: jitter e scatter identici dove
  // le punte non toccano. In via discreta la punta viene RICAMPIONATA: i dab
  // registrati hanno lo spacing del raggio pieno, e riusarli rimpicciolendo
  // il solo raggio li separa in una collana di cerchi — si cammina invece
  // lungo la polilinea con passo proporzionale al diametro già rastremato.
  replay() {
    const s = this.snap, r = this._rec, n = this._recN;
    this.endPassNeeded = false;
    s.rng = mulberry32(s.seed);
    this._segStarted = false;
    this._enValid = false; // l'alpha buildup riparte come al pen-down
    const burnGap = s.jSpacing > 0 && !s.continuous;
    const D = this._D, la = this._laX, lb = this._lbX;
    const th0 = this._th0, th1 = this._th1;

    if (s.continuous) {
      // catena di capsule: i nodi restano densi a qualunque raggio, bastano
      // i fattori per nodo (fuori dal clip il rasterizer scarta a costo ~0)
      let cum = 0;
      for (let i = 0; i < n; i++) {
        const o = i * REC_STRIDE;
        if (i > 0) cum += Math.hypot(r[o] - r[o - REC_STRIDE], r[o + 1] - r[o - REC_STRIDE + 1]);
        const m = this._full
          ? r[o + 3] * tipFactor(cum, la, th0) * tipFactor(D - cum, lb, th1)
          : r[o + 2] * tipFactor(D - cum, lb, th1);
        this._emitNow(r[o], r[o + 1], m);
      }
      return;
    }

    if (this._full) {
      // tratto intero ricampionato coi due coni (il registro viene
      // ridisegnato per intero: lo stream del seed può divergere)
      this._resample(1, 0, true);
      return;
    }

    // corpo: dab registrati fino al confine della punta, identici al live
    // (i burn tengono allineato lo stream del seed, la direzione registrata
    // la rotazione; la coda ricampionata può divergere senza conseguenze)
    const bodyEnd = D - lb;
    let cum = 0;
    this._dirA = r[5];
    this._emitNow(r[0], r[1], r[2]);
    if (burnGap && r[4]) s.rng();
    let i = 1;
    for (; i < n; i++) {
      const o = i * REC_STRIDE;
      const seg = Math.hypot(r[o] - r[o - REC_STRIDE], r[o + 1] - r[o - REC_STRIDE + 1]);
      if (cum + seg > bodyEnd) break;
      cum += seg;
      this._dirA = r[o + 5];
      this._emitNow(r[o], r[o + 1], r[o + 2]);
      if (burnGap && r[o + 4]) s.rng();
    }
    if (i >= n) return;
    this._resample(i, cum, false);
  }

  // Ricampiona il registro dal nodo i0 in poi applicando i coni esatti:
  // m base interpolato dai soli moltiplicatori di pressione (mP), passo
  // adattivo ∝ diametro corrente, stessa suddivisione a salto di raggio del
  // live. cum: distanza all'inizio del nodo i0-1. emitFirst: emette anche il
  // nodo i0-1 (replay dell'intero tratto; nel pass della sola punta è già
  // stato emesso dal corpo).
  /** @param {number} i0 @param {number} cum @param {boolean} emitFirst */
  _resample(i0, cum, emitFirst) {
    const s = this.snap, r = this._rec, n = this._recN;
    const D = this._D, la = this._laX, lb = this._lbX;
    const th0 = this._th0, th1 = this._th1;
    /** @type {(d: number) => number} */
    const cone = (d) => tipFactor(d, la, th0) * tipFactor(D - d, lb, th1);
    const o0 = (i0 - 1) * REC_STRIDE;
    let wx = r[o0], wy = r[o0 + 1], wm = r[o0 + 3];
    let ex = wx, ey = wy, em = wm * cone(cum); // ultima emissione
    this._dirA = r[o0 + 5]; // direzione registrata: l'unwrap riparte da lì
    /** @type {(x: number, y: number, m: number) => void} */
    const emit = (x, y, m) => {
      const dr = Math.abs(s.baseR * (m - em));
      if (dr > MAX_R_STEP_PX) {
        const dist = Math.hypot(x - ex, y - ey);
        const rSum = Math.max(0.25, s.baseR * em) + Math.max(0.25, s.baseR * m);
        if (dist < rSum * SUBDIV_OVERLAP) {
          const k = Math.min(64, Math.ceil(dr / MAX_R_STEP_PX));
          for (let j = 1; j < k; j++) {
            const f = j / k;
            this._emitNow(ex + (x - ex) * f, ey + (y - ey) * f, em + (m - em) * f);
          }
        }
      }
      this._emitNow(x, y, m);
      ex = x; ey = y; em = m;
    };
    if (emitFirst) this._emitNow(ex, ey, em);
    let gapLeft = Math.max(REPLAY_MIN_GAP_PX,
      s.spacing * 2 * Math.max(0.25, s.baseR * em));
    for (let i = i0; i < n; i++) {
      const o = i * REC_STRIDE;
      const nx = r[o], ny = r[o + 1], nm = r[o + 3];
      const seg = Math.hypot(nx - wx, ny - wy);
      if (seg > 0.0001) this._setDir(Math.atan2(ny - wy, nx - wx));
      let travelled = 0;
      while (gapLeft <= seg - travelled) {
        travelled += gapLeft;
        const f = travelled / seg;
        const mt = (wm + (nm - wm) * f) * cone(cum + travelled);
        emit(wx + (nx - wx) * f, wy + (ny - wy) * f, mt);
        gapLeft = Math.max(REPLAY_MIN_GAP_PX,
          s.spacing * 2 * Math.max(0.25, s.baseR * mt));
      }
      gapLeft -= seg - travelled;
      cum += seg;
      wx = nx; wy = ny; wm = nm;
    }
    // l'ultimo punto registrato è il vertice vero: emesso sempre, il tratto
    // finisce esattamente dove la penna si è alzata
    emit(wx, wy, wm * cone(D));
  }

  // Bbox conservativo (px documento) dei pixel che il pass finale può
  // cambiare: i dab della punta finale col loro VECCHIO ingombro — il nuovo
  // è un sottoinsieme, il cono riduce soltanto. Il chiamante svuota i soli
  // chunk intersecati e clippa il replay lì: il corpo del tratto non si
  // ridisegna mai. null = si rifà il tratto intero (drop di tutto il buffer).
  /** @returns {{x0: number, y0: number, x1: number, y1: number}|null} */
  endPassRect() {
    const s = this.snap, r = this._rec, n = this._recN;
    if (!s || n === 0 || this._full) return null;
    // ingombro massimo di un'emissione oltre il centro: nuvola scatter
    // (offset + raggio particella), jitter di posizione, bordo morbido dello
    // stamp e arrotondamenti; il riquadro di una shape ruotata arriva a r·√2
    const spreadK = (1 + 2 * s.jPos + (s.scatter ? s.partSize : 0)) *
      (s.shape ? 1.4143 : 1);
    const pad = s.jPos * s.diam + 3;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    /** @type {(x: number, y: number, m: number) => void} */
    const add = (x, y, m) => {
      const e = Math.max(0.25, s.baseR * m) * spreadK + pad;
      if (x - e < x0) x0 = x - e;
      if (y - e < y0) y0 = y - e;
      if (x + e > x1) x1 = x + e;
      if (y + e > y1) y1 = y + e;
    };
    // punta: dall'ultima emissione a ritroso finché la distanza lungo la
    // polilinea supera la punta; si include il primo nodo OLTRE il confine
    // (in via continua cambia anche la capsula a cavallo del confine)
    add(r[(n - 1) * REC_STRIDE], r[(n - 1) * REC_STRIDE + 1], r[(n - 1) * REC_STRIDE + 2]);
    let cum = 0;
    for (let i = n - 2; i >= 0; i--) {
      const o = i * REC_STRIDE;
      cum += Math.hypot(r[o + REC_STRIDE] - r[o], r[o + REC_STRIDE + 1] - r[o + 1]);
      add(r[o], r[o + 1], r[o + 2]);
      if (cum >= this._lbX) break;
    }
    return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
  }

  // ---- interni ----

  // Accoda un punto stabilizzato al ring della curva. Il segmento tra
  // terzultimo e penultimo viene emesso (suddiviso) quando arriva il punto
  // dopo: la spline ha bisogno del vicino successivo.
  /** @param {number} x @param {number} y @param {number} p */
  _pushPoint(x, y, p) {
    const q = this._cq;
    if (this._cqN > 0) {
      const last = q[this._cqN - 1];
      const dx = x - last.x, dy = y - last.y;
      if (dx * dx + dy * dy < 0.0025) { last.p = p; return; } // < 0.05 px
    }
    if (this._cqN === 4) {
      const head = q[0];
      q[0] = q[1]; q[1] = q[2]; q[2] = q[3]; q[3] = head;
      head.x = x; head.y = y; head.p = p;
      this._emitCurve(q[0], q[1], q[2], q[3]);
    } else {
      const slot = q[this._cqN++];
      slot.x = x; slot.y = y; slot.p = p;
      if (this._cqN === 3) this._emitCurve(q[0], q[0], q[1], q[2]);
      else if (this._cqN === 4) this._emitCurve(q[0], q[1], q[2], q[3]);
    }
  }

  // Fine tratto: emette il segmento finale rimasto in sospeso nel ring.
  _flushCurve() {
    const q = this._cq;
    if (this._cqN === 4) this._emitCurve(q[1], q[2], q[3], q[3]);
    else if (this._cqN === 3) this._emitCurve(q[0], q[1], q[2], q[2]);
    else if (this._cqN === 2) this._advance(q[1].x, q[1].y, q[1].p);
    this._cqN = 0;
  }

  // Emette il segmento p1->p2 della Catmull-Rom centripetale. Suddivisione
  // adattiva: si valuta la deviazione del punto medio della curva dalla
  // corda; sotto CURVE_TOL si emette la corda com'era prima (costo zero),
  // altrimenti n ~ sqrt(dev/tol) sotto-punti via _advance.
  /**
   * @param {{x: number, y: number, p: number}} p0 @param {{x: number, y: number, p: number}} p1
   * @param {{x: number, y: number, p: number}} p2 @param {{x: number, y: number, p: number}} p3
   */
  _emitCurve(p0, p1, p2, p3) {
    const cdx = p2.x - p1.x, cdy = p2.y - p1.y;
    const chord = Math.sqrt(cdx * cdx + cdy * cdy);
    if (chord < 0.05) return;
    // nodi centripetali (dist^0.5) con epsilon contro i duplicati ai bordi
    const t1 = Math.max(Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)), 1e-3);
    const t2 = t1 + Math.max(Math.sqrt(chord), 1e-3);
    const t3 = t2 + Math.max(Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)), 1e-3);
    const cm = crEval(p0, p1, p2, p3, 0, t1, t2, t3, (t1 + t2) * 0.5, this._cm);
    const sdx = cm.x - (p1.x + p2.x) * 0.5, sdy = cm.y - (p1.y + p2.y) * 0.5;
    const sag2 = sdx * sdx + sdy * sdy;
    if (sag2 <= CURVE_TOL * CURVE_TOL) {
      this._advance(p2.x, p2.y, p2.p);
      return;
    }
    const n = Math.min(32, Math.ceil(Math.sqrt(Math.sqrt(sag2) / CURVE_TOL)) + 1);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      crEval(p0, p1, p2, p3, 0, t1, t2, t3, t1 + (t2 - t1) * f, cm);
      this._advance(cm.x, cm.y, p1.p + (p2.p - p1.p) * f);
    }
    this._advance(p2.x, p2.y, p2.p);
  }

  // Aggiorna l'angolo di direzione mantenendolo CONTINUO: si somma il delta
  // più corto verso il nuovo atan2 — con la rotazione parziale l'orientamento
  // non salta quando la direzione attraversa ±π (e su una spirale lo stamp
  // continua a girare, com'è giusto).
  /** @param {number} a angolo atan2 della nuova direzione */
  _setDir(a) {
    let d = a - this._dirA;
    if (d > Math.PI || d < -Math.PI) d -= Math.round(d / TWO_PI_STROKE) * TWO_PI_STROKE;
    this._dirA += d;
  }

  /** @param {number} x @param {number} y @param {number} p */
  _advance(x, y, p) {
    const dx = x - this._lx, dy = y - this._ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.05) { this._lp = p; return; }
    this._dirX = dx / dist; this._dirY = dy / dist;
    this._setDir(Math.atan2(dy, dx));
    this._moved += dist;

    if (this.snap.continuous) {
      if (dist >= 0.25) {
        const mP = this._pressMult(p);
        this._emitLive(x, y, mP * this._fStart(this._moved), mP, false);
        this._lx = x; this._ly = y; this._lp = p;
      }
      return;
    }

    // via discreta: cammina lungo il segmento emettendo dab a passo di spacing
    let travelled = 0;
    const pa = this._lp;
    while (this._gapLeft <= dist - travelled) {
      travelled += this._gapLeft;
      const f = travelled / dist;
      const px = this._lx + dx * f, py = this._ly + dy * f;
      const mP = this._pressMult(lerp(pa, p, f));
      const m = mP * this._fStart(this._moved - dist + travelled);
      this._emitLive(px, py, m, mP, true);
      this._gapLeft = this._nextGap(Math.max(0.25, this.snap.baseR * m));
    }
    this._gapLeft -= dist - travelled;
    this._lx = x; this._ly = y; this._lp = p;
  }

  // Fattore della punta d'inizio alla distanza campionata s dal pen-down
  // (lunghezza e rapporto congelati alla chiusura della finestra di
  // velocità). La punta di fine vive nel pass di replay().
  /** @param {number} s */
  _fStart(s) {
    return tipFactor(s, this._la, this._th0);
  }

  // Moltiplicatore di pressione (reale solo dalla penna: mouse e tocco
  // arrivano a 1 da input.js — con la penna le estremità si assottigliano
  // anche per la rampa di pressione al pen-down/lift-off).
  /** @param {number} p */
  _pressMult(p) {
    return p < 1 ? Math.pow(Math.max(0.02, p), 1.5) : 1;
  }

  // ---- registro + emissione ----

  // Registra (per il pass finale) ed emette subito: il tratto live arriva
  // pieno fino alla punta finale, zero ritardo. burn: nel live questo dab è
  // seguito da un rng() di jitterSpacing (replay() deve bruciarlo per
  // restare allineato allo stream del seed). Dove la dinamica cambia il
  // raggio di più di MAX_R_STEP_PX rispetto all'emissione precedente, si
  // inseriscono dab intermedi interpolati (registrati anche loro: il replay
  // del corpo resta identico al live) — il bordo non fa gradini. La via
  // continua non ne ha bisogno (le capsule interpolano il raggio).
  /** @param {number} x @param {number} y @param {number} m @param {number} mP @param {boolean} burn */
  _emitLive(x, y, m, mP, burn) {
    if (!this.snap.continuous && this._moved >= 1 && this._lemM >= 0) {
      const s = this.snap;
      const dr = Math.abs(s.baseR * (m - this._lemM));
      if (dr > MAX_R_STEP_PX) {
        const dist = Math.hypot(x - this._lemX, y - this._lemY);
        const rSum = Math.max(0.25, s.baseR * this._lemM) + Math.max(0.25, s.baseR * m);
        if (dist < rSum * SUBDIV_OVERLAP) {
          const n = Math.min(64, Math.ceil(dr / MAX_R_STEP_PX));
          for (let k = 1; k < n; k++) {
            const f = k / n;
            this._emitRec(lerp(this._lemX, x, f), lerp(this._lemY, y, f),
              lerp(this._lemM, m, f), lerp(this._lemP, mP, f), false);
          }
        }
      }
    }
    this._emitRec(x, y, m, mP, burn);
  }

  /** @param {number} x @param {number} y @param {number} m @param {number} mP @param {boolean} burn */
  _emitRec(x, y, m, mP, burn) {
    if (this._recN < REC_MAX) {
      if (this._recN === this._recCap) {
        const nb = new Float32Array(this._recCap * 2 * REC_STRIDE);
        nb.set(this._rec);
        this._rec = nb; this._recCap *= 2;
      }
      const o = this._recN * REC_STRIDE, r = this._rec;
      r[o] = x; r[o + 1] = y; r[o + 2] = m; r[o + 3] = mP; r[o + 4] = burn ? 1 : 0;
      r[o + 5] = this._dirA;
      this._recN++;
    }
    this._lemX = x; this._lemY = y; this._lemM = m; this._lemP = mP;
    this._emitNow(x, y, m);
  }

  // Emissione vera e propria: dab (via discreta) o nodo della catena di
  // capsule (via continua; il primo nodo è un dot fermo).
  /** @param {number} x @param {number} y @param {number} m */
  _emitNow(x, y, m) {
    const s = this.snap;
    if (s.continuous) {
      const r = Math.max(0.25, s.baseR * m);
      if (this._segStarted) {
        this.q.push(T_SEG, this._fx, this._fy, this._fr, 1, x, y, r, 1, 0);
      } else {
        this.q.push(T_SEG, x, y, r, 1, x, y, r, 1, 0);
        this._segStarted = true;
      }
      this._fx = x; this._fy = y; this._fr = r;
      this.dabsEmitted++;
    } else {
      // punta vera: sotto MIN_R_PX di raggio il dab non si stampa (il clamp
      // a 0.25 px lo renderebbe un puntino visibile dove il cono è a zero)
      if (s.baseR * m < MIN_R_PX) return;
      // Buildup: i dab più fitti del passo di spacing (suddivisione, coda
      // ricampionata) accumulerebbero alpha in eccesso — esponente ∝ al
      // passo effettivo, come per alphaCompPow. Ricavato dalle POSIZIONI:
      // live e replay lo ricalcolano identico dagli stessi punti (dist≈0 =
      // ristampa del dot, alpha piena). Con jitterSpacing il passo è
      // volutamente casuale: lì non si compensa, come prima.
      let aPow = 1;
      if (s.buildup && s.jSpacing === 0 && this._enValid) {
        const d = Math.hypot(x - this._enX, y - this._enY);
        if (d >= 0.01) {
          const gNom = Math.max(0.5, s.spacing * Math.max(1, 2 * Math.max(0.25, s.baseR * m)));
          if (d < gNom) aPow = d / gNom;
        }
      }
      this._enX = x; this._enY = y; this._enValid = true;
      this._emitDab(x, y, m, aPow);
    }
  }

  /** @param {number} r */
  _nextGap(r) {
    const s = this.snap;
    let gap = Math.max(0.5, s.spacing * Math.max(1, r * 2));
    if (s.jSpacing > 0) {
      const f = 1 + (s.rng() * 2 - 1) * s.jSpacing;
      gap *= Math.max(0.1, f);
    }
    return gap;
  }

  // Emette uno stamp; con scatter ON lo stamp diventa una nuvola di partN
  // particelle (raggio = partSize del dab, offset su disco con distribuzione
  // modellata da partDev, raggio nuvola esteso da jPos — semantica mvp4).
  // Ogni particella tira i propri jitter. m: moltiplicatore di dinamica
  // (punte + pressione) già calcolato al momento del campionamento.
  // aPow: esponente di compensazione buildup (passo effettivo / nominale).
  /** @param {number} x @param {number} y @param {number} m @param {number} aPow */
  _emitDab(x, y, m, aPow) {
    const s = this.snap;
    const rng = s.rng;
    const baseR = Math.max(0.25, s.baseR * m);
    const n = s.partN;

    for (let i = 0; i < n; i++) {
      let px = x, py = y;
      let r = baseR;

      if (s.scatter) {
        // disco: angolo uniforme; il raggio segue partDev (0 = uniforme via
        // sqrt, >0 addensa al centro, <0 spinge verso il bordo)
        const ang = rng() * Math.PI * 2;
        const u = rng();
        const dev = s.partDev;
        const dT = dev > 0.0001
          ? Math.pow(u, 0.5 + dev * 3)
          : dev < -0.0001
            ? 1 - Math.pow(1 - Math.sqrt(u), 1 - dev * 3)
            : Math.sqrt(u);
        const off = dT * baseR * (1 + s.jPos * 2);
        px += Math.cos(ang) * off;
        py += Math.sin(ang) * off;
        r = Math.max(0.25, baseR * s.partSize);
      } else if (s.jPos > 0) {
        // jitter posizione: disco uniforme
        const ang = rng() * Math.PI * 2;
        const mag = rng() * s.jPos * s.diam;
        px += Math.cos(ang) * mag;
        py += Math.sin(ang) * mag;
      }

      if (s.jSize > 0) r = Math.max(0.25, r * (1 - rng() * s.jSize));

      let a = 1;
      if (s.jOp > 0) a *= 1 - rng() * s.jOp;
      if (s.buildup) {
        a *= s.opacity;
        const pow = s.alphaCompPow * aPow;
        if (pow !== 1) a = 1 - Math.pow(1 - a, pow);
      }

      let angle = s.baseAngle;
      // rotazione "segue il tratto": quota della direzione corrente (angolo
      // unwrappato — live, replay e resample lo tengono allineato)
      if (s.rotation !== 0) angle += s.rotation * this._dirA;
      if (s.jAngle > 0) angle += (rng() * 2 - 1) * Math.PI * s.jAngle;

      let cr = s.colR, cg = s.colG, cb = s.colB;
      if (!s.eraser && (s.jBright > 0 || s.jSat > 0)) {
        const v = clamp(s.hsv.v + (rng() * 2 - 1) * s.jBright, 0, 1);
        const sat = clamp(s.hsv.s + (rng() * 2 - 1) * s.jSat, 0, 1);
        const c = hsvToRgb(s.hsv.h, sat, v, s.tmpRgb);
        cr = c.r; cg = c.g; cb = c.b;
      }

      this.q.push(T_DAB, px, py, r, a, angle, cr, cg, cb, 0);
      this.dabsEmitted++;
    }
  }
}
