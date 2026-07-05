// PENNELLO BLUR -- applica una sfocatura locale direttamente sul layer
// raster attivo. Usa tile-diff per undo/collab, ma non passa dallo
// strokeStore: il risultato dipende dai pixel gia' presenti sotto il dab.

import { brush, falloff } from './brush.js';
import { gaussianBlurBuffer, iirCoeffs } from './fx_blur.js';
import { CHUNK, CHUNK_BYTES, CHUNK_SHIFT, chunkKey, forEachChunkInRect } from './store.js';
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
    // sfumino: passo 1% del diametro (floor 2px) — scia CONTINUA, niente
    // copie discrete (prima 6-16%: a size 1000 erano salti da 160px). Il
    // costo non lo governa lo spacing ma il catch-up PROPORZIONALE di
    // process(): sotto carico i dab si diradano da soli
    const dragSpacing = 0.01;
    const spacingFloor = lerp(blurSpacing, dragSpacing, this.drag);
    this.spacing = Math.max(2, size * spacingFloor);

    // Falloff circolare della sessione (raggio/durezza fissi): il blend testa
    // la banda in distanza QUADRATA e fa sqrt solo dentro la banda — niente
    // Math.hypot per pixel. cut = core + w e' il raggio oltre cui falloff = 0.
    const ffCore = this.radius * this.hardness;
    this.ffCore = ffCore;
    this.ffCore2 = ffCore * ffCore;
    this.ffW = Math.max(1, this.radius - ffCore);
    const ffCut = ffCore + this.ffW;
    this.ffCut2 = ffCut * ffCut;
    // Scratch riusati dab dopo dab: snapshot, copia sfocata e float del blur
    // sono 0.3-8 MB l'uno — riallocarli per dab e' churn GC (jank su mobile).
    /** @type {Uint8ClampedArray<ArrayBuffer>} */
    this.srcScratch = new Uint8ClampedArray(0);
    /** @type {Uint8ClampedArray<ArrayBuffer>} */
    this.blurScratch = new Uint8ClampedArray(0);
    this.f32Scratch = new Float32Array(0);
    // Downsampling per pennelli grandi: sopra 448px di diametro il lavoro
    // d'area (snapshot, blur, pull) gira a passo k (2/4/8) su griglia
    // ridotta e si riespande bilineare nel blend; la MASK e la scrittura
    // restano a piena risoluzione (bordo del pennello nitido). k=1 =
    // percorso esatto. MISURATO: per lo smudge PURO k=2 non paga (l'accumulo
    // legge comunque tutte le righe e la bilineare non ripaga i tap fusi,
    // ~0.86x) — senza blur si salta da k=1 a k=4.
    let lowK = 1;
    while (lowK < 8 && size / lowK > 448) lowK *= 2;
    const wantBlur = this.drag < 0.9999 && this.blurOpacity > 0.0001;
    if (!wantBlur && lowK === 2) lowK = 1;
    this.lowK = lowK;
    // catch-up: sopra questo arretrato process() salta un dab ogni due
    // (degradazione controllata invece di restare indietro rispetto al dito)
    this.catchUpBacklog = 24;
    /** @type {Uint8ClampedArray<ArrayBuffer>} */
    this.lowScratch = new Uint8ClampedArray(0);
    /** @type {Uint8ClampedArray<ArrayBuffer>} */
    this.lowBlurScratch = new Uint8ClampedArray(0);
    /** @type {Uint8ClampedArray<ArrayBuffer>} */
    this.lowPullScratch = new Uint8ClampedArray(0);
    /** @type {Uint32Array} */
    this.lowAccScratch = new Uint32Array(0);
    // Kernel wasm: attivi se lo store vive nella memoria lineare e il
    // modulo esporta i kernel del blur (artefatto vecchio in cache =
    // fallback JS, che resta bit-identico per contratto).
    const heap = this.store.heap;
    this.heap = heap && heap.exports.blur_blend && heap.exports.blur_pull_low ? heap : null;
    /** @type {Map<string, {ptr: number, size: number}>} blocchi nel heap wasm */
    this.wbufs = new Map();
    if (this.heap && selMask) {
      // la maschera selezione è un buffer JS: copiata UNA volta nel heap
      const n = selMask.w * selMask.h;
      const p = this._wbuf('sel', n);
      this.heap.u8(p, n).set(selMask.mask);
    }
    // GPU (punto 8): quando possibile la sessione vive in una texture del
    // renderer — dab = draw call, live = quad nello slot fx dei renderer,
    // commit = readback del rettangolo toccato in finish(). Fuori dai
    // requisiti (shape/selezione/pattern/clip/blend mode/board oltre 2048²/
    // renderer 2D) resta il motore CPU wasm/JS, che fa anche da fallback a
    // contesto perso. La collab non cambia: patch di pixel come da CPU.
    /** @type {import('./renderer_gl.js').FxFrame|null} */
    this.gpu = null;
    /** @type {{x0:number, y0:number, x1:number, y1:number}|null} */
    this.gpuDamage = null;
    const rend = /** @type {any} */ (app.renderer);
    if (rend && rend.smudgeBegin && !this.shape && !selMask && !patternTile &&
      (layer.mode || 'normal') === 'normal' && !layer.clip) {
      const bw = clip.x1 - clip.x0 + 1, bh = clip.y1 - clip.y0 + 1;
      const isClipBase = board.mgr.layers.some((l) => l.clip && l.clipBase === layer);
      if (!isClipBase && bw * bh <= 2048 * 2048) {
        this.gpu = rend.smudgeBegin(layer.id, this.store, clip, {
          radius: this.radius, hardness: this.hardness, sigma: this.sigma,
          drag: this.drag, blurOpacity: this.blurOpacity,
          useBlur: this.drag < 0.9999 && this.blurOpacity > 0.0001,
        });
      }
    }

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
      // catch-up PROPORZIONALE: per ogni soglia di arretrato superata si
      // salta un dab in piu' per ognuno processato — lo spacing effettivo
      // scala col carico e lo smudge fa passi piu' lunghi da se' (dragOffset
      // cresce con la distanza dal dab precedente) invece di restare
      // indietro rispetto al dito. L'ULTIMO dab non si salta mai.
      const backlog = this.dabs.length - this.dabRead;
      if (backlog > this.catchUpBacklog) {
        this.dabRead += Math.min(
          Math.floor(backlog / this.catchUpBacklog),
          this.dabs.length - 1 - this.dabRead);
      }
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
    if (this.gpu) {
      // commit GPU: readback del rettangolo toccato -> chunk (capture undo
      // prima della scrittura, solo dove i byte cambiano davvero). null a
      // contesto perso: i chunk restano pre-tratto, coerente col restore.
      const rend = /** @type {any} */ (this.app.renderer);
      const rb = this.changed && this.gpuDamage ? rend.smudgeReadback(this.gpuDamage) : null;
      this.changed = false;
      if (rb) this._applyRect(rb);
      rend.smudgeEnd();
      this.gpu = null;
    }
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
    this._freeWbufs();
  }

  cancel() {
    if (!this.active && this.finished) return;
    this.active = false;
    this.ending = true;
    this.dabs.length = 0;
    this.dabRead = 0;
    if (this.gpu) {
      // GPU: i chunk non sono mai stati toccati — basta liberare la VRAM
      /** @type {any} */ (this.app.renderer).smudgeEnd();
      this.gpu = null;
      this.changed = false;
    }
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
    this._freeWbufs();
    this.finished = true;
  }

  /**
   * Scrive il readback GPU nei chunk: per chunk solo dove i byte cambiano
   * davvero (capture undo prima della scrittura, markDirty sul sub-rect,
   * chunk creati solo se serve) — stessa semantica del motore CPU.
   * @param {{x:number, y:number, w:number, h:number, data:Uint8ClampedArray}} rb
   */
  _applyRect(rb) {
    const store = this.store;
    const rx1 = rb.x + rb.w - 1, ry1 = rb.y + rb.h - 1;
    for (let chy = rb.y >> CHUNK_SHIFT; chy <= ry1 >> CHUNK_SHIFT; chy++) {
      for (let chx = rb.x >> CHUNK_SHIFT; chx <= rx1 >> CHUNK_SHIFT; chx++) {
        const key = chunkKey(chx, chy);
        const ox = chx << CHUNK_SHIFT, oy = chy << CHUNK_SHIFT;
        const lx0 = Math.max(0, rb.x - ox), ly0 = Math.max(0, rb.y - oy);
        const lx1 = Math.min(CHUNK - 1, rx1 - ox), ly1 = Math.min(CHUNK - 1, ry1 - oy);
        let chunk = store.getByKey(key);
        let wrote = false;
        let dx0 = CHUNK, dy0 = CHUNK, dx1 = -1, dy1 = -1;
        for (let ly = ly0; ly <= ly1; ly++) {
          let di = ((ly << CHUNK_SHIFT) + lx0) * 4;
          let si = ((oy + ly - rb.y) * rb.w + (ox + lx0 - rb.x)) * 4;
          for (let lx = lx0; lx <= lx1; lx++, di += 4, si += 4) {
            const nr = rb.data[si], ng = rb.data[si + 1];
            const nb = rb.data[si + 2], na = rb.data[si + 3];
            const cr = chunk ? chunk.data[di] : 0;
            const cg = chunk ? chunk.data[di + 1] : 0;
            const cb = chunk ? chunk.data[di + 2] : 0;
            const ca = chunk ? chunk.data[di + 3] : 0;
            if (nr === cr && ng === cg && nb === cb && na === ca) continue;
            if (!wrote) {
              this._capture(key, chx, chy, chunk || null);
              if (!chunk) chunk = store.getOrCreate(chx, chy);
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
          store.markDirty(chunk, dx0, dy0, dx1, dy1);
          this.changed = true;
        }
      }
    }
  }

  /**
   * Blocco nel heap wasm, grow-only per nome; il vecchio torna alla free
   * list. ATTENZIONE: un alloc può far crescere la memoria e staccare OGNI
   * vista JS — allocare tutti i blocchi di un dab PRIMA di creare viste.
   * @param {string} name @param {number} size
   */
  _wbuf(name, size) {
    const heap = /** @type {import('./wasm_core.js').WasmHeap} */ (this.heap);
    let b = this.wbufs.get(name);
    if (!b || b.size < size) {
      // taglie a potenze di due: le free list dello slab sono per taglia
      // esatta, misure arbitrarie per-tratto creerebbero bucket monouso
      let cap = 4096;
      while (cap < size) cap *= 2;
      if (b) heap.free(b.ptr, b.size);
      b = { ptr: heap.alloc(cap), size: cap };
      this.wbufs.set(name, b);
    }
    return b.ptr;
  }

  // Tile 256² tutto trasparente: base dei chunk inesistenti nel kernel.
  // Azzerato solo alla prima alloc (la taglia è fissa: mai ri-allocato).
  _zeroTile() {
    const had = this.wbufs.has('zero');
    const ptr = this._wbuf('zero', CHUNK_BYTES);
    if (!had) /** @type {import('./wasm_core.js').WasmHeap} */ (this.heap).u8(ptr, CHUNK_BYTES).fill(0);
    return ptr;
  }

  _freeWbufs() {
    if (!this.heap) return;
    for (const b of this.wbufs.values()) this.heap.free(b.ptr, b.size);
    this.wbufs.clear();
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
    if (this.gpu) {
      // dab GPU: un draw call; i pixel CPU non si toccano fino al commit
      /** @type {any} */ (this.app.renderer).smudgeDab(x, y, pressure, dirX, dirY, dragOffset,
        hasSmudge ? this.drag : 0, useBlur ? this.blurOpacity * (1 - this.drag) : 0);
      // damage per il readback: bbox +2px (la banda del falloff puo'
      // sforare il raggio di un pixel sui pennelli duri)
      const ex0 = Math.max(x0 - 2, this.clip.x0), ey0 = Math.max(y0 - 2, this.clip.y0);
      const ex1 = Math.min(x1 + 2, this.clip.x1), ey1 = Math.min(y1 + 2, this.clip.y1);
      const d = this.gpuDamage;
      if (!d) {
        this.gpuDamage = { x0: ex0, y0: ey0, x1: ex1, y1: ey1 };
      } else {
        if (ex0 < d.x0) d.x0 = ex0;
        if (ey0 < d.y0) d.y0 = ey0;
        if (ex1 > d.x1) d.x1 = ex1;
        if (ey1 > d.y1) d.y1 = ey1;
      }
      this.changed = true;
      if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }
    const smudgePad = hasSmudge ? Math.ceil(dragOffset + Math.max(0.5, half * 0.07) + 2) : 0;
    const pad = Math.max(useBlur ? this.pad : 0, smudgePad);
    const sx = x0 - pad, sy = y0 - pad;
    const sw = x1 - x0 + 1 + pad * 2;
    const sh = y1 - y0 + 1 + pad * 2;
    const k = this.lowK;
    // Clamp al contenuto: pixel-exact per il blur a k=1 (la IIR vuole il
    // rect stretto), a granularita' CHUNK altrimenti — gratis dalla mappa
    // sparsa, e fuori da chunkB±pad ne' blur ne' pull possono produrre
    // pixel (le sorgenti la' sono trasparenti), quindi il clamp e' neutro.
    const content = useBlur && k === 1
      ? this._contentBounds(sx, sy, sw, sh)
      : this._chunkContentBounds(sx, sy, sw, sh);
    if (!content) {
      if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }
    const bx0 = Math.max(sx, content.x0 - pad);
    const by0 = Math.max(sy, content.y0 - pad);
    const bx1 = Math.min(sx + sw - 1, content.x1 + pad);
    const by1 = Math.min(sy + sh - 1, content.y1 + pad);
    x0 = Math.max(x0, bx0);
    y0 = Math.max(y0, by0);
    x1 = Math.min(x1, bx1);
    y1 = Math.min(y1, by1);
    if (x0 > x1 || y0 > y1) {
      // quirk conservato: il path blur k=1 non aggiornava prev qui
      if (!(useBlur && k === 1) && this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }

    const csx = bx0, csy = by0;
    let csw = bx1 - bx0 + 1;
    let csh = by1 - by0 + 1;
    if (k > 1) {
      // celle piene: cs esteso al multiplo di k (l'eccedenza legge mondo
      // trasparente; l'indicizzazione si/csw resta coerente)
      csw = Math.ceil(csw / k) * k;
      csh = Math.ceil(csh / k) * k;
      this._dabLow(x, y, x0, y0, x1, y1, csx, csy, csw, csh, useBlur, hasSmudge, dirX, dirY, dragOffset, pressure, stamp);
      if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }
    if (this.heap && (!stamp || stamp.ptr)) {
      // percorso wasm k=1: snapshot e blur nel heap, blend nel kernel.
      // TUTTE le alloc PRIMA delle viste (un grow le stacca).
      const heap = this.heap;
      const n = csw * csh * 4;
      const srcPtr = this._wbuf('src', n);
      let blurPtr = 0, f32Ptr = 0;
      if (useBlur) {
        blurPtr = this._wbuf('blur', n);
        f32Ptr = this._wbuf('f32', n * 4);
      }
      const outPtr = this._wbuf('out', CHUNK_BYTES);
      const zeroPtr = this._zeroTile();
      const pfPtr = this._wbuf('pf', 32 * 8);
      const piPtr = this._wbuf('pi', 32 * 4);
      const srcView = heap.u8c(srcPtr, n);
      this._snapshotInto(srcView, csx, csy, csw, csh);
      if (useBlur) {
        heap.u8c(blurPtr, n).set(srcView);
        const co = iirCoeffs(this.sigma);
        heap.exports.iir_blur(blurPtr, f32Ptr, csw, csh, co.B, co.c1, co.c2, co.c3);
      }
      this._blendWasm(pfPtr, piPtr, outPtr, zeroPtr, srcPtr, blurPtr,
        x, y, x0, y0, x1, y1, csx, csy, csw, csh, dirX, dirY, dragOffset, pressure, stamp);
      if (this.drag > 0.0001) this.prevDabs.set(lane, { x, y, dirX, dirY });
      return;
    }
    const src = this._snapshot(csx, csy, csw, csh);
    let blurred = null;
    if (useBlur) {
      const n = csw * csh * 4;
      if (this.blurScratch.length < n) this.blurScratch = new Uint8ClampedArray(n);
      if (this.f32Scratch.length < n) this.f32Scratch = new Float32Array(n);
      blurred = this.blurScratch;
      blurred.set(src.subarray(0, n));
      gaussianBlurBuffer(blurred, csw, csh, this.sigma, this.f32Scratch);
    }

    this._blendResult(x, y, x0, y0, x1, y1, csx, csy, csw, csh, src, blurred, dirX, dirY, dragOffset, pressure, stamp);
    if (this.drag > 0.0001) {
      this.prevDabs.set(lane, { x, y, dirX, dirY });
    }
  }

  /**
   * Snapshot nel buffer scratch riusato: validi i primi w*h*4 byte.
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @returns {Uint8ClampedArray<ArrayBuffer>}
   */
  _snapshot(x, y, w, h) {
    const n = w * h * 4;
    if (this.srcScratch.length < n) this.srcScratch = new Uint8ClampedArray(n);
    this._snapshotInto(this.srcScratch, x, y, w, h);
    return this.srcScratch;
  }

  /**
   * @param {Uint8ClampedArray} out buffer di destinazione (>= w*h*4)
   * @param {number} x @param {number} y @param {number} w @param {number} h
   */
  _snapshotInto(out, x, y, w, h) {
    out.fill(0, 0, w * h * 4);
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
   * Dab a risoluzione ridotta k = this.lowK: snapshot medio a 4 campioni
   * stratificati per cella (k=2: box 2x2 esatto), blur e pull sulla griglia
   * ridotta, riespansione bilineare nei buffer si-compatibili; la MASK e la
   * scrittura restano a piena risoluzione (bordo del pennello nitido).
   * @param {number} cx @param {number} cy centro del dab
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {number} csx @param {number} csy @param {number} csw @param {number} csh
   * @param {boolean} useBlur @param {boolean} hasSmudge
   * @param {number} dirX @param {number} dirY @param {number} dragOffset
   * @param {number} pressure
   * @param {{size:number, half:number, mask:Uint8Array, ptr:number}|null} stamp
   */
  _dabLow(cx, cy, x0, y0, x1, y1, csx, csy, csw, csh, useBlur, hasSmudge, dirX, dirY, dragOffset, pressure, stamp) {
    const k = this.lowK;
    const lowW = csw / k, lowH = csh / k;
    const lowN = lowW * lowH * 4;
    const heap = this.heap && (!stamp || stamp.ptr) ? this.heap : null;
    let lowSrcPtr = 0, lowBlurPtr = 0, lowPullPtr = 0, lowAccPtr = 0, f32Ptr = 0;
    let outPtr = 0, zeroPtr = 0, pfPtr = 0, piPtr = 0;
    /** @type {Uint8ClampedArray} */
    let lowSrc;
    if (heap) {
      // percorso wasm: buffer low nel heap. TUTTE le alloc PRIMA delle
      // viste (un grow le stacca; i puntatori restano validi).
      lowSrcPtr = this._wbuf('lowSrc', lowN);
      lowAccPtr = this._wbuf('lowAcc', lowN * 4);
      if (useBlur) {
        lowBlurPtr = this._wbuf('lowBlur', lowN);
        f32Ptr = this._wbuf('f32', lowN * 4);
      }
      if (hasSmudge) lowPullPtr = this._wbuf('lowPull', lowN);
      outPtr = this._wbuf('out', CHUNK_BYTES);
      zeroPtr = this._zeroTile();
      pfPtr = this._wbuf('pf', 32 * 8);
      piPtr = this._wbuf('pi', 32 * 4);
      lowSrc = heap.u8c(lowSrcPtr, lowN);
    } else {
      if (this.lowAccScratch.length < lowN) this.lowAccScratch = new Uint32Array(lowN);
      if (this.lowScratch.length < lowN) {
        this.lowScratch = new Uint8ClampedArray(lowN);
        this.lowBlurScratch = new Uint8ClampedArray(lowN);
        this.lowPullScratch = new Uint8ClampedArray(lowN);
      }
      lowSrc = this.lowScratch;
    }
    // 4 campioni stratificati per cella (k=2: box 2x2 esatto), accumulati
    // ROW-WISE: le righe non campione si saltano intere (traffico memoria
    // 2/k dell'area; le passate strided per-offset costavano 4x l'area)
    const q0 = k >> 2, q1 = (k * 3) >> 2;
    if (heap) {
      const ex = heap.exports;
      new Uint32Array(heap.memory.buffer, lowAccPtr, lowN).fill(0);
      forEachChunkInRect(this.store, csx, csy, csx + csw - 1, csy + csh - 1, false,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          ex.blur_low_acc(chunk.ptr, lx0, ly0, lx1, ly1, ox, oy,
            lowAccPtr, csx, csy, k, q0, q1, lowW);
        });
      ex.blur_low_div(lowAccPtr, lowSrcPtr, lowN);
    } else {
      const acc = this.lowAccScratch;
      acc.fill(0, 0, lowN);
      forEachChunkInRect(this.store, csx, csy, csx + csw - 1, csy + csh - 1, false,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          const data = chunk.data;
          const wxe = ox + lx1;
          for (let ly = ly0; ly <= ly1; ly++) {
            const wy = oy + ly;
            const ry = (wy - csy) % k; // csy <= wy per costruzione del rect
            if (ry !== q0 && ry !== q1) continue;
            const myRow = ((wy - csy - ry) / k) * lowW;
            for (let s = 0; s < 2; s++) {
              const sox = s === 0 ? q0 : q1;
              let wx0 = ox + lx0;
              const rx = (wx0 - csx - sox) % k;
              if (rx !== 0) wx0 += rx < 0 ? -rx : k - rx;
              if (wx0 > wxe) continue;
              let o = ((ly << CHUNK_SHIFT) + (wx0 - ox)) * 4;
              let ci = (myRow + (wx0 - csx - sox) / k) * 4;
              for (let wx = wx0; wx <= wxe; wx += k, o += k * 4, ci += 4) {
                acc[ci] += data[o];
                acc[ci + 1] += data[o + 1];
                acc[ci + 2] += data[o + 2];
                acc[ci + 3] += data[o + 3];
              }
            }
          }
        });
      // media dei 4 campioni col vincolo premultiplied r,g,b <= a
      for (let o = 0; o < lowN; o += 4) {
        const a = (acc[o + 3] + 2) >> 2;
        const r = (acc[o] + 2) >> 2;
        const g = (acc[o + 1] + 2) >> 2;
        const b = (acc[o + 2] + 2) >> 2;
        lowSrc[o] = r > a ? a : r;
        lowSrc[o + 1] = g > a ? a : g;
        lowSrc[o + 2] = b > a ? a : b;
        lowSrc[o + 3] = a;
      }
    }

    let lowBlur = null;
    if (useBlur) {
      if (heap) {
        heap.u8c(lowBlurPtr, lowN).set(lowSrc);
        const co = iirCoeffs(this.sigma / k);
        heap.exports.iir_blur(lowBlurPtr, f32Ptr, lowW, lowH, co.B, co.c1, co.c2, co.c3);
      } else {
        lowBlur = this.lowBlurScratch;
        lowBlur.set(lowSrc.subarray(0, lowN));
        if (this.f32Scratch.length < lowN) this.f32Scratch = new Float32Array(lowN);
        gaussianBlurBuffer(lowBlur, lowW, lowH, this.sigma / k, this.f32Scratch);
      }
    }
    let lowPull = null;
    if (hasSmudge) {
      const invK = 1 / k;
      const crossStep = Math.max(0.5, this.radius * 0.07) * invK;
      if (heap) {
        heap.exports.blur_pull_low(lowSrcPtr, lowW, lowH, lowPullPtr,
          -dirX * dragOffset * invK, -dirY * dragOffset * invK,
          -dirY * crossStep, dirX * crossStep);
      } else {
        lowPull = this.lowPullScratch;
        this._pullLow(lowSrc, lowW, lowH,
          -dirX * dragOffset * invK, -dirY * dragOffset * invK,
          -dirY * crossStep, dirX * crossStep, lowPull);
      }
    }
    // l'upsampling e' FUSO nel blend: una bilineare dal buffer low per
    // pixel, con gli stessi pesi condivisi da blur e pull — un passaggio
    // full-res in meno (materializzarli a piena risoluzione costava quanto
    // i tap che il low-res voleva risparmiare)
    if (heap) {
      this._blendLowWasm(pfPtr, piPtr, outPtr, zeroPtr, cx, cy, x0, y0, x1, y1,
        csx, csy, lowW, lowH, k, pressure, stamp, lowPullPtr, lowBlurPtr);
      return;
    }
    this._blendUp(cx, cy, x0, y0, x1, y1, csx, csy, lowW, lowH, k, pressure, stamp, lowPull, lowBlur);
  }

  /**
   * Pull dello smudge sulla griglia ridotta: 3 tap bilineari fusi (0.6
   * centro + 0.2 per lato) a offset COSTANTE nel dab; fuori dal buffer =
   * trasparente, bordo con clamp (coerente con _samplePremulInto).
   * @param {Uint8ClampedArray} src @param {number} w @param {number} h
   * @param {number} oCX @param {number} oCY offset del tap centrale (px low)
   * @param {number} crX @param {number} crY passo perpendicolare (px low)
   * @param {Uint8ClampedArray} out
   */
  _pullLow(src, w, h, oCX, oCY, crX, crY, out) {
    const oAX = oCX + crX, oAY = oCY + crY;
    const oBX = oCX - crX, oBY = oCY - crY;
    const xC = Math.floor(oCX), yC = Math.floor(oCY);
    const xA = Math.floor(oAX), yA = Math.floor(oAY);
    const xB = Math.floor(oBX), yB = Math.floor(oBY);
    const txC = oCX - xC, tyC = oCY - yC;
    const txA = oAX - xA, tyA = oAY - yA;
    const txB = oBX - xB, tyB = oBY - yB;
    const w4 = w * 4;
    const cD = (yC * w + xC) * 4, aD = (yA * w + xA) * 4, bD = (yB * w + xB) * 4;
    const cW00 = (1 - txC) * (1 - tyC), cW10 = txC * (1 - tyC), cW01 = (1 - txC) * tyC, cW11 = txC * tyC;
    const aW00 = (1 - txA) * (1 - tyA), aW10 = txA * (1 - tyA), aW01 = (1 - txA) * tyA, aW11 = txA * tyA;
    const bW00 = (1 - txB) * (1 - tyB), bW10 = txB * (1 - tyB), bW01 = (1 - txB) * tyB, bW11 = txB * tyB;
    const fx0 = Math.max(-xC, -xA, -xB), fx1 = w - 2 - Math.max(xC, xA, xB);
    const fy0 = Math.max(-yC, -yA, -yB), fy1 = h - 2 - Math.max(yC, yA, yB);
    const t4 = [0, 0, 0, 0];
    for (let iy = 0; iy < h; iy++) {
      const rowOk = iy >= fy0 && iy <= fy1;
      let o = iy * w4;
      for (let ix = 0; ix < w; ix++, o += 4) {
        if (rowOk && ix >= fx0 && ix <= fx1) {
          const iC = o + cD, iA = o + aD, iB = o + bD;
          out[o] = (src[iC] * cW00 + src[iC + 4] * cW10 + src[iC + w4] * cW01 + src[iC + w4 + 4] * cW11) * 0.6
            + (src[iA] * aW00 + src[iA + 4] * aW10 + src[iA + w4] * aW01 + src[iA + w4 + 4] * aW11) * 0.2
            + (src[iB] * bW00 + src[iB + 4] * bW10 + src[iB + w4] * bW01 + src[iB + w4 + 4] * bW11) * 0.2;
          out[o + 1] = (src[iC + 1] * cW00 + src[iC + 5] * cW10 + src[iC + w4 + 1] * cW01 + src[iC + w4 + 5] * cW11) * 0.6
            + (src[iA + 1] * aW00 + src[iA + 5] * aW10 + src[iA + w4 + 1] * aW01 + src[iA + w4 + 5] * aW11) * 0.2
            + (src[iB + 1] * bW00 + src[iB + 5] * bW10 + src[iB + w4 + 1] * bW01 + src[iB + w4 + 5] * bW11) * 0.2;
          out[o + 2] = (src[iC + 2] * cW00 + src[iC + 6] * cW10 + src[iC + w4 + 2] * cW01 + src[iC + w4 + 6] * cW11) * 0.6
            + (src[iA + 2] * aW00 + src[iA + 6] * aW10 + src[iA + w4 + 2] * aW01 + src[iA + w4 + 6] * aW11) * 0.2
            + (src[iB + 2] * bW00 + src[iB + 6] * bW10 + src[iB + w4 + 2] * bW01 + src[iB + w4 + 6] * bW11) * 0.2;
          out[o + 3] = (src[iC + 3] * cW00 + src[iC + 7] * cW10 + src[iC + w4 + 3] * cW01 + src[iC + w4 + 7] * cW11) * 0.6
            + (src[iA + 3] * aW00 + src[iA + 7] * aW10 + src[iA + w4 + 3] * aW01 + src[iA + w4 + 7] * aW11) * 0.2
            + (src[iB + 3] * bW00 + src[iB + 7] * bW10 + src[iB + w4 + 3] * bW01 + src[iB + w4 + 7] * bW11) * 0.2;
        } else {
          this._sampleLowTap(src, w, h, ix + oCX, iy + oCY, t4);
          let r = t4[0] * 0.6, g = t4[1] * 0.6, b = t4[2] * 0.6, a = t4[3] * 0.6;
          this._sampleLowTap(src, w, h, ix + oAX, iy + oAY, t4);
          r += t4[0] * 0.2; g += t4[1] * 0.2; b += t4[2] * 0.2; a += t4[3] * 0.2;
          this._sampleLowTap(src, w, h, ix + oBX, iy + oBY, t4);
          out[o] = r + t4[0] * 0.2;
          out[o + 1] = g + t4[1] * 0.2;
          out[o + 2] = b + t4[2] * 0.2;
          out[o + 3] = a + t4[3] * 0.2;
        }
      }
    }
  }

  /**
   * Un tap bilineare sulla griglia low: fuori [0,w-1]x[0,h-1] = trasparente,
   * bordo con clamp.
   * @param {Uint8ClampedArray} src @param {number} w @param {number} h
   * @param {number} fx @param {number} fy @param {number[]} out
   */
  _sampleLowTap(src, w, h, fx, fy, out) {
    if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) {
      out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
      return;
    }
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out[0] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    out[1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    out[2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
    out[3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
  }

  /**
   * Scrive nei blocchi pf/pi i parametri di mask comuni ai due kernel:
   * centro, pressione, falloff di sessione, selezione e stamp.
   * @param {Float64Array} pf @param {Int32Array} pi
   * @param {number} cx @param {number} cy @param {number} pressure
   * @param {{size:number, half:number, mask:Uint8Array, ptr:number}|null} stamp
   */
  _fillMaskParams(pf, pi, cx, cy, pressure, stamp) {
    pf[0] = cx; pf[1] = cy; pf[2] = pressure; pf[3] = this.drag; pf[4] = this.blurOpacity;
    pf[5] = this.ffCore; pf[6] = this.ffCore2; pf[7] = this.ffCut2; pf[8] = this.ffW;
    const sel = this.selMask;
    if (sel) {
      const b = /** @type {{ptr:number, size:number}} */ (this.wbufs.get('sel'));
      pi[14] = b.ptr; pi[15] = sel.x; pi[16] = sel.y; pi[17] = sel.w; pi[18] = sel.h;
    } else {
      pi[14] = 0;
    }
    if (stamp) {
      pi[19] = stamp.ptr; pi[20] = stamp.size;
      pi[21] = Math.round(cx - stamp.half);
      pi[22] = Math.round(cy - stamp.half);
    } else {
      pi[19] = 0;
    }
  }

  /**
   * Variante wasm di _blendResult (k=1): parametri del dab nei blocchi
   * pf/pi (stesse costanti dei tap del path JS, calcolate qui in f64
   * identico), blend per chunk via kernel blur_blend.
   * @param {number} pfPtr @param {number} piPtr
   * @param {number} outPtr @param {number} zeroPtr
   * @param {number} srcPtr @param {number} blurPtr
   * @param {number} cx @param {number} cy
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {number} sx @param {number} sy @param {number} sw @param {number} sh
   * @param {number} dirX @param {number} dirY @param {number} dragOffset
   * @param {number} pressure
   * @param {{size:number, half:number, mask:Uint8Array, ptr:number}|null} stamp
   */
  _blendWasm(pfPtr, piPtr, outPtr, zeroPtr, srcPtr, blurPtr, cx, cy, x0, y0, x1, y1, sx, sy, sw, sh, dirX, dirY, dragOffset, pressure, stamp) {
    const heap = /** @type {import('./wasm_core.js').WasmHeap} */ (this.heap);
    const drag = this.drag;
    const hasSmudge = drag > 0.0001 && dragOffset > 0.0001 && Math.hypot(dirX, dirY) > 0.0001;
    const pf = new Float64Array(heap.memory.buffer, pfPtr, 32);
    const pi = new Int32Array(heap.memory.buffer, piPtr, 32);
    this._fillMaskParams(pf, pi, cx, cy, pressure, stamp);
    let fwx0 = 1, fwx1 = 0, fwy0 = 1, fwy1 = 0;
    if (hasSmudge) {
      const perpX = -dirY, perpY = dirX;
      const crossStep = Math.max(0.5, this.radius * 0.07);
      const oCX = -dirX * dragOffset, oCY = -dirY * dragOffset;
      const oAX = oCX + perpX * crossStep, oAY = oCY + perpY * crossStep;
      const oBX = oCX - perpX * crossStep, oBY = oCY - perpY * crossStep;
      const xC = Math.floor(oCX), yC = Math.floor(oCY);
      const xA = Math.floor(oAX), yA = Math.floor(oAY);
      const xB = Math.floor(oBX), yB = Math.floor(oBY);
      const txC = oCX - xC, tyC = oCY - yC;
      const txA = oAX - xA, tyA = oAY - yA;
      const txB = oBX - xB, tyB = oBY - yB;
      pf[9] = (1 - txC) * (1 - tyC); pf[10] = txC * (1 - tyC);
      pf[11] = (1 - txC) * tyC; pf[12] = txC * tyC;
      pf[13] = (1 - txA) * (1 - tyA); pf[14] = txA * (1 - tyA);
      pf[15] = (1 - txA) * tyA; pf[16] = txA * tyA;
      pf[17] = (1 - txB) * (1 - tyB); pf[18] = txB * (1 - tyB);
      pf[19] = (1 - txB) * tyB; pf[20] = txB * tyB;
      pf[21] = oCX; pf[22] = oCY;
      pf[23] = perpX * crossStep; pf[24] = perpY * crossStep;
      pi[7] = (yC * sw + xC) * 4;
      pi[8] = (yA * sw + xA) * 4;
      pi[9] = (yB * sw + xB) * 4;
      fwx0 = sx + Math.max(-xC, -xA, -xB);
      fwx1 = sx + sw - 2 - Math.max(xC, xA, xB);
      fwy0 = sy + Math.max(-yC, -yA, -yB);
      fwy1 = sy + sh - 2 - Math.max(yC, yA, yB);
    }
    pi[0] = srcPtr; pi[1] = sx; pi[2] = sy; pi[3] = sw; pi[4] = sh;
    pi[5] = blurPtr; pi[6] = hasSmudge ? 1 : 0;
    pi[10] = fwx0; pi[11] = fwx1; pi[12] = fwy0; pi[13] = fwy1;
    this._runKernel(heap.exports.blur_blend, pfPtr, piPtr, outPtr, zeroPtr, x0, y0, x1, y1);
  }

  /**
   * Variante wasm di _blendUp (k>1): blend per chunk via blur_blend_low.
   * @param {number} pfPtr @param {number} piPtr
   * @param {number} outPtr @param {number} zeroPtr
   * @param {number} cx @param {number} cy
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {number} csx @param {number} csy
   * @param {number} lowW @param {number} lowH @param {number} k
   * @param {number} pressure
   * @param {{size:number, half:number, mask:Uint8Array, ptr:number}|null} stamp
   * @param {number} lowPullPtr @param {number} lowBlurPtr
   */
  _blendLowWasm(pfPtr, piPtr, outPtr, zeroPtr, cx, cy, x0, y0, x1, y1, csx, csy, lowW, lowH, k, pressure, stamp, lowPullPtr, lowBlurPtr) {
    const heap = /** @type {import('./wasm_core.js').WasmHeap} */ (this.heap);
    const pf = new Float64Array(heap.memory.buffer, pfPtr, 32);
    const pi = new Int32Array(heap.memory.buffer, piPtr, 32);
    this._fillMaskParams(pf, pi, cx, cy, pressure, stamp);
    pi[0] = lowPullPtr; pi[1] = csx; pi[2] = csy; pi[3] = lowW; pi[4] = lowH;
    pi[5] = lowBlurPtr; pi[6] = k;
    this._runKernel(heap.exports.blur_blend_low, pfPtr, piPtr, outPtr, zeroPtr, x0, y0, x1, y1);
  }

  /**
   * Esegue il kernel di blend per-chunk col protocollo base/out/damage:
   * in-place sui chunk gia' catturati dall'undo, tile scratch + copy-back
   * del solo rettangolo danneggiato altrimenti — la semantica "cattura e
   * crea solo se scrive" resta identica al path JS.
   * @param {(pf: number, pi: number, base: number, out: number, lx0: number, ly0: number, lx1: number, ly1: number, ox: number, oy: number) => number} kernel
   * @param {number} pfPtr @param {number} piPtr
   * @param {number} outPtr @param {number} zeroPtr
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   */
  _runKernel(kernel, pfPtr, piPtr, outPtr, zeroPtr, x0, y0, x1, y1) {
    const heap = /** @type {import('./wasm_core.js').WasmHeap} */ (this.heap);
    const store = this.store;
    for (let chy = y0 >> CHUNK_SHIFT; chy <= y1 >> CHUNK_SHIFT; chy++) {
      for (let chx = x0 >> CHUNK_SHIFT; chx <= x1 >> CHUNK_SHIFT; chx++) {
        const key = chunkKey(chx, chy);
        const ox = chx << CHUNK_SHIFT, oy = chy << CHUNK_SHIFT;
        const lx0 = Math.max(0, x0 - ox), ly0 = Math.max(0, y0 - oy);
        const lx1 = Math.min(CHUNK - 1, x1 - ox), ly1 = Math.min(CHUNK - 1, y1 - oy);
        let chunk = store.getByKey(key);
        const captured = this.before.has(key);
        const basePtr = chunk ? chunk.ptr : zeroPtr;
        const dstPtr = chunk && captured ? chunk.ptr : outPtr;
        const dmg = kernel(pfPtr, piPtr, basePtr, dstPtr, lx0, ly0, lx1, ly1, ox, oy);
        if (dmg === -1) continue; // u32::MAX letto come i32: nulla e' cambiato
        const d = dmg >>> 0;
        const dx0 = d >>> 24, dy0 = (d >>> 16) & 255, dx1 = (d >>> 8) & 255, dy1 = d & 255;
        if (!captured) this._capture(key, chx, chy, chunk || null);
        if (dstPtr === outPtr) {
          // getOrCreate puo' far crescere la memoria: i puntatori restano
          // validi, le viste (chunk.data compresa) le rigenera onGrow
          if (!chunk) chunk = store.getOrCreate(chx, chy);
          const out = heap.u8c(outPtr, CHUNK_BYTES);
          const rw = (dx1 - dx0 + 1) * 4;
          for (let ly = dy0; ly <= dy1; ly++) {
            const o = ((ly << CHUNK_SHIFT) + dx0) * 4;
            chunk.data.set(out.subarray(o, o + rw), o);
          }
        }
        const c = /** @type {Chunk} */ (chunk);
        c.touched = true;
        store.markDirty(c, dx0, dy0, dx1, dy1);
        this.changed = true;
      }
    }
  }

  /**
   * Blend a piena risoluzione del dab low-res: base = pixel del chunk (per
   * costruzione uguale allo snapshot), blur/pull campionati BILINEARE dai
   * buffer low direttamente qui (upsampling fuso: gli stessi pesi servono
   * entrambi i buffer). Stessa matematica di _blendResult: mask, formule,
   * clamp premultiplied, scrittura solo se cambia, capture/markDirty.
   * @param {number} cx @param {number} cy
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {number} csx @param {number} csy
   * @param {number} lowW @param {number} lowH @param {number} k
   * @param {number} pressure
   * @param {{size:number, half:number, mask:Uint8Array}|null} stamp
   * @param {Uint8ClampedArray|null} lowPull
   * @param {Uint8ClampedArray|null} lowBlur
   */
  _blendUp(cx, cy, x0, y0, x1, y1, csx, csy, lowW, lowH, k, pressure, stamp, lowPull, lowBlur) {
    const drag = this.drag;
    const sel = this.selMask;
    const blurOpacity = this.blurOpacity;
    const ffCore = this.ffCore, ffCore2 = this.ffCore2, ffCut2 = this.ffCut2, ffW = this.ffW;
    const invK = 1 / k;
    const lw4 = lowW * 4;
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
          const ddy = wy + 0.5 - cy;
          const dy2 = ddy * ddy;
          // riga bilineare del reticolo low (clamp: i pesi degeneri sommano
          // al valore esatto della cella di bordo)
          const fy = (wy - csy + 0.5) * invK - 0.5;
          let iy0 = Math.floor(fy);
          const ty = fy - iy0;
          let iy1 = iy0 + 1;
          if (iy0 < 0) { iy0 = 0; iy1 = 0; }
          else if (iy1 >= lowH) iy1 = lowH - 1;
          const rowA = iy0 * lw4, rowB = iy1 * lw4;
          const wyA = 1 - ty, wyB = ty;
          let di = ((ly << CHUNK_SHIFT) + lx0) * 4;
          for (let lx = lx0; lx <= lx1; lx++, di += 4) {
            const wx = ox + lx;
            let mask;
            if (stamp) {
              mask = this._maskAt(wx, wy, cx, cy, stamp) * pressure;
            } else {
              const ddx = wx + 0.5 - cx;
              const d2 = ddx * ddx + dy2;
              if (d2 >= ffCut2) continue;
              let bm;
              if (d2 <= ffCore2) {
                bm = 1;
              } else {
                const t = (Math.sqrt(d2) - ffCore) / ffW;
                bm = 1 - t * t * (3 - 2 * t);
              }
              if (sel) {
                const mx = wx - sel.x, my = wy - sel.y;
                if (mx < 0 || my < 0 || mx >= sel.w || my >= sel.h) continue;
                const sm = sel.mask[my * sel.w + mx] / 255;
                if (sm <= 0) continue;
                bm = sm * bm;
              }
              mask = bm * pressure;
            }
            if (mask <= 0.0001) continue;

            // pesi bilineari del reticolo low per questo pixel (condivisi
            // da blur e pull)
            const fx = (wx - csx + 0.5) * invK - 0.5;
            let ix0 = Math.floor(fx);
            const tx = fx - ix0;
            let ix1 = ix0 + 1;
            if (ix0 < 0) { ix0 = 0; ix1 = 0; }
            else if (ix1 >= lowW) ix1 = lowW - 1;
            const w00 = (1 - tx) * wyA, w10 = tx * wyA, w01 = (1 - tx) * wyB, w11 = tx * wyB;
            const a0 = rowA + ix0 * 4, a1 = rowA + ix1 * 4;
            const b0 = rowB + ix0 * 4, b1 = rowB + ix1 * 4;

            const cr = chunk ? chunk.data[di] : 0;
            const cg = chunk ? chunk.data[di + 1] : 0;
            const cb = chunk ? chunk.data[di + 2] : 0;
            const ca = chunk ? chunk.data[di + 3] : 0;
            let nr = cr, ng = cg, nb = cb, na = ca;
            if (lowBlur) {
              const ba = lowBlur[a0 + 3] * w00 + lowBlur[a1 + 3] * w10 + lowBlur[b0 + 3] * w01 + lowBlur[b1 + 3] * w11;
              const blurMask = mask * blurOpacity * (1 - drag);
              if (na !== 0 || ba > 0.0001) {
                const br = lowBlur[a0] * w00 + lowBlur[a1] * w10 + lowBlur[b0] * w01 + lowBlur[b1] * w11;
                const bg = lowBlur[a0 + 1] * w00 + lowBlur[a1 + 1] * w10 + lowBlur[b0 + 1] * w01 + lowBlur[b1 + 1] * w11;
                const bb = lowBlur[a0 + 2] * w00 + lowBlur[a1 + 2] * w10 + lowBlur[b0 + 2] * w01 + lowBlur[b1 + 2] * w11;
                na = i255(na + (ba - na) * blurMask);
                nr = Math.min(i255(nr + (br - nr) * blurMask), na);
                ng = Math.min(i255(ng + (bg - ng) * blurMask), na);
                nb = Math.min(i255(nb + (bb - nb) * blurMask), na);
              }
            }
            if (lowPull) {
              const dragMask = drag * mask;
              if (dragMask > 0.0001) {
                const ta = lowPull[a0 + 3] * w00 + lowPull[a1 + 3] * w10 + lowPull[b0 + 3] * w01 + lowPull[b1 + 3] * w11;
                if (ca === 0 && ta <= 0.0001 && !lowBlur) continue;
                const tr = lowPull[a0] * w00 + lowPull[a1] * w10 + lowPull[b0] * w01 + lowPull[b1] * w11;
                const tg = lowPull[a0 + 1] * w00 + lowPull[a1 + 1] * w10 + lowPull[b0 + 1] * w01 + lowPull[b1 + 1] * w11;
                const tb = lowPull[a0 + 2] * w00 + lowPull[a1 + 2] * w10 + lowPull[b0 + 2] * w01 + lowPull[b1 + 2] * w11;
                nr = i255(nr + (tr - nr) * dragMask);
                ng = i255(ng + (tg - ng) * dragMask);
                nb = i255(nb + (tb - nb) * dragMask);
                na = i255(na + (ta - na) * dragMask);
                nr = Math.min(nr, na);
                ng = Math.min(ng, na);
                nb = Math.min(nb, na);
              }
            }
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
   * Bbox pixel-exact del contenuto nel rect. Vista u32 (parola 0 = pixel
   * trasparente premultiplied) e per riga solo primo/ultimo non-zero:
   * sulle righe dense sono ~2 tocchi, il centro non si scansiona.
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
   */
  _contentBounds(x, y, w, h) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    forEachChunkInRect(this.store, x, y, x + w - 1, y + h - 1, false,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const u = new Uint32Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length >> 2);
        for (let ly = ly0; ly <= ly1; ly++) {
          const row = ly << CHUNK_SHIFT;
          let a = lx0, b = lx1;
          while (a <= b && u[row + a] === 0) a++;
          if (a > b) continue;
          while (u[row + b] === 0) b--;
          const wy = oy + ly;
          if (wy < y0) y0 = wy;
          if (wy > y1) y1 = wy;
          if (ox + a < x0) x0 = ox + a;
          if (ox + b > x1) x1 = ox + b;
        }
      });
    return x1 < x0 ? null : { x0, y0, x1, y1 };
  }

  /**
   * Bbox a granularita' CHUNK dei chunk esistenti nel rect (clampata al
   * rect), null se nessuno. O(min(chunk nel rect, chunk nello store)).
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @returns {{x0:number,y0:number,x1:number,y1:number}|null}
   */
  _chunkContentBounds(x, y, w, h) {
    const xr = x + w - 1, yr = y + h - 1;
    const cx0 = x >> CHUNK_SHIFT, cy0 = y >> CHUNK_SHIFT;
    const cx1 = xr >> CHUNK_SHIFT, cy1 = yr >> CHUNK_SHIFT;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.store.map.size) {
      for (const c of this.store.map.values()) {
        if (c.cx < cx0 || c.cx > cx1 || c.cy < cy0 || c.cy > cy1) continue;
        if (c.cx < bx0) bx0 = c.cx;
        if (c.cx > bx1) bx1 = c.cx;
        if (c.cy < by0) by0 = c.cy;
        if (c.cy > by1) by1 = c.cy;
      }
    } else {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          if (!this.store.map.has(chunkKey(cx, cy))) continue;
          if (cx < bx0) bx0 = cx;
          if (cx > bx1) bx1 = cx;
          if (cy < by0) by0 = cy;
          if (cy > by1) by1 = cy;
        }
      }
    }
    if (bx1 < bx0) return null;
    return {
      x0: Math.max(x, bx0 << CHUNK_SHIFT),
      y0: Math.max(y, by0 << CHUNK_SHIFT),
      x1: Math.min(xr, (bx1 << CHUNK_SHIFT) + CHUNK - 1),
      y1: Math.min(yr, (by1 << CHUNK_SHIFT) + CHUNK - 1),
    };
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
    const sel = this.selMask;
    const ffCore = this.ffCore, ffCore2 = this.ffCore2, ffCut2 = this.ffCut2, ffW = this.ffW;
    const sw4 = sw * 4;

    // Il pull dello smudge ha offset sorgente COSTANTE dentro il dab: parte
    // frazionaria e pesi bilineari uguali per ogni pixel (stesso trucco di
    // motionBlurBuffer). Nella regione "fast" i 3 tap leggono src a offset
    // fissi da si; sul bordo dello snapshot si ricade sul campionatore
    // generico, che gestisce clamp e fuori-buffer.
    let cD = 0, cW00 = 0, cW10 = 0, cW01 = 0, cW11 = 0;
    let aD = 0, aW00 = 0, aW10 = 0, aW01 = 0, aW11 = 0;
    let bD = 0, bW00 = 0, bW10 = 0, bW01 = 0, bW11 = 0;
    let fwx0 = 1, fwx1 = 0, fwy0 = 1, fwy1 = 0; // regione fast (mondo), vuota di default
    if (hasSmudge) {
      const oCX = -dirX * dragOffset, oCY = -dirY * dragOffset;
      const oAX = oCX + perpX * crossStep, oAY = oCY + perpY * crossStep;
      const oBX = oCX - perpX * crossStep, oBY = oCY - perpY * crossStep;
      const xC = Math.floor(oCX), yC = Math.floor(oCY);
      const xA = Math.floor(oAX), yA = Math.floor(oAY);
      const xB = Math.floor(oBX), yB = Math.floor(oBY);
      const txC = oCX - xC, tyC = oCY - yC;
      const txA = oAX - xA, tyA = oAY - yA;
      const txB = oBX - xB, tyB = oBY - yB;
      cD = (yC * sw + xC) * 4;
      cW00 = (1 - txC) * (1 - tyC); cW10 = txC * (1 - tyC);
      cW01 = (1 - txC) * tyC; cW11 = txC * tyC;
      aD = (yA * sw + xA) * 4;
      aW00 = (1 - txA) * (1 - tyA); aW10 = txA * (1 - tyA);
      aW01 = (1 - txA) * tyA; aW11 = txA * tyA;
      bD = (yB * sw + xB) * 4;
      bW00 = (1 - txB) * (1 - tyB); bW10 = txB * (1 - tyB);
      bW01 = (1 - txB) * tyB; bW11 = txB * tyB;
      // pixel sicuro se per ogni tap la cella bilineare [x0, x0+1] sta nel buffer
      fwx0 = sx + Math.max(-xC, -xA, -xB);
      fwx1 = sx + sw - 2 - Math.max(xC, xA, xB);
      fwy0 = sy + Math.max(-yC, -yA, -yB);
      fwy1 = sy + sh - 2 - Math.max(yC, yA, yB);
    }
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
          const ddy = wy + 0.5 - cy;
          const dy2 = ddy * ddy;
          let di = ((ly << CHUNK_SHIFT) + lx0) * 4;
          let si = ((wy - sy) * sw + (ox + lx0 - sx)) * 4;
          for (let lx = lx0; lx <= lx1; lx++, di += 4, si += 4) {
            const wx = ox + lx;
            let mask;
            if (stamp) {
              mask = this._maskAt(wx, wy, cx, cy, stamp) * pressure;
            } else {
              // falloff circolare inline (stessa matematica di _maskAt, ma
              // banda testata in distanza quadrata e sqrt solo nella banda)
              const ddx = wx + 0.5 - cx;
              const d2 = ddx * ddx + dy2;
              if (d2 >= ffCut2) continue;
              let bm;
              if (d2 <= ffCore2) {
                bm = 1;
              } else {
                const t = (Math.sqrt(d2) - ffCore) / ffW;
                bm = 1 - t * t * (3 - 2 * t);
              }
              if (sel) {
                const mx = wx - sel.x, my = wy - sel.y;
                if (mx < 0 || my < 0 || mx >= sel.w || my >= sel.h) continue;
                const sm = sel.mask[my * sel.w + mx] / 255;
                if (sm <= 0) continue;
                bm = sm * bm;
              }
              mask = bm * pressure;
            }
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
                let tr, tg, tb, ta;
                if (wx >= fwx0 && wx <= fwx1 && wy >= fwy0 && wy <= fwy1) {
                  // path fast: 3 tap bilineari fusi a indici/pesi costanti
                  const iC = si + cD, iA = si + aD, iB = si + bD;
                  tr = (src[iC] * cW00 + src[iC + 4] * cW10 + src[iC + sw4] * cW01 + src[iC + sw4 + 4] * cW11) * 0.6
                    + (src[iA] * aW00 + src[iA + 4] * aW10 + src[iA + sw4] * aW01 + src[iA + sw4 + 4] * aW11) * 0.2
                    + (src[iB] * bW00 + src[iB + 4] * bW10 + src[iB + sw4] * bW01 + src[iB + sw4 + 4] * bW11) * 0.2;
                  tg = (src[iC + 1] * cW00 + src[iC + 5] * cW10 + src[iC + sw4 + 1] * cW01 + src[iC + sw4 + 5] * cW11) * 0.6
                    + (src[iA + 1] * aW00 + src[iA + 5] * aW10 + src[iA + sw4 + 1] * aW01 + src[iA + sw4 + 5] * aW11) * 0.2
                    + (src[iB + 1] * bW00 + src[iB + 5] * bW10 + src[iB + sw4 + 1] * bW01 + src[iB + sw4 + 5] * bW11) * 0.2;
                  tb = (src[iC + 2] * cW00 + src[iC + 6] * cW10 + src[iC + sw4 + 2] * cW01 + src[iC + sw4 + 6] * cW11) * 0.6
                    + (src[iA + 2] * aW00 + src[iA + 6] * aW10 + src[iA + sw4 + 2] * aW01 + src[iA + sw4 + 6] * aW11) * 0.2
                    + (src[iB + 2] * bW00 + src[iB + 6] * bW10 + src[iB + sw4 + 2] * bW01 + src[iB + sw4 + 6] * bW11) * 0.2;
                  ta = (src[iC + 3] * cW00 + src[iC + 7] * cW10 + src[iC + sw4 + 3] * cW01 + src[iC + sw4 + 7] * cW11) * 0.6
                    + (src[iA + 3] * aW00 + src[iA + 7] * aW10 + src[iA + sw4 + 3] * aW01 + src[iA + sw4 + 7] * aW11) * 0.2
                    + (src[iB + 3] * bW00 + src[iB + 7] * bW10 + src[iB + sw4 + 3] * bW01 + src[iB + sw4 + 7] * bW11) * 0.2;
                } else {
                  const sourceX = wx + 0.5 - dirX * dragOffset;
                  const sourceY = wy + 0.5 - dirY * dragOffset;
                  this._samplePremulInto(src, sw, sh, sx, sy, sourceX, sourceY, pulled);
                  this._samplePremulInto(src, sw, sh, sx, sy, sourceX + perpX * crossStep, sourceY + perpY * crossStep, sideA);
                  this._samplePremulInto(src, sw, sh, sx, sy, sourceX - perpX * crossStep, sourceY - perpY * crossStep, sideB);
                  tr = pulled[0] * 0.6 + sideA[0] * 0.2 + sideB[0] * 0.2;
                  tg = pulled[1] * 0.6 + sideA[1] * 0.2 + sideB[1] * 0.2;
                  tb = pulled[2] * 0.6 + sideA[2] * 0.2 + sideB[2] * 0.2;
                  ta = pulled[3] * 0.6 + sideA[3] * 0.2 + sideB[3] * 0.2;
                }
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
   * @returns {{size:number, half:number, mask:Uint8Array, ptr:number}|null}
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
