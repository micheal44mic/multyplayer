// MOTORE DEL RASTER WORKER — puro, senza onmessage (testabile in Node).
// Esegue lo STESSO Rasterizer del main sui chunk del tratto. Due modalità,
// entrambe bit-exact per contratto (test differenziali wasm/test.mjs e
// js/raster_worker_test.mjs):
// - JS (avvio, o wasm assente): i chunk scrivono DIRETTAMENTE negli slot SAB;
// - WASM+SIMD (appena il modulo è caricato, swap SOLO a inizio tratto): i
//   chunk vivono nella memoria wasm del worker (i kernel vogliono pointer
//   nella LORO memoria lineare) e a fine batch i soli rect sporchi vengono
//   ricopiati negli slot SAB — il main continua a leggere il SAB, protocollo
//   invariato, costo = una memcpy dei pixel toccati (≈ ciò che comunque si
//   carica in GPU).
// Il worker NON decide struttura: getOrCreate senza binding è un bug
// (buffer staccato per non corrompere).

import { StampCache } from './brush.js';
import { Rasterizer } from './raster.js';
import { CHUNK, CHUNK_BYTES, keyCx, keyCy } from './store.js';
import { CTL_DRAINED, ENTRY_STRIDE, reviveSnap } from './raster_shared.js';

// Store minimo duck-typed per Rasterizer/forEachChunkInRect: mappa key->chunk
// con binding espliciti dal main; markDirty accumula i rect (usati da
// _maskSelection nel run e dal copy-out del batch, poi azzerati).
class WorkerStore {
  /** @param {(slot: number) => Uint8ClampedArray} view */
  constructor(view) {
    /** @type {Map<number, any>} */
    this.map = new Map();
    /** @type {Set<any>} */
    this.dirty = new Set();
    this.ver = 0;
    this._view = view;
    /** @type {import('./wasm_core.js').WasmHeap|null} */
    this.heap = null;
  }

  /** @param {number} key @param {number} slot */
  bind(key, slot) {
    if (this.map.has(key)) return;
    const sview = slot >= 0 ? this._view(slot)
      : (console.error('[raster_worker] slot mancante per', key), new Uint8ClampedArray(CHUNK_BYTES));
    let ptr = 0, data = sview;
    if (this.heap) {
      // modalità wasm: pixel nella memoria lineare (l'alloc può fare grow:
      // onGrow rigenera le viste dei chunk già legati PRIMA di questa)
      ptr = this.heap.alloc(CHUNK_BYTES);
      data = this.heap.u8c(ptr, CHUNK_BYTES);
      data.fill(0); // lo slab riusa i blocchi: dentro possono esserci pixel vecchi
    }
    this.map.set(key, {
      key, cx: keyCx(key), cy: keyCy(key),
      data, ptr, slot, sview,
      touched: false, _touched: false,
      dirX0: CHUNK, dirY0: CHUNK, dirX1: -1, dirY1: -1,
    });
  }

  /** @param {number} cx @param {number} cy */
  getOrCreate(cx, cy) {
    const key = ((cx + 32768) << 16) | (cy + 32768);
    let c = this.map.get(key);
    if (c === undefined) {
      // il main non ha simulato questo chunk: divergenza di geometria — mai
      // atteso (test differenziale); buffer staccato, il chunk resterà vuoto
      console.error('[raster_worker] chunk non previsto dal main', cx, cy);
      this.bind(key, -1);
      c = this.map.get(key);
    }
    return c;
  }

  /** @param {number} cx @param {number} cy */
  get(cx, cy) {
    return this.map.get(((cx + 32768) << 16) | (cy + 32768));
  }

  /** @param {number} key */
  getByKey(key) { return this.map.get(key); }

  // Pass finale del taper: il main ha svuotato questi chunk sul mirror; qui
  // muore il binding (il replay li ricrea con slot NUOVI decisi dal main).
  /** @param {number} key */
  removeKey(key) {
    const c = this.map.get(key);
    if (!c) return;
    this.map.delete(key);
    this.dirty.delete(c);
    if (this.heap && c.ptr) this.heap.free(c.ptr, CHUNK_BYTES);
  }

  /** @param {any} chunk @param {number} [lx0] @param {number} [ly0] @param {number} [lx1] @param {number} [ly1] */
  markDirty(chunk, lx0 = 0, ly0 = 0, lx1 = CHUNK - 1, ly1 = CHUNK - 1) {
    this.ver++;
    this.dirty.add(chunk);
    if (lx0 < chunk.dirX0) chunk.dirX0 = lx0;
    if (ly0 < chunk.dirY0) chunk.dirY0 = ly0;
    if (lx1 > chunk.dirX1) chunk.dirX1 = lx1;
    if (ly1 > chunk.dirY1) chunk.dirY1 = ly1;
  }

  // memory.grow ha staccato il buffer: rigenera le viste dei chunk wasm
  refreshViews() {
    if (!this.heap) return;
    for (const c of this.map.values()) {
      if (c.ptr) c.data = this.heap.u8c(c.ptr, CHUNK_BYTES);
    }
  }

  clear() {
    if (this.heap) {
      for (const c of this.map.values()) {
        if (c.ptr) this.heap.free(c.ptr, CHUNK_BYTES);
      }
    }
    this.map.clear();
    this.dirty.clear();
  }
}

// Vista-coda su un batch Float32Array: l'interfaccia che Rasterizer.run
// consuma (buf/count/peekOffset/pop/clear), senza copie.
class BatchQueue {
  constructor() {
    /** @type {Float32Array} */
    this.buf = new Float32Array(0);
    this.count = 0;
    this._head = 0;
  }
  /** @param {Float32Array} buf @param {number} n */
  load(buf, n) { this.buf = buf; this.count = n; this._head = 0; }
  peekOffset() { return this._head * ENTRY_STRIDE; }
  pop() { this._head++; this.count--; }
  clear() { this.count = 0; }
}

export class WorkerEngine {
  constructor() {
    /** @type {Int32Array|null} */
    this.ctl = null;
    /** @type {Uint8Array|null} */
    this.touched = null;
    /** @type {SharedArrayBuffer|ArrayBuffer|null} */
    this.slots = null;
    /** @type {Map<number, any>} id -> texture/shape */
    this.assets = new Map();
    this.store = new WorkerStore(
      (slot) => new Uint8ClampedArray(/** @type {any} */ (this.slots), slot * CHUNK_BYTES, CHUNK_BYTES),
    );
    this.raster = new Rasterizer(/** @type {any} */ (this.store), new StampCache(), null);
    this.queue = new BatchQueue();
    this.gen = 0;
    /** @type {import('./wasm_core.js').WasmHeap|null} core caricato, in attesa dello swap */
    this._pendingHeap = null;
  }

  /**
   * Il core wasm è pronto: lo swap avviene al PROSSIMO begin (mai a metà
   * tratto — dentro un tratto il motore resta uno solo).
   * @param {import('./wasm_core.js').WasmHeap} heap
   */
  attachHeap(heap) {
    this._pendingHeap = heap;
  }

  _swapToWasm() {
    const heap = /** @type {NonNullable<typeof this._pendingHeap>} */ (this._pendingHeap);
    this._pendingHeap = null;
    this.store.heap = heap;
    const stamps = new StampCache(160, heap);
    heap.onGrow = () => {
      this.store.refreshViews();
      stamps.refreshViews();
    };
    this.raster = new Rasterizer(/** @type {any} */ (this.store), stamps, heap);
  }

  /** @param {any} m */
  handle(m) {
    switch (m.t) {
      case 'init':
        this.ctl = new Int32Array(m.ctl);
        this.slots = m.slots;
        this.touched = new Uint8Array(m.touched);
        break;
      case 'asset':
        this.assets.set(m.id, m.obj);
        break;
      case 'begin': {
        this.gen = m.gen;
        this.store.clear();
        if (this._pendingHeap) this._swapToWasm();
        const snap = reviveSnap(m.snap, this.assets);
        this.raster.beginStroke(snap, m.clip || null, m.sel || null, null);
        this.raster.clip = null;
        break;
      }
      case 'endpass': {
        // punta del taper: via i binding dei chunk svuotati dal main, e le
        // entry successive (il replay) scrivono SOLO dentro il clip — la
        // stessa semantica di _endPass, ma al passo dei kernel wasm
        if (m.gen !== this.gen) break;
        if (m.clip) {
          for (const k of m.clip) this.store.removeKey(k);
          this.raster.clip = new Set(m.clip);
        } else {
          // punta più lunga del corpo disegnato: si rifà il tratto intero
          this.store.clear();
          this.raster.clip = null;
        }
        break;
      }
      case 'entries': {
        // batch di un frame: binding prima, poi il run intero (la selezione
        // si maschera una volta per batch, come una volta per frame sul main)
        if (m.gen !== this.gen) { this._drain(m.n); break; } // tratto morto: conta e basta
        const cr = m.creations;
        for (let i = 0; i < cr.length; i += 2) this.store.bind(cr[i], cr[i + 1]);
        this.queue.load(m.buf, m.n);
        try {
          this.raster.run(/** @type {any} */ (this.queue), Infinity);
        } catch (err) {
          console.error('[raster_worker] run', err);
        }
        this._publish();
        this._drain(m.n);
        break;
      }
      case 'reset':
        this.gen = m.gen;
        this.store.clear();
        this.raster.beginStroke(null);
        this.raster.clip = null;
        break;
    }
  }

  // Chiusura del batch, PRIMA di incrementare drained: flag touched nel SAB
  // e, in modalità wasm, copy-out dei soli rect sporchi verso gli slot.
  // I rect si azzerano dopo: il prossimo batch ricopia solo il suo.
  _publish() {
    const wasm = this.store.heap !== null;
    for (const c of this.store.dirty) {
      if (c.touched && !c._touched) {
        c._touched = true;
        if (this.touched && c.slot >= 0) this.touched[c.slot] = 1;
      }
      if (c.dirX1 >= c.dirX0) {
        if (wasm && c.slot >= 0 && c.data !== c.sview) {
          const rowBytes = (c.dirX1 - c.dirX0 + 1) * 4;
          for (let ly = c.dirY0; ly <= c.dirY1; ly++) {
            const o = ((ly << 8) + c.dirX0) * 4;
            c.sview.set(c.data.subarray(o, o + rowBytes), o);
          }
        }
        c.dirX0 = CHUNK; c.dirY0 = CHUNK; c.dirX1 = -1; c.dirY1 = -1;
      }
    }
    this.store.dirty.clear();
  }

  /** @param {number} n */
  _drain(n) {
    // SEMPRE, anche su errore: il main aspetta questo contatore
    if (this.ctl) Atomics.add(this.ctl, CTL_DRAINED, n);
  }
}
