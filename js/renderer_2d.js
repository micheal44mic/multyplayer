// Renderer Canvas2D dietro la stessa interfaccia del renderer WebGL.
// Due ruoli: fallback completo quando WebGL manca, e renderer dei gruppi
// raster SOPRA un livello testo (piani 2D del sandwich). Ogni chunk ha un
// piccolo canvas; putImageData solo sui chunk sporchi. I dati sono
// premultiplied, ImageData vuole straight alpha: si de-premoltiplica in
// upload (pochi chunk per frame, solo quelli toccati).

import { CHUNK } from './store.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */

export class Canvas2DRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.kind = 'Canvas2D';
    this.ok = true;
    this.contextLost = false;
    this.texCount = 0;
    this.uploadsThisFrame = 0;
    this.ctx = canvas.getContext('2d');
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    // mondo -> schermo device del frame corrente (vedi render)
    this._s = 1; this._tx = 0; this._ty = 0;
    this._img = new ImageData(CHUNK, CHUNK);
    // scratch per la gomma live: chunk del livello attivo - maschera stroke,
    // composto fuori dal canvas principale per non bucare i livelli sotto
    /** @type {HTMLCanvasElement|null} */
    this._scratch = null;
  }

  /** @param {number} wCss @param {number} hCss @param {number} dpr */
  resize(wCss, hCss, dpr) {
    const w = Math.round(wCss * dpr), h = Math.round(hCss * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** @param {() => ChunkStore[]} _fn */
  trackStores(_fn) {}

  /** @param {ChunkStore} store */
  uploadDirty(store) {
    let bytes = 0;
    for (const chunk of store.dirty) {
      if (!store.map.has(chunk.key)) continue;
      this._uploadNow(chunk);
      bytes += chunk.data.length;
    }
    store.dirty.clear();
    return bytes;
  }

  /** @param {Chunk} chunk */
  disposeChunkTex(chunk) {
    if (chunk.c2d) { chunk.c2d = null; this.texCount--; }
  }

  /** @param {Chunk} chunk */
  _uploadNow(chunk) {
    if (!chunk.c2d) {
      chunk.c2d = document.createElement('canvas');
      chunk.c2d.width = CHUNK;
      chunk.c2d.height = CHUNK;
      this.texCount++;
    }
    const src = chunk.data, dst = this._img.data;
    for (let o = 0; o < src.length; o += 4) {
      const a = src[o + 3];
      if (a === 0) {
        dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0;
      } else {
        const inv = 255 / a;
        dst[o] = Math.min(255, src[o] * inv);
        dst[o + 1] = Math.min(255, src[o + 1] * inv);
        dst[o + 2] = Math.min(255, src[o + 2] * inv);
        dst[o + 3] = a;
      }
    }
    chunk.c2d.getContext('2d').putImageData(this._img, 0, 0);
    chunk.texDirty = false;
    this.uploadsThisFrame++;
  }

  /** @param {ChunkStore[]} stores @param {Camera} camera @param {number} [maxTex] */
  evict(stores, camera, maxTex = 1024) {
    if (this.texCount <= maxTex) return;
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const store of stores) {
      for (const chunk of store.map.values()) {
        if (this.texCount <= maxTex) return;
        if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) continue;
        if (chunk.c2d) { chunk.c2d = null; chunk.texDirty = true; this.texCount--; }
      }
    }
  }

  /**
   * Disegna i livelli raster del gruppo dal basso verso l'alto (opacità per
   * livello, stroke live sopra il livello attivo, gomma via scratch).
   * @param {Camera} camera @param {Layer[]} layers @param {number} activeId
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   */
  render(camera, layers, activeId, strokeStore, strokeOpacity, eraserLive) {
    const ctx = this.ctx;
    const dpr = camera.dpr;
    this.uploadsThisFrame = 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // piano trasparente: griglia CSS e piani sottostanti restano visibili
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // mondo -> schermo device, applicato PER CHUNK con bordi arrotondati e
    // condivisi tra vicini: con la transform frazionaria drawImage antialiasa
    // il bordo di ogni chunk verso il trasparente e tra chunk adiacenti resta
    // una cucitura di ~1px (si vede ciò che sta dietro). Coi bordi arrotondati
    // la copertura è piena per costruzione (errore < 1px, invisibile).
    this._s = camera.zoom * dpr;
    this._tx = (-camera.x * camera.zoom + camera.w * 0.5) * dpr;
    this._ty = (-camera.y * camera.zoom + camera.h * 0.5) * dpr;
    // liscio in minificazione e fino a 380% di ingrandimento; oltre, pixel
    // nitidi per il lavoro di dettaglio (stessa soglia del renderer WebGL)
    ctx.imageSmoothingEnabled = camera.zoom <= 3.8;

    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);

    for (const layer of layers) {
      if (layer.kind !== 'raster' || !layer.visible || layer.opacity <= 0) continue;
      const live = layer.id === activeId && strokeStore && strokeStore.map.size > 0;
      if (live && eraserLive) {
        this._drawErase(ctx, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1);
        continue;
      }
      ctx.globalAlpha = layer.opacity;
      this._drawStore(ctx, layer.store, cx0, cy0, cx1, cy1);
      if (live) {
        ctx.globalAlpha = strokeOpacity * layer.opacity;
        this._drawStore(ctx, strokeStore, cx0, cy0, cx1, cy1);
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx @param {ChunkStore} store
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawStore(ctx, store, cx0, cy0, cx1, cy1) {
    const s = this._s, tx = this._tx, ty = this._ty;
    for (const chunk of store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.c2d || chunk.texDirty) this._uploadNow(chunk);
      const x0 = Math.round(chunk.cx * CHUNK * s + tx);
      const y0 = Math.round(chunk.cy * CHUNK * s + ty);
      const x1 = Math.round((chunk.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((chunk.cy + 1) * CHUNK * s + ty);
      ctx.drawImage(chunk.c2d, x0, y0, x1 - x0, y1 - y0);
    }
  }

  // Gomma live: per ogni chunk visibile del livello attivo si compone
  // (chunk - maschera) in uno scratch e si presenta il risultato — il
  // destination-out non tocca mai i livelli già disegnati sotto.
  /**
   * @param {CanvasRenderingContext2D} ctx @param {Layer} layer
   * @param {ChunkStore} strokeStore @param {number} strokeOpacity
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawErase(ctx, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1) {
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratch.width = CHUNK;
      this._scratch.height = CHUNK;
    }
    const sctx = this._scratch.getContext('2d');
    const s = this._s, tx = this._tx, ty = this._ty;
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.c2d || chunk.texDirty) this._uploadNow(chunk);
      const sc = strokeStore.getByKey(chunk.key);
      if (sc && (!sc.c2d || sc.texDirty)) this._uploadNow(sc);
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, CHUNK, CHUNK);
      sctx.drawImage(chunk.c2d, 0, 0);
      if (sc && sc.c2d) {
        sctx.globalCompositeOperation = 'destination-out';
        sctx.globalAlpha = strokeOpacity;
        sctx.drawImage(sc.c2d, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
        sctx.globalAlpha = 1;
      }
      ctx.globalAlpha = layer.opacity;
      const x0 = Math.round(chunk.cx * CHUNK * s + tx);
      const y0 = Math.round(chunk.cy * CHUNK * s + ty);
      const x1 = Math.round((chunk.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((chunk.cy + 1) * CHUNK * s + ty);
      ctx.drawImage(this._scratch, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
  }

  dispose() {}

  get gpuBytes() { return this.texCount * CHUNK * CHUNK * 4; }
}
