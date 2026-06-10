// PIXEL STORE — la CPU è la verità.
// Documento infinito = mappa sparsa di chunk 256x256 RGBA premultiplied.
// Chiavi intere (niente stringhe nel path caldo). Pool di buffer riusati.

export const CHUNK = 256;
export const CHUNK_SHIFT = 8;          // 2^8 = 256
export const CHUNK_BYTES = CHUNK * CHUNK * 4;

const KEY_OFF = 32768;                 // chunk coords in [-32768, 32767] → mondo ±8.4M px

/**
 * Tile 256x256 RGBA premultiplied. tex/c2d appartengono al renderer attivo.
 * Con il core wasm attivo, data è una vista sulla memoria lineare (offset
 * ptr); ptr = 0 indica un normale buffer JS.
 * @typedef {Object} Chunk
 * @property {number} key
 * @property {number} cx
 * @property {number} cy
 * @property {Uint8ClampedArray<ArrayBuffer>} data
 * @property {number} ptr
 * @property {WebGLTexture|null} tex
 * @property {boolean} texDirty
 * @property {boolean} touched
 * @property {HTMLCanvasElement|null} c2d
 * @property {number} dirX0 rect locale sporco accumulato (vuoto: x0=CHUNK, x1=-1)
 * @property {number} dirY0
 * @property {number} dirX1
 * @property {number} dirY1
 * @property {boolean} mips la catena mip in texture rispecchia il livello 0
 * @property {boolean} mipOn MIN_FILTER attuale della texture è mipmap-linear
 * @property {boolean} magNear MAG_FILTER attuale della texture è NEAREST
 */

/** @type {(cx: number, cy: number) => number} */
export const chunkKey = (cx, cy) => ((cx + KEY_OFF) << 16) | (cy + KEY_OFF);
/** @type {(key: number) => number} */
export const keyCx = (key) => (key >>> 16) - KEY_OFF;
/** @type {(key: number) => number} */
export const keyCy = (key) => (key & 0xffff) - KEY_OFF;

export class ChunkStore {
  /** @param {string} name @param {import('./wasm_core.js').WasmHeap|null} [heap] */
  constructor(name, heap = null) {
    this.name = name;
    this.heap = heap;        // se presente, i pixel vivono nella memoria wasm
    /** @type {Map<number, Chunk>} */
    this.map = new Map();    // key:int -> chunk
    /** @type {Set<Chunk>} */
    this.dirty = new Set();  // chunk refs con pixel CPU cambiati (da caricare in GPU)
    /** @type {Chunk[]} */
    this._pool = [];         // chunk rilasciati, riusabili (data azzerata, texture intatta)
  }

  /** @param {number} cx @param {number} cy */
  get(cx, cy) {
    return this.map.get(chunkKey(cx, cy));
  }

  /** @param {number} key */
  getByKey(key) {
    return this.map.get(key);
  }

  /** @param {number} cx @param {number} cy */
  getOrCreate(cx, cy) {
    const key = chunkKey(cx, cy);
    let c = this.map.get(key);
    if (c === undefined) {
      c = this._pool.pop();
      if (c === undefined) {
        // l'alloc può far crescere la memoria wasm (onGrow rigenera le viste
        // esistenti); la vista qui sotto è creata dopo, quindi sempre valida
        const ptr = this.heap ? this.heap.alloc(CHUNK_BYTES) : 0;
        const data = this.heap ? this.heap.u8c(ptr, CHUNK_BYTES) : new Uint8ClampedArray(CHUNK_BYTES);
        if (ptr) data.fill(0); // lo slot riusato può contenere pixel vecchi
        c = {
          key: 0, cx: 0, cy: 0,
          data,
          ptr,
          tex: null,        // gestita dal renderer
          texDirty: true,
          touched: false,   // true se il rasterizer ha scritto pixel reali
          c2d: null,        // canvas del fallback 2D
          dirX0: CHUNK, dirY0: CHUNK, dirX1: -1, dirY1: -1,
          mips: false, mipOn: false, magNear: true,
        };
      }
      c.key = key; c.cx = cx; c.cy = cy; c.texDirty = true; c.touched = false;
      c.dirX0 = CHUNK; c.dirY0 = CHUNK; c.dirX1 = -1; c.dirY1 = -1;
      c.mips = false;
      this.map.set(key, c);
    }
    return c;
  }

  // Accumula il rettangolo locale modificato: il renderer WebGL2 carica solo
  // quello (UNPACK_ROW_LENGTH). Senza argomenti = chunk intero (conservativo).
  /**
   * @param {Chunk} chunk
   * @param {number} [lx0] @param {number} [ly0] @param {number} [lx1] @param {number} [ly1]
   */
  markDirty(chunk, lx0 = 0, ly0 = 0, lx1 = CHUNK - 1, ly1 = CHUNK - 1) {
    this.dirty.add(chunk);
    if (lx0 < chunk.dirX0) chunk.dirX0 = lx0;
    if (ly0 < chunk.dirY0) chunk.dirY0 = ly0;
    if (lx1 > chunk.dirX1) chunk.dirX1 = lx1;
    if (ly1 > chunk.dirY1) chunk.dirY1 = ly1;
  }

  // Svuota lo store. I chunk che entrano nel pool tengono la texture viva
  // (riusata al prossimo stroke); per l'overflow la texture VA liberata,
  // altrimenti è un leak GPU. disposeAll = true libera tutte le texture.
  /** @param {(c: Chunk) => void} disposeTex @param {boolean} [disposeAll] */
  releaseAll(disposeTex, disposeAll = false) {
    for (const c of this.map.values()) {
      this._release(c, disposeTex, disposeAll);
    }
    this.map.clear();
    this.dirty.clear();
  }

  /** @param {Chunk} c @param {(c: Chunk) => void} disposeTex @param {boolean} forceDispose */
  _release(c, disposeTex, forceDispose) {
    c.data.fill(0);
    c.touched = false;
    if (this._pool.length < 64) {
      if (forceDispose && disposeTex) disposeTex(c);
      this._pool.push(c);
    } else {
      // il chunk muore: oltre alla texture va liberato anche lo slot wasm
      if (disposeTex) disposeTex(c);
      if (this.heap && c.ptr) this.heap.free(c.ptr, CHUNK_BYTES);
    }
  }

  // Rimuove un singolo chunk (undo "non esisteva", commit incrementale)
  /** @param {number} key @param {(c: Chunk) => void} disposeTex @param {boolean} [disposeAll] */
  remove(key, disposeTex, disposeAll = false) {
    const c = this.map.get(key);
    if (!c) return;
    this.map.delete(key);
    this.dirty.delete(c);
    this._release(c, disposeTex, disposeAll);
  }

  // Il renderer è stato sostituito o il contesto perso: texture e canvas dei
  // chunk — vivi E nel pool — appartengono al contesto morto, vanno dimenticati
  // (mai dispose: i loro handle non sono più validi).
  dropRendererResources() {
    for (const c of this.map.values()) { c.tex = null; c.c2d = null; c.texDirty = true; }
    for (const c of this._pool) { c.tex = null; c.c2d = null; c.texDirty = true; }
  }

  // memory.grow ha staccato il buffer wasm: tutte le viste (chunk vivi E
  // pool) vanno rigenerate. Chiamata da WasmHeap.onGrow.
  refreshViews() {
    if (!this.heap) return;
    for (const c of this.map.values()) c.data = this.heap.u8c(c.ptr, CHUNK_BYTES);
    for (const c of this._pool) c.data = this.heap.u8c(c.ptr, CHUNK_BYTES);
  }

  get count() { return this.map.size; }
  get cpuBytes() { return this.map.size * CHUNK_BYTES; }
}

// Itera i chunk che intersecano il bbox mondo [x0,y0]..[x1,y1] (px, inclusivo).
// cb(chunk, rettangolo locale nel chunk: lx0, ly0, lx1, ly1, origine mondo del chunk)
/**
 * @param {ChunkStore} store
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {boolean} create
 * @param {(chunk: Chunk, lx0: number, ly0: number, lx1: number, ly1: number, ox: number, oy: number) => void} cb
 */
export function forEachChunkInRect(store, x0, y0, x1, y1, create, cb) {
  const cx0 = x0 >> CHUNK_SHIFT, cy0 = y0 >> CHUNK_SHIFT;
  const cx1 = x1 >> CHUNK_SHIFT, cy1 = y1 >> CHUNK_SHIFT;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const chunk = create ? store.getOrCreate(cx, cy) : store.get(cx, cy);
      if (!chunk) continue;
      const ox = cx << CHUNK_SHIFT, oy = cy << CHUNK_SHIFT;
      const lx0 = Math.max(0, x0 - ox), ly0 = Math.max(0, y0 - oy);
      const lx1 = Math.min(CHUNK - 1, x1 - ox), ly1 = Math.min(CHUNK - 1, y1 - oy);
      cb(chunk, lx0, ly0, lx1, ly1, ox, oy);
    }
  }
}
