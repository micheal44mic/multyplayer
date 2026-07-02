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
/** @typedef {{x: number, y: number, dirX: number, dirY: number}} DabPoint */

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
    this.blurOpacity = clamp(brush.blurOpacity ?? 1, 0, 1);
    this.drag = clamp(brush.blurDrag ?? 0, 0, 1);
    this.radius = Math.max(0.5, size * 0.5);
    this.hardness = clamp(1 - (brush.blurSoftness ?? 0.65), 0, 1);
    this.shape = brush.shape || null;
    this.shapeInvert = !!brush.shapeInvert;
    this.shapeRoundness = clamp(brush.roundness || 1, 0.05, 1);
    this.shapeBaseAngle = (brush.angle || 0) * Math.PI / 180;
    this.shapeRotation = clamp(brush.rotation || 0, -1, 1);
    this.maskMaxHalf = this.shape ? Math.ceil(this.radius * 1.06 * Math.SQRT2) + 2 : this.radius;
    // Dimensione = area toccata; forza = quanto si spande il blur dentro
    // quell'area. Tenerli separati evita che un pennello grande sia sempre
    // anche una sfocatura ingestibile.
    this.sigma = clamp(this.radius * 0.22 * blurStrength, 0.35, 48);
    this.pad = Math.ceil(this.sigma * 3) + 2;
    const blurSpacing = size >= 500 ? 0.34 : size >= 240 ? 0.28 : size >= 100 ? 0.22 : 0.16;
    const dragSpacing = size >= 500 ? 0.16 : size >= 240 ? 0.12 : size >= 100 ? 0.08 : 0.06;
    const spacingFloor = lerp(blurSpacing, dragSpacing, this.drag);
    this.spacing = Math.max(2, size * spacingFloor);

    this.lastX = x;
    this.lastY = y;
    this.lastP = p;
    this.gap = this.spacing;
    this.active = true;
    this.ending = false;
    this.finished = false;
    this.changed = false;

    /** @type {Map<number, {cx:number, cy:number, data: Uint8ClampedArray<ArrayBuffer>|null}>} */
    this.before = new Map();
    /** @type {Map<string, DabPoint>} */
    this.prevDabs = new Map();
    /** @type {{x:number,y:number,p:number}[]} */
    this.dabs = [];
    this.dabRead = 0;

    app.undoMgr.captureBegin(layer.id);
    this._enqueue(x, y, p);
  }

  /** @param {number} x @param {number} y @param {number} p */
  move(x, y, p) {
    if (!this.active || this.ending) return;
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
      this._enqueue(lerp(this.lastX, x, t), lerp(this.lastY, y, t), lerp(this.lastP, p, t));
      this.gap = this.spacing;
    }
    this.gap -= dist - travelled;
    this.lastX = x; this.lastY = y; this.lastP = p;
  }

  /** @param {number} x @param {number} y @param {number} p */
  end(x, y, p) {
    if (!this.active || this.ending) return;
    this.move(x, y, p);
    this.ending = true;
  }

  /** @param {number} maxMs */
  process(maxMs) {
    if (this.finished) return true;
    const unlimited = maxMs === Infinity;
    const t0 = performance.now();
    while (this.dabRead < this.dabs.length) {
      const dab = this.dabs[this.dabRead++];
      this._dab(dab.x, dab.y, dab.p);
      if (!unlimited && performance.now() - t0 >= maxMs) break;
    }
    if (this.dabRead > 64 && this.dabRead === this.dabs.length) {
      this.dabs.length = 0;
      this.dabRead = 0;
    }
    if (this.ending && this.dabRead >= this.dabs.length) {
      this.finish();
      return true;
    }
    return false;
  }

  finish() {
    if (this.finished) return;
    this.active = false;
    this.finished = true;
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
    if (!this.active && this.finished) return;
    this.active = false;
    this.ending = true;
    this.dabs.length = 0;
    this.dabRead = 0;
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
    this.finished = true;
  }

  /** @param {number} x @param {number} y @param {number} p */
  _enqueue(x, y, p) {
    this.dabs.push({ x, y, p });
  }

  /** @param {number} x @param {number} y @param {number} p */
  _dab(x, y, p) {
    this._dabRepeated(x, y, p, 'main');
    if (this.mirrorX !== null) {
      const mx = this.mirrorX * 2 - x;
      if (Math.abs(mx - x) > 0.01) this._dabRepeated(mx, y, p, 'mirror');
    }
  }

  /** @param {number} x @param {number} y @param {number} p @param {string} lane */
  _dabRepeated(x, y, p, lane) {
    const tile = this.patternTile;
    if (!tile || tile.w <= 0 || tile.h <= 0) {
      this._dabOne(x, y, p, lane);
      return;
    }
    for (const ox of [-tile.w, 0, tile.w]) {
      for (const oy of [-tile.h, 0, tile.h]) {
        const px = x + ox, py = y + oy;
        const half = this.maskMaxHalf;
        if (px + half < tile.x || py + half < tile.y ||
          px - half > tile.x + tile.w - 1 || py - half > tile.y + tile.h - 1) continue;
        this._dabOne(px, py, p, `${lane}:${ox}:${oy}`);
      }
    }
  }

  /** @param {number} x @param {number} y @param {number} p @param {string} lane */
  _dabOne(x, y, p, lane) {
    const r = this.radius;
    const pressure = clamp(p, 0, 1);
    if (pressure <= 0.001) return;
    const prev = this.drag > 0.0001 ? this.prevDabs.get(lane) || null : null;
    let dirX = prev?.dirX || 0;
    let dirY = prev?.dirY || 0;
    let dragOffset = 0;
    if (prev) {
      const dx = x - prev.x;
      const dy = y - prev.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.0001) {
        dirX = dx / dist;
        dirY = dy / dist;
        dragOffset = dist * this.drag;
      }
    }
    const hasSmudge = this.drag > 0.0001 && dragOffset > 0.0001 && Math.hypot(dirX, dirY) > 0.0001;
    const stamp = this._shapeStamp(dirX, dirY);
    const half = stamp ? stamp.half : r;

    if (this.drag >= 0.9999 && !hasSmudge) {
      this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }

    let x0 = Math.max(Math.floor(x - half), this.clip.x0);
    let y0 = Math.max(Math.floor(y - half), this.clip.y0);
    let x1 = Math.min(Math.ceil(x + half), this.clip.x1);
    let y1 = Math.min(Math.ceil(y + half), this.clip.y1);
    if (x0 > x1 || y0 > y1) return;

    const useBlur = this.drag < 0.9999 && this.blurOpacity > 0.0001;
    if (!useBlur && !hasSmudge) {
      if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }
    const smudgePad = hasSmudge ? Math.ceil(dragOffset + Math.max(0.5, half * 0.07) + 2) : 0;
    const pad = Math.max(useBlur ? this.pad : 0, smudgePad);
    const sx = x0 - pad, sy = y0 - pad;
    const sw = x1 - x0 + 1 + pad * 2;
    const sh = y1 - y0 + 1 + pad * 2;
    let bx0 = sx, by0 = sy, bx1 = sx + sw - 1, by1 = sy + sh - 1;
    if (useBlur) {
      const content = this._contentBounds(sx, sy, sw, sh);
      if (!content) {
        if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
        return;
      }
      bx0 = Math.max(sx, content.x0 - pad);
      by0 = Math.max(sy, content.y0 - pad);
      bx1 = Math.min(sx + sw - 1, content.x1 + pad);
      by1 = Math.min(sy + sh - 1, content.y1 + pad);
      x0 = Math.max(x0, bx0);
      y0 = Math.max(y0, by0);
      x1 = Math.min(x1, bx1);
      y1 = Math.min(y1, by1);
      if (x0 > x1 || y0 > y1) return;
    } else if (this.store.count === 0) {
      if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }

    const csx = bx0, csy = by0;
    const csw = bx1 - bx0 + 1;
    const csh = by1 - by0 + 1;
    const src = this._snapshot(csx, csy, csw, csh);
    const blurred = useBlur ? src.slice() : null;
    if (blurred) gaussianBlurBuffer(blurred, csw, csh, this.sigma);

    this._blendResult(x, y, x0, y0, x1, y1, csx, csy, csw, csh, src, blurred, dirX, dirY, dragOffset, pressure, stamp);
    if (this.drag > 0.0001) {
      this.prevDabs.set(lane, { x, y, dirX, dirY });
    }
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
   * @param {number} sh
   * @param {Uint8ClampedArray<ArrayBuffer>} src
   * @param {Uint8ClampedArray<ArrayBuffer>|null} blurred
   * @param {number} dirX
   * @param {number} dirY
   * @param {number} dragOffset
   * @param {number} pressure
   * @param {{size:number, half:number, mask:Uint8Array}|null} stamp
   */
  _blendResult(cx, cy, x0, y0, x1, y1, sx, sy, sw, sh, src, blurred, dirX, dirY, dragOffset, pressure, stamp) {
    const drag = this.drag;
    const hasSmudge = drag > 0.0001 && dragOffset > 0.0001 && Math.hypot(dirX, dirY) > 0.0001;
    const perpX = -dirY;
    const perpY = dirX;
    const crossStep = Math.max(0.5, this.radius * 0.07);
    const pulled = [0, 0, 0, 0];
    const sideA = [0, 0, 0, 0];
    const sideB = [0, 0, 0, 0];
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
            const mask = this._maskAt(wx, wy, cx, cy, stamp) * pressure;
            if (mask <= 0.0001) continue;

            const sa = src[si + 3];
            let na = sa;
            let nr = src[si];
            let ng = src[si + 1];
            let nb = src[si + 2];
            if (blurred) {
              const ba = blurred[si + 3];
              const blurMask = mask * this.blurOpacity * (1 - drag);
              if (sa !== 0 || ba !== 0) {
                na = i255(na + (ba - na) * blurMask);
                nr = Math.min(i255(nr + (blurred[si] - nr) * blurMask), na);
                ng = Math.min(i255(ng + (blurred[si + 1] - ng) * blurMask), na);
                nb = Math.min(i255(nb + (blurred[si + 2] - nb) * blurMask), na);
              }
            }
            if (hasSmudge) {
              const dragMask = drag * mask;
              if (dragMask > 0.0001) {
                const sourceX = wx + 0.5 - dirX * dragOffset;
                const sourceY = wy + 0.5 - dirY * dragOffset;
                this._samplePremulInto(src, sw, sh, sx, sy, sourceX, sourceY, pulled);
                this._samplePremulInto(src, sw, sh, sx, sy, sourceX + perpX * crossStep, sourceY + perpY * crossStep, sideA);
                this._samplePremulInto(src, sw, sh, sx, sy, sourceX - perpX * crossStep, sourceY - perpY * crossStep, sideB);
                const tr = pulled[0] * 0.6 + sideA[0] * 0.2 + sideB[0] * 0.2;
                const tg = pulled[1] * 0.6 + sideA[1] * 0.2 + sideB[1] * 0.2;
                const tb = pulled[2] * 0.6 + sideA[2] * 0.2 + sideB[2] * 0.2;
                const ta = pulled[3] * 0.6 + sideA[3] * 0.2 + sideB[3] * 0.2;
                if (sa === 0 && ta <= 0.0001 && !blurred) continue;
                nr = i255(nr + (tr - nr) * dragMask);
                ng = i255(ng + (tg - ng) * dragMask);
                nb = i255(nb + (tb - nb) * dragMask);
                na = i255(na + (ta - na) * dragMask);
                nr = Math.min(nr, na);
                ng = Math.min(ng, na);
                nb = Math.min(nb, na);
              }
            }
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

  /**
   * @param {Uint8ClampedArray<ArrayBuffer>} src
   * @param {number} sw @param {number} sh
   * @param {number} sx @param {number} sy
   * @param {number} wx @param {number} wy
   * @param {number[]} out
   */
  _samplePremulInto(src, sw, sh, sx, sy, wx, wy, out) {
    const fx = wx - sx - 0.5;
    const fy = wy - sy - 0.5;
    if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, sw - 1);
    const y1 = Math.min(y0 + 1, sh - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const i00 = (y0 * sw + x0) * 4;
    const i10 = (y0 * sw + x1) * 4;
    const i01 = (y1 * sw + x0) * 4;
    const i11 = (y1 * sw + x1) * 4;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    out[0] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    out[1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    out[2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
    out[3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
  }

  /**
   * @param {number} wx @param {number} wy @param {number} cx @param {number} cy
   * @param {{size:number, half:number, mask:Uint8Array}|null} [stamp]
   */
  _maskAt(wx, wy, cx, cy, stamp = null) {
    const sel = this.selMask;
    let bm = 1;
    if (stamp) {
      const ix = Math.round(cx - stamp.half);
      const iy = Math.round(cy - stamp.half);
      const mx = wx - ix, my = wy - iy;
      if (mx < 0 || my < 0 || mx >= stamp.size || my >= stamp.size) return 0;
      bm = stamp.mask[my * stamp.size + mx] / 255;
      if (bm <= 0) return 0;
    } else {
      bm = falloff(Math.hypot(wx + 0.5 - cx, wy + 0.5 - cy), this.radius, this.hardness);
      if (bm <= 0) return 0;
    }
    if (sel) {
      const mx = wx - sel.x, my = wy - sel.y;
      if (mx < 0 || my < 0 || mx >= sel.w || my >= sel.h) return 0;
      const sm = sel.mask[my * sel.w + mx] / 255;
      if (sm <= 0) return 0;
      return sm * bm;
    }
    return bm;
  }

  /**
   * @param {number} dirX
   * @param {number} dirY
   * @returns {{size:number, half:number, mask:Uint8Array}|null}
   */
  _shapeStamp(dirX, dirY) {
    const shape = this.shape;
    if (!shape) return null;
    let angle = this.shapeBaseAngle;
    if (this.shapeRotation !== 0 && (dirX !== 0 || dirY !== 0)) {
      angle += this.shapeRotation * Math.atan2(dirY, dirX);
    }
    return this.app.stampCache.getStamp(this.radius, this.hardness, this.shapeRoundness, angle,
      shape, this.shapeInvert);
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
