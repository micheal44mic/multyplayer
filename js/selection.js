// SELEZIONE PER COLORE — maschera hard 0/255 legata a UN canvas (board).
// Il modello è un buffer piatto board-locale (1 byte/px, 4 MB a 2048²),
// NON un ChunkStore: niente RGBA né infrastruttura GPU per un bit logico.
// Il vincolo sul disegno non tocca dab/capsule del rasterizer: a fine
// Rasterizer.run i pixel scritti fuori maschera si azzerano nello stroke
// buffer (vedi _maskSelection in raster.js), così pennello, gomma e core
// WASM restano identici e il commit fonde pixel già mascherati.
// L'overlay è DOM, fuori dal container dei piani (Planes._rebuild fa
// replaceChildren e lo butterebbe via): tinta = bitmap board-locale
// trasformata dal compositor come i rettangoli .board; formiche = un path
// SVG in coordinate mondo col viewBox dei piani testo (vector-effect:
// tratteggio a spessore costante a ogni zoom, anima solo il dashoffset).

import { CHUNK, CHUNK_SHIFT, forEachChunkInRect } from './store.js';

/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./camera.js').Camera} Camera */

// 255/a per l'unpremultiply senza divisioni nel loop (indice 0 inutilizzato)
const INV = new Float64Array(256);
for (let a = 1; a < 256; a++) INV[a] = 255 / a;

// Oltre questo numero di segmenti il path delle formiche non si costruisce
// (selezioni frammentate tipo foto rumorose): resta la sola tinta, che
// costa O(area del bbox) qualunque sia la frammentazione.
const MAX_ANT_RUNS = 30000;

/** @typedef {'color'|'lasso'|'polygon'} SelectionKind */
/** @typedef {'replace'|'add'|'subtract'} SelectionOperation */

/** @param {number} v @param {number} min @param {number} max */
function clampInt(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export class SelectionManager {
  constructor() {
    /** @type {Uint8Array|null} 0/255 per pixel, board-locale (bw*bh) */
    this.mask = null;
    this.boardId = 0;
    this.bx = 0; this.by = 0;   // origine mondo del board della selezione
    this.bw = 0; this.bh = 0;   // dimensioni del board
    /** @type {{x0:number,y0:number,x1:number,y1:number}|null} bbox board-locale inclusivo */
    this.bounds = null;
    this.count = 0;             // pixel selezionati
    this.tolerance = 32;        // 0..128: max distanza per canale (straight)
    /** @type {SelectionKind} */
    this.kind = 'color';         // color picker, lazo libero, lazo poligonale
    /** @type {SelectionOperation} */
    this.operation = 'replace';  // nuova, aggiungi, sottrai (Photoshop-style)
    // ultimo campionamento: lo slider tolleranza ricostruisce da qui
    this._pick = { layerId: 0, wx: 0, wy: 0 };
    this._pickCanReselect = false;
    // versione: overlay e osservatori si risincronizzano quando cambia
    this.ver = 0;
  }

  get active() { return this.mask !== null; }

  get pick() { return this._pick; }

  clear() {
    if (this.mask === null) return;
    this.mask = null;
    this.bounds = null;
    this.boardId = 0;
    this.count = 0;
    this._pickCanReselect = false;
    this.ver++;
  }

  /**
   * Costruisce la maschera: tutti i pixel del livello (sull'intero board,
   * non contigui) con colore straight entro `tolerance` dal pixel cliccato,
   * alpha compresa — i bordi antialiasati entrano in proporzione. Click su
   * pixel trasparente = deseleziona. Ritorna true se la selezione esiste.
   * @param {ChunkStore} store @param {number} layerId
   * @param {Board} board @param {number} wx @param {number} wy px mondo
   * @param {SelectionOperation} [operation]
   */
  buildFromColor(store, layerId, board, wx, wy, operation = this.operation) {
    const picked = store.get(wx >> CHUNK_SHIFT, wy >> CHUNK_SHIFT);
    const po = (((wy & (CHUNK - 1)) << CHUNK_SHIFT) + (wx & (CHUNK - 1))) * 4;
    const a0 = picked ? picked.data[po + 3] : 0;
    if (a0 === 0) {
      if (operation === 'replace') this.clear();
      return false;
    }
    const k0 = INV[a0];
    const r0 = picked.data[po] * k0, g0 = picked.data[po + 1] * k0, b0 = picked.data[po + 2] * k0;

    const bw = board.w, bh = board.h, tol = this.tolerance;
    const mask = new Uint8Array(bw * bh);
    let count = 0, x0 = bw, y0 = bh, x1 = -1, y1 = -1;
    forEachChunkInRect(store, board.x, board.y, board.x + bw - 1, board.y + bh - 1, false,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const d = chunk.data;
        const mox = ox - board.x, moy = oy - board.y;
        for (let ly = ly0; ly <= ly1; ly++) {
          const my = moy + ly;
          const mrow = my * bw + mox;
          let o = ((ly << CHUNK_SHIFT) + lx0) * 4;
          for (let lx = lx0; lx <= lx1; lx++, o += 4) {
            const a = d[o + 3];
            if (a === 0) continue;
            let da = a - a0; if (da < 0) da = -da;
            if (da > tol) continue;
            const k = INV[a];
            let dr = d[o] * k - r0; if (dr < 0) dr = -dr;
            if (dr > tol) continue;
            let dg = d[o + 1] * k - g0; if (dg < 0) dg = -dg;
            if (dg > tol) continue;
            let db = d[o + 2] * k - b0; if (db < 0) db = -db;
            if (db > tol) continue;
            mask[mrow + lx] = 255;
            count++;
            const mx = mox + lx;
            if (mx < x0) x0 = mx;
            if (mx > x1) x1 = mx;
            if (my < y0) y0 = my;
            if (my > y1) y1 = my;
          }
        }
      });
    const changed = this._applyMask(board, mask, { x0, y0, x1, y1 }, count, operation);
    if (changed) {
      this._pick.layerId = layerId; this._pick.wx = wx; this._pick.wy = wy;
      this._pickCanReselect = operation === 'replace';
    }
    return changed;
  }

  /**
   * Costruisce una selezione da un poligono in coordinate mondo. Il riempimento
   * usa la regola pari/dispari e viene clippato al board.
   * @param {Board} board
   * @param {{x:number,y:number}[]} points
   * @param {SelectionOperation} [operation]
   */
  buildFromLasso(board, points, operation = this.operation) {
    if (!board || points.length < 3) return false;
    const bw = board.w, bh = board.h;
    /** @type {{x:number,y:number}[]} */
    const pts = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      const x = p.x - board.x, y = p.y - board.y;
      pts.push({ x, y });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0 || maxY < 0 || minX >= bw || minY >= bh) {
      if (operation === 'replace') this.clear();
      return false;
    }
    const y0s = clampInt(Math.floor(minY - 1), 0, bh - 1);
    const y1s = clampInt(Math.ceil(maxY + 1), 0, bh - 1);
    const mask = new Uint8Array(bw * bh);
    /** @type {number[]} */
    const xs = [];
    let count = 0, x0 = bw, y0 = bh, x1 = -1, y1 = -1;
    const n = pts.length;

    for (let y = y0s; y <= y1s; y++) {
      const py = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a.y > py) === (b.y > py)) continue;
        const x = a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y);
        xs.push(x);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const row = y * bw;
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = xs[i], xb = xs[i + 1];
        let sx = Math.ceil(xa - 0.5);
        let ex = Math.floor(xb - 0.5);
        if (ex < 0 || sx >= bw) continue;
        sx = clampInt(sx, 0, bw - 1);
        ex = clampInt(ex, 0, bw - 1);
        if (sx > ex) continue;
        for (let x = sx; x <= ex; x++) {
          const o = row + x;
          if (mask[o] !== 0) continue;
          mask[o] = 255;
          count++;
        }
        if (sx < x0) x0 = sx;
        if (ex > x1) x1 = ex;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const changed = this._applyMask(board, mask, { x0, y0, x1, y1 }, count, operation);
    if (changed) this._pickCanReselect = false;
    return changed;
  }

  get canReselectColor() { return this._pickCanReselect; }

  /** @param {Board} board @param {Uint8Array} mask @param {{x0:number,y0:number,x1:number,y1:number}} bounds @param {number} count */
  _adoptMask(board, mask, bounds, count) {
    if (count <= 0) { this.clear(); return false; }
    this.mask = mask;
    this.boardId = board.id;
    this.bx = board.x; this.by = board.y;
    this.bw = board.w; this.bh = board.h;
    this.bounds = bounds;
    this.count = count;
    this.ver++;
    return true;
  }

  /**
   * @param {Board} board @param {Uint8Array} incoming
   * @param {{x0:number,y0:number,x1:number,y1:number}} bounds
   * @param {number} count @param {SelectionOperation} operation
   */
  _applyMask(board, incoming, bounds, count, operation) {
    if (count <= 0 || bounds.x1 < bounds.x0 || bounds.y1 < bounds.y0) {
      if (operation === 'replace') return this._adoptMask(board, incoming, bounds, 0);
      return false;
    }
    const sameBoard = this.active && this.boardId === board.id &&
      this.mask && this.bw === board.w && this.bh === board.h;
    if (operation === 'add' && sameBoard) return this._addMask(incoming, bounds);
    if (operation === 'subtract') {
      if (!sameBoard) return false;
      return this._subtractMask(incoming, bounds);
    }
    return this._adoptMask(board, incoming, bounds, count);
  }

  /** @param {Uint8Array} incoming @param {{x0:number,y0:number,x1:number,y1:number}} bounds */
  _addMask(incoming, bounds) {
    const mask = this.mask;
    if (!mask) return false;
    let added = 0;
    let x0 = this.bounds.x0, y0 = this.bounds.y0, x1 = this.bounds.x1, y1 = this.bounds.y1;
    const bw = this.bw;
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      const row = y * bw;
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const o = row + x;
        if (incoming[o] === 0 || mask[o] !== 0) continue;
        mask[o] = 255;
        added++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (added === 0) return false;
    this.bounds = { x0, y0, x1, y1 };
    this.count += added;
    this._pickCanReselect = false;
    this.ver++;
    return true;
  }

  /** @param {Uint8Array} incoming @param {{x0:number,y0:number,x1:number,y1:number}} bounds */
  _subtractMask(incoming, bounds) {
    const mask = this.mask;
    if (!mask) return false;
    let removed = 0;
    const bw = this.bw;
    for (let y = bounds.y0; y <= bounds.y1; y++) {
      const row = y * bw;
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const o = row + x;
        if (incoming[o] === 0 || mask[o] === 0) continue;
        mask[o] = 0;
        removed++;
      }
    }
    if (removed === 0) return false;
    this.count -= removed;
    this._pickCanReselect = false;
    if (this.count <= 0) {
      this.clear();
      return true;
    }
    this._recomputeBounds();
    this.ver++;
    return true;
  }

  _recomputeBounds() {
    const mask = this.mask;
    if (!mask) return;
    const bw = this.bw, bh = this.bh;
    let count = 0, x0 = bw, y0 = bh, x1 = -1, y1 = -1;
    for (let y = 0; y < bh; y++) {
      const row = y * bw;
      for (let x = 0; x < bw; x++) {
        if (mask[row + x] === 0) continue;
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    this.count = count;
    this.bounds = count > 0 ? { x0, y0, x1, y1 } : null;
  }

  /**
   * Path SVG del bordo della maschera in coordinate mondo: segmenti H/V con
   * i run collineari fusi (regioni compatte = pochi comandi). null se la
   * selezione è troppo frammentata: il chiamante lascia la sola tinta.
   * @returns {string|null}
   */
  outlinePath() {
    const m = this.mask, b = this.bounds;
    if (!m || !b) return null;
    const bw = this.bw, bh = this.bh, wx = this.bx, wy = this.by;
    /** @type {string[]} */
    const parts = [];
    let runs = 0;
    // bordi orizzontali: cambio pieno/vuoto tra la riga my-1 e la riga my
    // (l'iterazione arriva a x1+1/y1+1 con edge falso per chiudere il run)
    for (let my = b.y0; my <= b.y1 + 1; my++) {
      const up = my > 0 ? (my - 1) * bw : -1;
      const dn = my < bh ? my * bw : -1;
      let start = -1;
      for (let mx = b.x0; mx <= b.x1 + 1; mx++) {
        const edge = mx <= b.x1 &&
          ((up >= 0 && m[up + mx] !== 0) !== (dn >= 0 && m[dn + mx] !== 0));
        if (edge) { if (start < 0) start = mx; }
        else if (start >= 0) {
          if (++runs > MAX_ANT_RUNS) return null;
          parts.push(`M${wx + start} ${wy + my}H${wx + mx}`);
          start = -1;
        }
      }
    }
    // bordi verticali: cambio tra la colonna mx-1 e la colonna mx
    for (let mx = b.x0; mx <= b.x1 + 1; mx++) {
      let start = -1;
      for (let my = b.y0; my <= b.y1 + 1; my++) {
        const row = my * bw;
        const edge = my <= b.y1 &&
          ((mx > 0 && m[row + mx - 1] !== 0) !== (mx < bw && m[row + mx] !== 0));
        if (edge) { if (start < 0) start = my; }
        else if (start >= 0) {
          if (++runs > MAX_ANT_RUNS) return null;
          parts.push(`M${wx + mx} ${wy + start}V${wy + my}`);
          start = -1;
        }
      }
    }
    return parts.join('');
  }
}

// Overlay DOM della selezione. Gli elementi vivono in index.html
// (#selection, pointer-events: none): l'input non li vede mai.
export class SelectionOverlay {
  /** @param {SelectionManager} sel */
  constructor(sel) {
    this.sel = sel;
    this.root = document.getElementById('selection');
    this.tint = /** @type {HTMLCanvasElement} */ (document.getElementById('sel-tint'));
    this.svg = document.getElementById('sel-svg');
    this.pathW = document.getElementById('sel-path-w');
    this.pathB = document.getElementById('sel-path-b');
    this.previewW = document.getElementById('sel-preview-w');
    this.previewB = document.getElementById('sel-preview-b');
    this._previewD = '';
    this._ver = -1;
    // cache camera: zero lavoro DOM se non cambia nulla
    this._cx = NaN; this._cy = NaN; this._cz = NaN; this._cw = NaN; this._ch = NaN;
  }

  // Una chiamata per frame: ricostruisce al cambio di selezione,
  // riposiziona al cambio camera. Entrambe no-op nel caso comune.
  /** @param {Camera} camera */
  sync(camera) {
    const sel = this.sel;
    if (this._ver !== sel.ver) {
      this._ver = sel.ver;
      this._rebuild();
    }
    if (sel.mask === null && !this._previewD) return;
    if (camera.x === this._cx && camera.y === this._cy && camera.zoom === this._cz &&
      camera.w === this._cw && camera.h === this._ch) return;
    this._cx = camera.x; this._cy = camera.y; this._cz = camera.zoom;
    this._cw = camera.w; this._ch = camera.h;
    const z = camera.zoom;
    if (sel.mask !== null) {
      const sx = (sel.bx - camera.x) * z + camera.w * 0.5;
      const sy = (sel.by - camera.y) * z + camera.h * 0.5;
      this.tint.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
    }
    const hw = camera.w * 0.5 / z, hh = camera.h * 0.5 / z;
    this.svg.setAttribute('viewBox', `${camera.x - hw} ${camera.y - hh} ${hw * 2} ${hh * 2}`);
  }

  /** @param {string} d */
  setPreviewPath(d) {
    if (d === this._previewD) return;
    this._previewD = d;
    this.previewW.setAttribute('d', d);
    this.previewB.setAttribute('d', d);
    this._syncVisibility();
    this._cx = NaN;
  }

  _rebuild() {
    const sel = this.sel;
    if (sel.mask === null) {
      this.pathW.setAttribute('d', '');
      this.pathB.setAttribute('d', '');
      this.tint.width = this.tint.height = 1; // libera il backing store
      this._syncVisibility();
      return;
    }
    this._syncVisibility();
    this._cx = NaN; // forza il riposizionamento al prossimo sync
    // tinta: bitmap board-locale, si riempie solo il bbox della selezione
    const b = sel.bounds, bw = sel.bw, mask = sel.mask;
    if (this.tint.width !== sel.bw || this.tint.height !== sel.bh) {
      this.tint.width = sel.bw;
      this.tint.height = sel.bh;
      this.tint.style.width = sel.bw + 'px';
      this.tint.style.height = sel.bh + 'px';
    }
    const ctx = this.tint.getContext('2d');
    ctx.clearRect(0, 0, sel.bw, sel.bh);
    const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    const img = ctx.createImageData(w, h);
    const px = img.data;
    for (let y = 0; y < h; y++) {
      const mrow = (b.y0 + y) * bw + b.x0;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        if (mask[mrow + x] === 0) continue;
        px[o] = 70; px[o + 1] = 130; px[o + 2] = 240; px[o + 3] = 46;
      }
    }
    ctx.putImageData(img, b.x0, b.y0);
    // formiche: stesso path due volte (bianco continuo sotto, scuro
    // tratteggiato sopra, anima il solo dashoffset in CSS)
    const d = sel.outlinePath() || '';
    this.pathW.setAttribute('d', d);
    this.pathB.setAttribute('d', d);
  }

  _syncVisibility() {
    this.root.hidden = this.sel.mask === null && !this._previewD;
  }
}
