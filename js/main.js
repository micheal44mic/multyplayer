// FRAME LOOP — unico orologio del sistema.
// 1. drena input  2. sampler -> descrittori  3. raster con budget
// 4. upload tile sporchi  5. present (piani). Zero allocazioni nel path
// per-frame. Il documento è una lista di CANVAS (artboard) affiancati;
// ogni canvas ha la sua pila di livelli (raster + testo), pennello e gomma
// scrivono sul livello attivo del canvas attivo e il tratto è ritagliato ai
// suoi bordi. I piani DOM compongono le pile di tutti i canvas.

import { Camera, ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { clamp } from './util.js';
import { ChunkStore, chunkKey, translateStore, forEachChunkInRect, CHUNK, CHUNK_SHIFT } from './store.js';
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
import { ProjectHub } from './project_io.js';
import { installTelemetry, loadRuntimeConfig, track, wireFeedbackLinks } from './telemetry.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./stroke.js').Snap} Snap */
/** @typedef {import('./layers.js').Layer} Layer */

// Chunk senza alcun pixel scritto (premultiplied: parola u32 0 = vuoto).
/** @param {Chunk} c */
function chunkIsBlank(c) {
  const u = new Uint32Array(c.data.buffer, c.data.byteOffset, c.data.length >> 2);
  for (let i = 0; i < u.length; i++) if (u[i] !== 0) return false;
  return true;
}

/** @param {{x:number,y:number}[]} points @param {{x:number,y:number}|null} preview @param {boolean} close */
function lassoPath(points, preview = null, close = false) {
  const n = points.length + (preview ? 1 : 0);
  if (n < 1) return '';
  /** @type {string[]} */
  const parts = [];
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
    /** @type {BlurBrushSession|null} */
    this.blurSession = null;      // pennello blur: scrive direttamente sul layer
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

    this.ui = new UI(this);
    // ColorDrop: goccia di colore trascinabile dal rail + "riempi al tocco"
    this.fillUI = new FillUI(this);
    // strumento Sposta/Trasforma: sessione con bbox, ✓/✗, anteprima a quad
    this.transform = new TransformTool(this);
    // pannello Effetti: blur in anteprima GPU, rasterizzato al ✓
    this.fx = new FxTool(this);
    // pannello Stile livello (traccia): stessa sessione a ✓/✗
    this.layerStyle = new LayerStyleTool(this);
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
        raster.store.destroy((c) => this.renderer.disposeChunkTex(c));
        this._allStores.delete(raster.store);
        raster = null;
        alert(`Maximum ${MAX_LAYERS} layers.`);
        return false;
      }
      raster = null;
      return true;
    } catch (err) {
      if (raster && raster.store) {
        raster.store.destroy((c) => this.renderer.disposeChunkTex(c));
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
        this.renderer.disposeChunkTex(c);
        c.c2d = null;
        c.texDirty = true;
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
    if (brush.tool === 'blur') {
      this.blurSession = new BlurBrushSession(this, board, target, this._strokeClip,
        this._strokeSel, this.queue.mirrorX, x, y, p);
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
    this.engine.cancel();
    this.queue.clear();
    this._dropStrokeBuffer();
    this.strokeLive = false;
    this.pendingCommit = false;
    this.collab.strokeCancel();
  }


  _dropStrokeBuffer() {
    // i chunk tornano al pool (texture riusata) o liberano la texture
    this.strokeStore.releaseAll((c) => this.renderer.disposeChunkTex(c));
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
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => this.renderer.disposeChunkTex(c);
    /** @type {Set<number>|null} */
    let clip = null;
    if (rect) {
      clip = new Set();
      // specchio attivo: anche la punta RIFLESSA va svuotata e ridisegnata
      // (il replay ri-emette tutto il registro e la coda lo specchia: dentro
      // il clip dell'unione i due tratti rinascono interi, fuori costo ~0)
      const ax = this.queue.mirrorX;
      const rects = ax !== null
        ? [rect, { x0: Math.floor(2 * ax - rect.x1), y0: rect.y0, x1: Math.ceil(2 * ax - rect.x0), y1: rect.y1 }]
        : [rect];
      for (const rc of rects) {
        const cx0 = rc.x0 >> CHUNK_SHIFT, cy0 = rc.y0 >> CHUNK_SHIFT;
        const cx1 = rc.x1 >> CHUNK_SHIFT, cy1 = rc.y1 >> CHUNK_SHIFT;
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const key = chunkKey(cx, cy);
            clip.add(key);
            this.strokeStore.remove(key, dispose);
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
      if (sc.touched && (this._strokeSel === null || !chunkIsBlank(sc))) touched.push(sc);
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
    this.cancelLasso();
    this.selection.clear(); // il board della selezione sta per morire
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
    // proxy dei board per lo zoom-out (solo WebGL): quad piatti al posto dei
    // chunk per i board non attivi. Durante un tratto la build resta ferma.
    const proxies = this.renderer instanceof GLRenderer && this.renderer.ok
      ? this.proxy.update(this.renderer, this.boards, this.boards.activeId,
        this.camera, !this.strokeLive, this.planes)
      : null;
    // testo "vivo" = livello testo ATTIVO del board attivo: pannello Testo,
    // gabbia distort e sessione Sposta passano da lì (e col testo attivo il
    // pennello comunque non scrive). Tutti gli altri testi sono quad cotti
    // dentro la pila. Al cambio i piani ricostruiscono i gruppi.
    const actLayer = this.boards.active ? this.boards.active.mgr.active : undefined;
    const liveTextId = actLayer && actLayer.kind === 'text' ? actLayer.id : 0;
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
    // sessioni Effetti/Stile livello: annullo implicito se il bersaglio
    // cambia + frame del quad cotto per i renderer (una sola sessione viva)
    this.fx.sync();
    this.layerStyle.sync();
    const fxFrame = this.fx.frame() || this.layerStyle.frame();
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

    this._lastFrameWall = performance.now();
    this._scheduleFrame();
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
