// Kernel WebGPU del dab — fase 1 del piano WebGPU (docs/webgpu-engine-plan.md).
// CONTRATTO: output byte-per-byte identico a Rasterizer._dab (js/raster.js,
// ramo non-LUT — il ramo LUT produce gli stessi byte per costruzione).
// Come ci si riesce: la MASCHERA dello stamp resta generata su CPU dalla
// StampCache (lì vive il float smoothstep, deterministico perché è f64 JS);
// il per-pixel è SOLO aritmetica intera u8/u32 — div255, wash col tie-break
// `>=`, buildup — che in WGSL è bit-exact su qualunque device per costruzione.
// Niente float nel path dei pixel: è il vincolo n.1 (collab deterministica).
//
// Parallelismo: thread per PIXEL, loop sui dab DENTRO il thread in ordine di
// emissione — l'operazione è per-pixel indipendente, quindi applicare i dab
// in sequenza dentro ogni thread è matematicamente identico all'applicazione
// sequenziale del riferimento (l'ordine del tie-break wash è preservato)
// senza alcuna sincronizzazione fra dab.
//
// I tipi WebGPU non sono nelle lib di tsc: gli handle GPU viaggiano come any.

export const WGSL_DAB = /* wgsl */ `
struct Params {
  n: u32,
  originX: i32,
  originY: i32,
  width: u32,
  height: u32,
  clipX0: i32,
  clipY0: i32,
  clipX1: i32,
  clipY1: i32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> pix: array<u32>;
@group(0) @binding(1) var<storage, read> masks: array<u32>;
// dab piatti, stride 12 u32: ix, iy, size, maskOff, a255, r, g, b, buildup, pad*3
@group(0) @binding(2) var<storage, read> dabs: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;

// stessa identita' intera di util.js: ((x+128) + ((x+128)>>8)) >> 8
fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn maskByte(off: u32) -> u32 {
  return (masks[off >> 2u] >> (8u * (off & 3u))) & 0xffu;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let gx = P.originX + i32(gid.x);
  let gy = P.originY + i32(gid.y);
  // il raster clampa i bbox al clip del tratto: qui il clip taglia per pixel
  if (gx < P.clipX0 || gx > P.clipX1 || gy < P.clipY0 || gy > P.clipY1) { return; }
  let pi = gid.y * P.width + gid.x;
  let p = pix[pi];
  var pr = p & 0xffu;
  var pg = (p >> 8u) & 0xffu;
  var pb = (p >> 16u) & 0xffu;
  var pa = (p >> 24u) & 0xffu;
  var wrote = false;
  for (var i = 0u; i < P.n; i = i + 1u) {
    let o = i * 12u;
    let mx = gx - bitcast<i32>(dabs[o]);
    let my = gy - bitcast<i32>(dabs[o + 1u]);
    let size = dabs[o + 2u];
    if (mx < 0 || my < 0 || mx >= i32(size) || my >= i32(size)) { continue; }
    let m = maskByte(dabs[o + 3u] + u32(my) * size + u32(mx));
    if (m == 0u) { continue; }
    let ma = div255(m * dabs[o + 4u]);
    if (ma == 0u) { continue; }
    if (dabs[o + 8u] != 0u) {
      // buildup: source-over incrementale (mai oltre 255 per identita')
      let inv = 255u - ma;
      pr = div255(dabs[o + 5u] * ma) + div255(pr * inv);
      pg = div255(dabs[o + 6u] * ma) + div255(pg * inv);
      pb = div255(dabs[o + 7u] * ma) + div255(pb * inv);
      pa = ma + div255(pa * inv);
      wrote = true;
    } else if (ma >= pa) {
      // wash: max(alpha), a parita' vince l'ULTIMO dab (>=)
      pr = div255(dabs[o + 5u] * ma);
      pg = div255(dabs[o + 6u] * ma);
      pb = div255(dabs[o + 7u] * ma);
      pa = ma;
      wrote = true;
    }
  }
  if (wrote) {
    pix[pi] = pr | (pg << 8u) | (pb << 16u) | (pa << 24u);
  }
}
`;

export const DAB_STRIDE_U32 = 12;

/**
 * Wrapper minimo del kernel per l'harness differenziale (e scheletro del
 * futuro stroke buffer GPU): un buffer pixel RGBA8-packed grande quanto la
 * regione, atlas delle maschere, batch di dab, dispatch, readback.
 */
export class WgpuDabKernel {
  constructor() {
    /** @type {any} */ this.device = null;
    /** @type {any} */ this.pipeline = null;
    this.ok = false;
  }

  /** Feature-detect a runtime (mai UA sniffing). @returns {Promise<boolean>} */
  async init() {
    const gpu = /** @type {any} */ (navigator).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    const module = this.device.createShaderModule({ code: WGSL_DAB });
    this.pipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    this.ok = true;
    return true;
  }

  /**
   * Applica un batch di dab a una regione di pixel e la rilegge (mapAsync,
   * mai readback sincrono). Test-oriented: alloca i buffer per chiamata.
   * @param {Uint8Array} pixels RGBA della regione (width×height×4), modificata al ritorno
   * @param {number} width @param {number} height
   * @param {number} originX @param {number} originY coordinate documento del pixel (0,0)
   * @param {Uint8Array} maskAtlas maschere concatenate (byte)
   * @param {Uint32Array} dabRecs record piatti stride DAB_STRIDE_U32
   * @param {number} dabCount
   * @param {{x0: number, y0: number, x1: number, y1: number}} clip
   * @returns {Promise<number>} ms GPU lato host (submit→map)
   */
  async runBatch(pixels, width, height, originX, originY, maskAtlas, dabRecs, dabCount, clip) {
    const dev = this.device;
    const pixBuf = dev.createBuffer({
      size: pixels.byteLength,
      usage: /* STORAGE|COPY_DST|COPY_SRC */ 0x80 | 0x8 | 0x4,
    });
    dev.queue.writeBuffer(pixBuf, 0, pixels);
    const maskBytes = (maskAtlas.byteLength + 3) & ~3;
    const maskBuf = dev.createBuffer({ size: Math.max(4, maskBytes), usage: 0x80 | 0x8 });
    dev.queue.writeBuffer(maskBuf, 0, maskAtlas, 0, maskAtlas.byteLength);
    const dabBuf = dev.createBuffer({ size: Math.max(4, dabRecs.byteLength), usage: 0x80 | 0x8 });
    dev.queue.writeBuffer(dabBuf, 0, dabRecs);
    const params = new ArrayBuffer(48);
    const pu = new Uint32Array(params);
    const pi = new Int32Array(params);
    pu[0] = dabCount;
    pi[1] = originX; pi[2] = originY;
    pu[3] = width; pu[4] = height;
    pi[5] = clip.x0; pi[6] = clip.y0; pi[7] = clip.x1; pi[8] = clip.y1;
    const parBuf = dev.createBuffer({ size: 48, usage: /* UNIFORM|COPY_DST */ 0x40 | 0x8 });
    dev.queue.writeBuffer(parBuf, 0, params);
    const staging = dev.createBuffer({ size: pixels.byteLength, usage: /* MAP_READ|COPY_DST */ 0x1 | 0x8 });

    const bind = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pixBuf } },
        { binding: 1, resource: { buffer: maskBuf } },
        { binding: 2, resource: { buffer: dabBuf } },
        { binding: 3, resource: { buffer: parBuf } },
      ],
    });
    const t0 = performance.now();
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    enc.copyBufferToBuffer(pixBuf, 0, staging, 0, pixels.byteLength);
    dev.queue.submit([enc.finish()]);
    await staging.mapAsync(/* READ */ 1);
    const ms = performance.now() - t0;
    pixels.set(new Uint8Array(staging.getMappedRange()));
    staging.unmap();
    for (const b of [pixBuf, maskBuf, dabBuf, parBuf, staging]) b.destroy();
    return ms;
  }
}
