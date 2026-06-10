// BENCHMARK del rasterizer — deterministico e riutilizzabile.
// Dalla console (dopo un reload, per azzerare il seed degli stroke):
//   import('./js/bench.js').then(m => console.log(JSON.stringify(m.runBench(window.__app), null, 2)))
// Ogni scenario genera stroke sintetici, drena la coda con budget infinito e
// misura raster + commit. Il checksum FNV dei pixel del documento (rep 0)
// verifica che due motori producano lo stesso identico output.

import { defaultGrainTexture } from './texture.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./brush.js').Brush} Brush */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

/** @type {Brush} */
const BASE = {
  size: 24, opacity: 1, hardness: 0.85, smoothing: 0.35, spacing: 0.04,
  roundness: 1, angle: 0, scatter: false, particleSize: 50, particleDensity: 100,
  particleDeviation: 0, jitterPos: 0, jitterSize: 0,
  jitterOpacity: 0, jitterSpacing: 0, jitterAngle: 0, jitterBright: 0,
  jitterSat: 0, buildup: false, pressureSize: true, pressureOpacity: false,
  texture: null, textureOn: false, textureScale: 1, textureDepth: 0.5,
  textureFloor: 0.25, textureContrast: 1, textureInvert: false, textureMoving: false,
  textureUseColor: false,
  color: { r: 26, g: 26, b: 31 }, tool: 'brush',
};

// Texture deterministica (seed fisso): i checksum degli scenari texture sono
// confrontabili tra ?engine=js e wasm come tutti gli altri.
const GRAIN = defaultGrainTexture();

/**
 * @typedef {Object} Scenario
 * @property {string} name
 * @property {Partial<Brush>} brush
 * @property {number} points
 * @property {Partial<Brush>} [prep]  pennellata di base da committare prima (es. per la gomma)
 */

/** @type {Scenario[]} */
const SCENARIOS = [
  { name: 'dab-piccolo-duro', brush: {}, points: 500 },
  { name: 'dab-grande-morbido', brush: { size: 160, hardness: 0.15 }, points: 300 },
  { name: 'capsule-continua', brush: { size: 80, hardness: 0.5, spacing: 0.001 }, points: 500 },
  { name: 'buildup-airbrush', brush: { size: 60, hardness: 0, spacing: 0.01, buildup: true, opacity: 0.35 }, points: 400 },
  { name: 'jitter-scatter', brush: { size: 48, hardness: 0.6, spacing: 0.08, roundness: 0.6, scatter: true, particleDensity: 100, particleSize: 40, particleDeviation: 0, jitterPos: 0.3, jitterSize: 0.3, jitterOpacity: 0.3, jitterAngle: 0.4, jitterBright: 0.2, jitterSat: 0.15 }, points: 400 },
  { name: 'gomma-grande', brush: { size: 120, hardness: 0.5, tool: 'eraser' }, points: 300, prep: { size: 160, hardness: 0.3 } },
  { name: 'texture-carta', brush: { size: 64, hardness: 0.7, spacing: 0.08, texture: GRAIN, textureOn: true, textureDepth: 0.8 }, points: 400 },
  { name: 'texture-capsula', brush: { size: 160, hardness: 0.7, spacing: 0.002, texture: GRAIN, textureOn: true, textureDepth: 0.8 }, points: 400 },
  { name: 'texture-capsula-colore', brush: { size: 160, hardness: 0.7, spacing: 0.002, texture: GRAIN, textureOn: true, textureDepth: 0.5, textureUseColor: true }, points: 400 },
  { name: 'texture-moving', brush: { size: 48, hardness: 0.6, spacing: 0.1, texture: GRAIN, textureOn: true, textureDepth: 1, textureContrast: 1.5, textureMoving: true }, points: 400 },
  { name: 'texture-colore', brush: { size: 64, hardness: 0.7, spacing: 0.08, texture: GRAIN, textureOn: true, textureDepth: 0.6, textureUseColor: true }, points: 400 },
];

// Traiettoria sinusoidale fissa: copre più chunk, pressione a campana.
/** @param {number} n @returns {{x: number, y: number, p: number}[]} */
function makePath(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    out.push({
      x: -1300 + t * 2600,
      y: -400 + Math.sin(t * Math.PI * 5) * 200,
      p: 0.25 + 0.75 * Math.sin(t * Math.PI),
    });
  }
  return out;
}

// FNV-1a a 32 bit sui pixel (parole u32) di tutti i chunk, in ordine di chiave.
// byteOffset esplicito: il buffer può essere la memoria lineare wasm.
/** @param {ChunkStore} store */
export function checksum(store) {
  let h = 0x811c9dc5 >>> 0;
  const keys = [...store.map.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    h = Math.imul(h ^ k, 16777619) >>> 0;
    const d = store.map.get(k).data;
    const u = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
  }
  return h >>> 0;
}

// Esegue una pennellata completa: sampling sincrono, raster a budget infinito,
// commit immediato. Ritorna le misure (il sampling non è incluso nel raster).
/** @param {App} app @param {Brush} cfg @param {{x: number, y: number, p: number}[]} path */
function runStroke(app, cfg, path) {
  app.engine.begin(path[0].x, path[0].y, path[0].p, cfg);
  app.raster.beginStroke(app.engine.snap);
  app.strokeLive = true;
  for (let i = 1; i < path.length - 1; i++) app.engine.move(path[i].x, path[i].y, path[i].p);
  const last = path[path.length - 1];
  app.engine.end(last.x, last.y, last.p);

  const t0 = performance.now();
  const px = app.raster.run(app.queue, Infinity);
  const rasterMs = performance.now() - t0;
  const dabs = app.raster.lastDabs;

  const t1 = performance.now();
  app._beginCommit();
  app._runCommit(Infinity);
  const commitMs = performance.now() - t1;

  return { px, dabs, rasterMs, commitMs };
}

/**
 * @param {App} app
 * @param {number} [reps] ripetizioni per scenario (vince la migliore; la rep 0 scalda la StampCache)
 */
export function runBench(app, reps = 3) {
  /** @type {Record<string, {dabs: number, px: number, rasterMs: number, mpxS: number, commitMs: number, chunks: number, checksum: string}>} */
  const results = {};
  for (const sc of SCENARIOS) {
    const cfg = /** @type {Brush} */ ({ ...BASE, ...sc.brush });
    const path = makePath(sc.points);
    let best = null;
    let sum = '';
    for (let rep = 0; rep < reps; rep++) {
      app.clearAll();
      if (sc.prep) {
        runStroke(app, /** @type {Brush} */ ({ ...BASE, ...sc.prep }), makePath(300));
      }
      const r = runStroke(app, cfg, path);
      if (rep === 0) sum = checksum(app.docStore).toString(16);
      if (!best || r.rasterMs < best.rasterMs) best = r;
    }
    results[sc.name] = {
      dabs: best.dabs,
      px: best.px,
      rasterMs: +best.rasterMs.toFixed(2),
      mpxS: +(best.px / 1e6 / (best.rasterMs / 1000)).toFixed(1),
      commitMs: +best.commitMs.toFixed(2),
      chunks: app.docStore.count,
      checksum: sum,
    };
  }
  app.clearAll();
  return results;
}
