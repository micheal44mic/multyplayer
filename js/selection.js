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
    // ultimo campionamento: lo slider tolleranza ricostruisce da qui
    this._pick = { layerId: 0, wx: 0, wy: 0 };
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
    this.ver++;
  }

  /**
   * Costruisce la maschera: tutti i pixel del livello (sull'intero board,
   * non contigui) con colore straight entro `tolerance` dal pixel cliccato,
   * alpha compresa — i bordi antialiasati entrano in proporzione. Click su
   * pixel trasparente = deseleziona. Ritorna true se la selezione esiste.
   * @param {ChunkStore} store @param {number} layerId
   * @param {Board} board @param {number} wx @param {number} wy px mondo
   */
  buildFromColor(store, layerId, board, wx, wy) {
    const picked = store.get(wx >> CHUNK_SHIFT, wy >> CHUNK_SHIFT);
    const po = (((wy & (CHUNK - 1)) << CHUNK_SHIFT) + (wx & (CHUNK - 1))) * 4;
    const a0 = picked ? picked.data[po + 3] : 0;
    if (a0 === 0) { this.clear(); return false; }
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
    // il pixel cliccato matcha sempre sé stesso: count > 0 garantito
    this.mask = mask;
    this.boardId = board.id;
    this.bx = board.x; this.by = board.y;
    this.bw = bw; this.bh = bh;
    this.bounds = { x0, y0, x1, y1 };
    this.count = count;
    this._pick.layerId = layerId; this._pick.wx = wx; this._pick.wy = wy;
    this.ver++;
    return true;
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
    if (sel.mask === null) return;
    if (camera.x === this._cx && camera.y === this._cy && camera.zoom === this._cz &&
      camera.w === this._cw && camera.h === this._ch) return;
    this._cx = camera.x; this._cy = camera.y; this._cz = camera.zoom;
    this._cw = camera.w; this._ch = camera.h;
    const z = camera.zoom;
    const sx = (sel.bx - camera.x) * z + camera.w * 0.5;
    const sy = (sel.by - camera.y) * z + camera.h * 0.5;
    this.tint.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
    const hw = camera.w * 0.5 / z, hh = camera.h * 0.5 / z;
    this.svg.setAttribute('viewBox', `${camera.x - hw} ${camera.y - hh} ${hw * 2} ${hh * 2}`);
  }

  _rebuild() {
    const sel = this.sel;
    if (sel.mask === null) {
      this.root.hidden = true;
      this.pathW.setAttribute('d', '');
      this.pathB.setAttribute('d', '');
      this.tint.width = this.tint.height = 1; // libera il backing store
      return;
    }
    this.root.hidden = false;
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
}
