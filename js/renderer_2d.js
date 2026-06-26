// Renderer Canvas2D dietro la stessa interfaccia del renderer WebGL.
// Due ruoli: fallback completo quando WebGL manca, e renderer dei gruppi
// raster SOPRA un livello testo (piani 2D del sandwich). Ogni chunk ha un
// piccolo canvas; putImageData solo sui chunk sporchi. I dati sono
// premultiplied, ImageData vuole straight alpha: si de-premoltiplica in
// upload (pochi chunk per frame, solo quelli toccati).

import { CHUNK } from './store.js';
import { warpGridWorld, warpPads, warpFoldOrder, perspGridWorld } from './warp.js';
import { snapshotRect, halftoneBuffer } from './fx_blur.js';

// Metodi di fusione -> globalCompositeOperation (semantica W3C nativa del
// canvas, sessioni incluse). 'add' usa 'lighter': somma anche l'alpha
// (αs+αb invece di αs+αb·(1-αs)) — differenza visibile solo su backdrop
// semitrasparente, accettata per il fallback. Condivisa con l'export.
/** @type {Record<string, GlobalCompositeOperation>} */
export const C2D_MODE = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen',
  add: 'lighter', overlay: 'overlay', softlight: 'soft-light',
  darken: 'darken', lighten: 'lighten', difference: 'difference',
};

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */

// Triangolo con texture su canvas 2D: clip sul triangolo destinazione +
// drawImage con l'affine sorgente→destinazione. Il clip è espanso di ~0.5px
// dal baricentro: il suo antialias lascerebbe cuciture trasparenti tra
// triangoli adiacenti (lieve overdraw sul bordo: invisibile, ed è solo
// l'ANTEPRIMA del fallback — il commit CPU è seamless per costruzione).
/**
 * @param {CanvasRenderingContext2D} ctx @param {HTMLCanvasElement} img
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {number} x2 @param {number} y2
 * @param {number} u0 @param {number} v0 @param {number} u1 @param {number} v1
 * @param {number} u2 @param {number} v2
 */
function texTri(ctx, img, x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2) {
  const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (den === 0) return;
  const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / den;
  const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / den;
  const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / den;
  const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / den;
  const e = x0 - a * u0 - c * v0, f = y0 - b * u0 - d * v0;
  const gx = (x0 + x1 + x2) / 3, gy = (y0 + y1 + y2) / 3;
  ctx.save();
  ctx.beginPath();
  let dx = x0 - gx, dy = y0 - gy, L = Math.hypot(dx, dy) || 1;
  ctx.moveTo(x0 + dx / L * 0.5, y0 + dy / L * 0.5);
  dx = x1 - gx; dy = y1 - gy; L = Math.hypot(dx, dy) || 1;
  ctx.lineTo(x1 + dx / L * 0.5, y1 + dy / L * 0.5);
  dx = x2 - gx; dy = y2 - gy; L = Math.hypot(dx, dy) || 1;
  ctx.lineTo(x2 + dx / L * 0.5, y2 + dy / L * 0.5);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

export class Canvas2DRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.kind = 'Canvas2D';
    this.ok = true;
    this.contextLost = false;
    // interfaccia comune col renderer GL (TextQuadCache li legge)
    /** @type {WebGLRenderingContext|null} */
    this.gl = null;
    this.ctxGen = 0;
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
    // canvas piatto della sessione di trasformazione (vedi TransformFrame)
    /** @type {HTMLCanvasElement|null} */
    this._tfCanvas = null;
    this._tfId = 0;
    // bake della sessione Warp: superficie cotta in un canvas mondo-1:1,
    // rifatta solo quando griglia/affine cambiano (vedi _ensureWarpCanvas)
    /** @type {HTMLCanvasElement|null} */
    this._warpCanvas = null;
    this._warpSig = '';
    this._warpX = 0;
    this._warpY = 0;
    this._warpEmpty = false;
    // sessione Effetti: canvas piatto + copia sfocata via ctx.filter
    /** @type {HTMLCanvasElement|null} */
    this._fxFlat = null;
    /** @type {HTMLCanvasElement|null} */
    this._fxBlur = null;
    this._fxId = 0;
    /** @type {string} */
    this._fxKey = '';
    // gruppi di ritaglio: base + figli composti in un canvas schermo (i
    // figli con source-atop = il colore sostituisce, l'alpha resta della
    // base — semantica Photoshop), poi UN blit. Allocato solo se serve.
    /** @type {HTMLCanvasElement|null} */
    this._clipTemp = null;
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
    if (chunk.c2d) { chunk.c2d = null; chunk.c2dDirty = true; this.texCount--; }
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
    chunk.c2dDirty = false;
    this.uploadsThisFrame++;
  }

  /** @param {ChunkStore[]} stores @param {Camera} camera @param {number} [maxTex] @param {Set<ChunkStore>|null} [covered] */
  evict(stores, camera, maxTex = 1024, covered = null) {
    if (this.texCount <= maxTex) return;
    // prima gli store coperti da un quad proxy: non si disegnano affatto,
    // i loro canvas vanno via anche se dentro la vista
    if (covered !== null) {
      for (const store of stores) {
        if (!covered.has(store)) continue;
        for (const chunk of store.map.values()) {
          if (this.texCount <= maxTex) return;
          if (chunk.c2d) { chunk.c2d = null; chunk.c2dDirty = true; this.texCount--; }
        }
      }
    }
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const store of stores) {
      if (covered !== null && covered.has(store)) continue; // già svuotati sopra
      for (const chunk of store.map.values()) {
        if (this.texCount <= maxTex) return;
        if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) continue;
        if (chunk.c2d) { chunk.c2d = null; chunk.c2dDirty = true; this.texCount--; }
      }
    }
  }

  /**
   * Disegna i livelli raster del gruppo dal basso verso l'alto (opacità per
   * livello, stroke live sopra il livello attivo, gomma via scratch).
   * proxies: i quad restano affare del bottom WebGL, ma lo skip va onorato
   * anche qui — un piano del pool non deve ridipingere per-chunk i layer di
   * un board già coperto dal suo quad.
   * transform: il livello in sessione Sposta/Trasforma si disegna come
   * canvas piatto unico con setTransform e clip al board (vedi renderer_gl).
   * fx: il livello in sessione Effetti si disegna come canvas sfocato unico
   * (blur via ctx.filter dove supportato), clippato al board.
   * textQuads: i livelli testo NON in editing stanno nella pila e si
   * disegnano qui come bake (drawImage del canvas cotto, clip al board).
   * @param {Camera} camera @param {Layer[]} layers @param {number} activeId
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {import('./board_proxy.js').ProxyFrame|null} [proxies]
   * @param {import('./renderer_gl.js').TransformFrame|null} [transform]
   * @param {import('./renderer_gl.js').FxFrame|null} [fx]
   * @param {import('./text_quad.js').TextQuadCache|null} [textQuads]
   */
  render(camera, layers, activeId, strokeStore, strokeOpacity, eraserLive, proxies = null, transform = null, fx = null, textQuads = null) {
    const ctx = this.ctx;
    const dpr = camera.dpr;
    this.uploadsThisFrame = 0;
    // il bake di warp/prospettiva può pesare quanto un board: via appena la
    // sessione finisce o torna in modalità affine
    if (this._warpCanvas && (transform === null ||
      (!transform.warp && !transform.persp && !transform.puppet))) {
      this._warpCanvas = null;
      this._warpSig = '';
    }

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
    // nitidi per il lavoro di dettaglio (stessa soglia del renderer WebGL).
    // Qualità 'high': il default 'low' è bilineare sul livello 0 e in
    // minificazione (zoom di lavoro < 1) sgrana i tratti sottili — 'high'
    // usa il downscale multi-pass, l'equivalente delle mipmap del path GL.
    ctx.imageSmoothingEnabled = camera.zoom <= 3.8;
    ctx.imageSmoothingQuality = 'high';

    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);

    const skip = proxies ? proxies.skip : null;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (skip !== null && skip.has(layer.id)) continue;
      if (layer.kind === 'text') {
        // testo cotto alla sua posizione nella pila (l'SVG vivo dei testi
        // in editing ha il suo piano, non passa da qui)
        if (textQuads) {
          const q = textQuads.quadFor(layer.id, camera);
          if (q) this._drawTextQuad(ctx, layer, q);
        }
        continue;
      }
      if (layer.kind !== 'raster') continue;
      // membro di un gruppo di ritaglio: lo disegna il pass della sua base
      // (base nascosta o a opacità 0 = gruppo invisibile)
      if (layer.clip && layer.clipBase) continue;
      // base di un gruppo? figli = catena contigua di clippati sopra
      let gEnd = i + 1;
      while (gEnd < layers.length &&
        layers[gEnd].clip && layers[gEnd].clipBase === layer) gEnd++;
      if (gEnd > i + 1) {
        this._renderClipGroup(ctx, layers, i, gEnd, activeId, strokeStore,
          strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1);
        i = gEnd - 1;
        continue;
      }
      // metodo di fusione del livello: composite nativo del canvas (i
      // sotto-path — chunk, scratch live, quad di sessione — lo ereditano)
      const mode = layer.mode || 'normal';
      if (mode !== 'normal') ctx.globalCompositeOperation = C2D_MODE[mode] || 'source-over';
      this._drawLayerInto(ctx, layer, activeId, strokeStore, strokeOpacity,
        eraserLive, transform, fx, cx0, cy0, cx1, cy1);
      if (mode !== 'normal') ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  // Disegna UN livello (chunk, gomma live o quad di sessione) sul ctx dato,
  // con la SUA opacità. Il composite mode del ctx è del chiamante (gruppi:
  // source-atop per i figli — _drawErase/_drawTransformQuad non lo toccano).
  /**
   * @param {CanvasRenderingContext2D} ctx @param {Layer} layer
   * @param {number} activeId @param {ChunkStore|null} strokeStore
   * @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {import('./renderer_gl.js').TransformFrame|null} transform
   * @param {import('./renderer_gl.js').FxFrame|null} fx
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawLayerInto(ctx, layer, activeId, strokeStore, strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1) {
    if (transform !== null && transform.layerId === layer.id) {
      // sessione Sposta/Trasforma: canvas piatto unico con la matrice
      this._drawTransformQuad(ctx, transform, layer.opacity);
      return;
    }
    if (fx !== null && fx.layerId === layer.id) {
      // sessione Effetti: canvas cotto unico, clippato al board
      this._drawFxQuad(ctx, fx, layer.opacity);
      return;
    }
    const live = layer.id === activeId && strokeStore && strokeStore.map.size > 0;
    if (live && eraserLive) {
      this._drawErase(ctx, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1, layer.opacity);
      return;
    }
    if (live && (layer.opacity < 1 || (layer.mode && layer.mode !== 'normal'))) {
      // livello semitrasparente o con metodo di fusione: tratto e chunk si
      // compongono nello scratch e si presentano in UN draw — l'over
      // diretto qui sotto applicherebbe opacità o modo due volte dove si
      // sovrappongono (tratto più opaco live che al commit)
      this._drawPaintLive(ctx, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1, layer.opacity);
      return;
    }
    ctx.globalAlpha = layer.opacity;
    this._drawStore(ctx, layer.store, cx0, cy0, cx1, cy1);
    if (live) {
      // a opacità 1 l'over diretto coincide già col commit
      ctx.globalAlpha = strokeOpacity * layer.opacity;
      this._drawStore(ctx, strokeStore, cx0, cy0, cx1, cy1);
    }
    ctx.globalAlpha = 1;
  }

  // Gruppo di ritaglio, semantica Photoshop: base + figli composti in un
  // canvas schermo — la base con source-over (la SUA alpha è la forma del
  // gruppo), ogni figlio con source-atop (out = src·dst_a + dst·(1−src_a):
  // l'alpha resta della base e il colore del figlio SOSTITUISCE quello
  // della base dove copre — niente frange del colore della base) — poi UN
  // blit sul piano. Tratti live e sessioni passano dagli stessi path.
  /**
   * @param {CanvasRenderingContext2D} ctx @param {Layer[]} layers
   * @param {number} baseIdx @param {number} endIdx
   * @param {number} activeId @param {ChunkStore|null} strokeStore
   * @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {import('./renderer_gl.js').TransformFrame|null} transform
   * @param {import('./renderer_gl.js').FxFrame|null} fx
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _renderClipGroup(ctx, layers, baseIdx, endIdx, activeId, strokeStore, strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1) {
    const w = this.canvas.width, h = this.canvas.height;
    if (!this._clipTemp) this._clipTemp = document.createElement('canvas');
    if (this._clipTemp.width !== w || this._clipTemp.height !== h) {
      this._clipTemp.width = w;
      this._clipTemp.height = h;
    }
    const smooth = ctx.imageSmoothingEnabled;
    const t = this._clipTemp.getContext('2d');
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'source-over';
    t.globalAlpha = 1;
    t.clearRect(0, 0, w, h);
    t.imageSmoothingEnabled = smooth;
    t.imageSmoothingQuality = 'high';
    this._drawLayerInto(t, layers[baseIdx], activeId, strokeStore,
      strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1);
    t.globalCompositeOperation = 'source-atop';
    for (let j = baseIdx + 1; j < endIdx; j++) {
      const child = layers[j];
      if (!child.visible || child.opacity <= 0) continue;
      this._drawLayerInto(t, child, activeId, strokeStore,
        strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1);
    }
    t.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const wasSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false; // blit 1:1, niente filtro
    // il metodo di fusione della BASE si applica qui, al gruppo intero
    const mode = layers[baseIdx].mode || 'normal';
    if (mode !== 'normal') ctx.globalCompositeOperation = C2D_MODE[mode] || 'source-over';
    ctx.drawImage(this._clipTemp, 0, 0);
    if (mode !== 'normal') ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = wasSmooth;
  }

  // Quad di un livello testo cotto (TextQuadCache): il canvas del bake
  // disegnato nel suo rettangolo mondo, clippato al board del livello — lo
  // stesso clip dell'SVG. Smoothing sempre attivo: contenuto vettoriale a
  // risoluzione finita, NEAREST lo squadretterebbe a zoom alto.
  /** @param {CanvasRenderingContext2D} ctx @param {Layer} layer @param {import('./text_quad.js').TextQuadEntry} q */
  _drawTextQuad(ctx, layer, q) {
    const s = this._s, tx = this._tx, ty = this._ty;
    ctx.save();
    const b = layer.clipBoard;
    if (b) {
      ctx.beginPath();
      ctx.rect(b.x * s + tx, b.y * s + ty, b.w * s, b.h * s);
      ctx.clip();
    }
    ctx.globalAlpha = layer.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.drawImage(q.canvas, q.x, q.y, q.w, q.h);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Quad della sessione Sposta/Trasforma su un ctx qualsiasi (schermo o
  // temp del ritaglio), con l'alpha dato e il clip al board.
  /** @param {CanvasRenderingContext2D} ctx @param {import('./renderer_gl.js').TransformFrame} transform @param {number} alpha */
  _drawTransformQuad(ctx, transform, alpha) {
    this._ensureTransformCanvas(transform);
    if (transform.warp || transform.persp || transform.puppet) {
      // modalità Warp/Prospettiva/Marionetta: il quad affine non basta, si
      // disegna il bake della superficie (triangoli in un canvas mondo-1:1)
      this._drawTransformWarp(ctx, transform, alpha);
      return;
    }
    const t = transform.m, s = this._s, tx = this._tx, ty = this._ty;
    ctx.save();
    ctx.beginPath();
    ctx.rect(transform.clip.x0 * s + tx, transform.clip.y0 * s + ty,
      (transform.clip.x1 + 1 - transform.clip.x0) * s,
      (transform.clip.y1 + 1 - transform.clip.y0) * s);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true; // la rotazione vuole il filtro
    // device ∘ T: il drawImage riceve coordinate MONDO
    ctx.setTransform(s * t[0], s * t[1], s * t[2], s * t[3], s * t[4] + tx, s * t[5] + ty);
    ctx.drawImage(this._tfCanvas, transform.x, transform.y);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Bake della sessione Warp: la superficie campionata a triangoli in un
  // canvas mondo-1:1 (8 suddivisioni per cella), rifatto SOLO quando
  // griglia o affine cambiano — a firma ferma ogni ridisegno del piano
  // costa un drawImage, come il quad. Questo è il path di anteprima dei
  // piani 2D/fallback; il commit esatto è warpStore.
  /** @param {import('./renderer_gl.js').TransformFrame} tf */
  _ensureWarpCanvas(tf) {
    const w = tf.warp;
    const sig = `${tf.id}|${w.ver}|${tf.m.join(',')}`;
    if (this._warpSig === sig && this._warpCanvas) return;
    this._warpSig = sig;
    this._warpEmpty = true;
    const segs = Math.min(40, w.n * 8);
    const pads = warpPads(w.bx, w.by, w.bw, w.bh, tf.x, tf.y, tf.w, tf.h);
    const bbox = { x: w.bx, y: w.by, w: w.bw, h: w.bh };
    const u0 = -pads.l / w.bw, u1 = 1 + pads.r / w.bw;
    const v0 = -pads.t / w.bh, v1 = 1 + pads.b / w.bh;
    const G = warpGridWorld(w.pts, w.n, bbox, tf.m, u0, u1, v0, v1, segs, segs);
    let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
    for (let k = 0; k < (segs + 1) * (segs + 1) * 2; k += 2) {
      const X = G[k], Y = G[k + 1];
      if (X < dx0) dx0 = X; if (X > dx1) dx1 = X;
      if (Y < dy0) dy0 = Y; if (Y > dy1) dy1 = Y;
    }
    dx0 = Math.max(Math.floor(dx0) - 1, tf.clip.x0);
    dy0 = Math.max(Math.floor(dy0) - 1, tf.clip.y0);
    dx1 = Math.min(Math.ceil(dx1) + 2, tf.clip.x1 + 1); // esclusivo
    dy1 = Math.min(Math.ceil(dy1) + 2, tf.clip.y1 + 1);
    if (dx0 >= dx1 || dy0 >= dy1) return; // tutto fuori dal board
    this._warpEmpty = false;
    const cnv = this._warpCanvas || (this._warpCanvas = document.createElement('canvas'));
    cnv.width = dx1 - dx0; // il set azzera il canvas
    cnv.height = dy1 - dy0;
    this._warpX = dx0;
    this._warpY = dy0;
    const bctx = cnv.getContext('2d');
    bctx.setTransform(1, 0, 0, 1, -dx0, -dy0);
    // coordinate sorgente dei nodi nello spazio dell'hull (il canvas piatto)
    const su = new Float64Array(segs + 1), sv = new Float64Array(segs + 1);
    const ew = w.bw + pads.l + pads.r, eh = w.bh + pads.t + pads.b;
    for (let j = 0; j <= segs; j++) su[j] = w.bx - pads.l + ew * j / segs - tf.x;
    for (let i = 0; i <= segs; i++) sv[i] = w.by - pads.t + eh * i / segs - tf.y;
    const cols = segs + 1, img = this._tfCanvas;
    // celle dal meno al più spostato: nelle pieghe la parte trascinata sopra
    const order = warpFoldOrder(G, bbox, tf.m, u0, u1, v0, v1, segs, segs);
    for (const cell of order) {
      const i = (cell / segs) | 0, j = cell % segs;
      const a = (i * cols + j) * 2, b = a + 2, c = a + cols * 2, d = c + 2;
      texTri(bctx, img, G[a], G[a + 1], G[b], G[b + 1], G[d], G[d + 1],
        su[j], sv[i], su[j + 1], sv[i], su[j + 1], sv[i + 1]);
      texTri(bctx, img, G[a], G[a + 1], G[d], G[d + 1], G[c], G[c + 1],
        su[j], sv[i], su[j + 1], sv[i + 1], su[j], sv[i + 1]);
    }
  }

  // Bake della sessione Prospettiva: come il warp ma con i nodi campionati
  // sull'omografia (32 suddivisioni: dentro ogni cella il mapping affine di
  // texTri devia dal prospettico esatto di frazioni di px) e senza ordine
  // di piega — il quad è convesso per costruzione, non si accavalla mai.
  // Questo è il path di anteprima dei piani 2D/fallback; il commit esatto
  // è perspStore.
  /** @param {import('./renderer_gl.js').TransformFrame} tf */
  _ensurePerspCanvas(tf) {
    const p = tf.persp;
    const sig = `p|${tf.id}|${p.ver}|${tf.m.join(',')}`;
    if (this._warpSig === sig && this._warpCanvas) return;
    this._warpSig = sig;
    this._warpEmpty = true;
    const segs = 32;
    const pads = warpPads(p.bx, p.by, p.bw, p.bh, tf.x, tf.y, tf.w, tf.h);
    const bbox = { x: p.bx, y: p.by, w: p.bw, h: p.bh };
    const u0 = -pads.l / p.bw, u1 = 1 + pads.r / p.bw;
    const v0 = -pads.t / p.bh, v1 = 1 + pads.b / p.bh;
    const G = perspGridWorld(p.q, bbox, tf.m, u0, u1, v0, v1, segs, segs);
    let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
    for (let k = 0; k < (segs + 1) * (segs + 1) * 2; k += 2) {
      const X = G[k], Y = G[k + 1];
      if (X < dx0) dx0 = X; if (X > dx1) dx1 = X;
      if (Y < dy0) dy0 = Y; if (Y > dy1) dy1 = Y;
    }
    dx0 = Math.max(Math.floor(dx0) - 1, tf.clip.x0);
    dy0 = Math.max(Math.floor(dy0) - 1, tf.clip.y0);
    dx1 = Math.min(Math.ceil(dx1) + 2, tf.clip.x1 + 1); // esclusivo
    dy1 = Math.min(Math.ceil(dy1) + 2, tf.clip.y1 + 1);
    if (dx0 >= dx1 || dy0 >= dy1) return; // tutto fuori dal board
    this._warpEmpty = false;
    const cnv = this._warpCanvas || (this._warpCanvas = document.createElement('canvas'));
    cnv.width = dx1 - dx0; // il set azzera il canvas
    cnv.height = dy1 - dy0;
    this._warpX = dx0;
    this._warpY = dy0;
    const bctx = cnv.getContext('2d');
    bctx.setTransform(1, 0, 0, 1, -dx0, -dy0);
    // coordinate sorgente dei nodi nello spazio dell'hull (il canvas piatto):
    // lineari nel dominio (u,v), la prospettiva sta tutta nelle posizioni
    const su = new Float64Array(segs + 1), sv = new Float64Array(segs + 1);
    const ew = p.bw + pads.l + pads.r, eh = p.bh + pads.t + pads.b;
    for (let j = 0; j <= segs; j++) su[j] = p.bx - pads.l + ew * j / segs - tf.x;
    for (let i = 0; i <= segs; i++) sv[i] = p.by - pads.t + eh * i / segs - tf.y;
    const cols = segs + 1, img = this._tfCanvas;
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < segs; j++) {
        const a = (i * cols + j) * 2, b = a + 2, c = a + cols * 2, d = c + 2;
        texTri(bctx, img, G[a], G[a + 1], G[b], G[b + 1], G[d], G[d + 1],
          su[j], sv[i], su[j + 1], sv[i], su[j + 1], sv[i + 1]);
        texTri(bctx, img, G[a], G[a + 1], G[d], G[d + 1], G[c], G[c + 1],
          su[j], sv[i], su[j + 1], sv[i + 1], su[j], sv[i + 1]);
      }
    }
  }

  // Bake della sessione Marionetta: i triangoli della mesh deformata cotti
  // in un canvas mondo-1:1 nell'ordine di piega/profondità del solver,
  // rifatto SOLO quando la deformazione cambia. Anteprima dei piani 2D e
  // del fallback; il commit esatto è puppetStore.
  /** @param {import('./renderer_gl.js').TransformFrame} tf */
  _ensurePuppetCanvas(tf) {
    const p = tf.puppet;
    const sig = `pp|${tf.id}|${p.ver}`;
    if (this._warpSig === sig && this._warpCanvas) return;
    this._warpSig = sig;
    this._warpEmpty = true;
    const def = p.pos;
    let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
    for (let k = 0; k < def.length; k += 2) {
      const X = def[k], Y = def[k + 1];
      if (X < dx0) dx0 = X; if (X > dx1) dx1 = X;
      if (Y < dy0) dy0 = Y; if (Y > dy1) dy1 = Y;
    }
    dx0 = Math.max(Math.floor(dx0) - 1, tf.clip.x0);
    dy0 = Math.max(Math.floor(dy0) - 1, tf.clip.y0);
    dx1 = Math.min(Math.ceil(dx1) + 2, tf.clip.x1 + 1); // esclusivo
    dy1 = Math.min(Math.ceil(dy1) + 2, tf.clip.y1 + 1);
    if (dx0 >= dx1 || dy0 >= dy1) return; // tutto fuori dal board
    this._warpEmpty = false;
    const cnv = this._warpCanvas || (this._warpCanvas = document.createElement('canvas'));
    cnv.width = dx1 - dx0; // il set azzera il canvas
    cnv.height = dy1 - dy0;
    this._warpX = dx0;
    this._warpY = dy0;
    const bctx = cnv.getContext('2d');
    bctx.setTransform(1, 0, 0, 1, -dx0, -dy0);
    const img = this._tfCanvas, tris = p.tris, pos0 = p.pos0;
    for (let q = 0; q < p.order.length; q++) {
      const t = p.order[q] * 3;
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      texTri(bctx, img,
        def[a * 2], def[a * 2 + 1], def[b * 2], def[b * 2 + 1], def[c * 2], def[c * 2 + 1],
        pos0[a * 2] - tf.x, pos0[a * 2 + 1] - tf.y,
        pos0[b * 2] - tf.x, pos0[b * 2 + 1] - tf.y,
        pos0[c * 2] - tf.x, pos0[c * 2 + 1] - tf.y);
    }
  }

  // Sessione Warp/Prospettiva/Marionetta su un ctx qualsiasi: il bake
  // disegnato come il quad, alpha dato e clip al board.
  /** @param {CanvasRenderingContext2D} ctx @param {import('./renderer_gl.js').TransformFrame} tf @param {number} alpha */
  _drawTransformWarp(ctx, tf, alpha) {
    if (tf.puppet) this._ensurePuppetCanvas(tf);
    else if (tf.persp) this._ensurePerspCanvas(tf);
    else this._ensureWarpCanvas(tf);
    if (this._warpEmpty) return;
    const s = this._s, tx = this._tx, ty = this._ty;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tf.clip.x0 * s + tx, tf.clip.y0 * s + ty,
      (tf.clip.x1 + 1 - tf.clip.x0) * s,
      (tf.clip.y1 + 1 - tf.clip.y0) * s);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.drawImage(this._warpCanvas, this._warpX, this._warpY);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Quad della sessione Effetti su un ctx qualsiasi, alpha dato, clip al board.
  /** @param {CanvasRenderingContext2D} ctx @param {import('./renderer_gl.js').FxFrame} fx @param {number} alpha */
  _drawFxQuad(ctx, fx, alpha) {
    this._ensureFxCanvas(fx);
    const s = this._s, tx = this._tx, ty = this._ty;
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx.clip.x0 * s + tx, fx.clip.y0 * s + ty,
      (fx.clip.x1 + 1 - fx.clip.x0) * s,
      (fx.clip.y1 + 1 - fx.clip.y0) * s);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.drawImage(this._fxBlur, fx.x, fx.y);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Canvas piatto di uno store nel rettangolo mondo [x,y,w,h] chunk-aligned:
  // i chunk de-premoltiplicati (ImageData vuole straight) copiati fianco a
  // fianco. Riusa cnv se passato. Condiviso da trasformazione ed effetti.
  /** @param {ChunkStore} store @param {number} x @param {number} y @param {number} w @param {number} h @param {HTMLCanvasElement|null} cnv */
  _flattenStore(store, x, y, w, h, cnv) {
    const out = cnv || document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    for (const c of store.map.values()) {
      const ox = c.cx * CHUNK - x, oy = c.cy * CHUNK - y;
      if (ox < 0 || oy < 0 || ox + CHUNK > w || oy + CHUNK > h) continue;
      const src = c.data, dst = this._img.data;
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
      ctx.putImageData(this._img, ox, oy);
    }
    return out;
  }

  // Canvas piatto della sessione di trasformazione, una volta per sessione
  // (id = timbro).
  /** @param {import('./renderer_gl.js').TransformFrame} tf */
  _ensureTransformCanvas(tf) {
    if (this._tfId === tf.id && this._tfCanvas) return;
    this._tfCanvas = this._flattenStore(tf.store, tf.x, tf.y, tf.w, tf.h, this._tfCanvas);
    this._tfId = tf.id;
  }

  // Sessione Effetti: piatto una volta per sessione, copia rifatta solo
  // quando i parametri cambiano. Gaussiana usa ctx.filter; halftone usa il
  // fallback CPU sui pixel premultiplied; gli altri effetti qui restano
  // nitidi in ANTEPRIMA — il commit CPU (fx_blur) è comunque corretto.
  // Questo renderer è il fallback raro senza WebGL.
  /** @param {import('./renderer_gl.js').FxFrame} fx */
  _ensureFxCanvas(fx) {
    if (this._fxId !== fx.id || !this._fxFlat) {
      this._fxFlat = this._flattenStore(fx.store, fx.x, fx.y, fx.w, fx.h, this._fxFlat);
      this._fxId = fx.id;
      this._fxKey = '';
    }
    const key = `${fx.kind}|${fx.sigma}|${fx.radius}|${fx.spacing}|${fx.angle}|${fx.colorMix}|${fx.x}|${fx.y}`;
    if (this._fxKey === key && this._fxBlur) return;
    const cnv = this._fxBlur || document.createElement('canvas');
    cnv.width = fx.w; // il set azzera il canvas
    cnv.height = fx.h;
    const bctx = cnv.getContext('2d');
    if (fx.kind === 'halftone') {
      const data = snapshotRect(fx.store, fx.x, fx.y, fx.w, fx.h);
      halftoneBuffer(data, fx.w, fx.h, fx.radius, fx.spacing || fx.radius * 2, fx.angle, fx.colorMix,
        fx.x - fx.clip.x0, fx.y - fx.clip.y0);
      this._putPremul(cnv, data, fx.w, fx.h);
    } else {
      const blurrable = fx.kind === 'gauss' && 'filter' in bctx;
      if (blurrable) bctx.filter = `blur(${fx.sigma}px)`;
      bctx.drawImage(this._fxFlat, 0, 0);
      if (blurrable) bctx.filter = 'none';
    }
    this._fxBlur = cnv;
    this._fxKey = key;
  }

  /** @param {HTMLCanvasElement} cnv @param {Uint8ClampedArray} src @param {number} w @param {number} h */
  _putPremul(cnv, src, w, h) {
    const ctx = cnv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const dst = img.data;
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
    ctx.putImageData(img, 0, 0);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx @param {ChunkStore} store
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawStore(ctx, store, cx0, cy0, cx1, cy1) {
    const s = this._s, tx = this._tx, ty = this._ty;
    for (const chunk of store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.c2d || chunk.c2dDirty) this._uploadNow(chunk);
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
  // layerAlpha: opacità da applicare (1 nel temp del ritaglio: lì l'opacità
  // del livello si applica al blit finale).
  /**
   * @param {CanvasRenderingContext2D} ctx @param {Layer} layer
   * @param {ChunkStore} strokeStore @param {number} strokeOpacity
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   * @param {number} layerAlpha
   */
  _drawErase(ctx, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1, layerAlpha) {
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratch.width = CHUNK;
      this._scratch.height = CHUNK;
    }
    const sctx = this._scratch.getContext('2d');
    const s = this._s, tx = this._tx, ty = this._ty;
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.c2d || chunk.c2dDirty) this._uploadNow(chunk);
      const sc = strokeStore.getByKey(chunk.key);
      if (sc && (!sc.c2d || sc.c2dDirty)) this._uploadNow(sc);
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
      ctx.globalAlpha = layerAlpha;
      const x0 = Math.round(chunk.cx * CHUNK * s + tx);
      const y0 = Math.round(chunk.cy * CHUNK * s + ty);
      const x1 = Math.round((chunk.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((chunk.cy + 1) * CHUNK * s + ty);
      ctx.drawImage(this._scratch, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
  }

  // Pennello live su livello semitrasparente: (tratto over chunk) composto
  // nello scratch, poi blit × opacità — la stessa matematica di commitChunk,
  // anteprima identica al commit. Due over separati sul canvas
  // applicherebbero l'opacità due volte dove si sovrappongono.
  /**
   * @param {CanvasRenderingContext2D} ctx @param {Layer} layer
   * @param {ChunkStore} strokeStore @param {number} strokeOpacity
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   * @param {number} layerAlpha
   */
  _drawPaintLive(ctx, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1, layerAlpha) {
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratch.width = CHUNK;
      this._scratch.height = CHUNK;
    }
    const sctx = this._scratch.getContext('2d');
    const s = this._s, tx = this._tx, ty = this._ty;
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.c2d || chunk.c2dDirty) this._uploadNow(chunk);
      const x0 = Math.round(chunk.cx * CHUNK * s + tx);
      const y0 = Math.round(chunk.cy * CHUNK * s + ty);
      const x1 = Math.round((chunk.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((chunk.cy + 1) * CHUNK * s + ty);
      const sc = strokeStore.getByKey(chunk.key);
      if (!sc) {
        // niente tratto qui: blit diretto del chunk
        ctx.globalAlpha = layerAlpha;
        ctx.drawImage(chunk.c2d, x0, y0, x1 - x0, y1 - y0);
        continue;
      }
      if (!sc.c2d || sc.c2dDirty) this._uploadNow(sc);
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, CHUNK, CHUNK);
      sctx.drawImage(chunk.c2d, 0, 0);
      sctx.globalAlpha = strokeOpacity;
      sctx.drawImage(sc.c2d, 0, 0);
      sctx.globalAlpha = 1;
      ctx.globalAlpha = layerAlpha;
      ctx.drawImage(this._scratch, x0, y0, x1 - x0, y1 - y0);
    }
    // tratto su zone vuote del livello: l'over diretto è già esatto
    ctx.globalAlpha = strokeOpacity * layerAlpha;
    for (const sc of strokeStore.map.values()) {
      if (sc.cx < cx0 || sc.cx > cx1 || sc.cy < cy0 || sc.cy > cy1) continue;
      if (layer.store.getByKey(sc.key)) continue; // già composto sopra
      if (!sc.c2d || sc.c2dDirty) this._uploadNow(sc);
      const x0 = Math.round(sc.cx * CHUNK * s + tx);
      const y0 = Math.round(sc.cy * CHUNK * s + ty);
      const x1 = Math.round((sc.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((sc.cy + 1) * CHUNK * s + ty);
      ctx.drawImage(sc.c2d, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
  }

  dispose() {}
}
