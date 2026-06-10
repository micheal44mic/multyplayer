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
  /**
   * @param {ChunkStore} strokeStore @param {StampCache} stampCache
   * @param {import('./wasm_core.js').WasmHeap|null} [heap]
   */
  constructor(strokeStore, stampCache, heap = null) {
    this.store = strokeStore;
    this.cache = stampCache;
    this.heap = heap; // core SIMD: stessi identici output del path JS
    /** @type {Snap|null} */
    this.snap = null;
    // stats per HUD
    this.lastPx = 0;
    this.lastDabs = 0;
    // LUT riusate (zero allocazioni per dab):
    // _maLut[m] = div255(m * a255)  — alpha del dab applicata alla maschera
    // _lutR/G/B[ma] = div255(c * ma) — colore premultiplied per ogni alpha
    this._maLut = new Uint8Array(256);
    this._lutA = -1;        // a255 per cui _maLut è valida
    this._lutR = new Uint8Array(256);
    this._lutG = new Uint8Array(256);
    this._lutB = new Uint8Array(256);
    this._lutColorKey = -1; // (cr<<16)|(cg<<8)|cb per cui le LUT colore sono valide
  }

  /** @param {Snap|null} snap */
  beginStroke(snap) {
    this.snap = snap;
    this._lutA = -1;
    this._lutColorKey = -1;
  }

  // Stessa identica aritmetica dei loop per-pixel, fattorizzata in tabelle:
  // 256 voci battono qualunque dab più grande di ~16x16.
  /** @param {number} a255 */
  _ensureMaLut(a255) {
    if (a255 === this._lutA) return;
    const L = this._maLut;
    if (a255 === 255) { for (let i = 0; i < 256; i++) L[i] = i; }
    else { for (let i = 0; i < 256; i++) L[i] = div255(i * a255); }
    this._lutA = a255;
  }

  /** @param {number} cr @param {number} cg @param {number} cb */
  _ensureColorLut(cr, cg, cb) {
    const key = (cr << 16) | (cg << 8) | cb;
    if (key === this._lutColorKey) return;
    const R = this._lutR, G = this._lutG, B = this._lutB;
    for (let i = 0; i < 256; i++) {
      R[i] = div255(cr * i);
      G[i] = div255(cg * i);
      B[i] = div255(cb * i);
    }
    this._lutColorKey = key;
  }

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

    if (this.heap) {
      const ex = this.heap.exports;
      const maskPtr = stamp.ptr;
      const bu = buildup ? 1 : 0;
      forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          store.markDirty(chunk, lx0, ly0, lx1, ly1);
          const wrote = ex.dab(chunk.ptr, lx0, ly0, lx1, ly1, maskPtr, sSize,
            lx0 + ox - ix, ly0 + oy - iy, a255, cr, cg, cb, bu);
          if (wrote) chunk.touched = true;
        });
      return;
    }

    // Le LUT convengono se sono già valide (alpha/colore stabili nel tratto)
    // o se il dab è grande abbastanza da ammortizzare le ~1280 op di rebuild
    // (jitter colore/opacità le invalida a ogni dab; i pixel scritti sono ben
    // meno dell'area del quadrato, quindi la soglia è prudente).
    const useLut = (this._lutA === a255 && this._lutColorKey === ((cr << 16) | (cg << 8) | cb)) ||
      sSize * sSize >= 4096;
    if (useLut) {
      this._ensureMaLut(a255);
      this._ensureColorLut(cr, cg, cb);
    }
    const maLut = this._maLut;
    const lutR = this._lutR, lutG = this._lutG, lutB = this._lutB;

    forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          let mi = (y2 + oy - iy) * sSize + (lx0 + ox - ix);
          if (useLut) {
            for (let x2 = lx0; x2 <= lx1; x2++, di += 4, mi++) {
              const ma = maLut[mask[mi]];
              if (ma === 0) continue;
              if (buildup) {
                const inv = 255 - ma;
                d[di] = lutR[ma] + div255(d[di] * inv);
                d[di + 1] = lutG[ma] + div255(d[di + 1] * inv);
                d[di + 2] = lutB[ma] + div255(d[di + 2] * inv);
                d[di + 3] = ma + div255(d[di + 3] * inv);
              } else if (ma > d[di + 3]) {
                // wash: max(alpha) — i dab non si scuriscono tra loro
                d[di] = lutR[ma];
                d[di + 1] = lutG[ma];
                d[di + 2] = lutB[ma];
                d[di + 3] = ma;
              }
              wrote = true;
            }
          } else {
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
                d[di] = div255(cr * ma);
                d[di + 1] = div255(cg * ma);
                d[di + 2] = div255(cb * ma);
                d[di + 3] = ma;
              }
              wrote = true;
            }
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

    if (this.heap) {
      const ex = this.heap.exports;
      forEachChunkInRect(store, bx0, by0, bx1, by1, true,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          store.markDirty(chunk, lx0, ly0, lx1, ly1);
          const wrote = ex.capsule(chunk.ptr, lx0, ly0, lx1, ly1, ox, oy,
            x0, y0, r0, a0, x1, y1, r1, a1, h, cr, cg, cb);
          if (wrote) chunk.touched = true;
        });
      return;
    }

    this._ensureColorLut(cr, cg, cb);
    const lutR = this._lutR, lutG = this._lutG, lutB = this._lutB;

    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const invLen2 = len2 > 0 ? 1 / len2 : 0;
    const dr = r1 - r0, da = a1 - a0;
    // Bound esatto per riga: dist >= distanza riga->segmento e falloff
    // monotono danno ma <= maMaxRow. Nei tratti a spacing basso i segmenti si
    // sovrappongono quasi del tutto: i pixel già saturi vengono saltati prima
    // di proiezione e sqrt senza cambiare l'output; le righe con bound 0
    // (il bbox è quadrato, la capsula no) si saltano intere.
    const aMax = Math.max(a0, a1);
    const rMax = Math.max(r0, r1);
    const yLo = Math.min(y0, y1), yHi = Math.max(y0, y1);

    forEachChunkInRect(store, bx0, by0, bx1, by1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          const py = oy + y2 + 0.5;
          const rowDist = py < yLo ? yLo - py : py > yHi ? py - yHi : 0;
          const maMaxRow = (falloff(rowDist, rMax, h) * aMax * 255 + 0.5) | 0;
          if (maMaxRow === 0) continue;
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4) {
            if (d[di + 3] >= maMaxRow) continue;
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
              d[di] = lutR[ma];
              d[di + 1] = lutG[ma];
              d[di + 2] = lutB[ma];
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
 * @param {import('./wasm_core.js').WasmHeap|null} [heap]
 */
export function commitChunk(docStore, sc, snap, undoCapture, heap = null) {
  const op255 = Math.round((snap ? snap.globalOpacity : 1) * 255);
  const eraser = snap ? snap.eraser : false;

  const existing = docStore.getByKey(sc.key);
  if (eraser && !existing) return; // niente da cancellare
  if (undoCapture) undoCapture(sc.key, sc.cx, sc.cy, existing ? existing.data : null);
  const doc = existing || docStore.getOrCreate(sc.cx, sc.cy);

  if (heap) {
    heap.exports.commit(doc.ptr, sc.ptr, op255, eraser ? 1 : 0);
    docStore.markDirty(doc);
    return;
  }

  const s = sc.data, d = doc.data;
  // Viste u32 per saltare in fretta i pixel vuoti (premultiplied: parola 0 =
  // pixel non toccato) e copiare in blocco quelli opachi. byteOffset esplicito:
  // il buffer sottostante può essere la memoria lineare wasm.
  const su = new Uint32Array(s.buffer, s.byteOffset, s.length >> 2);
  const du = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
  const full = op255 === 255;

  if (eraser) {
    for (let i = 0, o = 0; i < su.length; i++, o += 4) {
      if (su[i] === 0) continue;
      const sa = full ? s[o + 3] : div255(s[o + 3] * op255);
      if (sa === 0) continue;
      if (sa === 255) { du[i] = 0; continue; } // gomma piena: azzera la parola
      const inv = 255 - sa;
      d[o] = div255(d[o] * inv);
      d[o + 1] = div255(d[o + 1] * inv);
      d[o + 2] = div255(d[o + 2] * inv);
      d[o + 3] = div255(d[o + 3] * inv);
    }
  } else if (full) {
    // opacità 1: div255(x*255) = x, quindi niente moltiplicazioni sulla sorgente
    for (let i = 0, o = 0; i < su.length; i++, o += 4) {
      const v = su[i];
      if (v === 0) continue;
      const sa = s[o + 3];
      if (sa === 0) continue;
      if (sa === 255) { du[i] = v; continue; } // sorgente opaca: copia la parola
      const inv = 255 - sa;
      d[o] = s[o] + div255(d[o] * inv);
      d[o + 1] = s[o + 1] + div255(d[o + 1] * inv);
      d[o + 2] = s[o + 2] + div255(d[o + 2] * inv);
      d[o + 3] = sa + div255(d[o + 3] * inv);
    }
  } else {
    for (let i = 0, o = 0; i < su.length; i++, o += 4) {
      if (su[i] === 0) continue;
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
