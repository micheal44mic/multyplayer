// RASTER WORKER — pezzi condivisi main/worker (vedi docs/raster-worker-design.md).
// La simulazione di creazione chunk DEVE combaciare col Rasterizer: stessa
// taglia stamp (stampParams, bucket compresi), stesso clamp al clipRect,
// stesso early-out su alpha 0. Sigillata dal test js/raster_worker_test.mjs.

import { stampParams } from './brush.js';
import { forEachChunkInRect } from './store.js';
import { T_DAB } from './stroke.js';

// indici del ctl Int32Array (SAB): [0] = entry drenate dal worker
export const CTL_DRAINED = 0;
export const ENTRY_STRIDE = 10; // = STRIDE di stroke.js (descrittori Float32)

/**
 * Sottoinsieme dello snap che serve alla simulazione (solo geometria).
 * @typedef {{hardness: number, roundness: number,
 *   shape: import('./shape.js').BrushShape|null}} SimSnap
 */

/**
 * Simula la creazione/dirty di UNA entry della coda: chiama cb per ogni
 * chunk toccato con lo stesso rect locale che il Rasterizer passerebbe a
 * markDirty. create=true sullo store: i chunk nascono QUI (main = autorità).
 * Stessa geometria di Rasterizer._dab/_capsule; niente pixel.
 * @param {import('./store.js').ChunkStore} store
 * @param {SimSnap} snap
 * @param {Float32Array} buf @param {number} o offset dell'entry
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} clipRect
 * @param {(chunk: import('./store.js').Chunk, lx0: number, ly0: number, lx1: number, ly1: number) => void} cb
 * @param {Set<number>|null} [clipKeys] pass finale del taper: solo questi chunk
 */
export function simulateEntry(store, snap, buf, o, clipRect, cb, clipKeys = null) {
  let x0, y0, x1, y1;
  if (buf[o] === T_DAB) {
    // _dab: a255 0 = nessun lavoro (nemmeno creazioni), poi bbox dello stamp
    const a255 = Math.min(255, (buf[o + 4] * 255 + 0.5) | 0);
    if (a255 === 0) return;
    const p = stampParams(buf[o + 3], snap.hardness, snap.roundness, buf[o + 5], snap.shape);
    const ix = Math.round(buf[o + 1] - p.half);
    const iy = Math.round(buf[o + 2] - p.half);
    x0 = ix; y0 = iy; x1 = ix + p.size - 1; y1 = iy + p.size - 1;
  } else {
    // _capsule: bbox del segmento gonfiato di maxR+1
    const maxR = Math.max(buf[o + 3], buf[o + 7]) + 1;
    x0 = Math.floor(Math.min(buf[o + 1], buf[o + 5]) - maxR);
    y0 = Math.floor(Math.min(buf[o + 2], buf[o + 6]) - maxR);
    x1 = Math.ceil(Math.max(buf[o + 1], buf[o + 5]) + maxR);
    y1 = Math.ceil(Math.max(buf[o + 2], buf[o + 6]) + maxR);
  }
  if (clipRect) {
    if (x0 < clipRect.x0) x0 = clipRect.x0;
    if (y0 < clipRect.y0) y0 = clipRect.y0;
    if (x1 > clipRect.x1) x1 = clipRect.x1;
    if (y1 > clipRect.y1) y1 = clipRect.y1;
    if (x0 > x1 || y0 > y1) return;
  }
  forEachChunkInRect(store, x0, y0, x1, y1, true,
    (chunk, lx0, ly0, lx1, ly1) => cb(chunk, lx0, ly0, lx1, ly1), clipKeys);
}

/**
 * Serializza lo Snap per il worker: copia shallow dei campi dati, niente
 * funzioni/riferimenti vivi. tex/shape viaggiano per id (asset inviati una
 * volta); le LUT (Uint8Array piccole) si clonano col messaggio.
 * @param {import('./stroke.js').Snap} snap
 * @param {number} texId @param {number} shapeId 0 = assente
 */
export function serializeSnap(snap, texId, shapeId) {
  /** @type {any} */
  const out = {};
  for (const k of Object.keys(snap)) {
    const v = /** @type {any} */ (snap)[k];
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') out[k] = v;
  }
  out.texId = texId;
  out.shapeId = shapeId;
  out.texLut = snap.texLut ? snap.texLut.slice() : null;
  out.texColorLut = snap.texColorLut ? snap.texColorLut.slice() : null;
  return out;
}

/**
 * Ricostruisce lo Snap nel worker. rng/hsv/tmpRgb non servono al raster
 * (jitter e colore sono già nei descrittori); aqua è gated sul main.
 * @param {any} d @param {Map<number, any>} assets
 * @returns {import('./stroke.js').Snap}
 */
export function reviveSnap(d, assets) {
  /** @type {any} */
  const snap = { ...d };
  snap.tex = d.texId ? assets.get(d.texId) || null : null;
  snap.shape = d.shapeId ? assets.get(d.shapeId) || null : null;
  snap.texLut = d.texLut || null;
  snap.texColorLut = d.texColorLut || null;
  snap.rng = null;
  snap.hsv = { h: 0, s: 0, v: 0 };
  snap.tmpRgb = { r: 0, g: 0, b: 0 };
  snap.aqua = false; // gate: i tratti aqua non arrivano al worker
  delete snap.texId; delete snap.shapeId;
  return snap;
}
