// Fallback Canvas2D dietro la stessa interfaccia del renderer WebGL.
// Ogni chunk ha un piccolo canvas; putImageData solo sui chunk sporchi.
// I dati sono premultiplied, ImageData vuole straight alpha: si de-premoltiplica
// in upload (è un fallback: correttezza prima di tutto).

import { CHUNK } from './store.js';

export class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.kind = 'Canvas2D';
    this.ok = true;
    this.contextLost = false;
    this.texCount = 0;
    this.uploadsThisFrame = 0;
    this.ctx = canvas.getContext('2d');
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._img = new ImageData(CHUNK, CHUNK);
  }

  resize(wCss, hCss, dpr) {
    const w = Math.round(wCss * dpr), h = Math.round(hCss * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  trackStores() {}

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

  disposeChunkTex(chunk) {
    if (chunk.c2d) { chunk.c2d = null; this.texCount--; }
  }

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

  evict(docStore, camera, maxTex = 1024) {
    if (this.texCount <= maxTex) return;
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const chunk of docStore.map.values()) {
      if (this.texCount <= maxTex) break;
      if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) continue;
      if (chunk.c2d) { chunk.c2d = null; chunk.texDirty = true; this.texCount--; }
    }
  }

  render(camera, docStore, strokeStore, strokeOpacity, eraserLive) {
    const ctx = this.ctx;
    const dpr = camera.dpr;
    this.uploadsThisFrame = 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // mondo -> schermo device
    ctx.setTransform(
      camera.zoom * dpr, 0, 0, camera.zoom * dpr,
      (-camera.x * camera.zoom + camera.w * 0.5) * dpr,
      (-camera.y * camera.zoom + camera.h * 0.5) * dpr
    );
    ctx.imageSmoothingEnabled = camera.zoom < 1;

    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);

    for (const chunk of docStore.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.c2d || chunk.texDirty) this._uploadNow(chunk);
      ctx.drawImage(chunk.c2d, chunk.cx * CHUNK, chunk.cy * CHUNK);
    }

    if (strokeStore.map.size > 0) {
      ctx.globalAlpha = strokeOpacity;
      // nota: destination-out qui taglierebbe anche lo sfondo bianco appena
      // disegnato — visivamente equivalente perché lo sfondo pagina è bianco
      ctx.globalCompositeOperation = eraserLive ? 'destination-out' : 'source-over';
      for (const chunk of strokeStore.map.values()) {
        if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
        if (!chunk.c2d || chunk.texDirty) this._uploadNow(chunk);
        ctx.drawImage(chunk.c2d, chunk.cx * CHUNK, chunk.cy * CHUNK);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  get gpuBytes() { return this.texCount * CHUNK * CHUNK * 4; }
}
