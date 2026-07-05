// TEST DELLA CAPSULE v2 A INTERI (webgpu_test.html, dopo la suite dab).
// Due pretese DIVERSE:
//   (A) DETERMINISMO — executor JS intero (capsule_int.js) vs kernel WGSL
//       (wgpu_capsule.js): 0 byte diversi, obbligatorio. È il contratto che
//       rende il motore GPU compatibile con la collab.
//   (B) FEDELTÀ — v1 float (raster.js/_capsule, il motore attuale) vs v2:
//       statistiche di scostamento (maxΔ alpha, % pixel), NON 0-diff: v2
//       quantizza a 1/16 px nella banda AA per essere portabile. I numeri
//       decidono se atterrarla nel motore vero (lockstep JS+wasm).

import { ChunkStore, CHUNK } from './store.js';
import { StampCache } from './brush.js';
import { Rasterizer } from './raster.js';
import { DabQueue, T_SEG } from './stroke.js';
import { mulberry32 } from './util.js';
import { CAP_STRIDE_I32, FALLOFF_LUT, capsuleIntParams, capsuleIntRun } from './capsule_int.js';
import { WgpuCapsuleKernel } from './wgpu_capsule.js';

const W = 1024, H = 1024;
const ENTRY = 10;

/** @type {(s: string) => void} */
let print = (s) => console.log(s);
let failures = 0;

/** @param {boolean} ok @param {string} msg */
function check(ok, msg) {
  print((ok ? 'ok   ' : 'FAIL ') + msg);
  if (!ok) failures++;
}

/** Snap minimo per il path _capsule (niente texture/aqua). @param {number} hardness */
function makeSnap(hardness) {
  return /** @type {any} */ ({
    baseR: 12, diam: 24, opacity: 1, hardness, roundness: 1,
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
    eraser: false, continuous: true, globalOpacity: 1,
    seed: 7, rng: mulberry32(7), tmpRgb: { r: 0, g: 0, b: 0 },
  });
}

/**
 * Catena continua deterministica: polilinea con raggio/alpha che variano.
 * Ritorna lo stream f32 T_SEG (gli stessi arrotondamenti che vede v1).
 * @param {() => number} rnd @param {number} nodes @param {number} step
 * @param {number} rBase @param {number} rVar @param {boolean} alphaRamp
 */
function chainStream(rnd, nodes, step, rBase, rVar, alphaRamp) {
  const segs = [];
  let x = 120 + rnd() * 500, y = 120 + rnd() * 500;
  let ang = rnd() * Math.PI * 2;
  let r = rBase;
  for (let i = 0; i < nodes; i++) {
    ang += (rnd() - 0.5) * 0.9;
    const nx = x + Math.cos(ang) * step * (0.5 + rnd());
    const ny = y + Math.sin(ang) * step * (0.5 + rnd());
    const nr = Math.max(0.3, rBase + Math.sin(i / 7) * rVar + (rnd() - 0.5) * rVar * 0.3);
    const a0 = alphaRamp ? 0.15 + 0.8 * (i / nodes) : 1;
    const a1 = alphaRamp ? 0.15 + 0.8 * ((i + 1) / nodes) : 1;
    segs.push([x, y, r, a0, nx, ny, nr, a1]);
    x = nx; y = ny; r = nr;
  }
  const s = new Float32Array(segs.length * ENTRY);
  for (let i = 0; i < segs.length; i++) {
    const o = i * ENTRY, g = segs[i];
    s[o] = T_SEG;
    s[o + 1] = g[0]; s[o + 2] = g[1]; s[o + 3] = g[2]; s[o + 4] = g[3];
    s[o + 5] = g[4]; s[o + 6] = g[5]; s[o + 7] = g[6]; s[o + 8] = g[7];
    s[o + 9] = 0;
  }
  return s;
}

/**
 * Un caso: v1 (riferimento float), v2 JS intero, v2 GPU. A = JS-int vs GPU
 * 0-diff; B = v1 vs v2 statistiche.
 * @param {WgpuCapsuleKernel} kernel @param {string} name
 * @param {Float32Array} stream @param {number} hardness
 * @param {{x0: number, y0: number, x1: number, y1: number}} clip
 */
async function runCase(kernel, name, stream, hardness, clip) {
  const n = stream.length / ENTRY;
  const hq = Math.round(hardness * 4096);
  const CR = 30, CG = 90, CB = 200;

  // ---- v1: riferimento float (motore attuale) ----
  const refStore = new ChunkStore('ref', null);
  const refRaster = new Rasterizer(refStore, new StampCache(), null);
  refRaster.beginStroke(makeSnap(hardness), clip, null, null);
  const q = new DabQueue();
  for (let i = 0; i < n; i++) {
    const o = i * ENTRY;
    q.push(stream[o], stream[o + 1], stream[o + 2], stream[o + 3], stream[o + 4],
      stream[o + 5], stream[o + 6], stream[o + 7], stream[o + 8], stream[o + 9]);
  }
  const tRef0 = performance.now();
  refRaster.run(q, Infinity);
  const refMs = performance.now() - tRef0;
  const v1 = new Uint8Array(W * H * 4);
  refStore.map.forEach((chunk) => {
    const bx = chunk.cx * CHUNK, by = chunk.cy * CHUNK;
    if (bx < 0 || by < 0 || bx >= W || by >= H) return;
    for (let yy = 0; yy < CHUNK; yy++) {
      v1.set(chunk.data.subarray(yy * CHUNK * 4, (yy + 1) * CHUNK * 4), ((by + yy) * W + bx) * 4);
    }
  });

  // ---- v2: record integer dagli STESSI f32 dello stream ----
  /** @type {number[]} */
  const recs = [];
  for (let i = 0; i < n; i++) {
    const o = i * ENTRY;
    capsuleIntParams(stream[o + 1], stream[o + 2], stream[o + 3], stream[o + 4],
      stream[o + 5], stream[o + 6], stream[o + 7], stream[o + 8], recs);
  }
  const segRecs = new Int32Array(recs);
  const nRecs = segRecs.length / CAP_STRIDE_I32;

  // v2 su CPU (executor JS intero)
  const v2js = new Uint8Array(W * H * 4);
  const tJs0 = performance.now();
  capsuleIntRun(v2js, W, H, 0, 0, segRecs, nRecs, hq, CR, CG, CB, clip);
  const jsMs = performance.now() - tJs0;

  // v2 su GPU (kernel WGSL)
  const v2gpu = new Uint8Array(W * H * 4);
  const gpuMs = await kernel.runBatch(v2gpu, W, H, 0, 0, FALLOFF_LUT,
    segRecs, nRecs, hq, CR, CG, CB, clip);

  // ---- A: determinismo JS-int vs GPU ----
  let diffAB = 0;
  for (let i = 0; i < v2js.length; i++) if (v2js[i] !== v2gpu[i]) diffAB++;
  check(diffAB === 0, `${name} [A determinismo]: 0 byte diversi JS-int vs GPU (${diffAB}; ` +
    `${nRecs} tratte da ${n} seg, js-int ${jsMs.toFixed(1)}ms, gpu ${gpuMs.toFixed(1)}ms)`);

  // ---- B: fedeltà v1 float vs v2 ----
  let painted = 0, diffPx = 0, maxDa = 0, sumDa = 0;
  for (let i = 3; i < v1.length; i += 4) {
    const a1v = v1[i], a2v = v2js[i];
    if (a1v > 0 || a2v > 0) painted++;
    const d = Math.abs(a1v - a2v);
    if (d > 0) { diffPx++; sumDa += d; if (d > maxDa) maxDa = d; }
  }
  const pct = painted ? (diffPx / painted * 100) : 0;
  const mean = diffPx ? (sumDa / diffPx) : 0;
  // dall'atterraggio della v2 nel motore (raster.js == spec) il confronto
  // è di DETERMINISMO puro: 0 byte, non più una soglia di fedeltà
  check(maxDa === 0, `${name} [B motore==spec]: maxΔalpha ${maxDa} (atteso 0), ` +
    `pixel diversi ${diffPx}/${painted} (${pct.toFixed(2)}%), Δ medio ${mean.toFixed(2)}, ` +
    `motore ${refMs.toFixed(1)}ms`);
}

export async function runAllCapsule() {
  print('capsule v2 a interi — (A) JS-int vs WGSL 0-diff, (B) fedeltà vs v1 float');
  const kernel = new WgpuCapsuleKernel();
  if (!(/** @type {any} */ (navigator).gpu) || !(await kernel.init())) {
    print('WebGPU non disponibile: suite capsule saltata.');
    return { ok: false, failures: -1, webgpu: false };
  }
  const clip = { x0: 0, y0: 0, x1: 1023, y1: 1023 };

  await runCase(kernel, 'catena densa r12 h0.85',
    chainStream(mulberry32(101), 120, 5, 12, 4, false), 0.85, clip);
  await runCase(kernel, 'catena r60→300 h0.5',
    chainStream(mulberry32(202), 40, 22, 160, 140, false), 0.5, clip);
  await runCase(kernel, 'catena soft h0',
    chainStream(mulberry32(303), 80, 8, 30, 10, false), 0, clip);
  await runCase(kernel, 'catena dura h1 (AA 1px)',
    chainStream(mulberry32(404), 80, 8, 30, 10, false), 1, clip);
  await runCase(kernel, 'alpha in rampa',
    chainStream(mulberry32(505), 90, 7, 20, 6, true), 0.85, clip);

  // snap-line lunga: esercita lo split >256px, taper pieno
  const line = new Float32Array(ENTRY);
  line[0] = T_SEG;
  line[1] = 60.3; line[2] = 980.7; line[3] = 4; line[4] = 1;
  line[5] = 990.2; line[6] = 80.4; line[7] = 40; line[8] = 1;
  await runCase(kernel, 'linea snap 1300px con split', line, 0.85, clip);

  // degeneri: lunghezza zero, raggio sub-pixel, alpha zero
  const dg = new Float32Array(4 * ENTRY);
  const put = (/** @type {number} */ i, /** @type {number[]} */ v) => {
    dg[i * ENTRY] = T_SEG;
    for (let k = 0; k < 8; k++) dg[i * ENTRY + 1 + k] = v[k];
  };
  put(0, [400.5, 400.5, 25, 1, 400.5, 400.5, 25, 1]);   // len 0
  put(1, [500.2, 300.9, 0.3, 1, 540.7, 310.1, 0.35, 1]); // r sub-pixel
  put(2, [200, 600, 18, 0, 260, 640, 18, 0]);            // alpha 0
  put(3, [700.5, 700.5, 12, 1, 700.9, 700.6, 12, 1]);    // len sub-pixel
  await runCase(kernel, 'degeneri (len0, r0.3, a0)', dg, 0.85, clip);

  const tight = { x0: 200, y0: 200, x1: 500, y1: 420 };
  await runCase(kernel, 'clip stretto',
    chainStream(mulberry32(606), 100, 9, 26, 12, false), 0.85, tight);

  print(failures === 0 ? 'ALL CAPSULE V2 TESTS PASS' : `${failures} FAILURE(S) capsule`);
  return { ok: failures === 0, failures, webgpu: true };
}

/** @param {(s: string) => void} p */
export function setCapsulePrinter(p) { print = p; }
