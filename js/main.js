// FRAME LOOP — unico orologio del sistema.
// 1. drena input  2. sampler -> descrittori  3. raster con budget
// 4. upload tile sporchi  5. present (piani). Zero allocazioni nel path
// per-frame. Il documento è una lista di CANVAS (artboard) affiancati;
// ogni canvas ha la sua pila di livelli (raster + testo), pennello e gomma
// scrivono sul livello attivo del canvas attivo e il tratto è ritagliato ai
// suoi bordi. I piani DOM compongono le pile di tutti i canvas.

import { Camera, ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { clamp } from './util.js';
import { ChunkStore, chunkKey, translateStore, CHUNK, CHUNK_SHIFT } from './store.js';
import { brush, StampCache } from './brush.js';
import { DabQueue, StrokeEngine } from './stroke.js';
import { Rasterizer, commitChunk } from './raster.js';
import { GLRenderer } from './renderer_gl.js';
import { Canvas2DRenderer } from './renderer_2d.js';
import { InputManager } from './input.js';
import { UndoManager } from './undo.js';
import { Hud } from './hud.js';
import { UI } from './ui.js';
import { makeRasterLayer } from './layers.js';
import { BoardManager, MAX_BOARDS } from './boards.js';
import { drawTextDocument, freeBlockBitmap, setBlockDebug3d, setTextGpu } from './text_layer.js';
import { Planes } from './planes.js';
import { TransformTool } from './transform_ui.js';
import { BoardProxyCache } from './board_proxy.js';
import { WasmHeap } from './wasm_core.js';
import { strokeProfiler } from './stroke_profiler.js';
import { initStress } from './stress.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./stroke.js').Snap} Snap */
/** @typedef {import('./layers.js').Layer} Layer */

export class App {
  /** @param {WasmHeap|null} [heap] core SIMD; null = rasterizer JS */
  constructor(heap = null) {
    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('paint'));
    this.planesEl = document.getElementById('planes');
    this.gridEl = document.getElementById('grid');
    this.boardsEl = document.getElementById('boards');
    this.camera = new Camera();
    this.heap = heap;

    // Tutti gli store con pixel in memoria wasm, anche quelli dei livelli
    // eliminati che vivono solo nello stack di undo: memory.grow stacca il
    // buffer e OGNI vista va rigenerata.
    /** @type {Set<ChunkStore>} */
    this._allStores = new Set();

    this.boards = new BoardManager();
    const board = this.boards.add('Canvas 1');
    const first = makeRasterLayer('Livello 1', heap);
    board.mgr.insert(first);
    this._allStores.add(first.store);

    this.strokeStore = new ChunkStore('stroke', heap);
    this._allStores.add(this.strokeStore);
    this.stampCache = new StampCache(160, heap);
    if (heap) {
      heap.onGrow = () => {
        for (const s of this._allStores) s.refreshViews();
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
    renderer.trackStores(() => [...this._allStores]);

    this.planes = new Planes(this.planesEl, this.gridEl, this.boardsEl);
    // zoom-out: i board non attivi diventano UN quad con texture piatta
    // 1024² (build GPU a budget), invece di un draw+texture per chunk
    this.proxy = new BoardProxyCache();

    this.undoMgr = new UndoManager(
      () => this.ui.updateUndoButtons(this.undoMgr),
      // un'entry esce per sempre dagli stack: se possiede un livello
      // eliminato, qui muore davvero (texture + slot wasm + pool)
      (e) => {
        if ((e.op === 'detach' || e.op === 'replace') && e.layer) {
          if (e.layer.store) {
            e.layer.store.destroy((c) => this.renderer.disposeChunkTex(c));
            this._allStores.delete(e.layer.store);
          } else {
            freeBlockBitmap(e.layer); // testo: blob dell'estrusione 3D
          }
        }
      });

    // budget raster adattivo (px toccati per frame), target ~6 ms
    this.budgetPx = 1_500_000;
    this.strokeLive = false;      // c'è uno stroke non ancora compositato
    this.pendingCommit = false;   // pointer-up ricevuto: commit quando la coda è vuota
    this._strokeLayerId = 0;      // livello di destinazione del tratto in corso
    /** @type {{x0: number, y0: number, x1: number, y1: number}|null} */
    this._strokeClip = null;      // bordi del canvas del tratto in corso
    /** @type {{chunks: Chunk[], index: number, snap: Snap|null, store: ChunkStore, layerId: number}|null} */
    this.commitJob = null;        // commit incrementale spalmato sui frame
    this.COMMIT_CHUNKS_PER_FRAME = 24;

    // l'input vive sul CONTAINER dei piani: sopravvive alla sostituzione del
    // canvas (toggle desync) e i piani figli sono pointer-events: none
    this.input = new InputManager(this.planesEl, this.camera, {
      isPanTool: () => brush.tool === 'pan',
      onStrokeStart: (x, y, p, t) => this.startStroke(x, y, p, t),
      onStrokePoint: (x, y, p, t) => {
        if (this.transform.dragging) return this.transform.dragMove(x, y);
        if (this.strokeLive) this.engine.move(x, y, p, t);
      },
      onStrokeEnd: (x, y, p, t) => {
        if (this.transform.dragging) {
          this.transform.dragMove(x, y);
          return this.transform.dragEnd();
        }
        if (!this.strokeLive) return;
        this.engine.end(x, y, p, t);
        strokeProfiler.penUp();
        if (this.engine.endPassNeeded) {
          const tp = performance.now();
          this._endPass();
          strokeProfiler.event('endPass replay punta', performance.now() - tp);
        }
        this.pendingCommit = true;
      },
      onStrokeCancel: () => {
        if (this.transform.dragging) return this.transform.dragCancel();
        this.cancelStroke();
      },
    });

    this.ui = new UI(this);
    // strumento Sposta/Trasforma: sessione con bbox, ✓/✗, anteprima a quad
    this.transform = new TransformTool(this);

    // stats riusate (zero allocazioni nel loop)
    this.stats = {
      frameMs: 0, frameMaxMs: 0,
      timings: { input: 0, raster: 0, tex: 0, commit: 0, upload: 0, draw: 0 },
      texDabs: 0,
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
    this.fitBoard(board); // vista iniziale: il primo canvas inquadrato
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
    this.planes.resize(w, h, dpr);
  }

  // Compat: il "layerMgr" dell'app è la pila del canvas attivo (pannello
  // livelli, testo e azioni operano sempre sul canvas selezionato).
  get layerMgr() { return this.boards.active.mgr; }

  // ---- canvas (artboard) ----

  /** Inquadra un canvas: centrato, zoom per farlo stare nella vista. @param {import('./boards.js').Board} board */
  fitBoard(board) {
    const cam = this.camera;
    cam.zoom = clamp(Math.min(cam.w / board.w, cam.h / board.h) * 0.85, ZOOM_MIN, ZOOM_MAX);
    cam.x = board.x + board.w / 2;
    cam.y = board.y + board.h / 2;
    cam.changed = true;
  }

  fitActiveBoard() { this.fitBoard(this.boards.active); }

  // Nuovo canvas a destra dell'ultimo, con il suo primo livello; diventa
  // attivo e viene inquadrato. (Operazione di struttura non annullabile,
  // come il primo canvas alla partenza.)
  addBoard() {
    if (!this.boards.canAdd) { alert(`Massimo ${MAX_BOARDS} canvas.`); return null; }
    const board = this.boards.add();
    const first = makeRasterLayer('Livello 1', this.heap);
    board.mgr.insert(first);
    this._allStores.add(first.store);
    this.ui.layersUI.sync(true);
    this.ui.layersUI.scheduleThumbs();
    this.fitBoard(board);
    return board;
  }

  // Cambia il canvas attivo (dal tocco su un altro canvas): il pannello
  // livelli passa alla sua pila e il piano DOM evidenzia il rettangolo.
  /** @param {number} id */
  selectBoard(id) {
    if (id === this.boards.activeId || !this.boards.byId(id)) return;
    this.boards.activeId = id;
    this.boards.bump();
    this.ui.layersUI.sync(true);
    this.ui.layersUI.scheduleThumbs();
  }

  // ---- livelli (operazioni annullabili) ----

  // Inserisce sopra il livello attivo del canvas attivo e registra l'undo.
  /** @param {Layer} layer */
  addLayer(layer) {
    if (!this.layerMgr.canAdd) return false;
    const index = this.layerMgr.insert(layer);
    if (layer.store) this._allStores.add(layer.store);
    this.undoMgr.pushStruct(/** @type {any} */ ({ op: 'attach', layerId: layer.id, index, boardId: this.boards.activeId }));
    this.ui.layersUI.sync();
    this.ui.layersUI.scheduleThumbs();
    return true;
  }

  /** @param {number} id */
  deleteLayer(id) {
    const d = this.layerMgr.detach(id);
    if (!d) return;
    // i pixel CPU restano (per l'undo); texture e canvas-chunk si liberano
    if (d.layer.store) {
      d.layer.store.forEachChunkAll((c) => {
        this.renderer.disposeChunkTex(c);
        c.c2d = null;
        c.texDirty = true;
      });
    }
    this.undoMgr.pushStruct(/** @type {any} */ ({ op: 'detach', layer: d.layer, index: d.index, boardId: this.boards.activeId }));
    this.ui.layersUI.sync();
  }

  /** @param {number} from @param {number} to */
  moveLayerUndoable(from, to) {
    if (from === to) return;
    this.layerMgr.move(from, to);
    this.undoMgr.pushStruct(/** @type {any} */ ({ op: 'move', from, to, boardId: this.boards.activeId }));
    this.ui.layersUI.sync();
  }

  // Rasterizza un livello testo: lo sostituisce in lista (stessa posizione,
  // nome, visibilità e opacità) con un livello raster i cui pixel sono il
  // testo renderizzato one-shot a qualità export — 1 px = 1 px documento,
  // path CPU pieno, niente cache live né SDF — clippato al suo canvas.
  // Annullabile: l'entry 'replace' possiede il livello testo e l'undo li
  // riscambia (il testo torna editabile).
  /** @param {number} id @returns {boolean} */
  rasterizeTextLayer(id) {
    const board = this.boards.boardOfLayer(id);
    const layer = board && board.mgr.byId(id);
    if (!layer || layer.kind !== 'text') return false;

    // resa identica all'export PNG, ma su sfondo trasparente e senza cuocere
    // l'opacità del livello (resta proprietà del livello raster)
    const cnv = document.createElement('canvas');
    cnv.width = board.w; cnv.height = board.h;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    drawTextDocument(ctx, layer.item, layer.style, board.x, board.y, 1);
    const img = ctx.getImageData(0, 0, board.w, board.h);

    const raster = makeRasterLayer(layer.name, this.heap);
    raster.visible = layer.visible;
    raster.opacity = layer.opacity;
    // PRIMA del travaso: un alloc può far crescere la memoria wasm e onGrow
    // rigenera le viste solo degli store registrati
    this._allStores.add(raster.store);

    // travaso nel ChunkStore: straight -> premultiplied, si creano solo i
    // chunk con almeno un pixel coperto (il canvas è già il clip al board)
    const src = img.data, W = board.w;
    const bx1 = board.x + board.w - 1, by1 = board.y + board.h - 1;
    for (let cy = board.y >> CHUNK_SHIFT; cy <= by1 >> CHUNK_SHIFT; cy++) {
      for (let cx = board.x >> CHUNK_SHIFT; cx <= bx1 >> CHUNK_SHIFT; cx++) {
        const wx0 = Math.max(cx * CHUNK, board.x), wx1 = Math.min(cx * CHUNK + CHUNK - 1, bx1);
        const wy0 = Math.max(cy * CHUNK, board.y), wy1 = Math.min(cy * CHUNK + CHUNK - 1, by1);
        let any = false;
        for (let wy = wy0; wy <= wy1 && !any; wy++) {
          let o = ((wy - board.y) * W + (wx0 - board.x)) * 4 + 3;
          for (let wx = wx0; wx <= wx1; wx++, o += 4) {
            if (src[o] !== 0) { any = true; break; }
          }
        }
        if (!any) continue;
        const chunk = raster.store.getOrCreate(cx, cy);
        const d = chunk.data; // azzerata: i pixel ad alpha 0 restano 0
        for (let wy = wy0; wy <= wy1; wy++) {
          let so = ((wy - board.y) * W + (wx0 - board.x)) * 4;
          let dofs = ((wy - cy * CHUNK) * CHUNK + (wx0 - cx * CHUNK)) * 4;
          for (let wx = wx0; wx <= wx1; wx++, so += 4, dofs += 4) {
            const a = src[so + 3];
            if (a === 0) continue;
            const k = a / 255; // Uint8ClampedArray arrotonda da sé
            d[dofs] = src[so] * k;
            d[dofs + 1] = src[so + 1] * k;
            d[dofs + 2] = src[so + 2] * k;
            d[dofs + 3] = a;
          }
        }
        chunk.touched = true;
        raster.store.markDirty(chunk,
          wx0 - cx * CHUNK, wy0 - cy * CHUNK, wx1 - cx * CHUNK, wy1 - cy * CHUNK);
      }
    }

    // scambio in lista: il testo esce (vive nell'entry undo), il raster
    // entra alla stessa posizione e diventa attivo
    const d = board.mgr.detach(id);
    board.mgr.insert(raster, d.index);
    freeBlockBitmap(layer); // bitmap effetto/SDF: si rigenera se l'undo lo riporta
    this.undoMgr.pushStruct(/** @type {any} */ (
      { op: 'replace', layer, layerId: raster.id, boardId: board.id }));
    this.ui.layersUI.sync();
    this.ui.layersUI.scheduleThumbs();
    return true;
  }

  // Host delle operazioni di undo: risolve gli store e applica la struttura.
  // Gli id dei livelli sono globali, ma attach/move hanno bisogno del canvas
  // di appartenenza (boardId nelle entry): l'undo funziona anche se nel
  // frattempo si è cambiato canvas.
  _undoHost() {
    return {
      /** @param {number} layerId */
      storeFor: (layerId) => {
        const l = this.boards.layerById(layerId);
        if (!l || !l.store) return null;
        l.thumbDirty = true;
        return l.store;
      },
      /** @param {Chunk} c */
      disposeTex: (c) => this.renderer.disposeChunkTex(c),
      /** @param {Layer} layer @param {number} index @param {number} boardId */
      attachLayer: (layer, index, boardId) => {
        const b = this.boards.byId(boardId) || this.boards.active;
        b.mgr.insert(layer, index);
        if (layer.store) this._allStores.add(layer.store);
        if (layer.kind === 'text') layer.styleDirty = true;
        layer.thumbDirty = true;
      },
      /** @param {number} id */
      detachLayer: (id) => {
        const b = this.boards.boardOfLayer(id);
        if (!b) return null;
        const d = b.mgr.detach(id);
        return d ? { layer: d.layer, index: d.index, boardId: b.id } : null;
      },
      /** @param {number} layerId @param {number} dx @param {number} dy */
      translateLayer: (layerId, dx, dy) => {
        const b = this.boards.boardOfLayer(layerId);
        const layer = b && b.mgr.byId(layerId);
        if (!layer || !layer.store) return null;
        const clip = { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 };
        const lost = translateStore(layer.store, dx, dy, clip,
          (c) => this.renderer.disposeChunkTex(c));
        layer.thumbDirty = true;
        return lost;
      },
      /** @param {number} layerId @param {number} x @param {number} y @param {number} size */
      setTextForm: (layerId, x, y, size) => {
        const layer = this.boards.layerById(layerId);
        if (!layer || layer.kind !== 'text') return false;
        layer.item.x = x;
        layer.item.y = y;
        layer.item.size = size;
        layer.styleDirty = true;
        layer.thumbDirty = true;
        return true;
      },
      /** @param {number} from @param {number} to @param {number} boardId */
      moveLayer: (from, to, boardId) => {
        const b = this.boards.byId(boardId);
        if (b) b.mgr.move(from, to);
      },
    };
  }

  // ---- stroke ----

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  startStroke(x, y, p, t) {
    // si disegna solo DENTRO un canvas: il punto di partenza decide quale;
    // sul piano di lavoro vuoto non parte niente
    const board = this.boards.hitTest(x, y);
    if (!board) return;
    // primo click su un canvas NON attivo = solo selezione, niente tratto:
    // il canvas si carica (proxy → texture, barra sull'etichetta) e si
    // disegna dal tocco successivo
    if (board.id !== this.boards.activeId) {
      this.selectBoard(board.id);
      return;
    }
    // appena selezionato e ancora in caricamento: il tratto partirebbe
    // alla cieca sotto il quad del proxy
    if (this.renderer instanceof GLRenderer && this.proxy.isLoading(board.id)) return;
    // strumento Sposta/Trasforma: il drag sul canvas trasla la sessione
    if (brush.tool === 'move') return this.transform.dragStart(x, y);
    const target = board.mgr.paintTarget;
    if (!target) return; // attivo non dipingibile (testo/nascosto): ignora
    this._flushPendingStroke();
    this._strokeLayerId = target.id;
    this._strokeClip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    // zoom camera = scala della velocità: la dinamica legge il gesto fisico
    this.engine.begin(x, y, p, t, brush, undefined, this.camera.zoom);
    this.raster.beginStroke(this.engine.snap, this._strokeClip);
    this.strokeLive = true;
    this.pendingCommit = false;
    strokeProfiler.begin(this._strokeProfInfo());
  }

  // Riga di contesto per il report del profiler: pennello, texture col
  // livello mip scelto, motore, vista.
  _strokeProfInfo() {
    const snap = this.engine.snap;
    let tex = 'texture off';
    if (snap.tex) {
      tex = `texture ${snap.tex.w}x${snap.tex.h} ` +
        (snap.texMoving ? 'moving (mip per stamp)'
          : `ancorata mip ${this.raster._tileLevel}/${snap.tex.mips.length - 1}`) +
        ` scala ${(snap.texScale * 100).toFixed(0)}%${snap.texColor ? ' colori' : ''}`;
    }
    return `pennello: size ${brush.size}px spacing ${(brush.spacing * 100).toFixed(1)}% ` +
      `hardness ${brush.hardness} opacity ${brush.opacity} buildup ${brush.buildup} ` +
      `scatter ${brush.scatter} smoothing ${brush.smoothing} tool ${brush.tool} · ` +
      `via ${snap.continuous ? 'continua (capsule)' : 'discreta (stamp)'}\n` +
      `${tex} · motore ${this.stats.engine} · renderer ${this.renderer.kind} · ` +
      `zoom ${(this.camera.zoom * 100).toFixed(0)}% · dpr ${this.camera.dpr}`;
  }

  // Chiude del tutto l'eventuale tratto precedente: drena la sua coda
  // (col suo snapshot e il suo clip), poi completa il commit in sincrono.
  _flushPendingStroke() {
    if (!this.strokeLive && !this.commitJob) return;
    const tp = performance.now();
    if (this.strokeLive) {
      if (this.queue.count > 0) this.raster.run(this.queue, Infinity);
      if (this.pendingCommit) this._beginCommit();
    }
    if (this.commitJob) this._runCommit(Infinity);
    strokeProfiler.event('flush sincrono', performance.now() - tp);
    strokeProfiler.finish('chiuso dal tratto successivo');
  }

  cancelStroke() {
    strokeProfiler.cancel();
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

  // Pass finale del taper al pen-up: live il tratto è pieno fino alla punta
  // (zero ritardo); qui si svuotano i SOLI chunk coperti dalla punta
  // (endPassRect) e il replay viene clippato lì dal rasterizer: il corpo del
  // tratto non si ridisegna mai, il costo è ∝ all'area della punta — la
  // punta appare nello stesso frame del rilascio, senza scatto. Sincrono e
  // prima del present: nessun lampeggio.
  _endPass() {
    // il live ancora in coda va rasterizzato PRIMA di svuotare i chunk della
    // punta: il replay fuori dal clip viene scartato, e un dab mai disegnato
    // lascerebbe un buco nel corpo
    if (this.queue.count > 0) this.raster.run(this.queue, Infinity);
    const rect = this.engine.endPassRect();
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => this.renderer.disposeChunkTex(c);
    /** @type {Set<number>|null} */
    let clip = null;
    if (rect) {
      clip = new Set();
      const cx0 = rect.x0 >> CHUNK_SHIFT, cy0 = rect.y0 >> CHUNK_SHIFT;
      const cx1 = rect.x1 >> CHUNK_SHIFT, cy1 = rect.y1 >> CHUNK_SHIFT;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = chunkKey(cx, cy);
          clip.add(key);
          this.strokeStore.remove(key, dispose);
        }
      }
    } else {
      this._dropStrokeBuffer();
    }
    this.raster.beginStroke(this.engine.snap, this._strokeClip);
    this.raster.clip = clip;
    this.engine.replay();
    this.raster.run(this.queue, Infinity);
    this.raster.clip = null;
  }

  // Avvia il commit incrementale: composito sul livello spalmato sui frame.
  // Ogni chunk committato esce subito dallo stroke buffer, quindi il render
  // resta corretto chunk per chunk (mai doppia applicazione).
  _beginCommit() {
    this.pendingCommit = false;
    const layer = this.boards.layerById(this._strokeLayerId);
    if (!layer || !layer.store) {
      // il livello è stato eliminato durante il tratto: il tratto muore
      this.queue.clear();
      this._dropStrokeBuffer();
      this.strokeLive = false;
      return;
    }
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
    this.undoMgr.captureBegin(layer.id);
    this.commitJob = { chunks: touched, index: 0, snap: this.raster.snap, store: layer.store, layerId: layer.id };
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
      commitChunk(job.store, sc, job.snap,
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
      const done = this.boards.layerById(job.layerId);
      if (done) done.thumbDirty = true;
      this.ui.layersUI.scheduleThumbs();
    }
  }

  async undo() {
    // trasformazione pendente: prima ✓ o ✗ (i bottoni sono lì apposta)
    if (this.strokeLive || this.commitJob || this.transform.pending || this.transform.dragging) return;
    await this.undoMgr.undo(this._undoHost());
    // l'undo può aver cambiato i pixel sotto la sessione: si rifotografa
    this.transform.rebind();
    this.planes.invalidate();
    this.ui.layersUI.sync();
    this.ui.layersUI.scheduleThumbs();
  }

  async redo() {
    if (this.strokeLive || this.commitJob || this.transform.pending || this.transform.dragging) return;
    await this.undoMgr.redo(this._undoHost());
    this.transform.rebind();
    this.planes.invalidate();
    this.ui.layersUI.sync();
    this.ui.layersUI.scheduleThumbs();
  }

  // Azzera il documento: spariscono TUTTI i canvas, si riparte da uno solo.
  clearAll() {
    this.commitJob = null;
    this.cancelStroke();
    for (const b of this.boards.boards) {
      for (const l of b.mgr.layers) {
        if (l.store) {
          l.store.destroy((c) => this.renderer.disposeChunkTex(c));
          this._allStores.delete(l.store);
        } else {
          freeBlockBitmap(l);
        }
      }
      b.mgr.layers.length = 0;
    }
    this.boards.boards.length = 0;
    const board = this.boards.add('Canvas 1');
    const first = makeRasterLayer('Livello 1', this.heap);
    board.mgr.insert(first);
    this._allStores.add(first.store);
    this.undoMgr.clear();
    this.planes.invalidate();
    this.ui.layersUI.sync(true);
    this.ui.layersUI.scheduleThumbs();
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

    // texture/canvas dei chunk appartengono al contesto morto
    for (const s of this._allStores) {
      s.dropRendererResources();
      s.dirty.clear();
    }

    /** @type {GLRenderer | Canvas2DRenderer} */
    let renderer = new GLRenderer(fresh, { desynchronized: this.desync });
    if (!renderer.ok) renderer = new Canvas2DRenderer(fresh);
    this.renderer = renderer;
    renderer.trackStores(() => [...this._allStores]);
    this.stats.renderer = renderer.kind;
    this.layerMgr.bump(); // i piani reinseriscono il canvas nuovo
    this._resize();
  }

  /** @param {number} t */
  _frame(t) {
    const stats = this.stats;
    const dtFrame = t - this._lastT;
    this._lastT = t;

    const t0 = performance.now();
    // baseline degli accumulatori cumulativi: i delta a fine frame coprono
    // anche il lavoro raster dentro gli handler di input (endPass al pen-up)
    const texAcc0 = this.raster.texMsAcc, fills0 = this.raster.tileFillsAcc;
    const bakes0 = this.raster.bakesAcc;
    const gen0 = this.stampCache.generated, genMs0 = this.stampCache.genMs;

    // 1. input (gesture + conversione in punti stroke)
    this.input.drain();
    // a mano ferma il dot di pen-down matura (cresce fino a piena dimensione)
    if (this.engine.active) this.engine.tick(performance.now());
    const t1 = performance.now();

    // 2. (il sampling avviene dentro drain via engine.move) — misurato insieme
    // 3. raster con budget
    let rasterPx = 0, texMs = 0, texDabs = 0;
    if (this.queue.count > 0) {
      rasterPx = this.raster.run(this.queue, this.budgetPx);
      texMs = this.raster.lastTexMs;
      texDabs = this.raster.lastTexDabs;
    }
    const t2 = performance.now();

    // commit differito: parte quando il catch-up è finito, poi procede
    // a fette per non produrre un frame da centinaia di ms
    if (this.pendingCommit && this.queue.count === 0 && !this.engine.active) {
      this._beginCommit();
    }
    if (this.commitJob) this._runCommit(this.COMMIT_CHUNKS_PER_FRAME);
    const t2b = performance.now();

    // 4+5. upload dei tile sporchi e present, piano per piano
    const snap = this.raster.snap;
    const liveOpacity = this.strokeLive && snap ? snap.globalOpacity : 1;
    const liveEraser = this.strokeLive && snap ? snap.eraser : false;
    // proxy dei board per lo zoom-out (solo WebGL): quad piatti al posto dei
    // chunk per i board non attivi. Durante un tratto la build resta ferma.
    const proxies = this.renderer instanceof GLRenderer && this.renderer.ok
      ? this.proxy.update(this.renderer, this.boards, this.boards.activeId,
        this.camera, !this.strokeLive)
      : null;
    // sessione Sposta/Trasforma: ciclo di vita (auto-commit al cambio di
    // bersaglio) + frame del quad per i renderer; il gizmo si riposiziona qui
    this.transform.sync(this.camera);
    const tfFrame = this.transform.frame();
    const pres = this.planes.render({
      camera: this.camera, boards: this.boards, activeId: this.layerMgr.activeId,
      strokeStore: this.strokeStore,
      liveOpacity, eraserLive: liveEraser,
      bottom: this.renderer, bottomCanvas: this.canvas,
      proxies, transform: tfFrame,
    });
    // gabbia della distorsione testo: segue camera e modifiche (uscita a
    // confronto di stringa quando non c'è niente da fare)
    this.ui.textUI.gizmo.sync(this.camera);
    // VRAM limitata: eviction delle texture fuori schermo (riupload on-demand).
    // I chunk dei piani 2D hanno tex nulla: il loop li salta da solo.
    const tEv = performance.now();
    const rasterStores = this.boards.allRasterStores();
    this.renderer.evict(rasterStores, this.camera, 1024);
    this.planes.evict(this.camera);
    const t4 = performance.now();
    const evictMs = t4 - tEv;

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
    stats.timings.raster = rasterMs;
    stats.timings.tex = texMs;
    stats.timings.commit = t2b - t2;
    stats.timings.upload = pres.uploadMs;
    stats.timings.draw = pres.drawMs;
    stats.texDabs = texDabs;
    stats.budgetPx = this.budgetPx;
    stats.rasterPx = rasterPx;
    stats.queueDepth = this.queue.count;
    stats.dabsFrame = this.raster.lastDabs;
    stats.eventsPerSec = this.input.eventsPerSec;
    let docChunks = 0, cpuBytes = this.strokeStore.cpuBytes;
    for (const s of rasterStores) { docChunks += s.count; cpuBytes += s.cpuBytes; }
    stats.docChunks = docChunks;
    stats.strokeChunks = this.strokeStore.count;
    stats.cpuBytes = cpuBytes;
    stats.gpuBytes = this.renderer.gpuBytes + this.planes.gpuBytes + this.proxy.gpuBytes;
    stats.undoCount = this.undoMgr.undoStack.length;
    stats.undoBytes = this.undoMgr.storedBytes;
    stats.stampCache = this.stampCache.map.size;
    stats.stampGen = this.stampCache.generated;
    stats.zoom = this.camera.zoom;
    stats.dpr = this.camera.dpr;
    stats.contextLost = this.renderer.contextLost;
    this.hud.update(stats);

    // profiler del tratto: un campione per frame finché il tratto (con
    // catch-up e commit) non è davvero finito, poi report in console
    if (strokeProfiler.active) {
      strokeProfiler.frame(dtFrame, t1 - t0, rasterMs,
        this.raster.texMsAcc - texAcc0, this.stampCache.genMs - genMs0,
        t2b - t2, pres.uploadMs, pres.drawMs, evictMs,
        this.queue.count, this.raster.lastDabs, rasterPx, this.budgetPx,
        this.stampCache.generated - gen0,
        this.raster.tileFillsAcc - fills0, this.raster.bakesAcc - bakes0);
      if (!this.strokeLive && !this.pendingCommit && !this.commitJob &&
        this.queue.count === 0 && !this.engine.active) {
        strokeProfiler.finish();
      }
    }

    this.ui.layersUI.sync();
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
const app = new App(heap);
/** @type {any} */ (window).__app = app;
// pannello stress test (bottone ⚡, ?stress=BxL[xCOV%], __stress da console)
initStress(app);
// Diagnostica del testo 3D/ombra dalla console: __textDebug3d() fa toggle,
// __textDebug3d(true|false) imposta. Costosa: accenderla solo per indagare.
/** @type {any} */ (window).__textDebug3d = setBlockDebug3d;
// Effetti testo: GPU (SDF) di default, __textGpu(false) forza il path CPU
// per confronto dal vivo. __textGpu() fa toggle.
/** @type {any} */ (window).__textGpu = setTextGpu;
