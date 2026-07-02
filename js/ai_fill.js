import { renderLayerStackToCanvas } from './layer_composite.js';

const MAX_AI_SIDE = 1024;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

async function canvasToBase64Png(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('PNG export failed.')), 'image/png');
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBlob(base64, mimeType) {
  const clean = String(base64 || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'image/png' });
}

async function decodeImage(base64, mimeType) {
  const blob = base64ToBlob(base64, mimeType);
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Fall through to HTMLImageElement below.
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('AI image decode failed.')); };
    img.src = url;
  });
}

function cropSelectionMask(sel, crop) {
  const out = new Uint8Array(crop.w * crop.h);
  const src = sel.mask;
  for (let y = 0; y < crop.h; y++) {
    const sy = crop.y + y;
    const srcRow = sy * sel.bw + crop.x;
    const dstRow = y * crop.w;
    for (let x = 0; x < crop.w; x++) out[dstRow + x] = src[srcRow + x] ? 255 : 0;
  }
  return out;
}

function makeScaledMaskCanvas(maskCrop, crop, sendW, sendH) {
  const cnv = document.createElement('canvas');
  cnv.width = sendW;
  cnv.height = sendH;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(sendW, sendH);
  const d = img.data;
  for (let y = 0; y < sendH; y++) {
    const sy = clamp(Math.floor((y + 0.5) * crop.h / sendH), 0, crop.h - 1);
    for (let x = 0; x < sendW; x++) {
      const sx = clamp(Math.floor((x + 0.5) * crop.w / sendW), 0, crop.w - 1);
      const m = maskCrop[sy * crop.w + sx] ? 255 : 0;
      const o = (y * sendW + x) * 4;
      d[o] = m;
      d[o + 1] = m;
      d[o + 2] = m;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cnv;
}

export async function prepareAiFillPayload(app, prompt, model = '') {
  const board = app.boards.active;
  const sel = app.selection;
  if (!board) throw new Error('Nessun canvas attivo.');
  if (!sel.active || !sel.bounds || sel.boardId !== board.id) {
    throw new Error('Seleziona prima un area sul canvas attivo.');
  }

  const b = sel.bounds;
  const selW = b.x1 - b.x0 + 1;
  const selH = b.y1 - b.y0 + 1;
  const pad = Math.min(128, Math.max(32, Math.round(Math.max(selW, selH) * 0.12)));
  const x0 = clamp(b.x0 - pad, 0, board.w - 1);
  const y0 = clamp(b.y0 - pad, 0, board.h - 1);
  const x1 = clamp(b.x1 + pad, 0, board.w - 1);
  const y1 = clamp(b.y1 + pad, 0, board.h - 1);
  const crop = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const scale = Math.min(1, MAX_AI_SIDE / Math.max(crop.w, crop.h));
  const sendW = Math.max(8, Math.round(crop.w * scale));
  const sendH = Math.max(8, Math.round(crop.h * scale));

  const boardCanvas = await renderLayerStackToCanvas(board, board.mgr.layers, {
    background: '#ffffff',
    willReadFrequently: false,
  });

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = sendW;
  cropCanvas.height = sendH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.imageSmoothingEnabled = scale !== 1;
  cropCtx.imageSmoothingQuality = 'high';
  cropCtx.drawImage(boardCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, sendW, sendH);

  const maskCrop = cropSelectionMask(sel, crop);
  const maskCanvas = makeScaledMaskCanvas(maskCrop, crop, sendW, sendH);

  return {
    crop,
    maskCrop,
    request: {
      prompt,
      imageBase64: await canvasToBase64Png(cropCanvas),
      maskBase64: await canvasToBase64Png(maskCanvas),
      width: sendW,
      height: sendH,
      model,
    },
  };
}

export async function requestAiFill(payload) {
  const res = await fetch('/api/ai/fill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload.request),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI generation failed.');
  if (!data.imageBase64) throw new Error('AI generation returned no image.');
  return data;
}

export async function aiResultToImageData(result, payload) {
  const src = await decodeImage(result.imageBase64, result.mimeType);
  try {
    const cnv = document.createElement('canvas');
    cnv.width = payload.crop.w;
    cnv.height = payload.crop.h;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cnv.width, cnv.height);
    const img = ctx.getImageData(0, 0, cnv.width, cnv.height);
    const d = img.data;
    const mask = payload.maskCrop;
    for (let i = 0, o = 0; i < mask.length; i++, o += 4) {
      if (mask[i]) continue;
      d[o] = 0;
      d[o + 1] = 0;
      d[o + 2] = 0;
      d[o + 3] = 0;
    }
    return img;
  } finally {
    if (src && src.close) src.close();
  }
}

export function aiLayerName(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  return text ? `AI - ${text.slice(0, 36)}` : 'AI fill';
}
