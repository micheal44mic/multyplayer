// Kernel WebGPU della CAPSULE v2 a interi — speculare a js/capsule_int.js
// (lo spec vive lì; qui la stessa matematica in WGSL). Determinismo:
// le uniche operazioni non banali — floor((num·65536)/den) e floor(sqrt) —
// hanno un solo risultato matematico: qui si calcolano con approssimazione
// f32 CORRETTA da verifiche esatte in u32 (mul 32×32→64 a limbs), in JS con
// f64 esatto + correzione. Stessi bit per costruzione.
// Parallelismo: thread per pixel, loop sulle capsule in ordine (wash `>`,
// primo vince sui pari — identico all'iterazione sequenziale).

export const WGSL_CAPSULE = /* wgsl */ `
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
  hq: u32,
  colR: u32,
  colG: u32,
  colB: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> pix: array<u32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;   // FALLOFF_LUT u16 a coppie
@group(0) @binding(2) var<storage, read> segs: array<i32>;  // stride 10: X0,Y0,DX,DY,den,R0,DR,A0,DA,pad
@group(0) @binding(3) var<uniform> P: Params;

fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn lut16(i: u32) -> u32 {
  return (lut[i >> 1u] >> (16u * (i & 1u))) & 0xffffu;
}

// a*b a 64 bit come (hi, lo), tutto in u32
fn mul64(a: u32, b: u32) -> vec2<u32> {
  let a0 = a & 0xffffu; let a1 = a >> 16u;
  let b0 = b & 0xffffu; let b1 = b >> 16u;
  let ll = a0 * b0;
  let lh = a0 * b1;
  let hl = a1 * b0;
  let mid = lh + hl;
  let carry = select(0u, 0x10000u, mid < lh);
  let lo = ll + (mid << 16u);
  let c2 = select(0u, 1u, lo < ll);
  let hi = a1 * b1 + (mid >> 16u) + carry + c2;
  return vec2<u32>(hi, lo);
}

// (a64 <= b64)? confronto di coppie (hi,lo)
fn le64(a: vec2<u32>, b: vec2<u32>) -> bool {
  return a.x < b.x || (a.x == b.x && a.y <= b.y);
}

// floor((num<<16 + den/2)/den) — t ARROTONDATO, 0 < num < den <= 2^25:
// risultato <= 65536. f32 approssima, le verifiche esatte a 64 bit correggono.
fn divT(num: u32, den: u32) -> u32 {
  let lo0 = num << 16u;
  let lo = lo0 + (den >> 1u);
  let n64 = vec2<u32>((num >> 16u) + select(0u, 1u, lo < lo0), lo);
  var q = u32(clamp(f32(num) * 65536.0 / f32(den) + 0.5, 0.0, 65536.0));
  for (var k = 0u; k < 8u; k = k + 1u) {
    if (!le64(mul64(q, den), n64)) {          // q*den > num<<16 -> troppo alto
      q = q - 1u;
    } else if (le64(mul64(q + 1u, den), n64)) { // (q+1)*den <= num<<16 -> troppo basso
      q = q + 1u;
    } else {
      break;
    }
  }
  return q;
}

// round(sqrt(n)) esatto, n < 2^31 (mai tie): f32 approssima, i quadrati
// esatti in u32 correggono il floor, poi n > s²+s decide l'arrotondamento
fn isqrtRound(n: u32) -> u32 {
  var s = min(u32(sqrt(f32(n))), 46340u);
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (s * s > n) {
      s = s - 1u;
    } else if ((s + 1u) * (s + 1u) <= n) {
      s = s + 1u;
    } else {
      break;
    }
  }
  if (n > s * s + s) { s = s + 1u; }
  return s;
}

// ma (0..255) della capsula al pixel (px,py in 1/16 px) — riga per riga
// speculare a capsuleIntMa in capsule_int.js
fn capsuleMa(o: u32, px: i32, py: i32) -> u32 {
  let rx = px - segs[o];
  let ry = py - segs[o + 1u];
  let dx = segs[o + 2u];
  let dy = segs[o + 3u];
  let r0 = segs[o + 5u];
  let dr = segs[o + 6u];
  // scarto rapido: box di Chebyshev attorno ai due estremi, gonfiato di
  // Rmax+1px — soprainsieme del disco, l'output non cambia
  let rmax = max(r0, r0 + dr);
  let pad = rmax + 32;
  if (rx < min(0, dx) - pad || rx > max(0, dx) + pad ||
      ry < min(0, dy) - pad || ry > max(0, dy) + pad) { return 0u; }
  let den = segs[o + 4u];
  let num = rx * dx + ry * dy;
  var tq: u32;
  if (den == 0 || num <= 0) { tq = 0u; }
  else if (num >= den) { tq = 65536u; }
  else { tq = divT(u32(num), u32(den)); }
  let ti = i32(tq);
  let qx = rx - ((dx * ti) >> 16u);
  let qy = ry - ((dy * ti) >> 16u);
  let rT = r0 + ((dr * ti) >> 16u);
  let lim = rT + 32;
  if (lim <= 0) { return 0u; }
  // d² in u32: qx²+qy² può superare i31 (q fino a ~2^15.2 post-cull)
  let d2 = u32(qx * qx) + u32(qy * qy);
  let ulim = u32(lim);
  if (d2 >= ulim * ulim) { return 0u; }
  let aT = segs[o + 7u] + ((segs[o + 8u] * (ti >> 4u)) >> 12u);
  if (aT <= 0) { return 0u; }
  let core = (rT * i32(P.hq)) >> 12u;
  let w = u32(max(rT - core, 32));
  let d = i32(isqrtRound(d2));
  var u: u32 = 0u;
  if (d > core) { u = (u32((d - core) * 1024) + (w >> 1u)) / w; }
  if (u >= 1024u) { return 0u; }
  let m = lut16(u);
  return (m * u32(aT) + (1u << 22u)) >> 23u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let gx = P.originX + i32(gid.x);
  let gy = P.originY + i32(gid.y);
  if (gx < P.clipX0 || gx > P.clipX1 || gy < P.clipY0 || gy > P.clipY1) { return; }
  let px = gx * 32 + 16;
  let py = gy * 32 + 16;
  let pi = gid.y * P.width + gid.x;
  let p = pix[pi];
  var pr = p & 0xffu;
  var pg = (p >> 8u) & 0xffu;
  var pb = (p >> 16u) & 0xffu;
  var pa = (p >> 24u) & 0xffu;
  var wrote = false;
  for (var i = 0u; i < P.n; i = i + 1u) {
    let ma = capsuleMa(i * 10u, px, py);
    if (ma > pa) {
      pr = div255(P.colR * ma);
      pg = div255(P.colG * ma);
      pb = div255(P.colB * ma);
      pa = ma;
      wrote = true;
    }
  }
  if (wrote) {
    pix[pi] = pr | (pg << 8u) | (pb << 16u) | (pa << 24u);
  }
}
`;

/**
 * Wrapper del kernel capsule per l'harness differenziale (stessa forma di
 * WgpuDabKernel). I tipi WebGPU viaggiano come any (fuori dalle lib tsc).
 */
export class WgpuCapsuleKernel {
  constructor() {
    /** @type {any} */ this.device = null;
    /** @type {any} */ this.pipeline = null;
    this.ok = false;
  }

  /** @returns {Promise<boolean>} */
  async init() {
    const gpu = /** @type {any} */ (navigator).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    const module = this.device.createShaderModule({ code: WGSL_CAPSULE });
    this.pipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    this.ok = true;
    return true;
  }

  /**
   * Applica un batch di capsule v2 alla regione e la rilegge (mapAsync).
   * @param {Uint8Array} pixels RGBA width×height×4, modificata al ritorno
   * @param {number} width @param {number} height
   * @param {number} originX @param {number} originY
   * @param {Uint16Array} lutU16 FALLOFF_LUT
   * @param {Int32Array} segRecs record piatti CAP_STRIDE_I32
   * @param {number} nSegs @param {number} hq
   * @param {number} cr @param {number} cg @param {number} cb
   * @param {{x0: number, y0: number, x1: number, y1: number}} clip
   * @returns {Promise<number>} ms host submit→map
   */
  async runBatch(pixels, width, height, originX, originY, lutU16, segRecs, nSegs, hq, cr, cg, cb, clip) {
    const dev = this.device;
    const pixBuf = dev.createBuffer({ size: pixels.byteLength, usage: 0x80 | 0x8 | 0x4 });
    dev.queue.writeBuffer(pixBuf, 0, pixels);
    const lutBytes = (lutU16.byteLength + 3) & ~3;
    const lutBuf = dev.createBuffer({ size: lutBytes, usage: 0x80 | 0x8 });
    dev.queue.writeBuffer(lutBuf, 0, lutU16, 0, lutU16.length - (lutU16.length & 1));
    if (lutU16.length & 1) {
      const tail = new Uint16Array(2);
      tail[0] = lutU16[lutU16.length - 1];
      dev.queue.writeBuffer(lutBuf, (lutU16.length - 1) * 2, tail);
    }
    const segBuf = dev.createBuffer({ size: Math.max(4, segRecs.byteLength), usage: 0x80 | 0x8 });
    dev.queue.writeBuffer(segBuf, 0, segRecs);
    const params = new ArrayBuffer(64);
    const pu = new Uint32Array(params);
    const pi = new Int32Array(params);
    pu[0] = nSegs;
    pi[1] = originX; pi[2] = originY;
    pu[3] = width; pu[4] = height;
    pi[5] = clip.x0; pi[6] = clip.y0; pi[7] = clip.x1; pi[8] = clip.y1;
    pu[9] = hq; pu[10] = cr; pu[11] = cg; pu[12] = cb;
    const parBuf = dev.createBuffer({ size: 64, usage: 0x40 | 0x8 });
    dev.queue.writeBuffer(parBuf, 0, params);
    const staging = dev.createBuffer({ size: pixels.byteLength, usage: 0x1 | 0x8 });

    const bind = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pixBuf } },
        { binding: 1, resource: { buffer: lutBuf } },
        { binding: 2, resource: { buffer: segBuf } },
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
    await staging.mapAsync(1);
    const ms = performance.now() - t0;
    pixels.set(new Uint8Array(staging.getMappedRange()));
    staging.unmap();
    for (const b of [pixBuf, lutBuf, segBuf, parBuf, staging]) b.destroy();
    return ms;
  }
}
