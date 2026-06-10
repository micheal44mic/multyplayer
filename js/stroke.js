// STROKE PIPELINE — pura matematica, nessun pixel.
// Smoother -> Sampler (accumulatore di spacing) -> BrushDynamics -> descrittori in coda.
// La coda è un ring buffer Float32 preallocato: il rasterizer la drena col suo budget.

import { clamp, lerp, rgbToHsv, hsvToRgb, mulberry32 } from './util.js';

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

export class StrokeEngine {
  constructor(queue) {
    this.q = queue;
    this.active = false;
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
  }

  // Fotografa il pennello: lo stroke è deterministico e indipendente
  // da cambi di impostazioni a metà tratto.
  begin(x, y, p, brush) {
    const baseR = Math.max(0.5, brush.size * 0.5);
    const eraser = brush.tool === 'eraser';
    const hsv = rgbToHsv(brush.color.r, brush.color.g, brush.color.b, { h: 0, s: 0, v: 0 });

    const noJitter = brush.scatter === 0 && brush.jitterPos === 0 && brush.jitterSize === 0 &&
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

  move(x, y, p) {
    if (!this.active) return;
    const s = this.snap;
    // Smoother: il punto stabilizzato insegue il punto grezzo
    const k = lerp(1, 0.06, Math.sqrt(s.smoothing));
    this._sx += (x - this._sx) * k;
    this._sy += (y - this._sy) * k;
    this._sp += (p - this._sp) * k;
    this._advance(this._sx, this._sy, this._sp);
  }

  // Catch-up: a fine tratto lo stabilizzatore raggiunge il punto grezzo
  end(x, y, p) {
    if (!this.active) return;
    if (this.snap.smoothing > 0) {
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this._advance(lerp(this._sx, x, t), lerp(this._sy, y, t), lerp(this._sp, p, t));
      }
    } else {
      this._advance(x, y, p);
    }
    this.active = false;
  }

  cancel() { this.active = false; }

  // ---- interni ----

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

  _radius(p) {
    const s = this.snap;
    return Math.max(0.25, s.baseR * (s.pressureSize ? Math.pow(Math.max(0.02, p), 1.5) : 1));
  }

  _alphaDyn(p) {
    const s = this.snap;
    return s.pressureOpacity ? Math.pow(clamp(p, 0, 1), 1.2) : 1;
  }

  _nextGap(r) {
    const s = this.snap;
    let gap = Math.max(0.5, s.spacing * Math.max(1, r * 2));
    if (s.jSpacing > 0) {
      const f = 1 + (s.rng() * 2 - 1) * s.jSpacing;
      gap *= Math.max(0.1, f);
    }
    return gap;
  }

  _emitDab(x, y, p) {
    const s = this.snap;
    const rng = s.rng;

    let r = this._radius(p);
    if (s.jSize > 0) r = Math.max(0.25, r * (1 - rng() * s.jSize));

    let a = this._alphaDyn(p);
    if (s.jOp > 0) a *= 1 - rng() * s.jOp;
    if (s.buildup) {
      a *= s.opacity;
      if (s.alphaCompPow !== 1) a = 1 - Math.pow(1 - a, s.alphaCompPow);
    }

    // scatter: perpendicolare alla direzione del tratto
    if (s.scatter > 0) {
      const off = (rng() * 2 - 1) * s.scatter * s.diam;
      x += -this._dirY * off;
      y += this._dirX * off;
    }
    // jitter posizione: disco uniforme
    if (s.jPos > 0) {
      const ang = rng() * Math.PI * 2;
      const mag = rng() * s.jPos * s.diam;
      x += Math.cos(ang) * mag;
      y += Math.sin(ang) * mag;
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

    this.q.push(T_DAB, x, y, r, a, angle, cr, cg, cb, 0);
    this.dabsEmitted++;
    return r;
  }
}
