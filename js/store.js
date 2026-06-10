// PIXEL STORE — la CPU è la verità.
// Documento infinito = mappa sparsa di chunk 256x256 RGBA premultiplied.
// Chiavi intere (niente stringhe nel path caldo). Pool di buffer riusati.

export const CHUNK = 256;
export const CHUNK_SHIFT = 8;          // 2^8 = 256
export const CHUNK_BYTES = CHUNK * CHUNK * 4;

const KEY_OFF = 32768;                 // chunk coords in [-32768, 32767] → mondo ±8.4M px

export const chunkKey = (cx, cy) => ((cx + KEY_OFF) << 16) | (cy + KEY_OFF);
export const keyCx = (key) => (key >>> 16) - KEY_OFF;
export const keyCy = (key) => (key & 0xffff) - KEY_OFF;

export class ChunkStore {
  constructor(name) {
    this.name = name;
    this.map = new Map();    // key:int -> chunk
    this.dirty = new Set();  // chunk refs con pixel CPU cambiati (da caricare in GPU)
    this._pool = [];         // chunk rilasciati, riusabili (data azzerata, texture intatta)
  }

  get(cx, cy) {
    return this.map.get(chunkKey(cx, cy));
  }

  getByKey(key) {
    return this.map.get(key);
  }

  getOrCreate(cx, cy) {
    const key = chunkKey(cx, cy);
    let c = this.map.get(key);
    if (c === undefined) {
      c = this._pool.pop();
      if (c === undefined) {
        c = {
          key: 0, cx: 0, cy: 0,
          data: new Uint8ClampedArray(CHUNK_BYTES),
          tex: null,        // gestita dal renderer
          texDirty: true,
          touched: false,   // true se il rasterizer ha scritto pixel reali
          c2d: null,        // canvas del fallback 2D
        };
      }
      c.key = key; c.cx = cx; c.cy = cy; c.texDirty = true; c.touched = false;
      this.map.set(key, c);
    }
    return c;
  }

  markDirty(chunk) {
    this.dirty.add(chunk);
  }

  // Svuota lo store. I chunk che entrano nel pool tengono la texture viva
  // (riusata al prossimo stroke); per l'overflow la texture VA liberata,
  // altrimenti è un leak GPU. disposeAll = true libera tutte le texture.
  releaseAll(disposeTex, disposeAll = false) {
    for (const c of this.map.values()) {
      this._release(c, disposeTex, disposeAll);
    }
    this.map.clear();
    this.dirty.clear();
  }

  _release(c, disposeTex, forceDispose) {
    c.data.fill(0);
    c.touched = false;
    if (this._pool.length < 64) {
      if (forceDispose && disposeTex) disposeTex(c);
      this._pool.push(c);
    } else if (disposeTex) {
      disposeTex(c);
    }
  }

  // Rimuove un singolo chunk (undo "non esisteva", commit incrementale)
  remove(key, disposeTex, disposeAll = false) {
    const c = this.map.get(key);
    if (!c) return;
    this.map.delete(key);
    this.dirty.delete(c);
    this._release(c, disposeTex, disposeAll);
  }

  get count() { return this.map.size; }
  get cpuBytes() { return this.map.size * CHUNK_BYTES; }
}

// Itera i chunk che intersecano il bbox mondo [x0,y0]..[x1,y1] (px, inclusivo).
// cb(chunk, rettangolo locale nel chunk: lx0, ly0, lx1, ly1, origine mondo del chunk)
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
