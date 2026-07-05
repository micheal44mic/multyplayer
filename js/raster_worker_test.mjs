// TEST DIFFERENZIALE DEL RASTER WORKER (node js/raster_worker_test.mjs).
// Stessa sequenza di descrittori su: (A) path classico ChunkStore+Rasterizer,
// (B) protocollo worker in-process (SlotPool/SabStrokeStore + WorkerEngine +
// simulateEntry come fa il bridge). Pretese: chunk identici byte per byte,
// stesso insieme di chiavi, nessun "chunk non previsto" (la simulazione di
// creazione è un soprainsieme esatto), touched allineati, dirty bbox che
// copre ogni pixel scritto (upload completo).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkStore, CHUNK } from './store.js';
import { StampCache } from './brush.js';
import { Rasterizer } from './raster.js';
import { DabQueue, T_DAB, T_SEG } from './stroke.js';
import { SlotPool, SabStrokeStore } from './sab_store.js';
import { WorkerEngine } from './raster_worker_core.js';
import { CTL_DRAINED, ENTRY_STRIDE, simulateEntry, serializeSnap } from './raster_shared.js';
import { defaultGrainTexture, buildTextureLut, buildTextureColorLut } from './texture.js';
import { makeBrushShape } from './shape.js';
import { mulberry32 } from './util.js';
import { WasmHeap } from './wasm_core.js';

// core wasm reale: ogni caso gira anche col worker in modalità wasm+SIMD
const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(join(here, 'raster_core.wasm'));

let failures = 0;
/** @param {boolean} ok @param {string} msg */
function check(ok, msg) {
  if (ok) console.log('ok ', msg);
  else { console.error('FAIL', msg); failures++; }
}

/** @param {Partial<any>} over @returns {any} */
function makeSnap(over = {}) {
  return /** @type {any} */ ({
    baseR: 12, diam: 24, opacity: 1, hardness: 0.85, roundness: 1,
    shape: null, shapeInvert: false, baseAngle: 0, rotation: 0,
    spacing: 0.04, smoothing: 0, direct: false,
    pressureSize: 0, pressureCurveX: 0.5, pressureCurveY: 0.5,
    stabilizationMode: 'smart', scatter: false, partN: 1, partSize: 0.5, partDev: 0,
    jPos: 0, jSize: 0, jOp: 0, jSpacing: 0, jAngle: 0, jBright: 0, jSat: 0,
    aqua: false, aquaColorMix: 0, aquaWetness: 0.5, aquaLighten: false,
    buildup: false, alphaCompPow: 1, taperStart: 0, taperEnd: 0, speedScale: 1,
    tex: null, texScale: 1, texAngle: 0, texCos: 1, texSin: 0, texMoving: false,
    texLut: null, texColor: false, texColorLut: null,
    colR: 30, colG: 90, colB: 200, hsv: { h: 0, s: 0, v: 0 },
    eraser: false, continuous: false, globalOpacity: 1,
    seed: 7, rng: mulberry32(7), tmpRgb: { r: 0, g: 0, b: 0 },
    ...over,
  });
}

// entry casuali dentro (e a cavallo) del clip, dab e capsule miste
/** @param {DabQueue} q @param {() => number} rnd @param {number} n @param {{x0:number,y0:number,x1:number,y1:number}} clip */
function pushRandomEntries(q, rnd, n, clip) {
  const w = clip.x1 - clip.x0 + 1, h = clip.y1 - clip.y0 + 1;
  for (let i = 0; i < n; i++) {
    const x = clip.x0 - 40 + rnd() * (w + 80);
    const y = clip.y0 - 40 + rnd() * (h + 80);
    const r = 0.6 + rnd() * 60;
    const a = rnd() < 0.08 ? 0 : 0.05 + rnd() * 0.95;
    if (rnd() < 0.6) {
      q.push(T_DAB, x, y, r, a, rnd() * 7, (rnd() * 255) | 0, (rnd() * 255) | 0, (rnd() * 255) | 0, 0);
    } else {
      q.push(T_SEG, x, y, r, a,
        x + (rnd() - 0.5) * 90, y + (rnd() - 0.5) * 90, 0.6 + rnd() * 60, 0.05 + rnd() * 0.95, 0);
    }
  }
}

/**
 * Esegue lo stesso stream sui due path e confronta.
 * @param {string} name @param {any} snap @param {number} seed
 * @param {{mirrorX?: number|null, pattern?: any, sel?: any, wasm?: boolean}} [opt]
 */
async function runCase(name, snap, seed, opt = {}) {
  const clip = { x0: 0, y0: 0, x1: 1023, y1: 1023 };
  const rnd = mulberry32(seed);
  const q = new DabQueue();
  q.mirrorX = opt.mirrorX ?? null;
  q.patternTile = opt.pattern ?? null;
  pushRandomEntries(q, rnd, 90, clip);

  // stream comune: fotografa la coda espansa (specchio/pattern già applicati)
  const n = q.count;
  const stream = new Float32Array(n * ENTRY_STRIDE);
  for (let i = 0; i < n; i++) {
    const o = q.peekOffset();
    for (let k = 0; k < ENTRY_STRIDE; k++) stream[i * ENTRY_STRIDE + k] = q.buf[o + k];
    q.pop();
  }

  // ---- path A: riferimento ----
  const refStore = new ChunkStore('ref', null);
  const refRaster = new Rasterizer(refStore, new StampCache(), null);
  refRaster.beginStroke(snap, clip, opt.sel || null, null);
  const refQ = new DabQueue();
  for (let i = 0; i < n; i++) {
    const o = i * ENTRY_STRIDE;
    refQ.push(stream[o], stream[o + 1], stream[o + 2], stream[o + 3], stream[o + 4],
      stream[o + 5], stream[o + 6], stream[o + 7], stream[o + 8], stream[o + 9]);
  }
  refRaster.run(refQ, Infinity);

  // ---- path B: protocollo worker in-process ----
  const pool = new SlotPool();
  const cols = (clip.x1 >> 8) - (clip.x0 >> 8) + 1;
  pool.ensure(cols * cols + 16);
  const mirror = new SabStrokeStore('mirror', pool);
  const ctlSab = new SharedArrayBuffer(64);
  const eng = new WorkerEngine();
  if (opt.wasm) {
    // heap fresco per caso: nessuna interferenza di slab tra i casi
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    eng.attachHeap(new WasmHeap(instance));
  }
  eng.handle({ t: 'init', ctl: ctlSab, slots: pool.sab, touched: pool.touchedSab });
  if (snap.tex) eng.handle({ t: 'asset', id: 1, kind: 'tex', obj: snap.tex });
  if (snap.shape) eng.handle({ t: 'asset', id: 2, kind: 'shape', obj: snap.shape });
  eng.handle({
    t: 'begin', gen: 1, snap: serializeSnap(snap, snap.tex ? 1 : 0, snap.shape ? 2 : 0),
    clip: { ...clip }, sel: opt.sel || null,
  });
  const sim = { hardness: snap.hardness, roundness: snap.roundness, shape: snap.shape };
  const known = new Set();
  /** @type {{idx:number, chunk:any, lx0:number, ly0:number, lx1:number, ly1:number}[]} */
  const pending = [];
  let unexpected = 0;
  const origErr = console.error;
  console.error = (...a) => { unexpected++; origErr(...a); };
  let sent = 0;
  // batch di taglie variabili (come i frame)
  for (let i = 0; i < n;) {
    const bn = Math.min(n - i, 1 + ((rnd() * 24) | 0));
    const buf = stream.slice(i * ENTRY_STRIDE, (i + bn) * ENTRY_STRIDE);
    /** @type {number[]} */
    const creations = [];
    for (let k = 0; k < bn; k++) {
      const idx = ++sent;
      simulateEntry(mirror, sim, buf, k * ENTRY_STRIDE, clip, (chunk, lx0, ly0, lx1, ly1) => {
        if (!known.has(chunk.key)) {
          known.add(chunk.key);
          creations.push(chunk.key, mirror.slotFor(chunk));
        }
        pending.push({ idx, chunk, lx0, ly0, lx1, ly1 });
      });
    }
    eng.handle({ t: 'entries', gen: 1, n: bn, buf, creations });
    i += bn;
  }
  console.error = origErr;
  const drained = Atomics.load(new Int32Array(ctlSab), CTL_DRAINED);
  check(drained === n, `${name}: drained ${drained}/${n}`);
  check(unexpected === 0, `${name}: nessun chunk non previsto dal main (${unexpected})`);

  // applica i dirty come farebbe tick() a drain completo
  for (const p of pending) mirror.markDirty(p.chunk, p.lx0, p.ly0, p.lx1, p.ly1);

  // confronto struttura + byte
  const refKeys = [...refStore.map.keys()].sort();
  const mirKeys = [...mirror.map.keys()].sort();
  check(refKeys.length === mirKeys.length && refKeys.every((k, i) => k === mirKeys[i]),
    `${name}: stesso insieme di chunk (${refKeys.length})`);
  let diffBytes = 0, touchDiff = 0, dirtyMiss = 0;
  for (const [key, rc] of refStore.map) {
    const mc = mirror.map.get(key);
    if (!mc) continue;
    const a = rc.data, b = mc.data;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffBytes++;
    // touched: nel protocollo vero arriva dai flag SAB (syncTouched)
    const slot = mirror.slotFor(mc);
    const wTouched = slot >= 0 && pool.touched ? pool.touched[slot] === 1 : false;
    if (wTouched !== rc.touched) touchDiff++;
    // ogni pixel scritto deve stare nel bbox dirty del mirror (upload completo)
    for (let y = 0; y < CHUNK; y++) {
      for (let x = 0; x < CHUNK; x++) {
        const o = ((y << 8) + x) * 4;
        if (a[o + 3] === 0 && a[o] === 0 && a[o + 1] === 0 && a[o + 2] === 0) continue;
        if (x < mc.dirX0 || x > mc.dirX1 || y < mc.dirY0 || y > mc.dirY1) dirtyMiss++;
      }
    }
  }
  check(diffBytes === 0, `${name}: 0 byte diversi (${diffBytes})`);
  check(touchDiff === 0, `${name}: touched allineati (${touchDiff})`);
  check(dirtyMiss === 0, `${name}: dirty bbox copre ogni pixel scritto (${dirtyMiss})`);
}

// ---- casi: ognuno gira col worker in JS e in WASM+SIMD ----
const rnd = mulberry32(1234);
const shapeW = 64, shapeH = 48;
const shapeAlpha = new Uint8Array(shapeW * shapeH);
for (let i = 0; i < shapeAlpha.length; i++) shapeAlpha[i] = (rnd() * 256) | 0;
const shape = makeBrushShape('test-shape', shapeW, shapeH, shapeAlpha);
const tex = defaultGrainTexture();
const texLut = buildTextureLut(0.6, 1.2, 0.2, false);
const selMask = new Uint8Array(1024 * 1024);
{
  const mr = mulberry32(99);
  for (let i = 0; i < selMask.length; i++) selMask[i] = mr() < 0.5 ? 255 : 0;
}
const texAng = Math.PI / 5;

/** @type {[string, any, number, any][]} */
const CASES = [
  ['wash tondo', makeSnap(), 11, {}],
  ['buildup morbido', makeSnap({ buildup: true, hardness: 0.2 }), 22, {}],
  ['specchio+pattern', makeSnap(), 33, { mirrorX: 512, pattern: { x: 0, y: 0, w: 1024, h: 1024 } }],
  ['shape ruotata', makeSnap({ shape, roundness: 0.6 }), 44, {}],
  ['texture ancorata', makeSnap({ tex, texLut }), 55, {}],
  ['texture colore', makeSnap({ tex, texLut, texColor: true, texColorLut: buildTextureColorLut(1.4) }), 66, {}],
  ['texture moving', makeSnap({ tex, texLut, texMoving: true }), 77, {}],
  ['texture ruotata', makeSnap({ tex, texLut, texAngle: texAng, texCos: Math.cos(texAng), texSin: Math.sin(texAng) }), 88, {}],
  ['selezione', makeSnap(), 99, { sel: { mask: selMask, x: 0, y: 0, w: 1024, h: 1024 } }],
];

for (const wasm of [false, true]) {
  for (const [name, snap, seed, opt] of CASES) {
    await runCase(`${name} [worker ${wasm ? 'wasm' : 'js'}]`, snap, seed, { ...opt, wasm });
  }
}

// ---- pass finale del taper (endpass): live, svuota la punta, replay clippato ----
/** @param {string} name @param {boolean} wasm */
async function runEndPassCase(name, wasm) {
  const clip = { x0: 0, y0: 0, x1: 1023, y1: 1023 };
  const snap = makeSnap();
  const rnd2 = mulberry32(4242);
  const mkStream = (/** @type {number} */ n, /** @type {number} */ seed) => {
    const q = new DabQueue();
    pushRandomEntries(q, mulberry32(seed), n, clip);
    const out = new Float32Array(q.count * ENTRY_STRIDE);
    let i = 0;
    while (q.count > 0) {
      const o = q.peekOffset();
      for (let k = 0; k < ENTRY_STRIDE; k++) out[i * ENTRY_STRIDE + k] = q.buf[o + k];
      q.pop(); i++;
    }
    return out;
  };
  const live = mkStream(70, 91);
  const replay = mkStream(50, 92); // "punta" ridisegnata (descrittori qualsiasi)
  // chiavi della punta: un blocco di chunk in mezzo al board
  const tipKeys = new Set();
  for (let cy = 1; cy <= 2; cy++) for (let cx = 1; cx <= 2; cx++) tipKeys.add(((cx + 32768) << 16) | (cy + 32768));

  // riferimento: pipeline main di sempre
  const refStore = new ChunkStore('ref', null);
  const refRaster = new Rasterizer(refStore, new StampCache(), null);
  refRaster.beginStroke(snap, clip, null, null);
  const refQ = new DabQueue();
  const feed = (/** @type {Float32Array} */ s) => {
    for (let i = 0; i < s.length; i += ENTRY_STRIDE) {
      refQ.push(s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8], s[i + 9]);
    }
  };
  feed(live);
  refRaster.run(refQ, Infinity);
  for (const k of tipKeys) refStore.remove(k, null);
  refRaster.beginStroke(snap, clip, null, null);
  refRaster.clip = tipKeys;
  feed(replay);
  refRaster.run(refQ, Infinity);
  refRaster.clip = null;

  // path worker: live -> endpass -> replay (creazioni simulate col clip)
  const pool = new SlotPool();
  pool.ensure(16 + 16);
  const mirror = new SabStrokeStore('mirror', pool);
  const ctlSab = new SharedArrayBuffer(64);
  const eng = new WorkerEngine();
  if (wasm) {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    eng.attachHeap(new WasmHeap(instance));
  }
  eng.handle({ t: 'init', ctl: ctlSab, slots: pool.sab, touched: pool.touchedSab });
  eng.handle({ t: 'begin', gen: 1, snap: serializeSnap(snap, 0, 0), clip: { ...clip }, sel: null });
  const sim = { hardness: snap.hardness, roundness: snap.roundness, shape: snap.shape };
  const known = new Set();
  let sent = 0;
  /** @param {Float32Array} s @param {Set<number>|null} ck */
  const send = (s, ck) => {
    const n = s.length / ENTRY_STRIDE;
    /** @type {number[]} */
    const creations = [];
    for (let k = 0; k < n; k++) {
      sent++;
      simulateEntry(mirror, sim, s, k * ENTRY_STRIDE, clip, (chunk) => {
        if (!known.has(chunk.key)) {
          known.add(chunk.key);
          creations.push(chunk.key, mirror.slotFor(chunk));
        }
      }, ck);
    }
    eng.handle({ t: 'entries', gen: 1, n, buf: s, creations });
  };
  send(live, null);
  // endpass ASINCRONO come il bridge: rebind a slot freschi (i pixel vecchi
  // restano nel chunk fino allo swap), il worker scarta i binding e il
  // replay scrive negli slot nuovi; poi lo swap atomico (bridge._trySwap)
  /** @type {{chunk: any, oldSlot: number, newSlot: number}[]} */
  const swapItems = [];
  for (const k of tipKeys) {
    known.delete(k);
    const c = mirror.map.get(k);
    if (!c) continue;
    const r = mirror.rebindFresh(c);
    if (!r) { check(false, `${name}: pool esaurito nel rebind (capienza test insufficiente)`); continue; }
    swapItems.push({ chunk: c, oldSlot: r.oldSlot, newSlot: r.newSlot });
  }
  eng.handle({ t: 'endpass', gen: 1, clip: [...tipKeys] });
  send(replay, tipKeys);
  const drained = Atomics.load(new Int32Array(ctlSab), CTL_DRAINED);
  check(drained === sent, `${name}: drained ${drained}/${sent}`);
  for (const it of swapItems) {
    if (it.newSlot >= 0) it.chunk.data = pool.view(it.newSlot);
    it.chunk.touched = false;
    if (it.oldSlot >= 0) pool.releaseDeferred(it.oldSlot);
  }

  // il mirror TIENE i chunk della punta non ricoperti dal replay (bianchi,
  // touched 0: il commit li scarta); il riferimento li ha rimossi — quindi
  // mirror ⊇ ref, e gli extra devono essere vuoti con flag spento
  let diffBytes = 0, missing = 0, extraBad = 0;
  for (const [key, rc] of refStore.map) {
    const mc = mirror.map.get(key);
    if (!mc) { missing++; continue; }
    for (let i = 0; i < rc.data.length; i++) if (rc.data[i] !== mc.data[i]) diffBytes++;
  }
  for (const [key, mc] of mirror.map) {
    if (refStore.map.has(key)) continue;
    const slot = mirror.slotFor(mc);
    const flagged = slot >= 0 && pool.touched ? pool.touched[slot] === 1 : false;
    let blank = true;
    for (let i = 0; i < mc.data.length; i++) if (mc.data[i] !== 0) { blank = false; break; }
    if (!blank || flagged) extraBad++;
  }
  check(missing === 0, `${name}: nessun chunk del riferimento mancante (${missing})`);
  check(diffBytes === 0, `${name}: 0 byte diversi dopo endpass+swap (${diffBytes})`);
  check(extraBad === 0, `${name}: chunk punta non ricoperti = bianchi e non touched (${extraBad})`);
}

await runEndPassCase('endpass [worker js]', false);
await runEndPassCase('endpass [worker wasm]', true);

if (failures) {
  console.error(`\n${failures} FALLIMENTI`);
  process.exit(1);
}
console.log('\nALL RASTER WORKER TESTS PASS');
