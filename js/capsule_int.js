// CAPSULE v2 A INTERI — lo spec del falloff continuo portabile su GPU
// (fase 1 del piano WebGPU, docs/webgpu-engine-plan.md).
//
// La capsule v1 (raster.js/_capsule + brush.falloff) calcola il per-pixel in
// f64: bit-exact tra JS e wasm, ma NON riproducibile su GPU (niente f64, f32
// non deterministico tra vendor). Questo modulo definisce la formulazione v2
// in SOLI INTERI, così che JS e WGSL producano gli stessi byte per
// costruzione. v2 non è byte-identica a v1 (quantizzazione ~1/16 px nella
// banda AA): la fedeltà si misura nel test differenziale; l'atterraggio nel
// motore vero (raster.js + wasm in lockstep) è un passo successivo.
//
// SPEC v2 (tutte le operazioni su interi, definite senza ambiguità):
//   - coordinate/raggi in fixed-point 1/32 px (FP=32); pixel center = ·32+16
//   - i segmenti si spezzano su CPU a tratte ≤128 px (l'unione wash di
//     sotto-capsule con taper lineare È la capsula intera — stessa identità
//     della catena di capsule del motore)
//   - t di proiezione: num = clamp((p-a)·d, 0, den), den = |d|²,
//     t_q = floor((num·65536 + (den>>1))/den)  [ARROTONDATO; den=0 → t_q=0]
//   - proiezione: proj = a + (d·t_q >> 16)   (shift ARITMETICO su i32)
//   - dist: D = round(sqrt(qx²+qy²)) intero esatto (floor + correzione
//     d2 > D²+D → D+1; mai tie: D²+D+0.25 non è intero)
//   - raggio/alpha al punto: rT = R0 + ((DR·t_q) >> 16)   [i32, aritmetico]
//                            aT = A0 + ((DA·(t_q>>4)) >> 12)  [A in 255·256]
//   - skip se d2 ≥ (rT+32)² (il +1 px della v1) o rT+32 ≤ 0
//   - falloff: core = (rT·Hq) >> 12 (Hq = round(h·4096)),
//     w = max(32, rT-core), u = floor(((D-core)·1024 + (w>>1))/w) clamp 1024,
//     m = FALLOFF_LUT[u]  (LUT 1025 voci: round((1-smoothstep(u/1024))·32768))
//   - ma = (m·aT + (1<<22)) >> 23   → 0..255
//   - blend wash col tie-break della capsule: scrive solo se ma > dst.a,
//     colore premultiplied div255(c·ma) (identico a v1)
// Tutti gli intermedi stanno in i32/u32 (budget: split 128px → dx ≤ 2^12,
// den ≤ 2^25, num ≤ 2^28, d²/lim² ≤ 2^31 in u32, D ≤ 46341 → D²+D < 2^31);
// le uniche operazioni "larghe" — la divisione di t e la radice — hanno UN
// solo risultato matematico: JS le fa in f64 esatto (<2^53) con correzione,
// il WGSL con divisione software a limbs e sqrt f32 corretta, stessi bit.

export const CAP_STRIDE_I32 = 10; // X0,Y0,DX,DY,den,R0,DR,A0,DA,pad
export const CAP_FP = 32;         // unità fixed-point per pixel
const FP = CAP_FP;
const SPLIT_PX = 128;             // lunghezza massima di una tratta

/** Durezza quantizzata dello spec (scala 4096). @param {number} h */
export function quantHardness(h) { return Math.round(h * 4096); }

// LUT dello smoothstep discendente, 1025 voci a scala 32768. Unica fonte
// per JS e GPU (si carica com'è in uno storage buffer).
export const FALLOFF_LUT = (() => {
  const lut = new Uint16Array(1025);
  for (let i = 0; i <= 1024; i++) {
    const x = i / 1024;
    const s = x * x * (3 - 2 * x);
    lut[i] = Math.round((1 - s) * 32768);
  }
  return lut;
})();

/** floor esatto di (num·65536 + den/2)/den — t arrotondato (num,den ≥ 0).
 * @param {number} num @param {number} den */
function divT(num, den) {
  const wide = num * 65536 + (den >> 1); // ≤ 2^42: esatto in f64
  let q = Math.floor(wide / den);
  while ((q + 1) * den <= wide) q++;
  while (q * den > wide) q--;
  return q;
}

/** round esatto di sqrt(n), n ≥ 0 intero < 2^31 (mai tie). @param {number} n */
function isqrtRound(n) {
  let s = Math.floor(Math.sqrt(n));
  while ((s + 1) * (s + 1) <= n) s++;
  while (s * s > n) s--;
  if (n > s * s + s) s++;
  return s;
}

/**
 * Quantizza una capsula (coordinate documento f32/f64) nei record integer
 * dello spec, spezzando a tratte ≤256 px. Da chiamare su CPU: qui vive
 * l'ULTIMO float del path.
 * @param {number} x0 @param {number} y0 @param {number} r0 @param {number} a0
 * @param {number} x1 @param {number} y1 @param {number} r1 @param {number} a1
 * @param {number[]} out array piatto dove accodare i record (CAP_STRIDE_I32)
 */
export function capsuleIntParams(x0, y0, r0, a0, x1, y1, r1, a1, out) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / SPLIT_PX));
  for (let i = 0; i < n; i++) {
    const f0 = i / n, f1 = (i + 1) / n;
    const sx0 = x0 + (x1 - x0) * f0, sy0 = y0 + (y1 - y0) * f0;
    const sx1 = x0 + (x1 - x0) * f1, sy1 = y0 + (y1 - y0) * f1;
    const X0 = Math.round(sx0 * FP), Y0 = Math.round(sy0 * FP);
    const X1 = Math.round(sx1 * FP), Y1 = Math.round(sy1 * FP);
    const DX = X1 - X0, DY = Y1 - Y0;
    out.push(
      X0, Y0, DX, DY, DX * DX + DY * DY,
      Math.round((r0 + (r1 - r0) * f0) * FP),
      Math.round((r1 - r0) * (f1 - f0) * FP),
      Math.round((a0 + (a1 - a0) * f0) * 65280),
      Math.round((a1 - a0) * (f1 - f0) * 65280),
      0);
  }
}

/**
 * ma (0..255) della capsula v2 al pixel documento (ix,iy) — il cuore dello
 * spec, speculare riga per riga al kernel WGSL.
 * @param {Int32Array|number[]} seg record a offset o (CAP_STRIDE_I32)
 * @param {number} o @param {number} ix @param {number} iy @param {number} hq
 */
export function capsuleIntMa(seg, o, ix, iy, hq) {
  const px = ix * FP + (FP >> 1), py = iy * FP + (FP >> 1);
  const rx = px - seg[o], ry = py - seg[o + 1];
  const dx = seg[o + 2], dy = seg[o + 3], den = seg[o + 4];
  let num = rx * dx + ry * dy;
  let tq;
  if (den === 0 || num <= 0) tq = 0;
  else if (num >= den) tq = 65536;
  else tq = divT(num, den);
  const qx = rx - ((dx * tq) >> 16);
  const qy = ry - ((dy * tq) >> 16);
  const rT = seg[o + 5] + ((seg[o + 6] * tq) >> 16);
  const lim = rT + FP;
  if (lim <= 0) return 0;
  const d2 = qx * qx + qy * qy;
  if (d2 >= lim * lim) return 0;
  const aT = seg[o + 7] + ((seg[o + 8] * (tq >> 4)) >> 12);
  if (aT <= 0) return 0;
  const core = (rT * hq) >> 12;
  let w = rT - core;
  if (w < FP) w = FP;
  const D = isqrtRound(d2);
  let u = D <= core ? 0 : Math.floor(((D - core) * 1024 + (w >> 1)) / w);
  if (u >= 1024) return 0;
  const m = FALLOFF_LUT[u];
  return (m * aT + (1 << 22)) >> 23;
}

/**
 * Bound esatto di riga per i loop CPU: ma(pixel) <= capsuleIntBound(rowDist)
 * per ogni pixel della riga, per monotonia del falloff intero (D >= rowDist,
 * rT <= rMax, aT <= aMax). Skip con tie `>` = output invariato.
 * @param {number} rowDist distanza riga->segmento in unità fixed (>= 0)
 * @param {number} rMax @param {number} aMax @param {number} hq
 */
export function capsuleIntBound(rowDist, rMax, aMax, hq) {
  const lim = rMax + FP;
  if (lim <= 0 || rowDist >= lim || aMax <= 0) return 0;
  const core = (rMax * hq) >> 12;
  let w = rMax - core;
  if (w < FP) w = FP;
  const u = rowDist <= core ? 0 : Math.floor(((rowDist - core) * 1024 + (w >> 1)) / w);
  if (u >= 1024) return 0;
  return (FALLOFF_LUT[u] * aMax + (1 << 22)) >> 23;
}

/**
 * Executor JS di riferimento: applica una lista di capsule v2 a una regione
 * RGBA (wash `>`, colore div255) — l'altro lato del test differenziale.
 * @param {Uint8Array} pixels regione width×height×4, origine doc (originX, originY)
 * @param {number} width @param {number} height
 * @param {number} originX @param {number} originY
 * @param {Int32Array} segs record piatti @param {number} nSegs
 * @param {number} hq @param {number} cr @param {number} cg @param {number} cb
 * @param {{x0: number, y0: number, x1: number, y1: number}} clip
 */
export function capsuleIntRun(pixels, width, height, originX, originY,
  segs, nSegs, hq, cr, cg, cb, clip) {
  const div255 = (/** @type {number} */ x) => { const t = x + 128; return (t + (t >> 8)) >> 8; };
  for (let s = 0; s < nSegs; s++) {
    const o = s * CAP_STRIDE_I32;
    // bbox della tratta in px documento (stessa forma della v1: maxR+1)
    const x0f = seg16(segs[o]), y0f = seg16(segs[o + 1]);
    const x1f = x0f + seg16(segs[o + 2]), y1f = y0f + seg16(segs[o + 3]);
    const maxR = Math.max(segs[o + 5], segs[o + 5] + segs[o + 6]) / FP + 1;
    let bx0 = Math.floor(Math.min(x0f, x1f) - maxR), by0 = Math.floor(Math.min(y0f, y1f) - maxR);
    let bx1 = Math.ceil(Math.max(x0f, x1f) + maxR), by1 = Math.ceil(Math.max(y0f, y1f) + maxR);
    bx0 = Math.max(bx0, clip.x0, originX); by0 = Math.max(by0, clip.y0, originY);
    bx1 = Math.min(bx1, clip.x1, originX + width - 1); by1 = Math.min(by1, clip.y1, originY + height - 1);
    for (let iy = by0; iy <= by1; iy++) {
      let di = ((iy - originY) * width + (bx0 - originX)) * 4;
      for (let ix = bx0; ix <= bx1; ix++, di += 4) {
        const ma = capsuleIntMa(segs, o, ix, iy, hq);
        if (ma > pixels[di + 3]) {
          pixels[di] = div255(cr * ma);
          pixels[di + 1] = div255(cg * ma);
          pixels[di + 2] = div255(cb * ma);
          pixels[di + 3] = ma;
        }
      }
    }
  }
}

/** @param {number} v */
function seg16(v) { return v / FP; }
