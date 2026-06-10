// Utility condivise: math, colore, divisioni intere veloci.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// Divisione per 255 con arrotondamento, esatta per v in [0, 65025].
// Usata in tutti i loop di blend premultiplied.
export const div255 = (v) => ((v + 128) * 257) >> 16;

// RGB (0..255) -> HSV (h 0..360, s 0..1, v 0..1)
export function rgbToHsv(r, g, b, out) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  out.h = h;
  out.s = max === 0 ? 0 : d / max;
  out.v = max;
  return out;
}

// HSV -> RGB (0..255), scrive in out {r,g,b}
export function hsvToRgb(h, s, v, out) {
  const c = v * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  out.r = Math.round((r + m) * 255);
  out.g = Math.round((g + m) * 255);
  out.b = Math.round((b + m) * 255);
  return out;
}

export function hexToRgb(hex, out) {
  const n = parseInt(hex.slice(1), 16);
  out.r = (n >> 16) & 255;
  out.g = (n >> 8) & 255;
  out.b = n & 255;
  return out;
}

export function rgbToHex(r, g, b) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// PRNG deterministico per stroke (mulberry32) — nessuna allocazione per chiamata.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
