// FLOOD FILL (ColorDrop) — riempimento a goccia alla Procreate.
// Una sessione = un seed su un board: fotografa UN solo livello — quello
// marcato come Riferimento nel pannello (alla Procreate) o, in mancanza,
// il livello attivo stesso; gli altri livelli sopra e sotto non fanno mai
// da bordo. Flood scanline 4-connesso con soglia sul colore straight,
// maschera dilatata di 1 px quando si riempie il vuoto (si infila sotto
// l'antialias delle linee, niente aloni) e ammorbidita con un tent 3×3,
// poi scrive il colore sul livello attivo in premultiplied source-over.
// La sessione resta viva finché il dito è giù: cambiare soglia ripristina
// i chunk "prima" e riesegue il fill dalla STESSA sorgente fotografata
// all'inizio (zero ricompositi durante la regolazione). commit() produce
// UNA entry di undo tile-diff (stesso formato degli stroke); cancel()
// ripristina tutto e non lascia traccia.

import { CHUNK, CHUNK_SHIFT, chunkKey, forEachChunkInRect } from './store.js';
import { div255 } from './util.js';
import { drawTextDocument } from './text_layer.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./layers.js').Layer} Layer */

// 255/a per l'unpremultiply senza divisioni nel loop (indice 0 inutilizzato)
const INV = new Float64Array(256);
for (let a = 1; a < 256; a++) INV[a] = 255 / a;

// Fotografia premultiplied board-locale di UN livello (bw*bh*4): è la
// sorgente su cui il flood misura i bordi. Contenuto puro: visibilità e
// opacità del livello non contano (un riferimento semitrasparente fa da
// bordo identico). I livelli testo passano dallo stesso path dell'export
// (drawTextDocument) così il fill si ferma sui contorni delle lettere.
/** @param {Board} board @param {Layer} layer @returns {Uint8ClampedArray} */
function buildSource(board, layer) {
  const bw = board.w, bh = board.h;
  const out = new Uint8ClampedArray(bw * bh * 4);
  if (layer.kind === 'raster') {
    forEachChunkInRect(layer.store, board.x, board.y,
      board.x + bw - 1, board.y + bh - 1, false,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const s = chunk.data;
        const mox = ox - board.x, moy = oy - board.y;
        const len = (lx1 - lx0 + 1) * 4;
        for (let ly = ly0; ly <= ly1; ly++) {
          const so = ((ly << CHUNK_SHIFT) + lx0) * 4;
          const oo = ((moy + ly) * bw + mox + lx0) * 4;
          out.set(s.subarray(so, so + len), oo);
        }
      });
  } else if (layer.kind === 'text') {
    // testo come bordo: stessa resa dell'export, straight -> premul
    try {
      const cnv = document.createElement('canvas');
      cnv.width = bw; cnv.height = bh;
      const ctx = cnv.getContext('2d', { willReadFrequently: true });
      drawTextDocument(ctx, layer.item, layer.style, board.x, board.y, 1);
      const img = ctx.getImageData(0, 0, bw, bh).data;
      for (let i = 0, o = 0; i < bw * bh; i++, o += 4) {
        const sa = img[o + 3];
        if (sa === 0) continue;
        out[o] = div255(img[o] * sa);
        out[o + 1] = div255(img[o + 1] * sa);
        out[o + 2] = div255(img[o + 2] * sa);
        out[o + 3] = sa;
      }
    } catch { /* font/canvas indisponibili: il testo non fa da bordo */ }
  }
  return out;
}

/**
 * Flood scanline 4-connesso dal seed board-locale (sx, sy) sul composito
 * premultiplied. thr 0..255: seed (quasi) trasparente (a0 <= thr) = si
 * riempie il vuoto delimitato da pixel più opachi della soglia; seed su
 * colore = si riempie la regione di colore straight simile (per canale,
 * alpha compresa — semantica di selection.js, ma contigua).
 * @param {Uint8ClampedArray} src @param {number} bw @param {number} bh
 * @param {number} sx @param {number} sy @param {number} thr
 * @returns {{mask: Uint8Array, b: {x0:number,y0:number,x1:number,y1:number}, clear: boolean}}
 */
function floodMask(src, bw, bh, sx, sy, thr) {
  const mask = new Uint8Array(bw * bh);
  const so = (sy * bw + sx) * 4;
  const a0 = src[so + 3];
  const clear = a0 <= thr;
  const k0 = a0 > 0 ? INV[a0] : 0;
  const r0 = src[so] * k0, g0 = src[so + 1] * k0, b0 = src[so + 2] * k0;

  /** @type {(i: number) => boolean} */
  const match = clear
    ? (i) => src[i * 4 + 3] <= thr
    : (i) => {
      const o = i * 4, a = src[o + 3];
      let d = a - a0; if (d < 0) d = -d;
      if (d > thr || a === 0) return false;
      const k = INV[a];
      d = src[o] * k - r0; if (d < 0) d = -d;
      if (d > thr) return false;
      d = src[o + 1] * k - g0; if (d < 0) d = -d;
      if (d > thr) return false;
      d = src[o + 2] * k - b0; if (d < 0) d = -d;
      return d <= thr;
    };

  let x0 = sx, y0 = sy, x1 = sx, y1 = sy;
  /** @type {number[]} coppie (x, y) */
  const stack = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop(), x = stack.pop();
    const row = y * bw;
    if (mask[row + x] !== 0 || !match(row + x)) continue;
    let lx = x;
    while (lx > 0 && mask[row + lx - 1] === 0 && match(row + lx - 1)) lx--;
    let rx = x;
    while (rx < bw - 1 && mask[row + rx + 1] === 0 && match(row + rx + 1)) rx++;
    mask.fill(255, row + lx, row + rx + 1);
    if (lx < x0) x0 = lx;
    if (rx > x1) x1 = rx;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (let dy = -1; dy <= 1; dy += 2) {
      const ny = y + dy;
      if (ny < 0 || ny >= bh) continue;
      const nrow = ny * bw;
      let inRun = false;
      for (let xx = lx; xx <= rx; xx++) {
        const ok = mask[nrow + xx] === 0 && match(nrow + xx);
        if (ok && !inRun) { stack.push(xx, ny); inRun = true; }
        else if (!ok) inRun = false;
      }
    }
  }
  return { mask, b: { x0, y0, x1, y1 }, clear };
}

/**
 * Maschera 0/255 -> copertura antialiasata 0..255: dilatazione 1 px
 * (solo quando si riempie il vuoto: il colore si infila sotto l'antialias
 * delle linee invece di lasciare un alone chiaro) + tent 3×3 sul bordo.
 * Il campionamento replica i bordi del board: il fill resta pieno fino
 * al margine del canvas. bbox esteso e clampato di conseguenza.
 * @param {Uint8Array} mask @param {number} bw @param {number} bh
 * @param {{x0:number,y0:number,x1:number,y1:number}} b @param {boolean} dilate
 * @returns {{cov: Uint8Array, b: {x0:number,y0:number,x1:number,y1:number}}}
 */
function maskToCoverage(mask, bw, bh, b, dilate) {
  const grow = dilate ? 2 : 1;
  const x0 = Math.max(0, b.x0 - grow), y0 = Math.max(0, b.y0 - grow);
  const x1 = Math.min(bw - 1, b.x1 + grow), y1 = Math.min(bh - 1, b.y1 + grow);
  let base = mask;
  if (dilate) {
    base = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y++) {
      const row = y * bw;
      const up = y > 0 ? row - bw : row, dn = y < bh - 1 ? row + bw : row;
      for (let x = x0; x <= x1; x++) {
        const l = x > 0 ? x - 1 : x, r = x < bw - 1 ? x + 1 : x;
        if (mask[row + x] !== 0 || mask[row + l] !== 0 || mask[row + r] !== 0 ||
          mask[up + x] !== 0 || mask[dn + x] !== 0) base[row + x] = 255;
      }
    }
  }
  const cov = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y++) {
    const row = y * bw;
    const up = y > 0 ? row - bw : row, dn = y < bh - 1 ? row + bw : row;
    for (let x = x0; x <= x1; x++) {
      const c = base[row + x];
      const l = x > 0 ? x - 1 : x, r = x < bw - 1 ? x + 1 : x;
      const sum = 4 * c +
        2 * (base[row + l] + base[row + r] + base[up + x] + base[dn + x]) +
        base[up + l] + base[up + r] + base[dn + l] + base[dn + r];
      if (sum === 0) continue;
      cov[row + x] = sum >> 4; // /16: interno pieno = 255
    }
  }
  return { cov, b: { x0, y0, x1, y1 } };
}

// Stato "prima" di un chunk toccato dalla sessione (copia JS: indipendente
// dal grow della memoria wasm). data = null se il chunk non esisteva.
/** @typedef {{cx: number, cy: number, data: Uint8ClampedArray<ArrayBuffer>|null}} FillBefore */

export class FillSession {
  /**
   * @param {App} app
   * @param {Board} board
   * @param {Layer} layer livello raster di destinazione (paintTarget)
   * @param {number} wx @param {number} wy seed in px mondo (dentro il board)
   * @param {import('./util.js').Rgb} color colore di riempimento (straight)
   */
  constructor(app, board, layer, wx, wy, color) {
    this.app = app;
    this.board = board;
    this.layer = layer;
    this.sx = Math.min(board.w - 1, Math.max(0, Math.floor(wx) - board.x));
    this.sy = Math.min(board.h - 1, Math.max(0, Math.floor(wy) - board.y));
    this.color = { r: color.r, g: color.g, b: color.b };
    /** @type {number} soglia corrente in percento (0..100) */
    this.tolerance = -1;
    // la sorgente è fotografata UNA volta: le regolazioni di soglia
    // ripartono sempre dallo stato originale, mai dal fill già applicato.
    // I bordi vengono dal livello Riferimento (se marcato nel pannello,
    // alla Procreate) o dal livello che si sta riempiendo: mai dagli altri.
    this._src = buildSource(board, board.mgr.referenceLayer || layer);
    /** @type {Map<number, FillBefore>} */
    this._before = new Map();
    this._applied = false;
    this.filledPx = 0;
  }

  // (Ri)esegue il fill alla soglia pct (0..100): ripristina l'eventuale
  // applicazione precedente, ricalcola maschera e copertura, riapplica.
  /** @param {number} pct */
  run(pct) {
    pct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
    if (this._applied) this._restore();
    this.tolerance = pct;
    const thr = Math.round(pct * 2.55);
    const bw = this.board.w, bh = this.board.h;
    const f = floodMask(this._src, bw, bh, this.sx, this.sy, thr);
    const { cov, b } = maskToCoverage(f.mask, bw, bh, f.b, f.clear);
    this._apply(cov, b);
    this._applied = true;
  }

  /** @param {Uint8Array} cov @param {{x0:number,y0:number,x1:number,y1:number}} b */
  _apply(cov, b) {
    const board = this.board, store = this.layer.store;
    const bw = board.w;
    const sel = this.app.selection;
    const selMask = sel.active && sel.boardId === board.id ? sel.mask : null;
    const r = this.color.r, g = this.color.g, bl = this.color.b;
    let filled = 0;
    // rettangolo mondo della copertura -> chunk del livello (creati solo
    // dove c'è davvero qualcosa da scrivere)
    const wx0 = board.x + b.x0, wy0 = board.y + b.y0;
    const wx1 = board.x + b.x1, wy1 = board.y + b.y1;
    for (let cy = wy0 >> CHUNK_SHIFT; cy <= wy1 >> CHUNK_SHIFT; cy++) {
      for (let cx = wx0 >> CHUNK_SHIFT; cx <= wx1 >> CHUNK_SHIFT; cx++) {
        const ox = cx << CHUNK_SHIFT, oy = cy << CHUNK_SHIFT;
        const lx0 = Math.max(0, wx0 - ox), ly0 = Math.max(0, wy0 - oy);
        const lx1 = Math.min(CHUNK - 1, wx1 - ox), ly1 = Math.min(CHUNK - 1, wy1 - oy);
        const mox = ox - board.x, moy = oy - board.y;
        // prima passata: questo chunk riceve copertura?
        let any = false;
        for (let ly = ly0; ly <= ly1 && !any; ly++) {
          const mrow = (moy + ly) * bw + mox;
          for (let lx = lx0; lx <= lx1; lx++) {
            const m = mrow + lx;
            if (cov[m] !== 0 && (selMask === null || selMask[m] !== 0)) { any = true; break; }
          }
        }
        if (!any) continue;
        const key = chunkKey(cx, cy);
        if (!this._before.has(key)) {
          const existing = store.getByKey(key);
          this._before.set(key, {
            cx, cy,
            data: existing ? /** @type {Uint8ClampedArray<ArrayBuffer>} */ (existing.data.slice()) : null,
          });
        }
        const chunk = store.getOrCreate(cx, cy);
        const d = chunk.data;
        let dx0 = CHUNK, dy0 = CHUNK, dx1 = -1, dy1 = -1;
        for (let ly = ly0; ly <= ly1; ly++) {
          const mrow = (moy + ly) * bw + mox;
          let o = ((ly << CHUNK_SHIFT) + lx0) * 4;
          for (let lx = lx0; lx <= lx1; lx++, o += 4) {
            const m = mrow + lx;
            const a = selMask === null || selMask[m] !== 0 ? cov[m] : 0;
            if (a === 0) continue;
            // premultiplied source-over: a 255 rimpiazza, sul bordo fonde
            const inv = 255 - a;
            d[o] = div255(r * a) + div255(d[o] * inv);
            d[o + 1] = div255(g * a) + div255(d[o + 1] * inv);
            d[o + 2] = div255(bl * a) + div255(d[o + 2] * inv);
            d[o + 3] = a + div255(d[o + 3] * inv);
            filled++;
            if (lx < dx0) dx0 = lx;
            if (lx > dx1) dx1 = lx;
            if (ly < dy0) dy0 = ly;
            if (ly > dy1) dy1 = ly;
          }
        }
        if (dx1 < dx0) continue; // niente scritto (selezione ha azzerato tutto)
        chunk.touched = true;
        store.markDirty(chunk, dx0, dy0, dx1, dy1);
      }
    }
    this.filledPx = filled;
  }

  // Riporta il livello allo stato pre-sessione (gli stati "prima" restano:
  // sono sempre quelli originali, anche dopo molte regolazioni).
  _restore() {
    const store = this.layer.store;
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => this.app.renderer.disposeChunkTex(c);
    for (const [key, b] of this._before) {
      if (b.data) {
        const chunk = store.getOrCreate(b.cx, b.cy);
        chunk.data.set(b.data);
        chunk.touched = true;
        store.markDirty(chunk);
      } else {
        store.remove(key, dispose);
      }
    }
    this._applied = false;
  }

  // Conferma: il fill resta com'è, gli stati "prima" diventano UNA entry di
  // undo tile-diff (identica a quella degli stroke). true se c'è un'entry.
  commit() {
    if (!this._applied || this._before.size === 0) return false;
    const u = this.app.undoMgr;
    u.captureBegin(this.layer.id);
    for (const [key, b] of this._before) u.captureChunk(key, b.cx, b.cy, b.data);
    u.captureEnd();
    this._before.clear();
    this.layer.thumbDirty = true;
    this.app.ui.layersUI.scheduleThumbs();
    return true;
  }

  // Annulla: tutto torna come prima, nessuna entry di undo.
  cancel() {
    if (this._applied) this._restore();
    this._before.clear();
  }
}
