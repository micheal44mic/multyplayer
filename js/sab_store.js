// STROKE STORE SU SharedArrayBuffer (modalità raster worker).
// Il main è l'unica autorità: alloca gli slot (un chunk = uno slot da
// CHUNK_BYTES nel SAB), il worker ci scrive solo pixel. Il rilascio degli
// slot è DIFFERITO: azzeramento e riuso avvengono solo a worker fermo
// (drained == sent), mai sotto scritture in volo.

import { CHUNK, CHUNK_BYTES, ChunkStore, chunkKey } from './store.js';

export class SlotPool {
  constructor() {
    /** @type {SharedArrayBuffer|null} */
    this.sab = null;
    /** @type {SharedArrayBuffer|null} */
    this.touchedSab = null;
    /** @type {Uint8Array|null} vista sui flag touched scritti dal worker */
    this.touched = null;
    this.nSlots = 0;
    this._next = 0;
    /** @type {number[]} slot azzerati, pronti al riuso */
    this._free = [];
    /** @type {number[]} slot rilasciati ma forse ancora sotto scrittura */
    this._pendingZero = [];
  }

  // (Ri)dimensiona il pool. SOLO a worker fermo e store vuoto (inizio
  // tratto): un nuovo SAB butta ogni stato precedente. true = ricreato.
  /** @param {number} nSlots */
  ensure(nSlots) {
    if (this.sab && this.nSlots >= nSlots) return false;
    this.sab = new SharedArrayBuffer(nSlots * CHUNK_BYTES);
    this.touchedSab = new SharedArrayBuffer(nSlots);
    this.touched = new Uint8Array(this.touchedSab);
    this.nSlots = nSlots;
    this._next = 0;
    this._free.length = 0;
    this._pendingZero.length = 0;
    return true;
  }

  // -1 = esaurito (il chiamante fa flush+recycle o fallback)
  alloc() {
    const s = this._free.pop();
    if (s !== undefined) return s;
    if (this._next < this.nSlots) return this._next++;
    return -1;
  }

  /** @param {number} slot */
  view(slot) {
    return new Uint8ClampedArray(/** @type {any} */ (this.sab), slot * CHUNK_BYTES, CHUNK_BYTES);
  }

  /** @param {number} slot */
  releaseDeferred(slot) {
    this._pendingZero.push(slot);
  }

  // Da chiamare SOLO quando il worker ha drenato tutto il mandato: azzera
  // gli slot in attesa (pixel e flag touched) e li rende riusabili.
  recycle() {
    for (const s of this._pendingZero) {
      this.view(s).fill(0);
      if (this.touched) this.touched[s] = 0;
      this._free.push(s);
    }
    this._pendingZero.length = 0;
  }

  get pendingCount() { return this._pendingZero.length; }
}

// ChunkStore coi dati negli slot del pool: il renderer ci fa gli upload
// come su qualunque store, commit/endPass lo leggono/scrivono dal main.
// ptr resta 0 (MAI passare questi chunk ai kernel wasm del main).
export class SabStrokeStore extends ChunkStore {
  /** @param {string} name @param {SlotPool} pool */
  constructor(name, pool) {
    super(name, null);
    this.pool = pool;
    /** @type {Map<import('./store.js').Chunk, number>} chunk -> slot */
    this.slotOf = new Map();
  }

  /** @param {number} cx @param {number} cy */
  getOrCreate(cx, cy) {
    const key = chunkKey(cx, cy);
    let c = this.map.get(key);
    if (c !== undefined) return c;
    const slot = this.pool.alloc();
    // esaurimento (non deve succedere: il bridge dimensiona sul board e
    // ricicla a ogni flush) — buffer staccato per non corrompere, il worker
    // farà lo stesso: il chunk resta vuoto ma niente scritture selvagge
    const data = slot >= 0 ? this.pool.view(slot)
      : (console.error('[sab_store] pool esaurito', this.name), new Uint8ClampedArray(CHUNK_BYTES));
    c = this._pool.pop();
    if (c === undefined) {
      c = {
        key: 0, cx: 0, cy: 0, data, ptr: 0,
        tex: null, texDirty: true, touched: false,
        c2d: null, c2dDirty: true,
        dirX0: CHUNK, dirY0: CHUNK, dirX1: -1, dirY1: -1,
        mips: false, mipOn: false, magNear: true,
      };
    } else {
      c.data = data;
    }
    c.key = key; c.cx = cx; c.cy = cy; c.texDirty = true; c.c2dDirty = true; c.touched = false;
    c.dirX0 = CHUNK; c.dirY0 = CHUNK; c.dirX1 = -1; c.dirY1 = -1;
    c.mips = false;
    if (slot >= 0) this.slotOf.set(c, slot);
    this.map.set(key, c);
    return c;
  }

  /** @param {import('./store.js').Chunk} c */
  slotFor(c) {
    const s = this.slotOf.get(c);
    return s === undefined ? -1 : s;
  }

  // Endpass asincrono: il chunk resta in mappa coi PIXEL VECCHI visibili
  // (data non cambia), ma il protocollo da qui in poi usa uno slot NUOVO —
  // il worker ridisegna la punta lì, e lo scambio data→slot nuovo avviene
  // solo a replay finito (bridge._trySwap). Ritorna i due slot per il
  // rilascio differito del vecchio; null = pool pieno, il chunk TIENE lo
  // slot vecchio (punta non rastremata su quel chunk: degradazione visiva,
  // MAI perdita di pixel — il chiamante lo esclude dal clip del replay).
  /** @param {import('./store.js').Chunk} c */
  rebindFresh(c) {
    const old = this.slotOf.get(c);
    const slot = this.pool.alloc();
    if (slot < 0) return null;
    this.slotOf.set(c, slot);
    return { oldSlot: old === undefined ? -1 : old, newSlot: slot };
  }

  // Come la base ma SENZA azzerare i pixel (lo slot può essere ancora sotto
  // scrittura del worker): lo slot va in pendingZero, il chunk-oggetto viene
  // pooled con un buffer staccato vuoto (tiene viva la texture GPU riusabile).
  /** @param {import('./store.js').Chunk} c @param {(c: import('./store.js').Chunk) => void} disposeTex @param {boolean} forceDispose */
  _release(c, disposeTex, forceDispose) {
    const slot = this.slotOf.get(c);
    if (slot !== undefined) {
      this.pool.releaseDeferred(slot);
      this.slotOf.delete(c);
    }
    c.data = EMPTY;
    c.touched = false;
    if (this._pool.length < 64) {
      if (forceDispose && disposeTex) disposeTex(c);
      this._pool.push(c);
    } else if (disposeTex) {
      disposeTex(c);
    }
  }
}

const EMPTY = new Uint8ClampedArray(CHUNK_BYTES); // placeholder dei pooled
