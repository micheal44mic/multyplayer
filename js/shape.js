// SHAPE DEL PENNELLO — maschera alpha con catena mip, CPU.
// L'immagine importata viene cotta in un quadrato (lato max 1024, padding
// trasparente, proporzioni conservate) e diventa una griglia alpha 0..255:
// il quadrato mappa 1:1 sul riquadro dello stamp, quindi rotondità e angolo
// del pennello continuano a funzionare (schiacciano/ruotano il riquadro).
// Riconoscimento del canale: se l'immagine ha trasparenza la shape È l'alpha
// (il colore non conta); se è tutta opaca vale la convenzione Procreate,
// luminanza = pienezza (bianco = pieno, nero = vuoto) — l'inversione è un
// flag del pennello (brush.shapeInvert), applicata alla generazione dello
// stamp, non qui: una sola catena mip per entrambe le polarità.
// Mipmap a box filter: lo stamp campiona bilineare sul livello adatto al
// passo, così la shape resta antialiasata anche a diametri piccoli.

/**
 * @typedef {Object} BrushShape
 * @property {string} name
 * @property {number} w lato del livello 0 (quadrato)
 * @property {number} h
 * @property {Uint8Array[]} mips alpha per livello (0 = piena risoluzione)
 * @property {number[]} mw larghezze dei livelli
 * @property {number[]} mh altezze dei livelli
 */

export const SHAPE_MAX = 1024; // lato massimo del quadrato cotto

/**
 * Costruisce la shape dall'alpha di livello 0.
 * @param {string} name @param {number} w @param {number} h @param {Uint8Array} alpha
 * @returns {BrushShape}
 */
export function makeBrushShape(name, w, h, alpha) {
  const mips = [alpha];
  const mw = [w], mh = [h];
  let cw = w, ch = h, cur = alpha;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const next = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(ch - 1, y * 2), y1 = Math.min(ch - 1, y * 2 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(cw - 1, x * 2), x1 = Math.min(cw - 1, x * 2 + 1);
        next[y * nw + x] = (cur[y0 * cw + x0] + cur[y0 * cw + x1] +
          cur[y1 * cw + x0] + cur[y1 * cw + x1] + 2) >> 2;
      }
    }
    mips.push(next); mw.push(nw); mh.push(nh);
    cur = next; cw = nw; ch = nh;
  }
  return { name, w, h, mips, mw, mh };
}

/**
 * Da ImageData già quadrata (la cottura la fa shapeFromFile). rect: zona
 * davvero coperta dall'immagine — l'alpha si cerca SOLO lì, il padding
 * trasparente della cottura non deve far scattare il ramo alpha da solo.
 * @param {string} name @param {ImageData} img
 * @param {{x: number, y: number, w: number, h: number}} [rect]
 * @returns {BrushShape}
 */
export function shapeFromImageData(name, img, rect) {
  const { width: w, height: h, data: d } = img;
  const rx = rect ? rect.x : 0, ry = rect ? rect.y : 0;
  const rw = rect ? rect.w : w, rh = rect ? rect.h : h;
  let hasAlpha = false;
  for (let y = ry; y < ry + rh && !hasAlpha; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if (d[(y * w + x) * 4 + 3] < 250) { hasAlpha = true; break; }
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < alpha.length; i++, o += 4) {
    const a = d[o + 3];
    if (hasAlpha) {
      alpha[i] = a;
    } else if (a > 0) {
      // opaca: luminanza Rec.601, bianco = pieno (il padding resta 0)
      alpha[i] = Math.round(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]);
    }
  }
  return makeBrushShape(name, w, h, alpha);
}

/**
 * Importa un file immagine come shape: cottura in quadrato (lato
 * min(SHAPE_MAX, lato maggiore), immagine centrata, proporzioni conservate).
 * Lancia se non decodificabile.
 * @param {File} file
 * @returns {Promise<BrushShape>}
 */
export async function shapeFromFile(file) {
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
  const side = Math.max(16, Math.min(SHAPE_MAX, Math.max(w, h)));
  const k = side / Math.max(w, h);
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
  const dx = (side - dw) >> 1, dy = (side - dh) >> 1;
  const cnv = document.createElement('canvas');
  cnv.width = side; cnv.height = side;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, dx, dy, dw, dh);
  if (/** @type {any} */ (src).close) /** @type {any} */ (src).close();
  return shapeFromImageData(file.name.replace(/\.[^.]+$/, ''),
    ctx.getImageData(0, 0, side, side), { x: dx, y: dy, w: dw, h: dh });
}
