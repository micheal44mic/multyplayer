// STROKE BUFFER WEBGPU — fase 1 del piano (docs/webgpu-engine-plan.md).
// Il tratto VIVO rasterizza su GPU: i descrittori diventano dispatch compute
// su un'arena di chunk 256² GPU-residenti; i pixel tornano allo store
// specchio via mapAsync (MAI readback sincrono) e da lì rendering, commit,
// undo e collab restano quelli di sempre. Stesso contratto del raster
// worker: main = autorità sulla struttura (chunk creati qui), pixel che
// atterrano in ritardo di 1-2 frame (l'ink overlay copre il volo tramite
// gli stessi contatori sent/tickDrained/inkRing del bridge).
// La matematica è quella sigillata dai test: dab = maschere CPU + interi
// (wgpu_dab.js), capsule v2 (capsule_int.js) — bit-exact col CPU per
// costruzione, quindi la collab non si accorge di chi ha rasterizzato.
// Endpass della punta = replay INTERO da zero (la GPU se lo può permettere):
// niente pool di slot da scambiare, i pixel vecchi restano visibili finché
// il replay non atterra, i chunk scoperti si azzerano a fine atterraggio.
// Flush sincrono (raro: pen-down nella finestra di commit) = il chiamante
// ributta il tratto sul CPU — stessi byte.

import { ChunkStore, CHUNK, CHUNK_SHIFT, chunkKey } from './store.js';
import { T_DAB, STRIDE } from './stroke.js';
import { CAP_STRIDE_I32, CAP_FP, FALLOFF_LUT, quantHardness, capsuleIntParams } from './capsule_int.js';
import { acquireWgpuDevice, onWgpuDeviceLost } from './wgpu_device.js';

const REC_U32 = 12;          // record kernel: [tipo, ...campi], vedi WGSL
const SLOT_WORDS = CHUNK * CHUNK; // 65536 u32 = 256KB per chunk
const ARENA_START = 96;      // slot iniziali (24MB), cresce ×2
const ATLAS_START = 4 << 20; // atlas maschere iniziale (4MB)
const INK_RING = 2048;
// SAFETY (solo modalità 'safe'): il kernel cicla TUTTI i record del batch
// per ogni pixel di ogni chunk toccato — lavoro ≈ chunk × 65536 × recCount.
// Il tetto spezza i batch texture enormi in più submit; il freeze visto in
// sviluppo non è mai stato riprodotto sul campo, quindi il tetto è una
// guardia estrema da A/B, non il path di default.
const WORK_CAP = 256 << 20;  // record-pixel per submit (modalità safe)
// Texture GPU-direct, A/B dietro flag (?texgpu=..., persiste in localStorage):
//   'fast' = path originale puro (un batch per tick, zero log) — il
//            default di prodotto dopo test campo senza freeze;
//   'safe' = tetto di lavoro a fette + log per-batch (diagnostica);
//   'off'  = fallback worker/main persistente (kill-switch/supporto).
const TEX_GPU_MODE = (() => {
  try {
    const q = (new URLSearchParams(location.search).get('texgpu') || '').toLowerCase();
    if (q === 'fast' || q === 'safe') { localStorage.setItem('fable-paint.texgpu', q); return q; }
    if (q === 'on' || q === '1' || q === 'true') {
      localStorage.setItem('fable-paint.texgpu', 'fast');
      return 'fast';
    }
    if (q === 'off') { localStorage.setItem('fable-paint.texgpu', 'off'); return 'off'; }
    const s = localStorage.getItem('fable-paint.texgpu');
    return s === 'fast' || s === 'safe' || s === 'off' ? s : s === '1' ? 'fast' : 'fast';
  } catch { return 'fast'; }
})();

export const WGSL_STROKE = /* wgsl */ `
struct Params {
  chunkOX: i32,
  chunkOY: i32,
  slotBase: u32,
  recCount: u32,
  clipX0: i32,
  clipY0: i32,
  clipX1: i32,
  clipY1: i32,
  hq: i32,
  buildup: u32,
  capR: u32,
  capG: u32,
  capB: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> arena: array<u32>;
@group(0) @binding(1) var<storage, read> masks: array<u32>;
@group(0) @binding(2) var<storage, read> lut: array<u32>;
@group(0) @binding(3) var<storage, read> recs: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;
// tile della grana ANCORATA al canvas, per slot (fattore 1B/px e RGBX
// 4B/px, stessi byte dei tile CPU del Rasterizer): dummy quando il tratto
// non ha texture — i record senza flag non li leggono mai
@group(0) @binding(5) var<storage, read> tileLum: array<u32>;
@group(0) @binding(6) var<storage, read> tileRgb: array<u32>;

fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}
fn maskByte(off: u32) -> u32 {
  return (masks[off >> 2u] >> (8u * (off & 3u))) & 0xffu;
}
fn lut16(i: u32) -> u32 {
  return (lut[i >> 1u] >> (16u * (i & 1u))) & 0xffffu;
}
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
fn le64(a: vec2<u32>, b: vec2<u32>) -> bool {
  return a.x < b.x || (a.x == b.x && a.y <= b.y);
}
fn divT(num: u32, den: u32) -> u32 {
  let lo0 = num << 16u;
  let lo = lo0 + (den >> 1u);
  let n64 = vec2<u32>((num >> 16u) + select(0u, 1u, lo < lo0), lo);
  var q = u32(clamp(f32(num) * 65536.0 / f32(den) + 0.5, 0.0, 65536.0));
  for (var k = 0u; k < 8u; k = k + 1u) {
    if (!le64(mul64(q, den), n64)) { q = q - 1u; }
    else if (le64(mul64(q + 1u, den), n64)) { q = q + 1u; }
    else { break; }
  }
  return q;
}
fn isqrtRound(n: u32) -> u32 {
  var s = min(u32(sqrt(f32(n))), 46340u);
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (s * s > n) { s = s - 1u; }
    else if ((s + 1u) * (s + 1u) <= n) { s = s + 1u; }
    else { break; }
  }
  if (n > s * s + s) { s = s + 1u; }
  return s;
}

// capsule v2 (speculare a capsuleIntMa)
fn capsuleMa(o: u32, px: i32, py: i32) -> u32 {
  let rx = px - bitcast<i32>(recs[o + 1u]);
  let ry = py - bitcast<i32>(recs[o + 2u]);
  let dx = bitcast<i32>(recs[o + 3u]);
  let dy = bitcast<i32>(recs[o + 4u]);
  let r0 = bitcast<i32>(recs[o + 6u]);
  let dr = bitcast<i32>(recs[o + 7u]);
  let rmax = max(r0, r0 + dr);
  let pad = rmax + 32;
  if (rx < min(0, dx) - pad || rx > max(0, dx) + pad ||
      ry < min(0, dy) - pad || ry > max(0, dy) + pad) { return 0u; }
  let den = recs[o + 5u];
  let num = rx * dx + ry * dy;
  var tq: u32;
  if (den == 0u || num <= 0) { tq = 0u; }
  else if (num >= bitcast<i32>(den)) { tq = 65536u; }
  else { tq = divT(u32(num), den); }
  let ti = i32(tq);
  let qx = rx - ((dx * ti) >> 16u);
  let qy = ry - ((dy * ti) >> 16u);
  let rT = r0 + ((dr * ti) >> 16u);
  let lim = rT + 32;
  if (lim <= 0) { return 0u; }
  let d2 = u32(qx * qx) + u32(qy * qy);
  let ulim = u32(lim);
  if (d2 >= ulim * ulim) { return 0u; }
  let aT = bitcast<i32>(recs[o + 8u]) + ((bitcast<i32>(recs[o + 9u]) * (ti >> 4u)) >> 12u);
  if (aT <= 0) { return 0u; }
  let core = (rT * P.hq) >> 12u;
  let w = u32(max(rT - core, 32));
  let d = i32(isqrtRound(d2));
  var u: u32 = 0u;
  if (d > core) { u = (u32((d - core) * 1024) + (w >> 1u)) / w; }
  if (u >= 1024u) { return 0u; }
  return (lut16(u) * u32(aT) + (1u << 22u)) >> 23u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gx = P.chunkOX + i32(gid.x);
  let gy = P.chunkOY + i32(gid.y);
  if (gx < P.clipX0 || gx > P.clipX1 || gy < P.clipY0 || gy > P.clipY1) { return; }
  let pi = P.slotBase + (gid.y << 8u) + gid.x;
  // indici tile del pixel: slotBase = slot·65536 -> slot = slotBase>>16;
  // lum a 1B/px (16384 u32/slot), rgbx a 4B/px (65536 u32/slot)
  let li = (gid.y << 8u) + gid.x;
  let lumBase = (P.slotBase >> 16u) * 16384u;
  let rgbBase = P.slotBase + li;
  let p = arena[pi];
  var pr = p & 0xffu;
  var pg = (p >> 8u) & 0xffu;
  var pb = (p >> 16u) & 0xffu;
  var pa = (p >> 24u) & 0xffu;
  var wrote = false;
  for (var i = 0u; i < P.recCount; i = i + 1u) {
    let o = i * 12u;
    if (recs[o] == 0u) {
      // dab: maschera CPU + interi (wash >= / buildup), come wgpu_dab.js;
      // flags: 1 = ×fattore tile (grana fissa: m2=div255(m·f) PRIMA di
      // a255, come _dabTile), 2 = colore dal tile RGBX, 4 = colore per
      // stamp dall'atlas (grana moving in modalità colore — la maschera
      // moving arriva già pre-modulata dal bake CPU, qui è un dab normale)
      let mx = gx - bitcast<i32>(recs[o + 1u]);
      let my = gy - bitcast<i32>(recs[o + 2u]);
      let size = recs[o + 3u];
      if (mx < 0 || my < 0 || mx >= i32(size) || my >= i32(size)) { continue; }
      let flags = recs[o + 9u];
      var m = maskByte(recs[o + 4u] + u32(my) * size + u32(mx));
      if (m == 0u) { continue; }
      if ((flags & 1u) != 0u) {
        let f = (tileLum[lumBase + (li >> 2u)] >> (8u * (li & 3u))) & 0xffu;
        m = div255(m * f);
        if (m == 0u) { continue; }
      }
      let ma = div255(m * recs[o + 5u]);
      if (ma == 0u) { continue; }
      var cr = recs[o + 6u];
      var cg = recs[o + 7u];
      var cb = recs[o + 8u];
      if ((flags & 2u) != 0u) {
        let px4 = tileRgb[rgbBase];
        cr = px4 & 0xffu; cg = (px4 >> 8u) & 0xffu; cb = (px4 >> 16u) & 0xffu;
      } else if ((flags & 4u) != 0u) {
        let ci = recs[o + 10u] + (u32(my) * size + u32(mx)) * 3u;
        cr = maskByte(ci); cg = maskByte(ci + 1u); cb = maskByte(ci + 2u);
      }
      if (P.buildup != 0u) {
        let inv = 255u - ma;
        pr = div255(cr * ma) + div255(pr * inv);
        pg = div255(cg * ma) + div255(pg * inv);
        pb = div255(cb * ma) + div255(pb * inv);
        pa = ma + div255(pa * inv);
        wrote = true;
      } else if (ma >= pa) {
        pr = div255(cr * ma);
        pg = div255(cg * ma);
        pb = div255(cb * ma);
        pa = ma;
        wrote = true;
      }
    } else {
      // capsule v2: sempre wash, tie al primo (>); flags[10]: 1 = ×fattore
      // tile (ma=div255(maB·f), come _capsuleTex), 2 = colore dal tile RGBX
      var ma = capsuleMa(o, gx * 32 + 16, gy * 32 + 16);
      let flags = recs[o + 10u];
      if (ma != 0u && (flags & 1u) != 0u) {
        let f = (tileLum[lumBase + (li >> 2u)] >> (8u * (li & 3u))) & 0xffu;
        ma = div255(ma * f);
      }
      if (ma > pa) {
        var cr = P.capR;
        var cg = P.capG;
        var cb = P.capB;
        if ((flags & 2u) != 0u) {
          let px4 = tileRgb[rgbBase];
          cr = px4 & 0xffu; cg = (px4 >> 8u) & 0xffu; cb = (px4 >> 16u) & 0xffu;
        }
        pr = div255(cr * ma);
        pg = div255(cg * ma);
        pb = div255(cb * ma);
        pa = ma;
        wrote = true;
      }
    }
  }
  if (wrote) {
    arena[pi] = pr | (pg << 8u) | (pb << 16u) | (pa << 24u);
  }
}
`;

export class WgpuStrokeBridge {
  /** Feature-detect a runtime; null se WebGPU non c'è. @param {() => void} requestFrame */
  static async create(requestFrame) {
    try {
      // device CONDIVISO col renderer WebGPU (fase 2.2): il present legge
      // l'arena del ponte via copyBufferToTexture, serve lo stesso device
      const device = await acquireWgpuDevice();
      if (!device) return null;
      const b = new WgpuStrokeBridge(device, requestFrame);
      await b._init();
      return b;
    } catch (err) {
      console.warn('[wgpu_stroke] init fallita, fallback worker/CPU:', err);
      return null;
    }
  }

  /** @param {any} device @param {() => void} requestFrame */
  constructor(device, requestFrame) {
    /** @type {any} */ this.device = device;
    this._requestFrame = requestFrame;
    /** @type {any} */ this.pipeline = null;
    /** @type {any} */ this._lutBuf = null;
    /** @type {any} */ this._arena = null;
    this._arenaSlots = 0;
    /** @type {number[]} */ this._freeSlots = [];
    /** @type {Map<number, number>} chiave chunk -> slot */
    this._slotOf = new Map();
    /** @type {Set<number>} slot da azzerare al prossimo encode */
    this._needClear = new Set();
    /** @type {any} */ this._atlas = null;
    this._atlasCap = ATLAS_START;
    this._atlasUsed = 0;
    /** @type {Map<object, number>} stamp -> offset atlas */
    this._atlasOff = new Map();
    /** @type {{off: number, mask: Uint8Array}[]} */
    this._maskWrites = [];
    // GRANA ANCORATA al canvas: tile per slot (fattore 1B/px, RGBX 4B/px in
    // modalità colore) cotti dal Rasterizer del main (this._raster._tile —
    // stessi byte del CPU per costruzione) e caricati quando il chunk
    // prende lo slot. Buffer creati pigri al primo tratto texture, dummy
    // nel bind group fino ad allora.
    /** @type {any} */ this._tileLum = null;
    /** @type {any} */ this._tileRgb = null;
    /** @type {any} */ this._dummyTile = null;
    /** @type {{key: number, slot: number}[]} */
    this._tileWrites = [];
    this._tileMode = 0;      // 0 = niente grana fissa, 1 = fattore, 2 = +RGBX
    this._movingTex = false; // grana moving: maschere pre-modulate dal bake
    this._texSafe = false;   // tratto texture in modalità 'safe' (cap+log)
    /** @type {import('./raster.js').Rasterizer|null} fonte tile/bake (main) */
    this._raster = null;
    // store specchio: i chunk CPU dove atterrano i readback (il renderer e
    // il commit leggono da qui, come per il worker)
    this.store = new ChunkStore('gpu-stroke', null);
    this.usable = false;
    // stato per-tratto
    /** @type {import('./stroke.js').Snap|null} */
    this._snap = null;
    /** @type {{x0:number,y0:number,x1:number,y1:number}|null} */
    this._clip = null;
    /** @type {import('./brush.js').StampCache|null} */
    this._cache = null;
    this._hq = 0;
    // batch del frame: record + chunk toccati + rect sporco per chunk
    /** @type {number[]} */
    this._recs = [];
    /** @type {Set<number>} */
    this._chunks = new Set();
    /** @type {Map<number, {x0: number, y0: number, x1: number, y1: number}>} */
    this._dirty = new Map();     // rect locale al chunk: readback a banda + markDirty preciso
    // buffer PERSISTENTI (niente crea-e-distruggi per frame: era una fonte
    // di scatti) + pool di staging con flag busy (mai riusare un buffer mappato)
    /** @type {any} */ this._recBuf = null;
    this._recCap = 0;
    /** @type {any} */ this._uniBuf = null;
    this._uniCap = 0;
    /** @type {any} */ this._bind = null; // bind group cache: cade quando un buffer si ricrea
    /** @type {{buf: any, size: number, busy: boolean}[]} */
    this._stagingPool = [];
    // misure per il pannello perf
    this.statBytes = 0;          // byte riletti nel tratto corrente
    this.statBatches = 0;        // batch sottomessi nel tratto
    this.statLandMs = 0;         // ultimo submit->atterraggio (ms)
    this._inflight = 0;          // batch sottomessi non ancora atterrati
    this.gen = 0;                // bump = i readback in volo si scartano
    /** @type {Set<number>|null} chiavi da azzerare a fine endpass se scoperte */
    this._endpassZero = null;
    // contatori/ring per l'ink overlay (stesso contratto del raster bridge)
    this.sent = 0;
    this.tickDrained = 0;
    this.inkRing = new Float32Array(INK_RING * 8);
    // modalità DIRECT (fase 2.2): il renderer WebGPU legge l'arena con
    // copyBufferToTexture nello stesso frame del dispatch — niente readback
    // nel loop, il mirror CPU atterra UNA volta sola al commit (requestLand)
    this.direct = false;
    this.presentDrained = 0;     // entry già a schermo via arena (solo direct)
    this._landing = false;       // readback di commit in volo
  }

  /** Fin dove l'ink overlay può smettere di coprire: in direct i pixel sono
   * a schermo al submit, altrimenti quando atterrano nel mirror. */
  get overlayDrained() { return this.direct ? this.presentDrained : this.tickDrained; }

  /** Slot GPU del chunk (per il renderer in direct). @param {number} key */
  slotOfKey(key) { return this._slotOf.get(key); }

  /** Buffer arena corrente (può cambiare alla crescita: rileggerlo a ogni frame). */
  get arenaBuffer() { return this._arena; }

  async _init() {
    const dev = this.device;
    const module = dev.createShaderModule({ code: WGSL_STROKE });
    // layout ESPLICITO: il binding 4 usa offset dinamici (un uniform per
    // chunk a fette di 256B) e 'auto' non li abiliterebbe
    this._bgl = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'storage' } },
        { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: 4, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 5, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: 4, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = await dev.createComputePipelineAsync({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this._bgl] }),
      compute: { module, entryPoint: 'main' },
    });
    this._lutBuf = dev.createBuffer({ size: 2052, usage: 0x80 | 0x8 });
    // writeBuffer vuole multipli di 4 byte: LUT (2050) in copia paddata
    const lutBytes = new Uint8Array(2052);
    lutBytes.set(new Uint8Array(FALLOFF_LUT.buffer, 0, FALLOFF_LUT.length * 2));
    dev.queue.writeBuffer(this._lutBuf, 0, lutBytes);
    this._growArena(ARENA_START);
    // COPY_SRC anche sull'atlas: la crescita copia il vecchio nel nuovo
    this._atlas = dev.createBuffer({ size: this._atlasCap, usage: 0x80 | 0x8 | 0x4 });
    // segnaposto dei binding tile quando il tratto non ha grana fissa
    this._dummyTile = dev.createBuffer({ size: 16, usage: /* STORAGE */ 0x80 });
    this.usable = true;
    // device perso (Android in background, TDR): il ponte si spegne e sveglia
    // l'app, che ributta l'eventuale tratto in corso sul CPU (stessi byte) —
    // senza questo il commit aspetterebbe per sempre un atterraggio mai fatto
    onWgpuDeviceLost(() => {
      if (!this.usable) return;
      this.usable = false;
      console.warn('[wgpu_stroke] device perso: ponte GPU spento, tratti su worker/CPU');
      this._requestFrame();
    });
  }

  /** @param {number} slots */
  _growArena(slots) {
    const dev = this.device;
    const nb = dev.createBuffer({ size: slots * SLOT_WORDS * 4, usage: 0x80 | 0x8 | 0x4 });
    if (this._arena) {
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(this._arena, 0, nb, 0, this._arenaSlots * SLOT_WORDS * 4);
      dev.queue.submit([enc.finish()]);
      this._arena.destroy();
    }
    // i tile seguono l'arena slot per slot: stessa crescita, con copia (gli
    // slot già assegnati mantengono la grana caricata)
    if (this._tileLum) {
      this._tileLum = this._growCopy(this._tileLum, this._arenaSlots * CHUNK * CHUNK,
        slots * CHUNK * CHUNK);
    }
    if (this._tileRgb) {
      this._tileRgb = this._growCopy(this._tileRgb, this._arenaSlots * SLOT_WORDS * 4,
        slots * SLOT_WORDS * 4);
    }
    for (let i = this._arenaSlots; i < slots; i++) this._freeSlots.push(i);
    this._arena = nb;
    this._arenaSlots = slots;
    this._bind = null; // il bind group referenzia l'arena vecchia
  }

  /** Ricrea un buffer storage più grande copiando il contenuto vecchio.
   * @param {any} buf @param {number} oldBytes @param {number} newBytes */
  _growCopy(buf, oldBytes, newBytes) {
    const dev = this.device;
    const nb = dev.createBuffer({ size: newBytes, usage: 0x80 | 0x8 | 0x4 });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, nb, 0, oldBytes);
    dev.queue.submit([enc.finish()]);
    buf.destroy();
    return nb;
  }

  get idle() {
    return this.sent === this.tickDrained && this._recs.length === 0 && this._inflight === 0;
  }

  // in direct il "non ancora visibile" è sent-presentDrained (il mirror
  // atterra solo al commit: sent-tickDrained mostrerebbe numeri finti)
  get backlog() { return Math.max(0, this.sent - (this.direct ? this.presentDrained : this.tickDrained)); }

  /**
   * Gate per-tratto (come il bridge worker): niente aqua/selezione. La
   * TEXTURE passa: grana fissa = tile per chunk cotti dal Rasterizer del
   * main e caricati per slot; grana moving = maschere pre-modulate dal bake
   * CPU nell'atlas (il kernel non se ne accorge). Serve `raster` come fonte
   * di tile e bake — senza, i tratti texture ripiegano su worker/main.
   * @param {import('./stroke.js').Snap} snap
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip
   * @param {object|null} sel
   * @param {import('./brush.js').StampCache} cache
   * @param {import('./raster.js').Rasterizer|null} [raster]
   */
  beginStroke(snap, clip, sel, cache, raster = null) {
    if (!this.usable || sel !== null || snap.aqua) return false;
    const tex = !!(snap.tex && snap.texLut);
    if (tex && (!raster || TEX_GPU_MODE === 'off')) return false;
    // 'safe' = tetto di lavoro + log per-batch; 'fast' = path originale
    this._texSafe = tex && TEX_GPU_MODE === 'safe';
    this._snap = snap;
    this._clip = { ...clip };
    this._cache = cache;
    this._raster = raster;
    this._movingTex = tex && snap.texMoving;
    this._tileMode = tex && !snap.texMoving ? (snap.texColor ? 2 : 1) : 0;
    this._hq = quantHardness(snap.hardness);
    this._ensureTileBufs();
    this._resetGpuState();
    this._endpassZero = null;
    this.presentDrained = this.sent;
    this.statBytes = 0;
    this.statBatches = 0;
    return true;
  }

  // Buffer dei tile della grana fissa, pigri (solo chi usa texture li paga)
  // e in lockstep con gli slot dell'arena.
  _ensureTileBufs() {
    const dev = this.device;
    if (this._tileMode > 0 && !this._tileLum) {
      this._tileLum = dev.createBuffer({
        size: this._arenaSlots * CHUNK * CHUNK, usage: 0x80 | 0x8 | 0x4,
      });
      this._bind = null;
    }
    if (this._tileMode === 2 && !this._tileRgb) {
      this._tileRgb = dev.createBuffer({
        size: this._arenaSlots * SLOT_WORDS * 4, usage: 0x80 | 0x8 | 0x4,
      });
      this._bind = null;
    }
  }

  _resetGpuState() {
    // slot tutti liberi (i nuovi alloc partono azzerati), atlas per-tratto
    this._slotOf.clear();
    this._needClear.clear();
    this._freeSlots.length = 0;
    for (let i = 0; i < this._arenaSlots; i++) this._freeSlots.push(i);
    this._atlasOff.clear();
    this._atlasUsed = 0;
    this._maskWrites.length = 0;
    this._tileWrites.length = 0;
    this._recs.length = 0;
    this._chunks.clear();
    this._dirty.clear();
  }

  /** Annullo/fine tratto: i readback in volo si scartano. */
  reset() {
    this.gen++;
    this._inflight = 0;
    this._landing = false;
    this._resetGpuState();
    this.tickDrained = this.sent;
    this.presentDrained = this.sent;
    this._endpassZero = null;
    this._snap = null;
  }

  /**
   * Endpass della punta: replay INTERO da zero. I chunk noti restano
   * visibili coi pixel vecchi; a replay atterrato quelli non ricoperti
   * si azzerano (punta rastremata).
   */
  endPassBegin() {
    this._endpassZero = new Set(this.store.map.keys());
    this._slotOf.clear();
    this._needClear.clear();
    this._freeSlots.length = 0;
    for (let i = 0; i < this._arenaSlots; i++) this._freeSlots.push(i);
    this._recs.length = 0;
    this._chunks.clear();
    this._dirty.clear();
    // il replay riassegna gli slot: i tile pendenti puntano a slot vecchi
    // (i nuovi _touch li rimettono in coda per gli slot giusti)
    this._tileWrites.length = 0;
  }

  /** @param {object} stamp @param {Uint8Array} mask */
  _atlasFor(stamp, mask) {
    let off = this._atlasOff.get(stamp);
    if (off !== undefined) return off;
    const len = (mask.length + 3) & ~3;
    if (this._atlasUsed + len > this._atlasCap) {
      // atlas pieno: crescita CON COPIA, gli offset restano validi. (La v1
      // azzerava mappa e buffer: i record già in _recs — e le maschere dei
      // tick precedenti riusate da quelli nuovi — puntavano a offset ormai
      // vuoti o ricoperti da altre maschere: dab corrotti in silenzio.)
      let cap = this._atlasCap;
      while (this._atlasUsed + len > cap) cap *= 2;
      const nb = this.device.createBuffer({ size: cap, usage: 0x80 | 0x8 | 0x4 });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this._atlas, 0, nb, 0, this._atlasCap);
      this.device.queue.submit([enc.finish()]);
      this._atlas.destroy();
      this._atlas = nb;
      this._atlasCap = cap;
      this._bind = null;
    }
    off = this._atlasUsed;
    this._atlasUsed += len;
    this._atlasOff.set(stamp, off);
    this._maskWrites.push({ off, mask });
    return off;
  }

  /**
   * Drena la coda dell'App (specchio/pattern già espansi): record del kernel
   * + chunk toccati + ring per l'ink overlay. Stessa firma del bridge worker.
   * @param {import('./stroke.js').DabQueue} queue
   */
  sendEntries(queue) {
    const snap = /** @type {NonNullable<typeof this._snap>} */ (this._snap);
    const cache = /** @type {NonNullable<typeof this._cache>} */ (this._cache);
    const clip = /** @type {NonNullable<typeof this._clip>} */ (this._clip);
    const n = queue.count;
    for (let i = 0; i < n; i++) {
      const q = queue.buf;
      const o = queue.peekOffset();
      const type = q[o];
      const idx = ++this.sent;
      const rb = (idx & (INK_RING - 1)) * 8;
      this.inkRing[rb] = type;
      this.inkRing[rb + 1] = q[o + 1]; this.inkRing[rb + 2] = q[o + 2];
      this.inkRing[rb + 3] = q[o + 3];
      this.inkRing[rb + 4] = q[o + 5]; this.inkRing[rb + 5] = q[o + 6];
      this.inkRing[rb + 6] = q[o + 7];
      if (type === T_DAB) {
        const x = q[o + 1], y = q[o + 2], r = q[o + 3], a = q[o + 4];
        const angle = q[o + 5];
        const a255 = Math.min(255, (a * 255 + 0.5) | 0);
        if (a255 > 0) {
          const stamp = cache.getStamp(r, snap.hardness, snap.roundness, angle,
            snap.shape, snap.shapeInvert);
          const ix = Math.round(x - stamp.half);
          const iy = Math.round(y - stamp.half);
          // stesse diramazioni texture di Rasterizer._dab (parità = stessi
          // rami): moving = maschera pre-modulata (+RGB per stamp nel
          // colore), fissa = flag tile (fattore, +RGBX nel colore)
          let mask = stamp.mask;
          /** @type {object} */ let maskKey = stamp;
          let flags = 0, rgbOff = 0;
          if (this._movingTex) {
            const baked = /** @type {NonNullable<typeof this._raster>} */ (this._raster)
              ._bakedStamp(stamp, snap.texColor);
            mask = baked.mask;
            maskKey = baked;
            if (snap.texColor && baked.rgb) {
              flags = 4;
              rgbOff = this._atlasFor(baked.rgb, baked.rgb);
            }
          } else if (this._tileMode > 0) {
            flags = this._tileMode === 2 ? 3 : 1;
          }
          const off = this._atlasFor(maskKey, mask);
          this._recs.push(0, ix, iy, stamp.size, off, a255,
            q[o + 6], q[o + 7], q[o + 8], flags, rgbOff, 0);
          this._touch(ix, iy, ix + stamp.size - 1, iy + stamp.size - 1, clip);
        }
      } else {
        const s0 = this._recs.length;
        // capsule: la grana FISSA modula (flags come _capsuleTex); la
        // moving NO — sul CPU _capsule con texMoving dipinge liscio
        const capFlags = this._tileMode > 0 ? (this._tileMode === 2 ? 3 : 1) : 0;
        const tmp = /** @type {number[]} */ ([]);
        capsuleIntParams(q[o + 1], q[o + 2], q[o + 3], q[o + 4],
          q[o + 5], q[o + 6], q[o + 7], q[o + 8], tmp);
        for (let t = 0; t < tmp.length; t += CAP_STRIDE_I32) {
          this._recs.push(1, tmp[t], tmp[t + 1], tmp[t + 2], tmp[t + 3], tmp[t + 4],
            tmp[t + 5], tmp[t + 6], tmp[t + 7], tmp[t + 8], capFlags, 0);
          const rMax = tmp[t + 6] > 0 ? tmp[t + 5] + tmp[t + 6] : tmp[t + 5];
          const mR = rMax / CAP_FP + 1;
          const xLo = Math.min(tmp[t], tmp[t] + tmp[t + 2]) / CAP_FP;
          const xHi = Math.max(tmp[t], tmp[t] + tmp[t + 2]) / CAP_FP;
          const yLo = Math.min(tmp[t + 1], tmp[t + 1] + tmp[t + 3]) / CAP_FP;
          const yHi = Math.max(tmp[t + 1], tmp[t + 1] + tmp[t + 3]) / CAP_FP;
          this._touch(Math.floor(xLo - mR), Math.floor(yLo - mR),
            Math.ceil(xHi + mR), Math.ceil(yHi + mR), clip);
        }
        if (this._recs.length === s0) { /* niente record: fuori clip */ }
      }
      queue.pop();
    }
  }

  /** bbox mondo -> chunk creati nello store + slot GPU + batch
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip */
  _touch(x0, y0, x1, y1, clip) {
    x0 = Math.max(x0, clip.x0); y0 = Math.max(y0, clip.y0);
    x1 = Math.min(x1, clip.x1); y1 = Math.min(y1, clip.y1);
    if (x0 > x1 || y0 > y1) return;
    const cx0 = x0 >> CHUNK_SHIFT, cy0 = y0 >> CHUNK_SHIFT;
    const cx1 = x1 >> CHUNK_SHIFT, cy1 = y1 >> CHUNK_SHIFT;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = chunkKey(cx, cy);
        if (!this._slotOf.has(key)) {
          if (this._freeSlots.length === 0) this._growArena(this._arenaSlots * 2);
          const slot = /** @type {number} */ (this._freeSlots.pop());
          this._slotOf.set(key, slot);
          this._needClear.add(slot);
          // grana fissa: lo slot nuovo riceve il tile del chunk (upload al
          // prossimo tick, prima del dispatch)
          if (this._tileMode > 0) this._tileWrites.push({ key, slot });
          // slot fresco su un chunk CPU preesistente (endpass): la copia CPU
          // è stantia rispetto al GPU azzerato — la prima rilettura dev'essere
          // il chunk INTERO, o le righe fuori banda terrebbero pixel vecchi
          if (this.store.getByKey(key)) {
            this._dirty.set(key, { x0: 0, y0: 0, x1: CHUNK - 1, y1: CHUNK - 1 });
          }
        }
        this.store.getOrCreate(cx, cy);
        this._chunks.add(key);
        // rect sporco locale al chunk (banda di readback + markDirty preciso)
        const bx = cx << CHUNK_SHIFT, by = cy << CHUNK_SHIFT;
        const lx0 = Math.max(0, x0 - bx), ly0 = Math.max(0, y0 - by);
        const lx1 = Math.min(CHUNK - 1, x1 - bx), ly1 = Math.min(CHUNK - 1, y1 - by);
        const d = this._dirty.get(key);
        if (d === undefined) {
          this._dirty.set(key, { x0: lx0, y0: ly0, x1: lx1, y1: ly1 });
        } else {
          if (lx0 < d.x0) d.x0 = lx0;
          if (ly0 < d.y0) d.y0 = ly0;
          if (lx1 > d.x1) d.x1 = lx1;
          if (ly1 > d.y1) d.y1 = ly1;
        }
      }
    }
  }

  /**
   * Una volta per frame: incoda il batch (un command buffer), avvia il
   * readback dei chunk toccati, applica allo store quando atterra.
   */
  tick() {
    if (this._recs.length === 0 || this._chunks.size === 0) return;
    if (this._inflight >= 2) return; // backpressure: max 2 batch in volo
    const dev = this.device;
    const snap = /** @type {NonNullable<typeof this._snap>} */ (this._snap);
    const clip = /** @type {NonNullable<typeof this._clip>} */ (this._clip);
    if (this._recs.length % REC_U32 !== 0) {
      console.warn('[wgpu_stroke] record DISALLINEATI:', this._recs.length);
    }
    const chunkKeys = [...this._chunks];
    // Solo texgpu=safe usa il tetto di lavoro: texgpu=fast deve restare il
    // path originale, un batch per tick, per il confronto A/B sul campo.
    const totalRecs = this._recs.length / REC_U32;
    const maxRecs = this._texSafe
      ? Math.max(64, Math.floor(WORK_CAP / Math.max(1, chunkKeys.length * SLOT_WORDS)))
      : totalRecs;
    const recCount = Math.min(totalRecs, maxRecs);
    const partial = totalRecs > recCount;
    const recs = new Uint32Array(recCount * REC_U32);
    const recsI = new Int32Array(recs.buffer);
    for (let i = 0; i < recCount * REC_U32; i++) recsI[i] = this._recs[i];
    if (partial) this._recs.splice(0, recCount * REC_U32);
    else this._recs.length = 0;
    if (!partial) this._chunks.clear();
    if (this._texSafe) {
      console.info('[wgpu_stroke] batch tex', {
        recCount, totalRecs, chunks: chunkKeys.length,
        workMrp: Math.round(recCount * chunkKeys.length * SLOT_WORDS / 1e6),
        tileMode: this._tileMode, moving: this._movingTex, partial,
      });
    }

    for (const w of this._maskWrites) {
      // multipli di 4: parte allineata diretta, coda paddata
      const aligned = w.mask.length & ~3;
      if (aligned > 0) dev.queue.writeBuffer(this._atlas, w.off, w.mask, 0, aligned);
      if (aligned < w.mask.length) {
        const tail = new Uint8Array(4);
        tail.set(w.mask.subarray(aligned));
        dev.queue.writeBuffer(this._atlas, w.off + aligned, tail);
      }
    }
    this._maskWrites.length = 0;

    // tile della grana fissa per gli slot appena assegnati: cotti dal
    // Rasterizer del main (LRU suo: stessi byte del path CPU) e scritti
    // prima del dispatch (le op di coda sono ordinate)
    if (this._tileWrites.length > 0) {
      const raster = /** @type {NonNullable<typeof this._raster>} */ (this._raster);
      for (const w of this._tileWrites) {
        const chunk = this.store.getByKey(w.key);
        if (!chunk) continue;
        const t = raster._tile(chunk, this._tileMode === 2);
        dev.queue.writeBuffer(this._tileLum, w.slot * CHUNK * CHUNK, t.lum);
        if (this._tileMode === 2 && t.rgbx) {
          dev.queue.writeBuffer(this._tileRgb, w.slot * SLOT_WORDS * 4, t.rgbx);
        }
      }
      this._tileWrites.length = 0;
    }

    // buffer PERSISTENTI: si riallocano solo alla crescita (i destroy sono
    // differiti dal driver a GPU-idle; i writeBuffer sono ordinati sulla
    // coda, quindi i batch in volo leggono ancora i contenuti vecchi)
    if (recs.byteLength > this._recCap) {
      if (this._recBuf) this._recBuf.destroy();
      this._recCap = Math.max(65536, recs.byteLength * 2);
      this._recBuf = dev.createBuffer({ size: this._recCap, usage: 0x80 | 0x8 });
      this._bind = null;
    }
    dev.queue.writeBuffer(this._recBuf, 0, recs);

    // uniform per chunk a offset dinamici (allineati a 256B)
    const uni = new ArrayBuffer(chunkKeys.length * 256);
    for (let i = 0; i < chunkKeys.length; i++) {
      const key = chunkKeys[i];
      const chunk = /** @type {NonNullable<ReturnType<typeof this.store.getByKey>>} */ (this.store.getByKey(key));
      const slot = /** @type {number} */ (this._slotOf.get(key));
      const pi = new Int32Array(uni, i * 256, 16);
      const pu = new Uint32Array(uni, i * 256, 16);
      pi[0] = chunk.cx * CHUNK; pi[1] = chunk.cy * CHUNK;
      pu[2] = slot * SLOT_WORDS; pu[3] = recCount;
      pi[4] = clip.x0; pi[5] = clip.y0; pi[6] = clip.x1; pi[7] = clip.y1;
      pi[8] = this._hq;
      pu[9] = snap.buildup ? 1 : 0;
      pu[10] = snap.colR; pu[11] = snap.colG; pu[12] = snap.colB;
    }
    if (uni.byteLength > this._uniCap) {
      if (this._uniBuf) this._uniBuf.destroy();
      this._uniCap = Math.max(16 * 256, uni.byteLength * 2);
      this._uniBuf = dev.createBuffer({ size: this._uniCap, usage: 0x40 | 0x8 });
      this._bind = null;
    }
    dev.queue.writeBuffer(this._uniBuf, 0, uni);

    if (!this._bind) {
      this._bind = dev.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: { buffer: this._arena } },
          { binding: 1, resource: { buffer: this._atlas } },
          { binding: 2, resource: { buffer: this._lutBuf } },
          { binding: 3, resource: { buffer: this._recBuf } },
          { binding: 4, resource: { buffer: this._uniBuf, size: 64 } },
          { binding: 5, resource: { buffer: this._tileLum || this._dummyTile } },
          { binding: 6, resource: { buffer: this._tileRgb || this._dummyTile } },
        ],
      });
    }
    const bind = this._bind;

    // modalità DIRECT: niente banda di readback — il renderer copia gli slot
    // dell'arena nelle texture dei chunk nello stesso frame (stesso device,
    // stessa coda: il present vede QUESTO dispatch). Il mirror CPU atterra
    // una volta sola al commit, via requestLand.
    if (this.direct) {
      const enc = dev.createCommandEncoder();
      for (const slot of this._needClear) {
        enc.clearBuffer(this._arena, slot * SLOT_WORDS * 4, SLOT_WORDS * 4);
      }
      this._needClear.clear();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      for (let i = 0; i < chunkKeys.length; i++) {
        pass.setBindGroup(0, bind, [i * 256]);
        pass.dispatchWorkgroups(CHUNK / 8, CHUNK / 8);
      }
      pass.end();
      dev.queue.submit([enc.finish()]);
      this.statBatches++;
      // fetta parziale: entry non ancora tutte a schermo — l'overlay
      // continua a coprire finché l'ultima fetta non è dispatchata
      if (!partial) {
        this.presentDrained = this.sent;
        this._dirty.clear();
      }
      return;
    }

    // bande di righe sporche per chunk: si copia e rilegge SOLO quelle
    // (righe contigue in memoria: un dab da 30px = ~30KB, non 256KB)
    /** @type {{key: number, ry0: number, ry1: number, x0: number, x1: number, off: number}[]} */
    const bands = [];
    let stagingBytes = 0;
    for (const key of chunkKeys) {
      const d = /** @type {NonNullable<ReturnType<typeof this._dirty.get>>} */ (this._dirty.get(key));
      bands.push({ key, ry0: d.y0, ry1: d.y1, x0: d.x0, x1: d.x1, off: stagingBytes });
      stagingBytes += (d.y1 - d.y0 + 1) * CHUNK * 4;
    }
    if (!partial) this._dirty.clear();

    const sb = this._acquireStaging(stagingBytes);

    const enc = dev.createCommandEncoder();
    for (const slot of this._needClear) {
      enc.clearBuffer(this._arena, slot * SLOT_WORDS * 4, SLOT_WORDS * 4);
    }
    this._needClear.clear();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    for (let i = 0; i < chunkKeys.length; i++) {
      pass.setBindGroup(0, bind, [i * 256]);
      pass.dispatchWorkgroups(CHUNK / 8, CHUNK / 8);
    }
    pass.end();
    for (const b of bands) {
      const slot = /** @type {number} */ (this._slotOf.get(b.key));
      enc.copyBufferToBuffer(this._arena, slot * SLOT_WORDS * 4 + b.ry0 * CHUNK * 4,
        sb.buf, b.off, (b.ry1 - b.ry0 + 1) * CHUNK * 4);
    }
    dev.queue.submit([enc.finish()]);
    this.statBatches++;
    this.statBytes += stagingBytes;

    const gen = this.gen;
    // fetta parziale: le entry non sono tutte dispatchate, il drained non
    // avanza (l'ultima fetta porta tutto a this.sent)
    const drainedTo = partial ? this.tickDrained : this.sent;
    const tSubmit = performance.now();
    this._inflight++;
    sb.buf.mapAsync(1, 0, stagingBytes).then(() => {
      if (gen === this.gen) {
        const bytes = new Uint8Array(sb.buf.getMappedRange(0, stagingBytes));
        for (const b of bands) {
          const chunk = this.store.getByKey(b.key);
          if (!chunk) continue;
          const len = (b.ry1 - b.ry0 + 1) * CHUNK * 4;
          chunk.data.set(bytes.subarray(b.off, b.off + len), b.ry0 * CHUNK * 4);
          this.store.markDirty(chunk, b.x0, b.ry0, b.x1, b.ry1);
          if (!chunk.touched) chunk.touched = this._bandHasInk(chunk.data, b.ry0, b.ry1);
        }
        this.statLandMs = performance.now() - tSubmit;
        this.tickDrained = Math.max(this.tickDrained, drainedTo);
        this._inflight--;
        this._maybeFinishEndpass();
        this._requestFrame();
      }
      sb.buf.unmap();
      sb.busy = false;
    }).catch(() => {
      sb.busy = false;
      if (gen === this.gen) this._inflight--;
      // device perso a metà lettura: sveglia l'app (ripiega sul CPU)
      this._requestFrame();
    });
  }

  /** pool di staging: mai riusare un buffer mappato (flag busy)
   * @param {number} bytes @returns {{buf: any, size: number, busy: boolean}} */
  _acquireStaging(bytes) {
    /** @type {{buf: any, size: number, busy: boolean}|null} */
    let sb = null;
    for (const s of this._stagingPool) {
      if (!s.busy && s.size >= bytes) { sb = s; break; }
    }
    if (!sb) {
      let size = 262144;
      while (size < bytes) size *= 2;
      sb = { buf: this.device.createBuffer({ size, usage: /* MAP_READ|COPY_DST */ 0x1 | 0x8 }), size, busy: false };
      this._stagingPool.push(sb);
      // pota i liberi in eccesso (tiene al più 4 buffer)
      while (this._stagingPool.length > 4) {
        const i = this._stagingPool.findIndex((s) => !s.busy && s !== sb);
        if (i < 0) break;
        this._stagingPool.splice(i, 1)[0].buf.destroy();
      }
    }
    sb.busy = true;
    return sb;
  }

  /**
   * Modalità direct: l'UNICO readback del tratto — gli slot interi verso il
   * mirror CPU, quando la coda è drenata e il commit aspetta. Chiamata
   * dall'App a ogni frame di attesa; no-op se non c'è niente da atterrare o
   * un atterraggio è già in volo. touched si calcola qui (il commit filtra).
   */
  requestLand() {
    if (!this.direct || this._landing) return;
    if (this._recs.length > 0 || this._inflight > 0) return;
    if (this.sent === this.tickDrained) return;
    const drainedTo = this.sent;
    /** @type {[number, number][]} */
    const entries = [...this._slotOf.entries()];
    if (entries.length === 0) {
      // tratto interamente fuori clip: niente pixel, solo contatori
      this.tickDrained = drainedTo;
      this._maybeFinishEndpass();
      return;
    }
    const dev = this.device;
    const bytesPer = SLOT_WORDS * 4;
    const total = entries.length * bytesPer;
    const sb = this._acquireStaging(total);
    const enc = dev.createCommandEncoder();
    for (let i = 0; i < entries.length; i++) {
      enc.copyBufferToBuffer(this._arena, entries[i][1] * bytesPer, sb.buf, i * bytesPer, bytesPer);
    }
    dev.queue.submit([enc.finish()]);
    this.statBytes += total;
    const gen = this.gen;
    const tSubmit = performance.now();
    this._landing = true;
    this._inflight++;
    sb.buf.mapAsync(1, 0, total).then(() => {
      if (gen === this.gen) {
        const bytes = new Uint8Array(sb.buf.getMappedRange(0, total));
        for (let i = 0; i < entries.length; i++) {
          const chunk = this.store.getByKey(entries[i][0]);
          if (chunk) {
            chunk.data.set(bytes.subarray(i * bytesPer, (i + 1) * bytesPer));
            chunk.touched = this._bandHasInk(chunk.data, 0, CHUNK - 1);
            // niente markDirty: le texture mostrano già questi byte via
            // arena (un markDirty rifarebbe l'upload dell'intero tratto)
          }
        }
        this.statLandMs = performance.now() - tSubmit;
        this.tickDrained = Math.max(this.tickDrained, drainedTo);
        this._inflight--;
        this._landing = false;
        this._maybeFinishEndpass();
        this._requestFrame();
      } else {
        this._landing = false;
      }
      sb.buf.unmap();
      sb.busy = false;
    }).catch(() => {
      sb.busy = false;
      this._landing = false;
      if (gen === this.gen) this._inflight--;
      this._requestFrame();
    });
  }

  /** ink nella banda di righe [ry0, ry1]? (skip se il chunk è già touched)
   * @param {Uint8ClampedArray|Uint8Array} data @param {number} ry0 @param {number} ry1 */
  _bandHasInk(data, ry0, ry1) {
    const w = new Uint32Array(data.buffer, data.byteOffset + ry0 * CHUNK * 4,
      (ry1 - ry0 + 1) * CHUNK);
    for (let i = 0; i < w.length; i++) if (w[i] !== 0) return true;
    return false;
  }

  // a fine atterraggio dell'endpass: i chunk noti che il replay NON ha
  // ricoperto si azzerano (la punta rastremata li ha lasciati)
  _maybeFinishEndpass() {
    if (!this._endpassZero || this.sent !== this.tickDrained ||
      this._recs.length > 0 || this._inflight > 0) return;
    for (const key of this._endpassZero) {
      if (this._slotOf.has(key)) continue; // ricoperto dal replay
      const chunk = this.store.getByKey(key);
      if (!chunk) continue;
      chunk.data.fill(0);
      chunk.touched = false;
      this.store.markDirty(chunk, 0, 0, CHUNK - 1, CHUNK - 1);
    }
    this._endpassZero = null;
  }
}
