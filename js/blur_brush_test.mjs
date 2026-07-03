// Test differenziale del pennello blur/sfumino: la STESSA sessione
// (BlurBrushSession) su uno store wasm e su uno store JS deve produrre
// byte identici — i kernel blur_blend/blur_blend_low/iir_blur replicano
// i loop JS in f64 con lo stesso ordine di operazioni.
// Run: node js/blur_brush_test.mjs  (parte di `npm test`)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WasmHeap } from './wasm_core.js';
import { ChunkStore, CHUNK, CHUNK_BYTES } from './store.js';
import { brush } from './brush.js';
import { BlurBrushSession } from './blur_brush.js';

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, 'raster_core.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const heap = new WasmHeap(instance);
if (!heap.exports.blur_blend) {
  console.error('FAIL: raster_core.wasm non esporta blur_blend (artefatto vecchio?)');
  process.exit(1);
}

// onGrow: rigenera le viste degli store wasm vivi + la maschera stamp finta
/** @type {Set<ChunkStore>} */
const wasmStores = new Set();
/** @type {{size:number, half:number, mask:Uint8Array, ptr:number, r:number}|null} */
let fakeStampWasm = null;
heap.onGrow = () => {
  for (const s of wasmStores) s.refreshViews();
  if (fakeStampWasm) fakeStampWasm.mask = heap.u8(fakeStampWasm.ptr, fakeStampWasm.size * fakeStampWasm.size);
};

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {object|null} stamp */
function makeApp(stamp) {
  return {
    undoMgr: {
      captureBegin() {}, captureChunk() {}, captureEnd() {}, captureCancel() {},
      undoStack: /** @type {any[]} */ ([]),
    },
    renderer: { disposeChunkTex() {} },
    collab: /** @type {any} */ (null),
    ui: { layersUI: { scheduleThumbs() {} } },
    stampCache: stamp ? { getStamp: () => stamp } : null,
  };
}

// Contenuto deterministico: gradienti + dischi, chunk lasciati vuoti.
/** @param {ChunkStore} store @param {number} seed */
function fillStore(store, seed) {
  const rng = mulberry32(seed);
  const discs = [];
  for (let i = 0; i < 14; i++) {
    discs.push({
      x: rng() * 700, y: rng() * 700, r: 20 + rng() * 90,
      cr: rng() * 255, cg: rng() * 255, cb: rng() * 255, a: 0.35 + rng() * 0.65,
    });
  }
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      if ((cx + cy) % 3 === 2) continue;
      const c = store.getOrCreate(cx, cy);
      const d = c.data; // vista fresca: nessun alloc prima del prossimo chunk
      for (let ly = 0; ly < CHUNK; ly++) {
        const wy = cy * CHUNK + ly;
        for (let lx = 0; lx < CHUNK; lx++) {
          const wx = cx * CHUNK + lx;
          let r = 0, g = 0, b = 0, a = 0;
          if (((wx >> 6) + (wy >> 6)) % 2 === 0) {
            a = 0.85;
            r = (wx % 256) / 255 * a;
            g = (wy % 256) / 255 * a;
            b = 0.4 * a;
          }
          for (const ds of discs) {
            const dx = wx - ds.x, dy = wy - ds.y;
            if (dx * dx + dy * dy < ds.r * ds.r) {
              a = Math.min(1, a + ds.a);
              r = ds.cr / 255 * ds.a + r * (1 - ds.a);
              g = ds.cg / 255 * ds.a + g * (1 - ds.a);
              b = ds.cb / 255 * ds.a + b * (1 - ds.a);
            }
          }
          const o = (ly * CHUNK + lx) * 4;
          const A = Math.round(a * 255);
          d[o] = Math.min(Math.round(r * 255), A);
          d[o + 1] = Math.min(Math.round(g * 255), A);
          d[o + 2] = Math.min(Math.round(b * 255), A);
          d[o + 3] = A;
        }
      }
      c.touched = true;
    }
  }
}

/**
 * @param {number} seed @param {number} n
 * @param {number} x0 @param {number} y0 @param {number} [step]
 */
function strokePts(seed, n, x0, y0, step = 55) {
  const rng = mulberry32(seed);
  const pts = [];
  let x = x0, y = y0, p = 0.6;
  for (let i = 0; i < n; i++) {
    x += (rng() - 0.35) * step;
    y += (rng() - 0.5) * step;
    p = Math.min(1, Math.max(0.05, p + (rng() - 0.5) * 0.3));
    pts.push({ x, y, p });
  }
  return pts;
}

// Stamp finto (shape): stesso pattern per JS e wasm, ptr nel heap per il
// kernel. half > r come i veri shape stamp (maskMaxHalf).
/** @param {number} size */
function makeFakeStamps(size) {
  const rng = mulberry32(0x57a3f);
  const bytes = new Uint8Array(size * size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half, dy = (y - half) / half;
      const d = Math.hypot(dx, dy);
      const v = d >= 1 ? 0 : (1 - d) * 255 * (0.6 + 0.4 * rng());
      bytes[y * size + x] = v;
    }
  }
  const js = { size, half, mask: bytes, ptr: 0, r: half };
  const ptr = heap.alloc(size * size);
  const wasm = { size, half, mask: heap.u8(ptr, size * size), ptr, r: half };
  wasm.mask.set(bytes);
  return { js, wasm };
}

/** @param {any} params */
function setBrush(params) {
  brush.blurSize = params.size;
  brush.blurStrength = params.strength ?? 1;
  brush.blurOpacity = params.opacity ?? 1;
  brush.blurSoftness = params.softness ?? 0.65;
  brush.blurDrag = params.drag;
  brush.shape = params.shape || null;
  brush.shapeInvert = false;
  brush.roundness = 1;
  brush.angle = 0;
  brush.rotation = 0;
}

/** @param {ChunkStore} store @param {any} params @param {object|null} stamp */
function runStroke(store, params, stamp) {
  setBrush(params);
  const app = /** @type {any} */ (makeApp(stamp));
  const layer = /** @type {any} */ ({ id: 1, store, thumbDirty: false });
  const clip = params.clip || { x0: 0, y0: 0, x1: 2047, y1: 2047 };
  const pts = params.pts;
  const s = new BlurBrushSession(app, /** @type {any} */ ({}), layer, clip, params.sel || null,
    params.mirrorX ?? null, null, pts[0].x, pts[0].y, pts[0].p);
  s.catchUpBacklog = Infinity; // deterministico: nessun thinning nel test
  for (let i = 1; i < pts.length; i++) s.move(pts[i].x, pts[i].y, pts[i].p);
  const last = pts[pts.length - 1];
  s.end(last.x, last.y, last.p);
  s.process(Infinity);
  return s;
}

/** @param {ChunkStore} a @param {ChunkStore} b */
function diffStores(a, b) {
  const keys = new Set([...a.map.keys(), ...b.map.keys()]);
  const zero = new Uint8ClampedArray(CHUNK_BYTES);
  let ndiff = 0, maxd = 0, total = 0;
  for (const k of keys) {
    const ca = a.map.get(k), cb = b.map.get(k);
    const da = ca ? ca.data : zero, db = cb ? cb.data : zero;
    for (let i = 0; i < da.length; i++) {
      const d = Math.abs(da[i] - db[i]);
      if (d > 0) { ndiff++; if (d > maxd) maxd = d; }
    }
    total += da.length;
  }
  return { ndiff, maxd, total };
}

function makeSel() {
  const w = 500, h = 480;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      mask[y * w + x] = Math.max(0, Math.min(255, Math.round((x / w) * 340 - 20)));
    }
  }
  return { mask, x: 60, y: 40, w, h };
}

const stamps = makeFakeStamps(96);
fakeStampWasm = stamps.wasm;

const cases = [
  { name: 'smudge puro k=1, size 120', p: { size: 120, drag: 1, pts: strokePts(11, 20, 150, 160) } },
  { name: 'smudge puro k=1, size 440', p: { size: 440, drag: 1, pts: strokePts(22, 14, 300, 300) } },
  { name: 'blur puro k=1, size 120', p: { size: 120, drag: 0, pts: strokePts(33, 16, 200, 220) } },
  { name: 'misto k=1 drag 0.55, size 200', p: { size: 200, drag: 0.55, pts: strokePts(44, 16, 250, 260) } },
  { name: 'misto drag 0.85, size 36 + selezione', p: { size: 36, drag: 0.85, pts: strokePts(55, 30, 180, 200), sel: makeSel() } },
  { name: 'smudge size 90 + mirrorX 384', p: { size: 90, drag: 1, pts: strokePts(66, 20, 150, 300), mirrorX: 384 } },
  { name: 'misto drag 0.4 su bordo contenuto', p: { size: 150, drag: 0.4, pts: strokePts(77, 18, 480, 100) } },
  { name: 'smudge da zona vuota', p: { size: 100, drag: 1, pts: strokePts(88, 18, 690, 690) } },
  { name: 'stamp shape, smudge size 130', p: { size: 130, drag: 1, pts: strokePts(99, 18, 220, 240) }, stamp: true },
  { name: 'stamp shape + sel, misto size 120', p: { size: 120, drag: 0.5, pts: strokePts(111, 14, 220, 240), sel: makeSel() }, stamp: true },
  { name: 'misto k=2, size 500', p: { size: 500, drag: 0.5, pts: strokePts(201, 12, 300, 320) } },
  { name: 'blur k=4, size 1000', p: { size: 1000, drag: 0, pts: strokePts(204, 8, 380, 380, 220) } },
  { name: 'smudge k=4, size 1000', p: { size: 1000, drag: 1, pts: strokePts(203, 10, 380, 380, 220) } },
  { name: 'smudge k=8, size 2000', p: { size: 2000, drag: 1, pts: strokePts(205, 10, 380, 380, 450) } },
];

let fail = false;
for (const c of cases) {
  const sj = new ChunkStore('js', null);
  const sw = new ChunkStore('wasm', heap);
  wasmStores.add(sw);
  fillStore(sj, 0xfab1e);
  fillStore(sw, 0xfab1e);
  runStroke(sj, { ...c.p, shape: c.stamp ? {} : null }, c.stamp ? stamps.js : null);
  runStroke(sw, { ...c.p, shape: c.stamp ? {} : null }, c.stamp ? stamps.wasm : null);
  const { ndiff, maxd, total } = diffStores(sj, sw);
  const ok = ndiff === 0;
  if (!ok) fail = true;
  console.log(`${ok ? 'ok ' : 'FAIL'} ${c.name}: ${ndiff}/${total} byte diversi, max ${maxd}`);
  wasmStores.delete(sw);
  sw.releaseAll(() => {}, true);
}

// ---- bench: stessa sessione, store JS vs store wasm ----
/** @param {boolean} withHeap @param {any} params @param {number} reps */
function bench(withHeap, params, reps) {
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const store = new ChunkStore('b', withHeap ? heap : null);
    if (withHeap) wasmStores.add(store);
    fillStore(store, 0xfab1e);
    const t0 = performance.now();
    runStroke(store, params, null);
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
    if (withHeap) wasmStores.delete(store);
    store.releaseAll(() => {}, true);
  }
  return best;
}
for (const b of [
  { name: 'smudge size 200 (k=1)', p: { size: 200, drag: 1, pts: strokePts(123, 40, 120, 120) } },
  { name: 'misto size 200 drag 0.5 (k=1)', p: { size: 200, drag: 0.5, pts: strokePts(123, 40, 120, 120) } },
  { name: 'smudge size 500 (k=1)', p: { size: 500, drag: 1, pts: strokePts(321, 25, 250, 250) } },
  { name: 'misto size 500 drag 0.5 (k=2)', p: { size: 321, drag: 0.5, pts: strokePts(321, 25, 250, 250) } },
  { name: 'smudge size 1200 (k=4)', p: { size: 1200, drag: 1, pts: strokePts(322, 15, 380, 380, 260) } },
  { name: 'smudge size 2000 (k=8)', p: { size: 2000, drag: 1, pts: strokePts(323, 10, 380, 380, 450) } },
]) {
  const tJs = bench(false, b.p, 3);
  const tWasm = bench(true, b.p, 3);
  console.log(`bench ${b.name}: js ${tJs.toFixed(1)}ms -> wasm ${tWasm.toFixed(1)}ms (${(tJs / tWasm).toFixed(2)}x)`);
}

if (fail) {
  console.error('BLUR TESTS FAILED');
  process.exit(1);
}
console.log('ALL BLUR TESTS PASS');
