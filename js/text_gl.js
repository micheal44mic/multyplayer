// EFFETTI TESTO SU GPU — tutti i parametri sono uniform.
// Una SDF (distanza firmata) della SOLA stringa di glifi, normalizzata in em,
// vive in una texture per livello: si rigenera solo quando cambiano testo,
// font o il bucket di corsa (vedi padEm). Estrusione 3D e ombra morbida sono
// UN draw su un quad: l'estrusione è uno sphere-march lungo la direzione
// (l'unione delle copie, senza disegnarle), il bordo è un offset di soglia
// sulla distanza, il blur è una rampa (su una SDF la sfocatura è gratis).
// Dimensione, bordo, angolo, distanza, blur e colore cambiano senza
// rigenerare niente: il costo è un draw call, qualità piena a ogni evento.
// La faccia frontale resta l'SVG vettoriale: qui si disegna solo ciò che
// sta dietro, dove la risoluzione finita della SDF è invisibile.

/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./text_layer.js').TextItem} TextItem */
/** @typedef {import('./text_layer.js').TextStyle} TextStyle */

/**
 * Cache SDF di un livello (vive su layer.blockSdf).
 * @typedef {Object} SdfEntry
 * @property {string} key
 * @property {number} gen generazione del contesto (context restore)
 * @property {WebGLTexture} tex
 * @property {number} w px texture
 * @property {number} h
 * @property {number} F corpo del font nella SDF (px per em)
 * @property {number} baseX ancora del testo nella texture (px)
 * @property {number} baseY baseline alfabetica nella texture (px)
 * @property {number} far spread del canale a lungo raggio (px sdf)
 */

const MAX_TEX_W = 2048;
const MAX_TEX_H = 1024;
const F_MAX = 96;   // px per em nella SDF: gli effetti stanno DIETRO al
const F_MIN = 12;   // testo vettoriale, non serve la risoluzione del device
const NEAR = 64;    // spread del canale fine (px sdf): copre bordo + AA
const MARCH_N = 48; // passi massimi dello sphere-march dell'estrusione

const VS = `
attribute vec2 aPos;
uniform vec4 uBox;
varying vec2 vW;
void main() {
  vW = uBox.xy + aPos * uBox.zw;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

// Distanze in px MONDO. Doppio canale: R = vicino (preciso, per bordo e
// antialias), G = lontano (per la corsa di estrusione e la coda del blur);
// si commuta dove il canale fine satura. uT0 esclude la faccia frontale
// (i pixel sotto al testo SVG: disegnarli creerebbe un alone sul fill).
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uSdf;
uniform vec2 uTexSize;
uniform vec2 uAnchorW;
uniform vec2 uAnchorT;
uniform float uScale;
uniform vec2 uSpread;
uniform float uStroke;
uniform vec2 uDir;
uniform float uDist;
uniform float uBlur;
uniform float uAA;
uniform float uT0;
uniform float uBlock;
uniform vec4 uColor;
varying vec2 vW;

float sd(vec2 w) {
  vec2 uv = (uAnchorT + (w - uAnchorW) * uScale) / uTexSize;
  vec2 s = texture2D(uSdf, uv).rg;
  float dn = (s.r - 0.5) * 2.0 * uSpread.x;
  float df = (s.g - 0.5) * 2.0 * uSpread.y;
  float d = abs(dn) < uSpread.x * 0.85 ? dn : df;
  return d / uScale - uStroke;
}

void main() {
  float dmin;
  if (uBlock > 0.5) {
    dmin = 1e6;
    float t = uT0;
    for (int i = 0; i < ${MARCH_N}; i++) {
      float d = sd(vW - uDir * t);
      dmin = min(dmin, d);
      if (d < -uAA) break;
      t += max(d, uDist * ${(1 / MARCH_N).toFixed(6)});
      if (t > uDist) {
        dmin = min(dmin, sd(vW - uDir * uDist));
        break;
      }
    }
  } else {
    dmin = sd(vW - uDir * uDist);
  }
  float a = uBlur > 0.0
    ? 1.0 - smoothstep(-uBlur, uBlur, dmin)
    : 1.0 - smoothstep(-0.75 * uAA, 0.75 * uAA, dmin);
  gl_FragColor = uColor * a;
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

// ---- distance transform esatta (Felzenszwalb–Huttenlocher) ---------------
// 1D sulle distanze al quadrato; 2D = colonne poi righe. Gira SOLO quando
// cambiano testo/font, mai durante i gesti: JS basta (un eventuale port nel
// core wasm SIMD è un'ottimizzazione, non un requisito).

/**
 * @param {Float32Array} f @param {Float32Array} d
 * @param {Int32Array} v @param {Float32Array} z @param {number} n
 */
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -1e30;
  z[1] = 1e30;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e30;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Scratch riusati fra le generazioni (grow-only).
/** @type {Float32Array} */ let _g1 = new Float32Array(0);
/** @type {Float32Array} */ let _g2 = new Float32Array(0);
/** @type {Float32Array} */ let _rf = new Float32Array(0);
/** @type {Float32Array} */ let _rd = new Float32Array(0);
/** @type {Int32Array} */ let _rv = new Int32Array(0);
/** @type {Float32Array} */ let _rz = new Float32Array(0);

/** @param {Float32Array} grid @param {number} w @param {number} h */
function edt2d(grid, w, h) {
  const n = Math.max(w, h);
  if (_rf.length < n) {
    _rf = new Float32Array(n);
    _rd = new Float32Array(n);
    _rv = new Int32Array(n);
    _rz = new Float32Array(n + 1);
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) _rf[y] = grid[y * w + x];
    edt1d(_rf, _rd, _rv, _rz, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = _rd[y];
  }
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) _rf[x] = grid[off + x];
    edt1d(_rf, _rd, _rv, _rz, w);
    for (let x = 0; x < w; x++) grid[off + x] = _rd[x];
  }
}

// Canvas di servizio per misura e sagoma dei glifi.
const _sil = document.createElement('canvas');
const _silCtx = _sil.getContext('2d', { willReadFrequently: true });

export class TextFxGL {
  /** @returns {TextFxGL|null} null = niente WebGL: si resta sul path CPU */
  static create() {
    try {
      const canvas = document.createElement('canvas');
      const opts = { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true };
      const gl = /** @type {WebGLRenderingContext} */ (
        canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts));
      if (!gl) return null;
      return new TextFxGL(gl, canvas);
    } catch {
      return null;
    }
  }

  /** @param {WebGLRenderingContext} gl @param {HTMLCanvasElement} canvas */
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.ok = true;
    this.gen = 1; // bumpata al context restore: le entry stantie si rifanno
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ok = false;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.gen++;
      this._init();
      this.ok = true;
    });
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.prog = link(gl, VS, FS);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    /** @type {Record<string, WebGLUniformLocation>} */
    this.u = {};
    for (const name of ['uSdf', 'uTexSize', 'uAnchorW', 'uAnchorT', 'uScale', 'uSpread',
      'uStroke', 'uDir', 'uDist', 'uBlur', 'uAA', 'uT0', 'uBlock', 'uColor', 'uBox']) {
      this.u[name] = gl.getUniformLocation(this.prog, name);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  // (Ri)genera la texture SDF del livello se la chiave non corrisponde.
  // padEm decide la portata massima campionabile attorno ai glifi: oltre
  // satura (il chiamante la sceglie a bucket, così la SDF non si rifà a
  // ogni tacca degli slider ma solo alle soglie).
  /**
   * @param {Layer} layer @param {string} key @param {TextItem} it
   * @param {TextStyle} st @param {number} padEm
   * @returns {SdfEntry|null}
   */
  ensureSdf(layer, key, it, st, padEm) {
    const cur = /** @type {SdfEntry|null} */ (layer.blockSdf);
    if (cur && cur.key === key && cur.gen === this.gen) return cur;
    const gl = this.gl;

    // metriche per em (sonda a 100px: la larghezza misurata può essere corta
    // se il font non è pronto — fallback per-carattere, come blockBox)
    _silCtx.font = `${st.weight} 100px "${st.font}", sans-serif`;
    _silCtx.textAlign = 'center';
    _silCtx.textBaseline = 'alphabetic';
    const m = _silCtx.measureText(it.text);
    const wEm = Math.max(m.width, it.text.length * 80) / 100 + 0.3;
    const ascEm = (m.actualBoundingBoxAscent || 80) / 100 + 0.1;
    const descEm = (m.actualBoundingBoxDescent || 25) / 100 + 0.1;

    // corpo della SDF: il più grande che tiene testo + pad nei limiti texture
    const F = Math.max(F_MIN, Math.min(F_MAX,
      Math.floor((MAX_TEX_W - 4) / (wEm + 2 * padEm)),
      Math.floor((MAX_TEX_H - 4) / (ascEm + descEm + 2 * padEm))));
    const pad = Math.ceil(padEm * F);
    const w = Math.min(MAX_TEX_W, Math.ceil(wEm * F + 2 * pad));
    const h = Math.min(MAX_TEX_H, Math.ceil((ascEm + descEm) * F + 2 * pad));
    const baseX = w / 2;
    const baseY = pad + ascEm * F;

    // sagoma dei NUDI glifi (il bordo è una soglia nello shader)
    _sil.width = w; _sil.height = h;
    _silCtx.clearRect(0, 0, w, h);
    _silCtx.font = `${st.weight} ${F}px "${st.font}", sans-serif`;
    _silCtx.textAlign = 'center';
    _silCtx.textBaseline = 'alphabetic';
    _silCtx.fillStyle = '#fff';
    _silCtx.fillText(it.text, baseX, baseY);
    const alpha = _silCtx.getImageData(0, 0, w, h).data;

    // EDT firmata: dentro->distanza dal fuori, fuori->distanza dal dentro
    const n = w * h;
    if (_g1.length < n) { _g1 = new Float32Array(n); _g2 = new Float32Array(n); }
    for (let i = 0; i < n; i++) {
      const inside = alpha[i * 4 + 3] >= 128;
      _g1[i] = inside ? 0 : 1e20;    // -> distanza al dentro (per i px fuori)
      _g2[i] = inside ? 1e20 : 0;    // -> distanza al fuori (per i px dentro)
    }
    edt2d(_g1, w, h);
    edt2d(_g2, w, h);

    // codifica RG a doppio raggio; sul bordo antialiasato la copertura
    // stessa è la distanza subpixel (l'EDT binaria lì vale ±1)
    const far = pad;
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      let d = Math.sqrt(_g1[i]) - Math.sqrt(_g2[i]);
      const a = alpha[i * 4 + 3];
      if (a > 8 && a < 248) d = 0.5 - a / 255;
      let r = d / (2 * NEAR) + 0.5;
      let g = d / (2 * far) + 0.5;
      r = r < 0 ? 0 : r > 1 ? 1 : r;
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      const o = i * 4;
      px[o] = r * 255;
      px[o + 1] = g * 255;
      px[o + 3] = 255;
    }

    if (cur && cur.tex && cur.gen === this.gen) gl.deleteTexture(cur.tex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);

    /** @type {SdfEntry} */
    const entry = { key, gen: this.gen, tex, w, h, F, baseX, baseY, far };
    layer.blockSdf = entry;
    return entry;
  }

  // Disegna l'effetto nel blockCanvas del livello: un draw sul quad del box,
  // poi un blit GPU->GPU (drawImage) nel canvas 2D mostrato dal compositor.
  /**
   * @param {Layer} layer @param {TextItem} it @param {TextStyle} st
   * @param {{x: number, y: number, w: number, h: number}} box mondo
   * @param {number} r px bitmap per px mondo
   * @param {number} baselineY baseline alfabetica in px mondo
   * @returns {boolean} false = contesto perso/entry assente: usare il CPU path
   */
  render(layer, it, st, box, r, baselineY) {
    const e = /** @type {SdfEntry|null} */ (layer.blockSdf);
    if (!this.ok || !e || e.gen !== this.gen) return false;
    const gl = this.gl;
    const cw = Math.max(1, Math.round(box.w * r));
    const ch = Math.max(1, Math.round(box.h * r));
    // canvas GL grow-only: niente realloc a ogni variazione di box
    if (this.canvas.width < cw) this.canvas.width = cw;
    if (this.canvas.height < ch) this.canvas.height = ch;

    gl.viewport(0, this.canvas.height - ch, cw, ch);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, this.canvas.height - ch, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const rad = (st.shadowAngle ?? 45) * Math.PI / 180;
    const c = parseInt(st.shadowColor.slice(1), 16);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.uniform1i(this.u.uSdf, 0);
    gl.uniform4f(this.u.uBox, box.x, box.y, box.w, box.h);
    gl.uniform2f(this.u.uTexSize, e.w, e.h);
    gl.uniform2f(this.u.uAnchorW, it.x, baselineY);
    gl.uniform2f(this.u.uAnchorT, e.baseX, e.baseY);
    gl.uniform1f(this.u.uScale, e.F / it.size);
    gl.uniform2f(this.u.uSpread, NEAR, e.far);
    gl.uniform1f(this.u.uStroke, st.stroke);
    gl.uniform2f(this.u.uDir, Math.cos(rad), Math.sin(rad));
    gl.uniform1f(this.u.uDist, st.shadowDist);
    gl.uniform1f(this.u.uBlur, st.shadowBlur);
    gl.uniform1f(this.u.uAA, 1 / r);
    gl.uniform1f(this.u.uT0, 0.5 / r);
    gl.uniform1f(this.u.uBlock, st.block ? 1 : 0);
    gl.uniform4f(this.u.uColor,
      ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);

    // il viewport sta in alto nel canvas GL: in coordinate immagine è (0,0)
    const dest = layer.blockCanvas;
    if (dest.width !== cw || dest.height !== ch) { dest.width = cw; dest.height = ch; }
    const ctx = dest.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this.canvas, 0, 0, cw, ch, 0, 0, cw, ch);
    return true;
  }

  // Libera la texture SDF del livello (effetto spento, livello morto).
  /** @param {Layer} layer */
  free(layer) {
    const e = /** @type {SdfEntry|null} */ (layer.blockSdf);
    if (!e) return;
    if (this.ok && e.gen === this.gen && e.tex) this.gl.deleteTexture(e.tex);
    layer.blockSdf = null;
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.ok = false;
  }
}
