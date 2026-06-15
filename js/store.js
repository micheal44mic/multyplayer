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
    // versione del CONTENUTO: cresce a ogni scrittura/rimozione di pixel.
    // Le cache di presentazione (proxy dei board) la usano per invalidarsi.
    this.ver = 0;
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
    this.ver++;
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
    if (this.map.size > 0) this.ver++;
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
    this.ver++;
    this.map.delete(key);
    this.dirty.delete(c);
    this._release(c, disposeTex, disposeAll);
  }

  // Tutti i chunk, vivi E nel pool (migrazione tra piani, context cleanup).
  /** @param {(c: Chunk) => void} cb */
  forEachChunkAll(cb) {
    for (const c of this.map.values()) cb(c);
    for (const c of this._pool) cb(c);
  }

  // Morte definitiva dello store (livello eliminato per sempre): libera
  // texture, slot wasm e pool — releaseAll non basta, il pool tiene vivi
  // i buffer per il riuso.
  /** @param {(c: Chunk) => void} disposeTex */
  destroy(disposeTex) {
    for (const c of this.map.values()) {
      if (disposeTex) disposeTex(c);
      if (this.heap && c.ptr) this.heap.free(c.ptr, CHUNK_BYTES);
    }
    this.map.clear();
    this.dirty.clear();
    for (const c of this._pool) {
      if (disposeTex) disposeTex(c);
      if (this.heap && c.ptr) this.heap.free(c.ptr, CHUNK_BYTES);
    }
    this._pool.length = 0;
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
// clip: se presente, solo i chunk con chiave nel set (pass finale del taper:
// si riscrive la sola punta; il check precede getOrCreate, fuori dal clip non
// si crea nulla).
/**
 * @param {ChunkStore} store
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {boolean} create
 * @param {(chunk: Chunk, lx0: number, ly0: number, lx1: number, ly1: number, ox: number, oy: number) => void} cb
 * @param {Set<number>|null} [clip]
 */
export function forEachChunkInRect(store, x0, y0, x1, y1, create, cb, clip = null) {
  const cx0 = x0 >> CHUNK_SHIFT, cy0 = y0 >> CHUNK_SHIFT;
  const cx1 = x1 >> CHUNK_SHIFT, cy1 = y1 >> CHUNK_SHIFT;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (clip !== null && !clip.has(chunkKey(cx, cy))) continue;
      const chunk = create ? store.getOrCreate(cx, cy) : store.get(cx, cy);
      if (!chunk) continue;
      const ox = cx << CHUNK_SHIFT, oy = cy << CHUNK_SHIFT;
      const lx0 = Math.max(0, x0 - ox), ly0 = Math.max(0, y0 - oy);
      const lx1 = Math.min(CHUNK - 1, x1 - ox), ly1 = Math.min(CHUNK - 1, y1 - oy);
      cb(chunk, lx0, ly0, lx1, ly1, ox, oy);
    }
  }
}

// bbox pixel-exact del contenuto (alpha > 0), in mondo inclusivo; null se lo
// store è vuoto. Fotografa l'hull di partenza delle sessioni Sposta/
// Trasforma e del pannello Effetti.
/** @param {ChunkStore} store @returns {{x0:number,y0:number,x1:number,y1:number}|null} */
export function contentBBox(store) {
  let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
  for (const c of store.map.values()) {
    const d = c.data, bx = c.cx * CHUNK, by = c.cy * CHUNK;
    for (let y = 0; y < CHUNK; y++) {
      let o = y * CHUNK * 4 + 3;
      for (let x = 0; x < CHUNK; x++, o += 4) {
        if (d[o] === 0) continue;
        const wx = bx + x, wy = by + y;
        if (wx < X0) X0 = wx;
        if (wx > X1) X1 = wx;
        if (wy < Y0) Y0 = wy;
        if (wy > Y1) Y1 = wy;
      }
    }
  }
  return X1 < X0 ? null : { x0: X0, y0: Y0, x1: X1, y1: Y1 };
}

// Trasla TUTTI i pixel dello store di (dx, dy) px mondo INTERI, clippando al
// rettangolo inclusivo [clip.x0..x1]×[clip.y0..y1] (i bordi del board): i
// pixel che escono si perdono. Ritorna gli stati "prima" (copia integrale)
// dei chunk sorgente che perdono pixel nel clip — è tutto ciò che serve
// all'undo: traslare all'indietro è lossless, solo il bordo va fotografato.
// Offset e clip allineati al chunk = puro re-key della mappa: zero copie di
// pixel, le texture GPU restano valide (cambiano solo cx/cy/key).
/**
 * @param {ChunkStore} store @param {number} dx @param {number} dy
 * @param {{x0:number,y0:number,x1:number,y1:number}} clip
 * @param {(c: Chunk) => void} disposeTex
 * @returns {{key:number,cx:number,cy:number,existed:boolean,buf:ArrayBuffer,rawSize:number}[]}
 */
export function translateStore(store, dx, dy, clip, disposeTex) {
  /** @type {{key:number,cx:number,cy:number,existed:boolean,buf:ArrayBuffer,rawSize:number}[]} */
  const lost = [];
  if (store.map.size === 0 || (dx === 0 && dy === 0)) return lost;

  // chunk sorgente che dopo lo shift sborderebbe dal clip: fotografato intero
  // PRIMA di ogni mutazione (conservativo: anche se i pixel lì sono vuoti)
  for (const c of store.map.values()) {
    const x0 = c.cx * CHUNK + dx, y0 = c.cy * CHUNK + dy;
    if (x0 < clip.x0 || y0 < clip.y0 ||
      x0 + CHUNK - 1 > clip.x1 || y0 + CHUNK - 1 > clip.y1) {
      lost.push({ key: c.key, cx: c.cx, cy: c.cy, existed: true, buf: c.data.slice().buffer, rawSize: CHUNK_BYTES });
    }
  }

  /** @type {(v: number) => boolean} */
  const aligned = (v) => ((v % CHUNK) + CHUNK) % CHUNK === 0;
  if (dx % CHUNK === 0 && dy % CHUNK === 0 &&
    aligned(clip.x0) && aligned(clip.x1 + 1) && aligned(clip.y0) && aligned(clip.y1 + 1)) {
    // re-key: ogni chunk è interamente dentro o interamente fuori dal clip
    const ddx = dx / CHUNK, ddy = dy / CHUNK;
    const moved = [...store.map.values()];
    store.map.clear();
    store.ver++;
    for (const c of moved) {
      const ncx = c.cx + ddx, ncy = c.cy + ddy;
      if (ncx * CHUNK < clip.x0 || ncy * CHUNK < clip.y0 ||
        ncx * CHUNK + CHUNK - 1 > clip.x1 || ncy * CHUNK + CHUNK - 1 > clip.y1) {
        store.dirty.delete(c);
        store._release(c, disposeTex, false);
        continue;
      }
      c.cx = ncx; c.cy = ncy; c.key = chunkKey(ncx, ncy);
      store.map.set(c.key, c);
    }
    return lost;
  }

  // caso generale: ogni chunk destinazione si compone da ≤4 sorgenti con
  // copie di righe; la raccolta legge SOLO dai sorgenti (nessun alloc wasm),
  // la scrittura legge SOLO dai buffer temporanei JS — niente races col grow
  /** @type {Map<number, {cx:number, cy:number, data:Uint8ClampedArray}>} */
  const out = new Map();
  for (const c of store.map.values()) {
    // rettangolo mondo del chunk spostato ∩ clip
    const wx0 = Math.max(c.cx * CHUNK + dx, clip.x0), wx1 = Math.min(c.cx * CHUNK + dx + CHUNK - 1, clip.x1);
    const wy0 = Math.max(c.cy * CHUNK + dy, clip.y0), wy1 = Math.min(c.cy * CHUNK + dy + CHUNK - 1, clip.y1);
    if (wx0 > wx1 || wy0 > wy1) continue;
    const src = c.data;
    for (let cy = wy0 >> CHUNK_SHIFT; cy <= wy1 >> CHUNK_SHIFT; cy++) {
      for (let cx = wx0 >> CHUNK_SHIFT; cx <= wx1 >> CHUNK_SHIFT; cx++) {
        const key = chunkKey(cx, cy);
        let dst = out.get(key);
        if (!dst) {
          dst = { cx, cy, data: new Uint8ClampedArray(CHUNK_BYTES) };
          out.set(key, dst);
        }
        // overlap tra il chunk destinazione e il chunk sorgente spostato
        const ox0 = Math.max(wx0, cx * CHUNK), ox1 = Math.min(wx1, cx * CHUNK + CHUNK - 1);
        const oy0 = Math.max(wy0, cy * CHUNK), oy1 = Math.min(wy1, cy * CHUNK + CHUNK - 1);
        const n = (ox1 - ox0 + 1) * 4;
        for (let wy = oy0; wy <= oy1; wy++) {
          const so = ((wy - dy - c.cy * CHUNK) * CHUNK + (ox0 - dx - c.cx * CHUNK)) * 4;
          const dofs = ((wy - cy * CHUNK) * CHUNK + (ox0 - cx * CHUNK)) * 4;
          dst.data.set(src.subarray(so, so + n), dofs);
        }
      }
    }
  }
  // destinazioni rimaste completamente trasparenti: non si creano
  for (const [key, d] of out) {
    let any = false;
    const a = d.data;
    for (let o = 3; o < a.length; o += 4) if (a[o] !== 0) { any = true; break; }
    if (!any) out.delete(key);
  }
  // scrittura: via i chunk svuotati, dentro i contenuti nuovi
  for (const key of [...store.map.keys()]) {
    if (!out.has(key)) store.remove(key, disposeTex);
  }
  for (const d of out.values()) {
    const chunk = store.getOrCreate(d.cx, d.cy);
    chunk.data.set(d.data);
    chunk.touched = true;
    store.markDirty(chunk);
  }
  return lost;
}

// Trasforma TUTTI i pixel dello store con l'affine mondo m = [a,b,c,d,e,f]
// (x' = a·x + c·y + e, y' = b·x + d·y + f): mapping inverso per pixel
// destinazione, bilineare su premultiplied (lo spazio corretto per filtrare,
// niente aloni), clip al rettangolo inclusivo del board. LOSSY: l'undo è il
// tile-diff — capture(key, cx, cy, beforeOrNull) viene chiamato per OGNI
// chunk che cambia, PRIMA della mutazione. srcBox: hull chunk-aligned del
// contenuto ({x,y,w,h} mondo). Per la traslazione intera pura usare
// translateStore, che è bit-exact e con undo leggero.
/**
 * @param {ChunkStore} store @param {number[]} m
 * @param {{x:number,y:number,w:number,h:number}} srcBox
 * @param {{x0:number,y0:number,x1:number,y1:number}} clip
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray|null) => void} capture
 * @param {(c: Chunk) => void} disposeTex
 */
export function transformStore(store, m, srcBox, clip, capture, disposeTex) {
  if (store.map.size === 0) return;
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  // snapshot contiguo del sorgente: letto tutto PRIMA di ogni mutazione
  const sw = srcBox.w, sh = srcBox.h;
  const src = new Uint8ClampedArray(sw * sh * 4);
  for (const ch of store.map.values()) {
    const ox = ch.cx * CHUNK - srcBox.x, oy = ch.cy * CHUNK - srcBox.y;
    if (ox < 0 || oy < 0 || ox + CHUNK > sw || oy + CHUNK > sh) continue; // fuori hull: vuoto per costruzione
    for (let row = 0; row < CHUNK; row++) {
      src.set(ch.data.subarray(row * CHUNK * 4, (row + 1) * CHUNK * 4), ((oy + row) * sw + ox) * 4);
    }
  }
  // bbox destinazione: angoli del sorgente trasformati, ∩ clip
  let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
  for (const [px, py] of [[srcBox.x, srcBox.y], [srcBox.x + sw, srcBox.y],
    [srcBox.x, srcBox.y + sh], [srcBox.x + sw, srcBox.y + sh]]) {
    const X = a * px + c * py + e, Y = b * px + d * py + f;
    if (X < dx0) dx0 = X; if (X > dx1) dx1 = X;
    if (Y < dy0) dy0 = Y; if (Y > dy1) dy1 = Y;
  }
  dx0 = Math.max(Math.floor(dx0) - 1, clip.x0);
  dy0 = Math.max(Math.floor(dy0) - 1, clip.y0);
  dx1 = Math.min(Math.ceil(dx1) + 1, clip.x1);
  dy1 = Math.min(Math.ceil(dy1) + 1, clip.y1);

  // cattura: tutti i chunk esistenti (saranno svuotati) + la fascia destinazione
  /** @type {Set<number>} */
  const seen = new Set();
  for (const ch of store.map.values()) {
    seen.add(ch.key);
    capture(ch.key, ch.cx, ch.cy, ch.data);
  }
  if (dx0 <= dx1 && dy0 <= dy1) {
    for (let cy = dy0 >> CHUNK_SHIFT; cy <= dy1 >> CHUNK_SHIFT; cy++) {
      for (let cx = dx0 >> CHUNK_SHIFT; cx <= dx1 >> CHUNK_SHIFT; cx++) {
        const key = chunkKey(cx, cy);
        if (!seen.has(key)) { seen.add(key); capture(key, cx, cy, null); }
      }
    }
  }
  // via tutto il sorgente: il contenuto rinasce ricampionato
  for (const key of [...store.map.keys()]) store.remove(key, disposeTex);
  if (dx0 > dx1 || dy0 > dy1) return; // tutto fuori dal canvas
  const det = a * d - b * c;
  if (det === 0) return; // degenerata (scala 0): livello svuotato, già catturato
  // inversa: da pixel destinazione a coordinate campione nel sorgente
  const ia = d / det, ib = -b / det, ic = -c / det, id2 = a / det;
  const ie = (c * f - d * e) / det, if2 = (b * e - a * f) / det;

  const scratch = new Uint8ClampedArray(CHUNK_BYTES);
  for (let cy = dy0 >> CHUNK_SHIFT; cy <= dy1 >> CHUNK_SHIFT; cy++) {
    for (let cx = dx0 >> CHUNK_SHIFT; cx <= dx1 >> CHUNK_SHIFT; cx++) {
      const x0 = Math.max(cx * CHUNK, dx0), x1 = Math.min(cx * CHUNK + CHUNK - 1, dx1);
      const y0 = Math.max(cy * CHUNK, dy0), y1 = Math.min(cy * CHUNK + CHUNK - 1, dy1);
      scratch.fill(0);
      let any = false;
      for (let py = y0; py <= y1; py++) {
        // centro del pixel destinazione → indice cella sorgente (campioni ai
        // centri: il -0.5 riporta alla griglia degli indici); il passo per
        // px+1 è costante (affine): si avanza incrementalmente
        let sxf = ia * (x0 + 0.5) + ic * (py + 0.5) + ie - srcBox.x - 0.5;
        let syf = ib * (x0 + 0.5) + id2 * (py + 0.5) + if2 - srcBox.y - 0.5;
        let o = ((py - cy * CHUNK) * CHUNK + (x0 - cx * CHUNK)) * 4;
        for (let px = x0; px <= x1; px++, o += 4, sxf += ia, syf += ib) {
          const fx = Math.floor(sxf), fy = Math.floor(syf);
          if (fx < -1 || fy < -1 || fx >= sw || fy >= sh) continue;
          const wx = sxf - fx, wy = syf - fy;
          const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy);
          const w01 = (1 - wx) * wy, w11 = wx * wy;
          let r = 0, g = 0, bl2 = 0, al = 0;
          const in00 = fx >= 0 && fy >= 0, in10 = fx + 1 < sw && fy >= 0;
          const in01 = fx >= 0 && fy + 1 < sh, in11 = fx + 1 < sw && fy + 1 < sh;
          if (in00 && w00 > 0) {
            const t = (fy * sw + fx) * 4;
            r += src[t] * w00; g += src[t + 1] * w00; bl2 += src[t + 2] * w00; al += src[t + 3] * w00;
          }
          if (in10 && w10 > 0) {
            const t = (fy * sw + fx + 1) * 4;
            r += src[t] * w10; g += src[t + 1] * w10; bl2 += src[t + 2] * w10; al += src[t + 3] * w10;
          }
          if (in01 && w01 > 0) {
            const t = ((fy + 1) * sw + fx) * 4;
            r += src[t] * w01; g += src[t + 1] * w01; bl2 += src[t + 2] * w01; al += src[t + 3] * w01;
          }
          if (in11 && w11 > 0) {
            const t = ((fy + 1) * sw + fx + 1) * 4;
            r += src[t] * w11; g += src[t + 1] * w11; bl2 += src[t + 2] * w11; al += src[t + 3] * w11;
          }
          if (al < 0.5) continue; // arrotonderebbe a 0: il pixel resta vuoto
          scratch[o] = r; scratch[o + 1] = g; scratch[o + 2] = bl2; scratch[o + 3] = al;
          any = true;
        }
      }
      if (!any) continue;
      const chunk = store.getOrCreate(cx, cy);
      chunk.data.set(scratch);
      chunk.touched = true;
      store.markDirty(chunk);
    }
  }
}
