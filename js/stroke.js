// STROKE PIPELINE — pura matematica, nessun pixel.
// Smoother -> Sampler (accumulatore di spacing) -> BrushDynamics -> descrittori in coda.
// La coda è un ring buffer Float32 preallocato: il rasterizer la drena col suo budget.

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
 * @property {number} baseAngle
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
 * @property {number} taperStart rapporto di spessore a inizio tratto (0..1)
 * @property {number} taperEnd rapporto di spessore a fine tratto (0..1)
 * @property {number} speedRatio rapporto di spessore a velocità massima (1 = off)
 * @property {number} speedScale px mondo -> px CSS (zoom camera al pen-down)
 * @property {import('./texture.js').BrushTexture|null} tex texture/grana (null = off)
 * @property {number} texScale
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

// Sotto questa frazione di spacing, in modalità wash, l'unione dei dab tondi
// è geometricamente identica a una catena di capsule -> via continua.
const CONTINUOUS_THRESHOLD = 0.05;
// In buildup lo spacing di rasterizzazione viene clampato e l'alpha compensata
// analiticamente: stessa copertura accumulata, 30x meno lavoro nel caso 0.1%.
const MIN_BUILDUP_SPACING = 0.03;

// Dinamica alla ibis Paint. Il taper d'inizio vive in una finestra di TEMPO
// (lunghezza punta = velocità × finestra: lento = tondo, frustata = punta).
// Il taper di FINE non può essere disegnato live (la fine non è nota): il
// tratto viene disegnato a piena larghezza fino alla punta — zero ritardo —
// e ogni emissione viene registrata; al pen-up il chiamante svuota il buffer
// del tratto e replay() lo ridisegna con il cono finale, lungo
// velocità-al-rilascio × TAPER_MS (rilascio da fermo = fine tonda).
export const TAPER_MS = 60;
const SPEED_TAU = 40;    // ms, passa-basso della velocità (niente tremolio)
const SPEED_HALF = 1.0;  // px CSS/ms a cui l'effetto velocità è a metà
const REC_MAX = 1 << 21; // tetto del registro (~32MB): oltre, niente pass finale
const DOT_HOLD_MS = 180; // pressione ferma oltre questa soglia = dot deliberato

export class DabQueue {
  /** @param {number} [cap] */
  constructor(cap = 1 << 15) {
    this.cap = cap;
    this.buf = new Float32Array(cap * STRIDE);
    this.head = 0;   // indice entry di lettura
    this.tail = 0;   // indice entry di scrittura
    this.count = 0;
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
    // stato sampler
    this._lx = 0; this._ly = 0; this._lp = 0;     // ultimo punto campionato
    this._lt = 0;                                 // tempo dell'ultimo punto campionato
    this._gapLeft = 0;
    this._dirX = 1; this._dirY = 0;               // direzione corrente del tratto
    // dinamica: velocità filtrata dagli input grezzi (pre-stabilizzatore)
    this._t0 = 0;                                 // tempo pen-down
    this._vel = 0;                                // px CSS/ms, passa-basso
    this._vlx = 0; this._vly = 0; this._vlt = 0;  // ultimo input grezzo
    this._accDist = 0;                            // distanza tra eventi con dt=0
    this._moved = 0;                              // distanza campionata totale (tap detection)
    // registro delle emissioni per il pass finale: (x, y, m, burn) —
    // burn=1 se nel pass live è seguito un rng() di jitterSpacing
    this._rec = new Float32Array(1024 * 4);
    this._recCap = 1024;
    this._recN = 0;
    this._dotM = 0;                               // dot di pen-down: ultimo m stampato
    this._endLen = 0;                             // lunghezza punta finale (px documento)
    this._tapM = 0;                               // tap: m maturato al rilascio
    this.endPassNeeded = false;                   // il chiamante deve fare drop+replay
    this._segStarted = false;                     // via continua: primo nodo emesso
    this._fx = 0; this._fy = 0; this._fr = 0;     // ultimo nodo emesso
    // curva: ring degli ultimi 4 punti stabilizzati. Il segmento q1->q2 viene
    // emesso come Catmull-Rom quando arriva il punto successivo (lag di un
    // evento, ~5 ms): tra punti radi (mano veloce) niente più poligoni.
    this._cq = [{ x: 0, y: 0, p: 0, t: 0 }, { x: 0, y: 0, p: 0, t: 0 }, { x: 0, y: 0, p: 0, t: 0 }, { x: 0, y: 0, p: 0, t: 0 }];
    this._cqN = 0;
    this._cm = { x: 0, y: 0 }; // out riusato per crEval
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

    const noJitter = !brush.scatter && brush.jitterPos === 0 && brush.jitterSize === 0 &&
      brush.jitterOpacity === 0 && brush.jitterSpacing === 0 &&
      brush.jitterBright === 0 && brush.jitterSat === 0;
    // La grana ancorata al canvas modula ogni pixel allo stesso modo
    // qualunque sia il dab che lo copre: l'unione wash dei dab resta una
    // catena di capsule anche texturizzata (capsule_tex legge il fattore dai
    // tile). Solo la grana moving (che segue lo stamp) forza la via discreta.
    const continuous = !brush.buildup && noJitter && brush.roundness >= 0.999 &&
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
      baseAngle: brush.angle * Math.PI / 180,
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
      speedRatio: clamp(brush.speedThickness, 0, 1),
      speedScale,
      tex,
      texScale: clamp(brush.textureScale || 1, 0.05, 16),
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
    this._lx = x; this._ly = y; this._lp = p; this._lt = t;
    this._dirX = 1; this._dirY = 0;
    this._t0 = t;
    this._vel = 0; this._accDist = 0; this._moved = 0;
    this._vlx = x; this._vly = y; this._vlt = t;
    this._recN = 0;
    this.endPassNeeded = false;
    this._segStarted = false;
    this._cqN = 0;
    this._pushPoint(x, y, p, t); // primo nodo della curva (nessuna emissione)

    // primo dab/dot, disegnato subito (il pass finale lo ridisegnerà)
    const m = this._dynMult(t, p);
    this._dotM = m;
    this._emitLive(x, y, m, !continuous);
    if (!continuous) this._gapLeft = this._nextGap(Math.max(0.25, baseR * m));
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  move(x, y, p, t) {
    if (!this.active) return;
    const s = this.snap;
    // velocità del gesto: dagli input grezzi, filtrata passa-basso. Con eventi
    // coalesced a dt=0 la distanza si accumula fino al prossimo dt>0.
    this._accDist += Math.hypot(x - this._vlx, y - this._vly);
    this._vlx = x; this._vly = y;
    const dt = t - this._vlt;
    if (dt > 0) {
      const v = this._accDist * s.speedScale / dt;
      this._vel += (v - this._vel) * (1 - Math.exp(-dt / SPEED_TAU));
      this._vlt = t;
      this._accDist = 0;
    }
    // Smoother: il punto stabilizzato insegue il punto grezzo
    const k = lerp(1, 0.06, Math.sqrt(s.smoothing));
    this._sx += (x - this._sx) * k;
    this._sy += (y - this._sy) * k;
    this._sp += (p - this._sp) * k;
    this._pushPoint(this._sx, this._sy, this._sp, t);
  }

  // Catch-up: a fine tratto lo stabilizzatore raggiunge il punto grezzo
  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  end(x, y, p, t) {
    if (!this.active) return;
    if (this.snap.smoothing > 0) {
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        this._pushPoint(lerp(this._sx, x, f), lerp(this._sy, y, f), lerp(this._sp, p, f),
          lerp(this._vlt, t, f));
      }
    } else {
      this._pushPoint(x, y, p, t);
    }
    this._flushCurve();
    // serve il pass finale? (il chiamante fa drop del buffer + replay())
    const s = this.snap;
    if (this._moved < 1) {
      // tap / pressione ferma: dot uniforme maturato col tempo tenuto giù
      this._tapM = Math.max(0.05, this._dynMult(t, p));
      this.endPassNeeded = this._recN > 0 && this._recN < REC_MAX;
    } else {
      // Fermo prima del rilascio: i pointermove smettono di arrivare e il
      // filtro resterebbe congelato all'ultima velocità — decade per il
      // tempo di inattività (fermarsi e alzare = fine tonda, non a punta).
      const idle = t - this._vlt;
      if (idle > 0) this._vel *= Math.exp(-idle / SPEED_TAU);
      // lunghezza della punta = velocità al rilascio × finestra (px documento)
      this._endLen = this._vel / s.speedScale * TAPER_MS;
      this.endPassNeeded = s.taperEnd < 1 && this._endLen > 0.5 &&
        this._recN > 1 && this._recN < REC_MAX;
    }
    this.active = false;
  }

  // Chiamato dal frame loop: a mano ferma il dot di pen-down matura (cresce
  // fino a piena dimensione: fermo = tondo). Solo per pressioni DELIBERATE:
  // il pen-down di un tratto normale resta fermo 20-50ms prima di muoversi,
  // e senza soglia il dot semi-cresciuto restava come puntino in testa alle
  // punte sottili. Wash: ristampare a raggio crescente è un max di alpha.
  /** @param {number} now */
  tick(now) {
    if (!this.active || this._moved >= 1 || now - this._t0 < DOT_HOLD_MS) return;
    const m = this._dynMult(now, this._lp);
    if (m - this._dotM > 0.04) {
      this._dotM = m;
      this._emitLive(this._lx, this._ly, m, false);
    }
  }

  cancel() { this.active = false; this._cqN = 0; this._recN = 0; this.endPassNeeded = false; }

  // Secondo pass al pen-up (il chiamante ha appena svuotato il buffer del
  // tratto): ri-emette l'intero registro applicando il taper finale — un cono
  // spaziale dalla punta, factor = taperEnd + (1-taperEnd)·sqrt(d/L) (sqrt:
  // corpo pieno a lungo, punta corta). Stesso seed del pass live: jitter e
  // scatter identici dove il taper non tocca.
  replay() {
    const s = this.snap, r = this._rec, n = this._recN;
    this.endPassNeeded = false;
    s.rng = mulberry32(s.seed);
    this._segStarted = false;
    const burnGap = s.jSpacing > 0 && !s.continuous;
    if (this._moved < 1) {
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        this._emitNow(r[o], r[o + 1], this._tapM);
        if (burnGap && r[o + 3]) s.rng();
      }
      return;
    }
    let D = 0;
    for (let i = 1; i < n; i++) {
      D += Math.hypot(r[i * 4] - r[(i - 1) * 4], r[i * 4 + 1] - r[(i - 1) * 4 + 1]);
    }
    const L = Math.min(this._endLen, D);
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (i > 0) cum += Math.hypot(r[o] - r[o - 4], r[o + 1] - r[o - 3]);
      const d = D - cum;
      let m = r[o + 2];
      if (d < L) m *= s.taperEnd + (1 - s.taperEnd) * Math.sqrt(d / L);
      this._emitNow(r[o], r[o + 1], m);
      if (burnGap && r[o + 3]) s.rng();
    }
  }

  // ---- interni ----

  // Accoda un punto stabilizzato al ring della curva. Il segmento tra
  // terzultimo e penultimo viene emesso (suddiviso) quando arriva il punto
  // dopo: la spline ha bisogno del vicino successivo.
  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _pushPoint(x, y, p, t) {
    const q = this._cq;
    if (this._cqN > 0) {
      const last = q[this._cqN - 1];
      const dx = x - last.x, dy = y - last.y;
      if (dx * dx + dy * dy < 0.0025) { last.p = p; last.t = t; return; } // < 0.05 px
    }
    if (this._cqN === 4) {
      const head = q[0];
      q[0] = q[1]; q[1] = q[2]; q[2] = q[3]; q[3] = head;
      head.x = x; head.y = y; head.p = p; head.t = t;
      this._emitCurve(q[0], q[1], q[2], q[3]);
    } else {
      const slot = q[this._cqN++];
      slot.x = x; slot.y = y; slot.p = p; slot.t = t;
      if (this._cqN === 3) this._emitCurve(q[0], q[0], q[1], q[2]);
      else if (this._cqN === 4) this._emitCurve(q[0], q[1], q[2], q[3]);
    }
  }

  // Fine tratto: emette il segmento finale rimasto in sospeso nel ring.
  _flushCurve() {
    const q = this._cq;
    if (this._cqN === 4) this._emitCurve(q[1], q[2], q[3], q[3]);
    else if (this._cqN === 3) this._emitCurve(q[0], q[1], q[2], q[2]);
    else if (this._cqN === 2) this._advance(q[1].x, q[1].y, q[1].p, q[1].t);
    this._cqN = 0;
  }

  // Emette il segmento p1->p2 della Catmull-Rom centripetale. Suddivisione
  // adattiva: si valuta la deviazione del punto medio della curva dalla
  // corda; sotto CURVE_TOL si emette la corda com'era prima (costo zero),
  // altrimenti n ~ sqrt(dev/tol) sotto-punti via _advance.
  /**
   * @param {{x: number, y: number, p: number, t: number}} p0 @param {{x: number, y: number, p: number, t: number}} p1
   * @param {{x: number, y: number, p: number, t: number}} p2 @param {{x: number, y: number, p: number, t: number}} p3
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
      this._advance(p2.x, p2.y, p2.p, p2.t);
      return;
    }
    const n = Math.min(32, Math.ceil(Math.sqrt(Math.sqrt(sag2) / CURVE_TOL)) + 1);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      crEval(p0, p1, p2, p3, 0, t1, t2, t3, t1 + (t2 - t1) * f, cm);
      this._advance(cm.x, cm.y, p1.p + (p2.p - p1.p) * f, p1.t + (p2.t - p1.t) * f);
    }
    this._advance(p2.x, p2.y, p2.p, p2.t);
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _advance(x, y, p, t) {
    const dx = x - this._lx, dy = y - this._ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.05) { this._lp = p; this._lt = t; return; }
    this._dirX = dx / dist; this._dirY = dy / dist;
    this._moved += dist;

    if (this.snap.continuous) {
      if (dist >= 0.25) {
        this._emitLive(x, y, this._dynMult(t, p), false);
        this._lx = x; this._ly = y; this._lp = p; this._lt = t;
      }
      return;
    }

    // via discreta: cammina lungo il segmento emettendo dab a passo di spacing
    let travelled = 0;
    const ta = this._lt, pa = this._lp;
    while (this._gapLeft <= dist - travelled) {
      travelled += this._gapLeft;
      const f = travelled / dist;
      const px = this._lx + dx * f, py = this._ly + dy * f;
      const m = this._dynMult(lerp(ta, t, f), lerp(pa, p, f));
      this._emitLive(px, py, m, true);
      this._gapLeft = this._nextGap(Math.max(0.25, this.snap.baseR * m));
    }
    this._gapLeft -= dist - travelled;
    this._lx = x; this._ly = y; this._lp = p; this._lt = t;
  }

  // Moltiplicatore di spessore: taper d'inizio (finestra temporale da t0,
  // smoothstep) × velocità (più veloce = più sottile, risposta iperbolica
  // saturante) × pressione (reale solo dalla penna: mouse/tocco arrivano a 1
  // da input.js — con la penna le punte nascono già dalla rampa di pressione
  // al pen-down/lift-off). Il taper di fine vive nel pass di replay().
  /** @param {number} ts @param {number} p */
  _dynMult(ts, p) {
    const s = this.snap;
    let f = 1;
    if (s.taperStart < 1) {
      let u = (ts - this._t0) / TAPER_MS;
      if (u < 1) {
        if (u < 0) u = 0;
        u = u * u * (3 - 2 * u);
        f = s.taperStart + (1 - s.taperStart) * u;
      }
    }
    if (s.speedRatio < 1) {
      const vn = this._vel / (this._vel + SPEED_HALF);
      f *= 1 - (1 - s.speedRatio) * vn;
    }
    if (p < 1) f *= Math.pow(Math.max(0.02, p), 1.5);
    return f;
  }

  // ---- registro + emissione ----

  // Registra (per il pass finale) ed emette subito: il tratto live arriva
  // pieno fino alla punta, zero ritardo. burn: nel live questo dab è seguito
  // da un rng() di jitterSpacing (replay() deve bruciarlo per restare
  // allineato allo stream del seed).
  /** @param {number} x @param {number} y @param {number} m @param {boolean} burn */
  _emitLive(x, y, m, burn) {
    if (this._recN < REC_MAX) {
      if (this._recN === this._recCap) {
        const nb = new Float32Array(this._recCap * 2 * 4);
        nb.set(this._rec);
        this._rec = nb; this._recCap *= 2;
      }
      const o = this._recN * 4, r = this._rec;
      r[o] = x; r[o + 1] = y; r[o + 2] = m; r[o + 3] = burn ? 1 : 0;
      this._recN++;
    }
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
      this._emitDab(x, y, m);
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
  // (taper + velocità) già calcolato al momento del campionamento.
  /** @param {number} x @param {number} y @param {number} m */
  _emitDab(x, y, m) {
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
        if (s.alphaCompPow !== 1) a = 1 - Math.pow(1 - a, s.alphaCompPow);
      }

      let angle = s.baseAngle;
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
