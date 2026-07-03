// Entry del raster worker: guscio onmessage attorno a WorkerEngine
// (vedi raster_worker_core.js e docs/raster-worker-design.md).
// Il core wasm si carica in parallelo: finché non c'è (o se manca/fallisce)
// si rasterizza in JS — stesso output byte per byte; lo swap avviene solo
// a inizio tratto. Il messaggio 'ready' dice al main che il modulo è stato
// valutato: se onerror scatta prima, l'errore è di EVAL (diagnostica Safari).

import { WorkerEngine } from './raster_worker_core.js';
import { WasmHeap } from './wasm_core.js';

const engine = new WorkerEngine();

self.onmessage = (/** @type {MessageEvent} */ e) => {
  engine.handle(e.data);
};

self.postMessage({ t: 'ready' });

WasmHeap.load(new URL('./raster_core.wasm', import.meta.url)).then((heap) => {
  // artefatto vecchio in cache senza i kernel del paint = si resta in JS
  if (heap && heap.exports.dab && heap.exports.capsule &&
    heap.exports.dab_tex_tile && heap.exports.capsule_tex) {
    engine.attachHeap(heap);
    console.info('[raster_worker] core wasm+SIMD attivo nel worker');
  } else {
    self.postMessage({ t: 'ready', err: heap ? 'export mancanti' : 'load fallito (fallback JS)' });
  }
});
