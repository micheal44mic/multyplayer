// QUAD DEL TESTO — presentazione raster dei livelli testo NON in editing.
// Il dato resta vettoriale (item + style: editing, warp, undo ed export non
// cambiano); qui si cuoce drawTextDocument (faccia + effetti, stessa resa
// dell'export) in un canvas alla risoluzione dello zoom assestato, e il
// renderer lo presenta come UN quad alla posizione del livello nella pila
// (GL: texture, con scissor al board; fallback/pool 2D: drawImage + clip).
// Senza il piano SVG in mezzo i run raster non si spezzano più: tutti i
// livelli restano sul renderer WebGL del fondo (mipmap in minificazione) e
// i tratti sopra un testo non perdono più l'antialias sui piani 2D.
// L'SVG vettoriale resta SOLO per il testo ATTIVO del board attivo (lì
// passano pannello Testo e sessione Sposta — e col testo attivo il pennello
// comunque non scrive: paintTarget è null).
//
// Politica di ricottura:
// - contenuto (layer.ver via touchText) o font atterrato: subito, a budget;
// - zoom: il quad scala col gesto (lieve sfocatura, come il freeze touch
//   dei piani SVG) e si ricuoce nitido a camera ferma da STABLE_FRAMES,
//   solo se la scala è derivata oltre [0.6, 1.4]×;
// - fuori vista non si cuoce niente; un bake stantio resta buono finché
//   l'eviction (non disegnato per EVICT_FRAMES) non lo libera.

import { blockBox, drawTextDocument, ensureFont, touchText } from './text_layer.js';
import { clamp } from './util.js';

/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./boards.js').BoardManager} BoardManager */

const MAX_BAKES_PER_FRAME = 2; // drawTextDocument con effetti può costare
const STABLE_FRAMES = 6;       // camera ferma prima della ricottura da zoom
const EVICT_SWEEP = 60;        // cadenza dello sweep (frame)
const EVICT_FRAMES = 600;      // non disegnato da ~10 s: bake liberato
const MAX_SIDE = 4096;         // lato massimo della texture (cap sotto al device)
const MAX_PX = 4 << 20;        // pixel massimi per bake (16 MB RGBA)
const SCALE_MIN = 1 / 32;
const SCALE_MAX = 4;           // oltre il lavoro è a pixel (MAG NEAREST dei chunk)

/**
 * Bake di un livello testo. x/y/w/h = rettangolo MONDO del quad (l'ingombro
 * di blockBox arrotondato a interi); il canvas è quel rettangolo a `scale`
 * px per px mondo. tex/texGen li gestisce il renderer GL
 * (_ensureTextQuadTex): qui si invalidano e basta (texDirty, context perso).
 * @typedef {Object} TextQuadEntry
 * @property {number} layerId
 * @property {HTMLCanvasElement|null} canvas
 * @property {string} key contenuto dell'ultimo bake (ver + stato font)
 * @property {number} scale px canvas per px mondo dell'ultimo bake
 * @property {number} x @property {number} y
 * @property {number} w @property {number} h
 * @property {boolean} texDirty la texture GL va (ri)caricata dal canvas
 * @property {WebGLTexture|null} tex
 * @property {number} texGen generazione del contesto della texture
 * @property {number} lastUse ultimo frame in cui il quad è stato disegnato
 * @property {{x: number, y: number, w: number, h: number}|null} box ingombro mondo (cache)
 * @property {string} boxKey
 */

export class TextQuadCache {
  constructor() {
    /** @type {Map<number, TextQuadEntry>} layerId -> bake */
    this._map = new Map();
    this._frame = 0;
    /** @type {WebGLRenderingContext|null} */
    this._gl = null;
    this._gen = -1;
    this._maxSide = MAX_SIDE;
    this._zoomPrev = NaN;
    this._stable = 0;
    this.bakedThisFrame = 0;
    this.bakedPixelsThisFrame = 0;
    this.bakeMsThisFrame = 0;
    this.bakeMaxPixelsThisFrame = 0;
    this.cacheSerial = 0;
    // visibleRect riusati (update e quadFor girano nello stesso frame)
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._rect2 = { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  // Da chiamare una volta a frame PRIMA del render dei piani: decide e fa i
  // bake (a budget), gestisce context loss ed eviction. skip = layer dei
  // board coperti da un quad proxy (il proxy cuoce anche i loro testi).
  // Ritorna il numero di bake fatti (per invalidare i piani 2D del pool).
  /**
   * @param {import('./renderer_gl.js').GLRenderer | import('./renderer_2d.js').Canvas2DRenderer | import('./renderer_wgpu.js').WgpuRenderer} renderer
   * @param {BoardManager} boards
   * @param {Camera} camera
   * @param {number} liveTextId testo in editing (SVG vivo): mai cotto qui; -1 = tutti i testi sono SVG
   * @param {Set<number>|null} skip
   */
  update(renderer, boards, camera, liveTextId, skip) {
    this._frame++;
    this.bakedThisFrame = 0;
    this.bakedPixelsThisFrame = 0;
    this.bakeMsThisFrame = 0;
    this.bakeMaxPixelsThisFrame = 0;
    const gl = renderer.gl || null;
    const gen = renderer.ctxGen || 0;
    if (gl !== this._gl || gen !== this._gen) {
      // contesto nuovo (perso/ricreato/fallback 2D): le texture non esistono
      // più, i canvas CPU restano buoni
      for (const e of this._map.values()) {
        e.tex = null;
        e.texDirty = true;
      }
      this._gl = gl;
      this._gen = gen;
      this._maxSide = gl
        ? Math.min(MAX_SIDE, gl.getParameter(gl.MAX_TEXTURE_SIZE) || MAX_SIDE)
        : MAX_SIDE;
    }
    if (camera.zoom !== this._zoomPrev) {
      this._zoomPrev = camera.zoom;
      this._stable = 0;
    } else {
      this._stable++;
    }

    let budget = MAX_BAKES_PER_FRAME;
    const r = camera.visibleRect(this._rect);
    for (const b of boards.boards) {
      for (const l of b.mgr.layers) {
        if (l.kind !== 'text' || liveTextId === -1 || l.id === liveTextId) continue;
        if (!l.visible || l.opacity <= 0) continue;
        if (skip !== null && skip.has(l.id)) continue;
        let e = this._map.get(l.id);
        if (!e) {
          e = {
            layerId: l.id, canvas: null, key: '', scale: 1,
            x: 0, y: 0, w: 0, h: 0, texDirty: true,
            tex: null, texGen: -1, lastUse: this._frame,
            box: null, boxKey: '',
          };
          this._map.set(l.id, e);
        }
        const fontReady = document.fonts.check(`${l.style.weight} 16px "${l.style.font}"`) ? 1 : 0;
        const key = `${l.ver | 0}|${fontReady}`;
        if (e.boxKey !== key || !e.box) {
          e.box = blockBox(l.item, l.style);
          e.boxKey = key;
        }
        const bx = e.box;
        // fuori vista: niente bake (il quad eventualmente stantio resta)
        if (bx.x > r.x1 || bx.y > r.y1 || bx.x + bx.w < r.x0 || bx.y + bx.h < r.y0) continue;
        e.lastUse = this._frame;
        const wanted = this._wantedScale(camera, bx);
        let need = e.canvas === null || e.key !== key;
        if (!need && this._stable >= STABLE_FRAMES &&
          (wanted > e.scale * 1.4 || wanted < e.scale * 0.6)) {
          need = true; // zoom assestato lontano dalla scala cotta
        }
        if (!need || budget <= 0) continue;
        budget--;
        const bakeT = performance.now();
        const px = this._bake(e, l, wanted, key, fontReady === 1);
        this.bakeMsThisFrame += performance.now() - bakeT;
        this.bakedPixelsThisFrame += px;
        this.bakeMaxPixelsThisFrame = Math.max(this.bakeMaxPixelsThisFrame, px);
      }
    }

    if (this._frame % EVICT_SWEEP === 0) this._sweep(boards);
    return this.bakedThisFrame;
  }

  // Il bake del livello, se c'è ed è in vista: i renderer lo chiamano per
  // ogni livello testo della pila. Marca l'uso (eviction).
  /** @param {number} layerId @param {Camera} camera @returns {TextQuadEntry|null} */
  quadFor(layerId, camera) {
    const e = this._map.get(layerId);
    if (!e || !e.canvas) return null;
    const r = camera.visibleRect(this._rect2);
    if (e.x > r.x1 || e.y > r.y1 || e.x + e.w < r.x0 || e.y + e.h < r.y0) return null;
    e.lastUse = this._frame;
    return e;
  }

  // Scala del bake: risoluzione device, con pavimento/tetto e il cap della
  // texture (lato massimo del device e MAX_PX totali — un testo enorme a
  // zoom spinto si cuoce alla risoluzione che ci sta, leggera morbidezza).
  /** @param {Camera} camera @param {{w: number, h: number}} box */
  _wantedScale(camera, box) {
    let s = clamp(camera.zoom * camera.dpr, SCALE_MIN, SCALE_MAX);
    s = Math.min(s, this._maxSide / box.w, this._maxSide / box.h,
      Math.sqrt(MAX_PX / (box.w * box.h)));
    return Math.max(s, SCALE_MIN);
  }

  /** @param {TextQuadEntry} e @param {Layer} l @param {number} s @param {string} key @param {boolean} fontReady */
  _bake(e, l, s, key, fontReady) {
    const bx = e.box;
    const x = Math.floor(bx.x), y = Math.floor(bx.y);
    const w = Math.max(1, Math.ceil(bx.x + bx.w) - x);
    const h = Math.max(1, Math.ceil(bx.y + bx.h) - y);
    const tw = Math.max(1, Math.round(w * s));
    const th = Math.max(1, Math.round(h * s));
    if (!e.canvas) e.canvas = document.createElement('canvas');
    if (e.canvas.width !== tw || e.canvas.height !== th) {
      e.canvas.width = tw; // il set azzera il canvas
      e.canvas.height = th;
    }
    const ctx = e.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, tw, th);
    ctx.imageSmoothingQuality = 'high'; // bitmap effetto minificate
    // fattori esatti texel<->mondo: il quad mondo w×h mappa 1:1 sul canvas
    ctx.setTransform(tw / w, 0, 0, th / h, 0, 0);
    drawTextDocument(ctx, l.item, l.style, x, y, 1, tw / w, th / h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    e.x = x; e.y = y; e.w = w; e.h = h;
    e.scale = s;
    e.key = key;
    e.texDirty = true;
    e.lastUse = this._frame;
    this.bakedThisFrame++;
    this.cacheSerial++;
    // font non ancora atterrato: cotto il fallback, si invalida la chiave
    // quando arriva quello vero (stesso pattern del proxy e di syncTextSvg)
    if (!fontReady) ensureFont(l.style.font, l.style.weight).then(() => touchText(l));
    return tw * th;
  }

  // Bake di livelli morti o non disegnati da troppo: liberati (i canvas CPU
  // e le texture sono memoria come i chunk; tutto rinasce on-demand).
  /** @param {BoardManager} boards */
  _sweep(boards) {
    let removed = false;
    for (const [id, e] of this._map) {
      const gone = !boards.layerById(id);
      if (!gone && this._frame - e.lastUse <= EVICT_FRAMES) continue;
      if (e.tex && this._gl && e.texGen === this._gen) this._gl.deleteTexture(e.tex);
      // renderer WebGPU: la texture (GPUTexture nel campo condiviso) si
      // libera esplicitamente — il GC non è deterministico sulla VRAM
      else if (e.tex && typeof (/** @type {any} */ (e.tex)).destroy === 'function') {
        /** @type {any} */ (e.tex).destroy();
      }
      this._map.delete(id);
      removed = true;
    }
    if (removed) this.cacheSerial++;
  }
}
