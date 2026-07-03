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
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var strokeTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: U;

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

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
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
`;

/** @type {any} */ let sharedDevice = null;
let preinitTried = false;

export class WgpuRenderer {
  /** true dopo preinit riuscita: il costruttore sincrono può usare il device */
  static get available() { return sharedDevice !== null; }

  /** Da chiamare (await) PRIMA di new App quando il flag è attivo. */
  static async preinit() {
    if (preinitTried) return sharedDevice !== null;
    preinitTried = true;
    try {
      const gpu = /** @type {any} */ (navigator).gpu;
      if (!gpu) return false;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return false;
      sharedDevice = await adapter.requestDevice();
      return true;
    } catch {
      return false;
    }
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
      this._ctx.configure({ device: this.device, format: this._format, alphaMode: 'premultiplied' });
      const module = this.device.createShaderModule({ code: WGSL });
      this._bgl = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 2, sampler: {} },
          { binding: 1, visibility: 2, texture: {} },
          { binding: 2, visibility: 2, texture: {} },
          { binding: 3, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } },
        ],
      });
      this._pipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module, entryPoint: 'fs',
          targets: [{
            format: this._format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });
      this._sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this._samplerNearest = this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
      this._white = this.device.createTexture({
        size: [1, 1], format: 'rgba8unorm',
        usage: /* TEXTURE_BINDING|COPY_DST */ 0x4 | 0x2,
      });
      this.ok = true;
    } catch (err) {
      console.warn('[renderer_wgpu] init fallita:', err);
      this.ok = false;
    }
  }

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
      } else {
        this._uploadNow(chunk);
        bytes += chunk.data.length;
      }
    }
    store.dirty.clear();
    return bytes;
  }

  /** @param {Chunk} chunk */
  _uploadNow(chunk) {
    let tex = this._tex.get(chunk);
    if (!tex) {
      tex = this.device.createTexture({
        size: [CHUNK, CHUNK], format: 'rgba8unorm',
        usage: /* TEXTURE_BINDING|COPY_DST */ 0x4 | 0x2,
      });
      this._tex.set(chunk, tex);
      this.texCount++;
    }
    this.device.queue.writeTexture({ texture: tex },
      /** @type {Uint8Array} */ (/** @type {unknown} */ (chunk.data)),
      { bytesPerRow: CHUNK * 4 }, [CHUNK, CHUNK]);
    chunk.texDirty = false;
    chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
    this.uploadsThisFrame++;
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
    /** @type {{lt: any, st: any, x0: number, y0: number, x1: number, y1: number, mode: number, a: number}[]} */
    const draws = [];
    const pushChunk = (/** @type {Chunk} */ chunk, /** @type {any} */ st,
      /** @type {number} */ mode, /** @type {number} */ alpha) => {
      const x0 = Math.round(chunk.cx * CHUNK * s + tx);
      const y0 = Math.round(chunk.cy * CHUNK * s + ty);
      const x1 = Math.round((chunk.cx + 1) * CHUNK * s + tx);
      const y1 = Math.round((chunk.cy + 1) * CHUNK * s + ty);
      draws.push({ lt: this._tex.get(chunk), st, x0, y0, x1, y1, mode, a: alpha });
    };

    const skip = proxies ? proxies.skip : null;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (skip !== null && skip.has(layer.id)) continue;
      if (layer.kind === 'text' || layer.kind === 'svg') {
        if (textQuads || svgQuads) this._warnOnce('quad testo/svg');
        continue;
      }
      if (layer.kind !== 'raster') continue;
      if (layer.clip && layer.clipBase) { this._warnOnce('gruppi di ritaglio (figli)'); continue; }
      const mode = layer.mode || 'normal';
      if (mode !== 'normal') this._warnOnce(`blend mode ${mode}`);
      const alpha = layer.opacity;
      const live = strokeStore !== null && layer.id === activeId && strokeStore.map.size > 0;
      for (const chunk of layer.store.map.values()) {
        if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
        if (chunk.texDirty || !this._tex.has(chunk)) this._uploadNow(chunk);
        if (live) {
          const sc = /** @type {NonNullable<typeof strokeStore>} */ (strokeStore).getByKey(chunk.key);
          if (sc) {
            if (sc.texDirty || !this._tex.has(sc)) this._uploadNow(sc);
            pushChunk(chunk, this._tex.get(sc), eraserLive ? 2 : 1, alpha);
            continue;
          }
        }
        pushChunk(chunk, null, 0, alpha);
      }
      if (live && !eraserLive) {
        // tratto su zone vuote del livello (over diretto, esatto)
        for (const sc of /** @type {NonNullable<typeof strokeStore>} */ (strokeStore).map.values()) {
          if (sc.cx < cx0 || sc.cx > cx1 || sc.cy < cy0 || sc.cy > cy1) continue;
          if (layer.store.getByKey(sc.key)) continue;
          if (sc.texDirty || !this._tex.has(sc)) this._uploadNow(sc);
          pushChunk(sc, this._tex.get(sc), 3, alpha);
        }
      }
    }

    // uniform a offset dinamici, una fetta da 256B per draw
    const need = Math.max(256, draws.length * 256);
    if (need > this._uniCap) {
      if (this._uniBuf) this._uniBuf.destroy();
      this._uniCap = need * 2;
      this._uniBuf = this.device.createBuffer({ size: this._uniCap, usage: 0x40 | 0x8 });
    }
    const uni = new ArrayBuffer(Math.max(256, draws.length * 256));
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      const f = new Float32Array(uni, i * 256, 8);
      const u32 = new Uint32Array(uni, i * 256, 12);
      f[0] = d.x0; f[1] = d.y0; f[2] = d.x1; f[3] = d.y1;
      f[4] = W; f[5] = H;
      f[6] = d.a; f[7] = strokeOpacity;
      u32[8] = d.mode;
    }
    this.device.queue.writeBuffer(this._uniBuf, 0, uni);

    const samp = camera.zoom <= 3.8 ? this._sampler : this._samplerNearest;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this._ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear', storeOp: 'store',
      }],
    });
    pass.setPipeline(this._pipeline);
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      const bind = this.device.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: samp },
          { binding: 1, resource: (d.lt || this._white).createView() },
          { binding: 2, resource: (d.st || this._white).createView() },
          { binding: 3, resource: { buffer: this._uniBuf, size: 64 } },
        ],
      });
      pass.setBindGroup(0, bind, [i * 256]);
      pass.draw(6);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  dispose() {}
}
