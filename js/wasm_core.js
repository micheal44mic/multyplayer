// CORE WASM — caricamento e memoria del modulo raster_core (wasm/src/lib.rs).
// Il modulo Rust non alloca mai: tutta la memoria lineare sopra __heap_base è
// gestita qui con uno slab a liste libere per taglia (i chunk sono tutti da
// 256KB, le maschere ricorrono sulle stesse taglie bucketizzate).
// ATTENZIONE: memory.grow stacca il buffer e invalida OGNI vista esistente;
// onGrow viene chiamata subito dopo per rigenerarle (store + stamp cache).

export class WasmHeap {
  /**
   * Carica e istanzia il modulo. Ritorna null se il fetch fallisce o il
   * browser non supporta wasm/simd128: l'app resta sul rasterizer JS.
   * @param {URL|string} url
   * @returns {Promise<WasmHeap|null>}
   */
  static async load(url) {
    try {
      let mod;
      try {
        mod = await WebAssembly.instantiateStreaming(fetch(url), {});
      } catch {
        // MIME type sbagliato per lo streaming: riprova via ArrayBuffer
        const bytes = await (await fetch(url)).arrayBuffer();
        mod = await WebAssembly.instantiate(bytes, {});
      }
      return new WasmHeap(mod.instance);
    } catch (err) {
      console.warn('raster_core.wasm non disponibile, rasterizer JS:', err);
      return null;
    }
  }

  /** @param {WebAssembly.Instance} instance */
  constructor(instance) {
    /**
     * Export del modulo: dab/capsule/commit (vedi wasm/src/lib.rs).
     * @type {{
     *   memory: WebAssembly.Memory,
     *   dab: (chunkPtr: number, lx0: number, ly0: number, lx1: number, ly1: number,
     *         maskPtr: number, maskW: number, mcol0: number, mrow0: number,
     *         a255: number, cr: number, cg: number, cb: number, buildup: number) => number,
     *   dab_tex_tile: (chunkPtr: number, lx0: number, ly0: number, lx1: number, ly1: number,
     *                  maskPtr: number, maskW: number, mcol0: number, mrow0: number,
     *                  tilePtr: number, rgbPtr: number,
     *                  a255: number, cr: number, cg: number, cb: number,
     *                  buildup: number) => number,
     *   capsule: (chunkPtr: number, lx0: number, ly0: number, lx1: number, ly1: number,
     *             ox: number, oy: number, x0: number, y0: number, r0: number, a0: number,
     *             x1: number, y1: number, r1: number, a1: number, hardness: number,
     *             cr: number, cg: number, cb: number) => number,
     *   capsule_tex: (chunkPtr: number, lx0: number, ly0: number, lx1: number, ly1: number,
     *                 ox: number, oy: number, x0: number, y0: number, r0: number, a0: number,
     *                 x1: number, y1: number, r1: number, a1: number, hardness: number,
     *                 cr: number, cg: number, cb: number,
     *                 tilePtr: number, rgbPtr: number) => number,
     *   commit: (dstPtr: number, srcPtr: number, op255: number, eraser: number) => void,
     *   blur_blend: (pf: number, pi: number, base: number, out: number,
     *                lx0: number, ly0: number, lx1: number, ly1: number,
     *                ox: number, oy: number) => number,
     *   blur_blend_low: (pf: number, pi: number, base: number, out: number,
     *                    lx0: number, ly0: number, lx1: number, ly1: number,
     *                    ox: number, oy: number) => number,
     *   iir_blur: (dataPtr: number, f32Ptr: number, w: number, h: number,
     *              B: number, c1: number, c2: number, c3: number) => void,
     *   blur_low_acc: (chunkPtr: number, lx0: number, ly0: number, lx1: number,
     *                  ly1: number, ox: number, oy: number, accPtr: number,
     *                  csx: number, csy: number, k: number, q0: number,
     *                  q1: number, lowW: number) => void,
     *   blur_low_div: (accPtr: number, outPtr: number, lowN: number) => void,
     *   blur_pull_low: (srcPtr: number, w: number, h: number, outPtr: number,
     *                   oCX: number, oCY: number, crX: number, crY: number) => void,
     * }}
     */
    this.exports = /** @type {any} */ (instance.exports);
    this.memory = this.exports.memory;
    const base = /** @type {WebAssembly.Global} */ (/** @type {any} */ (instance.exports).__heap_base).value;
    this._next = (base + 15) & ~15;
    /** @type {Map<number, number[]>} taglia (allineata) -> offset liberi */
    this._free = new Map();
    /** @type {(() => void)|null} */
    this.onGrow = null;
  }

  /** Offset di un blocco da `size` byte (allineato a 16). @param {number} size */
  alloc(size) {
    size = (size + 15) & ~15;
    const list = this._free.get(size);
    if (list !== undefined && list.length > 0) return list.pop();
    if (this._next + size > this.memory.buffer.byteLength) {
      // cresce con 16MB di slack: i grow restano rari e ogni grow
      // rigenera tutte le viste tramite onGrow
      const deficit = this._next + size - this.memory.buffer.byteLength;
      this.memory.grow(Math.ceil(deficit / 65536) + 256);
      if (this.onGrow) this.onGrow();
    }
    const off = this._next;
    this._next += size;
    return off;
  }

  /** Restituisce un blocco alla lista libera della sua taglia.
   * @param {number} off @param {number} size */
  free(off, size) {
    size = (size + 15) & ~15;
    let list = this._free.get(size);
    if (list === undefined) this._free.set(size, list = []);
    list.push(off);
  }

  /** Acqua alta dell'allocatore: byte usati sopra __heap_base (i blocchi
   * nelle liste libere contano, verranno riusati). */
  get heapBytes() { return this._next; }

  /** Vista pixel (chunk RGBA). Da rigenerare dopo ogni grow.
   * @param {number} off @param {number} len */
  u8c(off, len) {
    return new Uint8ClampedArray(this.memory.buffer, off, len);
  }

  /** Vista maschera (stamp). @param {number} off @param {number} len */
  u8(off, len) {
    return new Uint8Array(this.memory.buffer, off, len);
  }
}
