// RASTERIZER A DUE VIE + BUDGET.
// - via continua: catena di capsule per segmento (lavoro ∝ area, non al n. di stamp)
// - via discreta: stamp dalla StampCache
// Tutto scrive nello stroke buffer (chunk sparsi premultiplied), mai sul layer.
// Il budget limita i pixel toccati per frame: l'eccedenza resta in coda (catch-up).

import { div255 } from './util.js';
import { falloff } from './brush.js';
import { CHUNK, CHUNK_SHIFT, forEachChunkInRect } from './store.js';
import { T_DAB } from './stroke.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./stroke.js').Snap} Snap */
/** @typedef {import('./stroke.js').DabQueue} DabQueue */
/** @typedef {import('./brush.js').StampCache} StampCache */

// Identità stabile per una texture (le LUT vengono ricostruite a ogni stroke,
// l'oggetto texture no): entra nella firma di invalidazione dei tile.
/** @type {WeakMap<object, number>} */
const texTags = new WeakMap();
let nextTexTag = 1;
/** @param {object} tex */
function texTag(tex) {
  let id = texTags.get(tex);
  if (id === undefined) { id = nextTexTag++; texTags.set(tex, id); }
  return id;
}

// FNV-1a sui byte di una LUT: due LUT con gli stessi parametri hanno lo
// stesso hash anche se sono oggetti diversi (ricostruite per stroke).
/** @param {Uint8Array} bytes */
function fnv(bytes) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h >>> 0;
}

export class Rasterizer {
  /**
   * @param {ChunkStore} strokeStore @param {StampCache} stampCache
   * @param {import('./wasm_core.js').WasmHeap|null} [heap]
   */
  constructor(strokeStore, stampCache, heap = null) {
    this.store = strokeStore;
    this.cache = stampCache;
    this.heap = heap; // core SIMD: stessi identici output del path JS
    /** @type {Snap|null} */
    this.snap = null;
    // Pass finale del taper: set di chiavi chunk (i soli svuotati della
    // punta) a cui il replay può scrivere. Il resto del tratto è già giusto
    // e in buildup riscriverlo lo accumulerebbe due volte. null = nessun clip.
    /** @type {Set<number>|null} */
    this.clip = null;
    // stats per HUD
    this.lastPx = 0;
    this.lastDabs = 0;
    // LUT riusate (zero allocazioni per dab):
    // _maLut[m] = div255(m * a255)  — alpha del dab applicata alla maschera
    // _lutR/G/B[ma] = div255(c * ma) — colore premultiplied per ogni alpha
    this._maLut = new Uint8Array(256);
    this._lutA = -1;        // a255 per cui _maLut è valida
    this._lutR = new Uint8Array(256);
    this._lutG = new Uint8Array(256);
    this._lutB = new Uint8Array(256);
    this._lutColorKey = -1; // (cr<<16)|(cg<<8)|cb per cui le LUT colore sono valide
    // LUT colonna/riga del campionamento bilineare, riusate (zero alloc):
    // u16 = indici texel (wrap REPEAT), u8 = frazione 0..255 in 8.8
    /** @type {Uint16Array|null} */
    this._cu0 = null;
    /** @type {Uint16Array|null} */
    this._cu1 = null;
    /** @type {Uint8Array|null} */
    this._cuf = null;
    /** @type {Uint16Array|null} */
    this._rv0 = null;
    /** @type {Uint16Array|null} */
    this._rv1 = null;
    /** @type {Uint8Array|null} */
    this._rvf = null;
    // TILE texture in spazio canvas (grana ancorata): fattore f = lut[lum] e
    // colori RGBX dipendono solo dalla posizione assoluta del pixel, quindi
    // si calcolano UNA volta per chunk e si riusano per ogni dab/capsula che
    // lo tocca (con spacing piccolo i dab si sovrappongono quasi del tutto:
    // prima la stessa texture veniva ricampionata centinaia di volte per px).
    // LRU bounded; ver/sig invalidano quando cambiano texture o parametri.
    /** @type {Map<number, {ver: number, lum: Uint8Array, lumPtr: number, rgbx: Uint8Array|null, rgbxPtr: number}>} */
    this._tiles = new Map();
    this._tileCap = 48;      // dimensionata sul pennello in beginStroke
    this._texVer = 0;
    this._texSig = '';
    this._tileLevel = 0;     // livello mip della grana ancorata (per stroke)
    this._tileFillPx = 0;    // px di tile/bake riempiti (conteggiati nel budget)
    // Maschere pre-modulate per texture MOVING: la grana segue lo stamp,
    // quindi m2 = div255(m*f) dipende solo dalle coordinate locali dello
    // stamp -> bake per stamp (LRU), poi il dab texturizzato è un dab normale.
    /** @type {Map<import('./brush.js').Stamp, {ver: number, mask: Uint8Array, ptr: number, rgb: Uint8Array|null}>} */
    this._baked = new Map();
    this._bakedBytes = 0; // i formati giganti hanno maschere da MB: bound in byte
    // strumentazione per l'HUD: tempo speso nel lavoro texture (fill di tile
    // e bake di maschere) nell'ultimo run
    this.lastTexMs = 0;
    this.lastTexDabs = 0;
  }

  /** @param {number} n */
  _ensureJsLuts(n) {
    if (this._cu0 && this._cu0.length >= n) return;
    this._cu0 = new Uint16Array(n);
    this._cu1 = new Uint16Array(n);
    this._cuf = new Uint8Array(n);
    this._rv0 = new Uint16Array(n);
    this._rv1 = new Uint16Array(n);
    this._rvf = new Uint8Array(n);
  }

  // Livello mip dal passo di campionamento (texel livello 0 per px documento).
  /** @param {number} size */
  _texLevel(size) {
    const snap = this.snap, tex = snap.tex;
    const step = snap.texMoving ? tex.w / (size * snap.texScale) : 1 / snap.texScale;
    let level = 0;
    while (level + 1 < tex.mips.length && step >= (2 << level)) level++;
    return level;
  }

  // Riempie le LUT colonna/riga del campionamento bilineare per questo dab.
  // UNICA sorgente della matematica float: path JS e wasm condividono questi
  // valori interi, quindi i due motori producono gli stessi byte. Ritorna lw.
  /**
   * @param {number} size @param {number} ix @param {number} iy
   * @param {number} level
   * @param {Uint16Array} u0 @param {Uint16Array} u1 @param {Uint8Array} uf
   * @param {Uint16Array} v0 @param {Uint16Array} v1 @param {Uint8Array} vf
   */
  _texFill(size, ix, iy, level, u0, u1, uf, v0, v1, vf) {
    const snap = this.snap, tex = snap.tex, scale = snap.texScale;
    const lw = tex.mw[level], lh = tex.mh[level];
    // texel del livello per px documento: il periodo resta quello del
    // livello 0 (la tile non cambia dimensione quando scatta il mip).
    // Ancorata al canvas la tile copre tex.w*scale px; in moving la texture
    // copre l'intero stamp.
    const kx = snap.texMoving ? lw / (size * scale) : lw / (tex.w * scale);
    const ky = snap.texMoving ? lh / (size * scale) : lh / (tex.h * scale);
    const ox = snap.texMoving ? 0 : ix;
    const oy = snap.texMoving ? 0 : iy;
    for (let x = 0; x < size; x++) {
      const u = (ox + x + 0.5) * kx - 0.5;
      const iu = Math.floor(u);
      let a = iu % lw; if (a < 0) a += lw;
      u0[x] = a;
      u1[x] = a + 1 < lw ? a + 1 : 0;
      uf[x] = (u - iu) * 256 | 0;
    }
    for (let y = 0; y < size; y++) {
      const v = (oy + y + 0.5) * ky - 0.5;
      const iv = Math.floor(v);
      let a = iv % lh; if (a < 0) a += lh;
      v0[y] = a;
      v1[y] = a + 1 < lh ? a + 1 : 0;
      vf[y] = (v - iv) * 256 | 0;
    }
    return lw;
  }

  /** @param {Snap|null} snap */
  beginStroke(snap) {
    this.snap = snap;
    this._lutA = -1;
    this._lutColorKey = -1;
    // Firma dei parametri texture: se cambia, tile e maschere baked cached
    // non valgono più (la versione le invalida pigramente, senza svuotare).
    if (snap && snap.tex && snap.texLut) {
      if (!snap.texMoving) this._tileLevel = this._texLevel(0); // step = 1/scale, la taglia non conta
      const sig = `${texTag(snap.tex)}|${snap.texMoving ? 'm' : this._tileLevel}|${snap.texScale}|` +
        `${fnv(snap.texLut)}|${snap.texColorLut ? fnv(snap.texColorLut) : 0}`;
      if (sig !== this._texSig) { this._texSig = sig; this._texVer++; }
      // la cache dei tile deve contenere almeno l'impronta del pennello (un
      // dab gigante tocca ~(diam/256+2)² chunk) con margine di avanzamento
      const cols = Math.ceil(snap.diam / CHUNK) + 2;
      this._tileCap = Math.max(48, cols * cols * 2);
    }
  }

  // Tile del chunk: fattore (e colori RGBX) della grana ancorata, riempiti
  // pigramente e riusati per tutto ciò che tocca il chunk. LRU bounded.
  /** @param {Chunk} chunk @param {boolean} needRgb */
  _tile(chunk, needRgb) {
    let t = this._tiles.get(chunk.key);
    if (t !== undefined) {
      if (t.ver === this._texVer && (!needRgb || t.rgbx !== null)) {
        this._tiles.delete(chunk.key); // LRU: reinserisci in coda
        this._tiles.set(chunk.key, t);
        return t;
      }
      this._tiles.delete(chunk.key);
    } else {
      t = { ver: 0, lum: new Uint8Array(CHUNK * CHUNK), lumPtr: 0, rgbx: null, rgbxPtr: 0 };
    }
    const t0 = performance.now();
    if (needRgb && t.rgbx === null) t.rgbx = new Uint8Array(CHUNK * CHUNK * 4);
    this._tileFill(t, chunk.cx << CHUNK_SHIFT, chunk.cy << CHUNK_SHIFT, needRgb);
    t.ver = this._texVer;
    if (this.heap) {
      if (!t.lumPtr) t.lumPtr = this.heap.alloc(CHUNK * CHUNK);
      this.heap.u8(t.lumPtr, CHUNK * CHUNK).set(t.lum);
      if (needRgb) {
        if (!t.rgbxPtr) t.rgbxPtr = this.heap.alloc(CHUNK * CHUNK * 4);
        this.heap.u8(t.rgbxPtr, CHUNK * CHUNK * 4).set(t.rgbx);
      }
    }
    this._tiles.set(chunk.key, t);
    while (this._tiles.size > this._tileCap) {
      const k = this._tiles.keys().next().value;
      const old = this._tiles.get(k);
      this._tiles.delete(k);
      if (this.heap) {
        if (old.lumPtr) this.heap.free(old.lumPtr, CHUNK * CHUNK);
        if (old.rgbxPtr) this.heap.free(old.rgbxPtr, CHUNK * CHUNK * 4);
      }
    }
    this._tileFillPx += CHUNK * CHUNK;
    this.lastTexMs += performance.now() - t0;
    return t;
  }

  // Riempie il tile con la STESSA matematica di _texFill/_textureMask
  // (bilineare intera 8.8 + LUT): per lo stesso pixel assoluto escono gli
  // stessi byte del vecchio campionamento per-dab, su entrambi i motori.
  /** @param {{lum: Uint8Array, rgbx: Uint8Array|null}} t @param {number} ox @param {number} oy @param {boolean} needRgb */
  _tileFill(t, ox, oy, needRgb) {
    const snap = this.snap, tex = snap.tex, lut = snap.texLut;
    const level = this._tileLevel;
    this._ensureJsLuts(CHUNK);
    const u0 = this._cu0, u1 = this._cu1, uf = this._cuf;
    const v0 = this._rv0, v1 = this._rv1, vf = this._rvf;
    const lw = this._texFill(CHUNK, ox, oy, level, u0, u1, uf, v0, v1, vf);
    const data = tex.mips[level];
    const lum = t.lum;
    const rgbx = needRgb ? t.rgbx : null;
    const rgbData = needRgb ? tex.rgbMips[level] : null;
    const lutC = snap.texColorLut;

    let i = 0;
    for (let y = 0; y < CHUNK; y++) {
      const fv = vf[y];
      const o0 = v0[y] * lw, o1 = v1[y] * lw;
      for (let x = 0; x < CHUNK; x++, i++) {
        const fu = uf[x], a = u0[x], b = u1[x];
        const top = data[o0 + a] * (256 - fu) + data[o0 + b] * fu;
        const bot = data[o1 + a] * (256 - fu) + data[o1 + b] * fu;
        lum[i] = lut[(top * (256 - fv) + bot * fv + 32768) >> 16];
        if (rgbx !== null) {
          const a3 = a * 3, b3 = b * 3, p0 = o0 * 3, p1 = o1 * 3, ci = i * 4;
          for (let c = 0; c < 3; c++) {
            const tc = rgbData[p0 + a3 + c] * (256 - fu) + rgbData[p0 + b3 + c] * fu;
            const bc = rgbData[p1 + a3 + c] * (256 - fu) + rgbData[p1 + b3 + c] * fu;
            rgbx[ci + c] = lutC[(tc * (256 - fv) + bc * fv + 32768) >> 16];
          }
          rgbx[ci + 3] = 255; // X=255: la lane alpha del composito produce ma
        }
      }
    }
  }

  // Maschera pre-modulata per la texture moving: m2 = div255(m * f) con f
  // calcolato sulle coordinate locali dello stamp — identico, byte per byte,
  // al vecchio campionamento per-dab (la grana che segue lo stamp non dipende
  // dalla posizione). Con la modalità colore bake anche l'RGB.
  /** @param {import('./brush.js').Stamp} stamp @param {boolean} needRgb */
  _bakedStamp(stamp, needRgb) {
    let b = this._baked.get(stamp);
    if (b !== undefined) {
      if (b.ver === this._texVer && (!needRgb || b.rgb !== null)) {
        this._baked.delete(stamp); // LRU
        this._baked.set(stamp, b);
        return b;
      }
      this._baked.delete(stamp);
    } else {
      b = { ver: 0, mask: new Uint8Array(stamp.size * stamp.size), ptr: 0, rgb: null };
      this._bakedBytes += stamp.size * stamp.size;
    }
    const t0 = performance.now();
    const n = stamp.size * stamp.size;
    if (needRgb && b.rgb === null) { b.rgb = new Uint8Array(n * 3); this._bakedBytes += n * 3; }
    this._textureMask(stamp.mask, b.mask, stamp.size, 0, 0, needRgb ? b.rgb : null);
    b.ver = this._texVer;
    if (this.heap) {
      if (!b.ptr) b.ptr = this.heap.alloc(n);
      this.heap.u8(b.ptr, n).set(b.mask);
    }
    this._baked.set(stamp, b);
    // bound per entry E per byte (l'entry appena inserita è l'ultima: mai evicted)
    while (this._baked.size > 1 && (this._baked.size > 64 || this._bakedBytes > (64 << 20))) {
      const k = this._baked.keys().next().value;
      const old = this._baked.get(k);
      this._baked.delete(k);
      this._bakedBytes -= old.mask.length + (old.rgb ? old.rgb.length : 0);
      if (this.heap && old.ptr) this.heap.free(old.ptr, old.mask.length);
    }
    this._tileFillPx += n;
    this.lastTexMs += performance.now() - t0;
    return b;
  }

  // Stessa identica aritmetica dei loop per-pixel, fattorizzata in tabelle:
  // 256 voci battono qualunque dab più grande di ~16x16.
  /** @param {number} a255 */
  _ensureMaLut(a255) {
    if (a255 === this._lutA) return;
    const L = this._maLut;
    if (a255 === 255) { for (let i = 0; i < 256; i++) L[i] = i; }
    else { for (let i = 0; i < 256; i++) L[i] = div255(i * a255); }
    this._lutA = a255;
  }

  /** @param {number} cr @param {number} cg @param {number} cb */
  _ensureColorLut(cr, cg, cb) {
    const key = (cr << 16) | (cg << 8) | cb;
    if (key === this._lutColorKey) return;
    const R = this._lutR, G = this._lutG, B = this._lutB;
    for (let i = 0; i < 256; i++) {
      R[i] = div255(cr * i);
      G[i] = div255(cg * i);
      B[i] = div255(cb * i);
    }
    this._lutColorKey = key;
  }

  // Drena la coda fino a esaurimento o budget (px toccati). Ritorna px usati.
  /** @param {DabQueue} queue @param {number} budgetPx */
  run(queue, budgetPx) {
    const snap = this.snap;
    this.lastPx = 0;
    this.lastDabs = 0;
    this.lastTexMs = 0;
    this.lastTexDabs = 0;
    this._tileFillPx = 0;
    if (!snap) { queue.clear(); return 0; }

    let used = 0;
    const buf = () => queue.buf; // il buffer può cambiare se la coda cresce

    while (queue.count > 0) {
      const q = buf();
      const o = queue.peekOffset();
      const type = q[o];

      let cost;
      if (type === T_DAB) {
        const r = q[o + 3];
        const d = (Math.ceil(r) + 1) * 2;
        cost = d * d;
      } else {
        const maxR = Math.max(q[o + 3], q[o + 7]) + 1;
        const w = Math.abs(q[o + 5] - q[o + 1]) + maxR * 2;
        const h = Math.abs(q[o + 6] - q[o + 2]) + maxR * 2;
        cost = w * h;
      }
      // almeno una entry per frame per garantire progresso
      if (used > 0 && used + cost > budgetPx) break;

      if (type === T_DAB) {
        this._dab(q[o + 1], q[o + 2], q[o + 3], q[o + 4], q[o + 5], q[o + 6], q[o + 7], q[o + 8]);
      } else {
        this._capsule(q[o + 1], q[o + 2], q[o + 3], q[o + 4], q[o + 5], q[o + 6], q[o + 7], q[o + 8]);
      }
      queue.pop();
      // i fill di tile/bake sono lavoro vero: contano nel budget del frame
      used += cost + this._tileFillPx;
      this._tileFillPx = 0;
      this.lastDabs++;
    }
    this.lastPx = used;
    return used;
  }

  // Modula la maschera dello stamp con la texture del pennello scrivendo in
  // dst. Campionamento bilineare sul livello mip scelto dal passo (la grana
  // resta antialiasata anche molto rimpicciolita), wrap REPEAT, aritmetica
  // intera 8.8: stessi byte qualunque sia il motore di composito a valle.
  // Con rgbOut (modalità colore) la stessa passata campiona anche l'RGB
  // della texture, col contrasto applicato via LUT.
  /**
   * @param {Uint8Array} src maschera dello stamp (mai modificata)
   * @param {Uint8Array} dst scratch (size*size)
   * @param {number} size @param {number} ix @param {number} iy origine mondo
   * @param {Uint8Array|null} rgbOut scratch RGB (size*size*3) o null
   */
  _textureMask(src, dst, size, ix, iy, rgbOut) {
    const snap = this.snap;
    const tex = snap.tex, lut = snap.texLut;
    const level = this._texLevel(size);
    this._ensureJsLuts(size);
    const u0 = this._cu0, u1 = this._cu1, uf = this._cuf;
    const v0 = this._rv0, v1 = this._rv1, vf = this._rvf;
    const lw = this._texFill(size, ix, iy, level, u0, u1, uf, v0, v1, vf);
    const data = tex.mips[level];
    const rgbData = rgbOut ? tex.rgbMips[level] : null;
    const lutC = snap.texColorLut;

    let i = 0;
    for (let y = 0; y < size; y++) {
      const fv = vf[y];
      const o0 = v0[y] * lw, o1 = v1[y] * lw;
      for (let x = 0; x < size; x++, i++) {
        const m = src[i];
        if (m === 0) { dst[i] = 0; continue; }
        const fu = uf[x], a = u0[x], b = u1[x];
        const top = data[o0 + a] * (256 - fu) + data[o0 + b] * fu;
        const bot = data[o1 + a] * (256 - fu) + data[o1 + b] * fu;
        const lum = (top * (256 - fv) + bot * fv + 32768) >> 16;
        dst[i] = div255(m * lut[lum]);
        if (rgbData !== null) {
          const a3 = a * 3, b3 = b * 3, p0 = o0 * 3, p1 = o1 * 3, ci = i * 3;
          for (let c = 0; c < 3; c++) {
            const t = rgbData[p0 + a3 + c] * (256 - fu) + rgbData[p0 + b3 + c] * fu;
            const bo = rgbData[p1 + a3 + c] * (256 - fu) + rgbData[p1 + b3 + c] * fu;
            rgbOut[ci + c] = lutC[(t * (256 - fv) + bo * fv + 32768) >> 16];
          }
        }
      }
    }
  }

  // Composito per-pixel della modalità "colori della texture": il colore
  // arriva dallo scratch RGB, non dal colore del pennello. Sempre in JS,
  // anche col core wasm attivo (l'export dab ha un solo colore per stamp):
  // stesso codice nei due motori -> stessi byte.
  /**
   * @param {Uint8Array} mask scratch maschera già texturizzata
   * @param {Uint8Array} rgb scratch RGB (3 byte/px dello stamp)
   * @param {number} sSize @param {number} ix @param {number} iy
   * @param {number} a255
   */
  _dabTexColor(mask, rgb, sSize, ix, iy, a255) {
    const buildup = this.snap.buildup;
    const store = this.store;
    forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          let mi = (y2 + oy - iy) * sSize + (lx0 + ox - ix);
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4, mi++) {
            const m = mask[mi];
            if (m === 0) continue;
            const ma = div255(m * a255);
            if (ma === 0) continue;
            const ci = mi * 3;
            if (buildup) {
              const inv = 255 - ma;
              d[di] = div255(rgb[ci] * ma) + div255(d[di] * inv);
              d[di + 1] = div255(rgb[ci + 1] * ma) + div255(d[di + 1] * inv);
              d[di + 2] = div255(rgb[ci + 2] * ma) + div255(d[di + 2] * inv);
              d[di + 3] = ma + div255(d[di + 3] * inv);
            } else if (ma > d[di + 3]) {
              d[di] = div255(rgb[ci] * ma);
              d[di + 1] = div255(rgb[ci + 1] * ma);
              d[di + 2] = div255(rgb[ci + 2] * ma);
              d[di + 3] = ma;
            }
            wrote = true;
          }
        }
        if (wrote) chunk.touched = true;
      }, this.clip);
  }

  // ---- via discreta: stamp dalla cache ----
  /**
   * @param {number} x @param {number} y @param {number} r @param {number} alpha
   * @param {number} angle @param {number} cr @param {number} cg @param {number} cb
   */
  _dab(x, y, r, alpha, angle, cr, cg, cb) {
    const snap = this.snap;
    const stamp = this.cache.getStamp(r, snap.hardness, snap.roundness, angle);
    const sSize = stamp.size;
    const ix = Math.round(x - stamp.half);
    const iy = Math.round(y - stamp.half);
    const a255 = Math.min(255, (alpha * 255 + 0.5) | 0);
    if (a255 === 0) return;

    // Texture: due vie, entrambe con gli stessi byte in uscita di prima.
    // - grana ancorata al canvas: il fattore (e i colori) arrivano dai tile
    //   per chunk -> dab_tex_tile SIMD fuso o mirror JS, zero ricampionamenti;
    // - grana moving (segue lo stamp): maschera pre-modulata cached per stamp,
    //   poi il dab procede come un dab normale (modalità colore: composito JS).
    let mask = stamp.mask, maskPtr = stamp.ptr;
    if (snap.tex && snap.texLut) {
      this.lastTexDabs++;
      if (!snap.texMoving) {
        this._dabTile(stamp, ix, iy, a255, cr, cg, cb);
        return;
      }
      const baked = this._bakedStamp(stamp, snap.texColor);
      if (snap.texColor) {
        this._dabTexColor(baked.mask, baked.rgb, sSize, ix, iy, a255);
        return;
      }
      mask = baked.mask;
      maskPtr = baked.ptr;
    }
    const buildup = snap.buildup;
    const store = this.store;

    if (this.heap) {
      const ex = this.heap.exports;
      const bu = buildup ? 1 : 0;
      forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          store.markDirty(chunk, lx0, ly0, lx1, ly1);
          const wrote = ex.dab(chunk.ptr, lx0, ly0, lx1, ly1, maskPtr, sSize,
            lx0 + ox - ix, ly0 + oy - iy, a255, cr, cg, cb, bu);
          if (wrote) chunk.touched = true;
        }, this.clip);
      return;
    }

    // Le LUT convengono se sono già valide (alpha/colore stabili nel tratto)
    // o se il dab è grande abbastanza da ammortizzare le ~1280 op di rebuild
    // (jitter colore/opacità le invalida a ogni dab; i pixel scritti sono ben
    // meno dell'area del quadrato, quindi la soglia è prudente).
    const useLut = (this._lutA === a255 && this._lutColorKey === ((cr << 16) | (cg << 8) | cb)) ||
      sSize * sSize >= 4096;
    if (useLut) {
      this._ensureMaLut(a255);
      this._ensureColorLut(cr, cg, cb);
    }
    const maLut = this._maLut;
    const lutR = this._lutR, lutG = this._lutG, lutB = this._lutB;

    forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          let mi = (y2 + oy - iy) * sSize + (lx0 + ox - ix);
          if (useLut) {
            for (let x2 = lx0; x2 <= lx1; x2++, di += 4, mi++) {
              const ma = maLut[mask[mi]];
              if (ma === 0) continue;
              if (buildup) {
                const inv = 255 - ma;
                d[di] = lutR[ma] + div255(d[di] * inv);
                d[di + 1] = lutG[ma] + div255(d[di + 1] * inv);
                d[di + 2] = lutB[ma] + div255(d[di + 2] * inv);
                d[di + 3] = ma + div255(d[di + 3] * inv);
              } else if (ma > d[di + 3]) {
                // wash: max(alpha) — i dab non si scuriscono tra loro
                d[di] = lutR[ma];
                d[di + 1] = lutG[ma];
                d[di + 2] = lutB[ma];
                d[di + 3] = ma;
              }
              wrote = true;
            }
          } else {
            for (let x2 = lx0; x2 <= lx1; x2++, di += 4, mi++) {
              const m = mask[mi];
              if (m === 0) continue;
              const ma = div255(m * a255);
              if (ma === 0) continue;
              if (buildup) {
                const inv = 255 - ma;
                d[di] = div255(cr * ma) + div255(d[di] * inv);
                d[di + 1] = div255(cg * ma) + div255(d[di + 1] * inv);
                d[di + 2] = div255(cb * ma) + div255(d[di + 2] * inv);
                d[di + 3] = ma + div255(d[di + 3] * inv);
              } else if (ma > d[di + 3]) {
                d[di] = div255(cr * ma);
                d[di + 1] = div255(cg * ma);
                d[di + 2] = div255(cb * ma);
                d[di + 3] = ma;
              }
              wrote = true;
            }
          }
        }
        if (wrote) chunk.touched = true;
      }, this.clip);
  }

  // Dab con grana ancorata al canvas: maschera dello stamp × fattore dal
  // tile del chunk, poi lo stesso composito di _dab. Path wasm: dab_tex_tile
  // fuso (con l'RGBX del tile nella modalità colore); path JS: stessa doppia
  // quantizzazione (m2 = div255(m*f), ma = div255(m2*a255)) -> stessi byte.
  /**
   * @param {import('./brush.js').Stamp} stamp
   * @param {number} ix @param {number} iy @param {number} a255
   * @param {number} cr @param {number} cg @param {number} cb
   */
  _dabTile(stamp, ix, iy, a255, cr, cg, cb) {
    const snap = this.snap;
    const sSize = stamp.size;
    const useColor = snap.texColor;
    const buildup = snap.buildup;
    const store = this.store;

    if (this.heap) {
      const ex = this.heap.exports;
      const bu = buildup ? 1 : 0;
      forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          const t = this._tile(chunk, useColor); // può far crescere la memoria: i ptr restano validi
          store.markDirty(chunk, lx0, ly0, lx1, ly1);
          const wrote = ex.dab_tex_tile(chunk.ptr, lx0, ly0, lx1, ly1,
            stamp.ptr, sSize, lx0 + ox - ix, ly0 + oy - iy,
            t.lumPtr, useColor ? t.rgbxPtr : 0, a255, cr, cg, cb, bu);
          if (wrote) chunk.touched = true;
        }, this.clip);
      return;
    }

    const mask = stamp.mask;
    // Stessa euristica di _dab: le LUT convengono se già valide o se il dab
    // è grande (il jitter colore/opacità le invalida a ogni dab); la modalità
    // colore non le usa (colore per pixel dal tile, come _dabTexColor).
    const useLut = !useColor && ((this._lutA === a255 && this._lutColorKey === ((cr << 16) | (cg << 8) | cb)) ||
      sSize * sSize >= 4096);
    if (useLut) {
      this._ensureMaLut(a255);
      this._ensureColorLut(cr, cg, cb);
    }
    const maLut = this._maLut;
    const lutR = this._lutR, lutG = this._lutG, lutB = this._lutB;

    forEachChunkInRect(store, ix, iy, ix + sSize - 1, iy + sSize - 1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const t = this._tile(chunk, useColor);
        const lum = t.lum, rgbx = useColor ? t.rgbx : null;
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          let ti = (y2 << CHUNK_SHIFT) + lx0;
          let mi = (y2 + oy - iy) * sSize + (lx0 + ox - ix);
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4, ti++, mi++) {
            const m = mask[mi];
            if (m === 0) continue;
            const m2 = div255(m * lum[ti]);
            if (m2 === 0) continue;
            const ma = useLut ? maLut[m2] : div255(m2 * a255);
            if (ma === 0) continue;
            if (rgbx !== null) {
              const ci = ti << 2;
              if (buildup) {
                const inv = 255 - ma;
                d[di] = div255(rgbx[ci] * ma) + div255(d[di] * inv);
                d[di + 1] = div255(rgbx[ci + 1] * ma) + div255(d[di + 1] * inv);
                d[di + 2] = div255(rgbx[ci + 2] * ma) + div255(d[di + 2] * inv);
                d[di + 3] = ma + div255(d[di + 3] * inv);
              } else if (ma > d[di + 3]) {
                d[di] = div255(rgbx[ci] * ma);
                d[di + 1] = div255(rgbx[ci + 1] * ma);
                d[di + 2] = div255(rgbx[ci + 2] * ma);
                d[di + 3] = ma;
              }
            } else if (buildup) {
              const inv = 255 - ma;
              d[di] = (useLut ? lutR[ma] : div255(cr * ma)) + div255(d[di] * inv);
              d[di + 1] = (useLut ? lutG[ma] : div255(cg * ma)) + div255(d[di + 1] * inv);
              d[di + 2] = (useLut ? lutB[ma] : div255(cb * ma)) + div255(d[di + 2] * inv);
              d[di + 3] = ma + div255(d[di + 3] * inv);
            } else if (ma > d[di + 3]) {
              d[di] = useLut ? lutR[ma] : div255(cr * ma);
              d[di + 1] = useLut ? lutG[ma] : div255(cg * ma);
              d[di + 2] = useLut ? lutB[ma] : div255(cb * ma);
              d[di + 3] = ma;
            }
            wrote = true;
          }
        }
        if (wrote) chunk.touched = true;
      }, this.clip);
  }

  // ---- via continua: capsula con raggio e alpha interpolati ----
  /**
   * @param {number} x0 @param {number} y0 @param {number} r0 @param {number} a0
   * @param {number} x1 @param {number} y1 @param {number} r1 @param {number} a1
   */
  _capsule(x0, y0, r0, a0, x1, y1, r1, a1) {
    const snap = this.snap;
    if (snap.tex && snap.texLut && !snap.texMoving) {
      this._capsuleTex(x0, y0, r0, a0, x1, y1, r1, a1);
      return;
    }
    const h = snap.hardness;
    const cr = snap.colR, cg = snap.colG, cb = snap.colB;
    const store = this.store;

    const maxR = Math.max(r0, r1) + 1;
    const bx0 = Math.floor(Math.min(x0, x1) - maxR);
    const by0 = Math.floor(Math.min(y0, y1) - maxR);
    const bx1 = Math.ceil(Math.max(x0, x1) + maxR);
    const by1 = Math.ceil(Math.max(y0, y1) + maxR);

    if (this.heap) {
      const ex = this.heap.exports;
      forEachChunkInRect(store, bx0, by0, bx1, by1, true,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          store.markDirty(chunk, lx0, ly0, lx1, ly1);
          const wrote = ex.capsule(chunk.ptr, lx0, ly0, lx1, ly1, ox, oy,
            x0, y0, r0, a0, x1, y1, r1, a1, h, cr, cg, cb);
          if (wrote) chunk.touched = true;
        }, this.clip);
      return;
    }

    this._ensureColorLut(cr, cg, cb);
    const lutR = this._lutR, lutG = this._lutG, lutB = this._lutB;

    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const invLen2 = len2 > 0 ? 1 / len2 : 0;
    const dr = r1 - r0, da = a1 - a0;
    // Bound esatto per riga: dist >= distanza riga->segmento e falloff
    // monotono danno ma <= maMaxRow. Nei tratti a spacing basso i segmenti si
    // sovrappongono quasi del tutto: i pixel già saturi vengono saltati prima
    // di proiezione e sqrt senza cambiare l'output; le righe con bound 0
    // (il bbox è quadrato, la capsula no) si saltano intere.
    const aMax = Math.max(a0, a1);
    const rMax = Math.max(r0, r1);
    const yLo = Math.min(y0, y1), yHi = Math.max(y0, y1);

    forEachChunkInRect(store, bx0, by0, bx1, by1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          const py = oy + y2 + 0.5;
          const rowDist = py < yLo ? yLo - py : py > yHi ? py - yHi : 0;
          const maMaxRow = (falloff(rowDist, rMax, h) * aMax * 255 + 0.5) | 0;
          if (maMaxRow === 0) continue;
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4) {
            if (d[di + 3] >= maMaxRow) continue;
            const px = ox + x2 + 0.5;
            let t = ((px - x0) * dx + (py - y0) * dy) * invLen2;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const qx = px - (x0 + dx * t);
            const qy = py - (y0 + dy * t);
            const rT = r0 + dr * t;
            const dist2 = qx * qx + qy * qy;
            const lim = rT + 1;
            if (dist2 >= lim * lim) continue;
            const a = falloff(Math.sqrt(dist2), rT, h) * (a0 + da * t);
            if (a <= 0) continue;
            const ma = (a * 255 + 0.5) | 0;
            if (ma > d[di + 3]) {
              d[di] = lutR[ma];
              d[di + 1] = lutG[ma];
              d[di + 2] = lutB[ma];
              d[di + 3] = ma;
              wrote = true;
            }
          }
        }
        if (wrote) chunk.touched = true;
      }, this.clip);
  }

  // Capsula texturizzata: la via continua quando la grana è ancorata al
  // canvas. Il fattore per pixel non dipende dal dab che lo copre, quindi
  // commuta con l'unione wash: una catena di capsule × tile equivale ai dab
  // sovrapposti. Geometria identica a _capsule; ma = div255(maBase * f), col
  // bound per pixel raffinato dal fattore (la grana satura il documento a
  // un'alpha più bassa del bound di riga). Modalità colore: RGBX dal tile.
  /**
   * @param {number} x0 @param {number} y0 @param {number} r0 @param {number} a0
   * @param {number} x1 @param {number} y1 @param {number} r1 @param {number} a1
   */
  _capsuleTex(x0, y0, r0, a0, x1, y1, r1, a1) {
    const snap = this.snap;
    const h = snap.hardness;
    const cr = snap.colR, cg = snap.colG, cb = snap.colB;
    const useColor = snap.texColor;
    const store = this.store;
    this.lastTexDabs++; // l'HUD conta anche i segmenti texturizzati

    const maxR = Math.max(r0, r1) + 1;
    const bx0 = Math.floor(Math.min(x0, x1) - maxR);
    const by0 = Math.floor(Math.min(y0, y1) - maxR);
    const bx1 = Math.ceil(Math.max(x0, x1) + maxR);
    const by1 = Math.ceil(Math.max(y0, y1) + maxR);

    if (this.heap) {
      const ex = this.heap.exports;
      forEachChunkInRect(store, bx0, by0, bx1, by1, true,
        (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
          const t = this._tile(chunk, useColor);
          store.markDirty(chunk, lx0, ly0, lx1, ly1);
          const wrote = ex.capsule_tex(chunk.ptr, lx0, ly0, lx1, ly1, ox, oy,
            x0, y0, r0, a0, x1, y1, r1, a1, h, cr, cg, cb,
            t.lumPtr, useColor ? t.rgbxPtr : 0);
          if (wrote) chunk.touched = true;
        }, this.clip);
      return;
    }

    this._ensureColorLut(cr, cg, cb);
    const lutR = this._lutR, lutG = this._lutG, lutB = this._lutB;

    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const invLen2 = len2 > 0 ? 1 / len2 : 0;
    const dr = r1 - r0, da = a1 - a0;
    const aMax = Math.max(a0, a1);
    const rMax = Math.max(r0, r1);
    const yLo = Math.min(y0, y1), yHi = Math.max(y0, y1);

    forEachChunkInRect(store, bx0, by0, bx1, by1, true,
      (chunk, lx0, ly0, lx1, ly1, ox, oy) => {
        const t = this._tile(chunk, useColor);
        const lum = t.lum, rgbx = useColor ? t.rgbx : null;
        store.markDirty(chunk, lx0, ly0, lx1, ly1);
        const d = chunk.data;
        let wrote = false;
        for (let y2 = ly0; y2 <= ly1; y2++) {
          const py = oy + y2 + 0.5;
          const rowDist = py < yLo ? yLo - py : py > yHi ? py - yHi : 0;
          const maMaxRow = (falloff(rowDist, rMax, h) * aMax * 255 + 0.5) | 0;
          if (maMaxRow === 0) continue;
          let di = ((y2 << CHUNK_SHIFT) + lx0) << 2;
          let ti = (y2 << CHUNK_SHIFT) + lx0;
          for (let x2 = lx0; x2 <= lx1; x2++, di += 4, ti++) {
            const f = lum[ti];
            // bound esatto: ma <= div255(maMaxRow * f) (div255 è monotona)
            if (d[di + 3] >= div255(maMaxRow * f)) continue;
            const px = ox + x2 + 0.5;
            let t2 = ((px - x0) * dx + (py - y0) * dy) * invLen2;
            if (t2 < 0) t2 = 0; else if (t2 > 1) t2 = 1;
            const qx = px - (x0 + dx * t2);
            const qy = py - (y0 + dy * t2);
            const rT = r0 + dr * t2;
            const dist2 = qx * qx + qy * qy;
            const lim = rT + 1;
            if (dist2 >= lim * lim) continue;
            const a = falloff(Math.sqrt(dist2), rT, h) * (a0 + da * t2);
            if (a <= 0) continue;
            const ma = div255(((a * 255 + 0.5) | 0) * f);
            if (ma > d[di + 3]) {
              if (rgbx !== null) {
                const ci = ti << 2;
                d[di] = div255(rgbx[ci] * ma);
                d[di + 1] = div255(rgbx[ci + 1] * ma);
                d[di + 2] = div255(rgbx[ci + 2] * ma);
              } else {
                d[di] = lutR[ma];
                d[di + 1] = lutG[ma];
                d[di + 2] = lutB[ma];
              }
              d[di + 3] = ma;
              wrote = true;
            }
          }
        }
        if (wrote) chunk.touched = true;
      }, this.clip);
  }
}

// Composita UN chunk dello stroke buffer sul layer documento.
// undoCapture(key, cx, cy, beforeDataOrNull) viene chiamato PRIMA di modificare.
/**
 * @param {ChunkStore} docStore
 * @param {Chunk} sc
 * @param {Snap|null} snap
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray<ArrayBuffer>|null) => void} [undoCapture]
 * @param {import('./wasm_core.js').WasmHeap|null} [heap]
 */
export function commitChunk(docStore, sc, snap, undoCapture, heap = null) {
  const op255 = Math.round((snap ? snap.globalOpacity : 1) * 255);
  const eraser = snap ? snap.eraser : false;

  const existing = docStore.getByKey(sc.key);
  if (eraser && !existing) return; // niente da cancellare
  if (undoCapture) undoCapture(sc.key, sc.cx, sc.cy, existing ? existing.data : null);
  const doc = existing || docStore.getOrCreate(sc.cx, sc.cy);

  if (heap) {
    heap.exports.commit(doc.ptr, sc.ptr, op255, eraser ? 1 : 0);
    docStore.markDirty(doc);
    return;
  }

  const s = sc.data, d = doc.data;
  // Viste u32 per saltare in fretta i pixel vuoti (premultiplied: parola 0 =
  // pixel non toccato) e copiare in blocco quelli opachi. byteOffset esplicito:
  // il buffer sottostante può essere la memoria lineare wasm.
  const su = new Uint32Array(s.buffer, s.byteOffset, s.length >> 2);
  const du = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
  const full = op255 === 255;

  if (eraser) {
    for (let i = 0, o = 0; i < su.length; i++, o += 4) {
      if (su[i] === 0) continue;
      const sa = full ? s[o + 3] : div255(s[o + 3] * op255);
      if (sa === 0) continue;
      if (sa === 255) { du[i] = 0; continue; } // gomma piena: azzera la parola
      const inv = 255 - sa;
      d[o] = div255(d[o] * inv);
      d[o + 1] = div255(d[o + 1] * inv);
      d[o + 2] = div255(d[o + 2] * inv);
      d[o + 3] = div255(d[o + 3] * inv);
    }
  } else if (full) {
    // opacità 1: div255(x*255) = x, quindi niente moltiplicazioni sulla sorgente
    for (let i = 0, o = 0; i < su.length; i++, o += 4) {
      const v = su[i];
      if (v === 0) continue;
      const sa = s[o + 3];
      if (sa === 0) continue;
      if (sa === 255) { du[i] = v; continue; } // sorgente opaca: copia la parola
      const inv = 255 - sa;
      d[o] = s[o] + div255(d[o] * inv);
      d[o + 1] = s[o + 1] + div255(d[o + 1] * inv);
      d[o + 2] = s[o + 2] + div255(d[o + 2] * inv);
      d[o + 3] = sa + div255(d[o + 3] * inv);
    }
  } else {
    for (let i = 0, o = 0; i < su.length; i++, o += 4) {
      if (su[i] === 0) continue;
      const sa = div255(s[o + 3] * op255);
      if (sa === 0) continue;
      const inv = 255 - sa;
      d[o] = div255(s[o] * op255) + div255(d[o] * inv);
      d[o + 1] = div255(s[o + 1] * op255) + div255(d[o + 1] * inv);
      d[o + 2] = div255(s[o + 2] * op255) + div255(d[o + 2] * inv);
      d[o + 3] = sa + div255(d[o + 3] * inv);
    }
  }
  docStore.markDirty(doc);
}
