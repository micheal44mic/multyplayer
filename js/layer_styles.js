import { CHUNK_SHIFT, contentBBox } from './store.js';
import { snapshotRect } from './fx_blur.js';

export const STYLE_BEVEL = 'bevelEmboss';

export const DEFAULT_BEVEL_EMBOSS = {
  kind: STYLE_BEVEL,
  enabled: true,
  style: 'inner',
  technique: 'smooth',
  depth: 100,
  direction: 'up',
  size: 5,
  soften: 0,
  angle: 120,
  altitude: 30,
  highlightMode: 'screen',
  highlightColor: '#ffffff',
  highlightOpacity: 75,
  shadowMode: 'multiply',
  shadowColor: '#000000',
  shadowOpacity: 75,
  glossContour: 'linear',
};

export const BEVEL_STYLE_INDEX = {
  inner: 0,
  outer: 1,
  emboss: 2,
  pillow: 3,
};

export const BEVEL_TECHNIQUE_INDEX = {
  smooth: 0,
  'chisel-hard': 1,
  'chisel-soft': 2,
};

export const CONTOUR_INDEX = {
  linear: 0,
  rounded: 1,
  cone: 2,
  'cove-deep': 3,
  'cove-shallow': 4,
  ring: 5,
  'ring-double': 6,
  sawtooth: 7,
  steps: 8,
};

export const STYLE_BLEND_INDEX = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  softlight: 4,
  darken: 5,
  lighten: 6,
  difference: 7,
  add: 8,
};

const BEVEL_STYLES = Object.keys(BEVEL_STYLE_INDEX);
const BEVEL_TECHNIQUES = Object.keys(BEVEL_TECHNIQUE_INDEX);
const CONTOURS = Object.keys(CONTOUR_INDEX);
const BLENDS = Object.keys(STYLE_BLEND_INDEX);

/** @param {number} v @param {number} min @param {number} max */
function clamp(v, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) v = min;
  return v < min ? min : v > max ? max : v;
}

/** @param {any} v @param {string[]} allowed @param {string} fallback */
function pick(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/** @param {string} hex */
export function hexRgb01(hex) {
  const s = /^#[0-9a-f]{6}$/i.test(String(hex)) ? String(hex) : '#000000';
  return [
    parseInt(s.slice(1, 3), 16) / 255,
    parseInt(s.slice(3, 5), 16) / 255,
    parseInt(s.slice(5, 7), 16) / 255,
  ];
}

/** @param {any} cfg */
export function normalizeBevel(cfg) {
  const d = DEFAULT_BEVEL_EMBOSS;
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    kind: STYLE_BEVEL,
    enabled: c.enabled !== false,
    style: pick(c.style, BEVEL_STYLES, d.style),
    technique: pick(c.technique, BEVEL_TECHNIQUES, d.technique),
    depth: clamp(c.depth ?? d.depth, 1, 1000),
    direction: c.direction === 'down' ? 'down' : 'up',
    size: clamp(c.size ?? d.size, 0, 250),
    soften: clamp(c.soften ?? d.soften, 0, 16),
    angle: clamp(c.angle ?? d.angle, 0, 360),
    altitude: clamp(c.altitude ?? d.altitude, 0, 90),
    highlightMode: pick(c.highlightMode, BLENDS, d.highlightMode),
    highlightColor: /^#[0-9a-f]{6}$/i.test(String(c.highlightColor)) ? c.highlightColor : d.highlightColor,
    highlightOpacity: clamp(c.highlightOpacity ?? d.highlightOpacity, 0, 100),
    shadowMode: pick(c.shadowMode, BLENDS, d.shadowMode),
    shadowColor: /^#[0-9a-f]{6}$/i.test(String(c.shadowColor)) ? c.shadowColor : d.shadowColor,
    shadowOpacity: clamp(c.shadowOpacity ?? d.shadowOpacity, 0, 100),
    glossContour: pick(c.glossContour, CONTOURS, d.glossContour),
  };
}

/** @param {any} styles */
export function normalizeLayerStyles(styles) {
  if (!Array.isArray(styles)) return [];
  const out = [];
  for (const s of styles) {
    if (s && s.kind === STYLE_BEVEL) out.push(normalizeBevel(s));
  }
  return out;
}

/** @param {any} styles */
export function cloneStyles(styles) {
  return normalizeLayerStyles(structuredClone(Array.isArray(styles) ? styles : []));
}

/** @param {import('./layers.js').Layer} layer */
export function activeBevel(layer) {
  const s = (layer.styles || []).find((x) => x && x.kind === STYLE_BEVEL);
  return s && s.enabled !== false ? normalizeBevel(s) : null;
}

/** @param {import('./layers.js').Layer} layer */
export function hasActiveLayerStyles(layer) {
  return !!activeBevel(layer);
}

/** @param {import('./layers.js').Layer} layer */
export function layerStyleKey(layer) {
  return JSON.stringify(normalizeLayerStyles(layer.styles || []));
}

/** @param {import('./layers.js').Layer} layer */
export function layerStyleHash(layer) {
  const s = layerStyleKey(layer);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** @param {any} cfg */
export function bevelPadding(cfg) {
  const c = normalizeBevel(cfg);
  if (c.style === 'inner') return 0;
  return Math.ceil(c.size + c.soften + 2);
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {import('./boards.js').Board|null|undefined} board
 */
export function bevelRect(layer, board = layer.clipBoard) {
  const cfg = activeBevel(layer);
  if (!cfg || !layer.store) return null;
  const bb = contentBBox(layer.store);
  if (!bb) return null;
  const pad = bevelPadding(cfg);
  let x0 = bb.x0 - pad, y0 = bb.y0 - pad, x1 = bb.x1 + pad, y1 = bb.y1 + pad;
  if (board) {
    x0 = Math.max(board.x, Math.min(bb.x0, board.x + board.w - 1) - pad);
    y0 = Math.max(board.y, Math.min(bb.y0, board.y + board.h - 1) - pad);
    x1 = Math.min(board.x + board.w - 1, Math.max(bb.x1, board.x) + pad);
    y1 = Math.min(board.y + board.h - 1, Math.max(bb.y1, board.y) + pad);
  }
  if (x1 < x0 || y1 < y0) return null;
  const x = (x0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
  const y = (y0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
  const w = (((x1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - x;
  const h = (((y1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - y;
  return {
    x, y, w, h, cfg,
    clip: board
      ? { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 }
      : { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 },
  };
}

/** @param {number} t @param {string} contour */
function contour(t, contour) {
  t = Math.max(0, Math.min(1, t));
  if (contour === 'rounded') return Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  if (contour === 'cone') return 1 - Math.abs(2 * t - 1);
  if (contour === 'cove-deep') return t * t;
  if (contour === 'cove-shallow') return Math.sqrt(t);
  if (contour === 'ring') return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  if (contour === 'ring-double') return 0.5 - 0.5 * Math.cos(t * Math.PI * 4);
  if (contour === 'sawtooth') return (t * 2) % 1;
  if (contour === 'steps') return Math.floor(t * 4) / 4;
  return t;
}

/** @param {number[]} base @param {number[]} src @param {string} mode */
function blend(base, src, mode) {
  const b = base, s = src;
  if (mode === 'multiply') return [b[0] * s[0], b[1] * s[1], b[2] * s[2]];
  if (mode === 'screen') return [1 - (1 - b[0]) * (1 - s[0]), 1 - (1 - b[1]) * (1 - s[1]), 1 - (1 - b[2]) * (1 - s[2])];
  if (mode === 'add') return [Math.min(1, b[0] + s[0]), Math.min(1, b[1] + s[1]), Math.min(1, b[2] + s[2])];
  if (mode === 'darken') return [Math.min(b[0], s[0]), Math.min(b[1], s[1]), Math.min(b[2], s[2])];
  if (mode === 'lighten') return [Math.max(b[0], s[0]), Math.max(b[1], s[1]), Math.max(b[2], s[2])];
  if (mode === 'difference') return [Math.abs(b[0] - s[0]), Math.abs(b[1] - s[1]), Math.abs(b[2] - s[2])];
  return s;
}

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** @param {Float32Array} grid @param {number} w @param {number} h */
function edt2d(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

/** @param {number} h @param {any} cfg */
function mappedHeight(h, cfg) {
  let t = 0;
  if (cfg.style === 'inner') t = Math.max(0, Math.min(1, (h - 0.5) * 2));
  else if (cfg.style === 'outer') t = Math.max(0, Math.min(1, (0.5 - h) * 2));
  else if (cfg.style === 'emboss') t = h;
  else t = Math.max(0, Math.min(1, 1 - Math.abs(h - 0.5) * 2));
  if (cfg.technique === 'smooth') {
    t = cfg.style === 'inner' || cfg.style === 'outer' ? t * (2 - t) : t * t * (3 - 2 * t);
  }
  const out = contour(t, cfg.glossContour);
  if (cfg.style === 'inner') return 0.5 + out * 0.5;
  if (cfg.style === 'outer') return 0.5 - out * 0.5;
  if (cfg.style === 'emboss') return out;
  return h >= 0.5 ? 0.5 + out * 0.5 : 0.5 - out * 0.5;
}

/**
 * @param {Uint8ClampedArray} data premultiplied RGBA, mutated in place
 * @param {number} w
 * @param {number} h
 * @param {any} config
 */
export function bevelEmbossBuffer(data, w, h, config) {
  const cfg = normalizeBevel(config);
  if (w <= 0 || h <= 0 || cfg.size <= 0) return;
  const n = w * h;
  const INF = 1e12;
  const dShape = new Float32Array(n);
  const dComp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inside = data[i * 4 + 3] > 127;
    dShape[i] = inside ? 0 : INF;
    dComp[i] = inside ? INF : 0;
  }
  edt2d(dShape, w, h);
  edt2d(dComp, w, h);

  const raw = new Float32Array(n);
  const height = new Float32Array(n);
  const size = Math.max(1, cfg.size);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const inside = a > 0.5;
    const dist = Math.sqrt(inside ? dComp[i] : dShape[i]);
    const nd = Math.max(0, Math.min(1, dist / size));
    const r = inside ? 0.5 + 0.5 * nd : 0.5 - 0.5 * nd;
    raw[i] = cfg.style === 'pillow' ? 1 - Math.abs(r - 0.5) * 2 : r;
    height[i] = mappedHeight(r, cfg);
  }

  const angle = cfg.angle * Math.PI / 180;
  const altitude = cfg.altitude * Math.PI / 180;
  const cosAlt = Math.cos(altitude);
  const sinAlt = Math.sin(altitude);
  const lx = Math.cos(angle) * cosAlt;
  const ly = Math.sin(angle) * cosAlt;
  const lz = sinAlt;
  const flat = sinAlt;
  const depth = Math.max(0.01, cfg.depth / 100) * 6;
  const dir = (cfg.direction === 'down' ? -1 : 1) * (cfg.style === 'pillow' ? -1 : 1);
  const hlColor = hexRgb01(cfg.highlightColor);
  const shColor = hexRgb01(cfg.shadowColor);
  const hlOp = cfg.highlightOpacity / 100;
  const shOp = cfg.shadowOpacity / 100;

  const at = (x, y) => height[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const a = data[o + 3] / 255;
      const dx = (at(x + 1, y) - at(x - 1, y)) * depth * dir;
      const dy = (at(x, y + 1) - at(x, y - 1)) * depth * dir;
      let nx = -dx, ny = -dy, nz = 1;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (cfg.style === 'pillow') { nx = -nx; ny = -ny; }
      const ndotl = nx * lx + ny * ly + nz * lz;
      let t = 0.5;
      if (ndotl > flat) t = 0.5 + 0.5 * Math.max(0, Math.min(1, (ndotl - flat) / (1 - flat + 0.0001)));
      else t = 0.5 - 0.5 * Math.max(0, Math.min(1, (flat - ndotl) / (flat + 1 + 0.0001)));
      const mt = contour(t, cfg.glossContour);
      const hl = Math.max(0, (mt - 0.5) * 2) * hlOp;
      const sh = Math.max(0, (0.5 - mt) * 2) * shOp;
      if (hl <= 0 && sh <= 0 && a <= 0) continue;

      const base = a > 0 ? [data[o] / 255 / a, data[o + 1] / 255 / a, data[o + 2] / 255 / a] : [0, 0, 0];
      const hlB = blend(base, hlColor, cfg.highlightMode);
      const shB = blend(base, shColor, cfg.shadowMode);
      const edge = Math.max(0, Math.min(1, a / 0.2));
      const innerMask = a * edge;
      const outerMask = Math.max(0, Math.min(1, raw[i] - a));
      let color = base.slice();
      let outA = a;
      if (cfg.style === 'inner' || cfg.style === 'pillow') {
        for (let c = 0; c < 3; c++) color[c] += (hlB[c] - color[c]) * hl * innerMask;
        for (let c = 0; c < 3; c++) color[c] += (shB[c] - color[c]) * sh * innerMask;
      } else {
        const inner = color.slice();
        for (let c = 0; c < 3; c++) inner[c] += (hlB[c] - inner[c]) * hl * innerMask;
        for (let c = 0; c < 3; c++) inner[c] += (shB[c] - inner[c]) * sh * innerMask;
        const oh = hl * outerMask, os = sh * outerMask;
        const oa = Math.min(1, oh + os);
        let outer = [0, 0, 0];
        if (oa > 0) {
          const k = oh / oa;
          outer = [
            shColor[0] + (hlColor[0] - shColor[0]) * k,
            shColor[1] + (hlColor[1] - shColor[1]) * k,
            shColor[2] + (hlColor[2] - shColor[2]) * k,
          ];
        }
        outA = Math.max(0, Math.min(1, a + oa));
        color = outA > 0 ? [
          (inner[0] * a + outer[0] * oa) / outA,
          (inner[1] * a + outer[1] * oa) / outA,
          (inner[2] * a + outer[2] * oa) / outA,
        ] : [0, 0, 0];
      }
      const A = Math.round(outA * 255);
      data[o + 3] = A;
      data[o] = Math.min(A, Math.round(color[0] * A));
      data[o + 1] = Math.min(A, Math.round(color[1] * A));
      data[o + 2] = Math.min(A, Math.round(color[2] * A));
    }
  }
}

/** @param {HTMLCanvasElement} cnv @param {Uint8ClampedArray} src @param {number} w @param {number} h */
function putPremul(cnv, src, w, h) {
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const dst = img.data;
  for (let o = 0; o < src.length; o += 4) {
    const a = src[o + 3];
    if (a === 0) {
      dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0;
    } else {
      const inv = 255 / a;
      dst[o] = Math.min(255, src[o] * inv);
      dst[o + 1] = Math.min(255, src[o + 1] * inv);
      dst[o + 2] = Math.min(255, src[o + 2] * inv);
      dst[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {import('./boards.js').Board|null|undefined} board
 */
export function renderStyledRasterToCanvas(layer, board = layer.clipBoard) {
  const rect = bevelRect(layer, board);
  if (!rect || !layer.store) return null;
  const data = snapshotRect(layer.store, rect.x, rect.y, rect.w, rect.h);
  bevelEmbossBuffer(data, rect.w, rect.h, rect.cfg);
  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  putPremul(canvas, data, rect.w, rect.h);
  return { canvas, x: rect.x, y: rect.y, w: rect.w, h: rect.h, clip: rect.clip };
}
