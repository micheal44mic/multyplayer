// STROKE PIPELINE — pura matematica, nessun pixel.
// Smoother -> Sampler (accumulatore di spacing) -> BrushDynamics -> descrittori in coda.
// La coda è un ring buffer Float32 preallocato: il rasterizer la drena col suo budget.

import { clamp, lerp, rgbToHsv, hsvToRgb, mulberry32 } from './util.js';

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
 * @property {boolean} pressureSize
 * @property {boolean} pressureOpacity
 * @property {number} colR
 * @property {number} colG
 * @property {number} colB
 * @property {import('./util.js').Hsv} hsv
 * @property {boolean} eraser
 * @property {boolean} continuous
 * @property {number} globalOpacity
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
    // ultimo punto emesso (via continua)
    this._ex = 0; this._ey = 0; this._er = 0; this._ea = 0;
    this._dirX = 1; this._dirY = 0;               // direzione corrente del tratto
    // curva: ring degli ultimi 4 punti stabilizzati. Il segmento q1->q2 viene
    // emesso come Catmull-Rom quando arriva il punto successivo (lag di un
    // evento, ~5 ms): tra punti radi (mano veloce) niente più poligoni.
    this._cq = [{ x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }, { x: 0, y: 0, p: 0 }];
    this._cqN = 0;
    this._cm = { x: 0, y: 0 }; // out riusato per crEval
  }

  // Fotografa il pennello: lo stroke è deterministico e indipendente
  // da cambi di impostazioni a metà tratto.
  /** @param {number} x @param {number} y @param {number} p @param {Brush} brush */
  begin(x, y, p, brush) {
    const baseR = Math.max(0.5, brush.size * 0.5);
    const eraser = brush.tool === 'eraser';
    const hsv = rgbToHsv(brush.color.r, brush.color.g, brush.color.b, { h: 0, s: 0, v: 0 });

    const noJitter = !brush.scatter && brush.jitterPos === 0 && brush.jitterSize === 0 &&
      brush.jitterOpacity === 0 && brush.jitterSpacing === 0 &&
      brush.jitterBright === 0 && brush.jitterSat === 0;
    const continuous = !brush.buildup && noJitter && brush.roundness >= 0.999 &&
      brush.spacing < CONTINUOUS_THRESHOLD;

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
      pressureSize: brush.pressureSize,
      pressureOpacity: brush.pressureOpacity,
      colR: eraser ? 255 : brush.color.r,
      colG: eraser ? 255 : brush.color.g,
      colB: eraser ? 255 : brush.color.b,
      hsv,
      eraser,
      continuous,
      // opacità globale applicata al composito (e allo shader live):
      // wash -> slider; buildup -> 1 (l'accumulo è già nei dab)
      globalOpacity: brush.buildup ? 1 : brush.opacity,
      rng: mulberry32((strokeSeed = (strokeSeed * 1103515245 + 12345) >>> 0)),
      tmpRgb: { r: 0, g: 0, b: 0 },
    };

    this.active = true;
    this.dabsEmitted = 0;
    this._sx = x; this._sy = y; this._sp = p;
    this._lx = x; this._ly = y; this._lp = p;
    this._dirX = 1; this._dirY = 0;
    this._cqN = 0;
    this._pushPoint(x, y, p); // primo nodo della curva (nessuna emissione)

    if (continuous) {
      const r = this._radius(p);
      const a = this._alphaDyn(p);
      this._ex = x; this._ey = y; this._er = r; this._ea = a;
      // punto fermo = un dot
      this.q.push(T_SEG, x, y, r, a, x, y, r, a, 0);
    } else {
      this._emitDab(x, y, p);
      this._gapLeft = this._nextGap(this._radius(p));
    }
  }

  /** @param {number} x @param {number} y @param {number} p */
  move(x, y, p) {
    if (!this.active) return;
    const s = this.snap;
    // Smoother: il punto stabilizzato insegue il punto grezzo
    const k = lerp(1, 0.06, Math.sqrt(s.smoothing));
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
        const t = i / steps;
        this._pushPoint(lerp(this._sx, x, t), lerp(this._sy, y, t), lerp(this._sp, p, t));
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

    if (this.snap.continuous) {
      if (dist >= 0.25) {
        const r = this._radius(p);
        const a = this._alphaDyn(p);
        this.q.push(T_SEG, this._ex, this._ey, this._er, this._ea, x, y, r, a, 0);
        this._ex = x; this._ey = y; this._er = r; this._ea = a;
        this._lx = x; this._ly = y; this._lp = p;
        this.dabsEmitted++;
      }
      return;
    }

    // via discreta: cammina lungo il segmento emettendo dab a passo di spacing
    let travelled = 0;
    const p0 = this._lp;
    while (this._gapLeft <= dist - travelled) {
      travelled += this._gapLeft;
      const t = travelled / dist;
      const px = this._lx + dx * t, py = this._ly + dy * t;
      const pp = lerp(p0, p, t);
      const r = this._emitDab(px, py, pp);
      this._gapLeft = this._nextGap(r);
    }
    this._gapLeft -= dist - travelled;
    this._lx = x; this._ly = y; this._lp = p;
  }

  /** @param {number} p */
  _radius(p) {
    const s = this.snap;
    return Math.max(0.25, s.baseR * (s.pressureSize ? Math.pow(Math.max(0.02, p), 1.5) : 1));
  }

  /** @param {number} p */
  _alphaDyn(p) {
    const s = this.snap;
    return s.pressureOpacity ? Math.pow(clamp(p, 0, 1), 1.2) : 1;
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
  // Ogni particella tira i propri jitter. Ritorna il raggio base del dab
  // (per il passo di spacing).
  /** @param {number} x @param {number} y @param {number} p */
  _emitDab(x, y, p) {
    const s = this.snap;
    const rng = s.rng;
    const baseR = this._radius(p);
    const aDyn = this._alphaDyn(p);
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

      let a = aDyn;
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
    return baseR;
  }
}
