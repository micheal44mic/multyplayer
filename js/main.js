// FRAME LOOP — unico orologio del sistema.
// 1. drena input  2. sampler -> descrittori  3. raster con budget
// 4. upload tile sporchi  5. present. Zero allocazioni nel path per-frame.

import { Camera } from './camera.js';
import { ChunkStore } from './store.js';
import { brush, StampCache } from './brush.js';
import { DabQueue, StrokeEngine } from './stroke.js';
import { Rasterizer, commitChunk } from './raster.js';
import { GLRenderer } from './renderer_gl.js';
import { Canvas2DRenderer } from './renderer_2d.js';
import { InputManager } from './input.js';
import { UndoManager } from './undo.js';
import { Hud } from './hud.js';
import { UI } from './ui.js';
import { WasmHeap } from './wasm_core.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./stroke.js').Snap} Snap */

export class App {
  /** @param {WasmHeap|null} [heap] core SIMD; null = rasterizer JS */
  constructor(heap = null) {
    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('paint'));
    this.camera = new Camera();
    this.heap = heap;
    this.docStore = new ChunkStore('doc', heap);
    this.strokeStore = new ChunkStore('stroke', heap);
    this.stampCache = new StampCache(160, heap);
    if (heap) {
      // memory.grow stacca il buffer: ogni vista va rigenerata subito
      heap.onGrow = () => {
        this.docStore.refreshViews();
        this.strokeStore.refreshViews();
        this.stampCache.refreshViews();
      };
    }
    this.queue = new DabQueue();
    this.engine = new StrokeEngine(this.queue);
    this.raster = new Rasterizer(this.strokeStore, this.stampCache, heap);
    this.hud = new Hud();

    // Presentazione desynchronized: meno latenza penna→schermo, ma su Chrome
    // può far lampeggiare il tratto (frame presentati fuori sincrono).
    // Preferenza persistita; toggle nel pannello (sezione Renderer).
    let desync = true;
    try { desync = localStorage.getItem('fable-paint.desync') !== '0'; } catch { /* storage negato */ }
    this.desync = desync;

    /** @type {GLRenderer | Canvas2DRenderer} */
    let renderer = new GLRenderer(this.canvas, { desynchronized: desync });
    if (!renderer.ok) renderer = new Canvas2DRenderer(this.canvas);
    this.renderer = renderer;
    renderer.trackStores(this.docStore, this.strokeStore);

    this.undoMgr = new UndoManager(() => this.ui.updateUndoButtons(this.undoMgr));

    // budget raster adattivo (px toccati per frame), target ~6 ms
    this.budgetPx = 1_500_000;
    this.strokeLive = false;      // c'è uno stroke non ancora compositato
    this.pendingCommit = false;   // pointer-up ricevuto: commit quando la coda è vuota
    /** @type {{chunks: Chunk[], index: number, snap: Snap|null}|null} */
    this.commitJob = null;        // commit incrementale: {chunks, index, snap}
    this.COMMIT_CHUNKS_PER_FRAME = 24;

    this.input = new InputManager(this.canvas, this.camera, {
      isPanTool: () => brush.tool === 'pan',
      onStrokeStart: (x, y, p) => this.startStroke(x, y, p),
      onStrokePoint: (x, y, p) => this.engine.move(x, y, p),
      onStrokeEnd: (x, y, p) => { this.engine.end(x, y, p); this.pendingCommit = true; },
      onStrokeCancel: () => this.cancelStroke(),
    });

    this.ui = new UI(this);

    // stats riusate (zero allocazioni nel loop)
    this.stats = {
      frameMs: 0, frameMaxMs: 0,
      timings: { input: 0, sample: 0, raster: 0, upload: 0, draw: 0 },
      budgetPx: 0, rasterPx: 0, queueDepth: 0, dabsFrame: 0,
      eventsPerSec: 0, docChunks: 0, strokeChunks: 0,
      cpuBytes: 0, gpuBytes: 0, undoCount: 0, undoBytes: 0,
      stampCache: 0, stampGen: 0, zoom: 1, dpr: 1,
      renderer: renderer.kind, engine: heap ? 'wasm simd' : 'js', contextLost: false,
    };
    this._frameMax = 0;
    this._frameMaxT = 0;
    this._lastT = performance.now();

    this._resize();
    window.addEventListener('resize', () => this._resize());
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this._resize());
    }

    // Watchdog: se il tick rAF va perso (tab nascosta al load, quirk del
    // browser), il loop viene riagganciato. Mai due catene in parallelo.
    this._rafPending = false;
    this._lastFrameWall = performance.now();
    document.addEventListener('visibilitychange', () => this._scheduleFrame());
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (performance.now() - this._lastFrameWall > 2000) {
        this._rafPending = false; // il tick pendente è andato perso: forza
        this._scheduleFrame();
      }
    }, 1000);

    this._scheduleFrame();
  }

  _scheduleFrame() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame((t) => { this._rafPending = false; this._frame(t); });
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.camera.resize(w, h, dpr);
    this.renderer.resize(w, h, dpr);
  }

  /** @param {number} x @param {number} y @param {number} p */
  startStroke(x, y, p) {
    // chiudi del tutto l'eventuale tratto precedente: drena la sua coda
    // (col suo snapshot), poi completa il commit in modo sincrono
    if (this.strokeLive) {
      if (this.queue.count > 0) this.raster.run(this.queue, Infinity);
      if (this.pendingCommit) this._beginCommit();
    }
    if (this.commitJob) this._runCommit(Infinity);
    this.engine.begin(x, y, p, brush);
    this.raster.beginStroke(this.engine.snap);
    this.strokeLive = true;
    this.pendingCommit = false;
  }

  cancelStroke() {
    this.engine.cancel();
    this.queue.clear();
    this._dropStrokeBuffer();
    this.strokeLive = false;
    this.pendingCommit = false;
  }

  _dropStrokeBuffer() {
    // i chunk tornano al pool (texture riusata) o liberano la texture
    this.strokeStore.releaseAll((c) => this.renderer.disposeChunkTex(c));
  }

  // Avvia il commit incrementale: composito sul layer spalmato sui frame.
  // Ogni chunk committato esce subito dallo stroke buffer, quindi il render
  // resta corretto chunk per chunk (mai doppia applicazione).
  _beginCommit() {
    this.pendingCommit = false;
    /** @type {Chunk[]} */
    const touched = [];
    for (const sc of this.strokeStore.map.values()) {
      if (sc.touched) touched.push(sc);
      else this.strokeStore.remove(sc.key, (c) => this.renderer.disposeChunkTex(c));
    }
    if (touched.length === 0) {
      this._dropStrokeBuffer();
      this.strokeLive = false;
      return;
    }
    this.undoMgr.captureBegin();
    this.commitJob = { chunks: touched, index: 0, snap: this.raster.snap };
  }

  /** @param {number} maxChunks */
  _runCommit(maxChunks) {
    const job = this.commitJob;
    if (!job) return;
    /** @type {(c: Chunk) => void} */
    const dispose = (c) => this.renderer.disposeChunkTex(c);
    let n = 0;
    while (job.index < job.chunks.length && n < maxChunks) {
      const sc = job.chunks[job.index++];
      commitChunk(this.docStore, sc, job.snap,
        (key, cx, cy, before) => this.undoMgr.captureChunk(key, cx, cy, before),
        this.heap);
      this.strokeStore.remove(sc.key, dispose);
      n++;
    }
    if (job.index >= job.chunks.length) {
      this.commitJob = null;
      this.undoMgr.captureEnd();
      this._dropStrokeBuffer(); // residui (non touched) e dirty set
      this.strokeLive = false;
    }
  }

  async undo() {
    if (this.strokeLive || this.commitJob) return;
    await this.undoMgr.undo(this.docStore, (c) => this.renderer.disposeChunkTex(c));
  }

  async redo() {
    if (this.strokeLive || this.commitJob) return;
    await this.undoMgr.redo(this.docStore, (c) => this.renderer.disposeChunkTex(c));
  }

  clearAll() {
    this.commitJob = null;
    this.cancelStroke();
    this.docStore.releaseAll((c) => this.renderer.disposeChunkTex(c), true);
    this.undoMgr.clear();
  }

  // Cambia la modalità di presentazione. Gli attributi di un contesto WebGL
  // sono immutabili: si sostituisce l'elemento canvas e si ricrea il renderer.
  // I pixel CPU sono la verità: le texture rinascono on-demand alla vista.
  /** @param {boolean} v */
  setDesynchronized(v) {
    if (v === this.desync) return;
    this.desync = v;
    try { localStorage.setItem('fable-paint.desync', v ? '1' : '0'); } catch { /* storage negato */ }
    this._recreateRenderer();
  }

  _recreateRenderer() {
    this.renderer.dispose();
    const fresh = /** @type {HTMLCanvasElement} */ (this.canvas.cloneNode(false));
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.input.rebind(fresh);

    // texture/canvas dei chunk appartengono al contesto morto
    this.docStore.dropRendererResources();
    this.strokeStore.dropRendererResources();
    this.docStore.dirty.clear();
    this.strokeStore.dirty.clear();

    /** @type {GLRenderer | Canvas2DRenderer} */
    let renderer = new GLRenderer(fresh, { desynchronized: this.desync });
    if (!renderer.ok) renderer = new Canvas2DRenderer(fresh);
    this.renderer = renderer;
    renderer.trackStores(this.docStore, this.strokeStore);
    this.stats.renderer = renderer.kind;
    this._resize();
  }

  /** @param {number} t */
  _frame(t) {
    const stats = this.stats;
    const dtFrame = t - this._lastT;
    this._lastT = t;

    const t0 = performance.now();

    // 1. input (gesture + conversione in punti stroke)
    this.input.drain();
    const t1 = performance.now();

    // 2. (il sampling avviene dentro drain via engine.move) — misurato insieme
    // 3. raster con budget
    let rasterPx = 0;
    if (this.queue.count > 0) {
      rasterPx = this.raster.run(this.queue, this.budgetPx);
    }
    const t2 = performance.now();

    // commit differito: parte quando il catch-up è finito, poi procede
    // a fette per non produrre un frame da centinaia di ms
    if (this.pendingCommit && this.queue.count === 0 && !this.engine.active) {
      this._beginCommit();
    }
    if (this.commitJob) this._runCommit(this.COMMIT_CHUNKS_PER_FRAME);

    // 4. upload dei soli tile sporchi
    this.renderer.uploadDirty(this.docStore);
    this.renderer.uploadDirty(this.strokeStore);
    const t3 = performance.now();

    // 5. present
    const snap = this.raster.snap;
    const liveOpacity = this.strokeLive && snap ? snap.globalOpacity : 1;
    const liveEraser = this.strokeLive && snap ? snap.eraser : false;
    this.renderer.render(this.camera, this.docStore, this.strokeStore, liveOpacity, liveEraser);
    // VRAM limitata: eviction delle texture fuori schermo (riupload on-demand)
    this.renderer.evict(this.docStore, this.camera, 1024);
    const t4 = performance.now();

    // budget adattivo: tiene il raster sotto ~6 ms anche su hardware lento
    const rasterMs = t2 - t1;
    if (rasterPx > 0) {
      if (rasterMs > 7) this.budgetPx = Math.max(262_144, this.budgetPx * 0.85);
      else if (rasterMs < 4 && this.queue.count > 0) this.budgetPx = Math.min(12_000_000, this.budgetPx * 1.15);
    }

    // HUD
    stats.frameMs = dtFrame;
    if (dtFrame > this._frameMax) this._frameMax = dtFrame;
    if (t - this._frameMaxT > 2000) { stats.frameMaxMs = this._frameMax; this._frameMax = 0; this._frameMaxT = t; }
    stats.timings.input = t1 - t0;
    stats.timings.sample = 0;
    stats.timings.raster = rasterMs;
    stats.timings.upload = t3 - t2;
    stats.timings.draw = t4 - t3;
    stats.budgetPx = this.budgetPx;
    stats.rasterPx = rasterPx;
    stats.queueDepth = this.queue.count;
    stats.dabsFrame = this.raster.lastDabs;
    stats.eventsPerSec = this.input.eventsPerSec;
    stats.docChunks = this.docStore.count;
    stats.strokeChunks = this.strokeStore.count;
    stats.cpuBytes = this.docStore.cpuBytes + this.strokeStore.cpuBytes;
    stats.gpuBytes = this.renderer.gpuBytes;
    stats.undoCount = this.undoMgr.undoStack.length;
    stats.undoBytes = this.undoMgr.storedBytes;
    stats.stampCache = this.stampCache.map.size;
    stats.stampGen = this.stampCache.generated;
    stats.zoom = this.camera.zoom;
    stats.dpr = this.camera.dpr;
    stats.contextLost = this.renderer.contextLost;
    this.hud.update(stats);

    this.ui.updateCursor(this.input, this.camera);
    this.ui.updateZoomLabel(this.camera.zoom);

    this._lastFrameWall = performance.now();
    this._scheduleFrame();
  }
}

// Il core wasm si carica PRIMA di costruire l'App: gli store nascono già
// nella memoria lineare (mai chunk misti JS/wasm). ?engine=js forza il
// fallback puro JS (utile per benchmark e debug).
const forceJs = new URLSearchParams(location.search).get('engine') === 'js';
const heap = forceJs ? null : await WasmHeap.load(new URL('./raster_core.wasm', import.meta.url));
/** @type {any} */ (window).__app = new App(heap);
