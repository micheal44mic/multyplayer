// PENNELLO BLUR -- applica una sfocatura locale direttamente sul layer
// raster attivo. Usa tile-diff per undo/collab, ma non passa dallo
// strokeStore: il risultato dipende dai pixel gia' presenti sotto il dab.

import { brush, falloff } from './brush.js';
import { gaussianBlurBuffer } from './fx_blur.js';
import { CHUNK, CHUNK_SHIFT, chunkKey, forEachChunkInRect } from './store.js';
import { clamp, lerp } from './util.js';

/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

/** @param {number} v */
const i255 = (v) => v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;

export class BlurBrushSession {
  /**
   * @param {import('./main.js').App} app
   * @param {Board} board
   * @param {Layer} layer
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip
   * @param {{mask: Uint8Array, x: number, y: number, w: number, h: number}|null} selMask
   * @param {number|null} mirrorX
   * @param {{x: number, y: number, w: number, h: number}|null} patternTile
   * @param {number} x @param {number} y @param {number} p
   */
  constructor(app, board, layer, clip, selMask, mirrorX, patternTile, x, y, p) {
    this.app = app;
    this.board = board;
    this.layer = layer;
    this.store = /** @type {ChunkStore} */ (layer.store);
    this.clip = clip;
    this.selMask = selMask;
    this.mirrorX = mirrorX;
    this.patternTile = patternTile;

    const size = clamp(brush.blurSize || brush.size, 1, 2000);
    const blurStrength = clamp(brush.blurStrength || 1, 0.05, 2);
    this.opacity = clamp(brush.blurOpacity ?? 1, 0, 1);
    this.radius = Math.max(0.5, size * 0.5);
    this.hardness = clamp(1 - (brush.blurSoftness ?? 0.65), 0, 1);
    // Dimensione = area toccata; forza = quanto si spande il blur dentro
    // quell'area. Tenerli separati evita che un pennello grande sia sempre
    // anche una sfocatura ingestibile.
    this.sigma = clamp(this.radius * 0.22 * blurStrength, 0.35, 48);
    this.pad = Math.ceil(this.sigma * 3) + 2;
    const spacingFloor = size >= 500 ? 0.34 : size >= 240 ? 0.28 : size >= 100 ? 0.22 : 0.16;
    this.spacing = Math.max(2, size * spacingFloor);

    this.lastX = x;
    this.lastY = y;
    this.lastP = p;
    this.gap = this.spacing;
    this.active = true;
    this.changed = false;

    /** @type {Map<number, {cx:number, cy:number, data: Uint8ClampedArray<ArrayBuffer>|null}>} */
    this.before = new Map();

    app.undoMgr.captureBegin(layer.id);
    this._dab(x, y, p);
  }

  /** @param {number} x @param {number} y @param {number} p */
  move(x, y, p) {
    if (!this.active) return;
    const dx = x - this.lastX, dy = y - this.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) {
      this.lastX = x; this.lastY = y; this.lastP = p;
      return;
    }
    let travelled = 0;
    while (this.gap <= dist - travelled) {
      travelled += this.gap;
      const t = travelled / dist;
      this._dab(lerp(this.lastX, x, t), lerp(this.lastY, y, t), lerp(this.lastP, p, t));
      this.gap = this.spacing;
    }
    this.gap -= dist - travelled;
    this.lastX = x; this.lastY = y; this.lastP = p;
  }

  /** @param {number} x @param {number} y @param {number} p */
  end(x, y, p) {
    if (!this.active) return;
    this.move(x, y, p);
    this.finish();
  }

  finish() {
    if (!this.active) return;
    this.active = false;
    const publishChunks = [];
    for (const b of this.before.values()) publishChunks.push({ cx: b.cx, cy: b.cy });
    const shouldPublish = this.changed && this.app.collab && this.app.collab.canSendPixelPatch &&
      publishChunks.length > 0;
    const undoCount = this.app.undoMgr.undoStack.length;
    if (shouldPublish) this.app.collab.suppressNextAutoPixelPatch();
    this.app.undoMgr.captureEnd();
    if (shouldPublish && this.app.undoMgr.undoStack.length > undoCount) {
      this.app.collab.sendPixelPatch(this.layer.id, publishChunks);
    }
    if (this.changed) {
      this.layer.thumbDirty = true;
      this.app.ui.layersUI.scheduleThumbs();
    }
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    const dispose = (/** @type {Chunk} */ c) => this.app.renderer.disposeChunkTex(c);
    for (const [key, b] of this.before) {
      if (b.data) {
        const c = this.store.getOrCreate(b.cx, b.cy);
        c.data.set(b.data);
        c.touched = true;
        this.store.markDirty(c);
      } else {
        this.store.remove(key, dispose);
      }
    }
    this.app.undoMgr.captureCancel();
    if (this.changed) {
      this.layer.thumbDirty = true;
      this.app.ui.layersUI.scheduleThumbs();
    }
  }

  /** @param {number} x @param {number} y @param {number} p */
  _dab(x, y, p) {
    this._dabRepeated(x, y, p);
    if (this.mirrorX !== null) {
      const mx = this.mirrorX * 2 - x;
      if (Math.abs(mx - x) > 0.01) this._dabRepeated(mx, y, p);
    }
  }

  /** @param {number} x @param {number} y @param {number} p */
  _dabRepeated(x, y, p) {
    const tile = this.patternTile;
    if (!tile || tile.w <= 0 || tile.h <= 0) {
      this._dabOne(x, y, p);
      return;
    }
    for (const ox of [-tile.w, 0, tile.w]) {
      for (const oy of [-tile.h, 0, tile.h]) {
        const px = x + ox, py = y + oy;
        if (px + this.radius < tile.x || py + this.radius < tile.y ||
          px - this.radius > tile.x + tile.w - 1 || py - this.radius > tile.y + tile.h - 1) continue;
        this._dabOne(px, py, p);
      }
    }
  }

  /** @param {number} x @param {number} y @param {number} p */
  _dabOne(x, y, p) {
    const r = this.radius;
    const strength = clamp(p * this.opacity, 0, 1);
    if (strength <= 0.001) return;

    let x0 = Math.max(Math.floor(x - r), this.clip.x0);
    let y0 = Math.max(Math.floor(y - r), this.clip.y0);
    let x1 = Math.min(Math.ceil(x + r), this.clip.x1);
    let y1 = Math.min(Math.ceil(y + r), this.clip.y1);
    if (x0 > x1 || y0 > y1) return;

    const sx = x0 - this.pad, sy = y0 - this.pad;
    const sw = x1 - x0 + 1 + this.pad * 2;
    const sh = y1 - y0 + 1 + this.pad * 2;
    const content = this._contentBounds(sx, sy, sw, sh);
    if (!content) return;

    const bx0 = Math.max(sx, content.x0 - this.pad);
    const by0 = Math.max(sy, content.y0 - this.pad);
    const bx1 = Math.min(sx + sw - 1, content.x1 + this.pad);
    const by1 = Math.min(sy + sh - 1, content.y1 + this.pad);
    x0 = Math.max(x0, bx0);
    y0 = Math.max(y0, by0);
    x1 = Math.min(x1, bx1);
    y1 = Math.min(y1, by1);
    if (x0 > x1 || y0 > y1) return;

    const csx = bx0, csy = by0;
    const csw = bx1 - bx0 + 1;
    const csh = by1 - by0 + 1;
    const src = this._snapshot(csx, csy, csw, csh);
    const blurred = src.slice();
    gaussianBlurBuffer(blurred, csw, csh, this.sigma);

    this._blendResult(x, y, x0, y0, x1, y1, csx, csy, csw, src, blurred, strength);
  }

  /**
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @returns {Uint8ClampedArray<ArrayBuffer>}
   */
  _snapshot(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    forEachChunkInRect(this.store, x, y, x + w - 1, y + h - 1, false,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const dx0 = ox + lx0 - x;
        const dy0 = oy + ly0 - y;
        const n = (lx1 - lx0 + 1) * 4;
        for (let ly = ly0; ly <= ly1; ly++) {
          const so = ((ly << CHUNK_SHIFT) + lx0) * 4;
          const dofs = ((dy0 + ly - ly0) * w + dx0) * 4;
          out.set(chunk.data.subarray(so, so + n), dofs);
        }
      });
    return out;
  }

  /**
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
   */
  _contentBounds(x, y, w, h) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    forEachChunkInRect(this.store, x, y, x + w - 1, y + h - 1, false,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const data = chunk.data;
        for (let ly = ly0; ly <= ly1; ly++) {
          let i = ((ly << CHUNK_SHIFT) + lx0) * 4;
          for (let lx = lx0; lx <= lx1; lx++, i += 4) {
            if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 0) continue;
            const wx = ox + lx, wy = oy + ly;
            if (wx < x0) x0 = wx;
            if (wx > x1) x1 = wx;
            if (wy < y0) y0 = wy;
            if (wy > y1) y1 = wy;
          }
        }
      });
    return x1 < x0 ? null : { x0, y0, x1, y1 };
  }

  /**
   * @param {number} cx @param {number} cy
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {number} sx @param {number} sy @param {number} sw
   * @param {Uint8ClampedArray<ArrayBuffer>} src
   * @param {Uint8ClampedArray<ArrayBuffer>} blurred
   * @param {number} strength
   */
  _blendResult(cx, cy, x0, y0, x1, y1, sx, sy, sw, src, blurred, strength) {
    for (let chy = y0 >> CHUNK_SHIFT; chy <= y1 >> CHUNK_SHIFT; chy++) {
      for (let chx = x0 >> CHUNK_SHIFT; chx <= x1 >> CHUNK_SHIFT; chx++) {
        const key = chunkKey(chx, chy);
        const ox = chx << CHUNK_SHIFT, oy = chy << CHUNK_SHIFT;
        const lx0 = Math.max(0, x0 - ox), ly0 = Math.max(0, y0 - oy);
        const lx1 = Math.min(CHUNK - 1, x1 - ox), ly1 = Math.min(CHUNK - 1, y1 - oy);
        let chunk = this.store.getByKey(key);
        let wrote = false;
        let dx0 = CHUNK, dy0 = CHUNK, dx1 = -1, dy1 = -1;

        for (let ly = ly0; ly <= ly1; ly++) {
          const wy = oy + ly;
          let di = ((ly << CHUNK_SHIFT) + lx0) * 4;
          let si = ((wy - sy) * sw + (ox + lx0 - sx)) * 4;
          for (let lx = lx0; lx <= lx1; lx++, di += 4, si += 4) {
            const wx = ox + lx;
            const mask = this._maskAt(wx, wy, cx, cy) * strength;
            if (mask <= 0.0001) continue;

            const sa = src[si + 3];
            const ba = blurred[si + 3];
            if (sa === 0 && ba === 0) continue;

            const na = i255(sa + (ba - sa) * mask);
            const nr = Math.min(i255(src[si] + (blurred[si] - src[si]) * mask), na);
            const ng = Math.min(i255(src[si + 1] + (blurred[si + 1] - src[si + 1]) * mask), na);
            const nb = Math.min(i255(src[si + 2] + (blurred[si + 2] - src[si + 2]) * mask), na);
            const cr = chunk ? chunk.data[di] : 0;
            const cg = chunk ? chunk.data[di + 1] : 0;
            const cb = chunk ? chunk.data[di + 2] : 0;
            const ca = chunk ? chunk.data[di + 3] : 0;
            if (nr === cr && ng === cg && nb === cb && na === ca) continue;

            if (!wrote) {
              this._capture(key, chx, chy, chunk || null);
              if (!chunk) chunk = this.store.getOrCreate(chx, chy);
              wrote = true;
            }
            chunk.data[di] = nr;
            chunk.data[di + 1] = ng;
            chunk.data[di + 2] = nb;
            chunk.data[di + 3] = na;
            if (lx < dx0) dx0 = lx;
            if (lx > dx1) dx1 = lx;
            if (ly < dy0) dy0 = ly;
            if (ly > dy1) dy1 = ly;
          }
        }

        if (wrote && chunk) {
          chunk.touched = true;
          this.store.markDirty(chunk, dx0, dy0, dx1, dy1);
          this.changed = true;
        }
      }
    }
  }

  /** @param {number} wx @param {number} wy @param {number} cx @param {number} cy */
  _maskAt(wx, wy, cx, cy) {
    const sel = this.selMask;
    if (sel) {
      const mx = wx - sel.x, my = wy - sel.y;
      if (mx < 0 || my < 0 || mx >= sel.w || my >= sel.h) return 0;
      const sm = sel.mask[my * sel.w + mx] / 255;
      if (sm <= 0) return 0;
      return sm * falloff(Math.hypot(wx + 0.5 - cx, wy + 0.5 - cy), this.radius, this.hardness);
    }
    return falloff(Math.hypot(wx + 0.5 - cx, wy + 0.5 - cy), this.radius, this.hardness);
  }

  /** @param {number} key @param {number} cx @param {number} cy @param {Chunk|null} chunk */
  _capture(key, cx, cy, chunk) {
    if (this.before.has(key)) return;
    this.before.set(key, {
      cx, cy,
      data: chunk ? chunk.data.slice() : null,
    });
    this.app.undoMgr.captureChunk(key, cx, cy, chunk ? chunk.data : null);
  }
}
