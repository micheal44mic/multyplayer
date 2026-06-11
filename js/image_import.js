// Import immagini: decodifica file, ridimensionamento entro un rettangolo e
// travaso ImageData -> ChunkStore premultiplied.

import { CHUNK, CHUNK_SHIFT } from './store.js';

/** @typedef {import('./store.js').ChunkStore} ChunkStore */

/**
 * @param {File} file
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
async function decodeImageFile(file) {
  if (!file) throw new Error('File immagine mancante.');
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error('Il file selezionato non e un\'immagine.');
  }

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // fallback sotto: alcuni browser/formati non passano da ImageBitmap.
    }
  }

  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Decodifica immagine fallita.')); };
    im.src = url;
  });
}

/**
 * Decodifica e disegna un'immagine entro maxW x maxH senza mai ingrandirla.
 * @param {File} file
 * @param {number} maxW
 * @param {number} maxH
 * @returns {Promise<{imageData: ImageData, srcW: number, srcH: number, drawW: number, drawH: number, scale: number}>}
 */
export async function imageDataFromFile(file, maxW, maxH) {
  if (maxW <= 0 || maxH <= 0) throw new Error('Canvas non valido.');

  /** @type {ImageBitmap|HTMLImageElement|null} */
  let src = null;
  try {
    src = await decodeImageFile(file);
    const srcW = /** @type {any} */ (src).width || /** @type {HTMLImageElement} */ (src).naturalWidth;
    const srcH = /** @type {any} */ (src).height || /** @type {HTMLImageElement} */ (src).naturalHeight;
    if (!srcW || !srcH) throw new Error('Immagine vuota.');

    const scale = Math.min(1, maxW / srcW, maxH / srcH);
    const drawW = Math.max(1, Math.round(srcW * scale));
    const drawH = Math.max(1, Math.round(srcH * scale));

    const cnv = document.createElement('canvas');
    cnv.width = drawW;
    cnv.height = drawH;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = scale !== 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, drawW, drawH);
    return {
      imageData: ctx.getImageData(0, 0, drawW, drawH),
      srcW, srcH, drawW, drawH, scale,
    };
  } finally {
    if (src && /** @type {any} */ (src).close) /** @type {ImageBitmap} */ (src).close();
  }
}

/**
 * Copia i pixel straight-alpha di ImageData in uno store premultiplied.
 * Crea solo chunk che contengono almeno un pixel con alpha > 0.
 * @param {ChunkStore} store
 * @param {ImageData} img
 * @param {number} worldX
 * @param {number} worldY
 * @returns {number} numero di chunk scritti
 */
export function blitImageDataToStore(store, img, worldX, worldY) {
  const src = img.data;
  const W = img.width;
  const H = img.height;
  if (!W || !H) return 0;

  const x0 = Math.round(worldX);
  const y0 = Math.round(worldY);
  const x1 = x0 + W - 1;
  const y1 = y0 + H - 1;
  let written = 0;

  for (let cy = y0 >> CHUNK_SHIFT; cy <= y1 >> CHUNK_SHIFT; cy++) {
    for (let cx = x0 >> CHUNK_SHIFT; cx <= x1 >> CHUNK_SHIFT; cx++) {
      const wx0 = Math.max(cx * CHUNK, x0);
      const wx1 = Math.min(cx * CHUNK + CHUNK - 1, x1);
      const wy0 = Math.max(cy * CHUNK, y0);
      const wy1 = Math.min(cy * CHUNK + CHUNK - 1, y1);

      let any = false;
      for (let wy = wy0; wy <= wy1 && !any; wy++) {
        let o = ((wy - y0) * W + (wx0 - x0)) * 4 + 3;
        for (let wx = wx0; wx <= wx1; wx++, o += 4) {
          if (src[o] !== 0) { any = true; break; }
        }
      }
      if (!any) continue;

      const chunk = store.getOrCreate(cx, cy);
      const dst = chunk.data;
      for (let wy = wy0; wy <= wy1; wy++) {
        let so = ((wy - y0) * W + (wx0 - x0)) * 4;
        let dofs = ((wy - cy * CHUNK) * CHUNK + (wx0 - cx * CHUNK)) * 4;
        for (let wx = wx0; wx <= wx1; wx++, so += 4, dofs += 4) {
          const a = src[so + 3];
          if (a === 0) continue;
          dst[dofs] = (src[so] * a + 127) / 255;
          dst[dofs + 1] = (src[so + 1] * a + 127) / 255;
          dst[dofs + 2] = (src[so + 2] * a + 127) / 255;
          dst[dofs + 3] = a;
        }
      }
      chunk.touched = true;
      store.markDirty(chunk,
        wx0 - cx * CHUNK, wy0 - cy * CHUNK, wx1 - cx * CHUNK, wy1 - cy * CHUNK);
      written++;
    }
  }

  return written;
}

/** @param {string} name */
export function imageLayerName(name) {
  const base = (name || 'Immagine').replace(/\.[^.]+$/, '').trim();
  return base || 'Immagine';
}
