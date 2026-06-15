// BLUR GAUSSIANO — commit CPU e scrittura nei chunk con undo a tile-diff.
// Il ✓ del pannello Effetti, col renderer WebGL, rilegge il risultato GPU
// dell'anteprima (stesso shader: il commit è ESATTAMENTE ciò che si vedeva);
// queste routine sono il fallback CPU (renderer 2D, contesto perso) e la
// scrittura condivisa dei due path. I pixel sono RGBA premultiplied: è lo
// spazio corretto per filtrare (niente aloni scuri sui bordi alpha).
// Il blur CPU è la gaussiana ricorsiva di Young–van Vliet (3° ordine,
// forward+backward per asse): costo costante per pixel indipendente da
// sigma, qualità da editor (è il metodo di GIMP). Il bordo dell'hull ha
// >= 3σ di trasparente attorno al contenuto (PAD della sessione), quindi
// l'innesco a zero della ricorsione è esatto.

import { CHUNK, CHUNK_SHIFT, chunkKey } from './store.js';

/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./store.js').Chunk} Chunk */

/**
 * Risultato di un effetto: i pixel premultiplied del rettangolo mondo
 * [x, y, w, h] (riga 0 = mondo in alto), pronti per la scrittura nei chunk.
 * @typedef {Object} FxResult
 * @property {number} x @property {number} y origine mondo
 * @property {number} w @property {number} h
 * @property {Uint8ClampedArray} data w*h*4 byte RGBA premultiplied
 */

// Snapshot contiguo del rettangolo mondo [x, y, w, h] (chunk-aligned: ogni
// chunk è interamente dentro o fuori). I chunk oltre il rettangolo sono
// vuoti per costruzione dell'hull e si saltano.
/** @param {ChunkStore} store @param {number} x @param {number} y @param {number} w @param {number} h */
export function snapshotRect(store, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (const c of store.map.values()) {
    const ox = c.cx * CHUNK - x, oy = c.cy * CHUNK - y;
    if (ox < 0 || oy < 0 || ox + CHUNK > w || oy + CHUNK > h) continue;
    for (let row = 0; row < CHUNK; row++) {
      out.set(c.data.subarray(row * CHUNK * 4, (row + 1) * CHUNK * 4),
        ((oy + row) * w + ox) * 4);
    }
  }
  return out;
}

// Coefficienti di Young–van Vliet (1995) per la gaussiana ricorsiva:
// y[n] = B·x[n] + c1·y[n-1] + c2·y[n-2] + c3·y[n-3], stesso filtro
// all'indietro. Validi da sigma ~0.5 in su.
/** @param {number} sigma */
function iirCoeffs(sigma) {
  const s = Math.max(0.5, sigma);
  const q = s >= 2.5
    ? 0.98711 * s - 0.96330
    : 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * s);
  const q2 = q * q, q3 = q2 * q;
  const b0 = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;
  const c1 = (2.44413 * q + 2.85619 * q2 + 1.26661 * q3) / b0;
  const c2 = -(1.4281 * q2 + 1.26661 * q3) / b0;
  const c3 = (0.422205 * q3) / b0;
  const B = 1 - (c1 + c2 + c3);
  return { B, c1, c2, c3 };
}

// Pass orizzontale: ricorsione per riga, avanti e indietro, 4 canali in
// parallelo con accumulatori scalari (innesco a zero: il bordo è trasparente).
/** @param {Float32Array} f @param {number} w @param {number} h @param {number} B @param {number} c1 @param {number} c2 @param {number} c3 */
function hPass(f, w, h, B, c1, c2, c3) {
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let r1 = 0, r2 = 0, r3 = 0, g1 = 0, g2 = 0, g3 = 0;
    let b1 = 0, b2 = 0, b3 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let o = row, end = row + w * 4; o < end; o += 4) {
      const r = B * f[o] + c1 * r1 + c2 * r2 + c3 * r3;
      f[o] = r; r3 = r2; r2 = r1; r1 = r;
      const g = B * f[o + 1] + c1 * g1 + c2 * g2 + c3 * g3;
      f[o + 1] = g; g3 = g2; g2 = g1; g1 = g;
      const b = B * f[o + 2] + c1 * b1 + c2 * b2 + c3 * b3;
      f[o + 2] = b; b3 = b2; b2 = b1; b1 = b;
      const a = B * f[o + 3] + c1 * a1 + c2 * a2 + c3 * a3;
      f[o + 3] = a; a3 = a2; a2 = a1; a1 = a;
    }
    r1 = r2 = r3 = g1 = g2 = g3 = b1 = b2 = b3 = a1 = a2 = a3 = 0;
    for (let o = row + (w - 1) * 4; o >= row; o -= 4) {
      const r = B * f[o] + c1 * r1 + c2 * r2 + c3 * r3;
      f[o] = r; r3 = r2; r2 = r1; r1 = r;
      const g = B * f[o + 1] + c1 * g1 + c2 * g2 + c3 * g3;
      f[o + 1] = g; g3 = g2; g2 = g1; g1 = g;
      const b = B * f[o + 2] + c1 * b1 + c2 * b2 + c3 * b3;
      f[o + 2] = b; b3 = b2; b2 = b1; b1 = b;
      const a = B * f[o + 3] + c1 * a1 + c2 * a2 + c3 * a3;
      f[o + 3] = a; a3 = a2; a2 = a1; a1 = a;
    }
  }
}

// Pass verticale: la ricorsione legge le righe già filtrate direttamente dal
// buffer (accesso sequenziale per riga, cache-friendly); le prime/ultime 3
// righe innescano a zero con loop dedicati.
/** @param {Float32Array} f @param {number} w @param {number} h @param {number} B @param {number} c1 @param {number} c2 @param {number} c3 */
function vPass(f, w, h, B, c1, c2, c3) {
  const w4 = w * 4;
  for (let y = 0; y < h; y++) {
    const o0 = y * w4;
    if (y >= 3) {
      for (let i = 0; i < w4; i++) {
        const o = o0 + i;
        f[o] = B * f[o] + c1 * f[o - w4] + c2 * f[o - 2 * w4] + c3 * f[o - 3 * w4];
      }
    } else if (y === 2) {
      for (let i = 0; i < w4; i++) {
        const o = o0 + i;
        f[o] = B * f[o] + c1 * f[o - w4] + c2 * f[o - 2 * w4];
      }
    } else if (y === 1) {
      for (let i = 0; i < w4; i++) {
        const o = o0 + i;
        f[o] = B * f[o] + c1 * f[o - w4];
      }
    } else {
      for (let i = 0; i < w4; i++) f[o0 + i] = B * f[o0 + i];
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const o0 = y * w4;
    if (y <= h - 4) {
      for (let i = 0; i < w4; i++) {
        const o = o0 + i;
        f[o] = B * f[o] + c1 * f[o + w4] + c2 * f[o + 2 * w4] + c3 * f[o + 3 * w4];
      }
    } else if (y === h - 3) {
      for (let i = 0; i < w4; i++) {
        const o = o0 + i;
        f[o] = B * f[o] + c1 * f[o + w4] + c2 * f[o + 2 * w4];
      }
    } else if (y === h - 2) {
      for (let i = 0; i < w4; i++) {
        const o = o0 + i;
        f[o] = B * f[o] + c1 * f[o + w4];
      }
    } else {
      for (let i = 0; i < w4; i++) f[o0 + i] = B * f[o0 + i];
    }
  }
}

// Blur gaussiano separabile IN PLACE sul buffer premultiplied (deviazione
// standard sigma in px). Accumulo in Float32, riscrittura u8 con il vincolo
// premultiplied r,g,b <= a (l'arrotondamento indipendente dei canali
// potrebbe violarlo di 1).
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} sigma */
export function gaussianBlurBuffer(data, w, h, sigma) {
  if (sigma <= 0 || w <= 0 || h <= 0) return;
  const n = w * h * 4;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = data[i];
  const { B, c1, c2, c3 } = iirCoeffs(sigma);
  hPass(f, w, h, B, c1, c2, c3);
  vPass(f, w, h, B, c1, c2, c3);
  for (let i = 0; i < n; i += 4) {
    data[i + 3] = f[i + 3];
    const a = data[i + 3];
    data[i] = Math.min(f[i], a);
    data[i + 1] = Math.min(f[i + 1], a);
    data[i + 2] = Math.min(f[i + 2], a);
  }
}

// Blur di movimento IN PLACE: media uniforme (box) lungo la direzione
// angle (radianti, mondo), corsa totale dist px (±dist/2). Tap a passo
// costante con pesi bilineari precalcolati (l'offset frazionario è lo
// stesso per tutti i pixel). Fuori dal buffer = trasparente, coerente col
// path GPU (l'hull ha il bordo trasparente). Questo è il fallback raro del
// renderer 2D: tap limitati, qualità comunque da box-blur direzionale.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} angle @param {number} dist */
export function motionBlurBuffer(data, w, h, angle, dist) {
  const half = dist / 2;
  if (half < 0.5 || w <= 0 || h <= 0) return;
  const R = Math.min(40, Math.max(1, Math.ceil(half)));
  const spacing = half / R;
  const ux = Math.cos(angle) * spacing, uy = Math.sin(angle) * spacing;
  // per tap: parte intera dell'offset + 4 pesi bilineari (uguali ovunque)
  const tap = [];
  for (let i = -R; i <= R; i++) {
    if (i === 0) continue;
    const dx = ux * i, dy = uy * i;
    const ix = Math.floor(dx), iy = Math.floor(dy);
    const fx = dx - ix, fy = dy - iy;
    tap.push({
      ix, iy,
      w00: (1 - fx) * (1 - fy), w10: fx * (1 - fy),
      w01: (1 - fx) * fy, w11: fx * fy,
    });
  }
  const norm = 1 / (tap.length + 1);
  const src = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) src[i] = data[i];
  /** @type {(x: number, y: number) => number} -1 = fuori (trasparente) */
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? (y * w + x) * 4 : -1;
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      let r = src[o], g = src[o + 1], b = src[o + 2], a = src[o + 3];
      for (const t of tap) {
        const x0 = x + t.ix, y0 = y + t.iy;
        const o00 = at(x0, y0), o10 = at(x0 + 1, y0);
        const o01 = at(x0, y0 + 1), o11 = at(x0 + 1, y0 + 1);
        if (o00 >= 0) { r += src[o00] * t.w00; g += src[o00 + 1] * t.w00; b += src[o00 + 2] * t.w00; a += src[o00 + 3] * t.w00; }
        if (o10 >= 0) { r += src[o10] * t.w10; g += src[o10 + 1] * t.w10; b += src[o10 + 2] * t.w10; a += src[o10 + 3] * t.w10; }
        if (o01 >= 0) { r += src[o01] * t.w01; g += src[o01 + 1] * t.w01; b += src[o01 + 2] * t.w01; a += src[o01 + 3] * t.w01; }
        if (o11 >= 0) { r += src[o11] * t.w11; g += src[o11 + 1] * t.w11; b += src[o11 + 2] * t.w11; a += src[o11 + 3] * t.w11; }
      }
      data[o + 3] = a * norm;
      const A = data[o + 3];
      data[o] = Math.min(r * norm, A);
      data[o + 1] = Math.min(g * norm, A);
      data[o + 2] = Math.min(b * norm, A);
    }
  }
}

// Blur radiale (zoom) IN PLACE: ogni pixel media i campioni lungo il raggio
// verso il centro (scale da 1 a 1-k: si raccoglie solo verso l'interno, il
// contenuto "scorre" in fuori senza mai campionare oltre il board). Jitter
// di fase per pixel come nello shader: rompe le bande dei tap radi.
// Fallback raro del renderer 2D: campionamento nearest.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} cx @param {number} cy @param {number} k */
export function zoomBlurBuffer(data, w, h, cx, cy, k) {
  if (k <= 0 || w <= 0 || h <= 0) return;
  const N = Math.min(120, Math.max(16, Math.round(k * 400)));
  const src = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) src[i] = data[i];
  const norm = 1 / (N + 1);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      const dx = x - cx, dy = y - cy;
      const j = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      const jit = (j < 0 ? j + 1 : j) - 0.5;
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i <= N; i++) {
        const s = 1 - k * (i + jit) / N;
        const sx = Math.round(cx + dx * s), sy = Math.round(cy + dy * s);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue; // trasparente
        const so = (sy * w + sx) * 4;
        r += src[so]; g += src[so + 1]; b += src[so + 2]; a += src[so + 3];
      }
      data[o + 3] = a * norm;
      const A = data[o + 3];
      data[o] = Math.min(r * norm, A);
      data[o + 1] = Math.min(g * norm, A);
      data[o + 2] = Math.min(b * norm, A);
    }
  }
}

// Hash deterministico, stessa famiglia dello shader (i due path non sono
// bit-exact tra loro ma su un device gira sempre uno solo dei due).
/** @param {number} x @param {number} y */
function hash2(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** @param {number} v @param {number} lo @param {number} hi */
function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** @param {number} px @param {number} py */
function signedVNoise(px, py) { return vnoise2(px, py) * 2 - 1; }

/** @param {number} px @param {number} py */
function pixelNoise(px, py) {
  return hash2(px, py) + hash2(px + 17.13, py - 11.71) - 1;
}

/** @param {number} px @param {number} py @param {number} seed */
function gaussianNoise(px, py, seed) {
  const n =
    hash2(px + seed * 0.11, py - seed * 0.17) +
    hash2(px * 1.37 - seed * 0.23, py * 0.91 + seed * 0.29) +
    hash2(px * 0.73 + 19.17 + seed * 0.31, py * 1.61 - 7.43 - seed * 0.37) +
    hash2(px * 1.91 - 5.71 - seed * 0.41, py * 0.57 + 23.11 + seed * 0.43);
  return clampNum((n - 2) * 0.86, -1, 1);
}

/** @param {number} px @param {number} py @param {number} size @param {number} roughness @param {number} seed */
function particleNoise(px, py, size, roughness, seed) {
  const s = Math.max(1, size);
  const rgh = clampNum(roughness, 0, 1);
  if (s <= 1.05) return pixelNoise(px + seed, py - seed);
  const gx = Math.floor(px / s), gy = Math.floor(py / s);
  let acc = 0, wsum = 0;
  const jitter = 0.18 + rgh * 0.62;
  for (let yy = -1; yy <= 1; yy++) {
    for (let xx = -1; xx <= 1; xx++) {
      const cx = gx + xx, cy = gy + yy;
      const jx = (hash2(cx + seed * 0.37, cy - seed * 0.21) - 0.5) * jitter;
      const jy = (hash2(cx - seed * 0.13, cy + seed * 0.49) - 0.5) * jitter;
      const ox = (cx + 0.5 + jx) * s;
      const oy = (cy + 0.5 + jy) * s;
      const rad = (0.38 + hash2(cx + 91.7, cy - 54.3) * (0.12 + rgh * 0.32)) * s;
      const dx = px - ox, dy = py - oy;
      const d2 = dx * dx + dy * dy, r2 = rad * rad;
      if (d2 >= r2) continue;
      const t = 1 - d2 / r2;
      const ww = t * t * (3 - 2 * t);
      const amp = pixelNoise(cx * 23.31 + seed, cy * 17.17 - seed);
      acc += amp * ww;
      wsum += ww;
    }
  }
  const clump = wsum > 0 ? acc / wsum : pixelNoise(gx + seed * 0.7, gy - seed * 0.4) * 0.25;
  const micro = pixelNoise(px + seed * 2.13, py - seed * 1.77);
  const microMix = 0.06 + rgh * 0.34;
  return clampNum(clump * (1 - microMix) + micro * microMix, -1, 1);
}

// Noise IN PLACE: random pixels/particles, con size controllabile. Size 1
// equivale al noise per-pixel; salendo, la casualita' resta ma cresce la
// particella. colorMix 0 = mono, 1 = canali indipendenti. Alpha intatta.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} amount @param {number} colorMix @param {number} size @param {number} roughness @param {number} seed */
export function noiseBuffer(data, w, h, amount, colorMix, size, roughness, seed) {
  if (amount <= 0) return;
  const sz = Math.max(1, size || 1);
  const rgh = clampNum(roughness, 0, 1);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      const a = data[o + 3];
      if (a === 0) continue;
      const px = x + seed, py = y + seed;
      const nm = particleNoise(px, py, sz, rgh, seed);
      const amt = amount * a;
      for (let ch = 0; ch < 3; ch++) {
        const k = 37.7 + ch * 31.6;
        const nc = colorMix > 0 ? particleNoise(px + k, py - k * 0.73, sz, rgh, seed + k) : nm;
        const n = nm + (nc - nm) * colorMix;
        data[o + ch] = clampNum(data[o + ch] + n * amt, 0, a);
      }
    }
  }
}

// Value noise smooth sulla griglia p/size (per la grana: macchie morbide).
/** @param {number} px @param {number} py */
function vnoise2(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a + (a - b + d - c) * ux) * uy;
}

/** @param {number} px @param {number} py @param {number} size @param {number} roughness @param {number} seed */
function grainParticleNoise(px, py, size, roughness, seed) {
  const s = Math.max(1, size);
  const rgh = clampNum(roughness, 0, 1);
  if (s <= 1.05) return pixelNoise(px + seed, py - seed);
  const gx = Math.floor(px / s), gy = Math.floor(py / s);
  let acc = 0, wsum = 0;
  const jitter = 0.16 + rgh * 0.56;
  for (let yy = -1; yy <= 1; yy++) {
    for (let xx = -1; xx <= 1; xx++) {
      const cx = gx + xx, cy = gy + yy;
      const jx = (hash2(cx + seed * 0.37, cy - seed * 0.21) - 0.5) * jitter;
      const jy = (hash2(cx - seed * 0.13, cy + seed * 0.49) - 0.5) * jitter;
      const ox = (cx + 0.5 + jx) * s;
      const oy = (cy + 0.5 + jy) * s;
      const rad = (0.32 + hash2(cx + 91.7, cy - 54.3) * (0.1 + rgh * 0.26)) * s;
      const dx = px - ox, dy = py - oy;
      const d2 = dx * dx + dy * dy, r2 = rad * rad;
      if (d2 >= r2) continue;
      const t = 1 - d2 / r2;
      const ww = t * t * (3 - 2 * t);
      const amp = gaussianNoise(cx * 23.31 + seed, cy * 17.17 - seed, seed);
      acc += amp * ww;
      wsum += ww;
    }
  }
  const clump = wsum > 0 ? acc / wsum : pixelNoise(gx + seed * 0.7, gy - seed * 0.4) * 0.18;
  const micro = pixelNoise(px + seed * 2.13, py - seed * 1.77);
  const microMix = 0.12 + rgh * 0.26;
  return clampNum(clump * (1 - microMix) + micro * microMix, -1, 1);
}

/** @param {number} px @param {number} py @param {number} size @param {number} roughness @param {number} seed */
function filmGrainNoise(px, py, size, roughness, seed) {
  const safeSize = Math.max(1, size);
  const rgh = clampNum(roughness, 0, 1);
  const sizeMix = clampNum((safeSize - 1) / 14, 0, 1);
  const micro = gaussianNoise(px + seed * 1.91, py - seed * 1.37, seed);
  const fineScale = Math.max(1, safeSize * 0.38);
  const fine = gaussianNoise((px + seed * 0.67) / fineScale,
    (py - seed * 0.53) / fineScale, seed + 31.7);
  const particle = grainParticleNoise(px, py, Math.max(1, safeSize * 0.7), rgh, seed);
  const bodyScale = Math.max(1, safeSize * 0.95);
  const body = signedVNoise((px + seed) / bodyScale, (py - seed) / bodyScale);
  return clampNum((
    micro * (0.58 - sizeMix * 0.2 + rgh * 0.08) +
    fine * (0.18 - sizeMix * 0.06) +
    particle * (0.18 + sizeMix * 0.22 + rgh * 0.04) +
    body * (0.06 + sizeMix * 0.04 - rgh * 0.03)
  ) * 0.82, -1, 1);
}

// Grana pellicola IN PLACE: rumore mono quasi-gaussiano, con una base fine
// sempre presente e granuli piu' grandi controllati da size. Alpha intatta.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} amount @param {number} size @param {number} roughness @param {number} seed */
export function grainBuffer(data, w, h, amount, size, roughness, seed) {
  if (amount <= 0 || size <= 0) return;
  const safeSize = Math.max(1, size);
  const rgh = clampNum(roughness, 0, 1);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      const a = data[o + 3];
      if (a === 0) continue;
      const n = filmGrainNoise(x, y, safeSize, rgh, seed);
      const lum = Math.min(1, (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / a);
      const mid = clampNum(4 * lum * (1 - lum), 0, 1);
      const tone = 0.16 + 0.84 * Math.pow(mid, 0.72);
      const k = n * amount * tone * a;
      data[o] = clampNum(data[o] + k, 0, a);
      data[o + 1] = clampNum(data[o + 1] + k, 0, a);
      data[o + 2] = clampNum(data[o + 2] + k, 0, a);
    }
  }
}

// Soglia IN PLACE: luminanza >= t (0..1) -> bianco, sotto -> nero, alla
// Photoshop. Alpha intatta (i bordi morbidi restano morbidi, il colore
// diventa puro); premultiplied: bianco = (a,a,a), nero = (0,0,0).
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} t */
export function thresholdBuffer(data, w, h, t) {
  const n = w * h * 4;
  for (let o = 0; o < n; o += 4) {
    const a = data[o + 3];
    if (a === 0) continue;
    const l = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / a;
    const v = l >= t ? a : 0;
    data[o] = v; data[o + 1] = v; data[o + 2] = v;
  }
}

const HT_CMYK_ANGLES = [15, 75, 0, 45].map((a) => a * Math.PI / 180);

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** @param {number} e0 @param {number} e1 @param {number} x */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** @param {number} angle @param {number} radius @param {number} spacing */
function htScreen(angle, radius, spacing) {
  return {
    c: Math.cos(angle),
    s: Math.sin(angle),
    r: Math.max(0.25, radius),
    cell: Math.max(2, spacing || radius * 2),
  };
}

/** @param {{c:number,s:number,r:number,cell:number}} sc @param {number} px @param {number} py */
function htDot(sc, px, py, amount) {
  amount = clamp(amount, 0, 1);
  if (amount <= 0.0001) return 0;
  const rx = sc.c * px + sc.s * py;
  const ry = -sc.s * px + sc.c * py;
  const dx = (rx / sc.cell - Math.floor(rx / sc.cell) - 0.5) * sc.cell;
  const dy = (ry / sc.cell - Math.floor(ry / sc.cell) - 0.5) * sc.cell;
  const r = sc.r * Math.sqrt(amount);
  return 1 - smoothstep(r - 0.75, r + 0.75, Math.hypot(dx, dy));
}

/**
 * @param {{c:number,s:number,r:number,cell:number}} sc
 * @param {Uint8ClampedArray} src @param {number} w @param {number} h
 * @param {number} px @param {number} py @param {number} ox @param {number} oy
 */
function htSampleOffset(sc, src, w, h, px, py, ox, oy) {
  const rx = sc.c * px + sc.s * py;
  const ry = -sc.s * px + sc.c * py;
  const gx = (Math.floor(rx / sc.cell) + 0.5) * sc.cell;
  const gy = (Math.floor(ry / sc.cell) + 0.5) * sc.cell;
  const sx = sc.c * gx - sc.s * gy - ox;
  const sy = sc.s * gx + sc.c * gy - oy;
  const ix = clamp(Math.floor(sx), 0, w - 1);
  const iy = clamp(Math.floor(sy), 0, h - 1);
  return (iy * w + ix) * 4;
}

/** @param {Uint8ClampedArray} src @param {number} o */
function htLum(src, o) {
  const a = src[o + 3];
  if (a === 0) return 1;
  return clamp((0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]) / a, 0, 1);
}

/** @param {Uint8ClampedArray} src @param {number} o @param {number} ch */
function htCmyk(src, o, ch) {
  const a = src[o + 3];
  if (a === 0) return 0;
  const r = clamp(src[o] / a, 0, 1);
  const g = clamp(src[o + 1] / a, 0, 1);
  const b = clamp(src[o + 2] / a, 0, 1);
  const k = 1 - Math.max(r, g, b);
  if (ch === 3) return k;
  const d = 1 - k;
  if (d <= 1e-5) return 0;
  if (ch === 0) return clamp((1 - r - k) / d, 0, 1);
  if (ch === 1) return clamp((1 - g - k) / d, 0, 1);
  return clamp((1 - b - k) / d, 0, 1);
}

// Halftone IN PLACE: Color=0 produce un retino monocromatico da bitmap/
// serigrafia, Color=1 usa quattro retini CMYK con angoli da rosetta. I vuoti
// diventano trasparenti: cosi' il risultato funziona anche come base di una
// clipping mask. Il retino e' ancorato alle coordinate del board (ox/oy =
// origine locale del buffer rispetto al board), quindi resta stabile fra
// preview e commit.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} radius @param {number} spacing @param {number} angle @param {number} colorMix @param {number} ox @param {number} oy */
export function halftoneBuffer(data, w, h, radius, spacing, angle, colorMix, ox, oy) {
  if (radius <= 0 || w <= 0 || h <= 0) return;
  const src = new Uint8ClampedArray(data);
  const mono = htScreen(angle, radius, spacing);
  const screens = HT_CMYK_ANGLES.map((a) => htScreen(angle + a, radius, spacing));
  const mix = clamp(colorMix, 0, 1);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5 + oy;
    for (let x = 0; x < w; x++, o += 4) {
      const a = src[o + 3];
      if (a === 0) continue;
      const px = x + 0.5 + ox;
      const mo = htSampleOffset(mono, src, w, h, px, py, ox, oy);
      const ink = htDot(mono, px, py, 1 - htLum(src, mo));
      let paperR = 1 - ink, paperG = paperR, paperB = paperR;
      let cover = ink;
      if (mix > 0) {
        const co = htSampleOffset(screens[0], src, w, h, px, py, ox, oy);
        const mo2 = htSampleOffset(screens[1], src, w, h, px, py, ox, oy);
        const yo = htSampleOffset(screens[2], src, w, h, px, py, ox, oy);
        const ko = htSampleOffset(screens[3], src, w, h, px, py, ox, oy);
        const cInk = htDot(screens[0], px, py, htCmyk(src, co, 0));
        const mInk = htDot(screens[1], px, py, htCmyk(src, mo2, 1));
        const yInk = htDot(screens[2], px, py, htCmyk(src, yo, 2));
        const kInk = htDot(screens[3], px, py, htCmyk(src, ko, 3));
        const cr = (1 - cInk) * (1 - kInk);
        const cg = (1 - mInk) * (1 - kInk);
        const cb = (1 - yInk) * (1 - kInk);
        const ca = 1 - (1 - cInk) * (1 - mInk) * (1 - yInk) * (1 - kInk);
        paperR += (cr - paperR) * mix;
        paperG += (cg - paperG) * mix;
        paperB += (cb - paperB) * mix;
        cover += (ca - cover) * mix;
      }
      const outA = a * cover;
      data[o + 3] = outA;
      if (outA <= 0) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
      } else {
        const inv = 1 / Math.max(1e-6, cover);
        data[o] = Math.min(clamp((paperR - (1 - cover)) * inv, 0, 1) * outA, outA);
        data[o + 1] = Math.min(clamp((paperG - (1 - cover)) * inv, 0, 1) * outA, outA);
        data[o + 2] = Math.min(clamp((paperB - (1 - cover)) * inv, 0, 1) * outA, outA);
      }
    }
  }
}

// EDT 1D esatta di Felzenszwalb & Huttenlocher sul quadrato delle distanze
// (inviluppo inferiore di parabole). f = input (0 sui semi, INF altrove),
// d = output, v/z = scratch.
/** @param {Float32Array} f @param {number} n @param {Float32Array} d @param {Int32Array} v @param {Float64Array} z */
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

// EDT 2D esatta IN PLACE su grid (w*h, 0 sui semi, INF altrove): al ritorno
// ogni cella contiene la distanza euclidea AL QUADRATO dal seme più vicino.
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

// Traccia (Stile livello) IN PLACE: contorno della forma (alpha>0.5) di
// larghezza sw, posizione pos (0 esterna, 1 centrale, 2 interna), colore
// r/g/b (0..1). Stessa matematica del path GPU: distanza euclidea esatta
// dal bordo, anello con rampa antialiasata di 1 px; l'anello esterno va
// SOTTO il contenuto, quello interno sostituisce il colore con alpha
// intatta. Fallback raro del renderer 2D.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} sw @param {number} pos @param {number} r @param {number} g @param {number} b */
export function strokeBuffer(data, w, h, sw, pos, r, g, b) {
  if (sw <= 0 || w <= 0 || h <= 0) return;
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
  /** @type {(ww: number, dd: number) => number} */
  const fill = (ww, dd) => Math.min(1, Math.max(0, ww + 0.5 - dd));
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const dOut = Math.sqrt(dShape[i]), dIn = Math.sqrt(dComp[i]);
    let covO = 0, covI = 0;
    // esterna/centrale: il riempimento copre anche la frangia antialiasata
    // del bordo (dIn < 2, alpha > 0.5): il residuo 1-a va saturato, sennò
    // lo sfondo trafila come cucitura punteggiata (come nello shader)
    const wO = pos === 1 ? sw / 2 : sw;
    if (pos !== 2 && (dOut > 0 || dIn < 2)) covO = fill(wO, dOut);
    if (pos !== 0 && dIn > 0) covI = fill(pos === 1 ? sw / 2 : sw, dIn);
    if (covO === 0 && covI === 0) continue;
    const a = data[o + 3];
    // interna: colore verso la traccia, alpha intatta (premul: colore*a)
    let cr = data[o] + (r * a - data[o]) * covI;
    let cg = data[o + 1] + (g * a - data[o + 1]) * covI;
    let cb = data[o + 2] + (b * a - data[o + 2]) * covI;
    // esterna: anello pieno sotto il contenuto
    const sa = covO * (255 - a);
    const na = Math.min(255, a + sa);
    data[o + 3] = na;
    const A = data[o + 3];
    data[o] = Math.min(cr + r * sa, A);
    data[o + 1] = Math.min(cg + g * sa, A);
    data[o + 2] = Math.min(cb + b * sa, A);
  }
}

// Colore (Stile livello) IN PLACE: sostituisce il colore con r/g/b (0..1)
// mantenendo l'alpha intatta. Premultiplied: rgb = colore × a.
/** @param {Uint8ClampedArray} data @param {number} w @param {number} h @param {number} r @param {number} g @param {number} b */
export function tintBuffer(data, w, h, r, g, b) {
  const n = w * h * 4;
  for (let o = 0; o < n; o += 4) {
    const a = data[o + 3];
    if (a === 0) continue;
    data[o] = Math.min(r * a, a);
    data[o + 1] = Math.min(g * a, a);
    data[o + 2] = Math.min(b * a, a);
  }
}

// Scrive il risultato dell'effetto nello store, clippato al rettangolo
// inclusivo del board, con cattura per l'undo (tile-diff come una
// pennellata): chunk esistenti fotografati PRIMA della mutazione, chunk
// nuovi catturati come "non esisteva". I chunk che resterebbero
// completamente trasparenti non si creano (e se esistevano e il rect li
// copre per intero, si rimuovono).
/**
 * @param {ChunkStore} store @param {FxResult} res
 * @param {{x0:number,y0:number,x1:number,y1:number}} clip
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray<ArrayBuffer>|null) => void} capture
 * @param {(c: Chunk) => void} disposeTex
 */
export function applyFxResult(store, res, clip, capture, disposeTex) {
  const x0 = Math.max(res.x, clip.x0), y0 = Math.max(res.y, clip.y0);
  const x1 = Math.min(res.x + res.w - 1, clip.x1), y1 = Math.min(res.y + res.h - 1, clip.y1);
  if (x0 > x1 || y0 > y1) return;
  const data = res.data, rw = res.w;
  for (let cy = y0 >> CHUNK_SHIFT; cy <= y1 >> CHUNK_SHIFT; cy++) {
    for (let cx = x0 >> CHUNK_SHIFT; cx <= x1 >> CHUNK_SHIFT; cx++) {
      const key = chunkKey(cx, cy);
      const ox = cx << CHUNK_SHIFT, oy = cy << CHUNK_SHIFT;
      const lx0 = Math.max(0, x0 - ox), ly0 = Math.max(0, y0 - oy);
      const lx1 = Math.min(CHUNK - 1, x1 - ox), ly1 = Math.min(CHUNK - 1, y1 - oy);
      let chunk = store.getByKey(key);
      const existed = chunk !== undefined;
      // il rect porta contenuto? (alpha > 0 da qualche parte)
      let any = false;
      for (let ly = ly0; ly <= ly1 && !any; ly++) {
        let so = ((oy + ly - res.y) * rw + (ox + lx0 - res.x)) * 4 + 3;
        for (let lx = lx0; lx <= lx1; lx++, so += 4) {
          if (data[so] !== 0) { any = true; break; }
        }
      }
      if (!existed && !any) continue; // niente da scrivere, niente chunk vuoti
      capture(key, cx, cy, existed ? chunk.data : null);
      if (existed && !any && lx0 === 0 && ly0 === 0 && lx1 === CHUNK - 1 && ly1 === CHUNK - 1) {
        // svuotato per intero: via dal documento (già fotografato)
        store.remove(key, disposeTex);
        continue;
      }
      if (!existed) chunk = store.getOrCreate(cx, cy);
      for (let ly = ly0; ly <= ly1; ly++) {
        let so = ((oy + ly - res.y) * rw + (ox + lx0 - res.x)) * 4;
        const n = (lx1 - lx0 + 1) * 4;
        chunk.data.set(data.subarray(so, so + n), (ly * CHUNK + lx0) * 4);
      }
      chunk.touched = true;
      store.markDirty(chunk, lx0, ly0, lx1, ly1);
    }
  }
}
