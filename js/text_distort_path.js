import { ensureOutlineFont, outlineCommands } from './text_outline.js';

/** @typedef {import('./text_layer.js').TextItem} TextItem */
/** @typedef {import('./text_layer.js').TextStyle} TextStyle */
/** @typedef {import('./text_layer.js').Distort} Distort */

const DISTORT_POINTS = [
  'tl', 'tc', 'tr', 'bl', 'bc', 'br',
  'htl', 'htcl', 'htcr', 'htr', 'hbl', 'hbcl', 'hbcr', 'hbr',
];

const edgeTop = { x: 0, y: 0, dx: 0, dy: 0 };
const edgeBot = { x: 0, y: 0, dx: 0, dy: 0 };
const mapped = { x: 0, y: 0 };

let cacheKey = '';
let cachePath = '';

/** @param {number} n */
function pnum(n) {
  return String(Math.round(n * 100) / 100);
}

/** @param {Distort} d */
function distortSig(d) {
  return DISTORT_POINTS.map((k) => `${d[k].x},${d[k].y}`).join('|');
}

/** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} size */
function lineSteps(x0, y0, x1, y1, size) {
  return Math.max(1, Math.min(24,
    Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(2, size * 0.12))));
}

/** @param {any[]} cmds */
function commandBounds(cmds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') add(c.x, c.y);
    else if (c.type === 'C') {
      add(c.x1, c.y1); add(c.x2, c.y2); add(c.x, c.y);
    } else if (c.type === 'Q') {
      add(c.x1, c.y1); add(c.x, c.y);
    }
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * @param {number} x @param {number} y
 * @param {{x:number,y:number,w:number,h:number}|null} bounds
 * @param {{x:number,y:number,w:number,h:number}} sbox
 */
function normalizeSourcePoint(x, y, bounds, sbox) {
  if (!bounds) return { x, y };
  return {
    x: sbox.x + (x - bounds.x) / bounds.w * sbox.w,
    y: sbox.y + (y - bounds.y) / bounds.h * sbox.h,
  };
}

/**
 * @param {number} x @param {number} y @param {Distort} d
 * @param {{x:number,y:number,w:number,h:number}} frame
 * @param {{x:number,y:number,w:number,h:number}} sbox
 * @param {(d: Distort, top: boolean, u: number, out: {x:number,y:number,dx:number,dy:number}) => any} evalEdge
 */
function mapPoint(x, y, d, frame, sbox, evalEdge) {
  const u = sbox.w ? (x - sbox.x) / sbox.w : 0;
  const v = sbox.h ? (y - sbox.y) / sbox.h : 0;
  evalEdge(d, true, u, edgeTop);
  evalEdge(d, false, u, edgeBot);
  mapped.x = frame.x + (edgeTop.x + (edgeBot.x - edgeTop.x) * v) * frame.w;
  mapped.y = frame.y + (edgeTop.y + (edgeBot.y - edgeTop.y) * v) * frame.h;
  return mapped;
}

/**
 * @param {string[]} out
 * @param {number} x @param {number} y @param {boolean} move
 * @param {Distort} d
 * @param {{x:number,y:number,w:number,h:number}} frame
 * @param {{x:number,y:number,w:number,h:number}} sbox
 * @param {{x:number,y:number,w:number,h:number}|null} bounds
 * @param {(d: Distort, top: boolean, u: number, out: {x:number,y:number,dx:number,dy:number}) => any} evalEdge
 */
function emit(out, x, y, move, d, frame, sbox, bounds, evalEdge) {
  const n = normalizeSourcePoint(x, y, bounds, sbox);
  const p = mapPoint(n.x, n.y, d, frame, sbox, evalEdge);
  out.push((move ? 'M' : 'L') + pnum(p.x) + ' ' + pnum(p.y));
}

/**
 * @param {TextItem} it
 * @param {TextStyle} st
 * @param {Object} o
 * @param {number} o.baseY
 * @param {number} o.measuredWidth
 * @param {{x:number,y:number,w:number,h:number}} o.frame
 * @param {{x:number,y:number,w:number,h:number}} o.sbox
 * @param {(d: Distort, top: boolean, u: number, out: {x:number,y:number,dx:number,dy:number}) => any} o.evalEdge
 * @returns {string|null}
 */
export function distortedOutlinePathData(it, st, o) {
  if (!it.text || st.warp !== 'distort' || !st.distort) return '';
  const key = `${it.text}|${it.x}|${it.y}|${it.size}|${st.font}|${st.weight}|` +
    `${o.baseY}|${o.measuredWidth}|${o.frame.x},${o.frame.y},${o.frame.w},${o.frame.h}|` +
    `${o.sbox.x},${o.sbox.y},${o.sbox.w},${o.sbox.h}|${distortSig(st.distort)}`;
  if (key === cacheKey) return cachePath;

  const cmds = outlineCommands(it.text, it.x, o.baseY, it.size,
    st.font, st.weight, o.measuredWidth);
  if (cmds === null) {
    ensureOutlineFont(st.font, st.weight);
    return null;
  }

  const out = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let open = false;
  let closed = false;
  const d = st.distort;
  const bounds = commandBounds(cmds);
  const closeSubpath = () => {
    if (!open || closed) return;
    out.push('Z');
    open = false;
    closed = true;
  };
  for (const c of cmds) {
    if (c.type === 'M') {
      closeSubpath();
      cx = sx = c.x; cy = sy = c.y;
      emit(out, cx, cy, true, d, o.frame, o.sbox, bounds, o.evalEdge);
      open = true;
      closed = false;
    } else if (c.type === 'L') {
      const n = lineSteps(cx, cy, c.x, c.y, it.size);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        emit(out, cx + (c.x - cx) * t, cy + (c.y - cy) * t,
          false, d, o.frame, o.sbox, bounds, o.evalEdge);
      }
      cx = c.x; cy = c.y;
    } else if (c.type === 'C') {
      const n = Math.max(10, lineSteps(cx, cy, c.x, c.y, it.size) * 2);
      for (let i = 1; i <= n; i++) {
        const t = i / n, mt = 1 - t;
        emit(out,
          mt * mt * mt * cx + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t * t * t * c.x,
          mt * mt * mt * cy + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t * t * t * c.y,
          false, d, o.frame, o.sbox, bounds, o.evalEdge);
      }
      cx = c.x; cy = c.y;
    } else if (c.type === 'Q') {
      const n = Math.max(8, lineSteps(cx, cy, c.x, c.y, it.size) * 2);
      for (let i = 1; i <= n; i++) {
        const t = i / n, mt = 1 - t;
        emit(out,
          mt * mt * cx + 2 * mt * t * c.x1 + t * t * c.x,
          mt * mt * cy + 2 * mt * t * c.y1 + t * t * c.y,
          false, d, o.frame, o.sbox, bounds, o.evalEdge);
      }
      cx = c.x; cy = c.y;
    } else if (c.type === 'Z') {
      out.push('Z');
      cx = sx; cy = sy;
      open = false;
      closed = true;
    }
  }
  closeSubpath();
  cacheKey = key;
  cachePath = out.join('');
  return cachePath;
}

/** @param {string} family @param {number} weight */
export function ensureDistortOutlineFont(family, weight) {
  return ensureOutlineFont(family, weight);
}
