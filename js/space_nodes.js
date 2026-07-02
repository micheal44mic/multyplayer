// Spaces nodes (text/image) are document objects, not DOM objects. The scene
// is drawn on one canvas; a single DOM editor is mounted only for the active
// node. I nodi image generano via /api/ai/generate (Gemini) spendendo token
// del wallet (js/tokens.js); il risultato ridimensiona il nodo al suo aspect.

import { wallet, genCost } from './tokens.js';

const TEXT_NODE_DESIGN_W = 224;
const TEXT_NODE_DESIGN_H = 224;
const TEXT_NODE_SCREEN_W = 112;
const TEXT_NODE_SCREEN_H = 112;
const PROXY_MIN_SCREEN_PX = 8; // sotto: rettangolo proxy (il nodo è un puntino, nulla da vedere)
const DIRECT_FALLBACK_MIN_PX = 72; // cache fredda + budget finito: sotto questa taglia proxy, MAI render diretto (decine di layout testo in un frame)
const VIEWPORT_PAD_PX = 320;
const GRID_CELL = 1024;
const HIT_PAD_PX = 4;
const PREVIEW_CACHE_SIZE = 256; // px device (bucket massimo), scalato fino a 2x col dpr
const PREVIEW_CACHE_MAX = 512; // backstop sul numero di entry
const PREVIEW_CACHE_BYTES = 48 << 20; // tetto memoria a byte REALI (le entry bucketed sono piccole)
const PREVIEW_BUCKET_MIN = 32; // bucket minimo: nodi lontani = cache minuscole
const PREVIEW_BUILD_BUDGET = 8; // (ri)costruzioni cache per frame: il resto resta stantio e si raffina
const BASE_SIDE = 512; // lato lungo della base persistente per variante (sorgente di miniature/striscia/editor)
const FULL_ACQUIRE_RATIO = 1.15; // full-res richiesto solo quando il nodo su schermo supera la base di questo margine
const FULL_IDLE_MS = 5000; // full-res rilasciato dopo questo tempo senza necessità (isteresi temporale)
const FULL_SWEEP_MS = 2000; // periodo dello sweep di rilascio dei full-res
const HOVER_CHROME_MIN_PX = 96; // sotto questa taglia schermo il chrome hover non appare (nodo nuovo = 112px)
// margini keep-alive: il chrome resta mentre il cursore raggiunge pillola/porte/+
const HOVER_KEEP_TOP_PX = 88;
const HOVER_KEEP_LEFT_PX = 180;
const HOVER_KEEP_RIGHT_PX = 64;
const HOVER_KEEP_BOTTOM_PX = 20;

const TEXT_PLACEHOLDER = 'Try "A narrative about the discovery of an ancient relic"';
const IMAGE_PLACEHOLDER = 'Try "A close-up macro shot of dew on a spider web"';
const GEN_PROMPT_PLACEHOLDER = 'Describe the image…';

// collegamenti: porta out = bordo destro (il +), porta in = bordo sinistro
const LINK_DROP_GAP_PX = 104; // click secco sul +: gap dal bordo che lascia respiro a porta out (+26), presa (-21.5) e curva
const LINK_CLICK_SLOP_PX = 6; // sotto questo spostamento il rilascio conta come click
const LINK_COLOR = 'rgba(90, 96, 110, 0.65)'; // anima scura: legge sul workspace chiaro
const LINK_HALO = 'rgba(255, 255, 255, 0.5)'; // alone sotto l'anima: legge sui nodi scuri
const LINK_COLOR_HOT = 'rgba(77, 124, 254, 0.95)'; // --accent
const LINK_ACCENT = '#4d7cfe'; // prese/spine dei fili: lo stesso di .shc-dot linked
const IN_PORT_R = 7.5; // raggio della presa = metà del cerchio .shc-dot (15px)

// resize dei nodi text: maniglie in px SCHERMO, limiti in px di DESIGN —
// minimo ≈ mezza casella (header + qualche riga), massimo = 3× il lato di
// design (un nodo GIÀ oltre il tetto non scatta indietro: solo non cresce)
const RESIZE_MIN_DESIGN_W = 128;
const RESIZE_MIN_DESIGN_H = 96;
const RESIZE_MAX_DESIGN_W = TEXT_NODE_DESIGN_W * 3;
const RESIZE_MAX_DESIGN_H = TEXT_NODE_DESIGN_H * 3;
/** @type {Record<string, string>} */
const RESIZE_CURSORS = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};

const GEN_ETA_MS = 15000; // stima media mostrata durante l'attesa
const GEN_GROW = 2; // alla prima generazione il nodo raddoppia (come la reference)

// Parametri di generazione (i formati e le taglie sono quelli dell'API Gemini)
const GEN_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const GEN_QUALITIES = ['1K', '2K', '4K'];
const GEN_VARIANTS = [1, 2, 4];
const QUALITY_MODELS = new Set(['gemini-3-pro-image']); // solo il Pro sceglie la risoluzione
const REF_MAX_PRO = 14;
const REF_MAX_BASE = 3;
const REF_SIDE_MAX = 1024; // i riferimenti si spediscono ridotti

/** @typedef {{ id:string, name:string, suffix?:string }} GenStyle */
/** @type {GenStyle[]} */
const GEN_STYLES = [
  { id: '', name: 'Nessuno stile' },
  { id: 'photo', name: 'Foto', suffix: ', photorealistic photograph, natural lighting, high detail' },
  { id: 'flat', name: 'Flat mockup', suffix: ', clean flat product mockup, plain studio background, flat vector-like style' },
  { id: 'illustration', name: 'Illustrazione', suffix: ', digital illustration, clean lines, rich colors' },
  { id: 'render3d', name: 'Render 3D', suffix: ', high quality 3D render, soft studio lighting' },
  { id: 'pixel', name: 'Pixel art', suffix: ', pixel art style, crisp pixels' },
  { id: 'watercolor', name: 'Acquerello', suffix: ', watercolor painting style, soft edges' },
];

/** @typedef {import('./main.js').App} App */
/** @typedef {'text'|'image'} SpaceNodeKind */
/** @typedef {{ from:number, to:number }} SpaceLink */
/** @typedef {{ url:string, b64:string }} GenRef */
/** @typedef {ImageBitmap|HTMLImageElement} GenImage */
/**
 * Variante generata come RECORD STABILE (non più il bitmap nudo): `png` è
 * l'archivio compresso — chiave del salvataggio E sorgente del re-decode —,
 * `base` la copia ≤BASE_SIDE sempre residente, `full` il bitmap pieno
 * residente solo quando serve (rilascio con isteresi, MAI senza png: sarebbe
 * l'unica copia dei pixel).
 * @typedef {{ png:string|null, w:number, h:number, base:HTMLCanvasElement|null, full:GenImage|null, fullT:number, disposed:boolean, refJpeg:string|null, _pending:Promise<GenImage|null>|null }} ImgRec
 */
/** @typedef {{ id:number, kind:SpaceNodeKind, label:string, x:number, y:number, w:number, h:number, text:string, fs?:number, model?:string, ratio?:string, quality?:string, nvars?:number, enhance?:boolean, style?:string, refs?:GenRef[], variants?:ImgRec[], img?:ImgRec|null, imgW?:number, imgH?:number, busy?:boolean, genT0?:number, genErr?:string, _pv?:number }} SpaceNode */

/**
 * Unità mondo per px di design del nodo. I text la FISSANO alla creazione
 * (node.fs): il resize estende lo spazio e il testo rifluisce, i caratteri
 * non cambiano corpo. Gli image (e i text salvati prima di fs) restano al
 * min-fit sul design 224×224, com'erano.
 * @param {SpaceNode} node
 */
function nodeDesignScale(node) {
  return node.fs || Math.min(node.w, node.h) / TEXT_NODE_DESIGN_W;
}

/** @param {string} model */
function refMax(model) {
  return QUALITY_MODELS.has(model) ? REF_MAX_PRO : REF_MAX_BASE;
}

/** @param {SpaceNode} node */
function nodeGenCost(node) {
  return genCost(node.model || defaultImageModel(), node.quality || '1K', node.nvars || 1);
}

const FALLBACK_IMAGE_MODELS = [
  { id: 'gemini-2.5-flash-image', name: 'Nano Banana' },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2' },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro' },
];

// I modelli sono gli stessi del riempimento AI: il select #ai-model resta la
// fonte unica, il fallback copre pagine senza quel pannello (es. test).
function imageModels() {
  const sel = document.getElementById('ai-model');
  if (sel instanceof HTMLSelectElement && sel.options.length) {
    return [...sel.options].map((o) => ({ id: o.value, name: o.textContent?.trim() || o.value }));
  }
  return FALLBACK_IMAGE_MODELS;
}

/** @param {string} id */
function imageModelName(id) {
  return imageModels().find((m) => m.id === id)?.name || id;
}

function defaultImageModel() {
  const models = imageModels();
  let saved = '';
  try {
    saved = localStorage.getItem('fable-paint.space-image-model') ||
      localStorage.getItem('fable-paint.ai-model') || '';
  } catch { /* storage unavailable */ }
  const found = models.find((m) => m.id === saved);
  return (found || models[models.length - 1]).id;
}

/** @param {string} paths */
function svgIcon(paths) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

/**
 * @param {string} base64
 * @param {string} [mime]
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
async function decodeGenImage(base64, mime) {
  const clean = String(base64 || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'image/png' });
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch { /* fallback HTMLImageElement sotto */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Decodifica immagine fallita.')); };
    im.src = url;
  });
}

/**
 * Data URL PNG del record, memoizzata: i salvataggi successivi riusano la
 * stringa senza ri-encodare (il restore la porta già nel record). Finché il
 * png non esiste il full-res resta residente per costruzione, quindi la
 * sorgente c'è sempre; per immagini ≤BASE_SIDE la base è copia intera.
 * @param {ImgRec} rec
 */
function encodeImgRec(rec) {
  if (rec.png) return rec.png;
  const src = rec.full || rec.base;
  if (!src) return '';
  const w = /** @type {any} */ (src).width || /** @type {any} */ (src).naturalWidth || 1;
  const h = /** @type {any} */ (src).height || /** @type {any} */ (src).naturalHeight || 1;
  const cnv = document.createElement('canvas');
  cnv.width = w;
  cnv.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (cnv.getContext('2d'));
  ctx.drawImage(/** @type {any} */ (src), 0, 0);
  rec.png = cnv.toDataURL('image/png');
  return rec.png;
}

/** Chiude il record: un decode in volo che atterra dopo trova disposed e si richiude. @param {ImgRec} rec */
function disposeImgRec(rec) {
  rec.disposed = true;
  if (rec.full && 'close' in rec.full) rec.full.close();
  rec.full = null;
  rec.base = null;
}

/** Chiude img + tutte le varianti (Set: la selezionata è dentro variants). @param {SpaceNode} node */
function closeNodeImages(node) {
  const all = new Set(node.variants || []);
  if (node.img) all.add(node.img);
  for (const rec of all) disposeImgRec(rec);
  node.img = null;
  node.variants = [];
}

/** @param {string} prompt */
function titleFromPrompt(prompt) {
  const t = String(prompt).replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  const cut = t.length > 26 ? t.slice(0, 26).trimEnd() + '…' : t;
  return cut ? cut[0].toUpperCase() + cut.slice(1) : '';
}

/** @param {number} t ms trascorsi @returns {number} progresso 0..0.96 */
function genProgress(t) {
  const lin = Math.min(1, t / GEN_ETA_MS) * 0.9;
  const over = t > GEN_ETA_MS ? (1 - Math.exp(-(t - GEN_ETA_MS) / 8000)) * 0.06 : 0;
  return Math.min(0.96, lin + over);
}

const IC_IMAGE = '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/>';
const IC_CARET = '<path d="M8 10l4 4 4-4"/>';

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export class SpaceNodes {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.layer = /** @type {HTMLElement} */ (document.getElementById('space-node-layer'));
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'space-node-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d', { alpha: true }));
    this.layer.appendChild(this.canvas);

    /** @type {SpaceNode[]} */
    this.nodes = [];
    this.nextId = 1;
    this.selectedId = 0;
    this.visible = false;
    this.interactive = false;
    this._version = 1;
    this._syncKey = '';
    this._screen = { x: 0, y: 0 };
    this._world = { x: 0, y: 0 };
    this._visibleRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._queryRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._drawStats = { visible: 0, full: 0, proxy: 0 };
    this._grid = new Map();
    this._nodeCells = new Map();
    /** @type {Map<number, {canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, ver:number}>} */
    this._previewCache = new Map();
    this._dpr = 1;
    this._cacheSize = PREVIEW_CACHE_SIZE;
    this._cacheBytes = 0;
    this._buildsLeft = PREVIEW_BUILD_BUDGET;
    this._wantMoreBuilds = false;
    /** @type {HTMLCanvasElement|null} */
    this._scratchA = null;
    /** @type {HTMLCanvasElement|null} */
    this._scratchB = null;
    /** @type {SpaceNode|null} */
    this._selectedNode = null;
    /** @type {HTMLElement|null} */
    this.editorEl = null;
    /** @type {HTMLTextAreaElement|null} */
    this.editorTextarea = null;
    /** @type {HTMLElement|null} */
    this.editorTitle = null;
    /** @type {HTMLCanvasElement|null} */
    this.editorImg = null;
    /** @type {HTMLTextAreaElement|null} */
    this.editorGenPrompt = null;
    /** @type {HTMLButtonElement|null} */
    this.editorGenBtn = null;
    /** @type {HTMLElement|null} */
    this.editorBalanceN = null;
    /** @type {HTMLElement|null} */
    this.editorGenErr = null;
    /** @type {HTMLElement|null} */
    this.editorLoadRing = null;
    /** @type {HTMLElement|null} */
    this.editorLoadEta = null;
    /** @type {HTMLElement|null} */
    this.editorRefsRow = null;
    /** @type {HTMLButtonElement|null} */
    this.editorRefBtn = null;
    /** @type {HTMLButtonElement|null} */
    this.editorStyleBtn = null;
    /** @type {HTMLButtonElement|null} */
    this.editorFxBtn = null;
    /** @type {HTMLElement|null} */
    this.editorStyleMenu = null;
    /** @type {HTMLInputElement|null} */
    this.editorRefInput = null;
    /** @type {HTMLElement|null} */
    this.editorVars = null;
    this._genRaf = 0;
    // rilascio dei full-res a isteresi: gira anche a camera ferma (il draw
    // non passa) e con Spaces nascosti — i fullT stantii si liberano comunque
    this._fullSweep = setInterval(() => this._sweepFulls(), FULL_SWEEP_MS);
    this._shownBalance = wallet.balance;
    wallet.onChange((balance, delta) => this._animateBalance(balance, delta));
    /** @type {{ id:number, pointerId:number, offsetX:number, offsetY:number, w:number, h:number }|null} */
    this._drag = null;
    /** @type {{ id:number, dir:string, pointerId:number, px:number, py:number, x:number, y:number, w:number, h:number }|null} */
    this._resize = null;
    /** @type {SpaceLink[]} */
    this.links = [];
    // curva pendente dal +: segue il puntatore, poi menu di creazione sul vuoto
    /** @type {{ fromId:number, pointerId:number, wx:number, wy:number, toId:number, sx:number, sy:number, moved:boolean, menu:boolean }|null} */
    this._link = null;
    /** @type {HTMLElement|null} */
    this._linkMenuEl = null;
    /** @type {HTMLElement|null} */
    this._hoverEl = null;
    /** @type {HTMLElement|null} */
    this._hoverTitle = null;
    /** @type {SpaceNode|null} */
    this._hoverNode = null;
    this._hoverKind = '';
    /** @type {HTMLElement|null} */
    this._hoverModelName = null;
    /** @type {HTMLElement|null} */
    this._hoverModelTag = null;
    /** @type {HTMLElement|null} */
    this._hoverModelMenu = null;
    /** @type {HTMLElement|null} */
    this._hoverRatioChip = null;
    /** @type {HTMLElement|null} */
    this._hoverQualityChip = null;
    /** @type {HTMLElement|null} */
    this._hoverVarsChip = null;
    /** @type {HTMLElement|null} */
    this._hoverImgCount = null;
    this._pillMenuKind = '';
    this._hoverRect = { x: 0, y: 0, w: 0, h: 0 };
    // chrome hover solo desktop: niente touch/tablet
    this._hoverEnabled = typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
    if (this._hoverEnabled) document.addEventListener('pointermove', this._onHoverMove, { passive: true });
  }

  /** @param {boolean} show @param {boolean} [interactive] */
  setVisible(show, interactive = show) {
    this.visible = show;
    this.interactive = !!interactive;
    this.layer.hidden = !show;
    this.layer.classList.toggle('space-node-layer-passive', show && !this.interactive);
    if (!this.interactive) {
      this._setHover(null);
      this.cancelLink();
    }
    if (!this.interactive && this.selectedId) this.select(0);
    if (show) this.sync(this.app.camera, true);
    else this.select(0);
  }

  createTextAtView() {
    return this.createNodeAtView('text');
  }

  createImageAtView() {
    return this.createNodeAtView('image');
  }

  /** @param {SpaceNodeKind} kind */
  createNodeAtView(kind) {
    this.cancelLink();
    const cam = this.app.camera;
    cam.screenToWorld(cam.ox + cam.w / 2, cam.oy + cam.h / 2, this._world);
    const node = this._createNode(
      kind,
      this._world.x,
      this._world.y,
      TEXT_NODE_SCREEN_W / cam.zoom,
      TEXT_NODE_SCREEN_H / cam.zoom
    );
    this.select(node.id, true);
    this.sync(cam, true);
    return node;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {string} [text]
   * @param {boolean} [sync]
   * @returns {SpaceNode}
   */
  createTextAtWorld(x, y, w, h, text = '', sync = true) {
    const node = this._createNode('text', x, y, w, h);
    node.text = text;
    this._version++;
    if (sync && this.visible) this.sync(this.app.camera, true);
    return node;
  }

  /**
   * Nodo image con risultato già pronto (stress test / import): altezza
   * derivata dall'aspect del bitmap, come dopo una generazione.
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {GenImage} img
   * @param {string} [text]
   * @param {boolean} [sync]
   * @returns {SpaceNode}
   */
  createImageAtWorld(x, y, w, img, text = '', sync = true) {
    const rec = this._makeImgRec(img);
    const node = this._createNode('image', x, y, w, w * (rec.h / rec.w));
    node.text = text;
    node.variants = [rec];
    node.img = rec;
    node.imgW = rec.w;
    node.imgH = rec.h;
    if (text) node.label = titleFromPrompt(text) || node.label;
    this._version++;
    if (sync && this.visible) this.sync(this.app.camera, true);
    return node;
  }

  clear() {
    this._setHover(null);
    this.cancelLink();
    this.select(0);
    for (const node of this.nodes) closeNodeImages(node);
    this.nodes.length = 0;
    this.links.length = 0;
    this.nextId = 1;
    this._grid.clear();
    this._nodeCells.clear();
    this._previewCache.clear();
    this._cacheBytes = 0;
    this._drag = null;
    this._version++;
    this._syncKey = '';
    this._drawStats = { visible: 0, full: 0, proxy: 0 };
    this._resizeCanvas(this.app.camera);
    this.ctx.clearRect(0, 0, this.app.camera.w, this.app.camera.h);
  }

  /**
   * Nodi in forma serializzabile per lo snapshot progetto: parametri completi,
   * riferimenti e varianti generate come PNG data-URL (i bitmap non
   * sopravvivono al JSON). L'indice della variante selezionata viaggia a parte.
   * I collegamenti viaggiano sul nodo sorgente come lista di id destinazione.
   */
  serialize() {
    return this.nodes.map((n) => {
      /** @type {any} */
      const out = {
        id: n.id,
        kind: n.kind,
        label: n.label,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        text: n.text,
      };
      if (n.kind === 'text' && n.fs) out.fs = n.fs;
      const outLinks = this.links.filter((l) => l.from === n.id).map((l) => l.to);
      if (outLinks.length) out.links = outLinks;
      if (n.kind === 'image') {
        out.model = n.model || '';
        out.ratio = n.ratio || '1:1';
        out.quality = n.quality || '1K';
        out.nvars = n.nvars || 1;
        out.enhance = !!n.enhance;
        out.style = n.style || '';
        out.refs = (n.refs || []).map((r) => r.url);
        const vars = n.variants || [];
        out.variants = vars.map(encodeImgRec);
        out.imgIndex = n.img ? vars.indexOf(n.img) : -1;
        if (n.img && out.imgIndex < 0) {
          out.variants.push(encodeImgRec(n.img));
          out.imgIndex = out.variants.length - 1;
        }
      }
      return out;
    });
  }

  /**
   * Ripristina i nodi dallo snapshot: parametri subito (sincroni), bitmap
   * decodificati in asincrono — le immagini compaiono appena i PNG sono pronti.
   * @param {any[]|null|undefined} data
   */
  restore(data) {
    this.clear();
    if (!Array.isArray(data) || !data.length) return;
    const seen = new Set();
    /** @type {[number, any[]][]} */
    const pendLinks = [];
    let maxId = 0;
    for (const sn of data) {
      if (!sn || typeof sn !== 'object') continue;
      const kind = sn.kind === 'image' ? 'image' : 'text';
      let id = Math.floor(Number(sn.id));
      if (!Number.isFinite(id) || id < 1 || seen.has(id)) id = maxId + 1;
      seen.add(id);
      maxId = Math.max(maxId, id);
      if (Array.isArray(sn.links) && sn.links.length) pendLinks.push([id, sn.links]);
      /** @type {SpaceNode} */
      const node = {
        id,
        kind,
        label: String(sn.label || '') || `${kind === 'image' ? 'Image' : 'Text'} ${id}`,
        x: Number(sn.x) || 0,
        y: Number(sn.y) || 0,
        w: Math.max(1, Number(sn.w) || TEXT_NODE_SCREEN_W),
        h: Math.max(1, Number(sn.h) || TEXT_NODE_SCREEN_H),
        text: String(sn.text || ''),
      };
      const fs = Number(sn.fs);
      if (kind === 'text' && Number.isFinite(fs) && fs > 0) node.fs = fs;
      if (kind === 'image') {
        node.model = imageModels().some((m) => m.id === sn.model) ? sn.model : defaultImageModel();
        node.ratio = GEN_RATIOS.includes(sn.ratio) ? sn.ratio : '1:1';
        node.quality = GEN_QUALITIES.includes(sn.quality) ? sn.quality : '1K';
        node.nvars = GEN_VARIANTS.includes(Number(sn.nvars)) ? Number(sn.nvars) : 1;
        node.enhance = !!sn.enhance;
        node.style = GEN_STYLES.some((s) => s.id === sn.style) ? sn.style : '';
        node.refs = (Array.isArray(sn.refs) ? sn.refs : [])
          .filter((/** @type {any} */ u) => typeof u === 'string' && u.startsWith('data:image/'))
          .map((/** @type {string} */ u) => ({ url: u, b64: u.split(',')[1] || '' }));
        node.variants = [];
        if (Array.isArray(sn.variants) && sn.variants.length) {
          this._restoreImages(node, sn.variants, Math.floor(Number(sn.imgIndex)));
        }
      }
      this.nodes.push(node);
      this._indexNode(node);
    }
    // i collegamenti si riagganciano solo a nodi davvero ripristinati
    const dedup = new Set();
    for (const [from, tos] of pendLinks) {
      for (const t of tos) {
        const to = Math.floor(Number(t));
        const key = `${from}:${to}`;
        if (!seen.has(to) || to === from || dedup.has(key)) continue;
        dedup.add(key);
        this.links.push({ from, to });
      }
    }
    this.nextId = maxId + 1;
    this._version++;
    this._syncKey = '';
    if (this.visible) this.sync(this.app.camera, true);
  }

  /**
   * Decodifica i PNG salvati e li riaggancia al nodo, se nel frattempo non è
   * stato cancellato o spazzato da un altro restore/clear.
   * @param {SpaceNode} node @param {string[]} urls @param {number} imgIndex
   */
  async _restoreImages(node, urls, imgIndex) {
    /** @type {ImgRec[]} */
    const recs = [];
    for (const url of urls) {
      if (typeof url !== 'string' || !url.startsWith('data:image/')) continue;
      try {
        const img = await decodeGenImage(url, url.slice(5, url.indexOf(';')) || 'image/png');
        recs.push(this._makeImgRec(img, url));
      } catch { /* variante illeggibile: si salta */ }
    }
    if (!this.nodes.includes(node)) {
      for (const rec of recs) disposeImgRec(rec);
      return;
    }
    if (!recs.length) return;
    node.variants = recs;
    node.img = recs[imgIndex >= 0 && imgIndex < recs.length ? imgIndex : 0];
    node.imgW = node.img.w;
    node.imgH = node.img.h;
    // il png c'è già: i full si rilasciano SUBITO (niente picco di RAM al
    // load), salvo la selezionata di un nodo già grande sotto lo zoom corrente
    for (const rec of recs) {
      if (!rec.full) continue;
      if (rec === node.img && this._nodeOnScreen(node) && this._recNeedsFull(node, rec)) {
        rec.fullT = performance.now();
        continue;
      }
      if ('close' in rec.full) rec.full.close();
      rec.full = null;
    }
    this._bumpPreview(node);
    this._refreshNodeUi(node);
  }

  stats() {
    const editor = this.editorEl?.isConnected ? 1 : 0;
    let images = 0;
    let imgBytes = 0;
    let imgFull = 0;
    /** @type {Set<ImgRec>} */
    const seen = new Set();
    for (const n of this.nodes) {
      if (n.kind !== 'image') continue;
      if (n.img) images++;
      const all = new Set(n.variants || []);
      if (n.img) all.add(n.img);
      for (const rec of all) {
        if (seen.has(rec)) continue;
        seen.add(rec);
        if (rec.full) {
          imgFull++;
          imgBytes += rec.w * rec.h * 4;
        }
        if (rec.base) imgBytes += rec.base.width * rec.base.height * 4;
      }
    }
    return {
      total: this.nodes.length,
      links: this.links.length,
      dom: this.visible ? 1 + editor : 0,
      full: this._drawStats.full,
      proxy: this._drawStats.proxy,
      selected: this.selectedId ? 1 : 0,
      editing: this.editorTextarea && document.activeElement === this.editorTextarea ? 1 : 0,
      images,
      imgBytes,
      imgFull,
    };
  }

  /** @param {number} id @param {boolean} [focus] */
  select(id, focus = false) {
    if (id === 0) {
      this._blurActiveText();
      this.selectedId = 0;
      this._selectedNode = null;
      this._unmountEditor();
      this._syncKey = '';
      if (this.visible) this.sync(this.app.camera, true);
      return;
    }
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return;
    this.selectedId = id;
    this._selectedNode = node;
    this._mountEditor(node);
    this._syncEditor(this.app.camera);
    if (focus) this.editorTextarea?.focus({ preventScroll: true });
    this._syncKey = '';
    if (this.visible) this.sync(this.app.camera, true);
  }

  _blurActiveText() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.layer.contains(active)) active.blur();
  }

  deleteSelected() {
    const id = this.selectedId;
    if (!id) return false;
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return false;
    const node = this.nodes[i];
    this._unindexNode(node);
    this._dropPreviewEntry(node.id);
    closeNodeImages(node);
    this.nodes.splice(i, 1);
    this.links = this.links.filter((l) => l.from !== id && l.to !== id);
    this.select(0);
    this._version++;
    this._syncKey = '';
    if (this.visible) this.sync(this.app.camera, true);
    return true;
  }

  /** @param {import('./camera.js').Camera} cam @param {boolean} [force] */
  sync(cam, force = false) {
    if (!this.visible) return;
    const key = [
      Math.round(cam.x * 100) / 100,
      Math.round(cam.y * 100) / 100,
      Math.round(cam.zoom * 10000) / 10000,
      cam.w, cam.h, cam.ox, cam.oy,
      Math.round((cam.dpr || 1) * 100) / 100,
      this.selectedId,
      this._drag?.id || 0,
      this._version,
    ].join('|');
    if (!force && this._syncKey === key) return;
    this._syncKey = key;
    cam.visibleRect(this._visibleRect);
    const pad = VIEWPORT_PAD_PX / Math.max(0.001, cam.zoom);
    this._queryRect.x0 = this._visibleRect.x0 - pad;
    this._queryRect.y0 = this._visibleRect.y0 - pad;
    this._queryRect.x1 = this._visibleRect.x1 + pad;
    this._queryRect.y1 = this._visibleRect.y1 + pad;
    const visibleNodes = this._queryNodes(this._queryRect);
    this._draw(cam, visibleNodes);
    this._syncEditor(cam);
    this._syncHover(cam);
  }

  /** @param {SpaceNode} node @param {import('./camera.js').Camera} cam */
  syncNode(node, cam) {
    if (node.id === this.selectedId) this._syncEditor(cam);
  }

  /**
   * @param {SpaceNodeKind} kind
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {SpaceNode}
   */
  _createNode(kind, x, y, w, h) {
    const id = this.nextId++;
    /** @type {SpaceNode} */
    const node = { id, kind, label: `${kind === 'image' ? 'Image' : 'Text'} ${id}`, x, y, w, h, text: '' };
    if (kind === 'text') node.fs = Math.min(w, h) / TEXT_NODE_DESIGN_W;
    if (kind === 'image') {
      node.model = defaultImageModel();
      node.ratio = '1:1';
      node.quality = '1K';
      node.nvars = 1;
      node.enhance = false;
      node.style = '';
      node.refs = [];
      node.variants = [];
    }
    this.nodes.push(node);
    this._indexNode(node);
    this._version++;
    this._syncKey = '';
    return node;
  }

  /** @param {SpaceNode} node */
  _mountEditor(node) {
    if (!this.editorEl) this._createEditor();
    const previousId = this.editorEl.dataset.nodeId ? Number(this.editorEl.dataset.nodeId) : 0;
    if (previousId !== node.id && this.editorTextarea) this.editorTextarea.value = node.text;
    this.editorEl.dataset.nodeId = String(node.id);
    this.editorEl.dataset.kind = node.kind;
    if (this.editorTextarea) {
      this.editorTextarea.placeholder = node.kind === 'image' ? IMAGE_PLACEHOLDER : TEXT_PLACEHOLDER;
    }
    if (this.editorTitle) this.editorTitle.textContent = node.label;
    if (this.editorTextarea && this.editorTextarea.value !== node.text) this.editorTextarea.value = node.text;
    if (this.editorGenPrompt && this.editorGenPrompt.value !== node.text) this.editorGenPrompt.value = node.text;
    if (!this.editorEl.isConnected) this.layer.appendChild(this.editorEl);
    this.editorEl.classList.add('selected');
    this._syncEditorState(node);
  }

  /** Allinea classi/contenuti dell'editor allo stato del nodo (img/busy/errore). @param {SpaceNode} node */
  _syncEditorState(node) {
    const el = this.editorEl;
    if (!el) return;
    el.classList.toggle('has-img', node.kind === 'image' && !!node.img);
    el.classList.toggle('generating', !!node.busy);
    if (this.editorBalanceN) this.editorBalanceN.textContent = String(this._shownBalance);
    if (this.editorGenErr) {
      this.editorGenErr.textContent = node.genErr || '';
      this.editorGenErr.hidden = !node.genErr;
    }
    if (this.editorStyleMenu) this.editorStyleMenu.hidden = true;
    if (node.kind === 'image') {
      this._syncEditorImage(node);
      this._syncGenToolStates(node);
      this._syncRefsRow(node);
      this._syncVarsStrip(node);
      this._updateGenCost(node);
      this._syncPromptHint(node);
    } else if (this.editorVars) {
      // l'editor è UNO condiviso: senza questo, la striscia varianti
      // dell'ultimo nodo image restava visibile sotto i nodi text
      this.editorVars.hidden = true;
      this.editorVars.textContent = '';
    }
  }

  /**
   * Placeholder della barra prompt: se alla porta Prompt arrivano nodi Text,
   * dice che quei testi entrano nel prompt (il campo resta per i dettagli).
   * @param {SpaceNode} node
   */
  _syncPromptHint(node) {
    if (node !== this._selectedNode || node.kind !== 'image' || !this.editorGenPrompt) return;
    const n = this._linkedPrompts(node).length;
    this.editorGenPrompt.placeholder = !n ? GEN_PROMPT_PLACEHOLDER :
      n === 1 ? 'Il testo del nodo collegato entra nel prompt — aggiungi dettagli…'
              : `I testi dei ${n} nodi collegati entrano nel prompt — aggiungi dettagli…`;
  }

  /** Stato di # (stile attivo) e ✨ (enhance) + tooltip. @param {SpaceNode} node */
  _syncGenToolStates(node) {
    const style = GEN_STYLES.find((s) => s.id === (node.style || '')) || GEN_STYLES[0];
    if (this.editorStyleBtn) {
      this.editorStyleBtn.classList.toggle('on', !!style.id);
      this.editorStyleBtn.title = style.id ? `Stile: ${style.name}` : 'Stile';
    }
    if (this.editorFxBtn) {
      this.editorFxBtn.classList.toggle('on', !!node.enhance);
      this.editorFxBtn.title = node.enhance ? 'Migliora prompt: attivo' : 'Migliora il prompt automaticamente';
    }
    if (this.editorRefBtn) {
      const n = node.refs?.length || 0;
      this.editorRefBtn.classList.toggle('on', n > 0);
      if (n > 0) this.editorRefBtn.setAttribute('data-n', String(n));
      else this.editorRefBtn.removeAttribute('data-n');
      this.editorRefBtn.title = `Immagini di riferimento (${n}/${refMax(node.model || '')})`;
    }
  }

  /** Prezzo corrente sul bottone genera. @param {SpaceNode} node */
  _updateGenCost(node) {
    if (node !== this._selectedNode || !this.editorGenBtn) return;
    const cost = nodeGenCost(node);
    const costEl = this.editorGenBtn.querySelector('.sgb-cost');
    if (costEl) costEl.textContent = `${cost} T`;
    const n = node.nvars || 1;
    this.editorGenBtn.title = n > 1 ? `Genera ${n} varianti (${cost} T)` : `Genera (${cost} T)`;
  }

  /** Menu stili sopra la barra. @param {SpaceNode} node */
  _openStyleMenu(node) {
    const menu = this.editorStyleMenu;
    if (!menu) return;
    menu.textContent = '';
    const current = node.style || '';
    for (const s of GEN_STYLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.className = 'sgb-style-opt' + (s.id === current ? ' current' : '');
      b.dataset.style = s.id;
      b.textContent = s.name;
      if (s.id === current) b.insertAdjacentHTML('beforeend', svgIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'));
      menu.appendChild(b);
    }
    menu.hidden = false;
  }

  /** Riduce e registra i file scelti come riferimenti. @param {SpaceNode} node @param {File[]} files */
  async _addRefs(node, files) {
    const max = refMax(node.model || '');
    for (const file of files) {
      if ((node.refs?.length || 0) >= max) {
        this._showGenError(node, `Massimo ${max} immagini di riferimento con questo modello.`);
        break;
      }
      try {
        const bmp = await createImageBitmap(file);
        const s = Math.min(1, REF_SIDE_MAX / Math.max(bmp.width, bmp.height));
        const cnv = document.createElement('canvas');
        cnv.width = Math.max(1, Math.round(bmp.width * s));
        cnv.height = Math.max(1, Math.round(bmp.height * s));
        const ctx = /** @type {CanvasRenderingContext2D} */ (cnv.getContext('2d'));
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cnv.width, cnv.height);
        ctx.drawImage(bmp, 0, 0, cnv.width, cnv.height);
        bmp.close();
        const url = cnv.toDataURL('image/jpeg', 0.88);
        (node.refs || (node.refs = [])).push({ url, b64: url.split(',')[1] || '' });
      } catch {
        this._showGenError(node, 'Immagine non leggibile.');
      }
    }
    this._syncRefsRow(node);
    this._syncGenToolStates(node);
    this._updateHoverChips(node);
  }

  /** Chips dei riferimenti sopra il prompt. @param {SpaceNode} node */
  _syncRefsRow(node) {
    const row = this.editorRefsRow;
    if (!row) return;
    const refs = node.refs || [];
    row.hidden = !refs.length;
    row.textContent = '';
    refs.forEach((r, i) => {
      const chip = document.createElement('span');
      chip.className = 'sgb-ref';
      const im = document.createElement('img');
      im.src = r.url;
      im.alt = '';
      im.draggable = false;
      const x = document.createElement('button');
      x.type = 'button';
      x.tabIndex = -1;
      x.className = 'sgb-ref-x';
      x.textContent = '×';
      x.title = 'Rimuovi riferimento';
      x.dataset.i = String(i);
      chip.append(im, x);
      row.appendChild(chip);
    });
  }

  /**
   * Striscia delle varianti generate: sotto il nodo, fuori dal riquadro,
   * da sinistra (visibile solo con più risultati). @param {SpaceNode} node
   */
  _syncVarsStrip(node) {
    const strip = this.editorVars;
    if (!strip) return;
    const vars = node.variants || [];
    strip.hidden = node.busy || vars.length < 2;
    strip.textContent = '';
    if (strip.hidden) return;
    const px = 96; // risoluzione interna: le thumb sono mostrate ~40px design
    vars.forEach((rec, i) => {
      const th = document.createElement('canvas');
      th.className = 'snv-thumb' + (rec === node.img ? ' sel' : '');
      th.dataset.i = String(i);
      th.title = `Variante ${i + 1}`;
      th.width = px;
      th.height = px;
      const ctx = /** @type {CanvasRenderingContext2D} */ (th.getContext('2d'));
      this._drawRecCover(ctx, rec, 0, 0, px, px, px);
      strip.appendChild(th);
    });
  }

  /** @param {SpaceNode} node @param {number} i */
  _selectVariant(node, i) {
    const v = node.variants?.[i];
    if (!v || v === node.img) return;
    node.img = v;
    node.imgW = v.w;
    node.imgH = v.h;
    node.h = node.w * (v.h / v.w);
    this._reindexNode(node);
    this._bumpPreview(node);
    this._refreshNodeUi(node);
  }

  /** Disegna l'immagine nel canvas dell'editor: base subito, full quando arriva. @param {SpaceNode} node */
  _syncEditorImage(node) {
    const cnv = this.editorImg;
    if (!cnv) return;
    const rec = node.img || null;
    // il full per l'editor parte da qui: la scena SALTA il nodo selezionato
    if (rec && this._recNeedsFull(node, rec)) {
      rec.fullT = performance.now();
      this._requestFull(rec);
    }
    const src = rec ? (rec.full || rec.base) : null;
    const key = rec && src ? `${node.id}:${node._pv || 0}:${rec.full ? 'f' : 'b'}` : '';
    if (cnv.dataset.imgKey === key) return;
    cnv.dataset.imgKey = key;
    if (!src) {
      cnv.width = 1;
      cnv.height = 1;
      return;
    }
    const w = /** @type {any} */ (src).width || /** @type {any} */ (src).naturalWidth || 1;
    const h = /** @type {any} */ (src).height || /** @type {any} */ (src).naturalHeight || 1;
    if (cnv.width !== w || cnv.height !== h) {
      cnv.width = w;
      cnv.height = h;
    }
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(/** @type {any} */ (src), 0, 0, w, h);
  }

  _createEditor() {
    const el = document.createElement('article');
    el.className = 'space-node space-text-node space-node-editor selected';
    el.style.width = `${TEXT_NODE_SCREEN_W}px`;
    el.style.height = `${TEXT_NODE_SCREEN_H}px`;

    const head = document.createElement('header');
    head.className = 'space-node-head';
    const grip = document.createElement('button');
    grip.className = 'space-node-grip';
    grip.type = 'button';
    grip.title = 'Drag node';
    grip.setAttribute('aria-label', 'Drag node');
    grip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12"/><path d="M6 12h12"/><path d="M6 16h12"/></svg>';
    const title = document.createElement('div');
    title.className = 'space-node-title';
    head.append(grip, title);

    const textarea = document.createElement('textarea');
    textarea.className = 'space-node-text';
    textarea.placeholder = TEXT_PLACEHOLDER;
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.rows = 8;

    const tabChip = document.createElement('span');
    tabChip.className = 'space-node-tabchip';
    tabChip.textContent = 'tab';
    tabChip.setAttribute('aria-hidden', 'true');

    // immagine generata (canvas: il risultato è un ImageBitmap)
    const imgCanvas = document.createElement('canvas');
    imgCanvas.className = 'space-node-img';

    // barra generazione (solo nodi image): prompt modificabile + token + genera
    const genbar = document.createElement('div');
    genbar.className = 'space-node-genbar';
    const refsRow = document.createElement('div');
    refsRow.className = 'sgb-refs';
    refsRow.hidden = true;
    const genPrompt = document.createElement('textarea');
    genPrompt.className = 'sgb-prompt';
    genPrompt.rows = 2;
    genPrompt.placeholder = GEN_PROMPT_PLACEHOLDER;
    genPrompt.spellcheck = false;
    genPrompt.autocomplete = 'off';
    const genRow = document.createElement('div');
    genRow.className = 'sgb-row';
    genRow.innerHTML = `
      <span class="sgb-left">
        <button class="sgb-tool sgb-ref-btn" type="button" tabindex="-1" title="Immagini di riferimento">@</button>
        <button class="sgb-tool sgb-style-btn" type="button" tabindex="-1" title="Stile">#</button>
        <button class="sgb-tool sgb-fx-btn" type="button" tabindex="-1" title="Migliora il prompt automaticamente">${svgIcon('<path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>')}</button>
      </span>
      <span class="sgb-right">
        <span class="sgb-balance" title="Token disponibili">${svgIcon('<path d="M13 3 5 13.5h5L10 21l8-10.5h-5z"/>')}<span class="sgb-balance-n"></span></span>
        <button class="sgb-gen" type="button" tabindex="-1">
          ${svgIcon('<path d="M12 18V6"/><path d="M6 12l6-6 6 6"/>')}<span class="sgb-cost"></span>
        </button>
      </span>`;
    const styleMenu = document.createElement('div');
    styleMenu.className = 'sgb-style-menu';
    styleMenu.hidden = true;
    const genErr = document.createElement('div');
    genErr.className = 'sgb-err';
    genErr.hidden = true;
    const refInput = document.createElement('input');
    refInput.type = 'file';
    refInput.accept = 'image/*';
    refInput.multiple = true;
    refInput.hidden = true;
    genbar.append(refsRow, genPrompt, genRow, styleMenu, genErr, refInput);

    // striscia delle varianti (sopra la barra, solo con più risultati)
    const varsStrip = document.createElement('div');
    varsStrip.className = 'space-node-vars';
    varsStrip.hidden = true;

    // overlay di attesa: anello di progresso tarato su GEN_ETA_MS
    const loading = document.createElement('div');
    loading.className = 'space-node-loading';
    loading.innerHTML = `
      <div class="snl-ring"></div>
      <div class="snl-label">Generazione…</div>
      <div class="snl-eta"></div>`;

    el.append(head, textarea, tabChip, imgCanvas, varsStrip, genbar, loading);
    // maniglie di resize (solo nodi text, gli image le nascondono via CSS)
    for (const dir of Object.keys(RESIZE_CURSORS)) {
      const rs = document.createElement('div');
      rs.className = `space-node-rs rs-${dir}`;
      rs.addEventListener('pointerdown', (e) => this._beginResize(e, dir));
      el.appendChild(rs);
    }
    this.editorEl = el;
    this.editorTextarea = textarea;
    this.editorTitle = title;
    this.editorImg = imgCanvas;
    this.editorGenPrompt = genPrompt;
    this.editorGenBtn = /** @type {HTMLButtonElement} */ (genRow.querySelector('.sgb-gen'));
    this.editorBalanceN = /** @type {HTMLElement} */ (genRow.querySelector('.sgb-balance-n'));
    this.editorGenErr = genErr;
    this.editorLoadRing = /** @type {HTMLElement} */ (loading.querySelector('.snl-ring'));
    this.editorLoadEta = /** @type {HTMLElement} */ (loading.querySelector('.snl-eta'));
    this.editorRefsRow = refsRow;
    this.editorRefBtn = /** @type {HTMLButtonElement} */ (genRow.querySelector('.sgb-ref-btn'));
    this.editorStyleBtn = /** @type {HTMLButtonElement} */ (genRow.querySelector('.sgb-style-btn'));
    this.editorFxBtn = /** @type {HTMLButtonElement} */ (genRow.querySelector('.sgb-fx-btn'));
    this.editorStyleMenu = styleMenu;
    this.editorRefInput = refInput;
    this.editorVars = varsStrip;
    this.editorBalanceN.textContent = String(wallet.balance);

    // Solo stopPropagation: mai ri-selezionare qui. Il re-mount al pointerdown
    // ricostruiva chip/miniature e chiudeva il menu stili sotto il puntatore,
    // così il click atterrava su elementi appena distrutti e si perdeva.
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    const onPromptInput = (/** @type {HTMLTextAreaElement} */ src) => {
      const node = this._selectedNode;
      if (!node) return;
      node.text = src.value;
      const other = src === textarea ? genPrompt : textarea;
      if (other.value !== src.value) other.value = src.value;
      if (node.genErr) {
        node.genErr = '';
        genErr.hidden = true;
      }
      this._bumpPreview(node);
    };
    textarea.addEventListener('input', () => onPromptInput(textarea));
    genPrompt.addEventListener('input', () => onPromptInput(genPrompt));
    const genOnEnter = (/** @type {KeyboardEvent} */ e) => {
      const node = this._selectedNode;
      if (e.key === 'Enter' && !e.shiftKey && node?.kind === 'image') {
        e.preventDefault();
        this._generate(node);
      }
    };
    textarea.addEventListener('keydown', genOnEnter);
    genPrompt.addEventListener('keydown', genOnEnter);
    this.editorGenBtn.addEventListener('click', () => {
      const node = this._selectedNode;
      if (node) this._generate(node);
    });
    this.editorRefBtn.addEventListener('click', () => refInput.click());
    // delegato sulla riga: i chip vengono ricostruiti, il listener resta
    refsRow.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target.closest('.sgb-ref-x') : null;
      const node = this._selectedNode;
      if (!(t instanceof HTMLElement) || !node) return;
      node.refs?.splice(Number(t.dataset.i), 1);
      this._syncRefsRow(node);
      this._syncGenToolStates(node);
      this._updateHoverChips(node);
    });
    refInput.addEventListener('change', () => {
      const node = this._selectedNode;
      if (node && refInput.files?.length) this._addRefs(node, [...refInput.files]);
      refInput.value = '';
    });
    this.editorStyleBtn.addEventListener('click', () => {
      const node = this._selectedNode;
      if (!node) return;
      if (styleMenu.hidden) this._openStyleMenu(node);
      else styleMenu.hidden = true;
    });
    styleMenu.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target.closest('.sgb-style-opt') : null;
      const node = this._selectedNode;
      if (!(t instanceof HTMLElement) || !node) return;
      node.style = t.dataset.style || '';
      styleMenu.hidden = true;
      this._syncGenToolStates(node);
    });
    this.editorFxBtn.addEventListener('click', () => {
      const node = this._selectedNode;
      if (!node) return;
      node.enhance = !node.enhance;
      this._syncGenToolStates(node);
    });
    // click altrove nell'editor = chiudi il menu stili (senza toccare il resto)
    el.addEventListener('pointerdown', (e) => {
      const t = e.target instanceof Node ? e.target : null;
      if (t && !styleMenu.contains(t) && !this.editorStyleBtn.contains(t)) styleMenu.hidden = true;
    });
    varsStrip.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target.closest('.snv-thumb') : null;
      const node = this._selectedNode;
      if (!(t instanceof HTMLElement) || !node) return;
      this._selectVariant(node, Number(t.dataset.i));
    });
    head.addEventListener('pointerdown', (e) => {
      const node = this._selectedNode;
      if (node) this._beginDrag(e, node);
    });
  }

  _unmountEditor() {
    this.editorEl?.remove();
  }

  /** @param {import('./camera.js').Camera} cam */
  _syncEditor(cam) {
    const node = this._selectedNode;
    if (!node || !this.editorEl?.isConnected) return;
    const scale = Math.max(0.02, nodeDesignScale(node) * cam.zoom);
    const width = Math.max(24, node.w * cam.zoom);
    const height = Math.max(24, node.h * cam.zoom);
    cam.worldToScreen(node.x - node.w / 2, node.y - node.h / 2, this._screen);
    const left = Math.round(this._screen.x - cam.ox);
    const top = Math.round(this._screen.y - cam.oy);
    this.editorEl.style.width = `${width}px`;
    this.editorEl.style.height = `${height}px`;
    this.editorEl.style.setProperty('--space-node-scale', String(scale));
    this.editorEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    // zoom sul nodo selezionato: l'editor tiene vivo (o richiede) il full-res
    if (node.kind === 'image' && node.img && this._recNeedsFull(node, node.img)) {
      node.img.fullT = performance.now();
      this._requestFull(node.img);
    }
  }

  /** @param {import('./camera.js').Camera} cam */
  _resizeCanvas(cam) {
    const dpr = Math.max(1, Math.min(3, cam.dpr || window.devicePixelRatio || 1));
    this._dpr = dpr;
    this._cacheSize = Math.round(PREVIEW_CACHE_SIZE * Math.min(2, dpr));
    const w = Math.max(1, Math.ceil(cam.w * dpr));
    const h = Math.max(1, Math.ceil(cam.h * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${cam.w}px`;
      this.canvas.style.height = `${cam.h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** @param {import('./camera.js').Camera} cam @param {SpaceNode[]} nodes */
  _draw(cam, nodes) {
    this._resizeCanvas(cam);
    this._buildsLeft = PREVIEW_BUILD_BUDGET;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, cam.w, cam.h);
    this._drawLinks(ctx, cam);
    let full = 0, proxy = 0;
    for (const node of nodes) {
      if (node.id === this.selectedId) continue;
      const w = node.w * cam.zoom;
      const h = node.h * cam.zoom;
      cam.worldToScreen(node.x - node.w / 2, node.y - node.h / 2, this._screen);
      const left = this._screen.x - cam.ox;
      const top = this._screen.y - cam.oy;
      if (left > cam.w || top > cam.h || left + w < 0 || top + h < 0) continue;
      // TUTTO resta visibile fino a taglie minuscole (testi compresi): la
      // cache bucketed costa un solo drawImage, il proxy serve solo sotto 8px
      if (Math.min(w, h) < PROXY_MIN_SCREEN_PX) {
        this._drawProxy(ctx, left, top, w, h);
        proxy++;
      } else {
        this._drawPreview(ctx, node, left, top, w, h);
        full++;
      }
    }
    this._drawStats = { visible: full + proxy, full, proxy };
    // budget esaurito con entry stantie in vista: raffina nei frame successivi
    if (this._wantMoreBuilds) {
      this._wantMoreBuilds = false;
      this._syncKey = '';
      this.app.requestFrame();
    }
  }

  _drawProxy(ctx, x, y, w, h) {
    roundRectPath(ctx, x, y, w, h, Math.min(10, Math.min(w, h) * 0.08));
    ctx.fillStyle = '#202020';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(238, 239, 244, 0.22)';
    ctx.stroke();
  }

  /** @param {CanvasRenderingContext2D} ctx @param {SpaceNode} node */
  _drawPreview(ctx, node, x, y, w, h) {
    const devLong = Math.max(w, h) * this._dpr;
    // in generazione: render diretto (l'anello di attesa anima ogni frame)
    if (node.kind === 'image' && node.busy) {
      this._renderPreviewAt(ctx, node, x, y, w, h, devLong);
      return;
    }
    // confronto in px device: la cache copre al massimo _cacheSize px fisici
    if (devLong > this._cacheSize * 1.5) {
      this._renderPreviewAt(ctx, node, x, y, w, h, devLong);
      return;
    }
    // bucket a potenze di due: nodi lontani = cache piccole (byte e build cheap),
    // il cambio di bucket allo zoom si ricostruisce col budget per frame
    let bucket = PREVIEW_BUCKET_MIN;
    while (bucket < devLong && bucket < this._cacheSize) bucket *= 2;
    const cache = this._ensurePreviewCache(node, bucket);
    if (cache) {
      ctx.drawImage(cache, x, y, w, h);
      return;
    }
    // cache fredda a budget finito: sui nodi piccoli il render diretto di
    // decine di layout in un frame costerebbe troppo — proxy per qualche
    // frame, le miniature arrivano col raffinamento progressivo
    if (Math.min(w, h) < DIRECT_FALLBACK_MIN_PX) this._drawProxy(ctx, x, y, w, h);
    else this._renderPreviewAt(ctx, node, x, y, w, h, devLong);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx @param {SpaceNode} node
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {number} [devLong] lato lungo in px DEVICE del target (per la scelta base/full)
   */
  _renderPreviewAt(ctx, node, x, y, w, h, devLong = Math.max(w, h)) {
    ctx.save();
    // w/node.w = zoom effettivo (vale anche per la cache, che tiene l'aspect)
    const scale = Math.max(0.02, nodeDesignScale(node) * (w / node.w));
    if (node.kind === 'image' && (node.img || node.busy)) {
      this._renderImageNodeAt(ctx, node, x, y, w, h, scale, devLong);
      ctx.restore();
      return;
    }
    roundRectPath(ctx, x, y, w, h, 11 * scale);
    ctx.fillStyle = '#202020';
    ctx.fill();
    ctx.lineWidth = Math.max(0.5, scale);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
    ctx.stroke();

    const pad = 10 * scale;
    const headH = 31 * scale;
    ctx.fillStyle = 'rgba(238, 239, 244, 0.88)';
    ctx.font = `${Math.max(5, 12 * scale)}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(node.label, x + pad, y + headH / 2, Math.max(1, w - pad * 2));

    const text = node.text || (node.kind === 'image' ? IMAGE_PLACEHOLDER : TEXT_PLACEHOLDER);
    const fs = Math.max(5, 11 * scale);
    ctx.font = `${fs}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillStyle = node.text ? 'rgba(241, 243, 247, 0.72)' : 'rgba(238, 239, 244, 0.25)';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    ctx.rect(x + pad, y + headH, Math.max(1, w - pad * 2), Math.max(1, h - headH - pad));
    ctx.clip();
    // righe a misura dell'altezza disponibile: il nodo esteso mostra più testo
    const lineH = fs * 1.35;
    const maxLines = Math.max(1, Math.floor((h - headH - pad - 2 * scale) / lineH));
    const lines = this._drawWrappedText(ctx, text, x + pad, y + headH + 2 * scale, w - pad * 2, lineH, maxLines);
    if (node.kind === 'image' && !node.text) {
      // chip "tab" sotto il placeholder, allineato al chip DOM dell'editor
      const chipY = y + headH + 2 * scale + lines * fs * 1.35 + 4 * scale;
      const chipFs = Math.max(4, 9 * scale);
      ctx.font = `${chipFs}px system-ui, -apple-system, Segoe UI, sans-serif`;
      const chipW = ctx.measureText('tab').width + 12 * scale;
      const chipH = 15 * scale;
      roundRectPath(ctx, x + pad, chipY, chipW, chipH, 5 * scale);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fill();
      ctx.fillStyle = 'rgba(238, 239, 244, 0.45)';
      ctx.textBaseline = 'middle';
      ctx.fillText('tab', x + pad + 6 * scale, chipY + chipH / 2 + 0.5 * scale);
    }
    ctx.restore();
  }

  /**
   * Nodo image con risultato (o in generazione) sul canvas di scena:
   * immagine cover-fit dentro il rettangolo arrotondato + velo di attesa.
   * @param {CanvasRenderingContext2D} ctx @param {SpaceNode} node
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {number} scale @param {number} [devLong]
   */
  _renderImageNodeAt(ctx, node, x, y, w, h, scale, devLong = Math.max(w, h)) {
    roundRectPath(ctx, x, y, w, h, 11 * scale);
    ctx.fillStyle = '#161616';
    ctx.fill();
    ctx.clip();
    if (node.img) this._drawRecCover(ctx, node.img, x, y, w, h, devLong);
    if (node.busy) {
      ctx.fillStyle = node.img ? 'rgba(10, 10, 10, 0.55)' : 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(x, y, w, h);
      const t = performance.now() - (node.genT0 || 0);
      const p = genProgress(t);
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = Math.min(w, h) * 0.14;
      ctx.lineWidth = Math.max(1, 2.6 * scale);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Cache di anteprima del nodo al bucket richiesto (lato lungo = bucket, il
   * corto segue l'aspect: le immagini non 1:1 non si distorcono). Ritorna la
   * entry stantia (bucket vecchio, contenuto giusto) se il budget del frame è
   * esaurito, null se non c'è nulla di valido da mostrare.
   * @param {SpaceNode} node @param {number} bucket
   * @returns {HTMLCanvasElement|null}
   */
  _ensurePreviewCache(node, bucket) {
    const ver = node._pv || 0;
    const ar = node.w / Math.max(0.0001, node.h);
    const cw = Math.max(1, Math.round(ar >= 1 ? bucket : bucket * ar));
    const ch = Math.max(1, Math.round(ar >= 1 ? bucket / ar : bucket));
    let entry = this._previewCache.get(node.id);
    const fresh = !!entry && entry.ver === ver;
    if (fresh) {
      // isteresi: una entry UN gradino più grande resta valida — a cavallo di
      // un confine pow2 lo zoom non ricostruisce avanti-indietro (l'eviction
      // a byte governa il costo delle entry sovradimensionate)
      const b2 = bucket * 2;
      const cw2 = Math.max(1, Math.round(ar >= 1 ? b2 : b2 * ar));
      const ch2 = Math.max(1, Math.round(ar >= 1 ? b2 / ar : b2));
      if ((entry.canvas.width === cw && entry.canvas.height === ch) ||
        (entry.canvas.width === cw2 && entry.canvas.height === ch2)) {
        this._previewCache.delete(node.id);
        this._previewCache.set(node.id, entry);
        return entry.canvas;
      }
    }
    if (this._buildsLeft <= 0) {
      this._wantMoreBuilds = true;
      return fresh ? entry.canvas : null;
    }
    this._buildsLeft--;
    if (!entry) {
      const canvas = document.createElement('canvas');
      // un canvas nuovo è 300×150, NON 0×0: azzerarlo tiene giusta la contabilità
      canvas.width = 0;
      canvas.height = 0;
      entry = {
        canvas,
        ctx: /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')),
        ver: -1,
      };
    }
    if (entry.canvas.width !== cw || entry.canvas.height !== ch) {
      this._cacheBytes -= entry.canvas.width * entry.canvas.height * 4;
      entry.canvas.width = cw;
      entry.canvas.height = ch;
      this._cacheBytes += cw * ch * 4;
    }
    entry.ctx.clearRect(0, 0, cw, ch);
    this._renderPreviewAt(entry.ctx, node, 0, 0, cw, ch);
    entry.ver = ver;
    this._previewCache.delete(node.id);
    this._previewCache.set(node.id, entry);
    // eviction LRU a byte reali (l'entry appena usata è in coda alla Map)
    while (this._previewCache.size > 1 &&
      (this._cacheBytes > PREVIEW_CACHE_BYTES || this._previewCache.size > PREVIEW_CACHE_MAX)) {
      const evictKey = this._previewCache.keys().next().value;
      this._dropPreviewEntry(evictKey);
    }
    return entry.canvas;
  }

  /** @param {number} id */
  _dropPreviewEntry(id) {
    const entry = this._previewCache.get(id);
    if (!entry) return;
    this._cacheBytes -= entry.canvas.width * entry.canvas.height * 4;
    this._previewCache.delete(id);
  }

  /**
   * drawImage cover-fit con riduzione a tappe: sotto scala 0.5 il bilineare a
   * un colpo scarta pixel (alias su 4K→300px); dimezzare fino a ~2x dal target
   * è una media vera. Costa solo alla (ri)costruzione della cache o dei thumb.
   * @param {CanvasRenderingContext2D} ctx @param {GenImage|HTMLCanvasElement} img
   * @param {number} x @param {number} y @param {number} w @param {number} h
   */
  _drawImageCover(ctx, img, x, y, w, h) {
    let sw = /** @type {any} */ (img).width || /** @type {any} */ (img).naturalWidth || 1;
    let sh = /** @type {any} */ (img).height || /** @type {any} */ (img).naturalHeight || 1;
    /** @type {GenImage|HTMLCanvasElement} */
    let src = img;
    if (Math.max(w / sw, h / sh) < 0.5) {
      let dst = this._scratchA || (this._scratchA = document.createElement('canvas'));
      let alt = this._scratchB || (this._scratchB = document.createElement('canvas'));
      while (Math.max(w / sw, h / sh) < 0.5) {
        const nw = Math.max(1, Math.floor(sw / 2));
        const nh = Math.max(1, Math.floor(sh / 2));
        if (dst === src) { const t = dst; dst = alt; alt = t; }
        if (dst.width < nw || dst.height < nh) {
          dst.width = nw;
          dst.height = nh;
        }
        const sctx = /** @type {CanvasRenderingContext2D} */ (dst.getContext('2d'));
        sctx.clearRect(0, 0, nw, nh);
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(src, 0, 0, sw, sh, 0, 0, nw, nh);
        src = dst;
        sw = nw;
        sh = nh;
      }
    }
    const s = Math.max(w / sw, h / sh);
    const dw = sw * s;
    const dh = sh * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(/** @type {any} */ (src), 0, 0, sw, sh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /**
   * Record stabile da un bitmap appena arrivato (generazione/restore/stress):
   * la base ≤BASE_SIDE si cuoce SUBITO (halving a tappe, è la sorgente di
   * miniature/striscia/editor); per immagini ≤BASE_SIDE la base è copia intera
   * e il bitmap si chiude qui. Il full-res resta nel record finché il png non
   * permette di rilasciarlo (sweep a isteresi).
   * @param {GenImage} img @param {string|null} [png]
   * @returns {ImgRec}
   */
  _makeImgRec(img, png = null) {
    const w = /** @type {any} */ (img).width || /** @type {any} */ (img).naturalWidth || 1;
    const h = /** @type {any} */ (img).height || /** @type {any} */ (img).naturalHeight || 1;
    const s = Math.min(1, BASE_SIDE / Math.max(w, h));
    const base = document.createElement('canvas');
    base.width = Math.max(1, Math.round(w * s));
    base.height = Math.max(1, Math.round(h * s));
    const ctx = /** @type {CanvasRenderingContext2D} */ (base.getContext('2d'));
    this._drawImageCover(ctx, img, 0, 0, base.width, base.height);
    /** @type {ImgRec} */
    const rec = { png: png || null, w, h, base, full: null, fullT: 0, disposed: false, refJpeg: null, _pending: null };
    if (s >= 1) {
      if ('close' in img) img.close();
    } else {
      rec.full = img;
      rec.fullT = performance.now();
    }
    return rec;
  }

  /**
   * Disegna il record cover-fit scegliendo la sorgente: base per miniature e
   * taglie coperte, full-res quando il target la supera — e se il full non è
   * residente lo richiede in asincrono mostrando la base nell'attesa
   * (progressivo alla Google Maps: prima morbido, poi nitido).
   * @param {CanvasRenderingContext2D} ctx @param {ImgRec} rec
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {number} devLong lato lungo del target in px device
   */
  _drawRecCover(ctx, rec, x, y, w, h, devLong) {
    const base = rec.base;
    const baseLong = base ? Math.max(base.width, base.height) : 0;
    const wantFull = baseLong > 0 && baseLong < Math.max(rec.w, rec.h) &&
      devLong > baseLong * FULL_ACQUIRE_RATIO;
    if (wantFull) {
      rec.fullT = performance.now();
      if (!rec.full) this._requestFull(rec);
    }
    const src = wantFull && rec.full ? rec.full : (base || rec.full);
    if (src) this._drawImageCover(ctx, src, x, y, w, h);
  }

  /** Il full-res serve se il nodo su schermo supera la base (con margine). @param {SpaceNode} node @param {ImgRec} rec */
  _recNeedsFull(node, rec) {
    const base = rec.base;
    if (!base) return false;
    const baseLong = Math.max(base.width, base.height);
    if (baseLong >= Math.max(rec.w, rec.h)) return false; // base = copia intera
    const devLong = Math.max(node.w, node.h) * this.app.camera.zoom * this._dpr;
    return devLong > baseLong * FULL_ACQUIRE_RATIO;
  }

  /**
   * Ridecodifica il full-res dal PNG in asincrono (una sola decodifica per
   * record anche con più richiedenti); al ritorno ridisegna scena ed editor.
   * @param {ImgRec} rec @returns {Promise<GenImage|null>}
   */
  _requestFull(rec) {
    if (rec.full) return Promise.resolve(rec.full);
    if (!rec.png || rec.disposed) return Promise.resolve(null);
    if (!rec._pending) {
      rec._pending = decodeGenImage(rec.png).then((img) => {
        rec._pending = null;
        if (rec.disposed) {
          if ('close' in img) img.close();
          return null;
        }
        rec.full = img;
        rec.fullT = performance.now();
        this._syncKey = '';
        this.app.requestFrame();
        const sel = this._selectedNode;
        if (sel && sel.img === rec && this.editorImg) {
          delete this.editorImg.dataset.imgKey;
          this._syncEditorImage(sel);
        }
        return img;
      }).catch(/** @returns {GenImage|null} */ () => {
        rec._pending = null;
        return null;
      });
    }
    return rec._pending;
  }

  /** @param {SpaceNode} node */
  _nodeOnScreen(node) {
    this.app.camera.visibleRect(this._visibleRect);
    const r = this._visibleRect;
    return node.x + node.w / 2 > r.x0 && node.x - node.w / 2 < r.x1 &&
      node.y + node.h / 2 > r.y0 && node.y - node.h / 2 < r.y1;
  }

  /**
   * Rilascio dei full-res: chiusi dopo FULL_IDLE_MS senza necessità. La
   * necessità si rivaluta QUI dalla camera (a schermo fermo il draw non gira e
   * i fullT sarebbero stantii per un nodo ancora sotto zoom). Senza png il
   * full è l'unica copia dei pixel e non si tocca (es. generazione non ancora
   * salvata, nodi dello stress test).
   */
  _sweepFulls() {
    if (!this.nodes.length) return;
    const now = performance.now();
    for (const node of this.nodes) {
      if (node.kind !== 'image') continue;
      const recs = new Set(node.variants || []);
      if (node.img) recs.add(node.img);
      for (const rec of recs) {
        if (!rec.full || !rec.png) continue;
        if (rec === node.img && this._nodeOnScreen(node) && this._recNeedsFull(node, rec)) {
          rec.fullT = now;
          continue;
        }
        if (now - rec.fullT > FULL_IDLE_MS) {
          if ('close' in rec.full) rec.full.close();
          rec.full = null;
        }
      }
    }
  }

  /** @param {SpaceNode} node */
  _bumpPreview(node) {
    node._pv = (node._pv || 0) + 1;
  }

  /**
   * Testo wrappato a parole; se continua oltre l'ultima riga visibile chiude
   * con '…' (il nodo non selezionato nasconde il resto, ma si vede che c'è).
   * @param {CanvasRenderingContext2D} ctx @param {string} text
   * @param {number} x @param {number} y @param {number} maxW
   * @param {number} lineH @param {number} maxLines
   * @returns {number} righe disegnate
   */
  _drawWrappedText(ctx, text, x, y, maxW, lineH, maxLines) {
    /** @type {string[]} */
    const rows = [];
    let more = false;
    /** @param {string} value */
    const fits = (value) => ctx.measureText(value).width <= maxW;
    /** @param {string} word */
    const splitLongWord = (word) => {
      /** @type {string[]} */
      const pieces = [];
      let rest = word;
      while (rest && !fits(rest)) {
        let lo = 1;
        let hi = rest.length;
        let best = 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(rest.slice(0, mid))) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        pieces.push(rest.slice(0, best));
        rest = rest.slice(best);
      }
      if (rest) pieces.push(rest);
      return pieces;
    };
    const paras = String(text).split('\n');
    outer: for (let p = 0; p < paras.length; p++) {
      const words = paras[p].split(/\s+/).filter(Boolean);
      let line = '';
      for (const word of words) {
        const pieces = splitLongWord(word);
        for (let i = 0; i < pieces.length; i++) {
          const sep = line && i === 0 ? ' ' : '';
          const next = `${line}${sep}${pieces[i]}`;
          if (!fits(next) && line) {
            rows.push(line);
            line = pieces[i];
            if (rows.length >= maxLines) {
              more = true; // c'è ancora testo in mano
              break outer;
            }
          } else {
            line = next;
          }
        }
      }
      rows.push(line); // anche vuota: il paragrafo vuoto resta una riga bianca
      if (rows.length >= maxLines) {
        more = p < paras.length - 1;
        break;
      }
    }
    if (more && rows.length) {
      let last = rows[rows.length - 1];
      while (last && !fits(last + '…')) last = last.slice(0, -1).trimEnd();
      rows[rows.length - 1] = `${last}…`;
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]) ctx.fillText(rows[i], x, y + lineH * i);
    }
    return rows.length;
  }

  /** @param {PointerEvent} e */
  _onDocumentPointerDown = (e) => {
    if (!this.visible || !this.interactive) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (this._linkMenuEl && !this._linkMenuEl.hidden) {
      if (this._linkMenuEl.contains(target)) return;
      // primo click fuori: chiude solo il menu (e scarta il filo pendente)
      this._closeLinkMenu();
      this.sync(this.app.camera, true);
      return;
    }
    if (this.editorEl?.contains(target)) return;
    if (this._hoverEl?.contains(target)) return;
    if (document.getElementById('spaces-create-menu')?.contains(target)) return;
    if (document.querySelector('.space-add')?.contains(target)) return;
    const rect = this.layer.getBoundingClientRect();
    const inLayer = e.clientX >= rect.left && e.clientY >= rect.top && e.clientX <= rect.right && e.clientY <= rect.bottom;
    if (!inLayer) {
      if (this.selectedId) this.select(0);
      return;
    }
    const id = this._hitTest(e.clientX, e.clientY);
    if (!id) {
      if (this.selectedId) this.select(0);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.select(id, true);
  };

  /** @param {number} sx @param {number} sy */
  _hitTest(sx, sy) {
    const cam = this.app.camera;
    cam.screenToWorld(sx, sy, this._world);
    const pad = HIT_PAD_PX / Math.max(0.001, cam.zoom);
    const rect = {
      x0: this._world.x - pad,
      y0: this._world.y - pad,
      x1: this._world.x + pad,
      y1: this._world.y + pad,
    };
    const nodes = this._queryNodes(rect);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (this._world.x >= n.x - n.w / 2 - pad &&
          this._world.x <= n.x + n.w / 2 + pad &&
          this._world.y >= n.y - n.h / 2 - pad &&
          this._world.y <= n.y + n.h / 2 + pad) return n.id;
    }
    return 0;
  }

  /** @param {SpaceNode} node */
  _indexNode(node) {
    const keys = this._nodeCellKeys(node);
    this._nodeCells.set(node.id, keys);
    for (const key of keys) {
      let bucket = this._grid.get(key);
      if (!bucket) {
        bucket = [];
        this._grid.set(key, bucket);
      }
      bucket.push(node);
    }
  }

  /** @param {SpaceNode} node */
  _unindexNode(node) {
    const keys = this._nodeCells.get(node.id);
    if (!keys) return;
    for (const key of keys) {
      const bucket = this._grid.get(key);
      if (!bucket) continue;
      const i = bucket.indexOf(node);
      if (i >= 0) bucket.splice(i, 1);
      if (!bucket.length) this._grid.delete(key);
    }
    this._nodeCells.delete(node.id);
  }

  /** @param {SpaceNode} node */
  _reindexNode(node) {
    this._unindexNode(node);
    this._indexNode(node);
  }

  /** @param {SpaceNode} node */
  _nodeCellKeys(node) {
    const x0 = Math.floor((node.x - node.w / 2) / GRID_CELL);
    const y0 = Math.floor((node.y - node.h / 2) / GRID_CELL);
    const x1 = Math.floor((node.x + node.w / 2) / GRID_CELL);
    const y1 = Math.floor((node.y + node.h / 2) / GRID_CELL);
    const keys = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) keys.push(`${x},${y}`);
    }
    return keys;
  }

  /** @param {{x0:number,y0:number,x1:number,y1:number}} rect */
  _queryNodes(rect) {
    const x0 = Math.floor(rect.x0 / GRID_CELL);
    const y0 = Math.floor(rect.y0 / GRID_CELL);
    const x1 = Math.floor(rect.x1 / GRID_CELL);
    const y1 = Math.floor(rect.y1 / GRID_CELL);
    const out = [];
    const seen = new Set();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this._grid.get(`${x},${y}`);
        if (!bucket) continue;
        for (const node of bucket) {
          if (seen.has(node.id)) continue;
          seen.add(node.id);
          if (this._intersectsRect(node, rect)) out.push(node);
        }
      }
    }
    return out;
  }

  /** @param {SpaceNode} node @param {{x0:number,y0:number,x1:number,y1:number}} r */
  _intersectsRect(node, r) {
    const x0 = node.x - node.w / 2;
    const y0 = node.y - node.h / 2;
    const x1 = node.x + node.w / 2;
    const y1 = node.y + node.h / 2;
    return x1 >= r.x0 && y1 >= r.y0 && x0 <= r.x1 && y0 <= r.y1;
  }

  /** @param {PointerEvent} e @param {SpaceNode} node */
  _beginDrag(e, node) {
    if (!this.editorEl || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    e.stopPropagation();
    this._setHover(null);
    this.select(node.id);
    const rect = this.editorEl.getBoundingClientRect();
    this._drag = {
      id: node.id,
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      w: rect.width || TEXT_NODE_SCREEN_W,
      h: rect.height || TEXT_NODE_SCREEN_H,
    };
    this.editorEl.classList.add('dragging');
    this.editorEl.setPointerCapture(e.pointerId);
    this.editorEl.addEventListener('pointermove', this._onDragMove);
    this.editorEl.addEventListener('pointerup', this._onDragEnd);
    this.editorEl.addEventListener('pointercancel', this._onDragEnd);
    this.editorEl.addEventListener('lostpointercapture', this._onDragEnd);
  }

  _onDragMove = (e) => {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const node = this._selectedNode;
    if (!node || node.id !== drag.id) return;
    const cam = this.app.camera;
    const cx = e.clientX - drag.offsetX + drag.w / 2;
    const cy = e.clientY - drag.offsetY + drag.h / 2;
    cam.screenToWorld(cx, cy, this._world);
    node.x = this._world.x;
    node.y = this._world.y;
    this._reindexNode(node);
    this._version++;
    this._syncKey = '';
    this.sync(cam, true);
  };

  _onDragEnd = (e) => {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (this.editorEl) {
      this.editorEl.classList.remove('dragging');
      this.editorEl.removeEventListener('pointermove', this._onDragMove);
      this.editorEl.removeEventListener('pointerup', this._onDragEnd);
      this.editorEl.removeEventListener('pointercancel', this._onDragEnd);
      this.editorEl.removeEventListener('lostpointercapture', this._onDragEnd);
    }
    this._drag = null;
  };

  /**
   * Resize dalle maniglie dell'editor: il bordo opposto resta fermo, cambiano
   * solo w/h (e il centro di conseguenza). La scala di design è fissa, quindi
   * il testo RIFLUISCE nello spazio nuovo senza cambiare corpo.
   * @param {PointerEvent} e @param {string} dir
   */
  _beginResize(e, dir) {
    const node = this._selectedNode;
    if (!node || !this.editorEl || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    e.stopPropagation();
    this._setHover(null);
    const cam = this.app.camera;
    cam.screenToWorld(e.clientX, e.clientY, this._world);
    this._resize = {
      id: node.id, dir, pointerId: e.pointerId,
      px: this._world.x, py: this._world.y,
      x: node.x, y: node.y, w: node.w, h: node.h,
    };
    // col pointer capture il cursore seguirebbe l'hit-test: fermo sul body
    document.body.style.cursor = RESIZE_CURSORS[dir] || '';
    this.editorEl.classList.add('resizing');
    this.editorEl.setPointerCapture(e.pointerId);
    this.editorEl.addEventListener('pointermove', this._onResizeMove);
    this.editorEl.addEventListener('pointerup', this._onResizeEnd);
    this.editorEl.addEventListener('pointercancel', this._onResizeEnd);
    this.editorEl.addEventListener('lostpointercapture', this._onResizeEnd);
  }

  /** @param {PointerEvent} e */
  _onResizeMove = (e) => {
    const rs = this._resize;
    if (!rs || e.pointerId !== rs.pointerId) return;
    const node = this._selectedNode;
    if (!node || node.id !== rs.id) return;
    const cam = this.app.camera;
    cam.screenToWorld(e.clientX, e.clientY, this._world);
    const dx = this._world.x - rs.px;
    const dy = this._world.y - rs.py;
    const s = nodeDesignScale(node);
    const minW = RESIZE_MIN_DESIGN_W * s;
    const minH = RESIZE_MIN_DESIGN_H * s;
    const maxW = Math.max(RESIZE_MAX_DESIGN_W * s, rs.w);
    const maxH = Math.max(RESIZE_MAX_DESIGN_H * s, rs.h);
    let x0 = rs.x - rs.w / 2;
    let x1 = rs.x + rs.w / 2;
    let y0 = rs.y - rs.h / 2;
    let y1 = rs.y + rs.h / 2;
    if (rs.dir.includes('e')) x1 = Math.min(x0 + maxW, Math.max(x0 + minW, x1 + dx));
    if (rs.dir.includes('w')) x0 = Math.max(x1 - maxW, Math.min(x1 - minW, x0 + dx));
    if (rs.dir.includes('s')) y1 = Math.min(y0 + maxH, Math.max(y0 + minH, y1 + dy));
    if (rs.dir.includes('n')) y0 = Math.max(y1 - maxH, Math.min(y1 - minH, y0 + dy));
    node.x = (x0 + x1) / 2;
    node.y = (y0 + y1) / 2;
    node.w = x1 - x0;
    node.h = y1 - y0;
    this._reindexNode(node);
    this._bumpPreview(node);
    this._version++;
    this._syncKey = '';
    this.sync(cam, true);
  };

  /** @param {PointerEvent} e */
  _onResizeEnd = (e) => {
    const rs = this._resize;
    if (!rs || e.pointerId !== rs.pointerId) return;
    document.body.style.cursor = '';
    if (this.editorEl) {
      this.editorEl.classList.remove('resizing');
      this.editorEl.removeEventListener('pointermove', this._onResizeMove);
      this.editorEl.removeEventListener('pointerup', this._onResizeEnd);
      this.editorEl.removeEventListener('pointercancel', this._onResizeEnd);
      this.editorEl.removeEventListener('lostpointercapture', this._onResizeEnd);
    }
    this._resize = null;
  };

  // ---------- collegamenti (curve Bézier: porta out destra → porta in sinistra) ----------

  /**
   * Fattore di collasso del chrome sotto la soglia: 1 quando il chrome hover
   * è visibile, poi scala con la taglia schermo (porte e prese in lockstep).
   * @param {import('./camera.js').Camera} cam @param {SpaceNode} node
   */
  _chromeScale(cam, node) {
    return Math.min(1, Math.min(node.w, node.h) * cam.zoom / HOVER_CHROME_MIN_PX);
  }

  /**
   * Porta out in px canvas: il centro del + del chrome (bordo destro + 26px).
   * Sotto la soglia del chrome l'offset collassa sul bordo del nodo.
   * @param {import('./camera.js').Camera} cam @param {SpaceNode} node
   * @param {{x:number,y:number}} out
   */
  _outPortPoint(cam, node, out) {
    const k = this._chromeScale(cam, node);
    out.x = (node.x + node.w / 2 - cam.x) * cam.zoom + cam.w * 0.5 + 26 * k;
    out.y = (node.y - cam.y) * cam.zoom + cam.h * 0.5;
    return out;
  }

  /**
   * Porta in in px canvas: il cerchio della riga richiesta del pannello porte
   * del chrome (riga 0 = Prompt, 1 = Image), replicandone il layout a px
   * fissi: colonna a 14px dal bordo sinistro, righe da 15px con gap 15px.
   * @param {import('./camera.js').Camera} cam @param {SpaceNode} node
   * @param {number} row @param {{x:number,y:number}} out
   */
  _inPortPoint(cam, node, row, out) {
    const rows = node.kind === 'image' ? 2 : 4;
    const r = Math.min(row, rows - 1);
    const k = this._chromeScale(cam, node);
    const total = rows * 15 + (rows - 1) * 15;
    out.x = (node.x - node.w / 2 - cam.x) * cam.zoom + cam.w * 0.5 - 21.5 * k;
    out.y = (node.y - cam.y) * cam.zoom + cam.h * 0.5 + (r * 30 - total / 2 + 7.5) * k;
    return out;
  }

  /**
   * Fili sul canvas di scena, sotto i nodi: dal + del sorgente al cerchio
   * della porta giusta del destinatario (testo → Prompt, immagine → Image).
   * Il filo pendente segue il puntatore e aggancia la porta del candidato.
   * @param {CanvasRenderingContext2D} ctx @param {import('./camera.js').Camera} cam
   */
  _drawLinks(ctx, cam) {
    const pending = this._link;
    if (!this.links.length && !pending) return;
    /** @type {Map<number, SpaceNode>} */
    const byId = new Map();
    for (const n of this.nodes) byId.set(n.id, n);
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 0, y: 0 };
    ctx.save();
    ctx.lineCap = 'round';
    for (const l of this.links) {
      const a = byId.get(l.from);
      const b = byId.get(l.to);
      if (!a || !b) continue;
      this._outPortPoint(cam, a, p0);
      this._inPortPoint(cam, b, a.kind === 'image' ? 1 : 0, p1);
      this._strokeWire(ctx, cam, p0.x, p0.y, p1.x, p1.y, false,
        this._chromeScale(cam, a), this._chromeScale(cam, b));
    }
    if (pending) {
      const a = byId.get(pending.fromId);
      if (a) {
        if (!pending.menu) this._drawCandidatePorts(ctx, cam, a, byId);
        const b = pending.toId ? byId.get(pending.toId) : null;
        this._outPortPoint(cam, a, p0);
        const kFrom = this._chromeScale(cam, a);
        if (b) {
          this._inPortPoint(cam, b, a.kind === 'image' ? 1 : 0, p1);
          this._strokeWire(ctx, cam, p0.x, p0.y, p1.x, p1.y, true, kFrom, this._chromeScale(cam, b));
          this._strokeLinkTarget(ctx, cam, b);
        } else {
          p1.x = (pending.wx - cam.x) * cam.zoom + cam.w * 0.5;
          p1.y = (pending.wy - cam.y) * cam.zoom + cam.h * 0.5;
          this._strokeWire(ctx, cam, p0.x, p0.y, p1.x, p1.y, true, kFrom, 0);
        }
      }
    }
    ctx.restore();
  }

  /**
   * Cubica a tangenti orizzontali (stile editor a nodi). Il filo non arriva
   * al centro della porta: si ferma sul bordo della presa (il cerchio
   * .shc-dot ridisegnato qui, pieno color accento) così l'innesto si legge
   * anche senza chrome hover; quando il chrome appare, il suo dot DOM si
   * sovrappone identico. kTo = 0 → estremo libero (filo pendente): puntino.
   * @param {CanvasRenderingContext2D} ctx @param {import('./camera.js').Camera} cam
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {boolean} hot @param {number} kFrom @param {number} kTo
   */
  _strokeWire(ctx, cam, x0, y0, x1, y1, hot, kFrom, kTo) {
    // fattore di zoom del filo: come i nodi, tutto rimpicciolisce insieme
    // (spessori, puntini, pancia della curva); kTo=0 = estremo libero
    const ks = (kFrom + (kTo || kFrom)) / 2;
    const rIn = IN_PORT_R * kTo;
    const xe = x1 - rIn;
    const bulge = Math.max(24 * ks, Math.min(180, Math.abs(xe - x0) * 0.5));
    const pad = bulge + 12;
    if (Math.max(x0, x1) + pad < 0 || Math.min(x0, x1) - pad > cam.w ||
        Math.max(y0, y1) + 12 < 0 || Math.min(y0, y1) - 12 > cam.h) return;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + bulge, y0, xe - bulge, y1, xe, y1);
    // doppio tratto: alone chiaro sotto + anima scura sopra, così il filo
    // resta leggibile sia sul workspace chiaro sia attraversando nodi scuri;
    // sotto il mezzo pixel l'alone è solo poltiglia e costo: via
    if (!hot && ks > 0.4) {
      ctx.strokeStyle = LINK_HALO;
      ctx.lineWidth = 3 * ks;
      ctx.stroke();
    }
    ctx.strokeStyle = hot ? LINK_COLOR_HOT : LINK_COLOR;
    ctx.lineWidth = (hot ? 2 : 1.5) * ks;
    ctx.stroke();
    // spina sul + del sorgente (il .shc-plus linked del chrome è già accento)
    ctx.fillStyle = LINK_ACCENT;
    ctx.beginPath();
    ctx.arc(x0, y0, 4 * kFrom, 0, Math.PI * 2);
    ctx.fill();
    if (!kTo) {
      // estremo libero che segue il puntatore
      ctx.beginPath();
      ctx.arc(x1, y1, 3 * ks, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // presa: alone morbido + disco pieno, come .shc-port.linked .shc-dot
    ctx.beginPath();
    ctx.arc(x1, y1, rIn + 2.5 * kTo, 0, Math.PI * 2);
    ctx.fillStyle = hot ? 'rgba(77, 124, 254, 0.45)' : 'rgba(77, 124, 254, 0.25)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x1, y1, rIn, 0, Math.PI * 2);
    ctx.fillStyle = LINK_ACCENT;
    ctx.fill();
  }

  /**
   * Durante il trascinamento del filo: anello + etichetta della porta che
   * riceverebbe l'aggancio, su ogni nodo visibile (sorgente text → Prompt,
   * sorgente image → Image), così si vede dove il filo può attaccarsi.
   * Le porte già raggiunte da un filo dello stesso tipo restano col disco
   * pieno dei link esistenti: niente anello sopra.
   * @param {CanvasRenderingContext2D} ctx @param {import('./camera.js').Camera} cam
   * @param {SpaceNode} src @param {Map<number, SpaceNode>} byId
   */
  _drawCandidatePorts(ctx, cam, src, byId) {
    const row = src.kind === 'image' ? 1 : 0;
    const label = row === 1 ? 'Image' : 'Prompt';
    /** @type {Set<number>} */
    const filled = new Set();
    for (const l of this.links) {
      const s = byId.get(l.from);
      if (s && (s.kind === 'image' ? 1 : 0) === row) filled.add(l.to);
    }
    const p = { x: 0, y: 0 };
    for (const n of this.nodes) {
      if (n.id === src.id || filled.has(n.id)) continue;
      const w = n.w * cam.zoom;
      const h = n.h * cam.zoom;
      const x = (n.x - n.w / 2 - cam.x) * cam.zoom + cam.w * 0.5;
      const y = (n.y - n.h / 2 - cam.y) * cam.zoom + cam.h * 0.5;
      if (x > cam.w + 40 || y > cam.h + 40 || x + w < -80 || y + h < -40) continue;
      const k = this._chromeScale(cam, n);
      this._inPortPoint(cam, n, row, p);
      const r = IN_PORT_R * k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 10, 10, 0.6)';
      ctx.fill();
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.stroke();
      // etichetta come nel chrome (testo chiaro, alone scuro per il fondo
      // chiaro); sotto ~7px sarebbe poltiglia: solo l'anello
      if (k > 0.6) {
        ctx.font = `600 ${Math.round(12 * k)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3 * k;
        ctx.strokeStyle = 'rgba(15, 17, 22, 0.6)';
        ctx.strokeText(label, p.x - r - 10 * k, p.y);
        ctx.fillStyle = 'rgba(242, 243, 246, 0.95)';
        ctx.fillText(label, p.x - r - 10 * k, p.y);
      }
    }
  }

  /** Alone sul nodo che riceverà il filo. @param {CanvasRenderingContext2D} ctx @param {import('./camera.js').Camera} cam @param {SpaceNode} node */
  _strokeLinkTarget(ctx, cam, node) {
    const w = node.w * cam.zoom;
    const h = node.h * cam.zoom;
    const x = (node.x - node.w / 2 - cam.x) * cam.zoom + cam.w * 0.5;
    const y = (node.y - node.h / 2 - cam.y) * cam.zoom + cam.h * 0.5;
    const scale = Math.max(0.02, Math.min(w / TEXT_NODE_DESIGN_W, h / TEXT_NODE_DESIGN_H));
    roundRectPath(ctx, x - 3, y - 3, w + 6, h + 6, 11 * scale + 3);
    ctx.lineWidth = 2;
    ctx.strokeStyle = LINK_COLOR_HOT;
    ctx.stroke();
  }

  /** Trascinamento dal + (porta out). @param {PointerEvent} e @param {SpaceNode} node */
  _beginLink(e, node) {
    if (this._link || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    this._closeLinkMenu();
    const cam = this.app.camera;
    cam.screenToWorld(e.clientX, e.clientY, this._world);
    this._link = {
      fromId: node.id,
      pointerId: e.pointerId,
      wx: this._world.x,
      wy: this._world.y,
      toId: 0,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      menu: false,
    };
    this._setHover(null);
    document.body.classList.add('space-linking');
    window.addEventListener('pointermove', this._onLinkMove);
    window.addEventListener('pointerup', this._onLinkEnd);
    window.addEventListener('pointercancel', this._onLinkCancel);
    this.sync(cam, true);
  }

  /** @param {PointerEvent} e */
  _onLinkMove = (e) => {
    const link = this._link;
    if (!link || link.menu || e.pointerId !== link.pointerId) return;
    const cam = this.app.camera;
    cam.screenToWorld(e.clientX, e.clientY, this._world);
    link.wx = this._world.x;
    link.wy = this._world.y;
    if (Math.hypot(e.clientX - link.sx, e.clientY - link.sy) > LINK_CLICK_SLOP_PX) link.moved = true;
    const id = this._hitTest(e.clientX, e.clientY);
    link.toId = id === link.fromId ? 0 : id;
    this.sync(cam, true);
  };

  /** @param {PointerEvent} e */
  _onLinkEnd = (e) => {
    const link = this._link;
    if (!link || link.menu || e.pointerId !== link.pointerId) return;
    this._unbindLinkDrag();
    if (link.toId) {
      // sul nodo: collega, o scollega se il filo c'era già
      this._toggleLink(link.fromId, link.toId);
      this._link = null;
    } else {
      // sul vuoto: menu di creazione con il filo già pronto; il click secco
      // sul + piazza il nuovo nodo a destra del sorgente
      if (!link.moved) {
        const src = this.nodes.find((n) => n.id === link.fromId);
        if (src) {
          const cam = this.app.camera;
          link.wx = src.x + src.w / 2 + (LINK_DROP_GAP_PX + TEXT_NODE_SCREEN_W / 2) / cam.zoom;
          link.wy = src.y;
        }
      }
      link.menu = true;
      this._openLinkMenu(link);
    }
    this.sync(this.app.camera, true);
  };

  /** @param {PointerEvent} e */
  _onLinkCancel = (e) => {
    const link = this._link;
    if (!link || link.menu || e.pointerId !== link.pointerId) return;
    this._unbindLinkDrag();
    this._link = null;
    this.sync(this.app.camera, true);
  };

  _unbindLinkDrag() {
    document.body.classList.remove('space-linking');
    window.removeEventListener('pointermove', this._onLinkMove);
    window.removeEventListener('pointerup', this._onLinkEnd);
    window.removeEventListener('pointercancel', this._onLinkCancel);
  }

  /** @param {number} from @param {number} to */
  _toggleLink(from, to) {
    const i = this.links.findIndex((l) => l.from === from && l.to === to);
    if (i >= 0) this.links.splice(i, 1);
    else this.links.push({ from, to });
    this._version++;
    this._syncKey = '';
    const sel = this._selectedNode;
    if (sel && (sel.id === to || sel.id === from)) this._syncPromptHint(sel);
  }

  /** Chiude filo pendente e menu. @returns {boolean} true se c'era qualcosa da chiudere */
  cancelLink() {
    const had = !!this._link || !!(this._linkMenuEl && !this._linkMenuEl.hidden);
    if (this._link && !this._link.menu) this._unbindLinkDrag();
    this._link = null;
    this._closeLinkMenu();
    if (had && this.visible) this.sync(this.app.camera, true);
    return had;
  }

  /** Menu Text/Image al punto di rilascio del filo. @param {{ wx:number, wy:number }} link */
  _openLinkMenu(link) {
    if (!this._linkMenuEl) this._createLinkMenu();
    const menu = /** @type {HTMLElement} */ (this._linkMenuEl);
    this.app.camera.worldToScreen(link.wx, link.wy, this._screen);
    menu.hidden = false;
    const mw = menu.offsetWidth || 292;
    const mh = menu.offsetHeight || 116;
    const x = Math.min(Math.max(8, this._screen.x + 16), window.innerWidth - mw - 8);
    const y = Math.min(Math.max(8, this._screen.y - mh / 2), window.innerHeight - mh - 8);
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
  }

  _createLinkMenu() {
    const menu = document.createElement('aside');
    menu.className = 'spaces-create-menu space-link-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Create linked node');
    menu.hidden = true;
    const item = (/** @type {string} */ kind, /** @type {string} */ title, /** @type {string} */ desc, /** @type {string} */ icon) => `
      <button class="spaces-menu-item" type="button" role="menuitem" data-link-create="${kind}">
        <span class="spaces-menu-icon" aria-hidden="true">${svgIcon(icon)}</span>
        <span class="spaces-menu-copy">
          <span class="spaces-menu-title">${title}</span>
          <span class="spaces-menu-desc">${desc}</span>
        </span>
      </button>`;
    menu.innerHTML =
      item('text', 'Text', 'Generate and edit text', '<path d="M8 7h8"/><path d="M8 12h8"/><path d="M8 17h5"/>') +
      item('image', 'Image', 'Generate and edit images', IC_IMAGE);
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target.closest('[data-link-create]') : null;
      const link = this._link;
      if (!(t instanceof HTMLElement) || !link) return;
      this._createLinkedNode(link, t.dataset.linkCreate === 'image' ? 'image' : 'text');
    });
    document.body.appendChild(menu);
    this._linkMenuEl = menu;
  }

  _closeLinkMenu() {
    if (this._linkMenuEl) this._linkMenuEl.hidden = true;
    if (this._link?.menu) this._link = null;
  }

  /** Nodo nuovo al punto di rilascio, già collegato al sorgente. @param {{ fromId:number, wx:number, wy:number }} link @param {SpaceNodeKind} kind */
  _createLinkedNode(link, kind) {
    const cam = this.app.camera;
    const from = this.nodes.find((n) => n.id === link.fromId);
    this._closeLinkMenu();
    this._link = null;
    const node = this._createNode(
      kind,
      link.wx,
      link.wy,
      TEXT_NODE_SCREEN_W / cam.zoom,
      TEXT_NODE_SCREEN_H / cam.zoom
    );
    if (from) this.links.push({ from: from.id, to: node.id });
    this.select(node.id, true);
    this.sync(cam, true);
  }

  /** Testi dei nodi text agganciati alla porta in, in ordine di collegamento. @param {SpaceNode} node */
  _linkedPrompts(node) {
    /** @type {string[]} */
    const out = [];
    for (const l of this.links) {
      if (l.to !== node.id) continue;
      const src = this.nodes.find((n) => n.id === l.from);
      if (src?.kind !== 'text') continue;
      const t = String(src.text || '').trim();
      if (t) out.push(t);
    }
    return out;
  }

  /** Nodi image agganciati alla porta in che hanno già un'immagine. @param {SpaceNode} node */
  _linkedImageCount(node) {
    let n = 0;
    for (const l of this.links) {
      if (l.to !== node.id) continue;
      const src = this.nodes.find((s) => s.id === l.from);
      if (src?.kind === 'image' && src.img) n++;
    }
    return n;
  }

  /**
   * Immagini dei nodi image collegati alla porta in, ridotte a jpeg come i
   * riferimenti manuali (fondo bianco, lato max REF_SIDE_MAX); l'encoding è
   * memoizzato sul record, quindi rigenerare non ricodifica. Se il full-res è
   * stato rilasciato si ridecodifica al volo (fallback: base, mai a vuoto).
   * @param {SpaceNode} node @returns {Promise<string[]>} base64 jpeg, in ordine di collegamento
   */
  async _linkedImageRefs(node) {
    /** @type {string[]} */
    const out = [];
    for (const l of this.links) {
      if (l.to !== node.id) continue;
      const src = this.nodes.find((n) => n.id === l.from);
      if (src?.kind !== 'image' || !src.img) continue;
      const rec = src.img;
      let b64 = rec.refJpeg;
      if (b64 == null) {
        try {
          const img = rec.full || (await this._requestFull(rec)) || rec.base;
          if (!img) continue;
          const iw = /** @type {any} */ (img).width || /** @type {any} */ (img).naturalWidth || 1;
          const ih = /** @type {any} */ (img).height || /** @type {any} */ (img).naturalHeight || 1;
          const s = Math.min(1, REF_SIDE_MAX / Math.max(iw, ih));
          const cnv = document.createElement('canvas');
          cnv.width = Math.max(1, Math.round(iw * s));
          cnv.height = Math.max(1, Math.round(ih * s));
          const ctx = /** @type {CanvasRenderingContext2D} */ (cnv.getContext('2d'));
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cnv.width, cnv.height);
          ctx.drawImage(/** @type {any} */ (img), 0, 0, cnv.width, cnv.height);
          b64 = cnv.toDataURL('image/jpeg', 0.88).split(',')[1] || '';
        } catch {
          b64 = '';
        }
        rec.refJpeg = b64;
      }
      if (b64) out.push(b64);
    }
    return out;
  }

  // ---------- chrome hover (solo desktop, per ora puramente visivo) ----------

  /** @param {PointerEvent} e */
  _onHoverMove = (e) => {
    if (!this.visible || !this.interactive || this._drag || this._link) {
      if (this._hoverNode) this._setHover(null);
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const cam = this.app.camera;
    if (this._hoverNode && this._hoverEl && !this._hoverEl.hidden) {
      // menu della pill aperto: le liste lunghe (es. i 10 formati) sporgono
      // oltre il fondo del nodo + 20px di keep-alive — finché il puntatore
      // è sul menu l'hover resta vivo, sennò scendere lo chiudeva
      const menu = this._hoverModelMenu;
      if (menu && !menu.hidden) {
        const mr = menu.getBoundingClientRect();
        if (e.clientX >= mr.left - 16 && e.clientX <= mr.right + 16 &&
            e.clientY >= mr.top - 16 && e.clientY <= mr.bottom + 16) return;
      }
      const lx = e.clientX - cam.ox;
      const ly = e.clientY - cam.oy;
      const r = this._hoverRect;
      if (lx >= r.x - HOVER_KEEP_LEFT_PX && lx <= r.x + r.w + HOVER_KEEP_RIGHT_PX &&
          ly >= r.y - HOVER_KEEP_TOP_PX && ly <= r.y + r.h + HOVER_KEEP_BOTTOM_PX) return;
    }
    const id = this._hitTest(e.clientX, e.clientY);
    if (!id) {
      if (this._hoverNode) this._setHover(null);
      return;
    }
    if (id === this._hoverNode?.id) return;
    this._setHover(this.nodes.find((n) => n.id === id) || null);
  };

  /** @param {SpaceNode|null} node */
  _setHover(node) {
    if (node === this._hoverNode) return;
    this._hoverNode = node;
    if (!node) {
      if (this._hoverEl) {
        this._hoverEl.hidden = true;
        this._closeModelMenu();
      }
      return;
    }
    if (!this._hoverEl) this._createHoverChrome();
    this._renderHoverChrome(node);
    this._syncHover(this.app.camera);
  }

  /** @param {import('./camera.js').Camera} cam */
  _syncHover(cam) {
    const node = this._hoverNode;
    if (!node || !this._hoverEl) return;
    if (!this.interactive || !this._nodeCells.has(node.id)) {
      this._setHover(null);
      return;
    }
    const w = node.w * cam.zoom;
    const h = node.h * cam.zoom;
    if (Math.min(w, h) < HOVER_CHROME_MIN_PX) {
      this._hoverEl.hidden = true;
      this._closeModelMenu();
      return;
    }
    cam.worldToScreen(node.x - node.w / 2, node.y - node.h / 2, this._screen);
    const left = Math.round(this._screen.x - cam.ox);
    const top = Math.round(this._screen.y - cam.oy);
    this._hoverRect.x = left;
    this._hoverRect.y = top;
    this._hoverRect.w = w;
    this._hoverRect.h = h;
    this._hoverEl.style.width = `${Math.round(w)}px`;
    this._hoverEl.style.height = `${Math.round(h)}px`;
    this._hoverEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    this._hoverEl.hidden = false;
  }

  _createHoverChrome() {
    const el = document.createElement('div');
    el.className = 'space-hover-chrome';
    el.setAttribute('aria-hidden', 'true');
    el.hidden = true;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const t = e.target instanceof Element ? e.target : null;
      const node = this._hoverNode;
      // tenendo premuto il + parte il filo verso un altro nodo (o il menu sul vuoto)
      if (node && t?.closest('.shc-plus')) this._beginLink(e, node);
    });
    el.addEventListener('click', this._onHoverChromeClick);
    this.layer.appendChild(el);
    this._hoverEl = el;
    this._hoverKind = '';
  }

  /** @param {SpaceNode} node */
  _renderHoverChrome(node) {
    const el = this._hoverEl;
    if (!el) return;
    if (node.kind !== this._hoverKind) {
      this._hoverKind = node.kind;
      el.classList.toggle('shc-img', node.kind === 'image');
      el.innerHTML = node.kind === 'image' ? this._imageChromeHTML() : this._textChromeHTML();
      this._hoverTitle = /** @type {HTMLElement} */ (el.querySelector('.shc-title-text'));
      this._hoverModelName = /** @type {HTMLElement|null} */ (el.querySelector('.shc-model-name'));
      this._hoverModelTag = /** @type {HTMLElement|null} */ (el.querySelector('.shc-model-tag'));
      this._hoverModelMenu = /** @type {HTMLElement|null} */ (el.querySelector('.shc-model-menu'));
      this._hoverRatioChip = /** @type {HTMLElement|null} */ (el.querySelector('.shc-ratio-pick'));
      this._hoverQualityChip = /** @type {HTMLElement|null} */ (el.querySelector('.shc-quality-pick'));
      this._hoverVarsChip = /** @type {HTMLElement|null} */ (el.querySelector('.shc-vars-pick'));
      this._hoverImgCount = /** @type {HTMLElement|null} */ (el.querySelector('.shc-imgcount'));
    }
    this._closeModelMenu();
    if (this._hoverTitle) this._hoverTitle.textContent = node.label;
    if (node.kind === 'image') this._updateHoverChips(node);
    this._updateHoverPorts(node);
  }

  /**
   * Accende sul chrome i cerchi delle porte in agganciate: Prompt se arriva
   * un testo, Image se arriva un'immagine, e il + se il nodo ha fili in uscita.
   * @param {SpaceNode} node
   */
  _updateHoverPorts(node) {
    const el = this._hoverEl;
    if (!el) return;
    let text = false;
    let image = false;
    let outgoing = false;
    for (const l of this.links) {
      if (l.from === node.id) outgoing = true;
      if (l.to !== node.id) continue;
      const src = this.nodes.find((n) => n.id === l.from);
      if (src?.kind === 'image') image = true;
      else if (src) text = true;
    }
    const ports = el.querySelectorAll('.shc-port');
    ports[0]?.classList.toggle('linked', text);
    ports[1]?.classList.toggle('linked', image);
    el.querySelector('.shc-plus')?.classList.toggle('linked', outgoing);
  }

  /** Allinea i chip della pill (modello/formato/qualità/varianti) e la porta Image. @param {SpaceNode} node */
  _updateHoverChips(node) {
    if (node.kind !== 'image' || node !== this._hoverNode) return;
    const model = node.model || defaultImageModel();
    const name = imageModelName(model);
    if (this._hoverModelName) this._hoverModelName.textContent = name;
    if (this._hoverModelTag) this._hoverModelTag.textContent = name;
    const setLabel = (/** @type {HTMLElement|null} */ chip, /** @type {string} */ text) => {
      const l = chip?.querySelector('.shc-chip-label');
      if (l) l.textContent = text;
    };
    setLabel(this._hoverRatioChip, node.ratio || '1:1');
    setLabel(this._hoverQualityChip, node.quality || '1K');
    setLabel(this._hoverVarsChip, `×${node.nvars || 1}`);
    if (this._hoverQualityChip) this._hoverQualityChip.hidden = !QUALITY_MODELS.has(model);
    if (this._hoverImgCount) {
      // allegati manuali + immagini dei nodi collegati (quelle che partiranno davvero)
      this._hoverImgCount.textContent = `${(node.refs?.length || 0) + this._linkedImageCount(node)}/${refMax(model)}`;
    }
  }

  _textChromeHTML() {
    return `
      <div class="shc-pill">
        <span class="shc-model">Models ${svgIcon(IC_CARET)}</span>
        <span class="shc-sep"></span>
        <span class="shc-ic">${svgIcon('<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>')}</span>
        <span class="shc-ic">${svgIcon('<circle cx="12" cy="12" r="7" stroke-dasharray="2.6 2.6"/>')}</span>
        <span class="shc-ic">${svgIcon('<path d="M8 4h8v16l-4-3.5L8 20z"/>')}</span>
      </div>
      <div class="shc-titlebar">
        <span class="shc-title">${svgIcon('<path d="M6 8h12"/><path d="M6 12h12"/><path d="M6 16h12"/>')}<span class="shc-title-text"></span></span>
        <span class="shc-model-tag">Models</span>
      </div>
      <div class="shc-ports">
        <div class="shc-port"><span class="shc-port-label">${svgIcon('<path d="M6 6h12"/><path d="M12 6v12"/>')} Prompt</span><span class="shc-dot"></span></div>
        <div class="shc-port"><span class="shc-port-label">${svgIcon(IC_IMAGE)} Image <em>0/20</em></span><span class="shc-dot"></span></div>
        <div class="shc-port"><span class="shc-port-label">${svgIcon('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>')} Video <em>0/20</em></span><span class="shc-dot"></span></div>
        <div class="shc-port"><span class="shc-port-label">${svgIcon('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>')} Document</span><span class="shc-dot"></span></div>
      </div>
      <span class="shc-plus">${svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/>')}</span>
      <div class="shc-footer">
        <span class="shc-at">@</span>
        <span class="shc-foot-right">
          <span class="shc-ic">${svgIcon('<path d="M4 7h10"/><path d="M4 12h10"/><path d="M4 17h6"/><path d="M17 14v6"/><path d="M14 17h6"/>')}</span>
          <span class="shc-send">${svgIcon('<path d="M12 18V6"/><path d="M6 12l6-6 6 6"/>')}</span>
        </span>
      </div>`;
  }

  _imageChromeHTML() {
    return `
      <div class="shc-pill">
        <button class="shc-model shc-model-pick" type="button" tabindex="-1" data-pill-menu="model">
          <span class="shc-model-name"></span>${svgIcon(IC_CARET)}
        </button>
        <span class="shc-sep"></span>
        <button class="shc-chip shc-ratio-pick" type="button" tabindex="-1" data-pill-menu="ratio" title="Formato"><span class="shc-chip-label">1:1</span>${svgIcon(IC_CARET)}</button>
        <button class="shc-chip shc-quality-pick" type="button" tabindex="-1" data-pill-menu="quality" title="Qualità"><span class="shc-chip-label">1K</span>${svgIcon(IC_CARET)}</button>
        <button class="shc-chip shc-vars-pick" type="button" tabindex="-1" data-pill-menu="vars" title="Varianti per generazione"><span class="shc-chip-label">×1</span>${svgIcon(IC_CARET)}</button>
        <span class="shc-sep"></span>
        <span class="shc-ic">${svgIcon('<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>')}</span>
        <span class="shc-ic">${svgIcon('<path d="M8 4h8v16l-4-3.5L8 20z"/>')}</span>
        <span class="shc-ic">${svgIcon('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>')}</span>
        <div class="shc-model-menu" hidden></div>
      </div>
      <div class="shc-titlebar">
        <span class="shc-title">${svgIcon(IC_IMAGE)}<span class="shc-title-text"></span></span>
        <span class="shc-model-tag"></span>
      </div>
      <div class="shc-ports">
        <div class="shc-port"><span class="shc-port-label">${svgIcon('<path d="M6 6h12"/><path d="M12 6v12"/>')} Prompt</span><span class="shc-dot"></span></div>
        <div class="shc-port"><span class="shc-port-label">${svgIcon(IC_IMAGE)} Image <em class="shc-imgcount">0/14</em></span><span class="shc-dot"></span></div>
      </div>
      <span class="shc-plus">${svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/>')}</span>`;
  }

  /** @param {MouseEvent} e */
  _onHoverChromeClick = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const node = this._hoverNode;
    if (!target || !node || node.kind !== 'image') return;
    const opt = target.closest('.shc-model-opt');
    if (opt instanceof HTMLElement && opt.dataset.value !== undefined) {
      this._pickPillOption(node, opt.dataset.kind || '', opt.dataset.value);
      return;
    }
    const chip = target.closest('[data-pill-menu]');
    if (chip instanceof HTMLElement) {
      const kind = chip.dataset.pillMenu || '';
      const menu = this._hoverModelMenu;
      if (!menu) return;
      if (menu.hidden || this._pillMenuKind !== kind) this._openPillMenu(node, kind, chip);
      else this._closeModelMenu();
    }
  };

  /**
   * Menu unico della pill, riusato per modello/formato/qualità/varianti.
   * @param {SpaceNode} node @param {string} kind @param {HTMLElement} anchor
   */
  _openPillMenu(node, kind, anchor) {
    const menu = this._hoverModelMenu;
    if (!menu) return;
    /** @type {{v:string, label:string}[]} */
    let items = [];
    let current = '';
    if (kind === 'model') {
      items = imageModels().map((m) => ({ v: m.id, label: m.name }));
      current = node.model || defaultImageModel();
    } else if (kind === 'ratio') {
      items = GEN_RATIOS.map((r) => ({ v: r, label: r }));
      current = node.ratio || '1:1';
    } else if (kind === 'quality') {
      items = GEN_QUALITIES.map((q) => ({ v: q, label: q }));
      current = node.quality || '1K';
    } else if (kind === 'vars') {
      items = GEN_VARIANTS.map((n) => ({ v: String(n), label: n === 1 ? '×1 · singola' : `×${n} varianti` }));
      current = String(node.nvars || 1);
    } else {
      return;
    }
    menu.textContent = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.className = 'shc-model-opt' + (it.v === current ? ' current' : '');
      b.dataset.kind = kind;
      b.dataset.value = it.v;
      b.textContent = it.label;
      if (it.v === current) b.insertAdjacentHTML('beforeend', svgIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'));
      menu.appendChild(b);
    }
    menu.style.left = `${Math.max(6, anchor.offsetLeft)}px`;
    this._pillMenuKind = kind;
    menu.hidden = false;
  }

  _closeModelMenu() {
    if (this._hoverModelMenu) this._hoverModelMenu.hidden = true;
    this._pillMenuKind = '';
  }

  /** @param {SpaceNode} node @param {string} kind @param {string} value */
  _pickPillOption(node, kind, value) {
    if (kind === 'model') {
      node.model = value;
      try { localStorage.setItem('fable-paint.space-image-model', value); } catch { /* storage unavailable */ }
      // qualità disponibile solo sul Pro: rientra a 1K sugli altri
      if (!QUALITY_MODELS.has(value)) node.quality = '1K';
      // i modelli base accettano meno riferimenti
      if (node.refs && node.refs.length > refMax(value)) node.refs.length = refMax(value);
    } else if (kind === 'ratio') {
      node.ratio = value;
    } else if (kind === 'quality') {
      node.quality = value;
    } else if (kind === 'vars') {
      node.nvars = Math.max(1, Number(value) || 1);
    }
    this._updateHoverChips(node);
    this._updateGenCost(node);
    if (node === this._selectedNode) {
      this._syncGenToolStates(node);
      this._syncRefsRow(node);
    }
    this._closeModelMenu();
  }

  // ---------- generazione immagine ----------

  /** @param {SpaceNode} node */
  async _generate(node) {
    if (!node || node.kind !== 'image' || node.busy) return;
    // i testi collegati alla porta in entrano nel prompt prima del testo del nodo
    const own = String(node.text || '').trim();
    const prompt = [...this._linkedPrompts(node), own].filter(Boolean).join('\n\n');
    if (prompt.length < 2) {
      this._showGenError(node, 'Scrivi prima cosa vuoi generare.');
      return;
    }
    const model = node.model || defaultImageModel();
    const per = genCost(model, node.quality || '1K', 1);
    const n = Math.max(1, node.nvars || 1);
    const total = per * n;
    if (!wallet.spend(total)) {
      this._showGenError(node, `Token insufficienti: servono ${total} T.`);
      this._playNoTokensFx();
      return;
    }
    this._playSpendFx(total);
    node.busy = true;
    node.genT0 = performance.now();
    node.genErr = '';
    this._refreshNodeUi(node);
    this._startGenLoop();

    const style = GEN_STYLES.find((s) => s.id === (node.style || ''));
    // riferimenti: prima le immagini dei nodi collegati alla porta, poi gli
    // allegati manuali @, entro il tetto del modello
    const refs = [...(await this._linkedImageRefs(node)), ...(node.refs || []).map((r) => r.b64)]
      .slice(0, refMax(model));
    /** @type {{prompt:string, model:string, aspectRatio:string, enhance:boolean, refs:{data:string, mimeType:string}[], imageSize?:string}} */
    const payload = {
      prompt: prompt + (style?.suffix || ''),
      model,
      aspectRatio: node.ratio || '1:1',
      enhance: !!node.enhance,
      refs: refs.map((data) => ({ data, mimeType: 'image/jpeg' })),
    };
    if (QUALITY_MODELS.has(model)) payload.imageSize = node.quality || '1K';

    try {
      /** @type {GenImage[]} */
      const imgs = [];
      let failMsg = '';
      // ogni variante è una chiamata indipendente: le fallite vengono rimborsate
      await Promise.all(Array.from({ length: n }, async () => {
        try {
          const res = await fetch('/api/ai/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.imageBase64) throw new Error(data.error || 'Generazione fallita.');
          imgs.push(await decodeGenImage(data.imageBase64, data.mimeType));
        } catch (err) {
          failMsg = err instanceof Error ? err.message : 'Generazione fallita.';
          wallet.refund(per);
        }
      }));
      if (!this.nodes.includes(node)) {
        for (const img of imgs) if ('close' in img) img.close();
        return;
      }
      if (!imgs.length) {
        node.genErr = failMsg || 'Generazione fallita.';
        return;
      }
      if (failMsg) node.genErr = `${n - imgs.length} varianti fallite (rimborsate).`;
      const first = !node.img;
      closeNodeImages(node);
      node.variants = imgs.map((img) => this._makeImgRec(img));
      node.img = node.variants[0];
      node.imgW = node.img.w;
      node.imgH = node.img.h;
      if (first) node.w *= GEN_GROW;
      node.h = node.w * (node.imgH / node.imgW);
      this._reindexNode(node);
      if (/^Image \d+$/.test(node.label)) {
        node.label = titleFromPrompt(own || prompt) || node.label;
        if (node === this._selectedNode && this.editorTitle) this.editorTitle.textContent = node.label;
        if (node === this._hoverNode && this._hoverTitle) this._hoverTitle.textContent = node.label;
      }
    } catch (err) {
      // imprevisto fuori dalle chiamate: niente doppio rimborso, solo il messaggio
      if (this.nodes.includes(node)) {
        node.genErr = err instanceof Error ? err.message : 'Generazione fallita.';
      }
    } finally {
      node.busy = false;
      this._bumpPreview(node);
      this._refreshNodeUi(node);
    }
  }

  /** Rinfresca editor + scena dopo un cambio di stato del nodo. @param {SpaceNode} node */
  _refreshNodeUi(node) {
    if (node === this._selectedNode && this.editorEl?.isConnected) {
      this._syncEditorState(node);
      this._syncEditor(this.app.camera);
    }
    this._version++;
    this._syncKey = '';
    if (this.visible) this.sync(this.app.camera, true);
  }

  /** @param {SpaceNode} node @param {string} msg */
  _showGenError(node, msg) {
    node.genErr = msg;
    if (node === this._selectedNode && this.editorGenErr) {
      this.editorGenErr.textContent = msg;
      this.editorGenErr.hidden = false;
    }
  }

  /** Loop rAF attivo solo mentre c'è almeno una generazione in corso. */
  _startGenLoop() {
    if (this._genRaf) return;
    const tick = () => {
      const busy = this.nodes.filter((n) => n.busy);
      if (!busy.length) {
        this._genRaf = 0;
        return;
      }
      const sel = this._selectedNode;
      if (sel?.busy && this.editorEl?.isConnected) {
        const t = performance.now() - (sel.genT0 || 0);
        if (this.editorLoadRing) this.editorLoadRing.style.setProperty('--p', String(genProgress(t)));
        if (this.editorLoadEta) {
          const remaining = Math.max(0, Math.round((GEN_ETA_MS - t) / 1000));
          this.editorLoadEta.textContent = remaining > 0 ? `~${remaining}s` : 'quasi pronto…';
        }
      }
      // i nodi in generazione non selezionati animano sul canvas di scena
      if (busy.some((n) => n.id !== this.selectedId) && this.visible) {
        this._syncKey = '';
        this.sync(this.app.camera, true);
      }
      this._genRaf = requestAnimationFrame(tick);
    };
    this._genRaf = requestAnimationFrame(tick);
  }

  // ---------- feedback token ----------

  /** Pop del bottone + scintille + "−N T" fluttuante alla spesa. @param {number} cost */
  _playSpendFx(cost) {
    const btn = this.editorGenBtn;
    const host = btn?.parentElement;
    if (!btn || !host || !btn.isConnected || typeof btn.animate !== 'function') return;
    btn.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }],
      { duration: 340, easing: 'cubic-bezier(.34,1.56,.64,1)' }
    );
    for (let i = 0; i < 9; i++) {
      const s = document.createElement('span');
      s.className = 'sgb-spark';
      host.appendChild(s);
      const a = (Math.PI * 2 * i) / 9 + Math.random() * 0.6;
      const d = 20 + Math.random() * 18;
      const anim = s.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px) scale(.3)`, opacity: 0 },
        ],
        { duration: 480 + Math.random() * 220, easing: 'cubic-bezier(.2,.7,.3,1)' }
      );
      anim.onfinish = () => s.remove();
      anim.oncancel = () => s.remove();
    }
    const f = document.createElement('span');
    f.className = 'sgb-float';
    f.textContent = `−${cost} T`;
    host.appendChild(f);
    const fa = f.animate(
      [
        { transform: 'translateY(0)', opacity: 1 },
        { transform: 'translateY(-30px)', opacity: 0 },
      ],
      { duration: 850, easing: 'ease-out' }
    );
    fa.onfinish = () => f.remove();
    fa.oncancel = () => f.remove();
  }

  _playNoTokensFx() {
    const btn = this.editorGenBtn;
    if (!btn || !btn.isConnected || typeof btn.animate !== 'function') return;
    btn.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-5px)' },
        { transform: 'translateX(5px)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(3px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 360, easing: 'ease-in-out' }
    );
    btn.parentElement?.querySelector('.sgb-balance')?.animate(
      [{ color: '#ff8a8a' }, { color: '' }],
      { duration: 700 }
    );
  }

  /**
   * Ticker animato del saldo (spesa = oro a scendere, rimborso = verde a salire).
   * @param {number} target @param {number} delta
   */
  _animateBalance(target, delta) {
    const elN = this.editorBalanceN;
    const from = this._shownBalance;
    this._shownBalance = target;
    if (!elN || !elN.isConnected) {
      if (elN) elN.textContent = String(target);
      return;
    }
    const chip = elN.parentElement;
    chip?.classList.remove('tick-up', 'tick-down');
    chip?.classList.add(delta < 0 ? 'tick-down' : 'tick-up');
    setTimeout(() => chip?.classList.remove('tick-up', 'tick-down'), 750);
    const t0 = performance.now();
    const dur = 620;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const ease = 1 - (1 - k) * (1 - k);
      elN.textContent = String(Math.round(from + (target - from) * ease));
      if (k < 1 && this._shownBalance === target) requestAnimationFrame(step);
      else if (this._shownBalance === target) elN.textContent = String(target);
    };
    requestAnimationFrame(step);
  }
}
