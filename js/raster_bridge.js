// PONTE MAIN ↔ RASTER WORKER (vedi docs/raster-worker-design.md).
// Il main simula la creazione dei chunk (stessa geometria del Rasterizer,
// raster_shared.simulateEntry), assegna gli slot SAB e manda al worker
// descrittori + binding; il worker scrive solo pixel e incrementa
// ctl[DRAINED]. I dirty rect si applicano allo store specchio SOLO fino
// alle entry drenate: mai upload di pixel non ancora scritti.

import { CHUNK_SHIFT } from './store.js';
import { SlotPool, SabStrokeStore } from './sab_store.js';
import { CTL_DRAINED, ENTRY_STRIDE, simulateEntry, serializeSnap } from './raster_shared.js';

// spin di flush: oltre questo, il worker è considerato morto (tratto perso,
// semantica da contesto perso) e il bridge si spegne per sempre
const FLUSH_DEADLINE_MS = 2000;

export class RasterBridge {
  constructor() {
    this.usable = false;
    /** @type {Worker|null} */
    this.worker = null;
    this.pool = new SlotPool();
    this.store = new SabStrokeStore('stroke-sab', this.pool);
    /** @type {SharedArrayBuffer|null} */
    this.ctlSab = null;
    /** @type {Int32Array|null} */
    this.ctl = null;
    this.gen = 0;
    this.sent = 0;          // entry inviate, cumulativo (specchia ctl[DRAINED])
    // asset (texture/shape) già inviati al worker, per identità
    /** @type {WeakMap<object, number>} */
    this._assetIds = new WeakMap();
    this._nextAssetId = 1;
    // rect dirty in attesa che il worker li scriva: {idx, gen, chunk, rect}
    /** @type {{idx: number, gen: number, chunk: import('./store.js').Chunk, lx0: number, ly0: number, lx1: number, ly1: number}[]} */
    this._pending = [];
    // chiavi chunk già comunicate al worker in questa generazione
    /** @type {Set<number>} */
    this._known = new Set();
    // snap corrente ridotto alla geometria (per simulateEntry)
    /** @type {{hardness: number, roundness: number, shape: any}|null} */
    this._sim = null;
    /** @type {{x0:number,y0:number,x1:number,y1:number}|null} */
    this._clip = null;
    // endpass asincrono in corso: {watermark, items} (vedi endPassBegin)
    /** @type {{watermark: number, items: {chunk: import('./store.js').Chunk, oldSlot: number, newSlot: number}[]}|null} */
    this._swap = null;
    this._ready = false;      // il worker ha valutato il modulo (diagnostica)
    this._flushMsFrame = 0;

    // perché il bridge NON è usable (diagnostica nel pannello perf):
    // no-coi = pagina non isolata (header COOP/COEP assenti o rifiutati),
    // no-sab = isolata ma senza SharedArrayBuffer, worker-error = spawn/crash
    this.reason = '';
    try {
      if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
        this.reason = 'no-coi';
        return;
      }
      if (typeof SharedArrayBuffer === 'undefined') {
        this.reason = typeof crossOriginIsolated === 'undefined' ? 'no-coi-api' : 'no-sab';
        return;
      }
      this.worker = new Worker(new URL('./raster_worker.js', import.meta.url), { type: 'module' });
      this.worker.onerror = (e) => {
        // Safari spesso non valorizza message sugli errori di EVAL del
        // modulo: filename/riga distinguono "script mai partito" da crash
        const detail = [e.message, e.filename, e.lineno, e.colno]
          .filter((v) => v !== undefined && v !== null && v !== '').join(' @ ');
        console.error('[raster_bridge] worker morto, fallback main-thread', detail || e);
        this.usable = false;
        this.reason = 'worker-error: ' + (detail || (this._ready ? 'crash' : 'eval-failed')) +
          (this._ready ? ' (dopo ready)' : ' (mai partito)');
      };
      this.worker.onmessage = (e) => {
        if (e.data && e.data.t === 'ready') {
          this._ready = true;
          if (e.data.err) this.reason = 'wasm: ' + e.data.err; // solo diagnostica: JS resta ok
        }
      };
      this.ctlSab = new SharedArrayBuffer(16 * 4);
      this.ctl = new Int32Array(this.ctlSab);
      this.usable = true;
    } catch (err) {
      console.warn('[raster_bridge] non disponibile:', err);
      this.usable = false;
      this.reason = 'init-error: ' + (err instanceof Error ? err.message : String(err));
    }
  }

  get drained() {
    return this.ctl ? Atomics.load(this.ctl, CTL_DRAINED) : this.sent;
  }

  // fermo = tutto drenato E nessuno scambio di punta in sospeso (il commit
  // deve leggere i pixel finali, non i vecchi in attesa di swap)
  get idle() { return this.drained >= this.sent && !this._swap; }

  // Entry inviate e non ancora rasterizzate dal worker: l'arretrato VERO.
  // Se resta stabilmente alto con la penna in movimento, il worker singolo
  // non tiene il passo (è il segnale per la fase 3 multi-worker).
  get backlog() { return Math.max(0, this.sent - this.drained); }

  // ms spesi in attesa (spin) dei flush dall'ultimo prelievo: il costo
  // percepibile al pen-up. Campionato per frame dal pannello perf.
  takeFlushMs() {
    const v = this._flushMsFrame || 0;
    this._flushMsFrame = 0;
    return v;
  }

  /** @param {object|null} obj @param {'tex'|'shape'} kind */
  _assetId(obj, kind) {
    if (!obj) return 0;
    let id = this._assetIds.get(obj);
    if (id === undefined) {
      id = this._nextAssetId++;
      this._assetIds.set(obj, id);
      /** @type {Worker} */ (this.worker).postMessage({ t: 'asset', id, kind, obj });
    }
    return id;
  }

  /**
   * Avvia un tratto sul worker. false = capienza/stato non ok, il chiamante
   * resta sul path main (nessun messaggio inviato in quel caso).
   * @param {import('./stroke.js').Snap} snap
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip
   * @param {{mask: Uint8Array, x: number, y: number, w: number, h: number}|null} sel
   */
  beginStroke(snap, clip, sel) {
    if (!this.usable || !this.worker) return false;
    if (this.store.map.size > 0) return false; // mai qui: tratto precedente non chiuso
    // capienza: DUE board + margine — l'endpass tiene vivi gli slot vecchi
    // della punta (pixel visibili fino allo swap) MENTRE alloca i nuovi:
    // il caso peggiore è tratto a tutto board + punta a tutto board. Con
    // "board+16" il pool si esauriva e la punta perdeva pixel (bug traccia
    // cancellata a metà, visto su iPhone coi taper lunghi).
    const cols = (clip.x1 >> CHUNK_SHIFT) - (clip.x0 >> CHUNK_SHIFT) + 1;
    const rows = (clip.y1 >> CHUNK_SHIFT) - (clip.y0 >> CHUNK_SHIFT) + 1;
    const needed = cols * rows * 2 + 16;
    if (!this.idle || this.pool.pendingCount > 0) {
      if (!this.flushSync()) return false;
    }
    this.pool.recycle();
    if (this.pool.ensure(needed)) {
      this.worker.postMessage({
        t: 'init', ctl: this.ctlSab, slots: this.pool.sab, touched: this.pool.touchedSab,
      });
    }
    if (!this._announced) {
      this._announced = true;
      console.info('[raster_bridge] raster worker attivo: i tratti locali rasterizzano fuori dal main thread');
    }
    this.gen++;
    this._known.clear();
    this._pending.length = 0;
    this._clipKeys = null;
    this._sim = { hardness: snap.hardness, roundness: snap.roundness, shape: snap.shape };
    this._clip = clip;
    const texId = this._assetId(snap.tex, 'tex');
    const shapeId = this._assetId(snap.shape, 'shape');
    this.worker.postMessage({
      t: 'begin', gen: this.gen,
      snap: serializeSnap(snap, texId, shapeId),
      clip: { ...clip },
      sel: sel ? { mask: sel.mask, x: sel.x, y: sel.y, w: sel.w, h: sel.h } : null,
    });
    return true;
  }

  /**
   * Drena la coda dell'App in un batch per il worker, simulando le creazioni
   * sul mirror (i chunk nascono QUI) e accodando i dirty rect in attesa.
   * @param {import('./stroke.js').DabQueue} queue
   */
  sendEntries(queue) {
    if (!this.usable || !this.worker || queue.count === 0) return;
    const n = queue.count;
    const buf = new Float32Array(n * ENTRY_STRIDE);
    /** @type {number[]} coppie [key, slot] */
    const creations = [];
    const sim = /** @type {NonNullable<typeof this._sim>} */ (this._sim);
    for (let i = 0; i < n; i++) {
      const src = queue.buf;
      const o = queue.peekOffset();
      for (let k = 0; k < ENTRY_STRIDE; k++) buf[i * ENTRY_STRIDE + k] = src[o + k];
      queue.pop();
      const idx = ++this.sent;
      simulateEntry(this.store, sim, buf, i * ENTRY_STRIDE, this._clip,
        (chunk, lx0, ly0, lx1, ly1) => {
          if (!this._known.has(chunk.key)) {
            this._known.add(chunk.key);
            creations.push(chunk.key, this.store.slotFor(chunk));
          }
          this._pending.push({ idx, gen: this.gen, chunk, lx0, ly0, lx1, ly1 });
        }, this._clipKeys || null);
    }
    this.worker.postMessage({ t: 'entries', gen: this.gen, n, buf, creations });
  }

  // Da chiamare una volta per frame: applica allo store specchio i dirty
  // rect delle entry già drenate (upload sicuro) e ricicla gli slot quando
  // il worker è fermo.
  tick() {
    const d = this.drained;
    if (this._pending.length > 0) {
      let i = 0;
      for (; i < this._pending.length; i++) {
        const p = this._pending[i];
        if (p.idx > d) break;
        if (p.gen === this.gen && this.store.map.get(p.chunk.key) === p.chunk) {
          this.store.markDirty(p.chunk, p.lx0, p.ly0, p.lx1, p.ly1);
        }
      }
      if (i > 0) this._pending.splice(0, i);
    }
    this._trySwap(d);
    if (this.idle && this.pool.pendingCount > 0) this.pool.recycle();
  }

  // Attende (spin) che il worker abbia drenato tutto il mandato, poi applica
  // i dirty residui. false = worker morto oltre deadline: bridge spento.
  flushSync() {
    if (!this.usable || !this.ctl) return false;
    if (!this.idle) {
      const t0 = performance.now();
      while (Atomics.load(this.ctl, CTL_DRAINED) < this.sent) {
        if (performance.now() - t0 > FLUSH_DEADLINE_MS) {
          console.error('[raster_bridge] flush oltre deadline: worker perso');
          this.usable = false;
          return false;
        }
      }
      this._flushMsFrame = (this._flushMsFrame || 0) + (performance.now() - t0);
    }
    this.tick();
    return true;
  }

  // Copia i flag touched scritti dal worker nei chunk del mirror.
  // SOLO dopo flushSync: prima i flag possono essere indietro.
  syncTouched() {
    const flags = this.pool.touched;
    if (!flags) return;
    for (const c of this.store.map.values()) {
      const slot = this.store.slotFor(c);
      // il chunk può essere stato scritto anche dal main (endPass): OR, mai
      // spegnere un touched già vero
      if (slot >= 0 && flags[slot]) c.touched = true;
    }
  }

  /**
   * Pass finale del taper SUL WORKER, ASINCRONO: i chunk della punta restano
   * in mappa coi pixel vecchi (visibili: niente buchi né freeze), ma il
   * protocollo passa a slot NUOVI (rebindFresh) — il worker scarta i suoi
   * binding ('endpass' viaggia in FIFO DOPO il vivo residuo, quindi arriva
   * a vivo completato) e ridisegna la punta negli slot nuovi; lo scambio
   * atomico avviene in _trySwap quando drained raggiunge il watermark.
   * clipKeys null = tratto rifatto per intero. I byte finali sono identici
   * al path sincrono: cambia solo QUANDO la punta appare.
   * @param {Set<number>|null} clipKeys
   */
  endPassBegin(clipKeys) {
    if (!this.usable || !this.worker) return;
    // universo del clip: le chiavi della punta, o TUTTO il board (redo del
    // tratto intero) — enumerabile perché il clip del tratto è un board
    /** @type {Set<number>} */
    const universe = clipKeys ? new Set(clipKeys) : this._boardKeys();
    /** @type {{chunk: import('./store.js').Chunk, oldSlot: number, newSlot: number}[]} */
    const items = [];
    for (const k of universe) {
      const c = this.store.map.get(k);
      if (!c) { this._known.delete(k); continue; }
      const r = this.store.rebindFresh(c);
      if (!r) {
        // pool pieno (mai con la capienza 2×board): il chunk tiene slot e
        // pixel vivi, la sua punta resta non rastremata — niente perdita
        console.error('[raster_bridge] endpass: pool pieno, chunk escluso dal replay', k);
        universe.delete(k);
        continue;
      }
      this._known.delete(k);
      items.push({ chunk: c, oldSlot: r.oldSlot, newSlot: r.newSlot });
    }
    this._clipKeys = universe;
    this._swap = { watermark: -1, items };
    this.worker.postMessage({ t: 'endpass', gen: this.gen, clip: [...universe] });
  }

  // Tutte le chiavi chunk del board del tratto corrente (clip fotografato
  // al begin): serve all'endpass "tratto intero" per un clip enumerabile.
  _boardKeys() {
    /** @type {Set<number>} */
    const keys = new Set();
    const c = this._clip;
    if (!c) return keys;
    for (let cy = c.y0 >> CHUNK_SHIFT; cy <= c.y1 >> CHUNK_SHIFT; cy++) {
      for (let cx = c.x0 >> CHUNK_SHIFT; cx <= c.x1 >> CHUNK_SHIFT; cx++) {
        keys.add(((cx + 32768) << 16) | (cy + 32768));
      }
    }
    return keys;
  }

  /**
   * Chiude l'endpass: fissa il watermark (tutte le entry del replay sono
   * state inviate) e concede uno spin di cortesia — sui dispositivi veloci
   * la punta appare nello stesso frame del rilascio, come sempre; oltre il
   * budget si torna al frame loop e lo swap avverrà in tick().
   * @param {number} spinMs
   */
  finishEndPass(spinMs) {
    if (!this._swap || !this.ctl) return;
    this._swap.watermark = this.sent;
    if (spinMs > 0 && !this.idleDrained) {
      const t0 = performance.now();
      while (Atomics.load(this.ctl, CTL_DRAINED) < this.sent &&
        performance.now() - t0 < spinMs) { /* spin */ }
      this._flushMsFrame = (this._flushMsFrame || 0) + (performance.now() - t0);
    }
    this.tick();
  }

  get idleDrained() { return this.drained >= this.sent; }

  // Scambio della punta: pixel nuovi al posto dei vecchi, touched azzerato
  // (lo dirà il flag SAB del worker via syncTouched), slot vecchi al riciclo
  // differito. Chiamato da tick() quando il worker ha superato il watermark.
  /** @param {number} drained */
  _trySwap(drained) {
    const s = this._swap;
    if (!s || s.watermark < 0 || drained < s.watermark) return;
    for (const it of s.items) {
      const c = it.chunk;
      if (this.store.map.get(c.key) === c) {
        if (it.newSlot >= 0) c.data = this.pool.view(it.newSlot);
        c.touched = false;
        this.store.markDirty(c);
      }
      if (it.oldSlot >= 0) this.pool.releaseDeferred(it.oldSlot);
    }
    this._swap = null;
  }

  // Annullo/snap: il worker dimentica binding e snap. Gli slot del mirror
  // vengono rilasciati dal chiamante (releaseAll) e riciclati a drain finito.
  reset() {
    if (!this.usable || !this.worker) return;
    this.gen++;
    this._pending.length = 0;
    this._known.clear();
    this._clipKeys = null;
    if (this._swap) {
      // scambio mai avvenuto: gli slot NUOVI li rilascia releaseAll (sono
      // in slotOf), qui vanno solo i VECCHI rimasti appesi agli item
      for (const it of this._swap.items) {
        if (it.oldSlot >= 0) this.pool.releaseDeferred(it.oldSlot);
      }
      this._swap = null;
    }
    this.worker.postMessage({ t: 'reset', gen: this.gen });
  }
}
