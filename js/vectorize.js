import { CHUNK, contentBBox } from './store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WASM_URL = new URL('../vendor/vtracer/vtracer_webapp_bg.wasm', import.meta.url);
const MAX_TRACE_SIDE = 1536;
const SAMPLE_LIMIT = 48000;
const KMEANS_ITERS = 7;
const DEBUG_LIMIT = 160;
let vtracerReady = null;

/** @typedef {'balanced'|'smooth'|'smoothPlus'|'detailed'} VectorizePreset */
/** @typedef {{mode: 'bw'|'color', colors?: number, preset?: VectorizePreset, traceScale?: number, preBlur?: number, hierarchical?: 'stacked'|'cutout'}} VectorizeOptions */
/** @typedef {{palette: number[][], dropColors: number[][], paintNoneColor?: number[]}} TracePalette */

const TRACE_PRESETS = {
  balanced: {
    cornerDeg: 60, length: 4, iterations: 10, spliceDeg: 45,
    colorSpeckle: 16, bwSpeckle: 4, layerDifference: 16, pathPrecision: 2,
  },
  smooth: {
    cornerDeg: 75, length: 2, iterations: 16, spliceDeg: 60,
    colorSpeckle: 8, bwSpeckle: 3, layerDifference: 12, pathPrecision: 2,
  },
  smoothPlus: {
    cornerDeg: 82, length: 1.5, iterations: 20, spliceDeg: 68,
    colorSpeckle: 6, bwSpeckle: 2, layerDifference: 10, pathPrecision: 2,
  },
  detailed: {
    cornerDeg: 88, length: 1, iterations: 24, spliceDeg: 75,
    colorSpeckle: 4, bwSpeckle: 2, layerDifference: 8, pathPrecision: 3,
  },
};

function vectorizeDebugEnabled() {
  try {
    const q = new URLSearchParams(window.location.search || '');
    return q.has('debugVectorize') || localStorage.getItem('fable-paint.vectorizeDebug') === '1';
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {number} [depth] */
function cleanDebugValue(value, depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) {
    const out = value.slice(0, 32).map((v) => cleanDebugValue(v, depth + 1));
    if (value.length > 32) out.push(`... ${value.length - 32} more`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (n++ >= 48) { out.__more = true; break; }
      out[k] = cleanDebugValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * @param {string} stage
 * @param {Record<string, unknown>} [data]
 */
export function vectorizeDebug(stage, data = {}) {
  try {
    const entry = { t: new Date().toISOString(), stage, data: cleanDebugValue(data) };
    const w = /** @type {any} */ (window);
    if (!Array.isArray(w.__fpVectorizeDebug)) w.__fpVectorizeDebug = [];
    w.__fpVectorizeDebug.push(entry);
    if (w.__fpVectorizeDebug.length > DEBUG_LIMIT) w.__fpVectorizeDebug.splice(0, w.__fpVectorizeDebug.length - DEBUG_LIMIT);
    if (vectorizeDebugEnabled()) {
      let el = document.getElementById('fp-vectorize-debug');
      if (!el) {
        el = document.createElement('script');
        el.id = 'fp-vectorize-debug';
        el.setAttribute('type', 'application/json');
        el.setAttribute('hidden', '');
        document.documentElement.appendChild(el);
      }
      el.textContent = JSON.stringify(w.__fpVectorizeDebug);
      console.log('[vectorize]', stage, entry.data);
    }
  } catch {
    /* Debug must never affect vectorization. */
  }
}

async function loadVTracer() {
  if (vtracerReady) return vtracerReady;
  vtracerReady = (async () => {
    const vtracer = await import('../vendor/vtracer/vtracer_webapp_bg.js');
    const imports = { './vtracer_webapp_bg.js': vtracer };
    let instance;
    if (WebAssembly.instantiateStreaming) {
      try {
        instance = (await WebAssembly.instantiateStreaming(fetch(WASM_URL), imports)).instance;
      } catch {
        // Dev servers often serve wasm as octet-stream; the ArrayBuffer path is tolerant.
      }
    }
    if (!instance) {
      const bytes = await (await fetch(WASM_URL)).arrayBuffer();
      instance = (await WebAssembly.instantiate(bytes, imports)).instance;
    }
    vtracer.__wbg_set_wasm(instance.exports);
    instance.exports.__wbindgen_start();
    return vtracer;
  })();
  return vtracerReady;
}

/** @param {number} deg */
function deg2rad(deg) {
  return deg / 180 * Math.PI;
}

/** @param {number} v */
function byte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** @param {number[]} c */
function hexColor(c) {
  return '#' + c.slice(0, 3).map((v) => byte(v).toString(16).padStart(2, '0')).join('');
}

/** @param {string} raw */
function parseColor(raw) {
  const value = (raw || '').trim().toLowerCase();
  if (!value || value === 'none' || value === 'currentcolor') return null;
  const named = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    cyan: [0, 255, 255],
    aqua: [0, 255, 255],
    magenta: [255, 0, 255],
    fuchsia: [255, 0, 255],
  }[value];
  if (named) return named;
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (m) {
    const h = m[1].length === 3
      ? m[1].split('').map((ch) => ch + ch).join('')
      : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([.\d]+)(?:\s*,\s*|\s+)([.\d]+)(?:\s*,\s*|\s+)([.\d]+)/i.exec(value);
  if (m) return [byte(Number(m[1])), byte(Number(m[2])), byte(Number(m[3]))];
  return null;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {import('./boards.js').Board} board
 */
function clippedContentBox(layer, board) {
  if (!layer.store) return null;
  const b = contentBBox(layer.store);
  if (!b) return null;
  const x0 = Math.max(board.x, b.x0);
  const y0 = Math.max(board.y, b.y0);
  const x1 = Math.min(board.x + board.w - 1, b.x1);
  const y1 = Math.min(board.y + board.h - 1, b.y1);
  return x1 >= x0 && y1 >= y0 ? { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {{x0:number,y0:number,x1:number,y1:number,w:number,h:number}} box
 */
function rasterToImageData(layer, box) {
  const img = new ImageData(box.w, box.h);
  const dst = img.data;
  for (const c of layer.store.map.values()) {
    const ox = c.cx * CHUNK;
    const oy = c.cy * CHUNK;
    const wx0 = Math.max(ox, box.x0);
    const wy0 = Math.max(oy, box.y0);
    const wx1 = Math.min(ox + CHUNK - 1, box.x1);
    const wy1 = Math.min(oy + CHUNK - 1, box.y1);
    if (wx0 > wx1 || wy0 > wy1) continue;
    const src = c.data;
    for (let wy = wy0; wy <= wy1; wy++) {
      let so = ((wy - oy) * CHUNK + (wx0 - ox)) * 4;
      let dofs = ((wy - box.y0) * box.w + (wx0 - box.x0)) * 4;
      for (let wx = wx0; wx <= wx1; wx++, so += 4, dofs += 4) {
        const a = src[so + 3];
        if (a === 0) continue;
        const inv = 255 / a;
        dst[dofs] = byte(src[so] * inv);
        dst[dofs + 1] = byte(src[so + 1] * inv);
        dst[dofs + 2] = byte(src[so + 2] * inv);
        dst[dofs + 3] = a;
      }
    }
  }
  return img;
}

/** @param {ImageData} img @param {VectorizeOptions} [options] */
function imageDataToTraceCanvas(img, options = { mode: 'color' }) {
  const source = document.createElement('canvas');
  source.width = img.width;
  source.height = img.height;
  source.getContext('2d', { willReadFrequently: true }).putImageData(img, 0, 0);

  const requested = Math.max(1, Math.min(4, Number(options.traceScale) || 1));
  const scale = Math.min(requested, MAX_TRACE_SIDE / Math.max(img.width, img.height));
  if (Math.abs(scale - 1) < 0.001) return source;

  const cnv = document.createElement('canvas');
  cnv.width = Math.max(1, Math.round(img.width * scale));
  cnv.height = Math.max(1, Math.round(img.height * scale));
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const blur = Math.max(0, Math.min(4, Number(options.preBlur) || 0));
  if (blur > 0 && 'filter' in ctx) ctx.filter = `blur(${Math.round(blur * scale * 100) / 100}px)`;
  ctx.drawImage(source, 0, 0, cnv.width, cnv.height);
  if (blur > 0 && 'filter' in ctx) ctx.filter = 'none';
  return cnv;
}

/** @param {ImageData} img */
function hasTransparentBorder(img) {
  const d = img.data;
  const w = img.width, h = img.height;
  if (w <= 0 || h <= 0) return false;
  let total = 0, transparent = 0;
  /** @param {number} x @param {number} y */
  const sample = (x, y) => {
    total++;
    if (d[(y * w + x) * 4 + 3] < 8) transparent++;
  };
  for (let x = 0; x < w; x++) {
    sample(x, 0);
    if (h > 1) sample(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    sample(0, y);
    if (w > 1) sample(w - 1, y);
  }
  return total > 0 && transparent / total > 0.5;
}

/** @param {ImageData} img @param {VectorizeOptions} options */
function effectiveVectorizeOptions(img, options) {
  if (options.mode !== 'color') return options;
  return {
    ...options,
    traceScale: options.traceScale || 2,
    preBlur: options.preBlur ?? 0.7,
    hierarchical: options.hierarchical || (hasTransparentBorder(img) ? 'cutout' : 'stacked'),
  };
}

/** @param {ImageData} img */
function applyBlackWhite(img) {
  const d = img.data;
  for (let o = 0; o < d.length; o += 4) {
    if (d[o + 3] < 8) {
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255;
      continue;
    }
    const lum = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    if (lum < 168) {
      d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 255;
    } else {
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255;
    }
  }
}

/** @param {number[]} c */
function lum(c) {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/** @param {number[]} a @param {number[]} b */
function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * @param {number[][]} centers
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
function nearestCenter(centers, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i];
    const dr = r - c[0], dg = g - c[1], db = b - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * @param {number[][]} palette
 * @param {number[]} color
 */
function nearestPaletteColor(palette, color) {
  return palette[nearestCenter(palette, color[0], color[1], color[2])];
}

/** @param {number[][]} palette */
function uniquePalette(palette) {
  const seen = new Set();
  const out = [];
  for (const c of palette) {
    const key = hexColor(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([byte(c[0]), byte(c[1]), byte(c[2])]);
  }
  return out;
}

/**
 * @param {ImageData} img
 * @param {number} colorCount
 * @returns {number[][]}
 */
function quantizeColors(img, colorCount) {
  const k = Math.max(2, Math.min(32, Math.round(colorCount || 8)));
  const d = img.data;
  const samples = [];
  const stride = Math.max(1, Math.ceil((d.length / 4) / SAMPLE_LIMIT));
  for (let i = 0, px = 0; i < d.length; i += 4, px++) {
    if (d[i + 3] < 8) {
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
      continue;
    }
    d[i + 3] = 255;
    if (px % stride === 0) samples.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (samples.length === 0) return [[255, 255, 255]];
  samples.sort((a, b) => lum(a) - lum(b));
  /** @type {number[][]} */
  const centers = [];
  for (let i = 0; i < k; i++) {
    centers.push(samples[Math.min(samples.length - 1, Math.floor((i + 0.5) * samples.length / k))].slice());
  }

  for (let iter = 0; iter < KMEANS_ITERS; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      const idx = nearestCenter(centers, s[0], s[1], s[2]);
      sums[idx][0] += s[0]; sums[idx][1] += s[1]; sums[idx][2] += s[2]; sums[idx][3]++;
    }
    for (let i = 0; i < centers.length; i++) {
      if (!sums[i][3]) continue;
      centers[i][0] = sums[i][0] / sums[i][3];
      centers[i][1] = sums[i][1] / sums[i][3];
      centers[i][2] = sums[i][2] / sums[i][3];
    }
  }

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const c = centers[nearestCenter(centers, d[i], d[i + 1], d[i + 2])];
    d[i] = byte(c[0]);
    d[i + 1] = byte(c[1]);
    d[i + 2] = byte(c[2]);
    d[i + 3] = 255;
  }
  return uniquePalette(centers);
}

/** @param {number[][]} avoid */
function pickBackgroundColor(avoid) {
  const candidates = [
    [255, 0, 255], [0, 255, 255], [255, 255, 0],
    [0, 255, 0], [255, 0, 0], [0, 0, 255],
    [255, 255, 255], [0, 0, 0],
  ];
  const used = new Set(avoid.map(hexColor));
  return candidates.find((c) => !used.has(hexColor(c))) || [255, 0, 255];
}

/**
 * @param {ImageData} img
 * @param {number[]} bg
 */
function fillTransparentWith(img, bg) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] >= 8) continue;
    d[i] = bg[0];
    d[i + 1] = bg[1];
    d[i + 2] = bg[2];
    d[i + 3] = 255;
  }
}

/** @param {ImageData} img */
function detectBorderBackground(img) {
  const d = img.data;
  const w = img.width, h = img.height;
  if (w <= 0 || h <= 0) return null;
  const ring = Math.max(1, Math.min(8, Math.floor(Math.min(w, h) * 0.025)));
  const bins = new Map();
  let sampled = 0;
  /** @param {number} x @param {number} y */
  const sample = (x, y) => {
    const o = (y * w + x) * 4;
    if (d[o + 3] < 8) return;
    const key = `${d[o] >> 4},${d[o + 1] >> 4},${d[o + 2] >> 4}`;
    let b = bins.get(key);
    if (!b) {
      b = { count: 0, r: 0, g: 0, b: 0 };
      bins.set(key, b);
    }
    b.count++;
    b.r += d[o];
    b.g += d[o + 1];
    b.b += d[o + 2];
    sampled++;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ring; x++) sample(x, y);
    for (let x = Math.max(ring, w - ring); x < w; x++) sample(x, y);
  }
  for (let y = 0; y < ring; y++) {
    for (let x = ring; x < Math.max(ring, w - ring); x++) sample(x, y);
  }
  for (let y = Math.max(ring, h - ring); y < h; y++) {
    for (let x = ring; x < Math.max(ring, w - ring); x++) sample(x, y);
  }
  if (!sampled) return null;
  let best = null;
  for (const b of bins.values()) {
    if (!best || b.count > best.count) best = b;
  }
  if (!best) return null;
  const ratio = best.count / sampled;
  if (ratio < 0.35) return null;
  return {
    color: [byte(best.r / best.count), byte(best.g / best.count), byte(best.b / best.count)],
    ratio,
    sampled,
    ring,
  };
}

/**
 * Toglie lo sfondo collegato ai bordi prima della quantizzazione colore.
 * Cosi un JPG/logo bianco non diventa una campitura vettoriale enorme,
 * ma i bianchi interni chiusi dal contorno restano editabili.
 * @param {ImageData} img
 */
function removeConnectedBorderBackground(img) {
  const bg = detectBorderBackground(img);
  if (!bg) return { removed: 0, background: null, reason: 'no-dominant-border-color' };
  const d = img.data;
  const w = img.width, h = img.height;
  const total = w * h;
  const tolerance = 38;
  const tol2 = tolerance * tolerance;
  const br = bg.color[0], bgc = bg.color[1], bb = bg.color[2];
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0, removed = 0;
  /** @param {number} idx */
  const matches = (idx) => {
    if (seen[idx]) return false;
    const o = idx * 4;
    if (d[o + 3] < 8) return false;
    const dr = d[o] - br, dg = d[o + 1] - bgc, db = d[o + 2] - bb;
    return dr * dr + dg * dg + db * db <= tol2;
  };
  /** @param {number} x @param {number} y */
  const seed = (x, y) => {
    const idx = y * w + x;
    if (!matches(idx)) return;
    seen[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    if (h > 1) seed(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    seed(0, y);
    if (w > 1) seed(w - 1, y);
  }
  while (head < tail) {
    const idx = queue[head++];
    const o = idx * 4;
    d[o + 3] = 0;
    removed++;
    const x = idx % w;
    const y = (idx - x) / w;
    const next = [idx - 1, idx + 1, idx - w, idx + w];
    if (x === 0) next[0] = -1;
    if (x === w - 1) next[1] = -1;
    if (y === 0) next[2] = -1;
    if (y === h - 1) next[3] = -1;
    for (const n of next) {
      if (n < 0 || !matches(n)) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  return {
    removed,
    background: debugColor(bg.color),
    tolerance,
    edgeRatio: Math.round(bg.ratio * 1000) / 1000,
    edgeSamples: bg.sampled,
    ring: bg.ring,
  };
}

/** @param {number[]} c */
function debugColor(c) {
  return hexColor(c);
}

/** @param {TracePalette} tracePalette */
function debugPalette(tracePalette) {
  return {
    palette: tracePalette.palette.map(debugColor),
    dropColors: tracePalette.dropColors.map(debugColor),
    paintNoneColor: tracePalette.paintNoneColor ? debugColor(tracePalette.paintNoneColor) : null,
  };
}

/** @param {ImageData} img */
function imageDataColorSummary(img) {
  const d = img.data;
  const total = d.length / 4;
  const stride = Math.max(1, Math.ceil(total / 120000));
  const counts = new Map();
  let transparent = 0;
  let sampled = 0;
  for (let i = 0, px = 0; i < d.length; i += 4, px++) {
    if (px % stride) continue;
    sampled++;
    if (d[i + 3] < 8) transparent++;
    const key = `${hexColor([d[i], d[i + 1], d[i + 2]])}/${byte(d[i + 3])}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([color, count]) => ({ color, count }));
  return { width: img.width, height: img.height, total, sampled, stride, transparent, uniqueSampled: counts.size, top };
}

/** @param {HTMLCanvasElement} cnv */
function canvasColorSummary(cnv) {
  try {
    return imageDataColorSummary(cnv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cnv.width, cnv.height));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {string} s @returns {{order: string[], map: Map<string, string>}} */
function parseStyleDecls(s) {
  const order = [];
  const map = new Map();
  for (const part of String(s || '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!name) continue;
    if (!map.has(name)) order.push(name);
    map.set(name, val);
  }
  return { order, map };
}

/** @param {{order: string[], map: Map<string, string>}} decls */
function styleDeclsText(decls) {
  const names = decls.order.filter((name) => decls.map.has(name));
  return names.map((name) => `${name}: ${decls.map.get(name)}`).join('; ');
}

/**
 * @param {Element} el
 * @param {string} prop
 */
function stylePaintValue(el, prop) {
  return parseStyleDecls(el.getAttribute('style') || '').map.get(prop) || '';
}

/**
 * @param {Element} el
 * @param {string} prop
 * @param {string|null} next
 */
function setStylePaint(el, prop, next) {
  const decls = parseStyleDecls(el.getAttribute('style') || '');
  if (!decls.map.has(prop)) decls.order.push(prop);
  decls.map.set(prop, next || 'none');
  const text = styleDeclsText(decls);
  if (text) el.setAttribute('style', text);
  else el.removeAttribute('style');
}

/** @param {Element} root */
function summarizeSvgRoot(root) {
  const shapes = Array.from(root.querySelectorAll('path,polygon,polyline,rect,circle,ellipse,line'));
  const fills = {};
  const strokes = {};
  const samples = [];
  for (const el of shapes) {
    const fill = el.getAttribute('fill') || stylePaintValue(el, 'fill') || '(missing)';
    const stroke = el.getAttribute('stroke') || stylePaintValue(el, 'stroke') || '(missing)';
    fills[fill] = (fills[fill] || 0) + 1;
    strokes[stroke] = (strokes[stroke] || 0) + 1;
    if (samples.length < 8) {
      samples.push({
        tag: el.localName,
        fillAttr: el.getAttribute('fill'),
        fillStyle: stylePaintValue(el, 'fill') || null,
        strokeAttr: el.getAttribute('stroke'),
        strokeStyle: stylePaintValue(el, 'stroke') || null,
        style: el.getAttribute('style'),
        d: (el.getAttribute('d') || '').slice(0, 96),
      });
    }
  }
  return {
    shapeCount: shapes.length,
    pathCount: root.querySelectorAll('path').length,
    fills,
    strokes,
    samples,
  };
}

/** @param {string} svgText */
function summarizeSvgText(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    return summarizeSvgRoot(doc.documentElement);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), snippet: svgText.slice(0, 240) };
  }
}

/**
 * @param {HTMLCanvasElement} cnv
 * @param {VectorizeOptions} options
 * @returns {TracePalette}
 */
function prepareTraceCanvas(cnv, options) {
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, cnv.width, cnv.height);
  vectorizeDebug('prepareTraceCanvas.before', {
    options,
    canvas: { width: cnv.width, height: cnv.height },
    colors: imageDataColorSummary(img),
  });
  let prepared;
  if (options.mode === 'bw') {
    applyBlackWhite(img);
    prepared = { palette: [[0, 0, 0]], dropColors: [], paintNoneColor: [0, 0, 0] };
  } else {
    const removedBackground = removeConnectedBorderBackground(img);
    vectorizeDebug('prepareTraceCanvas.removeBackground', removedBackground);
    const palette = quantizeColors(img, options.colors || 8);
    const bg = pickBackgroundColor(palette);
    fillTransparentWith(img, bg);
    prepared = { palette, dropColors: [bg] };
  }
  ctx.putImageData(img, 0, 0);
  vectorizeDebug('prepareTraceCanvas.after', {
    tracePalette: debugPalette(prepared),
    colors: imageDataColorSummary(img),
  });
  return prepared;
}

/** @param {Element} el */
function isPaintableShape(el) {
  return /^(path|polygon|polyline|rect|circle|ellipse|line)$/i.test(el.localName);
}

/**
 * @param {Element} el
 * @param {'fill'|'stroke'} prop
 * @param {TracePalette} tracePalette
 */
function normalizePaint(el, prop, tracePalette) {
  const raw = el.getAttribute(prop) || stylePaintValue(el, prop);
  const color = parseColor(raw);
  if (!color) return;
  const isDrop = tracePalette.dropColors.some((c) => dist2(c, color) <= 9);
  const next = isDrop ? null : hexColor(nearestPaletteColor(tracePalette.palette, color));
  if (el.hasAttribute(prop)) el.setAttribute(prop, next || 'none');
  if (stylePaintValue(el, prop)) setStylePaint(el, prop, next);
}

/**
 * @param {string} svgText
 * @param {TracePalette} tracePalette
 */
function normalizeSvgPaints(svgText, tracePalette) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  const before = summarizeSvgRoot(root);
  const decisions = [];
  const nodes = root.querySelectorAll('*');
  for (const el of nodes) {
    let decision = null;
    if (isPaintableShape(el)) {
      const beforeShape = {
        tag: el.localName,
        fillAttr: el.getAttribute('fill'),
        fillStyle: stylePaintValue(el, 'fill') || null,
        strokeAttr: el.getAttribute('stroke'),
        strokeStyle: stylePaintValue(el, 'stroke') || null,
        style: el.getAttribute('style'),
      };
      const hasStroke = el.hasAttribute('stroke') || !!stylePaintValue(el, 'stroke');
      const fill = (el.getAttribute('fill') || stylePaintValue(el, 'fill') || '').trim().toLowerCase();
      const needsDefaultFill = !hasStroke && (!fill || fill === 'none');
      if (needsDefaultFill) {
        const next = hexColor(tracePalette.paintNoneColor || tracePalette.palette[0] || [0, 0, 0]);
        if (stylePaintValue(el, 'fill')) setStylePaint(el, 'fill', next);
        else el.setAttribute('fill', next);
      }
      decision = { before: beforeShape, hasStroke, fill, needsDefaultFill };
    }
    normalizePaint(el, 'fill', tracePalette);
    normalizePaint(el, 'stroke', tracePalette);
    let removed = false;
    if (isPaintableShape(el)) {
      const fillNow = (el.getAttribute('fill') || stylePaintValue(el, 'fill') || '').trim().toLowerCase();
      const strokeNow = (el.getAttribute('stroke') || stylePaintValue(el, 'stroke') || '').trim().toLowerCase();
      if (fillNow === 'none' && (!strokeNow || strokeNow === 'none')) {
        el.remove();
        removed = true;
      }
    }
    if (decision && decisions.length < 12) {
      decisions.push({
        ...decision,
        removed,
        after: {
          fillAttr: el.getAttribute('fill'),
          fillStyle: stylePaintValue(el, 'fill') || null,
          strokeAttr: el.getAttribute('stroke'),
          strokeStyle: stylePaintValue(el, 'stroke') || null,
          style: el.getAttribute('style'),
        },
      });
    }
  }
  vectorizeDebug('normalizeSvgPaints', {
    tracePalette: debugPalette(tracePalette),
    before,
    decisions,
    after: summarizeSvgRoot(root),
  });
  return new XMLSerializer().serializeToString(root);
}

/**
 * @param {HTMLCanvasElement} cnv
 * @param {VectorizeOptions} options
 * @param {TracePalette} tracePalette
 * @param {(progress: number) => void} onProgress
 */
async function runVTracer(cnv, options, tracePalette, onProgress) {
  const { BinaryImageConverter, ColorImageConverter } = await loadVTracer();
  const preset = TRACE_PRESETS[options.preset || 'balanced'] || TRACE_PRESETS.balanced;
  const id = `fp-vtrace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:0;height:0;overflow:hidden;pointer-events:none;';
  cnv.id = `${id}-canvas`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = `${id}-svg`;
  svg.setAttribute('version', '1.1');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `0 0 ${cnv.width} ${cnv.height}`);
  svg.setAttribute('width', String(cnv.width));
  svg.setAttribute('height', String(cnv.height));
  host.append(cnv, svg);
  document.body.appendChild(host);

  /** @type {any} */
  let converter = null;
  const params = {
    canvas_id: cnv.id,
    svg_id: svg.id,
    mode: 'spline',
    hierarchical: options.hierarchical || 'stacked',
    corner_threshold: deg2rad(preset.cornerDeg),
    length_threshold: preset.length,
    max_iterations: preset.iterations,
    splice_threshold: deg2rad(preset.spliceDeg),
    filter_speckle: options.mode === 'bw' ? preset.bwSpeckle : preset.colorSpeckle,
    color_precision: 0,
    layer_difference: preset.layerDifference,
    path_precision: preset.pathPrecision,
  };

  try {
    const Converter = options.mode === 'bw' ? BinaryImageConverter : ColorImageConverter;
    vectorizeDebug('runVTracer.start', {
      options,
      converter: options.mode === 'bw' ? 'BinaryImageConverter' : 'ColorImageConverter',
      params,
      tracePalette: debugPalette(tracePalette),
      canvas: canvasColorSummary(cnv),
    });
    converter = Converter.new_with_string(JSON.stringify(params));
    converter.init();
    let done = false;
    onProgress(0);
    while (!done) {
      const oldLog = console.log;
      console.log = () => {};
      try {
        done = converter.tick();
      } finally {
        console.log = oldLog;
      }
      const p = Number(converter.progress());
      onProgress(Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0);
      if (!done) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    onProgress(100);
    const rawSvgText = new XMLSerializer().serializeToString(svg);
    vectorizeDebug('runVTracer.rawSvg', {
      length: rawSvgText.length,
      summary: summarizeSvgText(rawSvgText),
      snippet: rawSvgText.slice(0, 700),
    });
    const svgText = normalizeSvgPaints(rawSvgText, tracePalette);
    vectorizeDebug('runVTracer.normalizedSvg', {
      length: svgText.length,
      summary: summarizeSvgText(svgText),
      snippet: svgText.slice(0, 700),
    });
    if (!/<path[\s>]/i.test(svgText)) throw new Error('No vector paths were created.');
    return svgText;
  } catch (err) {
    vectorizeDebug('runVTracer.error', { error: err });
    throw err;
  } finally {
    if (converter) {
      try { converter.free(); } catch (err) {
        vectorizeDebug('runVTracer.freeError', { error: err });
      }
    }
    host.remove();
  }
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {import('./boards.js').Board} board
 * @param {VectorizeOptions} options
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<{svgText: string, box: {x: number, y: number, w: number, h: number}}>}
 */
export async function vectorizeRasterLayer(layer, board, options, onProgress = () => {}) {
  if (!layer || layer.kind !== 'raster' || !layer.store) throw new Error('Select a raster layer to vectorize.');
  vectorizeDebug('vectorizeRasterLayer.start', {
    options,
    layer: { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, chunks: layer.store.map.size },
    board: { id: board.id, x: board.x, y: board.y, w: board.w, h: board.h },
  });
  const box = clippedContentBox(layer, board);
  if (!box) throw new Error('This layer has no visible pixels to vectorize.');
  const img = rasterToImageData(layer, box);
  const effectiveOptions = effectiveVectorizeOptions(img, options);
  vectorizeDebug('vectorizeRasterLayer.rasterImage', { box, colors: imageDataColorSummary(img) });
  vectorizeDebug('vectorizeRasterLayer.effectiveOptions', { input: options, effective: effectiveOptions });
  const cnv = imageDataToTraceCanvas(img, effectiveOptions);
  vectorizeDebug('vectorizeRasterLayer.traceCanvas', {
    source: { width: img.width, height: img.height },
    canvas: { width: cnv.width, height: cnv.height },
    colors: canvasColorSummary(cnv),
  });
  const tracePalette = prepareTraceCanvas(cnv, effectiveOptions);
  const svgText = await runVTracer(cnv, effectiveOptions, tracePalette, onProgress);
  vectorizeDebug('vectorizeRasterLayer.done', {
    box: { x: box.x0, y: box.y0, w: box.w, h: box.h },
    svg: { length: svgText.length, summary: summarizeSvgText(svgText) },
  });
  return { svgText, box: { x: box.x0, y: box.y0, w: box.w, h: box.h } };
}
