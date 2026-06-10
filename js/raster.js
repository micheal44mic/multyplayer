// RASTERIZER A DUE VIE + BUDGET.
// - via continua: catena di capsule per segmento (lavoro ∝ area, non al n. di stamp)
// - via discreta: stamp dalla StampCache
// Tutto scrive nello stroke buffer (chunk sparsi premultiplied), mai sul layer.
// Il budget limita i pixel toccati per frame: l'eccedenza resta in coda (catch-up).

import { div255 } from './util.js';
import { falloff } from './brush.js';
import { CHUNK, CHUNK_SHIFT, forEachChunkInRect } from './store.js';
import { T_DAB } from './stroke.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./stroke.js').Snap} Snap */
/** @typedef {import('./stroke.js').DabQueue} DabQueue */
/** @typedef {import('./brush.js').StampCache} StampCache */

export class Rasterizer {
  /** @param {ChunkStore} strokeStore @param {StampCache} stampCache */
  constructor(strokeStore, stampCache) {
    this.store = strokeStore;
    this.cache = stampCache;
    /** @type {Snap|null} */
    this.snap = null;
    // stats per HUD
    this.lastPx = 0;
    this.lastDabs = 0;
  }

  /** @param {Snap|null} snap */
  beginStroke(snap) { this.snap = snap; }

  // Drena la coda fino a esaurimento o budget (px toccati). Ritorna px usati.
  /** @param {DabQueue} queue @param {number} budgetPx */
  run(queue, budgetPx) {
    const snap = this.snap;
    this.lastPx = 0;
    this.lastDabs = 0;
    if (!snap) { queue.clear(); return 0; }

    let used = 0;
    const buf = () => queue.buf; // il buffer può cambiare se la coda cresce

    while (queue.count > 0) {
      const q = buf();
      const o = queue.peekOffset();
      const type = q[o];

      let cost;
      if (type === T_DAB) {
        const r = q[o + 3];
        const d = (Math.ceil(r) + 1) * 2;
        cost = d * d;
      } else {
        const maxR = Math.max(q[o + 3], q[o + 7]) + 1;
        const w = Math.abs(q[o + 5] - q[o + 1]) + maxR * 2;
        const h = Math.abs(q[o + 6] - q[o + 2]) + maxR * 2;
        cost = w * h;
      }
      // almeno una entry per frame per garantire progresso
      if (used > 0 && used + cost > budgetPx) break;

      if (type === T_DAB) {
        this._dab(q[o + 1], q[o + 2], q[o + 3], q[o + 4], q[o + 5], q[o + 6], q[o + 7], q[o + 8]);
      } else {
        this._capsule(q[o + 1], q[o + 2], q[o + 3], q[o + 4], q[o + 5], q[o + 6], q[o + 7], q[o + 8]);
      }
      queue.pop();
      used += cost;
      this.lastDabs++;
    }
    this.lastPx = used;
    return used;
  }

  // ---- via discreta: stamp dalla cache ----
  /**
   * @param {number} x @param {number} y @param {number} r @param {number} alpha
   * @param {number} angle @param {number} cr @param {number} cg @param {number} cb
   */
  _dab(x, y, r, alpha, angle, cr, cg, cb) {
    const snap = this.snap;
    const stamp = this.cache.getStamp(r, snap.hardness, snap.roundness, angle);
    const sSize = stamp.size;
    const ix = Math.round(x - stamp.half);
    const iy = Math.round(y - stamp.half);
    const a255 = Math.min(255, (alpha * 255 + 0.5) | 0);
    if (a255 === 0) return;
    const mask = stamp.mask;
    const buildup = snap.buildup;
    const store = this.store;

    forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          let mi = (y2 + oy - iy) * sSize + (lx0 + ox - ix);
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4, mi++) {
            const m = mask[mi];
            if (m === 0) continue;
            const ma = div255(m * a255);
            if (ma === 0) continue;
            if (buildup) {
              const inv = 255 - ma;
              d[di] = div255(cr * ma) + div255(d[di] * inv);
              d[di + 1] = div255(cg * ma) + div255(d[di + 1] * inv);
              d[di + 2] = div255(cb * ma) + div255(d[di + 2] * inv);
              d[di + 3] = ma + div255(d[di + 3] * inv);
            } else if (ma > d[di + 3]) {
              // wash: max(alpha) — i dab non si scuriscono tra loro
              d[di] = div255(cr * ma);
              d[di + 1] = div255(cg * ma);
              d[di + 2] = div255(cb * ma);
              d[di + 3] = ma;
            }
            wrote = true;
          }
        }
        if (wrote) chunk.touched = true;
      });
  }

  // ---- via continua: capsula con raggio e alpha interpolati ----
  /**
   * @param {number} x0 @param {number} y0 @param {number} r0 @param {number} a0
   * @param {number} x1 @param {number} y1 @param {number} r1 @param {number} a1
   */
  _capsule(x0, y0, r0, a0, x1, y1, r1, a1) {
    const snap = this.snap;
    const h = snap.hardness;
    const cr = snap.colR, cg = snap.colG, cb = snap.colB;
    const store = this.store;

    const maxR = Math.max(r0, r1) + 1;
    const bx0 = Math.floor(Math.min(x0, x1) - maxR);
    const by0 = Math.floor(Math.min(y0, y1) - maxR);
    const bx1 = Math.ceil(Math.max(x0, x1) + maxR);
    const by1 = Math.ceil(Math.max(y0, y1) + maxR);

    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const invLen2 = len2 > 0 ? 1 / len2 : 0;
    const dr = r1 - r0, da = a1 - a0;

    forEachChunkInRect(store, bx0, by0, bx1, by1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          const py = oy + y2 + 0.5;
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4) {
            const px = ox + x2 + 0.5;
            let t = ((px - x0) * dx + (py - y0) * dy) * invLen2;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const qx = px - (x0 + dx * t);
            const qy = py - (y0 + dy * t);
            const rT = r0 + dr * t;
            const dist2 = qx * qx + qy * qy;
            const lim = rT + 1;
            if (dist2 >= lim * lim) continue;
            const a = falloff(Math.sqrt(dist2), rT, h) * (a0 + da * t);
            if (a <= 0) continue;
            const ma = (a * 255 + 0.5) | 0;
            if (ma > d[di + 3]) {
              d[di] = div255(cr * ma);
              d[di + 1] = div255(cg * ma);
              d[di + 2] = div255(cb * ma);
              d[di + 3] = ma;
              wrote = true;
            }
          }
        }
        if (wrote) chunk.touched = true;
      });
  }
}

// Composita UN chunk dello stroke buffer sul layer documento.
// undoCapture(key, cx, cy, beforeDataOrNull) viene chiamato PRIMA di modificare.
/**
 * @param {ChunkStore} docStore
 * @param {Chunk} sc
 * @param {Snap|null} snap
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray<ArrayBuffer>|null) => void} [undoCapture]
 */
export function commitChunk(docStore, sc, snap, undoCapture) {
  const op255 = Math.round((snap ? snap.globalOpacity : 1) * 255);
  const eraser = snap ? snap.eraser : false;

  const existing = docStore.getByKey(sc.key);
  if (eraser && !existing) return; // niente da cancellare
  if (undoCapture) undoCapture(sc.key, sc.cx, sc.cy, existing ? existing.data : null);
  const doc = existing || docStore.getOrCreate(sc.cx, sc.cy);
  const s = sc.data, d = doc.data;

  if (eraser) {
    for (let o = 0; o < s.length; o += 4) {
      const sa = div255(s[o + 3] * op255);
      if (sa === 0) continue;
      const inv = 255 - sa;
      d[o] = div255(d[o] * inv);
      d[o + 1] = div255(d[o + 1] * inv);
      d[o + 2] = div255(d[o + 2] * inv);
      d[o + 3] = div255(d[o + 3] * inv);
    }
  } else {
    for (let o = 0; o < s.length; o += 4) {
      const sa = div255(s[o + 3] * op255);
      if (sa === 0) continue;
      const inv = 255 - sa;
      d[o] = div255(s[o] * op255) + div255(d[o] * inv);
      d[o + 1] = div255(s[o + 1] * op255) + div255(d[o + 1] * inv);
      d[o + 2] = div255(s[o + 2] * op255) + div255(d[o + 2] * inv);
      d[o + 3] = sa + div255(d[o + 3] * inv);
    }
  }
  docStore.markDirty(doc);
}
