// PRESENTAZIONE — la GPU è un proiettore.
// Texture 256x256 per chunk, texSubImage2D solo dei chunk sporchi,
// pan/zoom = matrice nel vertex shader, zero pixel CPU toccati dalla vista.
// Multi-livello: i layer raster del proprio gruppo si disegnano dal basso
// verso l'alto con l'opacità del livello; il buffer dello stroke live si
// inserisce subito sopra il livello attivo. Canvas trasparente (alpha:true):
// la griglia di sfondo è CSS, sotto tutti i piani.

import { CHUNK } from './store.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */

// Sopra questo zoom la magnificazione mostra i pixel nitidi (NEAREST, per il
// lavoro di dettaglio); fino a qui l'ingrandimento è ammorbidito (LINEAR).
const MAG_NEAREST_ZOOM = 3.8;

// uSize: lato del quad in px mondo (CHUNK per i tile; dimensioni del board
// per i quad proxy dello zoom-out).
const VS_CHUNK = `
attribute vec2 aPos;
uniform mat3 uMat;
uniform vec2 uOrigin;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vUv = aPos;
  vec3 p = uMat * vec3(uOrigin + aPos * uSize, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FS_CHUNK = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv) * uAlpha;
}`;

// Preview live della gomma: il chunk del livello attivo viene attenuato
// dalla maschera alpha dello stroke buffer, senza toccare ciò che sta sotto.
// uLayerA = opacità del livello (moltiplica il risultato).
const FS_ERASE = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uAlpha;
uniform float uLayerA;
varying vec2 vUv;
void main() {
  float k = 1.0 - texture2D(uMask, vUv).a * uAlpha;
  gl_FragColor = texture2D(uTex, vUv) * k * uLayerA;
}`;

/** @param {WebGLRenderingContext} gl @param {number} type @param {string} src */
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

/** @param {WebGLRenderingContext} gl @param {string} vs @param {string} fs */
function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class GLRenderer {
  /** @param {HTMLCanvasElement} canvas @param {{desynchronized?: boolean}} [opts] */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.kind = 'WebGL';
    this.contextLost = false;
    this.texCount = 0;
    this.uploadsThisFrame = 0;
    /** @type {() => ChunkStore[]} provider degli store vivi (context restore) */
    this._storesFn = () => [];
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._wantMips = false;    // zoom < 1 nel frame corrente
    this._wantNearest = true;  // zoom > MAG_NEAREST_ZOOM nel frame corrente

    // desynchronized: presentazione a bassa latenza (Chrome). Può lampeggiare
    // su alcuni sistemi: il frame va a schermo fuori sincrono col loop.
    // Safari ignora l'opzione. Configurabile dal toggle nel pannello.
    // alpha: true — il canvas è un piano trasparente sopra la griglia CSS
    // (e sopra eventuali livelli testo più in basso nella pila).
    const ctxOpts = {
      alpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false,
      desynchronized: opts && opts.desynchronized !== undefined ? opts.desynchronized : true,
      powerPreference: 'high-performance',
    };
    // WebGL2 quando c'è: serve UNPACK_ROW_LENGTH per caricare solo il
    // sotto-rettangolo sporco del chunk. Gli shader (GLSL ES 1.0) e il resto
    // dell'API sono identici; su WebGL1 si torna all'upload del chunk intero.
    this.gl = /** @type {WebGLRenderingContext} */ (
      canvas.getContext('webgl2', ctxOpts) ||
      canvas.getContext('webgl', ctxOpts) || canvas.getContext('experimental-webgl', ctxOpts));
    if (!this.gl) { this.ok = false; return; }
    this.ok = true;
    this.isGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    this.kind = this.isGL2 ? 'WebGL2' : 'WebGL';

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // la CPU è la verità: si ricrea tutto dai buffer.
      // dropRendererResources copre anche i chunk nel pool: le loro texture
      // appartengono al contesto perso e ribinderle sarebbe INVALID_OPERATION.
      this._init();
      for (const st of this._storesFn()) st.dropRendererResources();
      this.contextLost = false;
    });

    this._init();
  }

  _init() {
    const gl = this.gl;
    // generazione del contesto: le risorse esterne (proxy dei board) la
    // confrontano per dimenticare ciò che apparteneva a un contesto morto
    this.ctxGen = (this.ctxGen || 0) + 1;
    this.progChunk = link(gl, VS_CHUNK, FS_CHUNK);
    this.progErase = link(gl, VS_CHUNK, FS_ERASE);

    this.uMat = gl.getUniformLocation(this.progChunk, 'uMat');
    this.uOrigin = gl.getUniformLocation(this.progChunk, 'uOrigin');
    this.uSize = gl.getUniformLocation(this.progChunk, 'uSize');
    this.uAlpha = gl.getUniformLocation(this.progChunk, 'uAlpha');
    this.uTex = gl.getUniformLocation(this.progChunk, 'uTex');
    this.eMat = gl.getUniformLocation(this.progErase, 'uMat');
    this.eOrigin = gl.getUniformLocation(this.progErase, 'uOrigin');
    this.eSize = gl.getUniformLocation(this.progErase, 'uSize');
    this.eAlpha = gl.getUniformLocation(this.progErase, 'uAlpha');
    this.eLayerA = gl.getUniformLocation(this.progErase, 'uLayerA');
    this.eTex = gl.getUniformLocation(this.progErase, 'uTex');
    this.eMask = gl.getUniformLocation(this.progErase, 'uMask');

    // quad 0..1 condiviso
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.texCount = 0;

    // texture 1x1 trasparente per i chunk senza maschera gomma
    this.dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(4));
  }

  /** @param {number} wCss @param {number} hCss @param {number} dpr */
  resize(wCss, hCss, dpr) {
    const w = Math.round(wCss * dpr), h = Math.round(hCss * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** @param {() => ChunkStore[]} fn provider degli store da risanare al context restore */
  trackStores(fn) { this._storesFn = fn; }

  /** @param {Chunk} chunk */
  _ensureTex(chunk) {
    const gl = this.gl;
    if (!chunk.tex) {
      chunk.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CHUNK, CHUNK, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      chunk.texDirty = true;
      chunk.mips = false;
      chunk.mipOn = false;
      chunk.magNear = true; // la texture nasce con MAG_FILTER = NEAREST
      this.texCount++;
    }
    return chunk.tex;
  }

  // Filtri di campionamento in funzione dello zoom, aggiornati pigramente
  // per chunk (con la texture già bound sull'unità attiva):
  //   - zoom < 1 (minificazione): LINEAR campiona solo 4 texel e i tratti
  //     sottili si sgranano/spezzano -> mipmap, (ri)generate solo per i
  //     chunk cambiati e solo quando servono;
  //   - zoom 1..MAG_NEAREST_ZOOM: ingrandimento ammorbidito (MAG LINEAR);
  //   - oltre: pixel nitidi (MAG NEAREST) per il lavoro di dettaglio.
  /** @param {Chunk} chunk */
  _applyMips(chunk) {
    const gl = this.gl;
    if (this._wantMips) {
      if (!chunk.mips) {
        gl.generateMipmap(gl.TEXTURE_2D); // CHUNK=256 è POT: ok anche su WebGL1
        chunk.mips = true;
      }
      if (!chunk.mipOn) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        chunk.mipOn = true;
      }
    } else if (chunk.mipOn) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      chunk.mipOn = false;
    }
    if (this._wantNearest !== chunk.magNear) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER,
        this._wantNearest ? gl.NEAREST : gl.LINEAR);
      chunk.magNear = this._wantNearest;
    }
  }

  // Upload dei soli chunk sporchi. Su WebGL2, se la texture è già valida,
  // carica solo il rettangolo sporco accumulato (UNPACK_ROW_LENGTH = stride
  // del chunk): un pennello piccolo passa da 256KB a pochi KB per chunk.
  // Ritorna i byte caricati.
  /** @param {ChunkStore} store */
  uploadDirty(store) {
    if (this.contextLost) { store.dirty.clear(); return 0; }
    const gl = this.gl;
    let bytes = 0;
    let rowLenSet = false;
    for (const chunk of store.dirty) {
      if (!store.map.has(chunk.key)) continue; // rilasciato nel frattempo
      if (this.isGL2 && chunk.tex && !chunk.texDirty && chunk.dirX1 >= chunk.dirX0) {
        const x0 = chunk.dirX0, y0 = chunk.dirY0;
        const w = chunk.dirX1 - x0 + 1, h = chunk.dirY1 - y0 + 1;
        if (!rowLenSet) {
          /** @type {WebGL2RenderingContext} */ (gl).pixelStorei(
            WebGL2RenderingContext.UNPACK_ROW_LENGTH, CHUNK);
          rowLenSet = true;
        }
        gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
        // vista che parte dal primo pixel del rect; le righe seguono lo
        // stride del chunk via ROW_LENGTH (byteOffset: memoria wasm)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array(chunk.data.buffer,
            chunk.data.byteOffset + (y0 * CHUNK + x0) * 4,
            ((h - 1) * CHUNK + w) * 4));
        bytes += w * h * 4;
        this.uploadsThisFrame++;
        chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
        chunk.mips = false; // il livello 0 è cambiato: catena mip stantia
      } else {
        if (rowLenSet) {
          // _uploadNow carica il chunk intero: stride di default
          /** @type {WebGL2RenderingContext} */ (gl).pixelStorei(
            WebGL2RenderingContext.UNPACK_ROW_LENGTH, 0);
          rowLenSet = false;
        }
        this._uploadNow(chunk);
        bytes += chunk.data.length;
      }
    }
    if (rowLenSet) {
      /** @type {WebGL2RenderingContext} */ (gl).pixelStorei(
        WebGL2RenderingContext.UNPACK_ROW_LENGTH, 0);
    }
    store.dirty.clear();
    return bytes;
  }

  /** @param {Chunk} chunk */
  disposeChunkTex(chunk) {
    if (chunk.tex) {
      if (!this.contextLost) this.gl.deleteTexture(chunk.tex);
      chunk.tex = null;
      this.texCount--;
    }
  }

  // Lega programma chunk + quad + uniform comuni (anche dopo il pass gomma).
  /** @param {Camera} camera */
  _bindChunkProg(camera) {
    const gl = this.gl;
    gl.useProgram(this.progChunk);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.progChunk, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(this.uMat, false, camera.matrix());
    gl.uniform2f(this.uSize, CHUNK, CHUNK);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Disegna i livelli raster del gruppo dal basso verso l'alto, con
   * l'opacità del livello. Lo stroke live entra subito sopra il livello
   * attivo; con la gomma il livello attivo è attenuato dalla maschera.
   * I layer nel set proxies.skip non si disegnano: al loro posto ci sono i
   * quad piatti dei board (proxies.quads), uno per board — lo zoom-out non
   * paga più un draw e una texture per ogni chunk.
   * @param {Camera} camera @param {Layer[]} layers @param {number} activeId
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {import('./board_proxy.js').ProxyFrame|null} [proxies]
   */
  render(camera, layers, activeId, strokeStore, strokeOpacity, eraserLive, proxies = null) {
    if (this.contextLost) return;
    const gl = this.gl;
    this.uploadsThisFrame = 0;
    this._wantMips = camera.zoom < 1;
    this._wantNearest = camera.zoom > MAG_NEAREST_ZOOM;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // piano trasparente: la griglia CSS (e i piani sotto) restano visibili
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._bindChunkProg(camera);

    // quad dei board proxati (i board non si sovrappongono: ordine libero)
    if (proxies && proxies.quads.length > 0) {
      gl.uniform1f(this.uAlpha, 1);
      for (const q of proxies.quads) {
        gl.uniform2f(this.uSize, q.w, q.h);
        gl.uniform2f(this.uOrigin, q.x, q.y);
        gl.bindTexture(gl.TEXTURE_2D, q.tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.uniform2f(this.uSize, CHUNK, CHUNK);
    }
    const skip = proxies ? proxies.skip : null;

    for (const layer of layers) {
      if (layer.kind !== 'raster' || !layer.visible || layer.opacity <= 0) continue;
      if (skip !== null && skip.has(layer.id)) continue;
      const live = layer.id === activeId && strokeStore && strokeStore.map.size > 0;
      if (live && eraserLive) {
        this._drawErase(camera, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1);
        this._bindChunkProg(camera); // il pass gomma ha cambiato programma
      } else {
        gl.uniform1f(this.uAlpha, layer.opacity);
        this._drawStore(layer.store, cx0, cy0, cx1, cy1);
        if (live) {
          // visivamente il tratto appartiene al livello: ne eredita l'opacità
          gl.uniform1f(this.uAlpha, strokeOpacity * layer.opacity);
          this._drawStore(strokeStore, cx0, cy0, cx1, cy1);
        }
      }
    }
  }

  // Gomma live sul livello attivo: chunk * (1 - maschera stroke) * opacità.
  /**
   * @param {Camera} camera @param {Layer} layer @param {ChunkStore} strokeStore
   * @param {number} strokeOpacity
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawErase(camera, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    gl.useProgram(this.progErase);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPosE = gl.getAttribLocation(this.progErase, 'aPos');
    gl.enableVertexAttribArray(aPosE);
    gl.vertexAttribPointer(aPosE, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(this.eMat, false, camera.matrix());
    gl.uniform2f(this.eSize, CHUNK, CHUNK);
    gl.uniform1f(this.eAlpha, strokeOpacity);
    gl.uniform1f(this.eLayerA, layer.opacity);
    gl.uniform1i(this.eTex, 0);
    gl.uniform1i(this.eMask, 1);
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      gl.activeTexture(gl.TEXTURE0);
      if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
      const sc = strokeStore.getByKey(chunk.key);
      if (sc && (!sc.tex || sc.texDirty)) this._uploadNow(sc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      this._applyMips(chunk);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sc && sc.tex ? sc.tex : this.dummyTex);
      if (sc && sc.tex) this._applyMips(sc);
      gl.uniform2f(this.eOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  // Upload immediato di un chunk la cui texture è assente o stantia
  // (eviction, pool, context restore). La CPU è la verità.
  /** @param {Chunk} chunk */
  _uploadNow(chunk) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._ensureTex(chunk));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length));
    chunk.texDirty = false;
    // il chunk intero è in texture: l'eventuale rect accumulato è coperto
    chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
    chunk.mips = false;
    this.uploadsThisFrame++;
  }

  /**
   * @param {ChunkStore} store
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawStore(store, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    for (const chunk of store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      this._applyMips(chunk);
      gl.uniform2f(this.uOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Tiene la VRAM limitata: oltre maxTex, le texture dei chunk fuori
  // schermo vengono liberate (verranno ricaricate on-demand alla vista).
  /** @param {ChunkStore[]} stores @param {Camera} camera @param {number} [maxTex] */
  evict(stores, camera, maxTex = 1024) {
    if (this.contextLost || this.texCount <= maxTex) return;
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const store of stores) {
      for (const chunk of store.map.values()) {
        if (this.texCount <= maxTex) return;
        if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) continue;
        if (chunk.tex) {
          this.gl.deleteTexture(chunk.tex);
          chunk.tex = null;
          chunk.texDirty = true;
          this.texCount--;
        }
      }
    }
  }

  // Il canvas sta per essere sostituito (cambio attributi di contesto):
  // rilascia il contesto subito invece di aspettare il GC dell'elemento.
  dispose() {
    if (!this.gl) return;
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }

  get gpuBytes() { return this.texCount * CHUNK * CHUNK * 4; }
}
