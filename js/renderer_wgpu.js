// RENDERER WEBGPU (fase 2 del piano, v0 dietro ?renderer=wgpu).
// Presenta la pila raster direttamente in WebGPU: texture rgba8 per chunk
// (premultiplied, upload dai chunk CPU sui dirty), un quad per chunk, blend
// OVER premultiplied sul canvas trasparente (i board bianchi sono DOM sotto,
// come per GL/2D). Il tratto vivo usa il pass COMBINATO per chunk (stessa
// matematica di commitChunk / _drawPaintLive del renderer 2D: tratto over
// chunk nello scratch, poi × opacità del livello) e la gomma il
// destination-out — entrambi nel fragment shader, niente scratch.
// v0 NON copre (warn una volta, dietro flag): gruppi di ritaglio (disegna la
// sola base), blend mode ≠ normal (resi come normal), sessioni
// Trasforma/Effetti, quad testo/svg, proxy zoom-out (main li gate su
// GLRenderer: qui sono null e si va per-chunk). L'init del device è ASINCRONO
// e va fatto PRIMA di new App: WgpuRenderer.preinit() + available.

import { CHUNK } from './store.js';
import { acquireWgpuDevice, onWgpuDeviceLost } from './wgpu_device.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */

const WGSL = /* wgsl */ `
struct U {
  rect: vec4<f32>,      // x0,y0,x1,y1 del quad in px device
  screen: vec2<f32>,    // dimensioni canvas in px device
  layerAlpha: f32,
  strokeOpacity: f32,
  mode: u32,            // 0 chunk, 1 paint combinato, 2 gomma, 3 solo tratto
  blendFn: u32,         // fsBlend: 0 multiply, 1 overlay, 2 softlight, 3 darken, 4 lighten, 5 difference
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var strokeTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: U;
@group(0) @binding(4) var back: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  let c = corners[vi];
  let px = mix(u.rect.xy, u.rect.zw, c);
  let ndc = vec2<f32>(px.x / u.screen.x * 2.0 - 1.0, 1.0 - px.y / u.screen.y * 2.0);
  var o: VOut;
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.uv = c;
  return o;
}

fn srcPx(in: VOut) -> vec4<f32> {
  let c = textureSample(layerTex, samp, in.uv);
  let s = textureSample(strokeTex, samp, in.uv);
  var o: vec4<f32>;
  if (u.mode == 0u) {
    o = c;
  } else if (u.mode == 1u) {
    // paint combinato: (tratto×op) over chunk — identico a commitChunk
    let sp = s * u.strokeOpacity;
    o = sp + c * (1.0 - sp.a);
  } else if (u.mode == 2u) {
    // gomma live: chunk × (1 - alphaTratto×op)
    o = c * (1.0 - s.a * u.strokeOpacity);
  } else {
    // solo tratto (chunk del livello assente)
    o = s * u.strokeOpacity;
  }
  return o * u.layerAlpha;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  return srcPx(in);
}

// B(Cb, Cs) del modulo W3C Compositing, sui colori NON premoltiplicati
fn blendB(b: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  switch u.blendFn {
    case 0u: { return b * s; }                                     // multiply
    case 1u: {                                                     // overlay
      return select(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), b >= vec3<f32>(0.5));
    }
    case 2u: {                                                     // softlight
      let dd = select(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), b >= vec3<f32>(0.25));
      return select(b - (1.0 - 2.0 * s) * b * (1.0 - b),
        b + (2.0 * s - 1.0) * (dd - b), s >= vec3<f32>(0.5));
    }
    case 3u: { return min(b, s); }                                 // darken
    case 4u: { return max(b, s); }                                 // lighten
    default: { return abs(b - s); }                                // difference
  }
}

// Modi "shader": formula completa col backdrop copiato (blending SPENTO:
// dove il livello è vuoto riscrive il backdrop) —
//   co = cs·(1-ab) + cb·(1-as) + as·ab·B(Cb,Cs)   ao = as + ab·(1-as)
@fragment
fn fsBlend(in: VOut) -> @location(0) vec4<f32> {
  let s = srcPx(in);
  let b = textureLoad(back, vec2<i32>(in.pos.xy), 0);
  let B = blendB(b.rgb / max(b.a, 1e-4), s.rgb / max(s.a, 1e-4));
  return vec4<f32>(s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * B,
    s.a + b.a * (1.0 - s.a));
}
`;

// indici di blendFn nel WGSL (i 6 modi non esprimibili nel blending fisso)
const SHADER_MODE_IDX = /** @type {Record<string, number>} */ ({
  multiply: 0, overlay: 1, softlight: 2, darken: 3, lighten: 4, difference: 5,
});

// Blit di minificazione: ogni livello mip campiona il precedente in linear
// a mezza risoluzione = media 2×2 esatta (l'equivalente del generateMipmap
// GL: senza mip, a zoom<1 i tratti sottili si sgranano/spezzano).
const WGSL_MIP = /* wgsl */ `
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let uv = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  return textureSample(src, s, in.uv);
}
`;

const MIP_LEVELS = 9; // 256 -> 1 (CHUNK è POT)

/** @type {any} */ let sharedDevice = null;
let preinitTried = false;

export class WgpuRenderer {
  /** true dopo preinit riuscita: il costruttore sincrono può usare il device */
  static get available() { return sharedDevice !== null; }

  /** Da chiamare (await) PRIMA di new App quando il flag è attivo. */
  static async preinit() {
    if (preinitTried) return sharedDevice !== null;
    preinitTried = true;
    // stesso device del ponte tratto (fase 2.2): il present copia gli slot
    // dell'arena nelle texture dei chunk — con due device non si potrebbe
    sharedDevice = await acquireWgpuDevice();
    return sharedDevice !== null;
  }

  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.kind = 'WebGPU';
    this.ok = false;
    this.contextLost = false;
    /** @type {WebGLRenderingContext|null} interfaccia comune (TextQuadCache) */
    this.gl = null;
    this.ctxGen = 0;
    this.texCount = 0;
    this.uploadsThisFrame = 0;
    /** @type {any} */ this.device = sharedDevice;
    /** @type {any} */ this._ctx = null;
    /** @type {any} */ this._pipeline = null;
    /** @type {any} */ this._sampler = null;
    /** @type {any} */ this._samplerNearest = null;
    /** @type {any} */ this._white = null;   // 1×1 trasparente per gli slot non usati
    /** @type {any} */ this._bgl = null;
    /** @type {any} */ this._uniBuf = null;
    this._uniCap = 0;
    /** @type {string} */ this._format = 'bgra8unorm';
    /** @type {WeakMap<Chunk, any>} texture per chunk (possedute qui) */
    this._tex = new WeakMap();
    /** @type {WeakMap<any, {full: any, level: any[]}>} view cache per texture */
    this._views = new WeakMap();
    /** @type {import('./wgpu_stroke.js').WgpuStrokeBridge|null} */
    this._bridge = null;
    /** @type {any} */ this._mipPipeline = null;
    /** @type {any} */ this._mipBgl = null;
    /** @type {any} */ this._mipSampler = null;
    /** @type {any} */ this._samplerMip = null;
    /** @type {any} */ this._pipelineGrp = null;
    /** @type {any} */ this._pipelineGrpClip = null;
    /** @type {any} */ this._grpTex = null;
    /** @type {any} */ this._pipeScreen = null;
    /** @type {any} */ this._pipeAdd = null;
    /** @type {any} */ this._pipeBlend = null;
    /** @type {any} */ this._bdTex = null; // backdrop dei modi shader
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    /** @type {(() => ChunkStore[])|null} */
    this._storesFn = null;
    this._warned = new Set();
    if (!this.device) return;
    try {
      this._ctx = canvas.getContext('webgpu');
      if (!this._ctx) return;
      const gpu = /** @type {any} */ (navigator).gpu;
      this._format = gpu.getPreferredCanvasFormat();
      // COPY_SRC sul canvas: i modi shader copiano il backdrop accumulato
      // (ATTENZIONE: le costanti di GPUTextureUsage NON sono quelle dei
      // buffer — COPY_SRC texture = 0x1)
      this._ctx.configure({
        device: this.device, format: this._format, alphaMode: 'premultiplied',
        usage: /* RENDER_ATTACHMENT|COPY_SRC */ 0x10 | 0x1,
      });
      const module = this.device.createShaderModule({ code: WGSL });
      this._bgl = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, sampler: {} },
          { binding: 1, visibility: 2, texture: {} },
          { binding: 2, visibility: 2, texture: {} },
          { binding: 3, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } },
          { binding: 4, visibility: 2, texture: {} },
        ],
      });
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] });
      const makePipe = (/** @type {string} */ format, /** @type {any} */ blend,
        /** @type {string} */ entry = 'fs') =>
        this.device.createRenderPipeline({
          layout,
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: entry, targets: [{ format, blend }] },
          primitive: { topology: 'triangle-list' },
        });
      const over = {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      };
      this._pipeline = makePipe(this._format, over);
      // gruppi di ritaglio (FBO rgba8): base con over normale, figli con
      // DST_ALPHA — il colore sostituisce dove la base ha alpha, la forma
      // resta della base (blendFunc(DST_ALPHA, ONE_MINUS_SRC_ALPHA) del GL)
      this._pipelineGrp = makePipe('rgba8unorm', over);
      this._pipelineGrpClip = makePipe('rgba8unorm', {
        color: { srcFactor: 'dst-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'dst-alpha', dstFactor: 'one-minus-src-alpha' },
      });
      // blend mode fixed-function ESATTI sul premultiplied (come il GL):
      // screen = ONE/ONE_MINUS_SRC_COLOR, add = ONE/ONE + alpha over
      this._pipeScreen = makePipe(this._format, {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      });
      this._pipeAdd = makePipe(this._format, {
        color: { srcFactor: 'one', dstFactor: 'one' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      });
      // modi shader: formula W3C col backdrop, blending SPENTO
      this._pipeBlend = makePipe(this._format, undefined, 'fsBlend');
      this._sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this._samplerNearest = this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
      // minificazione (zoom<1): trilinear sui mip — il LINEAR_MIPMAP_LINEAR
      // del GL, senza cui i tratti sottili da lontano si sgranano/spezzano
      this._samplerMip = this.device.createSampler({
        magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      });
      this._white = this.device.createTexture({
        size: [1, 1], format: 'rgba8unorm',
        usage: /* TEXTURE_BINDING|COPY_DST */ 0x4 | 0x2,
      });
      // pipeline del blit mip (bersaglio rgba8unorm, niente blend)
      const mipModule = this.device.createShaderModule({ code: WGSL_MIP });
      this._mipBgl = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, sampler: {} },
          { binding: 1, visibility: 2, texture: {} },
        ],
      });
      this._mipPipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._mipBgl] }),
        vertex: { module: mipModule, entryPoint: 'vs' },
        fragment: { module: mipModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
      this._mipSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.ok = true;
      onWgpuDeviceLost(() => {
        // v0: niente recovery (ricreare device+pipeline+texture); il warn
        // spiega lo schermo fermo — il flag è sperimentale
        console.warn('[renderer_wgpu] device perso: present WebGPU fermo, ricaricare la pagina');
      });
    } catch (err) {
      console.warn('[renderer_wgpu] init fallita:', err);
      this.ok = false;
    }
  }

  /**
   * Fase 2.2: il tratto vivo si legge DIRETTAMENTE dall'arena del ponte
   * (bridge.direct): copyBufferToTexture slot→texture nello stesso submit
   * del present — il readback CPU vive solo al commit.
   * @param {import('./wgpu_stroke.js').WgpuStrokeBridge} bridge
   */
  attachStrokeBridge(bridge) { this._bridge = bridge; }

  /** @param {string} what */
  _warnOnce(what) {
    if (this._warned.has(what)) return;
    this._warned.add(what);
    console.warn(`[renderer_wgpu] v0: ${what} non ancora supportato sotto ?renderer=wgpu`);
  }

  /** @param {() => ChunkStore[]} fn */
  trackStores(fn) { this._storesFn = fn; }

  /** @param {number} wCss @param {number} hCss @param {number} dpr */
  resize(wCss, hCss, dpr) {
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Upload dei rect sporchi dello store — stessa semantica del GL:
   * rect parziale quando la texture esiste, chunk intero altrimenti.
   * @param {ChunkStore} store */
  uploadDirty(store) {
    let bytes = 0;
    for (const chunk of store.dirty) {
      if (!store.map.has(chunk.key)) continue; // rilasciato nel frattempo
      const tex = this._tex.get(chunk);
      if (tex && !chunk.texDirty && chunk.dirX1 >= chunk.dirX0) {
        const x0 = chunk.dirX0, y0 = chunk.dirY0;
        const w = chunk.dirX1 - x0 + 1, h = chunk.dirY1 - y0 + 1;
        // vista dal primo pixel del rect, righe con lo stride del chunk
        this.device.queue.writeTexture({ texture: tex, origin: [x0, y0] },
          new Uint8Array(chunk.data.buffer,
            chunk.data.byteOffset + (y0 * CHUNK + x0) * 4,
            ((h - 1) * CHUNK + w) * 4),
          { bytesPerRow: CHUNK * 4 }, [w, h]);
        bytes += w * h * 4;
        this.uploadsThisFrame++;
        chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
        chunk.mips = false; // il livello 0 è cambiato: catena mip stantia
      } else {
        this._uploadNow(chunk);
        bytes += chunk.data.length;
      }
    }
    store.dirty.clear();
    return bytes;
  }

  /** Texture di chunk: catena mip completa (la minificazione la usa) e
   * RENDER_ATTACHMENT per il blit dei livelli. @param {Chunk} chunk */
  _newTex(chunk) {
    const tex = this.device.createTexture({
      size: [CHUNK, CHUNK], format: 'rgba8unorm', mipLevelCount: MIP_LEVELS,
      usage: /* TEXTURE_BINDING|COPY_DST|RENDER_ATTACHMENT */ 0x4 | 0x2 | 0x10,
    });
    this._tex.set(chunk, tex);
    this.texCount++;
    return tex;
  }

  /** View cache: full (trilinear nel pass principale) + per livello (blit).
   * @param {any} tex */
  _viewsOf(tex) {
    let v = this._views.get(tex);
    if (!v) {
      v = { full: tex.createView(), level: [] };
      for (let l = 0; l < tex.mipLevelCount; l++) {
        v.level.push(tex.createView({ baseMipLevel: l, mipLevelCount: 1 }));
      }
      this._views.set(tex, v);
    }
    return v;
  }

  /** @param {Chunk} chunk */
  _uploadNow(chunk) {
    let tex = this._tex.get(chunk);
    if (!tex) tex = this._newTex(chunk);
    this.device.queue.writeTexture({ texture: tex },
      /** @type {Uint8Array} */ (/** @type {unknown} */ (chunk.data)),
      { bytesPerRow: CHUNK * 4 }, [CHUNK, CHUNK]);
    chunk.texDirty = false;
    chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
    chunk.mips = false; // il livello 0 è cambiato: catena mip stantia
    this.uploadsThisFrame++;
  }

  /**
   * Texture del bake testo/SVG: (ri)creata quando il bake cambia (texDirty)
   * o la taglia del canvas non coincide; upload PREMOLTIPLICATO via
   * copyExternalImageToTexture (il canvas è straight-alpha) con catena mip
   * propria (NPOT ok in WebGPU), rigenerata subito — la minificazione la
   * campiona quando serve. Riusa i campi tex/texGen/texDirty dell'entry
   * (contratto di _ensureTextQuadTex del GL; un solo bottom renderer vivo).
   * @param {{canvas: HTMLCanvasElement|null, tex: any, texGen: number, texDirty: boolean}} q
   * @param {any[]} mipGen
   */
  _ensureQuadTex(q, mipGen) {
    const cv = /** @type {HTMLCanvasElement} */ (q.canvas);
    let tex = q.tex;
    const fresh = !tex || q.texGen !== this.ctxGen || typeof tex.destroy !== 'function' ||
      tex.width !== cv.width || tex.height !== cv.height;
    if (!fresh && !q.texDirty) return tex;
    if (fresh) {
      if (tex && typeof tex.destroy === 'function') { tex.destroy(); this.texCount--; }
      const levels = 1 + Math.floor(Math.log2(Math.max(cv.width, cv.height)));
      tex = this.device.createTexture({
        size: [cv.width, cv.height], format: 'rgba8unorm', mipLevelCount: levels,
        usage: /* TEXTURE_BINDING|COPY_DST|RENDER_ATTACHMENT */ 0x4 | 0x2 | 0x10,
      });
      q.tex = tex;
      q.texGen = this.ctxGen;
      this.texCount++;
    }
    this.device.queue.copyExternalImageToTexture(
      { source: cv }, { texture: tex, premultipliedAlpha: true },
      [cv.width, cv.height]);
    mipGen.push(tex); // catena subito buona: lo zoom può scendere quando vuole
    q.texDirty = false;
    this.uploadsThisFrame++;
    return tex;
  }

  /** @param {Chunk} chunk */
  disposeChunkTex(chunk) {
    const tex = this._tex.get(chunk);
    if (tex) {
      tex.destroy();
      this._tex.delete(chunk);
      this.texCount--;
      chunk.texDirty = true;
    }
  }

  /**
   * Eviction come per GL: fuori vista si scaricano (riupload on-demand).
   * @param {ChunkStore[]} stores @param {Camera} camera @param {number} [maxTex]
   * @param {Set<ChunkStore>|null} [covered]
   */
  evict(stores, camera, maxTex = 1024, covered = null) {
    if (this.texCount <= maxTex) return;
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const store of stores) {
      const out = covered !== null && covered.has(store);
      for (const chunk of store.map.values()) {
        if (this.texCount <= maxTex) return;
        if (out || chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) {
          this.disposeChunkTex(chunk);
        }
      }
    }
  }

  /**
   * Contratto del bottom renderer (vedi renderer_2d.render).
   * @param {Camera} camera @param {Layer[]} layers @param {number} activeId
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {import('./board_proxy.js').ProxyFrame|null} [proxies]
   * @param {import('./renderer_gl.js').TransformFrameSet} [transform]
   * @param {import('./renderer_gl.js').FxFrame|null} [fx]
   * @param {import('./text_quad.js').TextQuadCache|null} [textQuads]
   * @param {import('./svg_quad.js').SvgQuadCache|null} [svgQuads]
   */
  render(camera, layers, activeId, strokeStore, strokeOpacity, eraserLive, proxies = null,
    transform = null, fx = null, textQuads = null, svgQuads = null) {
    if (!this.ok) return;
    this.uploadsThisFrame = 0;
    if (transform !== null) this._warnOnce('sessione Trasforma');
    if (fx !== null) this._warnOnce('sessione Effetti');

    const dpr = camera.dpr;
    const s = camera.zoom * dpr;
    const tx = (-camera.x * camera.zoom + camera.w * 0.5) * dpr;
    const ty = (-camera.y * camera.zoom + camera.h * 0.5) * dpr;
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    const W = this.canvas.width, H = this.canvas.height;

    // raccolta draw: [chunkTex, strokeTex|null, rect, mode, layerAlpha]
    // samp/sciss opzionali per i quad testo/svg (LINEAR sempre + clip board);
    // clip=true = figlio di gruppo di ritaglio (pipeline DST_ALPHA).
    // Il frame è una sequenza di SEGMENTI: canvas (load/clear) e gruppo
    // (base+figli nell'FBO canvas-size, poi blit nel segmento dopo) — la
    // struttura FBO+blit del GL, in render pass WebGPU consecutivi.
    /** @typedef {{lt: any, st: any, x0: number, y0: number, x1: number, y1: number, mode: number, a: number, samp?: any, sciss?: number[], clip?: boolean, pipe?: string, blendFn?: number, _ui?: number}} Draw */
    /** @type {{group: boolean, draws: Draw[], bd?: number[]}[]} */
    const segments = [{ group: false, draws: [] }];
    /** @type {Draw[]} */
    let sink = segments[0].draws;
    // bbox device (clampato al canvas) di una lista di draw — la regione di
    // backdrop da copiare per i modi shader; null = tutto fuori schermo
    const drawsRect = (/** @type {Draw[]} */ list, /** @type {number} */ from, /** @type {number} */ to) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = from; k < to; k++) {
        const d = list[k];
        if (d.x0 < x0) x0 = d.x0;
        if (d.y0 < y0) y0 = d.y0;
        if (d.x1 > x1) x1 = d.x1;
        if (d.y1 > y1) y1 = d.y1;
      }
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(W, x1); y1 = Math.min(H, y1);
      return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
    };
    // minificazione: sotto zoom 1 si campionano i mip (come il GL); i chunk
    // col livello 0 cambiato rigenerano la catena in questo stesso encoder
    const wantMips = camera.zoom < 1;
    /** @type {any[]} texture con catena mip da rigenerare questo frame */
    const mipGen = [];
    const needMips = (/** @type {Chunk} */ chunk) => {
      if (wantMips && !chunk.mips) {
        mipGen.push(this._tex.get(chunk));
        chunk.mips = true; // la catena si rigenera in questo frame
      }
    };
    // tratto GPU-diretto: copie arena→texture da accodare prima del pass
    // (solo quando lo strokeStore È il mirror del ponte in modalità direct)
    const bridge = this._bridge && this._bridge.direct && strokeStore === this._bridge.store
      ? this._bridge : null;
    /** @type {{slot: number, tex: any}[]} */
    const copies = [];
    const strokeTex = (/** @type {Chunk} */ sc) => {
      if (bridge) {
        const slot = bridge.slotOfKey(sc.key);
        if (slot !== undefined) {
          let tex = this._tex.get(sc);
          if (!tex) tex = this._newTex(sc);
          copies.push({ slot, tex });
          // la copia riscrive il livello 0 a ogni frame: mip da rifare
          if (wantMips) mipGen.push(tex);
          return tex;
        }
      }
      // niente slot (ponte spento, chunk scoperto dall'endpass): via CPU
      if (sc.texDirty || !this._tex.has(sc)) this._uploadNow(sc);
      needMips(sc);
      return this._tex.get(sc);
    };
    const pushChunk = (/** @type {Chunk} */ chunk, /** @type {any} */ st,
      /** @type {number} */ mode, /** @type {number} */ alpha, /** @type {boolean} */ clip) => {
      const x0 = Math.round(chunk.cx * CHUNK * s + tx);
      const y0 = Math.round(chunk.cy * CHUNK * s + ty);
      const x1 = Math.round((chunk.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((chunk.cy + 1) * CHUNK * s + ty);
      sink.push({ lt: this._tex.get(chunk), st, x0, y0, x1, y1, mode, a: alpha, clip });
    };
    // i draw di UN livello raster (chunk + tratto live) nel sink corrente
    const collectRaster = (/** @type {Layer} */ layer, /** @type {boolean} */ clip) => {
      const alpha = layer.opacity;
      const live = strokeStore !== null && layer.id === activeId && strokeStore.map.size > 0;
      for (const chunk of layer.store.map.values()) {
        if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
        if (chunk.texDirty || !this._tex.has(chunk)) this._uploadNow(chunk);
        needMips(chunk);
        if (live) {
          const sc = /** @type {NonNullable<typeof strokeStore>} */ (strokeStore).getByKey(chunk.key);
          if (sc) {
            pushChunk(chunk, strokeTex(sc), eraserLive ? 2 : 1, alpha, clip);
            continue;
          }
        }
        pushChunk(chunk, null, 0, alpha, clip);
      }
      if (live && !eraserLive) {
        // tratto su zone vuote del livello (over diretto, esatto)
        for (const sc of /** @type {NonNullable<typeof strokeStore>} */ (strokeStore).map.values()) {
          if (sc.cx < cx0 || sc.cx > cx1 || sc.cy < cy0 || sc.cy > cy1) continue;
          if (layer.store.getByKey(sc.key)) continue;
          pushChunk(sc, strokeTex(sc), 3, alpha, clip);
        }
      }
    };

    const skip = proxies ? proxies.skip : null;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (skip !== null && skip.has(layer.id)) continue;
      if (layer.kind === 'text' || layer.kind === 'svg') {
        // vettori NON in editing: quad cotto alla posizione nella pila,
        // clip al board (il testo può sbordare), LINEAR sempre (contenuto
        // vettoriale: NEAREST lo squadretterebbe). L'SVG vivo ha il suo
        // piano DOM e non passa da qui — come per il GL.
        const cache = layer.kind === 'text' ? textQuads : svgQuads;
        if (cache) {
          const q = cache.quadFor(layer.id, camera);
          if (q) {
            const tex = this._ensureQuadTex(q, mipGen);
            const b = layer.clipBoard;
            /** @type {number[]|undefined} */
            let sciss;
            if (b) {
              const sx0 = Math.max(0, Math.min(W, Math.round(b.x * s + tx)));
              const sy0 = Math.max(0, Math.min(H, Math.round(b.y * s + ty)));
              const sx1 = Math.max(0, Math.min(W, Math.round((b.x + b.w) * s + tx)));
              const sy1 = Math.max(0, Math.min(H, Math.round((b.y + b.h) * s + ty)));
              if (sx1 <= sx0 || sy1 <= sy0) continue; // board fuori schermo
              sciss = [sx0, sy0, sx1 - sx0, sy1 - sy0];
            }
            sink.push({
              lt: tex, st: null,
              x0: Math.round(q.x * s + tx), y0: Math.round(q.y * s + ty),
              x1: Math.round((q.x + q.w) * s + tx), y1: Math.round((q.y + q.h) * s + ty),
              mode: 0, a: layer.opacity,
              samp: wantMips ? this._samplerMip : this._sampler, sciss,
            });
          }
        }
        continue;
      }
      if (layer.kind !== 'raster') continue;
      // membro di un gruppo di ritaglio: lo disegna il pass della sua base
      if (layer.clip && layer.clipBase) continue;
      const mode = layer.mode || 'normal';
      // base di un gruppo? I figli sono la catena CONTIGUA di clippati sopra
      // (come in GL: base + figli nell'FBO, poi blit alla posizione in pila)
      let gEnd = i + 1;
      while (gEnd < layers.length &&
        layers[gEnd].clip && layers[gEnd].clipBase === layer) gEnd++;
      if (gEnd > i + 1) {
        /** @type {Draw[]} */
        const grpDraws = [];
        sink = grpDraws;
        collectRaster(layer, false); // base: blending normale (dà la forma)
        const baseN = grpDraws.length;
        for (let j = i + 1; j < gEnd; j++) {
          const child = layers[j];
          if (!child.visible || child.opacity <= 0) continue;
          collectRaster(child, true); // figli: DST_ALPHA (colore, non forma)
        }
        const canvasSeg = { group: false, draws: /** @type {Draw[]} */ ([]),
          bd: /** @type {number[]|undefined} */ (undefined) };
        sink = canvasSeg.draws;
        if (grpDraws.length > 0) {
          segments.push({ group: true, draws: grpDraws }, canvasSeg);
          // il gruppo si presenta con un blit 1:1 (NEAREST) e il metodo di
          // fusione della BASE si applica QUI, al gruppo intero (come GL)
          /** @type {Draw} */
          const blit = { lt: 'GRP', st: null, x0: 0, y0: 0, x1: W, y1: H,
            mode: 0, a: 1, samp: this._samplerNearest };
          if (mode in SHADER_MODE_IDX) {
            // bbox del gruppo = bbox della base (l'alpha dei figli è sua)
            const rect = drawsRect(grpDraws, 0, baseN);
            if (rect) {
              canvasSeg.bd = rect;
              blit.pipe = 'blend';
              blit.blendFn = SHADER_MODE_IDX[mode];
              blit.sciss = rect;
            }
          } else if (mode === 'screen') blit.pipe = 'screen';
          else if (mode === 'add') blit.pipe = 'add';
          sink.push(blit);
        } else {
          segments.push(canvasSeg); // gruppo vuoto in vista: nessun blit
        }
        i = gEnd - 1;
        continue;
      }
      if (mode in SHADER_MODE_IDX) {
        // modo "shader": segmento con copia del backdrop (bbox dei chunk
        // visibili) e pass fusione a blending spento
        const seg = { group: false, draws: /** @type {Draw[]} */ ([]),
          bd: /** @type {number[]|undefined} */ (undefined) };
        sink = seg.draws;
        collectRaster(layer, false);
        if (seg.draws.length > 0) {
          const rect = drawsRect(seg.draws, 0, seg.draws.length);
          if (rect) {
            for (const d of seg.draws) { d.pipe = 'blend'; d.blendFn = SHADER_MODE_IDX[mode]; }
            seg.bd = rect;
            segments.push(seg);
          }
        }
        const cont = { group: false, draws: /** @type {Draw[]} */ ([]) };
        segments.push(cont);
        sink = cont.draws;
        continue;
      }
      if (mode === 'screen' || mode === 'add') {
        const from = sink.length;
        collectRaster(layer, false);
        for (let k = from; k < sink.length; k++) sink[k].pipe = mode;
        continue;
      }
      collectRaster(layer, false);
    }

    // uniform a offset dinamici, una fetta da 256B per draw (indice globale
    // sull'intero frame, attraverso tutti i segmenti)
    /** @type {Draw[]} */
    const flat = [];
    for (const seg of segments) for (const d of seg.draws) { d._ui = flat.length; flat.push(d); }
    const need = Math.max(256, flat.length * 256);
    if (need > this._uniCap) {
      if (this._uniBuf) this._uniBuf.destroy();
      this._uniCap = need * 2;
      this._uniBuf = this.device.createBuffer({ size: this._uniCap, usage: 0x40 | 0x8 });
    }
    const uni = new ArrayBuffer(need);
    for (let i = 0; i < flat.length; i++) {
      const d = flat[i];
      const f = new Float32Array(uni, i * 256, 8);
      const u32 = new Uint32Array(uni, i * 256, 12);
      f[0] = d.x0; f[1] = d.y0; f[2] = d.x1; f[3] = d.y1;
      f[4] = W; f[5] = H;
      f[6] = d.a; f[7] = strokeOpacity;
      u32[8] = d.mode;
      u32[9] = d.blendFn || 0;
    }
    this.device.queue.writeBuffer(this._uniBuf, 0, uni);

    // filtri come il GL: mip in minificazione, linear fino a 3.8×, poi
    // nearest per il lavoro di dettaglio
    const samp = wantMips ? this._samplerMip
      : camera.zoom <= 3.8 ? this._sampler : this._samplerNearest;
    const enc = this.device.createCommandEncoder();
    // slot dell'arena → texture dei chunk vivi, PRIMA del pass: stesso
    // device e stessa coda del compute del ponte (già sottomesso in questo
    // frame) — il present mostra il dispatch di QUESTO frame, zero ritardo
    for (const c of copies) {
      enc.copyBufferToTexture(
        { buffer: /** @type {NonNullable<typeof this._bridge>} */ (this._bridge).arenaBuffer,
          offset: c.slot * CHUNK * CHUNK * 4, bytesPerRow: CHUNK * 4, rowsPerImage: CHUNK },
        { texture: c.tex }, [CHUNK, CHUNK, 1]);
    }
    // rigenerazione mip: un blit per livello, ogni livello media 2×2 il
    // precedente (dopo le copie arena: il livello 0 è quello del frame)
    for (const tex of mipGen) {
      const v = this._viewsOf(tex);
      for (let l = 1; l < v.level.length; l++) {
        const bg = this.device.createBindGroup({
          layout: this._mipBgl,
          entries: [
            { binding: 0, resource: this._mipSampler },
            { binding: 1, resource: v.level[l - 1] },
          ],
        });
        const mp = enc.beginRenderPass({
          colorAttachments: [{
            view: v.level[l],
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear', storeOp: 'store',
          }],
        });
        mp.setPipeline(this._mipPipeline);
        mp.setBindGroup(0, bg);
        mp.draw(3);
        mp.end();
      }
    }
    // i draw di un segmento nel pass corrente (pipeline per-draw: i figli
    // clippati usano il blend DST_ALPHA — colore sostituito, forma della base)
    const drawList = (/** @type {any} */ pass, /** @type {Draw[]} */ list,
      /** @type {any} */ pipeNormal, /** @type {any} */ pipeClip) => {
      /** @type {any} */ let curPipe = null;
      let scissOn = false;
      for (const d of list) {
        const pipe = d.clip ? pipeClip
          : d.pipe === 'screen' ? this._pipeScreen
          : d.pipe === 'add' ? this._pipeAdd
          : d.pipe === 'blend' ? this._pipeBlend
          : pipeNormal;
        if (pipe !== curPipe) { pass.setPipeline(pipe); curPipe = pipe; }
        // clip al board dei quad testo/svg (lo scissor persiste: ripristino)
        if (d.sciss) {
          pass.setScissorRect(d.sciss[0], d.sciss[1], d.sciss[2], d.sciss[3]);
          scissOn = true;
        } else if (scissOn) {
          pass.setScissorRect(0, 0, W, H);
          scissOn = false;
        }
        const lt = d.lt === 'GRP' ? this._grpTex : d.lt;
        const bind = this.device.createBindGroup({
          layout: this._bgl,
          entries: [
            { binding: 0, resource: d.samp || samp },
            { binding: 1, resource: this._viewsOf(lt || this._white).full },
            { binding: 2, resource: this._viewsOf(d.st || this._white).full },
            { binding: 3, resource: { buffer: this._uniBuf, size: 64 } },
            { binding: 4, resource: this._viewsOf(this._bdTex || this._white).full },
          ],
        });
        pass.setBindGroup(0, bind, [/** @type {number} */ (d._ui) * 256]);
        pass.draw(6);
      }
    };

    const canvasTex = this._ctx.getCurrentTexture();
    const canvasView = canvasTex.createView();
    let canvasStarted = false;
    for (const seg of segments) {
      if (seg.group) {
        // pass del gruppo: base+figli nell'FBO canvas-size, azzerato
        this._ensureGrpTex(W, H);
        const gp = enc.beginRenderPass({
          colorAttachments: [{
            view: this._viewsOf(this._grpTex).full,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear', storeOp: 'store',
          }],
        });
        drawList(gp, seg.draws, this._pipelineGrp, this._pipelineGrpClip);
        gp.end();
        continue;
      }
      if (seg.draws.length === 0 && canvasStarted) continue;
      if (seg.bd) {
        // modi shader: il backdrop accumulato (solo il bbox) si copia in
        // una texture — il pass fusione lo campiona via textureLoad
        this._ensureBdTex(W, H);
        enc.copyTextureToTexture(
          { texture: canvasTex, origin: [seg.bd[0], seg.bd[1]] },
          { texture: this._bdTex, origin: [seg.bd[0], seg.bd[1]] },
          [seg.bd[2], seg.bd[3]]);
      }
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: canvasStarted ? 'load' : 'clear', storeOp: 'store',
        }],
      });
      canvasStarted = true;
      drawList(pass, seg.draws, this._pipeline, this._pipeline);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
  }

  /** Backdrop dei modi shader: texture canvas-size nel formato del canvas.
   * @param {number} w @param {number} h */
  _ensureBdTex(w, h) {
    if (this._bdTex && this._bdTex.width === w && this._bdTex.height === h) return;
    if (this._bdTex) this._bdTex.destroy();
    this._bdTex = this.device.createTexture({
      size: [w, h], format: this._format,
      usage: /* TEXTURE_BINDING|COPY_DST */ 0x4 | 0x2,
    });
  }

  /** FBO dei gruppi di ritaglio: texture canvas-size, ricreata al resize.
   * @param {number} w @param {number} h */
  _ensureGrpTex(w, h) {
    if (this._grpTex && this._grpTex.width === w && this._grpTex.height === h) return;
    if (this._grpTex) this._grpTex.destroy();
    this._grpTex = this.device.createTexture({
      size: [w, h], format: 'rgba8unorm',
      usage: /* TEXTURE_BINDING|RENDER_ATTACHMENT */ 0x4 | 0x10,
    });
  }

  dispose() {}
}
