// Compositing condiviso tra export e merge livelli.

import { CHUNK } from './store.js';
import { drawTextDocument } from './text_layer.js';
import { drawSvgLayerToCanvas } from './svg_layer.js';
import { refreshClipBases } from './layers.js';
import { C2D_MODE } from './renderer_2d.js';

/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./layers.js').Layer} Layer */

/**
 * Disegna uno stack di livelli sul context dato, in coordinate canvas-board.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Board} board
 * @param {Layer[]} layers
 * @param {{end?: number, onSvgError?: (err: unknown, layer: Layer) => void}} [options]
 */
export async function drawLayerStack(ctx, board, layers, options = {}) {
  const x0 = board.x, y0 = board.y, w = board.w, h = board.h;
  const end = Math.max(0, Math.min(options.end ?? layers.length, layers.length));

  const tmp = document.createElement('canvas');
  tmp.width = CHUNK; tmp.height = CHUNK;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(CHUNK, CHUNK);

  /** @param {CanvasRenderingContext2D} target @param {Layer} layer */
  const drawRaster = (target, layer) => {
    for (const c of layer.store.map.values()) {
      const s = c.data, d = img.data;
      let empty = true;
      for (let o = 0; o < s.length; o += 4) {
        const a = s[o + 3];
        if (a === 0) {
          d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
          continue;
        }
        empty = false;
        const inv = 255 / a;
        d[o] = Math.min(255, s[o] * inv);
        d[o + 1] = Math.min(255, s[o + 1] * inv);
        d[o + 2] = Math.min(255, s[o + 2] * inv);
        d[o + 3] = a;
      }
      if (empty) continue;
      tctx.putImageData(img, 0, 0);
      target.drawImage(tmp, c.cx * CHUNK - x0, c.cy * CHUNK - y0);
    }
  };

  refreshClipBases(layers);
  /** @type {HTMLCanvasElement|null} */
  let clipTemp = null;
  for (let i = 0; i < end; i++) {
    const layer = layers[i];
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.kind === 'raster' && layer.clip && layer.clipBase) continue;

    if (layer.kind === 'text') {
      drawTextDocument(ctx, layer.item, layer.style, x0, y0, layer.opacity);
      continue;
    }
    if (layer.kind === 'svg') {
      try {
        await drawSvgLayerToCanvas(ctx, layer, board);
      } catch (err) {
        if (options.onSvgError) options.onSvgError(err, layer);
        else throw err;
      }
      continue;
    }

    let gEnd = i + 1;
    while (gEnd < end && layers[gEnd].clip && layers[gEnd].clipBase === layer) gEnd++;
    if (gEnd > i + 1) {
      if (!clipTemp) {
        clipTemp = document.createElement('canvas');
        clipTemp.width = w; clipTemp.height = h;
      }
      const cctx = clipTemp.getContext('2d');
      cctx.globalCompositeOperation = 'source-over';
      cctx.globalAlpha = 1;
      cctx.clearRect(0, 0, w, h);
      cctx.globalAlpha = layer.opacity;
      drawRaster(cctx, layer);
      cctx.globalCompositeOperation = 'source-atop';
      for (let j = i + 1; j < gEnd; j++) {
        const child = layers[j];
        if (!child.visible || child.opacity <= 0) continue;
        cctx.globalAlpha = child.opacity;
        drawRaster(cctx, child);
      }
      cctx.globalCompositeOperation = 'source-over';
      cctx.globalAlpha = 1;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = C2D_MODE[layer.mode || 'normal'] || 'source-over';
      ctx.drawImage(clipTemp, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      i = gEnd - 1;
      continue;
    }

    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = C2D_MODE[layer.mode || 'normal'] || 'source-over';
    drawRaster(ctx, layer);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;
}

/**
 * @param {Board} board
 * @param {Layer[]} layers
 * @param {{end?: number, background?: string, willReadFrequently?: boolean, onSvgError?: (err: unknown, layer: Layer) => void}} [options]
 */
export async function renderLayerStackToCanvas(board, layers, options = {}) {
  const cnv = document.createElement('canvas');
  cnv.width = board.w; cnv.height = board.h;
  const ctx = cnv.getContext('2d', { willReadFrequently: !!options.willReadFrequently });
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, board.w, board.h);
  }
  await drawLayerStack(ctx, board, layers, options);
  return cnv;
}

/**
 * Ricava un livello sorgente normale che, disegnato source-over sul backdrop,
 * ricrea il risultato "through". I pixel sono straight-alpha ImageData.
 * @param {ImageData} backdrop
 * @param {ImageData} through
 */
export function normalSourceFromBackdrop(backdrop, through) {
  const w = through.width, h = through.height;
  const out = new ImageData(w, h);
  const b = backdrop.data, t = through.data, d = out.data;
  for (let o = 0; o < t.length; o += 4) {
    const br = b[o], bg = b[o + 1], bb = b[o + 2], ba = b[o + 3] / 255;
    const tr = t[o], tg = t[o + 1], tb = t[o + 2], ta = t[o + 3] / 255;

    if (Math.abs(tr - br) <= 1 && Math.abs(tg - bg) <= 1 &&
      Math.abs(tb - bb) <= 1 && Math.abs(t[o + 3] - b[o + 3]) <= 1) {
      continue;
    }

    let sa;
    if (ba < 0.999) sa = (ta - ba) / (1 - ba);
    else sa = 1;
    sa = Math.max(0, Math.min(1, sa));
    if (sa <= 0.0001) continue;

    const keep = 1 - sa;
    const bpR = br / 255 * ba, bpG = bg / 255 * ba, bpB = bb / 255 * ba;
    const tpR = tr / 255 * ta, tpG = tg / 255 * ta, tpB = tb / 255 * ta;
    const spR = Math.max(0, Math.min(sa, tpR - bpR * keep));
    const spG = Math.max(0, Math.min(sa, tpG - bpG * keep));
    const spB = Math.max(0, Math.min(sa, tpB - bpB * keep));

    d[o + 3] = Math.round(sa * 255);
    d[o] = Math.round(spR / sa * 255);
    d[o + 1] = Math.round(spG / sa * 255);
    d[o + 2] = Math.round(spB / sa * 255);
  }
  return out;
}
