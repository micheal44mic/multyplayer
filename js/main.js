// FRAME LOOP — unico orologio del sistema.
// 1. drena input  2. sampler -> descrittori  3. raster con budget
// 4. upload tile sporchi  5. present (piani). Zero allocazioni nel path
// per-frame. Il documento è una lista di CANVAS (artboard) affiancati;
// ogni canvas ha la sua pila di livelli (raster + testo), pennello e gomma
// scrivono sul livello attivo del canvas attivo e il tratto è ritagliato ai
// suoi bordi. I piani DOM compongono le pile di tutti i canvas.

import { Camera, ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { clamp } from './util.js';
import { ChunkStore, chunkKey, translateStore, translateStoreWrapped, forEachChunkInRect, isChunkBlank, CHUNK, CHUNK_SHIFT } from './store.js';
import { brush, StampCache } from './brush.js';
import { DabQueue, StrokeEngine } from './stroke.js';
import { Rasterizer, commitChunk } from './raster.js';
import { GLRenderer } from './renderer_gl.js';
import { Canvas2DRenderer } from './renderer_2d.js';
import { InputManager } from './input.js';
import { UndoManager } from './undo.js';
import { UI } from './ui.js';
import { makeRasterLayer, refreshClipBases, MAX_LAYERS } from './layers.js';
import { BoardManager, MAX_BOARDS } from './boards.js';
import { drawTextDocument, freeBlockBitmap, setBlockDebug3d, setTextGpu, touchText } from './text_layer.js';
import { Planes } from './planes.js';
import { TransformTool } from './transform_ui.js';
import { FxTool } from './fx_ui.js';
import { LayerStyleTool } from './layer_style_ui.js';
import { FillUI } from './fill_ui.js';
import { BoardProxyCache } from './board_proxy.js';
import { TextQuadCache } from './text_quad.js';
import { WasmHeap } from './wasm_core.js';
import { blitImageDataToStore, imageDataFromFile, imageLayerName } from './image_import.js';
import { SelectionManager, SelectionOverlay } from './selection.js';
import { Collab } from './collab.js';
import { initStress } from './stress.js';
import { BlurBrushSession } from './blur_brush.js';
import { LiquifyBrushSession } from './liquify_brush.js';
import { ProjectHub } from './project_io.js';
import { installTelemetry, loadRuntimeConfig, track, wireFeedbackLinks } from './telemetry.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./stroke.js').Snap} Snap */
/** @typedef {import('./layers.js').Layer} Layer */

/** @param {{x:number,y:number}[]} points @param {{x:number,y:number}|null} preview @param {boolean} close */
function lassoPath(points, preview = null, close = false) {
  const n = points.length + (preview ? 1 : 0);
  if (n < 1) return '';
  /** @type {string[]} */
  const parts = [];
  /** @param {number} v */
  const fmt = (v) => Math.round(v * 100) / 100;
  const first = points[0];
  parts.push(`M${fmt(first.x)} ${fmt(first.y)}`);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    parts.push(`L${fmt(p.x)} ${fmt(p.y)}`);
  }
  if (preview) parts.push(`L${fmt(preview.x)} ${fmt(preview.y)}`);
  if (close && n >= 3) parts.push('Z');
  return parts.join('');
}

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
    const first = makeRasterLayer('Layer 1', heap);
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

    // Presentazione desynchronized: meno latenza penna→schermo, ma su Chrome
    // può far lampeggiare il tratto (frame presentati fuori sincrono).
    // Preferenza persistita; toggle nel pannello (sezione Renderer).
    let desync = false;
    try { desync = localStorage.getItem('fable-paint.desync') === '1'; } catch { /* storage negato */ }
    this.desync = desync;

    /** @type {GLRenderer | Canvas2DRenderer} */
    let renderer = new GLRenderer(this.canvas, { desynchronized: desync });
    if (!renderer.ok) renderer = new Canvas2DRenderer(this.canvas);
    this.renderer = renderer;
    renderer.trackStores(() => [...this._allStores]);
    /** @type {(c: Chunk) => void} */
    this._disposeTex = (c) => this.renderer.disposeChunkTex(c);

    this.planes = new Planes(this.planesEl, this.gridEl, this.boardsEl);
    // zoom-out: i board non attivi diventano UN quad con texture piatta
    // 1024² (build GPU a budget), invece di un draw+texture per chunk
    this.proxy = new BoardProxyCache();
    // testi non in editing: cotti in texture e disegnati DENTRO la pila del
    // renderer (i run raster non si spezzano più sull'SVG); l'SVG vettoriale
    // resta solo per il testo attivo del board attivo (_liveTextId)
    this.textQuads = new TextQuadCache();
    this._liveTextId = 0;

    this.undoMgr = new UndoManager(
      () => this.ui.updateUndoButtons(this.undoMgr),
      // un'entry esce per sempre dagli stack: se possiede un livello
      // eliminato, qui muore davvero (texture + slot wasm + pool)
      (e) => {
        if ((e.op === 'detach' || e.op === 'replace') && e.layer) {
          if (e.layer.store) {
            e.layer.store.destroy(this._disposeTex);
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
    /** @type {BlurBrushSession|null} */
    this.blurSession = null;      // pennello blur: scrive direttamente sul layer
    /** @type {LiquifyBrushSession|null} */
    this.liquifySession = null;   // liquify: deforma direttamente il layer, a budget
    /** @type {{layerId:number, chunks: Map<number, {cx:number, cy:number, data: Uint8ClampedArray<ArrayBuffer>|null}>}|null} */
    this._liquifyBase = null;     // contenuto pre-Liquify per Reconstruct/Reset
    /** @type {{kind:'free'|'polygon', board: import('./boards.js').Board, points:{x:number,y:number}[], preview:{x:number,y:number}|null, lastClickT:number}|null} */
    this.lassoSession = null;     // lazo libero/poligonale: preview + punti
    this._lassoHover = { x: 0, y: 0 };
    this._strokeLayerId = 0;      // livello di destinazione del tratto in corso
    /** @type {{x0: number, y0: number, x1: number, y1: number}|null} */
    this._strokeClip = null;      // bordi del canvas del tratto in corso
    // maschera di selezione del tratto in corso: fotografata al pen-down e
    // valida per TUTTO il tratto (endPass compreso), anche se l'utente
    // deseleziona a metà — un tratto mezzo mascherato sarebbe incoerente
    /** @type {{mask: Uint8Array, x: number, y: number, w: number, h: number}|null} */
    this._strokeSel = null;
    /** @type {{chunks: Chunk[], index: number, snap: Snap|null, store: ChunkStore, layerId: number}|null} */
    this.commitJob = null;        // commit incrementale spalmato sui frame
    this.COMMIT_CHUNKS_PER_FRAME = 24;
    this._imageImporting = false;
    this._firstStrokeTracked = false;

    // l'input vive sul CONTAINER dei piani: sopravvive alla sostituzione del
    // canvas (toggle desync) e i piani figli sono pointer-events: none
    this.input = new InputManager(this.planesEl, this.camera, {
      isPanTool: () => brush.tool === 'pan',
      onStrokeStart: (x, y, p, t) => this.startStroke(x, y, p, t),
      onStrokePoint: (x, y, p, t) => {
        if (this.lassoSession) return this.lassoMove(x, y);
        if (this.transform.dragging) return this.transform.dragMove(x, y);
        if (this.fillUI.adjusting) return this.fillUI.tapMove(x, y);
        if (this.blurSession) return this.blurSession.move(x, y, p);
        if (this.liquifySession) return this.liquifySession.move(x, y, p, t);
        if (this.strokeLive) {
          this.engine.move(x, y, p, t);
          this.collab.strokePoint(x, y, p, t);
        }
      },
      onStrokeEnd: (x, y, p, t) => {
        if (this.lassoSession) return this.lassoEnd(x, y);
        if (this.transform.dragging) {
          this.transform.dragMove(x, y);
          return this.transform.dragEnd();
        }
        if (this.fillUI.adjusting) return this.fillUI.tapEnd();
        if (this.blurSession) {
          this.blurSession.end(x, y, p);
          this.blurSession = null;
          this.strokeLive = false;
          return;
        }
        if (this.liquifySession) {
          this.liquifySession.end(x, y, p, t);
          return;
        }
        if (!this.strokeLive) return;
        this.engine.end(x, y, p, t);
        if (this.engine.snapMode) this._syncSnapStroke();
        else if (this.engine.endPassNeeded) this._endPass();
        this.pendingCommit = true;
        this.collab.strokeEnd(x, y, p, t);
      },
      onStrokeCancel: () => {
        if (this.lassoSession) return this.cancelLasso();
        if (this.transform.dragging) return this.transform.dragCancel();
        if (this.fillUI.adjusting) return this.fillUI.tapCancel();
        if (this.blurSession) {
          this.blurSession.cancel();
          this.blurSession = null;
          this.strokeLive = false;
          return;
        }
        if (this.liquifySession) {
          this.liquifySession.cancel();
          this.liquifySession = null;
          this.strokeLive = false;
          return;
        }
        this.cancelStroke();
      },
    });

    // selezione per colore: modello (maschera per-board) + overlay DOM
    // (tinta + formiche), fuori dai piani e trasparente all'input
    this.selection = new SelectionManager();
    this.selectionUI = new SelectionOverlay(this.selection);

    // Specchio verticale: i descrittori in coda vengono duplicati riflessi
    // sull'asse a metà del canvas attivo (queue.mirrorX, fotografato al
    // pen-down). La guida è un overlay FUORI da #planes (la rebuild dei
    // piani rimpiazza i figli) e sparisce mentre il tratto è vivo.
    this.mirrorV = false;
    this._mirrorEl = document.createElement('div');
    this._mirrorEl.id = 'mirror-guide';
    this._mirrorEl.hidden = true;
    document.body.appendChild(this._mirrorEl);
    this._mirrorKey = '';
    // Pattern seamless: il bordo del canvas diventa il bordo della tile.
    // La coda ripete il tratto sui tile adiacenti e il rasterizer clippa al
    // board attivo; la guida evidenzia la tile mentre il toggle e' acceso.
    this.patternMode = false;
    /** @type {'wrap'|'repeat'} */
    this.patternView = 'wrap';
    this._patternEl = document.createElement('div');
    this._patternEl.id = 'pattern-guide';
    this._patternEl.hidden = true;
    document.body.appendChild(this._patternEl);
    this._patternKey = '';
    this._patternRepeatCanvas = document.createElement('canvas');
    this._patternRepeatCanvas.id = 'pattern-repeat-preview';
    this._patternRepeatCanvas.hidden = true;
    document.body.appendChild(this._patternRepeatCanvas);
    this._patternRepeatScratch = document.createElement('canvas');
    this._patternRepeatRenderer = new Canvas2DRenderer(this._patternRepeatScratch);
    this._patternRepeatCamera = new Camera();

    this.ui = new UI(this);
    // ColorDrop: goccia di colore trascinabile dal rail + "riempi al tocco"
    this.fillUI = new FillUI(this);
    // strumento Sposta/Trasforma: sessione con bbox, ✓/✗, anteprima a quad
    this.transform = new TransformTool(this);
    // pannello Effetti: blur in anteprima GPU, rasterizzato al ✓
    this.fx = new FxTool(this);
    // pannello Stile livello (traccia): stessa sessione a ✓/✗
    this.layerStyle = new LayerStyleTool(this);
    this._lastTransformFrame = null;
    this._lastFxFrame = null;
    // i tool a sessione si escludono a vicenda (pannelli e sessioni)
    /** @type {import('./fx_session.js').FxSessionTool[]} */
    this.fxTools = [this.fx, this.layerStyle];

    // collaborazione P2P (WebRTC): tratti come comandi deterministici,
    // cursori/scie degli altri utenti, snapshot bit-exact all'adesione
    this.collab = new Collab(this);

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
    this._frameMsAvg = 0;
    this._proxyCamX = NaN;
    this._proxyCamY = NaN;
    this._proxyCamZ = NaN;
    this._proxyCamW = NaN;
    this._proxyCamH = NaN;
    this._proxyStillFrames = 0;
    this._proxyBuildSteps = 0;
    this._proxyBuildMs = 0;
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
    requestAnimationFrame(() => { this._rafPending = false; this._frame(); });
  }

  _resize() {
    const r = this.planesEl?.getBoundingClientRect();
    const w = Math.max(1, this.planesEl?.clientWidth || window.innerWidth);
    const h = Math.max(1, this.planesEl?.clientHeight || window.innerHeight);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.camera.resize(w, h, dpr, r?.left || 0, r?.top || 0);
    this.renderer.resize(w, h, dpr);
    this.planes.resize(w, h, dpr);
  }

  _syncProxyBuildBudget() {
    const cam = this.camera;
    const still = cam.x === this._proxyCamX && cam.y === this._proxyCamY &&
      cam.zoom === this._proxyCamZ && cam.w === this._proxyCamW && cam.h === this._proxyCamH;
    if (still) {
      this._proxyStillFrames++;
    } else {
      this._proxyCamX = cam.x; this._proxyCamY = cam.y; this._proxyCamZ = cam.zoom;
      this._proxyCamW = cam.w; this._proxyCamH = cam.h;
      this._proxyStillFrames = 0;
    }

    const busy = this.strokeLive || this.pendingCommit || this.commitJob ||
      this.queue.count > 0 || this.blurSession || this.liquifySession ||
      this.transform.dragging || this.transform.pending ||
      this.fx.pending || this.layerStyle.pending || this.fillUI.pending ||
      this.collab.remoteTransformActive;
    if (busy || this._proxyStillFrames < 3) {
      this._proxyBuildSteps = 0;
      this._proxyBuildMs = 0;
      return;
    }

    const avg = this._frameMsAvg || 0;
    if (avg > 18) {
      // Sotto carico pesante: fai avanzare i proxy molto lentamente, senza
      // competere col canvas attivo.
      this._proxyBuildSteps = this._proxyStillFrames % 4 === 0 ? 1 : 0;
      this._proxyBuildMs = this._proxyBuildSteps ? 0.35 : 0;
    } else if (avg > 12) {
      this._proxyBuildSteps = 2;
      this._proxyBuildMs = 0.5;
    } else if (this._proxyStillFrames < 15) {
      this._proxyBuildSteps = 4;
      this._proxyBuildMs = 0.75;
    } else if (this._proxyStillFrames < 45) {
      this._proxyBuildSteps = 8;
      this._proxyBuildMs = 1.25;
    } else {
      this._proxyBuildSteps = 16;
      this._proxyBuildMs = 2;
    }
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
    if (!this.boards.canAdd) { alert(`Maximum ${MAX_BOARDS} canvases.`); return null; }
    const board = this.boards.add();
    const first = makeRasterLayer('Layer 1', this.heap);
    board.mgr.insert(first);
    this._allStores.add(first.store);
    this.ui.layersUI.sync(true);
    this.ui.layersUI.scheduleThumbs();
    this.fitBoard(board);
    track('board_add', { count: this.boards.boards.length });
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

  // Inserisce sopra il livello attivo del canvas indicato e registra l'undo.
  /** @param {Layer} layer @param {import('./boards.js').Board} [board] */
  addLayer(layer, board = this.boards.active) {
    if (!board || !board.mgr.canAdd) return false;
    const index = board.mgr.insert(layer);
    if (layer.store) this._allStores.add(layer.store);
    this.undoMgr.pushStruct(/** @type {any} */ ({ op: 'attach', layerId: layer.id, index, boardId: board.id }));
    this.ui.layersUI.sync();
    this.ui.layersUI.scheduleThumbs();
    return true;
  }

  get imageImporting() { return this._imageImporting; }

  /** @param {boolean} v */
  _setImageImporting(v) {
    this._imageImporting = v;
    document.body.classList.toggle('importing', v);
    if (this.ui && this.ui.layersUI) this.ui.layersUI.setImportBusy(v);
  }

  /**
   * Importa un file immagine come nuovo livello raster nel canvas attivo
   * catturato all'inizio dell'operazione.
   * @param {File} file
   * @returns {Promise<boolean>}
   */
  async importImageLayer(file) {
    if (!file) return false;
    if (this._imageImporting) { alert('Image import already in progress.'); return false; }
    const board = this.boards.active;
    if (!board) return false;
    if (!board.mgr.canAdd) { alert(`Maximum ${MAX_LAYERS} layers.`); return false; }

    /** @type {Layer|null} */
    let raster = null;
    this._setImageImporting(true);
    try {
      const { imageData, drawW, drawH } = await imageDataFromFile(file, board.w, board.h);
      if (!board.mgr.canAdd) { alert(`Maximum ${MAX_LAYERS} layers.`); return false; }

      raster = makeRasterLayer(imageLayerName(file.name), this.heap);
      // PRIMA del travaso: un alloc può far crescere la memoria wasm e onGrow
      // rigenera le viste solo degli store registrati.
      this._allStores.add(raster.store);
      const dx = Math.round(board.x + (board.w - drawW) / 2);
      const dy = Math.round(board.y + (board.h - drawH) / 2);
      blitImageDataToStore(raster.store, imageData, dx, dy);

      const ok = this.addLayer(raster, board);
      if (!ok) {
        raster.store.destroy(this._disposeTex);
        this._allStores.delete(raster.store);
        raster = null;
        alert(`Maximum ${MAX_LAYERS} layers.`);
        return false;
      }
      raster = null;
      return true;
    } catch (err) {
      if (raster && raster.store) {
        raster.store.destroy(this._disposeTex);
        this._allStores.delete(raster.store);
      }
      console.error(err);
      alert(err instanceof Error ? err.message : 'Image import failed.');
      return false;
    } finally {
      this._setImageImporting(false);
    }
  }

  /** @param {number} id */
  deleteLayer(id) {
    const d = this.layerMgr.detach(id);
    if (!d) return;
    // i pixel CPU restano (per l'undo); texture e canvas-chunk si liberano
    if (d.layer.store) {
      d.layer.store.forEachChunkAll((c) => {
        this._disposeTex(c);
        c.c2d = null;
        c.texDirty = true;
        c.c2dDirty = true;
      });
    }
    this.undoMgr.pushStruct(/** @type {any} */ ({ op: 'detach', layer: d.layer, index: d.index, boardId: this.boards.activeId }));
    this.ui.layersUI.sync();
  }

  // Maschera di ritaglio: il livello si vede solo dove il livello sotto
  // (la base, alla Procreate) ha alpha. Annullabile (op struct 'clip').
  /** @param {number} id */
  toggleClipUndoable(id) {
    const layer = this.layerMgr.byId(id);
    if (!layer || layer.kind !== 'raster') return;
    layer.clip = !layer.clip;
    this.layerMgr.bump(); // pannello e proxy (contentKey) si risincronizzano
    this.undoMgr.pushStruct(/** @type {any} */ (
      { op: 'clip', layerId: id, v: layer.clip, boardId: this.boards.activeId }));
    this.planes.invalidate();
    this.ui.layersUI.sync();
  }

  // Metodo di fusione del livello (alla Photoshop). Annullabile (op 'mode').
  /** @param {number} id @param {import('./layers.js').BlendMode} mode */
  setModeUndoable(id, mode) {
    const layer = this.layerMgr.byId(id);
    if (!layer || layer.kind !== 'raster') return;
    const prev = layer.mode || 'normal';
    if (prev === mode) return;
    layer.mode = mode;
    this.layerMgr.bump(); // pannello e proxy (contentKey) si risincronizzano
    this.undoMgr.pushStruct(/** @type {any} */ (
      { op: 'mode', layerId: id, m0: prev, m1: mode, boardId: this.boards.activeId }));
    this.planes.invalidate();
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

    blitImageDataToStore(raster.store, img, board.x, board.y);

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

  // ---- selezione per colore ----

  // Click del tool Selezione: campiona il colore del livello attivo nel
  // punto e seleziona TUTTI i pixel simili del board (non contigui). Click
  // su un pixel trasparente = deseleziona.
  /** @param {import('./boards.js').Board} board @param {number} x @param {number} y */
  selectAt(board, x, y) {
    const layer = board.mgr.paintTarget;
    if (!layer) return; // attivo non raster o nascosto: niente da campionare
    this.selection.buildFromColor(layer.store, layer.id, board,
      Math.floor(x), Math.floor(y), this.selection.operation);
  }

  // Lo slider tolleranza ricampiona l'ultima selezione dallo stesso punto
  // e dallo stesso livello (se esistono ancora).
  reselectTolerance() {
    const sel = this.selection;
    if (!sel.active || !sel.canReselectColor || this.strokeLive || this.commitJob) return;
    const board = this.boards.byId(sel.boardId);
    const layer = board && board.mgr.byId(sel.pick.layerId);
    if (!board || !layer || !layer.store) return;
    sel.buildFromColor(layer.store, layer.id, board, sel.pick.wx, sel.pick.wy);
  }

  /** @param {import('./boards.js').Board} board @param {number} x @param {number} y */
  startLasso(board, x, y, t = performance.now()) {
    if (this.selection.kind === 'lasso') {
      this.lassoSession = { kind: 'free', board, points: [{ x, y }], preview: null, lastClickT: t };
      this.selectionUI.setPreviewPath(lassoPath(this.lassoSession.points, null, true));
      this.ui?.syncSelectOptions();
      return;
    }
    if (this.selection.kind === 'polygon') {
      this._polygonLassoDown(board, x, y, t);
    }
  }

  /** @param {number} x @param {number} y */
  lassoMove(x, y) {
    const s = this.lassoSession;
    if (!s) return;
    if (s.kind === 'free') {
      const last = s.points[s.points.length - 1];
      if (Math.hypot(x - last.x, y - last.y) >= 1.5) s.points.push({ x, y });
      this.selectionUI.setPreviewPath(lassoPath(s.points, null, true));
      return;
    }
    s.preview = { x, y };
    this._syncLassoPreview();
  }

  /** @param {number} x @param {number} y */
  lassoEnd(x, y) {
    const s = this.lassoSession;
    if (!s) return;
    if (s.kind === 'free') {
      const last = s.points[s.points.length - 1];
      if (Math.hypot(x - last.x, y - last.y) >= 0.5) s.points.push({ x, y });
      this._commitLasso(s);
      return;
    }
    s.preview = null;
    this._syncLassoPreview();
  }

  /** @param {import('./boards.js').Board} board @param {number} x @param {number} y @param {number} t */
  _polygonLassoDown(board, x, y, t) {
    let s = this.lassoSession;
    const closeDist = Math.max(4, 10 / this.camera.zoom);
    if (!s || s.kind !== 'polygon') {
      s = this.lassoSession = { kind: 'polygon', board, points: [{ x, y }], preview: null, lastClickT: t };
      this._syncLassoPreview();
      this.ui?.syncSelectOptions();
      return;
    }
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    const nearFirst = s.points.length >= 3 && Math.hypot(x - first.x, y - first.y) <= closeDist;
    const doubleClick = s.points.length >= 3 && t - s.lastClickT < 360 &&
      Math.hypot(x - last.x, y - last.y) <= closeDist;
    if (nearFirst || doubleClick) {
      this._commitLasso(s);
      return;
    }
    s.points.push({ x, y });
    s.preview = null;
    s.lastClickT = t;
    this._syncLassoPreview();
    this.ui?.syncSelectOptions();
  }

  finishPolygonLasso() {
    const s = this.lassoSession;
    if (!s || s.kind !== 'polygon' || s.points.length < 3) return false;
    this._commitLasso(s);
    return true;
  }

  cancelLasso() {
    if (!this.lassoSession) return false;
    this.lassoSession = null;
    this.selectionUI.setPreviewPath('');
    this.ui?.syncSelectOptions();
    return true;
  }

  /** @param {{kind:'free'|'polygon', board: import('./boards.js').Board, points:{x:number,y:number}[]}} session */
  _commitLasso(session) {
    const points = session.points.slice();
    this.lassoSession = null;
    this.selectionUI.setPreviewPath('');
    if (points.length >= 3) this.selection.buildFromLasso(session.board, points, this.selection.operation);
    this.ui?.syncSelectOptions();
  }

  _syncLassoPreview() {
    const s = this.lassoSession;
    if (!s) return;
    let preview = s.preview;
    if (s.kind === 'polygon' && !preview && this.input.hover.visible) {
      this.camera.screenToWorld(this.input.hover.x, this.input.hover.y, this._lassoHover);
      preview = this._lassoHover;
    }
    this.selectionUI.setPreviewPath(lassoPath(s.points, preview, s.kind === 'free'));
  }

  // Canc/Backspace: azzera i pixel selezionati del livello attivo del board
  // della selezione. Annullabile col tile-diff degli stroke (stesso path).
  /** @returns {boolean} true se qualcosa è stato cancellato */
  deleteSelected() {
    // stesse guardie di undo(): mai mutare chunk sotto un commit in volo
    if (this.collab.remoteTransformActive || this.strokeLive || this.commitJob || this.transform.pending || this.transform.dragging || this.fx.pending || this.layerStyle.pending || this.fillUI.pending) return false;
    const sel = this.selection;
    if (!sel.active) return false;
    const board = this.boards.byId(sel.boardId);
    if (!board) { sel.clear(); return false; }
    const layer = board.mgr.paintTarget;
    if (!layer) return false;
    const store = layer.store, mask = sel.mask, mw = sel.bw;
    const b = sel.bounds;
    let changed = false;
    this.undoMgr.captureBegin(layer.id);
    forEachChunkInRect(store,
      sel.bx + b.x0, sel.by + b.y0, sel.bx + b.x1, sel.by + b.y1, false,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const d32 = new Uint32Array(chunk.data.buffer, chunk.data.byteOffset, CHUNK * CHUNK);
        const mox = ox - sel.bx, moy = oy - sel.by;
        // prima passata: c'è almeno un pixel selezionato e non vuoto?
        let any = false;
        for (let ly = ly0; ly <= ly1 && !any; ly++) {
          const mrow = (moy + ly) * mw + mox;
          let o = (ly << CHUNK_SHIFT) + lx0;
          for (let lx = lx0; lx <= lx1; lx++, o++) {
            if (d32[o] !== 0 && mask[mrow + lx] !== 0) { any = true; break; }
          }
        }
        if (!any) return;
        // foto "prima" PER l'undo, poi azzeramento col rect sporco esatto
        this.undoMgr.captureChunk(chunk.key, chunk.cx, chunk.cy, chunk.data);
        let dx0 = CHUNK, dy0 = CHUNK, dx1 = -1, dy1 = -1;
        for (let ly = ly0; ly <= ly1; ly++) {
          const mrow = (moy + ly) * mw + mox;
          let o = (ly << CHUNK_SHIFT) + lx0;
          for (let lx = lx0; lx <= lx1; lx++, o++) {
            if (d32[o] === 0 || mask[mrow + lx] === 0) continue;
            d32[o] = 0;
            if (lx < dx0) dx0 = lx;
            if (lx > dx1) dx1 = lx;
            if (ly < dy0) dy0 = ly;
            if (ly > dy1) dy1 = ly;
          }
        }
        store.markDirty(chunk, dx0, dy0, dx1, dy1);
        changed = true;
      });
    this.undoMgr.captureEnd(); // entry senza chunk: scartata da sé
    if (changed) {
      layer.thumbDirty = true;
      this.ui.layersUI.scheduleThumbs();
    }
    return changed;
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
      disposeTex: this._disposeTex,
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
      /** @param {number} layerId @param {number} dx @param {number} dy @param {boolean} [wrap] */
      translateLayer: (layerId, dx, dy, wrap = false) => {
        const b = this.boards.boardOfLayer(layerId);
        const layer = b && b.mgr.byId(layerId);
        if (!layer || !layer.store) return null;
        const clip = { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 };
        const lost = wrap
          ? translateStoreWrapped(layer.store, dx, dy, clip, this._disposeTex)
          : translateStore(layer.store, dx, dy, clip, this._disposeTex);
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
        touchText(layer);
        layer.thumbDirty = true;
        return true;
      },
      /** @param {number} from @param {number} to @param {number} boardId */
      moveLayer: (from, to, boardId) => {
        const b = this.boards.byId(boardId);
        if (b) b.mgr.move(from, to);
      },
      /** @param {number} layerId @param {boolean} v @returns {boolean|null} */
      setClip: (layerId, v) => {
        const b = this.boards.boardOfLayer(layerId);
        const layer = b && b.mgr.byId(layerId);
        if (!layer || layer.kind !== 'raster') return null;
        const prev = !!layer.clip;
        layer.clip = v;
        b.mgr.bump();
        return prev;
      },
      /** @param {number} layerId @param {string} m @returns {string|null} */
      setMode: (layerId, m) => {
        const b = this.boards.boardOfLayer(layerId);
        const layer = b && b.mgr.byId(layerId);
        if (!layer || layer.kind !== 'raster') return null;
        const prev = layer.mode || 'normal';
        layer.mode = /** @type {import('./layers.js').BlendMode} */ (m);
        b.mgr.bump();
        return prev;
      },
    };
  }

  // Posiziona la guida dello specchio: linea a metà del canvas attivo, in
  // px schermo (transform, come i .board). Nascosta mentre il tratto è vivo
  // (strokeLive copre pen-down → fine commit) e ovviamente a toggle spento.
  // A regime è un confronto di stringa e basta.
  _syncMirrorGuide() {
    const el = this._mirrorEl;
    const board = this.boards.active;
    if (!this.mirrorV || !board || this.strokeLive) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    const cam = this.camera, z = cam.zoom;
    const sx = (board.x + board.w / 2 - cam.x) * z + cam.w * 0.5 + cam.ox;
    const sy = (board.y - cam.y) * z + cam.h * 0.5 + cam.oy;
    const h = board.h * z;
    const key = `${sx}|${sy}|${h}`;
    if (this._mirrorKey !== key) {
      this._mirrorKey = key;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      el.style.height = h + 'px';
    }
    if (el.hidden) el.hidden = false;
  }

  _syncPatternGuide() {
    const el = this._patternEl;
    const board = this.boards.active;
    if (!this.patternMode || !board || this.strokeLive) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    const cam = this.camera, z = cam.zoom;
    const sx = (board.x - cam.x) * z + cam.w * 0.5 + cam.ox;
    const sy = (board.y - cam.y) * z + cam.h * 0.5 + cam.oy;
    const w = board.w * z;
    const h = board.h * z;
    const key = `${sx}|${sy}|${w}|${h}`;
    if (this._patternKey !== key) {
      this._patternKey = key;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }
    if (el.hidden) el.hidden = false;
  }

  _syncPatternRepeatPreview() {
    const cnv = this._patternRepeatCanvas;
    const board = this.boards.active;
    if (!this.patternMode || this.patternView !== 'repeat' || !board) {
      if (!cnv.hidden) cnv.hidden = true;
      return;
    }
    const cam = this.camera;
    const z = cam.zoom;
    const dpr = Math.max(1, cam.dpr || window.devicePixelRatio || 1);
    const cssW = Math.max(1, Math.round(cam.w));
    const cssH = Math.max(1, Math.round(cam.h));
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (cnv.width !== pw) cnv.width = pw;
    if (cnv.height !== ph) cnv.height = ph;
    cnv.style.transform = `translate(${cam.ox}px, ${cam.oy}px)`;
    cnv.style.width = cssW + 'px';
    cnv.style.height = cssH + 'px';

    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);

    const sx = (board.x - cam.x) * z + cam.w * 0.5;
    const sy = (board.y - cam.y) * z + cam.h * 0.5;
    const tileW = board.w * z;
    const tileH = board.h * z;
    if (tileW <= 0 || tileH <= 0) {
      if (!cnv.hidden) cnv.hidden = true;
      return;
    }

    const scratch = this._patternRepeatScratch;
    this._patternRepeatRenderer.resize(cssW, cssH, dpr);
    ctx.imageSmoothingEnabled = false;
    for (const ox of [-1, 0, 1]) {
      for (const oy of [-1, 0, 1]) {
        if (ox === 0 && oy === 0) continue;
        const dx = sx + ox * tileW;
        const dy = sy + oy * tileH;
        if (dx >= cssW || dy >= cssH || dx + tileW <= 0 || dy + tileH <= 0) continue;

        const x0 = clamp(dx, 0, cssW);
        const y0 = clamp(dy, 0, cssH);
        const x1 = clamp(dx + tileW, 0, cssW);
        const y1 = clamp(dy + tileH, 0, cssH);
        if (x1 <= x0 || y1 <= y0) continue;

        ctx.fillStyle = '#fff';
        ctx.fillRect(x0 * dpr, y0 * dpr, (x1 - x0) * dpr, (y1 - y0) * dpr);
        this._renderPatternRepeatTile(board, ox, oy, cssW, cssH, dpr);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 * dpr, y0 * dpr, (x1 - x0) * dpr, (y1 - y0) * dpr);
        ctx.clip();
        ctx.drawImage(scratch, 0, 0);
        ctx.restore();

        const line = Math.max(1, dpr);
        ctx.lineWidth = line;
        ctx.strokeStyle = 'rgba(77, 124, 254, 0.45)';
        ctx.strokeRect(dx * dpr + line * 0.5, dy * dpr + line * 0.5,
          Math.max(0, tileW * dpr - line), Math.max(0, tileH * dpr - line));
      }
    }
    if (cnv.hidden) cnv.hidden = false;
  }

  /**
   * @param {import('./boards.js').Board} board
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} dpr
   */
  _renderPatternRepeatTile(board, tileX, tileY, cssW, cssH, dpr) {
    const cam = this.camera;
    const vcam = this._patternRepeatCamera;
    vcam.x = cam.x - tileX * board.w;
    vcam.y = cam.y - tileY * board.h;
    vcam.zoom = cam.zoom;
    vcam.resize(cssW, cssH, dpr, 0, 0);

    const snap = this.raster.snap;
    const liveOpacity = this.strokeLive && snap ? snap.globalOpacity : 1;
    const liveEraser = this.strokeLive && snap ? snap.eraser : false;
    this._patternRepeatRenderer.render(vcam, board.mgr.layers, board.mgr.activeId,
      this.strokeLive ? this.strokeStore : null, liveOpacity, liveEraser,
      null, this._lastTransformFrame || null, this._lastFxFrame || null, this.textQuads);
  }

  // ---- stroke ----

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  startStroke(x, y, p, t) {
    // Il lazo poligonale resta vivo tra un click e l'altro: i punti successivi
    // possono cadere anche fuori dal board, poi il riempimento viene clippato.
    if (brush.tool === 'select' && this.lassoSession?.kind === 'polygon') {
      return this._polygonLassoDown(this.lassoSession.board, x, y, t);
    }
    // si disegna solo DENTRO un canvas: il punto di partenza decide quale;
    // sul piano di lavoro vuoto non parte niente
    const board = this.boards.hitTest(x, y);
    if (!board) return;
    if (this.patternMode && this.patternView === 'repeat' && board.id !== this.boards.activeId) {
      return;
    }
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
    // un undo/redo collaborativo è in applicazione (asincrono): i suoi tile
    // stanno venendo scambiati, niente tratti sotto
    if (this.collab.applying) return;
    if (this.collab.remoteTransformActive) {
      this.collab.ui.toast('Transform in progress: wait for ✓ or cancel it.');
      return;
    }
    // effetto/stile in anteprima: un gesto sul canvas è l'annullo implicito
    // (l'applicazione è solo esplicita col ✓)
    for (const t of this.fxTools) if (t.pending) t.cancel();
    // ColorDrop "riempi al tocco": giù = anteprima del riempimento,
    // scorrere in orizzontale = soglia, su = conferma (fill_ui.js)
    if (this.fillUI.tapActive) return this.fillUI.tapStart(board, x, y);
    // strumento Selezione: il click campiona il colore e costruisce la
    // maschera, oppure avvia lazo libero/poligonale; nessun tratto
    if (brush.tool === 'select') {
      if (this.selection.kind === 'color') return this.selectAt(board, x, y);
      return this.startLasso(board, x, y, t);
    }
    // strumento Sposta/Trasforma: il drag sul canvas trasla la sessione
    if (brush.tool === 'move') return this.transform.dragStart(x, y);
    const target = board.mgr.paintTarget;
    if (!target) return; // attivo non dipingibile (testo/nascosto): ignora
    if (!this._firstStrokeTracked) {
      this._firstStrokeTracked = true;
      track('first_stroke', { tool: brush.tool, boardCount: this.boards.boards.length });
    }
    this._flushPendingStroke();
    this._strokeLayerId = target.id;
    this._strokeClip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    // selezione attiva SU QUESTO canvas: il tratto scrive solo dentro la
    // maschera (su un altro canvas si disegna libero)
    const sel = this.selection;
    this._strokeSel = sel.active && sel.boardId === board.id
      ? { mask: sel.mask, x: board.x, y: board.y, w: board.w, h: board.h }
      : null;
    // specchio verticale: l'asse (metà del canvas) si fotografa al pen-down
    // e vale per TUTTO il tratto, replay della punta compreso — un toggle a
    // metà gesto non spezza il disegno in corso
    this.queue.mirrorX = this.mirrorV ? board.x + board.w / 2 : null;
    this.queue.patternTile = this.patternMode ? { x: board.x, y: board.y, w: board.w, h: board.h } : null;
    if (brush.tool === 'blur') {
      this.blurSession = new BlurBrushSession(this, board, target, this._strokeClip,
        this._strokeSel, this.queue.mirrorX, this.queue.patternTile, x, y, p);
      this.strokeLive = true;
      this.pendingCommit = false;
      return;
    }
    if (brush.tool === 'liquify') {
      this.liquifySession = new LiquifyBrushSession(this, board, target, this._strokeClip,
        this._strokeSel, this.queue.mirrorX, this.queue.patternTile, x, y, p, t);
      this.strokeLive = true;
      this.pendingCommit = false;
      return;
    }
    // zoom camera = scala della velocità: la dinamica legge il gesto fisico
    this.engine.begin(x, y, p, t, brush, undefined, this.camera.zoom);
    this.raster.beginStroke(this.engine.snap, this._strokeClip, this._strokeSel);
    this.strokeLive = true;
    this.pendingCommit = false;
    // collaborazione: pennello fotografato + seed + eventi -> replay remoto
    this.collab.strokeBegin(board, target.id, x, y, p, t);
  }

  // Chiude del tutto l'eventuale tratto precedente: drena la sua coda
  // (col suo snapshot e il suo clip), poi completa il commit in sincrono.
  _flushPendingStroke() {
    if (this.blurSession) {
      this.blurSession.finish();
      this.blurSession = null;
      this.strokeLive = false;
    }
    if (this.liquifySession) {
      this.liquifySession.ending = true;
      this.liquifySession.process(Infinity);
      this.liquifySession = null;
      this.strokeLive = false;
    }
    if (!this.strokeLive && !this.commitJob) return;
    if (this.strokeLive) {
      if (this.engine.snapDirty) this._syncSnapStroke();
      if (this.queue.count > 0) this.raster.run(this.queue, Infinity);
      if (this.pendingCommit) this._beginCommit();
    }
    if (this.commitJob) this._runCommit(Infinity);
  }

  cancelStroke() {
    if (this.blurSession) {
      this.blurSession.cancel();
      this.blurSession = null;
      this.strokeLive = false;
      return;
    }
    if (this.liquifySession) {
      this.liquifySession.cancel();
      this.liquifySession = null;
      this.strokeLive = false;
      return;
    }
    this.engine.cancel();
    this.queue.clear();
    this._dropStrokeBuffer();
    this.strokeLive = false;
    this.pendingCommit = false;
    this.collab.strokeCancel();
  }

  /**
   * Ricorda il primo stato visto da Liquify per il layer corrente. Reconstruct
   * e Reset leggono questa base finche' l'utente resta nello strumento.
   * @param {number} layerId @param {number} key @param {number} cx @param {number} cy
   * @param {Chunk|null} chunk
   */
  liquifyRememberChunk(layerId, key, cx, cy, chunk) {
    if (!this._liquifyBase || this._liquifyBase.layerId !== layerId) {
      this._liquifyBase = { layerId, chunks: new Map() };
    }
    if (this._liquifyBase.chunks.has(key)) return;
    this._liquifyBase.chunks.set(key, {
      cx, cy,
      data: chunk ? chunk.data.slice() : null,
    });
  }

  /**
   * @param {number} layerId @param {number} wx @param {number} wy
   * @param {number[]} fallback premultiplied rgba corrente
   * @param {number[]} out
   */
  liquifyBasePixel(layerId, wx, wy, fallback, out) {
    const base = this._liquifyBase;
    if (!base || base.layerId !== layerId) {
      out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2]; out[3] = fallback[3];
      return out;
    }
    const cx = wx >> CHUNK_SHIFT, cy = wy >> CHUNK_SHIFT;
    const b = base.chunks.get(chunkKey(cx, cy));
    if (!b) {
      out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2]; out[3] = fallback[3];
      return out;
    }
    if (!b.data) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return out;
    }
    const lx = wx - (cx << CHUNK_SHIFT);
    const ly = wy - (cy << CHUNK_SHIFT);
    const o = ((ly << CHUNK_SHIFT) + lx) * 4;
    out[0] = b.data[o]; out[1] = b.data[o + 1]; out[2] = b.data[o + 2]; out[3] = b.data[o + 3];
    return out;
  }

  liquifyClearBaseline() { this._liquifyBase = null; }

  liquifyResetActive() {
    const layer = this.layerMgr.active;
    const base = this._liquifyBase;
    if (!layer || layer.kind !== 'raster' || !layer.store || !base || base.layerId !== layer.id || base.chunks.size === 0) return false;
    const store = layer.store;
    let changed = false;
    this.undoMgr.captureBegin(layer.id);
    for (const [key, b] of base.chunks) {
      const cur = store.getByKey(key);
      if (cur) this.undoMgr.captureChunk(key, b.cx, b.cy, cur.data);
      else if (b.data) this.undoMgr.captureChunk(key, b.cx, b.cy, null);
      else continue;
      if (b.data) {
        const chunk = store.getOrCreate(b.cx, b.cy);
        chunk.data.set(b.data);
        chunk.touched = true;
        store.markDirty(chunk);
      } else {
        store.remove(key, this._disposeTex);
      }
      changed = true;
    }
    this.undoMgr.captureEnd();
    if (!changed) {
      this.undoMgr.captureCancel();
      return false;
    }
    layer.thumbDirty = true;
    this.ui.layersUI.scheduleThumbs();
    return true;
  }


  _dropStrokeBuffer() {
    // i chunk tornano al pool (texture riusata) o liberano la texture
    this.strokeStore.releaseAll(this._disposeTex);
  }

  _syncSnapStroke() {
    if (!this.engine.snapMode || !this.engine.snapDirty) return false;
    this.queue.clear();
    this._dropStrokeBuffer();
    this.raster.beginStroke(this.engine.snap, this._strokeClip, this._strokeSel);
    return this.engine.emitSnap();
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
    /** @type {Set<number>|null} */
    let clip = null;
    if (rect) {
      clip = new Set();
      // Specchio e pattern attivi: anche le copie generate vanno svuotate e
      // ridisegnate, altrimenti la punta corretta resterebbe piena sui bordi.
      const rects = this._strokeRepeatRects(rect);
      for (const rc of rects) {
        const cx0 = rc.x0 >> CHUNK_SHIFT, cy0 = rc.y0 >> CHUNK_SHIFT;
        const cx1 = rc.x1 >> CHUNK_SHIFT, cy1 = rc.y1 >> CHUNK_SHIFT;
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const key = chunkKey(cx, cy);
            clip.add(key);
            this.strokeStore.remove(key, this._disposeTex);
          }
        }
      }
    } else {
      this._dropStrokeBuffer();
    }
    this.raster.beginStroke(this.engine.snap, this._strokeClip, this._strokeSel);
    this.raster.clip = clip;
    this.engine.replay();
    this.raster.run(this.queue, Infinity);
    this.raster.clip = null;
  }

  /** @param {{x0:number,y0:number,x1:number,y1:number}} rect */
  _strokeRepeatRects(rect) {
    const bases = [rect];
    const ax = this.queue.mirrorX;
    if (ax !== null) {
      bases.push({
        x0: Math.floor(2 * ax - rect.x1),
        y0: rect.y0,
        x1: Math.ceil(2 * ax - rect.x0),
        y1: rect.y1,
      });
    }
    const tile = this.queue.patternTile;
    if (!tile || tile.w <= 0 || tile.h <= 0) return bases;
    /** @type {{x0:number,y0:number,x1:number,y1:number}[]} */
    const out = [];
    for (const r of bases) {
      for (const ox of [-tile.w, 0, tile.w]) {
        for (const oy of [-tile.h, 0, tile.h]) {
          out.push({
            x0: Math.floor(r.x0 + ox),
            y0: Math.floor(r.y0 + oy),
            x1: Math.ceil(r.x1 + ox),
            y1: Math.ceil(r.y1 + oy),
          });
        }
      }
    }
    return out;
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
      // con la selezione un chunk toccato può essere stato interamente
      // azzerato dalla maschera: committarlo creerebbe chunk vuoti nel doc
      if (sc.touched && (this._strokeSel === null || !isChunkBlank(sc))) touched.push(sc);
      else this.strokeStore.remove(sc.key, this._disposeTex);
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
    let n = 0;
    while (job.index < job.chunks.length && n < maxChunks) {
      const sc = job.chunks[job.index++];
      commitChunk(job.store, sc, job.snap,
        (key, cx, cy, before) => this.undoMgr.captureChunk(key, cx, cy, before),
        this.heap);
      this.strokeStore.remove(sc.key, this._disposeTex);
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
    // trasformazione/effetto pendente: prima ✓ o ✗ (i bottoni sono lì apposta)
    if (this.collab.remoteTransformActive || this.strokeLive || this.commitJob || this.transform.pending || this.transform.dragging || this.fx.pending || this.layerStyle.pending || this.fillUI.pending) return;
    await this.undoMgr.undo(this._undoHost());
    // l'undo può aver cambiato i pixel sotto la sessione: si rifotografa
    this.transform.rebind();
    this.planes.invalidate();
    this.ui.layersUI.sync();
    this.ui.layersUI.scheduleThumbs();
  }

  async redo() {
    if (this.collab.remoteTransformActive || this.strokeLive || this.commitJob || this.transform.pending || this.transform.dragging || this.fx.pending || this.layerStyle.pending || this.fillUI.pending) return;
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
    this.liquifyClearBaseline();
    this.cancelLasso();
    this.selection.clear(); // il board della selezione sta per morire
    for (const b of this.boards.boards) {
      for (const l of b.mgr.layers) {
        if (l.store) {
          l.store.destroy(this._disposeTex);
          this._allStores.delete(l.store);
        } else {
          freeBlockBitmap(l);
        }
      }
      b.mgr.layers.length = 0;
    }
    this.boards.boards.length = 0;
    const board = this.boards.add('Canvas 1');
    const first = makeRasterLayer('Layer 1', this.heap);
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
    this.layerMgr.bump(); // i piani reinseriscono il canvas nuovo
    this._resize();
  }

  _frame() {
    const frameStart = performance.now();
    // 1. input (gesture + conversione in punti stroke)
    this.input.drain();
    // a mano ferma il dot di pen-down matura (cresce fino a piena dimensione)
    if (this.engine.active) {
      const now = performance.now();
      // se è QUESTO tick a chiudere la finestra di velocità, va replicato
      // sui peer: il replay remoto deve chiuderla nello stesso punto
      const held = this.engine._held;
      this.engine.tick(now);
      if (held && !this.engine._held) this.collab.strokeTick(now);
      if (this.engine.snapDirty) this._syncSnapStroke();
    }
    const t1 = performance.now();

    // 2. (il sampling avviene dentro drain via engine.move)
    // 3. raster con budget
    let rasterPx = 0;
    if (this.queue.count > 0) {
      rasterPx = this.raster.run(this.queue, this.budgetPx);
    }
    if (this.liquifySession) this._pumpLiquify(5.5);
    const t2 = performance.now();

    // commit differito: parte quando il catch-up è finito, poi procede
    // a fette per non produrre un frame da centinaia di ms
    if (this.pendingCommit && this.queue.count === 0 && !this.engine.active) {
      this._beginCommit();
    }
    if (this.commitJob) this._runCommit(this.COMMIT_CHUNKS_PER_FRAME);
    // collaborazione: applica i tratti/op remoti quando la pipeline è libera,
    // invia i punti bufferizzati, disegna cursori e scie degli altri
    this.collab.frame();

    // maschere di ritaglio: la base effettiva di ogni livello clippato,
    // risolta PRIMA di proxy e piani (bake e renderer leggono layer.clipBase)
    for (const b of this.boards.boards) refreshClipBases(b.mgr.layers);

    // 4+5. upload dei tile sporchi e present, piano per piano
    const snap = this.raster.snap;
    const liveOpacity = this.strokeLive && snap ? snap.globalOpacity : 1;
    const liveEraser = this.strokeLive && snap ? snap.eraser : false;
    // proxy dei board (solo WebGL): quad piatti al posto dei chunk per i
    // board non attivi. Il build è background: si ferma durante input/sessioni
    // e usa un budget piccolo quando il frame precedente era già pesante.
    this._syncProxyBuildBudget();
    const proxies = this.renderer instanceof GLRenderer && this.renderer.ok
      ? this.proxy.update(this.renderer, this.boards, this.boards.activeId,
        this.camera, this._proxyBuildSteps, this._proxyBuildMs, this.planes)
      : null;
    // Solo il testo attivo resta SVG vivo: i pannelli/gizmo lo editano come
    // vettore puro. Gli altri testi vengono presentati come quad cache dentro
    // la pila raster; il dato editabile resta item+style.
    const activeLayer = this.layerMgr.active;
    const liveTextId = activeLayer && activeLayer.kind === 'text' ? activeLayer.id : 0;
    if (liveTextId !== this._liveTextId) {
      this._liveTextId = liveTextId;
      this.boards.bump();
    }
    // bake dei testi (a budget): un bake nuovo deve ridipingere anche gli
    // eventuali piani 2D del pool che lo contengono
    if (this.textQuads.update(this.renderer, this.boards, this.camera,
      liveTextId, proxies ? proxies.skip : null) > 0) {
      this.planes.invalidate();
    }
    // sessione Sposta/Trasforma: ciclo di vita (auto-commit al cambio di
    // bersaglio) + frame del quad per i renderer; il gizmo si riposiziona qui
    this.transform.sync(this.camera);
    const tfFrame = this.transform.frame() || this.collab.transformFrame();
    this._lastTransformFrame = tfFrame;
    // sessioni Effetti/Stile livello: annullo implicito se il bersaglio
    // cambia + frame del quad cotto per i renderer (una sola sessione viva)
    this.fx.sync();
    this.layerStyle.sync();
    const fxFrame = this.fx.frame() || this.layerStyle.frame();
    this._lastFxFrame = fxFrame;
    this.planes.render({
      camera: this.camera, boards: this.boards, activeId: this.layerMgr.activeId,
      strokeStore: this.strokeStore,
      liveOpacity, eraserLive: liveEraser,
      bottom: this.renderer, bottomCanvas: this.canvas,
      proxies, transform: tfFrame, fx: fxFrame,
      textQuads: this.textQuads, liveTextId,
    });
    // gabbia della distorsione testo: segue camera e modifiche (uscita a
    // confronto di stringa quando non c'è niente da fare)
    this.ui.textUI.gizmo.sync(this.camera);
    // overlay della selezione: ricostruisce al cambio di maschera,
    // riposiziona al cambio camera (no-op altrimenti)
    this._syncLassoPreview();
    this.selectionUI.sync(this.camera);
    // guida dello specchio verticale (nascosta col tratto in corso)
    this._syncMirrorGuide();
    this._syncPatternGuide();
    this._syncPatternRepeatPreview();
    // VRAM limitata: eviction delle texture fuori schermo (riupload on-demand).
    // I chunk dei piani 2D hanno tex nulla: il loop li salta da solo.
    // Gli store dei board coperti da un quad proxy contano come fuori-vista:
    // a zoom-out la vista copre tutto e il cap, da solo, non rientrerebbe
    // mai. I board in warm-up restano fuori dal set: le loro texture stanno
    // rinascendo a budget proprio adesso.
    const rasterStores = this.boards.allRasterStores();
    /** @type {Set<import('./store.js').ChunkStore>|null} */
    let covered = null;
    if (proxies && proxies.skip.size > 0) {
      covered = new Set();
      for (const b of this.boards.boards) {
        if (proxies.loading.has(b.id)) continue;
        for (const l of b.mgr.layers) {
          if (l.store && proxies.skip.has(l.id)) covered.add(l.store);
        }
      }
    }
    this.renderer.evict(rasterStores, this.camera, 1024, covered);
    this.planes.evict(this.camera, covered);

    // budget adattivo: tiene il raster sotto ~6 ms anche su hardware lento
    const rasterMs = t2 - t1;
    if (rasterPx > 0) {
      if (rasterMs > 7) this.budgetPx = Math.max(262_144, this.budgetPx * 0.85);
      else if (rasterMs < 4 && this.queue.count > 0) this.budgetPx = Math.min(12_000_000, this.budgetPx * 1.15);
    }

    this.ui.layersUI.sync();
    this.ui.updateCursor(this.input, this.camera);
    this.ui.updateZoomLabel(this.camera.zoom);

    const frameEnd = performance.now();
    const frameMs = frameEnd - frameStart;
    this._frameMsAvg = this._frameMsAvg
      ? this._frameMsAvg * 0.85 + frameMs * 0.15
      : frameMs;
    this._lastFrameWall = frameEnd;
    this._scheduleFrame();
  }

  /** @param {number} maxMs */
  _pumpLiquify(maxMs) {
    const s = this.liquifySession;
    if (!s) return;
    if (s.process(maxMs)) {
      this.liquifySession = null;
      this.strokeLive = false;
    }
  }
}

// Il core wasm si carica PRIMA di costruire l'App: gli store nascono già
// nella memoria lineare (mai chunk misti JS/wasm). ?engine=js forza il
// fallback puro JS (utile per benchmark e debug).
await loadRuntimeConfig();
installTelemetry();
wireFeedbackLinks();
const forceJs = new URLSearchParams(location.search).get('engine') === 'js';
const heap = forceJs ? null : await WasmHeap.load(new URL('./raster_core.wasm', import.meta.url));
const app = new App(heap);
const projects = new ProjectHub(app);
track('app_ready', { engine: heap ? 'wasm' : 'js' });
// pannello stress test (bottone ⚡, ?stress=BxL[xCOV%][tN], __stress da console)
initStress(app);
// Diagnostica del testo 3D/ombra dalla console: __textDebug3d() fa toggle,
// __textDebug3d(true|false) imposta. Costosa: accenderla solo per indagare.
/** @type {any} */ (window).__textDebug3d = setBlockDebug3d;
// Effetti testo: GPU (SDF) di default, __textGpu(false) forza il path CPU
// per confronto dal vivo. __textGpu() fa toggle.
/** @type {any} */ (window).__textGpu = setTextGpu;
/** @type {any} */ (window).__projects = projects;
