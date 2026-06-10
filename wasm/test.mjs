// Test differenziale del core wasm contro la matematica di js/raster.js.
// Esecuzione:  node wasm/test.mjs
// Confronta byte per byte l'output di dab/capsule/commit con un riferimento
// JS che replica i loop originali, su input casuali (seed fisso).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, '../js/raster_core.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;

const CHUNK = 256;
const CHUNK_BYTES = CHUNK * CHUNK * 4;
const div255 = (v) => ((v + 128) * 257) >> 16;

// PRNG deterministico (mulberry32, come util.js)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xfab1e);
const ri = (n) => (rng() * n) | 0;

// ---- identità div255 vettoriale: ((x+128)+((x+128)>>8))>>8 ----
for (let v = 0; v <= 65025; v++) {
  const a = v + 128;
  if (((a + (a >> 8)) >> 8) !== div255(v)) {
    console.error('div255 identity FAIL at', v);
    process.exit(1);
  }
}
console.log('ok  identità div255 (0..65025)');

// ---- memoria: chunk dst/src, maschera, tile fattori, tile RGBX ----
const base = ex.__heap_base.value;
const need = base + CHUNK_BYTES * 2 + 65536 + 65536 + CHUNK * CHUNK * 4;
const pages = Math.ceil((need - ex.memory.buffer.byteLength) / 65536);
if (pages > 0) ex.memory.grow(pages);
const PTR_DST = (base + 15) & ~15;
const PTR_SRC = PTR_DST + CHUNK_BYTES;
const PTR_MASK = PTR_SRC + CHUNK_BYTES;
const mem = () => new Uint8Array(ex.memory.buffer);

/** @param {Uint8Array} m */
function randomize(m, off, len, sparse) {
  for (let i = 0; i < len; i += 4) {
    if (sparse && rng() < 0.5) {
      m[off + i] = 0; m[off + i + 1] = 0; m[off + i + 2] = 0; m[off + i + 3] = 0;
    } else {
      // premultiplied valido: canali <= alpha
      const a = ri(256);
      m[off + i] = ri(a + 1); m[off + i + 1] = ri(a + 1); m[off + i + 2] = ri(a + 1); m[off + i + 3] = a;
    }
  }
}

// ---- riferimento JS: dab (copia di _dab in raster.js) ----
function refDab(d, lx0, ly0, lx1, ly1, mask, maskW, mcol0, mrow0, a255, cr, cg, cb, buildup) {
  let wrote = false;
  for (let y2 = ly0; y2 <= ly1; y2++) {
    let di = ((y2 << 8) + lx0) << 2;
    let mi = (mrow0 + (y2 - ly0)) * maskW + mcol0;
    for (let x2 = lx0; x2 <= lx1; x2++, di += 4, mi++) {
      const m = mask[mi];
      if (m === 0) continue;
      const ma = div255(m * a255);
      if (ma === 0) continue;
      if (buildup) {
        const inv = 255 - ma;
        d[di] = div255(cr * ma) + div255(d[di] * inv);
        d[di + 1] = div255(cg * ma) + div255(d[di + 1] * inv);
        d[di + 2] = div255(cb * ma) + div255(d[di + 2] * inv);
        d[di + 3] = ma + div255(d[di + 3] * inv);
      } else if (ma >= d[di + 3]) { // wash: a parità vince l'ultimo dab
        d[di] = div255(cr * ma);
        d[di + 1] = div255(cg * ma);
        d[di + 2] = div255(cb * ma);
        d[di + 3] = ma;
      }
      wrote = true;
    }
  }
  return wrote ? 1 : 0;
}

// ---- riferimento JS: capsule (copia di _capsule) ----
function falloff(dist, r, h) {
  const core = r * h;
  let w = r - core;
  if (w < 1) w = 1;
  let t = (dist - core) / w;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}
function refCapsule(d, lx0, ly0, lx1, ly1, ox, oy, x0, y0, r0, a0, x1, y1, r1, a1, h, cr, cg, cb) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const invLen2 = len2 > 0 ? 1 / len2 : 0;
  const dr = r1 - r0, da = a1 - a0;
  let wrote = false;
  for (let y2 = ly0; y2 <= ly1; y2++) {
    const py = oy + y2 + 0.5;
    let di = ((y2 << 8) + lx0) << 2;
    for (let x2 = lx0; x2 <= lx1; x2++, di += 4) {
      const px = ox + x2 + 0.5;
      let t = ((px - x0) * dx + (py - y0) * dy) * invLen2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = px - (x0 + dx * t);
      const qy = py - (y0 + dy * t);
      const rT = r0 + dr * t;
      const dist2 = qx * qx + qy * qy;
      const lim = rT + 1;
      if (dist2 >= lim * lim) continue;
      const a = falloff(Math.sqrt(dist2), rT, h) * (a0 + da * t);
      if (a <= 0) continue;
      const ma = (a * 255 + 0.5) | 0;
      if (ma > d[di + 3]) {
        d[di] = div255(cr * ma);
        d[di + 1] = div255(cg * ma);
        d[di + 2] = div255(cb * ma);
        d[di + 3] = ma;
        wrote = true;
      }
    }
  }
  return wrote ? 1 : 0;
}

// ---- riferimento JS: commit (copia di commitChunk, senza store) ----
function refCommit(d, s, op255, eraser) {
  for (let o = 0; o < s.length; o += 4) {
    const sa = div255(s[o + 3] * op255);
    if (sa === 0) continue;
    const inv = 255 - sa;
    if (eraser) {
      d[o] = div255(d[o] * inv);
      d[o + 1] = div255(d[o + 1] * inv);
      d[o + 2] = div255(d[o + 2] * inv);
      d[o + 3] = div255(d[o + 3] * inv);
    } else {
      d[o] = div255(s[o] * op255) + div255(d[o] * inv);
      d[o + 1] = div255(s[o + 1] * op255) + div255(d[o + 1] * inv);
      d[o + 2] = div255(s[o + 2] * op255) + div255(d[o + 2] * inv);
      d[o + 3] = sa + div255(d[o + 3] * inv);
    }
  }
}

/** @returns {string|null} */
function diff(a, b, label) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `${label}: byte ${i} (px ${i >> 2}.${i & 3}) ref=${a[i]} wasm=${b[i]}`;
  }
  return null;
}

let fails = 0;

// ---- dab: 300 casi random ----
for (let it = 0; it < 300; it++) {
  const maskW = 8 + ri(120);
  const maskH = 8 + ri(120);
  const mask = new Uint8Array(maskW * maskH);
  for (let i = 0; i < mask.length; i++) mask[i] = rng() < 0.3 ? 0 : ri(256);
  const w = 1 + ri(Math.min(maskW, 80));
  const h = 1 + ri(Math.min(maskH, 80));
  const lx0 = ri(CHUNK - w), ly0 = ri(CHUNK - h);
  const lx1 = lx0 + w - 1, ly1 = ly0 + h - 1;
  const mcol0 = ri(maskW - w + 1), mrow0 = ri(maskH - h + 1);
  const a255 = it % 7 === 0 ? 255 : ri(256);
  const cr = ri(256), cg = ri(256), cb = ri(256);
  const buildup = it & 1;

  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, true);
  const ref = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);
  m.set(mask, PTR_MASK);

  const refWrote = refDab(ref, lx0, ly0, lx1, ly1, mask, maskW, mcol0, mrow0, a255, cr, cg, cb, buildup);
  const wasmWrote = ex.dab(PTR_DST, lx0, ly0, lx1, ly1, PTR_MASK, maskW, mcol0, mrow0, a255, cr, cg, cb, buildup);

  const e = diff(ref, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `dab #${it}`);
  if (e || refWrote !== wasmWrote) {
    console.error('FAIL', e || `dab #${it}: wrote ref=${refWrote} wasm=${wasmWrote}`,
      { lx0, ly0, lx1, ly1, maskW, mcol0, mrow0, a255, cr, cg, cb, buildup });
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  dab (300 casi, wash+buildup)');

// ---- dab_tex_tile: 300 casi random ----
// Riferimento = path JS texturizzato di raster.js: m2 = div255(m*f) col
// fattore letto dal tile in spazio chunk, poi composito di dab. rgb != null:
// colori per pixel dal tile RGBX (X=255, contratto del fill in raster.js).
const PTR_TILE = PTR_MASK + 65536;
const PTR_RGBX = PTR_TILE + 65536;

function refDabTexTile(d, lx0, ly0, lx1, ly1, mask, maskW, mcol0, mrow0,
  tile, rgbx, a255, cr, cg, cb, buildup) {
  let wrote = false;
  for (let y2 = ly0; y2 <= ly1; y2++) {
    let di = ((y2 << 8) + lx0) << 2;
    let ti = (y2 << 8) + lx0;
    let mi = (mrow0 + (y2 - ly0)) * maskW + mcol0;
    for (let x2 = lx0; x2 <= lx1; x2++, di += 4, ti++, mi++) {
      const m = mask[mi];
      if (m === 0) continue;
      const m2 = div255(m * tile[ti]);
      if (m2 === 0) continue;
      const ma = div255(m2 * a255);
      if (ma === 0) continue;
      const r = rgbx ? rgbx[ti * 4] : cr;
      const g = rgbx ? rgbx[ti * 4 + 1] : cg;
      const b = rgbx ? rgbx[ti * 4 + 2] : cb;
      if (buildup) {
        const inv = 255 - ma;
        d[di] = div255(r * ma) + div255(d[di] * inv);
        d[di + 1] = div255(g * ma) + div255(d[di + 1] * inv);
        d[di + 2] = div255(b * ma) + div255(d[di + 2] * inv);
        d[di + 3] = ma + div255(d[di + 3] * inv);
      } else if (ma >= d[di + 3]) { // wash: a parità vince l'ultimo dab
        d[di] = div255(r * ma);
        d[di + 1] = div255(g * ma);
        d[di + 2] = div255(b * ma);
        d[di + 3] = ma;
      }
      wrote = true;
    }
  }
  return wrote ? 1 : 0;
}

for (let it = 0; it < 300; it++) {
  const maskW = 8 + ri(120);
  const maskH = 8 + ri(120);
  const mask = new Uint8Array(maskW * maskH);
  for (let i = 0; i < mask.length; i++) mask[i] = rng() < 0.3 ? 0 : ri(256);
  const tile = new Uint8Array(CHUNK * CHUNK);
  for (let i = 0; i < tile.length; i++) tile[i] = rng() < 0.1 ? 0 : ri(256);
  const useRgb = it % 3 === 0;
  const rgbx = useRgb ? new Uint8Array(CHUNK * CHUNK * 4) : null;
  if (rgbx) {
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      rgbx[i * 4] = ri(256); rgbx[i * 4 + 1] = ri(256); rgbx[i * 4 + 2] = ri(256);
      rgbx[i * 4 + 3] = 255; // contratto: X=255 (la lane X produce ma)
    }
  }

  const w = 1 + ri(Math.min(maskW, 80));
  const h = 1 + ri(Math.min(maskH, 80));
  const lx0 = ri(CHUNK - w), ly0 = ri(CHUNK - h);
  const lx1 = lx0 + w - 1, ly1 = ly0 + h - 1;
  const mcol0 = ri(maskW - w + 1), mrow0 = ri(maskH - h + 1);
  const a255 = it % 7 === 0 ? 255 : ri(256);
  const cr = ri(256), cg = ri(256), cb = ri(256);
  const buildup = it & 1;

  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, true);
  const ref = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);
  m.set(mask, PTR_MASK);
  m.set(tile, PTR_TILE);
  if (rgbx) m.set(rgbx, PTR_RGBX);

  const refWrote = refDabTexTile(ref, lx0, ly0, lx1, ly1, mask, maskW, mcol0, mrow0,
    tile, rgbx, a255, cr, cg, cb, buildup);
  const wasmWrote = ex.dab_tex_tile(PTR_DST, lx0, ly0, lx1, ly1, PTR_MASK, maskW, mcol0, mrow0,
    PTR_TILE, rgbx ? PTR_RGBX : 0, a255, cr, cg, cb, buildup);

  const e = diff(ref, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `dab_tex_tile #${it}`);
  if (e || refWrote !== wasmWrote) {
    console.error('FAIL', e || `dab_tex_tile #${it}: wrote ref=${refWrote} wasm=${wasmWrote}`,
      { lx0, ly0, lx1, ly1, maskW, mcol0, mrow0, a255, useRgb, buildup });
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  dab_tex_tile (300 casi, wash+buildup, colore fisso+RGBX)');

// ---- capsule: 300 casi random ----
for (let it = 0; it < 300; it++) {
  const lx0 = ri(200), ly0 = ri(200);
  const lx1 = lx0 + 1 + ri(CHUNK - lx0 - 1), ly1 = ly0 + 1 + ri(CHUNK - ly0 - 1);
  const ox = (ri(64) - 32) * 256, oy = (ri(64) - 32) * 256;
  const cx = ox + lx0 + rng() * (lx1 - lx0);
  const cy = oy + ly0 + rng() * (ly1 - ly0);
  const x0 = cx + (rng() - 0.5) * 60, y0 = cy + (rng() - 0.5) * 60;
  const x1 = x0 + (rng() - 0.5) * 30, y1 = y0 + (rng() - 0.5) * 30;
  const r0 = 0.25 + rng() * 60, r1 = 0.25 + rng() * 60;
  const a0 = rng(), a1 = rng();
  const h = rng();
  const cr = ri(256), cg = ri(256), cb = ri(256);

  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, true);
  const ref = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);

  const refWrote = refCapsule(ref, lx0, ly0, lx1, ly1, ox, oy, x0, y0, r0, a0, x1, y1, r1, a1, h, cr, cg, cb);
  const wasmWrote = ex.capsule(PTR_DST, lx0, ly0, lx1, ly1, ox, oy, x0, y0, r0, a0, x1, y1, r1, a1, h, cr, cg, cb);

  const e = diff(ref, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `capsule #${it}`);
  if (e || refWrote !== wasmWrote) {
    console.error('FAIL', e || `capsule #${it}: wrote ref=${refWrote} wasm=${wasmWrote}`);
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  capsule (300 casi)');

// ---- capsule_tex: 300 casi random ----
// Riferimento SENZA scorciatoie (niente bound di riga/pixel): verifica che
// gli skip SIMD del wasm siano esatti. ma = div255(maBase * f) col fattore
// dal tile; rgb != null: colori per pixel dal tile RGBX.
function refCapsuleTex(d, lx0, ly0, lx1, ly1, ox, oy, x0, y0, r0, a0, x1, y1, r1, a1, h,
  cr, cg, cb, tile, rgbx) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const invLen2 = len2 > 0 ? 1 / len2 : 0;
  const dr = r1 - r0, da = a1 - a0;
  let wrote = false;
  for (let y2 = ly0; y2 <= ly1; y2++) {
    const py = oy + y2 + 0.5;
    let di = ((y2 << 8) + lx0) << 2;
    let ti = (y2 << 8) + lx0;
    for (let x2 = lx0; x2 <= lx1; x2++, di += 4, ti++) {
      const px = ox + x2 + 0.5;
      let t = ((px - x0) * dx + (py - y0) * dy) * invLen2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = px - (x0 + dx * t);
      const qy = py - (y0 + dy * t);
      const rT = r0 + dr * t;
      const dist2 = qx * qx + qy * qy;
      const lim = rT + 1;
      if (dist2 >= lim * lim) continue;
      const a = falloff(Math.sqrt(dist2), rT, h) * (a0 + da * t);
      if (a <= 0) continue;
      const ma = div255(((a * 255 + 0.5) | 0) * tile[ti]);
      if (ma > d[di + 3]) {
        const r = rgbx ? rgbx[ti * 4] : cr;
        const g = rgbx ? rgbx[ti * 4 + 1] : cg;
        const b = rgbx ? rgbx[ti * 4 + 2] : cb;
        d[di] = div255(r * ma);
        d[di + 1] = div255(g * ma);
        d[di + 2] = div255(b * ma);
        d[di + 3] = ma;
        wrote = true;
      }
    }
  }
  return wrote ? 1 : 0;
}

for (let it = 0; it < 300; it++) {
  const lx0 = ri(200), ly0 = ri(200);
  const lx1 = lx0 + 1 + ri(CHUNK - lx0 - 1), ly1 = ly0 + 1 + ri(CHUNK - ly0 - 1);
  const ox = (ri(64) - 32) * 256, oy = (ri(64) - 32) * 256;
  const cx = ox + lx0 + rng() * (lx1 - lx0);
  const cy = oy + ly0 + rng() * (ly1 - ly0);
  const x0 = cx + (rng() - 0.5) * 60, y0 = cy + (rng() - 0.5) * 60;
  const x1 = x0 + (rng() - 0.5) * 30, y1 = y0 + (rng() - 0.5) * 30;
  const r0 = 0.25 + rng() * 60, r1 = 0.25 + rng() * 60;
  const a0 = rng(), a1 = rng();
  const h = rng();
  const cr = ri(256), cg = ri(256), cb = ri(256);
  const tile = new Uint8Array(CHUNK * CHUNK);
  for (let i = 0; i < tile.length; i++) tile[i] = rng() < 0.1 ? 0 : ri(256);
  const useRgb = it % 3 === 0;
  const rgbx = useRgb ? new Uint8Array(CHUNK * CHUNK * 4) : null;
  if (rgbx) {
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      rgbx[i * 4] = ri(256); rgbx[i * 4 + 1] = ri(256); rgbx[i * 4 + 2] = ri(256);
      rgbx[i * 4 + 3] = 255;
    }
  }

  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, true);
  const ref = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);
  m.set(tile, PTR_TILE);
  if (rgbx) m.set(rgbx, PTR_RGBX);

  const refWrote = refCapsuleTex(ref, lx0, ly0, lx1, ly1, ox, oy, x0, y0, r0, a0, x1, y1, r1, a1, h,
    cr, cg, cb, tile, rgbx);
  const wasmWrote = ex.capsule_tex(PTR_DST, lx0, ly0, lx1, ly1, ox, oy, x0, y0, r0, a0, x1, y1, r1, a1, h,
    cr, cg, cb, PTR_TILE, rgbx ? PTR_RGBX : 0);

  const e = diff(ref, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `capsule_tex #${it}`);
  if (e || refWrote !== wasmWrote) {
    console.error('FAIL', e || `capsule_tex #${it}: wrote ref=${refWrote} wasm=${wasmWrote}`, { useRgb });
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  capsule_tex (300 casi, colore fisso+RGBX)');

// ---- commit: 200 casi random ----
for (let it = 0; it < 200; it++) {
  const op255 = it % 3 === 0 ? 255 : 1 + ri(255);
  const eraser = it & 1;
  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, false);
  randomize(m, PTR_SRC, CHUNK_BYTES, true);
  const refD = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);
  const refS = m.slice(PTR_SRC, PTR_SRC + CHUNK_BYTES);

  refCommit(refD, refS, op255, eraser);
  ex.commit(PTR_DST, PTR_SRC, op255, eraser);

  const e = diff(refD, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `commit #${it} (op=${op255} eraser=${eraser})`);
  if (e) {
    console.error('FAIL', e);
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  commit (200 casi, over+gomma)');

if (fails) {
  console.error(`${fails} FAIL`);
  process.exit(1);
}
console.log('TUTTI I TEST PASSANO');
