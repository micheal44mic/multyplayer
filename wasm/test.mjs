// Differential test for the wasm core against the math in js/raster.js.
// Run with:  node wasm/test.mjs
// Compares dab/capsule/commit output byte for byte with a JS reference that
// replicates the original loops on random input (fixed seed).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// capsule v2: lo SPEC intero vive in capsule_int.js — qui fa da riferimento
import { CAP_STRIDE_I32, FALLOFF_LUT, capsuleIntParams, capsuleIntMa } from '../js/capsule_int.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, '../js/raster_core.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;

const CHUNK = 256;
const CHUNK_BYTES = CHUNK * CHUNK * 4;
const div255 = (v) => ((v + 128) * 257) >> 16;

// Deterministic PRNG (mulberry32, like util.js).
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

// ---- vector div255 identity: ((x+128)+((x+128)>>8))>>8 ----
for (let v = 0; v <= 65025; v++) {
  const a = v + 128;
  if (((a + (a >> 8)) >> 8) !== div255(v)) {
    console.error('div255 identity FAIL at', v);
    process.exit(1);
  }
}
console.log('ok  div255 identity (0..65025)');

// ---- memory: dst/src chunks, mask, factor tile, RGBX tile ----
const base = ex.__heap_base.value;
const need = base + CHUNK_BYTES * 2 + 65536 + 65536 + CHUNK * CHUNK * 4 + 8192;
const pages = Math.ceil((need - ex.memory.buffer.byteLength) / 65536);
if (pages > 0) ex.memory.grow(pages);
const PTR_DST = (base + 15) & ~15;
const PTR_SRC = PTR_DST + CHUNK_BYTES;
const PTR_MASK = PTR_SRC + CHUNK_BYTES;
const mem = () => new Uint8Array(ex.memory.buffer);

// LUT del falloff capsule v2 nel modulo (unica fonte: js/capsule_int.js)
const PTR_LUT = PTR_MASK + 65536 + 65536 + CHUNK * CHUNK * 4;
new Uint8Array(ex.memory.buffer, PTR_LUT, FALLOFF_LUT.length * 2)
  .set(new Uint8Array(FALLOFF_LUT.buffer, 0, FALLOFF_LUT.length * 2));
ex.set_falloff_lut(PTR_LUT);

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

// ---- JS reference: dab (copy of _dab in raster.js) ----
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
      } else if (ma >= d[di + 3]) { // wash: ties go to the latest dab
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

// ---- JS reference: capsule v2 (lo spec di capsule_int.js, senza bound:
// verifica che gli skip SIMD/di riga del wasm siano esatti) ----
function refCapsuleInt(d, lx0, ly0, lx1, ly1, ox, oy, recs, s, hq, cr, cg, cb) {
  let wrote = false;
  for (let y2 = ly0; y2 <= ly1; y2++) {
    let di = ((y2 << 8) + lx0) << 2;
    for (let x2 = lx0; x2 <= lx1; x2++, di += 4) {
      const ma = capsuleIntMa(recs, s, ox + x2, oy + y2, hq);
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

// ---- JS reference: commit (copy of commitChunk, without store) ----
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

// ---- dab: 300 random cases ----
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
console.log('ok  dab (300 cases, wash+buildup)');

// ---- dab_tex_tile: 300 random cases ----
// Reference = textured JS path from raster.js: m2 = div255(m*f), with the
// factor read from the tile in chunk space, then dab compositing. rgb != null
// means per-pixel colors from the RGBX tile (X=255, the raster.js fill contract).
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
      } else if (ma >= d[di + 3]) { // wash: ties go to the latest dab
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
console.log('ok  dab_tex_tile (300 cases, wash+buildup, fixed color+RGBX)');

// ---- capsule_int: 300 random cases (quantizzazione dallo spec condiviso) ----
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
  const hq = Math.round(h * 4096);
  const recs = [];
  capsuleIntParams(x0, y0, r0, a0, x1, y1, r1, a1, recs);

  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, true);
  const ref = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);

  let refWrote = 0, wasmWrote = 0;
  for (let s = 0; s < recs.length; s += CAP_STRIDE_I32) {
    refWrote |= refCapsuleInt(ref, lx0, ly0, lx1, ly1, ox, oy, recs, s, hq, cr, cg, cb);
    wasmWrote |= ex.capsule_int(PTR_DST, lx0, ly0, lx1, ly1, ox, oy,
      recs[s], recs[s + 1], recs[s + 2], recs[s + 3], recs[s + 4],
      recs[s + 5], recs[s + 6], recs[s + 7], recs[s + 8], hq, cr, cg, cb);
  }

  const e = diff(ref, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `capsule_int #${it}`);
  if (e || refWrote !== wasmWrote) {
    console.error('FAIL', e || `capsule_int #${it}: wrote ref=${refWrote} wasm=${wasmWrote}`);
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  capsule_int (300 cases, v2 interi)');

// ---- capsule_tex_int: 300 random cases ----
// Riferimento v2 senza scorciatoie (nessun bound di riga/pixel): verifica che
// gli skip SIMD del wasm siano esatti. ma = div255(maBase * f) col fattore dal
// tile; rgb != null = colori per pixel dal tile RGBX.
function refCapsuleTexInt(d, lx0, ly0, lx1, ly1, ox, oy, recs, s, hq,
  cr, cg, cb, tile, rgbx) {
  let wrote = false;
  for (let y2 = ly0; y2 <= ly1; y2++) {
    let di = ((y2 << 8) + lx0) << 2;
    let ti = (y2 << 8) + lx0;
    for (let x2 = lx0; x2 <= lx1; x2++, di += 4, ti++) {
      const maB = capsuleIntMa(recs, s, ox + x2, oy + y2, hq);
      if (maB === 0) continue;
      const ma = div255(maB * tile[ti]);
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

  const hq = Math.round(h * 4096);
  const recs = [];
  capsuleIntParams(x0, y0, r0, a0, x1, y1, r1, a1, recs);

  const m = mem();
  randomize(m, PTR_DST, CHUNK_BYTES, true);
  const ref = m.slice(PTR_DST, PTR_DST + CHUNK_BYTES);
  m.set(tile, PTR_TILE);
  if (rgbx) m.set(rgbx, PTR_RGBX);

  let refWrote = 0, wasmWrote = 0;
  for (let s = 0; s < recs.length; s += CAP_STRIDE_I32) {
    refWrote |= refCapsuleTexInt(ref, lx0, ly0, lx1, ly1, ox, oy, recs, s, hq,
      cr, cg, cb, tile, rgbx);
    wasmWrote |= ex.capsule_tex_int(PTR_DST, lx0, ly0, lx1, ly1, ox, oy,
      recs[s], recs[s + 1], recs[s + 2], recs[s + 3], recs[s + 4],
      recs[s + 5], recs[s + 6], recs[s + 7], recs[s + 8], hq,
      cr, cg, cb, PTR_TILE, rgbx ? PTR_RGBX : 0);
  }

  const e = diff(ref, mem().subarray(PTR_DST, PTR_DST + CHUNK_BYTES), `capsule_tex_int #${it}`);
  if (e || refWrote !== wasmWrote) {
    console.error('FAIL', e || `capsule_tex_int #${it}: wrote ref=${refWrote} wasm=${wasmWrote}`, { useRgb });
    if (++fails > 3) process.exit(1);
  }
}
console.log('ok  capsule_tex_int (300 cases, v2 interi, fixed color+RGBX)');

// ---- commit: 200 random cases ----
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
console.log('ok  commit (200 cases, over+eraser)');

if (fails) {
  console.error(`${fails} FAIL`);
  process.exit(1);
}
console.log('ALL TESTS PASS');
