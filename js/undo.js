// UNDO tile-diff. Per ogni stroke salva i chunk "prima" (null = non esisteva).
// La compressione avviene nel worker, mai nel path del dito.
// undo/redo sono swap: prima di ripristinare si fotografa lo stato corrente.

import { CHUNK_BYTES, keyCx, keyCy } from './store.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

/**
 * Stato "prima" di un chunk. buf è raw (ArrayBuffer di CHUNK_BYTES) o
 * compresso deflate-raw se zip è true; null se il chunk non esisteva.
 * @typedef {Object} UndoChunk
 * @property {number} key
 * @property {number} cx
 * @property {number} cy
 * @property {boolean} existed
 * @property {ArrayBuffer|null} buf
 * @property {number} rawSize
 * @property {boolean} [zip]
 */

/**
 * @typedef {Object} UndoEntry
 * @property {UndoChunk[]} chunks
 * @property {number} rawSize
 * @property {boolean} compressed
 * @property {Promise<any>} ready
 */

const MAX_ENTRIES = 64;
const MAX_RAW_BYTES = 256 * 1024 * 1024; // budget equivalente non compresso

let nextMsgId = 1;

export class UndoManager {
  /** @param {() => void} [onChange] */
  constructor(onChange) {
    /** @type {UndoEntry[]} */
    this.undoStack = [];
    /** @type {UndoEntry[]} */
    this.redoStack = [];
    this.rawBytes = 0;        // somma dei rawSize in stack (per il cap)
    this.storedBytes = 0;     // byte realmente in memoria (compressi o raw)
    this.onChange = onChange || (() => {});
    this.busy = false;        // un'operazione undo/redo alla volta
    /** @type {UndoEntry|null} */
    this._entry = null;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
    this._pending = new Map(); // msgId -> {resolve, reject}

    /** @type {Worker|null} */
    this.worker = null;
    try {
      this.worker = new Worker(new URL('./undo_worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const p = this._pending.get(e.data.id);
        if (!p) return;
        this._pending.delete(e.data.id);
        e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error));
      };
      this.worker.onerror = () => { this.worker = null; };
    } catch {
      this.worker = null;
    }
  }

  /**
   * @param {{id: number, op: string, buffers: {key: number, buf: ArrayBuffer|null, rawSize?: number}[]}} msg
   * @param {Transferable[]} transfer
   * @returns {Promise<any>}
   */
  _send(msg, transfer) {
    return new Promise((resolve, reject) => {
      this._pending.set(msg.id, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  // ---- cattura (chiamata da commitStroke) ----
  captureBegin() {
    this._entry = { chunks: [], rawSize: 0, compressed: false, ready: Promise.resolve() };
  }

  /**
   * @param {number} key @param {number} cx @param {number} cy
   * @param {Uint8ClampedArray<ArrayBuffer>|null} beforeDataOrNull
   */
  captureChunk(key, cx, cy, beforeDataOrNull) {
    const e = this._entry;
    if (!e) return;
    if (beforeDataOrNull) {
      // copia: il chunk sta per essere modificato
      const copy = beforeDataOrNull.slice().buffer;
      e.chunks.push({ key, cx, cy, existed: true, buf: copy, rawSize: CHUNK_BYTES });
      e.rawSize += CHUNK_BYTES;
    } else {
      e.chunks.push({ key, cx, cy, existed: false, buf: null, rawSize: 0 });
    }
  }

  captureEnd() {
    const e = this._entry;
    this._entry = null;
    if (!e || e.chunks.length === 0) return;

    this.undoStack.push(e);
    this.rawBytes += e.rawSize;
    this.storedBytes += e.rawSize;
    this._dropRedo();
    this._trim();
    this._compressEntry(e);
    this.onChange();
  }

  /** @param {UndoEntry} e */
  _compressEntry(e) {
    if (!this.worker) return;
    const toSend = e.chunks.filter(c => c.existed);
    if (toSend.length === 0) return;
    const id = nextMsgId++;
    e.ready = this._send(
      { id, op: 'compress', buffers: toSend.map(c => ({ key: c.key, buf: c.buf })) },
      toSend.map(c => c.buf)
    ).then((res) => {
      if (res.raw) {
        // fallback: i buffer tornano com'erano
        for (const item of res.buffers) {
          const c = e.chunks.find(k => k.key === item.key && k.existed);
          if (c) c.buf = item.buf;
        }
        return;
      }
      let stored = 0;
      for (const item of res.buffers) {
        const c = e.chunks.find(k => k.key === item.key && k.existed);
        if (c) { c.buf = item.buf; c.zip = true; stored += item.buf.byteLength; }
      }
      this.storedBytes -= e.rawSize;
      this.storedBytes += stored;
      e.compressed = true;
      this.onChange();
    }).catch(() => { /* resta raw */ });
  }

  /** @param {UndoEntry} e */
  async _materialize(e) {
    // riporta tutti i chunk dell'entry a raw (decomprimendo se serve)
    await e.ready;
    const zipped = e.chunks.filter(c => c.existed && c.zip);
    if (zipped.length === 0) return;
    const id = nextMsgId++;
    const res = await this._send(
      { id, op: 'decompress', buffers: zipped.map(c => ({ key: c.key, buf: c.buf, rawSize: c.rawSize })) },
      zipped.map(c => c.buf)
    );
    for (const item of res.buffers) {
      const c = e.chunks.find(k => k.key === item.key && k.existed);
      if (c) { c.buf = item.buf; c.zip = false; }
    }
  }

  _dropRedo() {
    for (const e of this.redoStack) this._account(e, -1);
    this.redoStack.length = 0;
  }

  /** @param {UndoEntry} e @param {number} sign */
  _account(e, sign) {
    this.rawBytes += sign * e.rawSize;
    let stored = 0;
    for (const c of e.chunks) if (c.existed && c.buf) stored += c.buf.byteLength;
    this.storedBytes += sign * stored;
  }

  _trim() {
    while (this.undoStack.length > MAX_ENTRIES || this.rawBytes > MAX_RAW_BYTES) {
      const e = this.undoStack.shift();
      if (!e) break;
      this._account(e, -1);
    }
  }

  // ---- applicazione ----
  // restore scambia lo stato: cattura il "corrente" per la direzione opposta.
  /** @param {UndoEntry} entry @param {ChunkStore} docStore @param {(c: Chunk) => void} disposeTex */
  async _apply(entry, docStore, disposeTex) {
    await this._materialize(entry);

    /** @type {UndoEntry} */
    const counter = { chunks: [], rawSize: 0, compressed: false, ready: Promise.resolve() };
    for (const c of entry.chunks) {
      const cur = docStore.getByKey(c.key);
      if (cur) {
        counter.chunks.push({ key: c.key, cx: c.cx, cy: c.cy, existed: true, buf: cur.data.slice().buffer, rawSize: CHUNK_BYTES });
        counter.rawSize += CHUNK_BYTES;
      } else {
        counter.chunks.push({ key: c.key, cx: c.cx, cy: c.cy, existed: false, buf: null, rawSize: 0 });
      }

      if (c.existed) {
        const chunk = docStore.getOrCreate(c.cx, c.cy);
        chunk.data.set(new Uint8ClampedArray(c.buf));
        chunk.touched = true;
        docStore.markDirty(chunk);
      } else {
        docStore.remove(c.key, disposeTex);
      }
    }
    return counter;
  }

  /** @param {ChunkStore} docStore @param {(c: Chunk) => void} disposeTex */
  async undo(docStore, disposeTex) {
    if (this.busy || this.undoStack.length === 0) return false;
    this.busy = true;
    try {
      const e = this.undoStack.pop();
      this._account(e, -1);
      const counter = await this._apply(e, docStore, disposeTex);
      this.redoStack.push(counter);
      this._account(counter, +1);
      this._compressEntry(counter);
    } finally {
      this.busy = false;
      this.onChange();
    }
    return true;
  }

  /** @param {ChunkStore} docStore @param {(c: Chunk) => void} disposeTex */
  async redo(docStore, disposeTex) {
    if (this.busy || this.redoStack.length === 0) return false;
    this.busy = true;
    try {
      const e = this.redoStack.pop();
      this._account(e, -1);
      const counter = await this._apply(e, docStore, disposeTex);
      this.undoStack.push(counter);
      this._account(counter, +1);
      this._compressEntry(counter);
    } finally {
      this.busy = false;
      this.onChange();
    }
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.rawBytes = 0;
    this.storedBytes = 0;
    this.onChange();
  }

  get canUndo() { return this.undoStack.length > 0 && !this.busy; }
  get canRedo() { return this.redoStack.length > 0 && !this.busy; }
}
