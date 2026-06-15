// TEXTURE DEL PENNELLO — luminanza + RGB con catena mip, CPU.
// L'immagine importata resta alla sua dimensione nativa e diventa due griglie:
// luminanza 0..255 (alpha-aware: i pixel trasparenti tendono al bianco =
// nessuna modulazione) per la grana, e RGB per la modalità "colori della
// texture". Mipmap a box filter: il rasterizer campiona bilineare sul livello
// adatto al passo, quindi la texture resta antialiasata a qualunque scala.
// Tutto qui è deterministico (seed fisso per la grana di default): i bench
// differenziali JS/wasm possono confrontare i checksum.

import { clamp, mulberry32 } from './util.js';

/**
 * @typedef {Object} BrushTexture
 * @property {string} name
 * @property {number} w larghezza del livello 0
 * @property {number} h
 * @property {Uint8Array[]} mips luminanza per livello (0 = piena risoluzione)
 * @property {Uint8Array[]} rgbMips RGB intrecciato (3 byte/px) per livello
 * @property {number[]} mw larghezze dei livelli
 * @property {number[]} mh altezze dei livelli
 */

/**
 * Costruisce la texture da luminanza + RGB di livello 0.
 * @param {string} name @param {number} w @param {number} h
 * @param {Uint8Array} lum @param {Uint8Array} rgb 3 byte per pixel
 * @returns {BrushTexture}
 */
export function makeBrushTexture(name, w, h, lum, rgb) {
  const mips = [lum], rgbMips = [rgb];
  const mw = [w], mh = [h];
  let cw = w, ch = h, cur = lum, curRgb = rgb;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const next = new Uint8Array(nw * nh);
    const nextRgb = new Uint8Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(ch - 1, y * 2), y1 = Math.min(ch - 1, y * 2 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(cw - 1, x * 2), x1 = Math.min(cw - 1, x * 2 + 1);
        const i00 = y0 * cw + x0, i01 = y0 * cw + x1;
        const i10 = y1 * cw + x0, i11 = y1 * cw + x1;
        const o = y * nw + x;
        next[o] = (cur[i00] + cur[i01] + cur[i10] + cur[i11] + 2) >> 2;
        for (let c = 0; c < 3; c++) {
          nextRgb[o * 3 + c] = (curRgb[i00 * 3 + c] + curRgb[i01 * 3 + c] +
            curRgb[i10 * 3 + c] + curRgb[i11 * 3 + c] + 2) >> 2;
        }
      }
    }
    mips.push(next); rgbMips.push(nextRgb); mw.push(nw); mh.push(nh);
    cur = next; curRgb = nextRgb; cw = nw; ch = nh;
  }
  return { name, w, h, mips, rgbMips, mw, mh };
}

/**
 * Da ImageData: luminanza Rec.601 e RGB, entrambi pesati con l'alpha
 * (trasparente -> bianco = nessuna modulazione, nessun colore).
 * @param {string} name @param {ImageData} img
 * @returns {BrushTexture}
 */
export function textureFromImageData(name, img) {
  const { width: w, height: h, data: d } = img;
  const lum = new Uint8Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, o = 0; i < lum.length; i++, o += 4) {
    const a = d[o + 3], inv = 255 - a;
    const r = ((d[o] * a + 127) / 255 | 0) + inv;
    const g = ((d[o + 1] * a + 127) / 255 | 0) + inv;
    const b = ((d[o + 2] * a + 127) / 255 | 0) + inv;
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return makeBrushTexture(name, w, h, lum, rgb);
}

/**
 * Importa un file immagine alla sua dimensione nativa (nessun riscalo).
 * Lancia se non decodificabile.
 * @param {File} file
 * @returns {Promise<BrushTexture>}
 */
export async function textureFromFile(file) {
  /** @type {ImageBitmap|HTMLImageElement} */
  let src;
  try {
    src = await createImageBitmap(file);
  } catch {
    // fallback per i formati/browser senza createImageBitmap(file)
    src = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decoding failed')); };
      im.src = url;
    });
  }
  const w = /** @type {any} */ (src).width || /** @type {any} */ (src).naturalWidth;
  const h = /** @type {any} */ (src).height || /** @type {any} */ (src).naturalHeight;
  if (!w || !h) throw new Error('empty image');
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  if (/** @type {any} */ (src).close) /** @type {any} */ (src).close();
  return textureFromImageData(file.name.replace(/\.[^.]+$/, ''), ctx.getImageData(0, 0, w, h));
}

// Grana carta procedurale 256x256: fibre morbide, variazione larga e pori
// attenuati. Seed fisso: identica a ogni avvio, benchabile.
/** @returns {BrushTexture} */
export function defaultGrainTexture() {
  const size = 256;
  const rng = mulberry32(0xc0ffee);
  /** @param {number} x @param {number} y */
  const hash = (x, y) => {
    const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  /** @param {number} x @param {number} y */
  const vnoise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a + (a - b + d - c) * ux) * uy;
  };
  const lum = new Uint8Array(size * size);
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const fiberX = vnoise(x / 34, y / 5.5) - 0.5;
      const fiberY = vnoise((x + y * 0.35) / 8, (y - x * 0.18) / 30) - 0.5;
      const cloud = vnoise(x / 42 + 19.7, y / 42 - 8.1) - 0.5;
      const poreRaw = Math.max(0, vnoise(x / 7.5 - 3.2, y / 7.5 + 11.6) - 0.68) / 0.32;
      const pore = poreRaw * poreRaw;
      const micro = (rng() + rng() - 1) * 4;
      const v = Math.round(clamp(226 + fiberX * 24 + fiberY * 12 + cloud * 18 + micro - pore * 34, 118, 250));
      lum[i] = v;
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
    }
  }
  return makeBrushTexture('Paper Grain', size, size, lum, rgb);
}

/**
 * LUT luminanza -> fattore 0..255 applicato alla maschera (255 = intatta).
 * Stessa catena del riferimento mvp4: contrasto attorno al grigio medio,
 * inversione, pavimento minimo, poi la profondità dosa l'effetto.
 * @param {number} depth 0..1 @param {number} contrast >= 0
 * @param {number} floor 0..1 @param {boolean} invert
 * @returns {Uint8Array}
 */
export function buildTextureLut(depth, contrast, floor, invert) {
  const lut = new Uint8Array(256);
  const d = clamp(depth, 0, 1);
  const c = Math.max(0, contrast);
  const f = clamp(floor, 0, 1);
  for (let i = 0; i < 256; i++) {
    let m = clamp((i / 255 - 0.5) * c + 0.5, 0, 1);
    if (invert) m = 1 - m;
    const limited = f + (1 - f) * m;
    lut[i] = Math.round((1 - d + limited * d) * 255);
  }
  return lut;
}

/**
 * LUT canale colore -> canale con il contrasto della texture applicato
 * (modalità "colori della texture", come mvp4: solo contrasto, niente
 * inversione/profondità che riguardano l'alpha).
 * @param {number} contrast >= 0
 * @returns {Uint8Array}
 */
export function buildTextureColorLut(contrast) {
  const lut = new Uint8Array(256);
  const c = Math.max(0, contrast);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(clamp((i / 255 - 0.5) * c + 0.5, 0, 1) * 255);
  }
  return lut;
}
