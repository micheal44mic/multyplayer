// UNDO tile-diff + operazioni di struttura sui livelli.
// Per ogni stroke salva i chunk "prima" (null = non esisteva) e il livello
// su cui è avvenuto. La compressione avviene nel worker, mai nel path del
// dito. undo/redo sono swap: prima di ripristinare si fotografa lo stato
// corrente. Le operazioni di struttura (aggiungi/elimina/sposta livello)
// sono entry leggere; un'eliminazione tiene VIVO il livello dentro l'entry
// finché questa non esce dallo stack (hook onDrop per liberarlo davvero).

import { CHUNK_BYTES, keyCx, keyCy } from './store.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./layers.js').Layer} Layer */

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
 * Entry di stroke (kind 'stroke'), di struttura (kind 'struct') o di
 * traslazione pixel (kind 'move').
 * struct: op 'attach' (il livello è in lista; undo = staccarlo),
 * op 'detach' (l'entry POSSIEDE il livello; undo = reinserirlo a index),
 * op 'move' (sposta da from a to; undo = inverso),
 * op 'replace' (rasterizza testo: l'entry POSSIEDE il livello sostituito,
 * layerId è quello vivo in lista; undo = scambiarli di nuovo),
 * op 'textform' (item del testo spostato/scalato: posizione e corpo
 * prima (x0,y0,s0) e dopo (x1,y1,s1); undo = rimettere i "prima"),
 * op 'clip' (maschera di ritaglio: v è il valore impostato; undo = rimettere
 * il precedente),
 * op 'mode' (metodo di fusione: m0 prima, m1 dopo; undo = rimettere m0).
 * move: i pixel del livello layerId sono stati traslati di dx/dy; undo =
 * traslare all'indietro e ripristinare i chunks (stati "prima" dei chunk
 * che hanno perso pixel nel clip al board — la traslazione è lossless,
 * solo il bordo va fotografato).
 * @typedef {Object} UndoEntry
 * @property {'stroke'|'struct'|'move'} kind
 * @property {UndoChunk[]} chunks
 * @property {number} rawSize
 * @property {boolean} compressed
 * @property {Promise<any>} ready
 * @property {number} [layerId] stroke/move: livello di destinazione; replace: livello vivo
 * @property {'attach'|'detach'|'move'|'replace'|'textform'|'clip'|'mode'} [op]
 * @property {Layer} [layer] solo op 'detach'/'replace'
 * @property {number} [index] solo op 'attach'/'detach'
 * @property {number} [from] solo op 'move'
 * @property {number} [to]
 * @property {number} [dx] kind 'move'
 * @property {number} [dy]
 * @property {number} [x0] op 'textform': item prima/dopo
 * @property {number} [y0] @property {number} [s0]
 * @property {number} [x1] @property {number} [y1] @property {number} [s1]
 * @property {boolean} [v] op 'clip': valore impostato del flag
 * @property {string} [m0] op 'mode': metodo prima/dopo
 * @property {string} [m1]
 * @property {number} [boardId] struct: canvas di appartenenza dell'operazione
 * @property {string} [cid] collaborazione: id dell'op ('uid:n') — l'undo
 *   mirato (undoCid) trova l'entry per id ovunque sia nello stack; il
 *   counter EREDITA il cid, così il round-trip undo↔redo resta aggangiato
 */

/**
 * Chi applica davvero le operazioni: l'App. storeFor risolve il livello di
 * uno stroke (null = livello sparito, entry da scartare in silenzio).
 * Gli id dei livelli sono globali a tutti i canvas; attach/move ricevono il
 * canvas di destinazione (boardId), detach lo ritorna.
 * @typedef {Object} UndoHost
 * @property {(layerId: number) => ChunkStore|null} storeFor
 * @property {(c: Chunk) => void} disposeTex
 * @property {(layer: Layer, index: number, boardId: number) => void} attachLayer
 * @property {(layerId: number) => {layer: Layer, index: number, boardId: number}|null} detachLayer
 * @property {(from: number, to: number, boardId: number) => void} moveLayer
 * @property {(layerId: number, dx: number, dy: number) => UndoChunk[]|null} translateLayer
 * @property {(layerId: number, x: number, y: number, size: number) => boolean} setTextForm
 * @property {(layerId: number, v: boolean) => boolean|null} setClip null = livello sparito/non raster
 * @property {(layerId: number, m: string) => string|null} setMode metodo di fusione, ritorna il precedente (null = sparito/non raster)
 */

const MAX_ENTRIES = 64;
const MAX_RAW_BYTES = 256 * 1024 * 1024; // budget equivalente non compresso

let nextMsgId = 1;

export class UndoManager {
  /** @param {() => void} [onChange] @param {(e: UndoEntry) => void} [onDrop] */
  constructor(onChange, onDrop) {
    /** @type {UndoEntry[]} */
    this.undoStack = [];
    /** @type {UndoEntry[]} */
    this.redoStack = [];
    this.rawBytes = 0;        // somma dei rawSize in stack (per il cap)
    this.storedBytes = 0;     // byte realmente in memoria (compressi o raw)
    this.onChange = onChange || (() => {});
    // un'entry esce per sempre dagli stack (trim/clear/ramo redo scartato):
    // se possiede un livello eliminato, qui lo si libera davvero
    this.onDrop = onDrop || (() => {});
    this.busy = false;        // un'operazione undo/redo alla volta
    // collaborazione: true = una nuova op NON svuota tutto il redo (il redo
    // di un utente sopravvive alle op degli ALTRI; chi tagga una nuova entry
    // butta via solo il redo del SUO autore con dropRedoByPrefix)
    this.selectiveRedo = false;
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
  /** @param {number} layerId */
  captureBegin(layerId) {
    this._entry = { kind: 'stroke', layerId, chunks: [], rawSize: 0, compressed: false, ready: Promise.resolve() };
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
    if (!this.selectiveRedo) this._dropRedo();
    this._trim();
    this._compressEntry(e);
    this.onChange();
  }

  captureCancel() {
    this._entry = null;
  }

  // Operazione di struttura già ESEGUITA dal chiamante: qui si registra solo.
  // detach: l'entry possiede il livello staccato (rawSize = i suoi byte CPU,
  // così il budget di memoria spinge fuori le eliminazioni vecchie).
  /** @param {UndoEntry} e */
  pushStruct(e) {
    e.kind = 'struct';
    e.chunks = [];
    e.compressed = false;
    e.ready = Promise.resolve();
    e.rawSize = (e.op === 'detach' || e.op === 'replace') &&
      e.layer && e.layer.store ? e.layer.store.cpuBytes : 0;
    this.undoStack.push(e);
    this.rawBytes += e.rawSize;
    if (!this.selectiveRedo) this._dropRedo();
    this._trim();
    this.onChange();
  }

  // Traslazione pixel già ESEGUITA dal chiamante: e.chunks sono gli stati
  // "prima" dei chunk persi nel clip (vanno compressi come uno stroke).
  /** @param {UndoEntry} e */
  pushMove(e) {
    e.kind = 'move';
    e.compressed = false;
    e.ready = Promise.resolve();
    e.rawSize = e.chunks.reduce((s, c) => s + c.rawSize, 0);
    this.undoStack.push(e);
    this.rawBytes += e.rawSize;
    this.storedBytes += e.rawSize;
    if (!this.selectiveRedo) this._dropRedo();
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
    for (const e of this.redoStack) { this._account(e, -1); this.onDrop(e); }
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
      this.onDrop(e);
    }
  }

  // ---- applicazione ----
  // restore scambia lo stato: cattura il "corrente" per la direzione opposta.
  // Ritorna null se il livello dello stroke non esiste più (entry scartata).
  /** @param {UndoEntry} entry @param {UndoHost} host @returns {Promise<UndoEntry|null>} */
  async _apply(entry, host) {
    const store = host.storeFor(entry.layerId);
    if (!store) return null;
    await this._materialize(entry);

    /** @type {UndoEntry} */
    const counter = { kind: 'stroke', layerId: entry.layerId, chunks: [], rawSize: 0, compressed: false, ready: Promise.resolve() };
    for (const c of entry.chunks) {
      const cur = store.getByKey(c.key);
      if (cur) {
        counter.chunks.push({ key: c.key, cx: c.cx, cy: c.cy, existed: true, buf: cur.data.slice().buffer, rawSize: CHUNK_BYTES });
        counter.rawSize += CHUNK_BYTES;
      } else {
        counter.chunks.push({ key: c.key, cx: c.cx, cy: c.cy, existed: false, buf: null, rawSize: 0 });
      }

      if (c.existed) {
        const chunk = store.getOrCreate(c.cx, c.cy);
        chunk.data.set(new Uint8ClampedArray(c.buf));
        chunk.touched = true;
        store.markDirty(chunk);
      } else {
        store.remove(c.key, host.disposeTex);
      }
    }
    return counter;
  }

  // Esegue l'INVERSO di e; il counter, ri-applicato, esegue l'inverso di sé
  // (round-trip perfetto). L'ownership del livello passa di mano: dopo un
  // undo di 'attach' è il counter ('detach') a possederlo.
  /** @param {UndoEntry} e @param {UndoHost} host @returns {UndoEntry|null} */
  _applyStruct(e, host) {
    if (e.op === 'attach') {
      const d = host.detachLayer(e.layerId);
      if (!d) return null;
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'detach', layer: d.layer, index: d.index, boardId: d.boardId,
        chunks: [], compressed: false, ready: Promise.resolve(),
        rawSize: d.layer.store ? d.layer.store.cpuBytes : 0,
      });
    }
    if (e.op === 'detach') {
      host.attachLayer(e.layer, e.index, e.boardId);
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'attach', layerId: e.layer.id, index: e.index, boardId: e.boardId,
        chunks: [], compressed: false, ready: Promise.resolve(), rawSize: 0,
      });
    }
    if (e.op === 'move') {
      host.moveLayer(e.to, e.from, e.boardId);
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'move', from: e.to, to: e.from, boardId: e.boardId,
        chunks: [], compressed: false, ready: Promise.resolve(), rawSize: 0,
      });
    }
    if (e.op === 'replace') {
      // scambia il livello vivo con quello posseduto, alla posizione attuale
      const d = host.detachLayer(e.layerId);
      if (!d) return null;
      host.attachLayer(e.layer, d.index, d.boardId);
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'replace', layer: d.layer, layerId: e.layer.id,
        boardId: d.boardId, chunks: [], compressed: false,
        ready: Promise.resolve(),
        rawSize: d.layer.store ? d.layer.store.cpuBytes : 0,
      });
    }
    if (e.op === 'clip') {
      // l'azione registrata ha impostato v: l'inverso rimette !v; il counter
      // registra come "impostato" il contrario dello stato trovato (riapplicarlo
      // riporta esattamente lì — round-trip perfetto anche se desincronizzato)
      const prev = host.setClip(e.layerId, !e.v);
      if (prev === null) return null;
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'clip', layerId: e.layerId, boardId: e.boardId,
        v: !prev, chunks: [], compressed: false, ready: Promise.resolve(), rawSize: 0,
      });
    }
    if (e.op === 'textform') {
      if (!host.setTextForm(e.layerId, e.x0, e.y0, e.s0)) return null;
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'textform', layerId: e.layerId, boardId: e.boardId,
        x0: e.x1, y0: e.y1, s0: e.s1, x1: e.x0, y1: e.y0, s1: e.s0,
        chunks: [], compressed: false, ready: Promise.resolve(), rawSize: 0,
      });
    }
    if (e.op === 'mode') {
      // rimette m0; il counter registra come "prima" lo stato trovato
      // (round-trip perfetto anche se desincronizzato, come per 'clip')
      const prev = host.setMode(e.layerId, e.m0);
      if (prev === null) return null;
      return /** @type {UndoEntry} */ ({
        kind: 'struct', op: 'mode', layerId: e.layerId, boardId: e.boardId,
        m0: prev, m1: e.m0, chunks: [], compressed: false,
        ready: Promise.resolve(), rawSize: 0,
      });
    }
    return null;
  }

  // Inverte una traslazione di pixel: trasla all'indietro (raccogliendo gli
  // eventuali persi della corsa inversa, di norma nessuno) e ripristina gli
  // stati "prima" dei chunk che il clip aveva mangiato. Il counter è la
  // stessa operazione a segno invertito: round-trip perfetto.
  /** @param {UndoEntry} e @param {UndoHost} host @returns {Promise<UndoEntry|null>} */
  async _applyMove(e, host) {
    const store = host.storeFor(e.layerId);
    if (!store) return null;
    await this._materialize(e);
    const lost = host.translateLayer(e.layerId, -e.dx, -e.dy);
    if (!lost) return null;
    for (const c of e.chunks) {
      const chunk = store.getOrCreate(c.cx, c.cy);
      chunk.data.set(new Uint8ClampedArray(c.buf));
      chunk.touched = true;
      store.markDirty(chunk);
    }
    return /** @type {UndoEntry} */ ({
      kind: 'move', layerId: e.layerId, dx: -e.dx, dy: -e.dy,
      boardId: e.boardId, chunks: lost, compressed: false,
      ready: Promise.resolve(),
      rawSize: lost.reduce((s, c) => s + c.rawSize, 0),
    });
  }

  // Scambia l'entry all'indice i (non necessariamente la cima): serve
  // all'undo collaborativo per-utente. È corretto fuori ordine perché
  // _apply/_applyStruct/_applyMove sono SWAP che fotografano lo stato
  // corrente: il counter è un round-trip perfetto qualunque cosa sia
  // successo nel frattempo. Counter scartato (livello sparito) = l'entry
  // muore davvero (onDrop libera gli eventuali livelli posseduti).
  /** @param {UndoEntry[]} fromStack @param {number} i @param {UndoEntry[]} toStack @param {UndoHost} host */
  async _swapAt(fromStack, i, toStack, host) {
    if (this.busy || i < 0 || i >= fromStack.length) return false;
    this.busy = true;
    try {
      const [e] = fromStack.splice(i, 1);
      this._account(e, -1);
      const counter = e.kind === 'struct'
        ? this._applyStruct(e, host)
        : e.kind === 'move'
          ? await this._applyMove(e, host)
          : await this._apply(e, host);
      if (counter) {
        counter.cid = e.cid; // l'identità collaborativa segue il round-trip
        toStack.push(counter);
        this._account(counter, +1);
        if (counter.kind !== 'struct') this._compressEntry(counter);
      } else {
        this.onDrop(e);
      }
    } finally {
      this.busy = false;
      this.onChange();
    }
    return true;
  }

  /** @param {UndoHost} host */
  undo(host) { return this._swapAt(this.undoStack, this.undoStack.length - 1, this.redoStack, host); }

  /** @param {UndoHost} host */
  redo(host) { return this._swapAt(this.redoStack, this.redoStack.length - 1, this.undoStack, host); }

  // ---- undo collaborativo per cid ----

  /** Ultimo indice con quel cid (le entry più recenti vincono). @param {UndoEntry[]} stack @param {string} cid */
  _indexOfCid(stack, cid) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].cid === cid) return i;
    }
    return -1;
  }

  /** Annulla l'entry con quel cid ovunque sia. false = non trovata/occupato. @param {string} cid @param {UndoHost} host */
  undoCid(cid, host) {
    return this._swapAt(this.undoStack, this._indexOfCid(this.undoStack, cid), this.redoStack, host);
  }

  /** @param {string} cid @param {UndoHost} host */
  redoCid(cid, host) {
    return this._swapAt(this.redoStack, this._indexOfCid(this.redoStack, cid), this.undoStack, host);
  }

  /** Tagga l'ultima entry pushata (quella dell'op appena conclusa). @param {string} cid */
  tagTop(cid) {
    const e = this.undoStack[this.undoStack.length - 1];
    if (e) e.cid = cid;
  }

  /** Una nuova op dell'autore butta via il SUO redo (semantica standard). @param {string} prefix 'uid:' */
  dropRedoByPrefix(prefix) {
    let dropped = false;
    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      const c = this.redoStack[i].cid;
      if (c && c.startsWith(prefix)) {
        const [e] = this.redoStack.splice(i, 1);
        this._account(e, -1);
        this.onDrop(e);
        dropped = true;
      }
    }
    if (dropped) this.onChange();
  }

  dropRedoAll() {
    this._dropRedo();
    this.onChange();
  }

  clear() {
    for (const e of this.undoStack) this.onDrop(e);
    for (const e of this.redoStack) this.onDrop(e);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.rawBytes = 0;
    this.storedBytes = 0;
    this.onChange();
  }

  get canUndo() { return this.undoStack.length > 0 && !this.busy; }
  get canRedo() { return this.redoStack.length > 0 && !this.busy; }
}
