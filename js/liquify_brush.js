// PENNELLO LIQUIFY -- deformazione locale stile Procreate sul layer raster.
// Scrive a chunk, con una coda drenata a budget per non bloccare input e UI.

import { brush, falloff } from './brush.js';
import { CHUNK, CHUNK_SHIFT, chunkKey, forEachChunkInRect } from './store.js';
import { clamp, lerp } from './util.js';

/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */

const TWO_PI = Math.PI * 2;
/** @param {number} v */
const i255 = (v) => v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;

/** @param {number} x @param {number} y @param {number} seed */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** @param {number} x */
function smooth01(x) {
  x = clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
}

/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} x @param {number} y @param {number[]} out */
function sampleBilinear(data, w, h, x, y, out) {
  const fx = Math.floor(x), fy = Math.floor(y);
  if (fx < -1 || fy < -1 || fx >= w || fy >= h) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    return out;
  }
  const wx = x - fx, wy = y - fy;
  const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy);
  const w01 = (1 - wx) * wy, w11 = wx * wy;
  let r = 0, g = 0, b = 0, a = 0;
  if (fx >= 0 && fy >= 0) {
    const o = (fy * w + fx) * 4;
    r += data[o] * w00; g += data[o + 1] * w00; b += data[o + 2] * w00; a += data[o + 3] * w00;
  }
  if (fx + 1 < w && fy >= 0) {
    const o = (fy * w + fx + 1) * 4;
    r += data[o] * w10; g += data[o + 1] * w10; b += data[o + 2] * w10; a += data[o + 3] * w10;
  }
  if (fx >= 0 && fy + 1 < h) {
    const o = ((fy + 1) * w + fx) * 4;
    r += data[o] * w01; g += data[o + 1] * w01; b += data[o + 2] * w01; a += data[o + 3] * w01;
  }
  if (fx + 1 < w && fy + 1 < h) {
    const o = ((fy + 1) * w + fx + 1) * 4;
    r += data[o] * w11; g += data[o + 1] * w11; b += data[o + 2] * w11; a += data[o + 3] * w11;
  }
  out[0] = i255(r); out[1] = i255(g); out[2] = i255(b); out[3] = i255(a);
  return out;
}

export class LiquifyBrushSession {
  /**
   * @param {import('./main.js').App} app
   * @param {Board} board
   * @param {Layer} layer
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip
   * @param {{mask: Uint8Array, x: number, y: number, w: number, h: number}|null} selMask
   * @param {number|null} mirrorX
   * @param {{x: number, y: number, w: number, h: number}|null} patternTile
   * @param {number} x @param {number} y @param {number} p @param {number} t
   */
  constructor(app, board, layer, clip, selMask, mirrorX, patternTile, x, y, p, t) {
    this.app = app;
    this.board = board;
    this.layer = layer;
    this.store = /** @type {ChunkStore} */ (layer.store);
    this.clip = clip;
    this.selMask = selMask;
    this.mirrorX = mirrorX;
    this.patternTile = patternTile;

    this.size = clamp(brush.liquifySize || 96, 1, 2000);
    this.radius = Math.max(0.5, this.size * 0.5);
    this.pressure = clamp(brush.liquifyPressure ?? 0.62, 0, 1);
    this.distortion = clamp(brush.liquifyDistortion ?? 0, 0, 1);
    this.momentum = clamp(brush.liquifyMomentum ?? 0, 0, 1);
    this.mode = brush.liquifyMode || 'push';
    this.seed = ((performance.now() * 1000) | 0) ^ ((x * 73856093) | 0) ^ ((y * 19349663) | 0);

    const large = this.radius >= 300 ? 0.30 : this.radius >= 120 ? 0.22 : 0.14;
    const modeMul = this.mode === 'push' || this.mode === 'edge' ? 1 : 0.82;
    this.spacing = Math.max(2, this.radius * large * modeMul);
    this.gap = this.mode === 'push' ? this.spacing : 0;
    this.lastX = x; this.lastY = y; this.lastP = p; this.lastT = t;
    this.dabX = x; this.dabY = y;
    this.velX = 0; this.velY = 0;
    this.active = true;
    this.ending = false;
    this.finished = false;
    this.changed = false;

    /** @type {{x:number,y:number,dx:number,dy:number,p:number,mode:string,seed:number}[]} */
    this.dabs = [];
    this.dabRead = 0;
    /** @type {ReturnType<LiquifyBrushSession['_makeJob']>|null} */
    this.job = null;
    /** @type {Map<number, {cx:number, cy:number, data: Uint8ClampedArray<ArrayBuffer>|null}>} */
    this.before = new Map();
    this.tmp = [0, 0, 0, 0];
    this.tmp2 = [0, 0, 0, 0];

    app.undoMgr.captureBegin(layer.id);
    if (this.mode !== 'push') this._enqueue(x, y, 0, 0, p, this.mode);
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  move(x, y, p, t) {
    if (!this.active || this.ending) return;
    const dx = x - this.lastX, dy = y - this.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) {
      this.lastX = x; this.lastY = y; this.lastP = p; this.lastT = t;
      return;
    }
    const dt = Math.max(1, t - this.lastT);
    this.velX = dx / dt * 16.67;
    this.velY = dy / dt * 16.67;

    let travelled = 0;
    while (this.gap <= dist - travelled) {
      travelled += this.gap;
      const k = travelled / dist;
      const px = lerp(this.lastX, x, k);
      const py = lerp(this.lastY, y, k);
      const pp = lerp(this.lastP, p, k);
      this._enqueue(px, py, px - this.dabX, py - this.dabY, pp, this.mode);
      this.dabX = px; this.dabY = py;
      this.gap = this.spacing;
    }
    this.gap -= dist - travelled;
    this.lastX = x; this.lastY = y; this.lastP = p; this.lastT = t;
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  end(x, y, p, t) {
    if (!this.active || this.ending) return;
    this.move(x, y, p, t);
    if (this.mode !== 'push' && Math.hypot(x - this.dabX, y - this.dabY) > this.spacing * 0.25) {
      this._enqueue(x, y, x - this.dabX, y - this.dabY, p, this.mode);
    }
    this._enqueueMomentum();
    this.ending = true;
  }

  cancel() {
    if (!this.active && this.finished) return;
    this.active = false;
    this.ending = true;
    this.dabs.length = 0;
    this.job = null;
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
    this._markLayerDirty();
    this.finished = true;
  }

  /** @param {number} maxMs */
  process(maxMs) {
    if (this.finished) return true;
    const unlimited = maxMs === Infinity;
    const t0 = performance.now();
    while (this.job || this.dabRead < this.dabs.length) {
      if (!this.job) {
        const dab = this.dabs[this.dabRead++];
        this.job = this._makeJob(dab);
        if (!this.job) continue;
      }
      this._processJobChunk(this.job);
      if (this.job.chunkIndex >= this.job.chunks.length) this.job = null;
      if (!unlimited && performance.now() - t0 >= maxMs) break;
    }
    if (this.dabRead > 64 && this.dabRead === this.dabs.length) {
      this.dabs.length = 0;
      this.dabRead = 0;
    }
    if (this.ending && !this.job && this.dabRead >= this.dabs.length) {
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
    this._markLayerDirty();
  }

  _markLayerDirty() {
    if (!this.changed) return;
    this.layer.thumbDirty = true;
    this.app.ui.layersUI.scheduleThumbs();
  }

  /** @param {number} x @param {number} y @param {number} dx @param {number} dy @param {number} p @param {string} mode */
  _enqueue(x, y, dx, dy, p, mode) {
    const strength = this.pressure * clamp(p || 1, 0, 1);
    if (strength <= 0.001) return;
    this._enqueueRepeated(x, y, dx, dy, strength, mode);
    if (this.mirrorX !== null) {
      const mx = this.mirrorX * 2 - x;
      if (Math.abs(mx - x) > 0.01) {
        this._enqueueRepeated(mx, y, -dx, dy, strength, mode);
      }
    }
  }

  /** @param {number} x @param {number} y @param {number} dx @param {number} dy @param {number} strength @param {string} mode */
  _enqueueRepeated(x, y, dx, dy, strength, mode) {
    const tile = this.patternTile;
    if (!tile || tile.w <= 0 || tile.h <= 0) {
      this.dabs.push({ x, y, dx, dy, p: strength, mode, seed: this.seed + this.dabs.length * 1013 });
      return;
    }
    for (const ox of [-tile.w, 0, tile.w]) {
      for (const oy of [-tile.h, 0, tile.h]) {
        const px = x + ox, py = y + oy;
        if (px + this.radius < tile.x || py + this.radius < tile.y ||
          px - this.radius > tile.x + tile.w - 1 || py - this.radius > tile.y + tile.h - 1) continue;
        this.dabs.push({ x: px, y: py, dx, dy, p: strength, mode, seed: this.seed + this.dabs.length * 1013 });
      }
    }
  }

  _enqueueMomentum() {
    if (this.momentum <= 0.001) return;
    const speed = Math.hypot(this.velX, this.velY);
    if (speed < 0.05) return;
    const steps = Math.round(2 + this.momentum * 8);
    let x = this.lastX, y = this.lastY;
    let vx = this.velX * this.momentum * 0.72;
    let vy = this.velY * this.momentum * 0.72;
    for (let i = 0; i < steps; i++) {
      const decay = Math.pow(1 - i / steps, 1.5);
      if (this.mode === 'push') {
        x += vx * decay;
        y += vy * decay;
      }
      this._enqueue(x, y, vx * decay, vy * decay, this.lastP * decay, this.mode);
      vx *= 0.72;
      vy *= 0.72;
    }
  }

  /** @param {{x:number,y:number,dx:number,dy:number,p:number,mode:string,seed:number}} dab */
  _makeJob(dab) {
    const r = this.radius;
    const pushPad = Math.ceil(Math.min(r * 0.9, Math.hypot(dab.dx, dab.dy) * 1.4 + r * 0.35));
    const pad = dab.mode === 'reconstruct' ? 1 : pushPad + 3;
    const x0 = Math.max(Math.floor(dab.x - r), this.clip.x0);
    const y0 = Math.max(Math.floor(dab.y - r), this.clip.y0);
    const x1 = Math.min(Math.ceil(dab.x + r), this.clip.x1);
    const y1 = Math.min(Math.ceil(dab.y + r), this.clip.y1);
    if (x0 > x1 || y0 > y1) return null;

    const sx = Math.max(x0 - pad, this.clip.x0);
    const sy = Math.max(y0 - pad, this.clip.y0);
    const sw = Math.min(x1 + pad, this.clip.x1) - sx + 1;
    const sh = Math.min(y1 + pad, this.clip.y1) - sy + 1;
    if (dab.mode !== 'reconstruct' && !this._contentBounds(sx, sy, sw, sh)) return null;

    const chunks = [];
    for (let cy = y0 >> CHUNK_SHIFT; cy <= y1 >> CHUNK_SHIFT; cy++) {
      for (let cx = x0 >> CHUNK_SHIFT; cx <= x1 >> CHUNK_SHIFT; cx++) chunks.push({ cx, cy });
    }
    return {
      x0, y0, x1, y1, sx, sy, sw, sh,
      src: dab.mode === 'reconstruct' ? null : this._snapshot(sx, sy, sw, sh),
      dab,
      chunks,
      chunkIndex: 0,
    };
  }

  /** @param {NonNullable<ReturnType<LiquifyBrushSession['_makeJob']>>} job */
  _processJobChunk(job) {
    const { dab } = job;
    const item = job.chunks[job.chunkIndex++];
    const key = chunkKey(item.cx, item.cy);
    const ox = item.cx << CHUNK_SHIFT, oy = item.cy << CHUNK_SHIFT;
    const lx0 = Math.max(0, job.x0 - ox), ly0 = Math.max(0, job.y0 - oy);
    const lx1 = Math.min(CHUNK - 1, job.x1 - ox), ly1 = Math.min(CHUNK - 1, job.y1 - oy);
    let chunk = this.store.getByKey(key);
    let wrote = false;
    let dx0 = CHUNK, dy0 = CHUNK, dx1 = -1, dy1 = -1;

    for (let ly = ly0; ly <= ly1; ly++) {
      const wy = oy + ly;
      let di = ((ly << CHUNK_SHIFT) + lx0) * 4;
      for (let lx = lx0; lx <= lx1; lx++, di += 4) {
        const wx = ox + lx;
        const mask = this._maskAt(wx, wy, dab.x, dab.y) * dab.p;
        if (mask <= 0.0001) continue;

        const out = dab.mode === 'reconstruct'
          ? this._reconstructPixel(wx, wy, chunk, di, mask, this.tmp)
          : this._liquifyPixel(job, wx, wy, mask, this.tmp);
        if (out[3] < 0.5) {
          out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
        } else {
          if (out[0] > out[3]) out[0] = out[3];
          if (out[1] > out[3]) out[1] = out[3];
          if (out[2] > out[3]) out[2] = out[3];
        }

        const cr = chunk ? chunk.data[di] : 0;
        const cg = chunk ? chunk.data[di + 1] : 0;
        const cb = chunk ? chunk.data[di + 2] : 0;
        const ca = chunk ? chunk.data[di + 3] : 0;
        if (out[0] === cr && out[1] === cg && out[2] === cb && out[3] === ca) continue;

        if (!wrote) {
          this._capture(key, item.cx, item.cy, chunk || null);
          if (!chunk) chunk = this.store.getOrCreate(item.cx, item.cy);
          wrote = true;
        }
        chunk.data[di] = out[0];
        chunk.data[di + 1] = out[1];
        chunk.data[di + 2] = out[2];
        chunk.data[di + 3] = out[3];
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

  /**
   * @param {NonNullable<ReturnType<LiquifyBrushSession['_makeJob']>>} job
   * @param {number} wx @param {number} wy @param {number} mask @param {number[]} out
   */
  _liquifyPixel(job, wx, wy, mask, out) {
    const d = job.dab;
    let sx = wx + 0.5;
    let sy = wy + 0.5;
    const vx = sx - d.x;
    const vy = sy - d.y;
    const r = this.radius;
    const mode = d.mode;
    const chaos = this.distortion;

    if (mode === 'push') {
      let dx = d.dx, dy = d.dy;
      const len = Math.hypot(dx, dy);
      if (len > r * 0.65) {
        const k = r * 0.65 / len;
        dx *= k; dy *= k;
      }
      if (chaos > 0.001) {
        const n = hash2(Math.floor(wx / 14), Math.floor(wy / 14), d.seed) * 2 - 1;
        const px = -dy, py = dx;
        const pl = Math.hypot(px, py) || 1;
        const wob = n * chaos * r * 0.08 * mask;
        dx += px / pl * wob;
        dy += py / pl * wob;
      }
      sx -= dx * (0.9 + chaos * 0.25) * mask;
      sy -= dy * (0.9 + chaos * 0.25) * mask;
    } else if (mode === 'twirlR' || mode === 'twirlL') {
      const sign = mode === 'twirlR' ? 1 : -1;
      const dist = Math.hypot(vx, vy);
      const extra = chaos * (hash2(Math.floor(wx / 18), Math.floor(wy / 18), d.seed) - 0.5);
      const a = -sign * (0.78 + chaos * 0.72) * mask * (1 + extra);
      const ca = Math.cos(a), sa = Math.sin(a);
      sx = d.x + vx * ca - vy * sa;
      sy = d.y + vx * sa + vy * ca;
      if (dist < 1) { sx = wx + 0.5; sy = wy + 0.5; }
    } else if (mode === 'pinch' || mode === 'expand') {
      const sign = mode === 'pinch' ? 1 : -1;
      const k = 1 + sign * (0.46 + chaos * 0.24) * mask;
      sx = d.x + vx * k;
      sy = d.y + vy * k;
    } else if (mode === 'crystals') {
      const ang = Math.atan2(vy, vx);
      const sectors = Math.max(7, Math.round(10 + chaos * 18));
      const q = Math.round(ang / TWO_PI * sectors);
      const qa = q / sectors * TWO_PI;
      const n = hash2(q, Math.floor(Math.hypot(vx, vy) / Math.max(6, r * 0.13)), d.seed);
      const jag = (0.34 + chaos * 0.38) * r * mask * (0.45 + n);
      sx -= Math.cos(qa) * jag;
      sy -= Math.sin(qa) * jag;
    } else if (mode === 'edge') {
      let ux = d.dx, uy = d.dy;
      let ul = Math.hypot(ux, uy);
      if (ul < 0.01) { ux = 1; uy = 0; ul = 1; }
      ux /= ul; uy /= ul;
      const nx = -uy, ny = ux;
      const side = vx * nx + vy * ny;
      const pull = Math.sign(side || 1) * (0.54 + chaos * 0.16) * r * mask * smooth01(Math.abs(side) / Math.max(1, r));
      sx += nx * pull;
      sy += ny * pull;
    }

    return sampleBilinear(job.src || new Uint8ClampedArray(0), job.sw, job.sh,
      sx - job.sx - 0.5, sy - job.sy - 0.5, out);
  }

  /** @param {number} wx @param {number} wy @param {Chunk|null|undefined} chunk @param {number} di @param {number} mask @param {number[]} out */
  _reconstructPixel(wx, wy, chunk, di, mask, out) {
    const cr = chunk ? chunk.data[di] : 0;
    const cg = chunk ? chunk.data[di + 1] : 0;
    const cb = chunk ? chunk.data[di + 2] : 0;
    const ca = chunk ? chunk.data[di + 3] : 0;
    const cur = this.tmp2;
    cur[0] = cr; cur[1] = cg; cur[2] = cb; cur[3] = ca;
    const base = this.app.liquifyBasePixel(this.layer.id, wx, wy, cur, out);
    out[0] = i255(cr + (base[0] - cr) * mask);
    out[1] = i255(cg + (base[1] - cg) * mask);
    out[2] = i255(cb + (base[2] - cb) * mask);
    out[3] = i255(ca + (base[3] - ca) * mask);
    return out;
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h */
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

  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  _contentBounds(x, y, w, h) {
    let hit = false;
    forEachChunkInRect(this.store, x, y, x + w - 1, y + h - 1, false,
      (chunk, lx0, ly0, lx1, ly1) => {
        if (hit) return;
        const data = chunk.data;
        for (let ly = ly0; ly <= ly1; ly++) {
          let i = ((ly << CHUNK_SHIFT) + lx0) * 4 + 3;
          for (let lx = lx0; lx <= lx1; lx++, i += 4) {
            if (data[i] !== 0) { hit = true; return; }
          }
        }
      });
    return hit;
  }

  /** @param {number} wx @param {number} wy @param {number} cx @param {number} cy */
  _maskAt(wx, wy, cx, cy) {
    const sel = this.selMask;
    let sm = 1;
    if (sel) {
      const mx = wx - sel.x, my = wy - sel.y;
      if (mx < 0 || my < 0 || mx >= sel.w || my >= sel.h) return 0;
      sm = sel.mask[my * sel.w + mx] / 255;
      if (sm <= 0) return 0;
    }
    return sm * falloff(Math.hypot(wx + 0.5 - cx, wy + 0.5 - cy), this.radius, 0.18);
  }

  /** @param {number} key @param {number} cx @param {number} cy @param {Chunk|null} chunk */
  _capture(key, cx, cy, chunk) {
    if (this.before.has(key)) return;
    this.app.liquifyRememberChunk(this.layer.id, key, cx, cy, chunk);
    this.before.set(key, {
      cx, cy,
      data: chunk ? chunk.data.slice() : null,
    });
    this.app.undoMgr.captureChunk(key, cx, cy, chunk ? chunk.data : null);
  }
}
