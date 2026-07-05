// TEST DIFFERENZIALE DEL KERNEL WEBGPU DAB (webgpu_test.html — nel browser:
// WebGPU non gira in Node). Stessa sequenza di descrittori T_DAB f32 su:
//   (A) riferimento — ChunkStore + Rasterizer JS (js/raster.js), il motore
//       che definisce il contratto della collab;
//   (B) kernel WGSL (js/wgpu_dab.js) su un buffer regione 1024², maschere
//       dalla STESSA StampCache (il float resta su CPU in entrambi i path).
// Pretesa: 0 byte diversi, e zero scritture GPU fuori dai chunk del
// riferimento. Speculare a js/raster_worker_test.mjs.

import { ChunkStore, CHUNK } from './store.js';
import { StampCache } from './brush.js';
import { Rasterizer } from './raster.js';
import { DabQueue, T_DAB } from './stroke.js';
import { mulberry32 } from './util.js';
import { WgpuDabKernel, DAB_STRIDE_U32 } from './wgpu_dab.js';

const W = 1024, H = 1024;
const ENTRY = 10; // stride descrittori (stroke.js STRIDE)

/** @type {(s: string) => void} */
let print = (s) => console.log(s);
let failures = 0;

/** @param {boolean} ok @param {string} msg */
function check(ok, msg) {
  print((ok ? 'ok   ' : 'FAIL ') + msg);
  if (!ok) failures++;
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

/**
 * Fotografa una lista di dab come stream f32 (gli stessi arrotondamenti f32
 * che vede il run del raster: r/alpha/angle vanno letti DA QUI, non dai f64).
 * @param {{x:number,y:number,r:number,a:number,angle?:number,cr?:number,cg?:number,cb?:number}[]} dabs
 */
function toStream(dabs) {
  const s = new Float32Array(dabs.length * ENTRY);
  for (let i = 0; i < dabs.length; i++) {
    const d = dabs[i], o = i * ENTRY;
    s[o] = T_DAB;
    s[o + 1] = d.x; s[o + 2] = d.y; s[o + 3] = d.r; s[o + 4] = d.a;
    s[o + 5] = d.angle ?? 0;
    s[o + 6] = d.cr ?? 30; s[o + 7] = d.cg ?? 90; s[o + 8] = d.cb ?? 200;
    s[o + 9] = 0;
  }
  return s;
}

/** dab casuali dentro e a cavallo del clip (stesso spirito del worker test)
 * @param {() => number} rnd @param {number} n
 * @param {{x0:number,y0:number,x1:number,y1:number}} clip @param {number} rMax */
function randomDabs(rnd, n, clip, rMax = 60) {
  const w = clip.x1 - clip.x0 + 1, h = clip.y1 - clip.y0 + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: clip.x0 - 40 + rnd() * (w + 80),
      y: clip.y0 - 40 + rnd() * (h + 80),
      r: 0.6 + rnd() * rMax,
      a: rnd() < 0.08 ? 0 : 0.05 + rnd() * 0.95,
      angle: rnd() * 7,
      cr: (rnd() * 255) | 0, cg: (rnd() * 255) | 0, cb: (rnd() * 255) | 0,
    });
  }
  return out;
}

/**
 * Un caso: riferimento vs GPU, confronto byte-per-byte sulla regione.
 * @param {WgpuDabKernel} kernel @param {string} name @param {any} snap
 * @param {Float32Array} stream @param {{x0:number,y0:number,x1:number,y1:number}} clip
 */
async function runCase(kernel, name, snap, stream, clip) {
  const n = stream.length / ENTRY;
  const cache = new StampCache();

  // ---- path A: riferimento ----
  const refStore = new ChunkStore('ref', null);
  const refRaster = new Rasterizer(refStore, cache, null);
  refRaster.beginStroke(snap, clip, null, null);
  const q = new DabQueue();
  for (let i = 0; i < n; i++) {
    const o = i * ENTRY;
    q.push(stream[o], stream[o + 1], stream[o + 2], stream[o + 3], stream[o + 4],
      stream[o + 5], stream[o + 6], stream[o + 7], stream[o + 8], stream[o + 9]);
  }
  const tRef0 = performance.now();
  refRaster.run(q, Infinity);
  const refMs = performance.now() - tRef0;

  // ---- path B: kernel WGSL ----
  // record dab dalla STESSA testa di _dab: stamp dalla cache condivisa,
  // ix/iy con Math.round, a255 con lo stesso arrotondamento; il float vive
  // tutto qui su CPU, al kernel arrivano solo interi
  /** @type {Map<object, number>} */
  const atlasOff = new Map();
  /** @type {Uint8Array[]} */
  const atlasParts = [];
  let atlasBytes = 0;
  const recs = new Uint32Array(n * DAB_STRIDE_U32);
  const recsI = new Int32Array(recs.buffer);
  let nRecs = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ENTRY;
    const x = stream[o + 1], y = stream[o + 2], r = stream[o + 3], a = stream[o + 4];
    const angle = stream[o + 5];
    const a255 = Math.min(255, (a * 255 + 0.5) | 0);
    if (a255 === 0) continue; // il riferimento scarta il dab in testa
    const stamp = cache.getStamp(r, snap.hardness, snap.roundness, angle,
      snap.shape, snap.shapeInvert);
    let off = atlasOff.get(stamp);
    if (off === undefined) {
      off = atlasBytes;
      atlasOff.set(stamp, off);
      atlasParts.push(stamp.mask);
      atlasBytes += stamp.mask.length;
    }
    const ro = nRecs * DAB_STRIDE_U32;
    recsI[ro] = Math.round(x - stamp.half);
    recsI[ro + 1] = Math.round(y - stamp.half);
    recs[ro + 2] = stamp.size;
    recs[ro + 3] = off;
    recs[ro + 4] = a255;
    recs[ro + 5] = stream[o + 6]; recs[ro + 6] = stream[o + 7]; recs[ro + 7] = stream[o + 8];
    recs[ro + 8] = snap.buildup ? 1 : 0;
    nRecs++;
  }
  const atlas = new Uint8Array(atlasBytes);
  { let p = 0; for (const part of atlasParts) { atlas.set(part, p); p += part.length; } }

  const gpuPix = new Uint8Array(W * H * 4);
  const gpuMs = await kernel.runBatch(gpuPix, W, H, 0, 0, atlas,
    recs.subarray(0, nRecs * DAB_STRIDE_U32), nRecs, clip);

  // ---- confronto ----
  let diff = 0, refPainted = 0;
  const covered = new Uint8Array((W >> 8) * (H >> 8)); // celle chunk del ref
  refStore.map.forEach((chunk) => {
    const bx = chunk.cx * CHUNK, by = chunk.cy * CHUNK;
    if (bx < 0 || by < 0 || bx >= W || by >= H) return;
    covered[(chunk.cy << 2) + chunk.cx] = 1;
    const cd = chunk.data;
    for (let yy = 0; yy < CHUNK; yy++) {
      const gBase = ((by + yy) * W + bx) * 4;
      const cBase = (yy * CHUNK) * 4;
      for (let k = 0; k < CHUNK * 4; k++) {
        if (cd[cBase + k] !== gpuPix[gBase + k]) diff++;
        if (cd[cBase + k] !== 0) refPainted++;
      }
    }
  });
  // fuori dai chunk del riferimento la GPU non deve aver scritto nulla
  let spurious = 0;
  for (let cyc = 0; cyc < (H >> 8); cyc++) {
    for (let cxc = 0; cxc < (W >> 8); cxc++) {
      if (covered[(cyc << 2) + cxc]) continue;
      const bx = cxc * CHUNK, by = cyc * CHUNK;
      for (let yy = 0; yy < CHUNK; yy++) {
        const gBase = ((by + yy) * W + bx) * 4;
        for (let k = 0; k < CHUNK * 4; k++) if (gpuPix[gBase + k] !== 0) spurious++;
      }
    }
  }
  check(diff === 0, `${name}: 0 byte diversi (${diff}; ref ha ${refPainted} byte dipinti, ` +
    `${nRecs}/${n} dab, atlas ${(atlasBytes / 1024).toFixed(0)}KB, ` +
    `js ${refMs.toFixed(1)}ms vs gpu ${gpuMs.toFixed(1)}ms)`);
  check(spurious === 0, `${name}: nessuna scrittura GPU fuori dai chunk del riferimento (${spurious})`);
}

export async function runAll() {
  print('kernel WebGPU dab vs Rasterizer JS — regione 1024², descrittori f32 condivisi');
  const kernel = new WgpuDabKernel();
  if (!(/** @type {any} */ (navigator).gpu)) {
    print('navigator.gpu ASSENTE — il contesto non è sicuro (serve HTTPS o localhost) ' +
      'oppure il browser non espone WebGPU. isSecureContext = ' + window.isSecureContext);
    print('Se isSecureContext è true: il browser non ha WebGPU attivo — su iPhone/iPad ' +
      'vecchi va acceso in Impostazioni > Safari > Avanzate > Feature Flags > WebGPU.');
    print('UA: ' + navigator.userAgent);
    return { ok: false, failures: -1, webgpu: false };
  }
  const okInit = await kernel.init();
  if (!okInit) {
    print('WebGPU presente ma nessun adapter/device: GPU in blocklist o limiti del device.');
    print('UA: ' + navigator.userAgent);
    return { ok: false, failures: -1, webgpu: false };
  }
  const clip = { x0: 0, y0: 0, x1: 1023, y1: 1023 };

  await runCase(kernel, 'wash tondo', makeSnap(),
    toStream(randomDabs(mulberry32(11), 140, clip)), clip);
  await runCase(kernel, 'wash soft (hardness 0)', makeSnap({ hardness: 0 }),
    toStream(randomDabs(mulberry32(23), 120, clip)), clip);
  await runCase(kernel, 'wash duro (hardness 1, banda AA 1px)', makeSnap({ hardness: 1 }),
    toStream(randomDabs(mulberry32(31), 120, clip)), clip);

  // tie-break wash: dab coincidenti, stessa alpha, colori diversi — l'ordine
  // decide (>= : vince l'ultimo). Poi scalette di alpha su e giu'.
  const tb = [];
  for (let i = 0; i < 24; i++) tb.push({ x: 300.37, y: 412.81, r: 40, a: 0.5, cr: i * 10, cg: 255 - i * 10, cb: 7 * i });
  for (let i = 0; i < 16; i++) tb.push({ x: 600.5, y: 200.5, r: 30, a: 0.2 + i * 0.05, cr: 200, cg: i * 15, cb: 30 });
  for (let i = 0; i < 16; i++) tb.push({ x: 600.5, y: 500.5, r: 30, a: 0.95 - i * 0.05, cr: 10, cg: i * 15, cb: 200 });
  await runCase(kernel, 'tie-break e scalette di alpha', makeSnap(), toStream(tb), clip);

  await runCase(kernel, 'ellisse ruotata (roundness 0.35)', makeSnap({ roundness: 0.35 }),
    toStream(randomDabs(mulberry32(47), 120, clip)), clip);

  // buildup: accumulo lungo una linea, alpha bassa, tanti overlap
  const bu = [];
  for (let i = 0; i < 200; i++) bu.push({ x: 100 + i * 4, y: 480 + Math.sin(i / 9) * 60, r: 22, a: 0.15, cr: 180, cg: 40, cb: 90 });
  await runCase(kernel, 'buildup accumulo', makeSnap({ buildup: true }), toStream(bu), clip);

  const tight = { x0: 100, y0: 100, x1: 400, y1: 300 };
  await runCase(kernel, 'clip stretto a cavallo', makeSnap(),
    toStream(randomDabs(mulberry32(59), 120, tight, 80)), tight);

  await runCase(kernel, 'dab giganti (r 300)', makeSnap(),
    toStream([
      { x: 250, y: 250, r: 300, a: 0.8, cr: 20, cg: 120, cb: 240 },
      { x: 700, y: 300, r: 300, a: 0.45, cr: 240, cg: 80, cb: 20 },
      { x: 500, y: 700, r: 290, a: 1, cr: 60, cg: 200, cb: 60 },
      { x: -80, y: 900, r: 300, a: 0.6, cr: 200, cg: 200, cb: 0 },
    ]), clip);

  print(failures === 0 ? 'ALL WGPU DAB TESTS PASS' : `${failures} FAILURE(S)`);
  return { ok: failures === 0, failures, webgpu: true };
}

/** @param {(s: string) => void} p */
export function setPrinter(p) { print = p; }
