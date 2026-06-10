// PRESENTAZIONE — la GPU è un proiettore.
// Texture 256x256 per chunk, texSubImage2D solo dei chunk sporchi,
// pan/zoom = matrice nel vertex shader, zero pixel CPU toccati dalla vista.

import { CHUNK } from './store.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./camera.js').Camera} Camera */

const VS_CHUNK = `
attribute vec2 aPos;
uniform mat3 uMat;
uniform vec2 uOrigin;
varying vec2 vUv;
void main() {
  vUv = aPos;
  vec3 p = uMat * vec3(uOrigin + aPos * ${CHUNK}.0, 1.0);
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

// Preview live della gomma: il chunk documento viene attenuato dalla
// maschera alpha dello stroke buffer, senza toccare lo sfondo.
const FS_ERASE = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float k = 1.0 - texture2D(uMask, vUv).a * uAlpha;
  gl_FragColor = texture2D(uTex, vUv) * k;
}`;

const VS_GRID = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_GRID = `
precision highp float;
uniform vec2 uCenter;
uniform float uZoom;
uniform vec2 uView;   // viewport in px CSS
uniform float uDpr;
void main() {
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec2 world = vec2(
    (frag.x - uView.x * 0.5) / uZoom + uCenter.x,
    ((uView.y - frag.y) - uView.y * 0.5) / uZoom + uCenter.y
  );
  float cell = 64.0;
  vec2 f = fract(world / cell) - 0.5;
  float distPx = length(f) * cell * uZoom;       // distanza dal punto in px schermo
  float dot1 = 1.0 - smoothstep(1.0, 2.2, distPx);
  float fade = clamp((uZoom * cell - 7.0) / 30.0, 0.0, 1.0) * 0.16;
  vec3 col = mix(vec3(1.0), vec3(0.25, 0.27, 0.33), dot1 * fade);
  gl_FragColor = vec4(col, 1.0);
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
    /** @type {ChunkStore[]} */
    this._stores = [];
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

    // desynchronized: presentazione a bassa latenza (Chrome). Può lampeggiare
    // su alcuni sistemi: il frame va a schermo fuori sincrono col loop.
    // Safari ignora l'opzione. Configurabile dal toggle nel pannello.
    const ctxOpts = {
      alpha: false, antialias: false, depth: false, stencil: false,
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
      for (const st of this._stores) st.dropRendererResources();
      this.contextLost = false;
    });

    this._init();
  }

  _init() {
    const gl = this.gl;
    this.progChunk = link(gl, VS_CHUNK, FS_CHUNK);
    this.progGrid = link(gl, VS_GRID, FS_GRID);
    this.progErase = link(gl, VS_CHUNK, FS_ERASE);

    this.uMat = gl.getUniformLocation(this.progChunk, 'uMat');
    this.uOrigin = gl.getUniformLocation(this.progChunk, 'uOrigin');
    this.uAlpha = gl.getUniformLocation(this.progChunk, 'uAlpha');
    this.uTex = gl.getUniformLocation(this.progChunk, 'uTex');
    this.eMat = gl.getUniformLocation(this.progErase, 'uMat');
    this.eOrigin = gl.getUniformLocation(this.progErase, 'uOrigin');
    this.eAlpha = gl.getUniformLocation(this.progErase, 'uAlpha');
    this.eTex = gl.getUniformLocation(this.progErase, 'uTex');
    this.eMask = gl.getUniformLocation(this.progErase, 'uMask');
    this.gCenter = gl.getUniformLocation(this.progGrid, 'uCenter');
    this.gZoom = gl.getUniformLocation(this.progGrid, 'uZoom');
    this.gView = gl.getUniformLocation(this.progGrid, 'uView');
    this.gDpr = gl.getUniformLocation(this.progGrid, 'uDpr');

    // quad 0..1 condiviso
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    // quad fullscreen clip-space
    this.quadFS = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFS);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

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

  /** @param {...ChunkStore} stores */
  trackStores(...stores) { this._stores = stores; }

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
      this.texCount++;
    }
    return chunk.tex;
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

  /**
   * @param {Camera} camera @param {ChunkStore} docStore @param {ChunkStore} strokeStore
   * @param {number} strokeOpacity @param {boolean} eraserLive
   */
  render(camera, docStore, strokeStore, strokeOpacity, eraserLive) {
    if (this.contextLost) return;
    const gl = this.gl;
    this.uploadsThisFrame = 0;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // sfondo + griglia procedurale (coordinate mondo nel fragment)
    gl.disable(gl.BLEND);
    gl.useProgram(this.progGrid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFS);
    const aPosG = gl.getAttribLocation(this.progGrid, 'aPos');
    gl.enableVertexAttribArray(aPosG);
    gl.vertexAttribPointer(aPosG, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.gCenter, camera.x, camera.y);
    gl.uniform1f(this.gZoom, camera.zoom);
    gl.uniform2f(this.gView, camera.w, camera.h);
    gl.uniform1f(this.gDpr, camera.dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // chunk del documento (premultiplied source-over)
    gl.useProgram(this.progChunk);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.progChunk, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(this.uMat, false, camera.matrix());
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);

    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (eraserLive && strokeStore.map.size > 0) {
      // gomma live: doc * (1 - maschera stroke), sfondo intatto
      gl.useProgram(this.progErase);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      const aPosE = gl.getAttribLocation(this.progErase, 'aPos');
      gl.enableVertexAttribArray(aPosE);
      gl.vertexAttribPointer(aPosE, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(this.eMat, false, camera.matrix());
      gl.uniform1f(this.eAlpha, strokeOpacity);
      gl.uniform1i(this.eTex, 0);
      gl.uniform1i(this.eMask, 1);
      for (const chunk of docStore.map.values()) {
        if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
        gl.activeTexture(gl.TEXTURE0);
        if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
        const sc = strokeStore.getByKey(chunk.key);
        if (sc && (!sc.tex || sc.texDirty)) this._uploadNow(sc);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, sc && sc.tex ? sc.tex : this.dummyTex);
        gl.uniform2f(this.eOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.activeTexture(gl.TEXTURE0);
    } else {
      gl.uniform1f(this.uAlpha, 1);
      this._drawStore(docStore, cx0, cy0, cx1, cy1);
      if (strokeStore.map.size > 0) {
        gl.uniform1f(this.uAlpha, strokeOpacity);
        this._drawStore(strokeStore, cx0, cy0, cx1, cy1);
      }
    }
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
      gl.uniform2f(this.uOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Tiene la VRAM limitata: oltre maxTex, le texture dei chunk fuori
  // schermo vengono liberate (verranno ricaricate on-demand alla vista).
  /** @param {ChunkStore} docStore @param {Camera} camera @param {number} [maxTex] */
  evict(docStore, camera, maxTex = 1024) {
    if (this.contextLost || this.texCount <= maxTex) return;
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const chunk of docStore.map.values()) {
      if (this.texCount <= maxTex) break;
      if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) continue;
      if (chunk.tex) {
        this.gl.deleteTexture(chunk.tex);
        chunk.tex = null;
        chunk.texDirty = true;
        this.texCount--;
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
