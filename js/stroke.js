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

// Salto massimo di raggio tra due emissioni consecutive: oltre, si inseriscono
// dab intermedi interpolati — i gradini del bordo restano sub-pixel dovunque
// il raggio cambia (pressione). Lo spacing dell'utente resta il ritmo base:
// a raggio costante non si aggiunge nulla.
const MAX_R_STEP_PX = 0.5;
// ...ma SOLO dove gli stamp consecutivi si sovrappongono (il tratto è un
// nastro continuo, la smerlatura si vede). Se il passo supera questa frazione
// della somma dei raggi, i tondi sono separati di proposito (spacing alto):
// la pressione deve scalarli, non fonderli con un ponte di dab intermedi.
const SUBDIV_OVERLAP = 0.75;

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
    this._gapLeft = 0;
    this._dirX = 1; this._dirY = 0;               // direzione corrente del tratto
    this._moved = 0;                              // distanza campionata totale
    this._lemX = 0; this._lemY = 0; this._lemM = -1; // ultima emissione live (per la suddivisione; -1 = nessuna)
    this._enX = 0; this._enY = 0; this._enValid = false; // ultima emissione discreta (per l'alpha buildup)
    this._segStarted = false;                     // via continua: primo nodo emesso
    this._fx = 0; this._fy = 0; this._fr = 0;     // ultimo nodo emesso
    // curva: ring degli ultimi 4 punti stabilizzati. Il segmento q1->q2 viene
    // emesso come Catmull-Rom quando arriva il punto successivo (lag di un
    // evento, ~5 ms): tra punti radi (mano veloce) niente più poligoni.
    this._cq = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }];
    this._cqN = 0;
    this._cm = { x: 0, y: 0 }; // out riusato per crEval
  }

  // Fotografa il pennello: lo stroke è deterministico e indipendente
  // da cambi di impostazioni a metà tratto. seed: rng fisso (preview del
  // pennello — scatter/jitter identici a ogni re-render, niente sfarfallio).
  /**
   * @param {number} x @param {number} y @param {number} p
   * @param {Brush} brush @param {number} [seed]
   */
  begin(x, y, p, brush, seed) {
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
    this._lx = x; this._ly = y; this._lp = p;
    this._dirX = 1; this._dirY = 0;
    this._moved = 0;
    this._lemM = -1;
    this._enValid = false;
    this._segStarted = false;
    this._cqN = 0;
    this._pushPoint(x, y, p); // primo nodo della curva (nessuna emissione)

    // primo dab/dot, disegnato subito
    const m = this._pressMult(p);
    this._emitLive(x, y, m);
    if (!continuous) this._gapLeft = this._nextGap(Math.max(0.25, baseR * m));
  }

  /** @param {number} x @param {number} y @param {number} p */
  move(x, y, p) {
    if (!this.active) return;
    // Smoother: il punto stabilizzato insegue il punto grezzo
    const k = lerp(1, 0.06, Math.sqrt(this.snap.smoothing));
    this._sx += (x - this._sx) * k;
    this._sy += (y - this._sy) * k;
    this._sp += (p - this._sp) * k;
    this._pushPoint(this._sx, this._sy, this._sp);
  }

  // Catch-up: a fine tratto lo stabilizzatore raggiunge il punto grezzo
  /** @param {number} x @param {number} y @param {number} p */
  end(x, y, p) {
    if (!this.active) return;
    if (this.snap.smoothing > 0) {
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        this._pushPoint(lerp(this._sx, x, f), lerp(this._sy, y, f), lerp(this._sp, p, f));
      }
    } else {
      this._pushPoint(x, y, p);
    }
    this._flushCurve();
    this.active = false;
  }

  cancel() { this.active = false; this._cqN = 0; }

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

  /** @param {number} x @param {number} y @param {number} p */
  _advance(x, y, p) {
    const dx = x - this._lx, dy = y - this._ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.05) { this._lp = p; return; }
    this._dirX = dx / dist; this._dirY = dy / dist;
    this._moved += dist;

    if (this.snap.continuous) {
      if (dist >= 0.25) {
        this._emitLive(x, y, this._pressMult(p));
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
      const m = this._pressMult(lerp(pa, p, f));
      this._emitLive(px, py, m);
      this._gapLeft = this._nextGap(Math.max(0.25, this.snap.baseR * m));
    }
    this._gapLeft -= dist - travelled;
    this._lx = x; this._ly = y; this._lp = p;
  }

  // Moltiplicatore di spessore: pressione (reale solo dalla penna: mouse e
  // tocco arrivano a 1 da input.js — con la penna le punte nascono dalla
  // rampa di pressione al pen-down/lift-off).
  /** @param {number} p */
  _pressMult(p) {
    return p < 1 ? Math.pow(Math.max(0.02, p), 1.5) : 1;
  }

  // ---- emissione ----

  // Emette subito. Dove la pressione cambia il raggio di più di
  // MAX_R_STEP_PX rispetto all'emissione precedente, si inseriscono dab
  // intermedi interpolati — il bordo non fa gradini. La via continua non ne
  // ha bisogno (le capsule interpolano il raggio), il dot fermo nemmeno
  // (ristampa sul posto).
  /** @param {number} x @param {number} y @param {number} m */
  _emitLive(x, y, m) {
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
            this._emitNow(lerp(this._lemX, x, f), lerp(this._lemY, y, f),
              lerp(this._lemM, m, f));
          }
        }
      }
    }
    this._lemX = x; this._lemY = y; this._lemM = m;
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
      // Buildup: i dab più fitti del passo di spacing (suddivisione)
      // accumulerebbero alpha in eccesso — esponente ∝ al passo effettivo,
      // come per alphaCompPow. Ricavato dalle POSIZIONI (dist≈0 = ristampa
      // del dot, alpha piena). Con jitterSpacing il passo è volutamente
      // casuale: lì non si compensa, come prima.
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
  // Ogni particella tira i propri jitter. m: moltiplicatore di pressione
  // già calcolato al momento del campionamento.
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
