// QUAD SVG — presentazione raster dei livelli SVG NON attivi.
// Il contenuto resta vettoriale nel layer (svgItem): qui cuociamo solo una
// texture temporanea per non tenere vivi molti piani DOM durante zoom,
// cambio livello e multi-canvas. Lo SVG attivo resta un piano SVG vero.

import { drawSvgLayerToCanvas, svgItemBounds } from './svg_layer.js';
import { clamp } from './util.js';

/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./boards.js').BoardManager} BoardManager */

const MAX_STARTS_PER_FRAME = 1; // Blob+Image decode: lasciamolo fuori dal path caldo
const STABLE_FRAMES = 6;
const EVICT_SWEEP = 60;
const EVICT_FRAMES = 600;
const MAX_SIDE = 4096;
const MAX_PX = 4 << 20;
const SCALE_MIN = 1 / 32;
const SCALE_MAX = 4;

/**
 * @typedef {Object} SvgQuadEntry
 * @property {number} layerId
 * @property {HTMLCanvasElement|null} canvas
 * @property {string} key
 * @property {string} pendingKey
 * @property {number} scale
 * @property {number} x @property {number} y
 * @property {number} w @property {number} h
 * @property {boolean} texDirty
 * @property {WebGLTexture|null} tex
 * @property {number} texGen
 * @property {number} lastUse
 * @property {{x: number, y: number, w: number, h: number}|null} box
 * @property {string} boxKey
 */

export class SvgQuadCache {
  /** @param {(() => void)|null} [onInvalidate] */
  constructor(onInvalidate = null) {
    /** @type {Map<number, SvgQuadEntry>} */
    this._map = new Map();
    this._frame = 0;
    /** @type {WebGLRenderingContext|null} */
    this._gl = null;
    this._gen = -1;
    this._maxSide = MAX_SIDE;
    this._zoomPrev = NaN;
    this._stable = 0;
    this._pending = 0;
    this._onInvalidate = onInvalidate;
    this.bakedThisFrame = 0;
    this.bakedPixelsThisFrame = 0;
    this.bakeMsThisFrame = 0;
    this.bakeMaxPixelsThisFrame = 0;
    this.cacheSerial = 0;
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._rect2 = { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  /**
   * @param {import('./renderer_gl.js').GLRenderer | import('./renderer_2d.js').Canvas2DRenderer | import('./renderer_wgpu.js').WgpuRenderer} renderer
   * @param {BoardManager} boards
   * @param {Camera} camera
   * @param {number} liveSvgId SVG in editing: mai cotto qui; -1 = tutti SVG vivi
   * @param {Set<number>|null} skip
   */
  update(renderer, boards, camera, liveSvgId, skip) {
    this._frame++;
    this.bakedThisFrame = 0;
    this.bakedPixelsThisFrame = 0;
    this.bakeMsThisFrame = 0;
    this.bakeMaxPixelsThisFrame = 0;
    const gl = renderer.gl || null;
    const gen = renderer.ctxGen || 0;
    if (gl !== this._gl || gen !== this._gen) {
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

    let starts = MAX_STARTS_PER_FRAME;
    const r = camera.visibleRect(this._rect);
    for (const b of boards.boards) {
      for (const l of b.mgr.layers) {
        if (l.kind !== 'svg' || liveSvgId === -1 || l.id === liveSvgId) continue;
        if (!l.visible || l.opacity <= 0 || !l.svgItem) continue;
        if (skip !== null && skip.has(l.id)) continue;
        let e = this._map.get(l.id);
        if (!e) {
          e = {
            layerId: l.id, canvas: null, key: '', pendingKey: '', scale: 1,
            x: 0, y: 0, w: 0, h: 0, texDirty: true,
            tex: null, texGen: -1, lastUse: this._frame,
            box: null, boxKey: '',
          };
          this._map.set(l.id, e);
        }
        const key = `${l.ver | 0}`;
        const boxKey = `${key}|${b.x}|${b.y}|${b.w}|${b.h}`;
        if (e.boxKey !== boxKey || !e.box) {
          e.box = this._visibleBox(l, b);
          e.boxKey = boxKey;
        }
        const bx = e.box;
        if (!bx || bx.w <= 0 || bx.h <= 0) continue;
        if (bx.x > r.x1 || bx.y > r.y1 || bx.x + bx.w < r.x0 || bx.y + bx.h < r.y0) continue;
        e.lastUse = this._frame;
        const wanted = this._wantedScale(camera, bx);
        let need = e.canvas === null || e.key !== key;
        if (!need && this._stable >= STABLE_FRAMES &&
          (wanted > e.scale * 1.4 || wanted < e.scale * 0.6)) {
          need = true;
        }
        if (!need || e.pendingKey === key || starts <= 0) continue;
        starts--;
        this._startBake(e, l, bx, wanted, key);
      }
    }
    if (this._frame % EVICT_SWEEP === 0) this._sweep(boards);
    return this.bakedThisFrame;
  }

  /** @param {number} layerId @param {Camera} camera @returns {SvgQuadEntry|null} */
  quadFor(layerId, camera) {
    const e = this._map.get(layerId);
    if (!e || !e.canvas) return null;
    const r = camera.visibleRect(this._rect2);
    if (e.x > r.x1 || e.y > r.y1 || e.x + e.w < r.x0 || e.y + e.h < r.y0) return null;
    e.lastUse = this._frame;
    return e;
  }

  needsFrame() {
    return this._pending > 0;
  }

  /** @param {Layer} layer @param {{x: number, y: number, w: number, h: number}} board */
  _visibleBox(layer, board) {
    const raw = svgItemBounds(layer.svgItem);
    if (!raw) return null;
    const x0 = Math.max(raw.x, board.x);
    const y0 = Math.max(raw.y, board.y);
    const x1 = Math.min(raw.x + raw.w, board.x + board.w);
    const y1 = Math.min(raw.y + raw.h, board.y + board.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** @param {Camera} camera @param {{w: number, h: number}} box */
  _wantedScale(camera, box) {
    let s = clamp(camera.zoom * camera.dpr, SCALE_MIN, SCALE_MAX);
    s = Math.min(s, this._maxSide / box.w, this._maxSide / box.h,
      Math.sqrt(MAX_PX / (box.w * box.h)));
    return Math.max(s, SCALE_MIN);
  }

  /** @param {SvgQuadEntry} e @param {Layer} layer @param {{x: number, y: number, w: number, h: number}} box @param {number} s @param {string} key */
  _startBake(e, layer, box, s, key) {
    const x = Math.floor(box.x), y = Math.floor(box.y);
    const w = Math.max(1, Math.ceil(box.x + box.w) - x);
    const h = Math.max(1, Math.ceil(box.y + box.h) - y);
    const tw = Math.max(1, Math.round(w * s));
    const th = Math.max(1, Math.round(h * s));
    e.pendingKey = key;
    this._pending++;
    const t0 = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(tw / w, 0, 0, th / h, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    drawSvgLayerToCanvas(ctx, layer, { x, y, w, h }, 1, false)
      .then(() => {
        if (e.pendingKey !== key) return;
        e.canvas = canvas;
        e.x = x; e.y = y; e.w = w; e.h = h;
        e.scale = s;
        e.key = key;
        e.pendingKey = '';
        e.texDirty = true;
        e.lastUse = this._frame;
        this.bakedThisFrame++;
        this.bakedPixelsThisFrame += tw * th;
        this.bakeMaxPixelsThisFrame = Math.max(this.bakeMaxPixelsThisFrame, tw * th);
        this.bakeMsThisFrame += performance.now() - t0;
        this.cacheSerial++;
        if (this._onInvalidate) this._onInvalidate();
      })
      .catch((err) => {
        console.warn('[svg-quad] bake failed', err);
        if (e.pendingKey === key) e.pendingKey = '';
      })
      .finally(() => {
        this._pending = Math.max(0, this._pending - 1);
      });
  }

  /** @param {BoardManager} boards */
  _sweep(boards) {
    let removed = false;
    for (const [id, e] of this._map) {
      const gone = !boards.layerById(id);
      if (!gone && this._frame - e.lastUse <= EVICT_FRAMES) continue;
      if (e.tex && this._gl && e.texGen === this._gen) this._gl.deleteTexture(e.tex);
      this._map.delete(id);
      removed = true;
    }
    if (removed) this.cacheSerial++;
  }
}
