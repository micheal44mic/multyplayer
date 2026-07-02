// GIZMO DISTORSIONE — la gabbia envelope del testo, editabile sul canvas.
// Overlay SVG fixed a tutto schermo SOPRA i piani: il root è pointer-events
// none (disegno e pan passano attraverso), solo i pallini catturano i
// pointer.

import { distortBox, bumpDistort, touchText } from './text_layer.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./text_layer.js').Distort} Distort */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @type {(keyof Distort)[]} */
const ANCHORS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br'];
/** @type {[keyof Distort, keyof Distort][]} */
const HANDLES = [
  ['htl', 'tl'], ['htcl', 'tc'], ['htcr', 'tc'], ['htr', 'tr'],
  ['hbl', 'bl'], ['hbcl', 'bc'], ['hbcr', 'bc'], ['hbr', 'br'],
];
/** @type {Partial<Record<keyof Distort, keyof Distort>>} */
const MIRROR = { htcl: 'htcr', htcr: 'htcl', hbcl: 'hbcr', hbcr: 'hbcl' };

export class DistortGizmo {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'distortgizmo');
    svg.setAttribute('aria-hidden', 'true');
    this.svg = svg;
    this.edgesEl = document.createElementNS(SVG_NS, 'path');
    this.edgesEl.setAttribute('class', 'dg-edge');
    this.spokesEl = document.createElementNS(SVG_NS, 'path');
    this.spokesEl.setAttribute('class', 'dg-spoke');
    svg.append(this.edgesEl, this.spokesEl);
    /** @type {Map<keyof Distort, SVGCircleElement>} */
    this._dots = new Map();
    for (const k of ANCHORS) this._addDot(k, 'dg-anchor');
    for (const [k] of HANDLES) this._addDot(k, 'dg-handle');
    document.body.appendChild(svg);
    this._visible = false;
    this._sig = '';
    /** @type {{key: keyof Distort, sx: number, sy: number, v0: {x: number, y: number}, box: ReturnType<typeof distortBox>}|null} */
    this._drag = null;
  }

  /** @returns {Layer|null} */
  get layer() {
    const l = this.app.layerMgr.active;
    return l && l.kind === 'text' && l.visible &&
      l.style.warp === 'distort' && l.style.distort ? l : null;
  }

  /** @param {keyof Distort} key @param {string} cls */
  _addDot(key, cls) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('r', cls === 'dg-anchor' ? '7' : '5');
    c.dataset.k = key;
    c.addEventListener('pointerdown', (e) => this._down(e, key));
    c.addEventListener('pointermove', (e) => this._move(e));
    const up = () => { this._drag = null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    this.svg.appendChild(c);
    this._dots.set(key, c);
  }

  /** @param {PointerEvent} e @param {keyof Distort} key */
  _down(e, key) {
    const l = this.layer;
    if (!l) return;
    const tgt = /** @type {SVGCircleElement} */ (e.currentTarget);
    try { tgt.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    const p = l.style.distort[key];
    this._drag = {
      key,
      sx: e.clientX, sy: e.clientY,
      v0: { x: p.x, y: p.y },
      box: distortBox(l.item, l.style),
    };
  }

  /** @param {PointerEvent} e */
  _move(e) {
    const d = this._drag, l = this.layer;
    if (!d || !l) return;
    e.preventDefault();
    const cam = this.app.camera;
    const nx = d.v0.x + (e.clientX - d.sx) / cam.zoom / d.box.w;
    const ny = d.v0.y + (e.clientY - d.sy) / cam.zoom / d.box.h;
    const p = l.style.distort[d.key];
    p.x = nx;
    p.y = ny;
    const ok = MIRROR[d.key];
    if (ok && !e.altKey) {
      const q = l.style.distort[ok];
      q.x = -nx;
      q.y = -ny;
    }
    bumpDistort(l.style);
    touchText(l);
  }

  /** @param {import('./camera.js').Camera} cam */
  sync(cam) {
    const l = this.layer;
    if (!l) {
      if (this._visible) {
        this._visible = false;
        this.svg.style.display = 'none';
        this._sig = '';
        this._drag = null;
      }
      return;
    }
    const st = l.style, it = l.item;
    const sig = `${cam.x}|${cam.y}|${cam.zoom}|${cam.w}|${cam.h}|${l.id}|` +
      `${st.distortVer ?? 0}|${it.x}|${it.y}|${it.size}|${it.text}|${st.font}|${st.weight}`;
    if (sig === this._sig && this._visible) return;
    this._sig = sig;
    if (!this._visible) {
      this._visible = true;
      this.svg.style.display = 'block';
    }
    const box = distortBox(it, st);
    const d = st.distort;
    /** @param {{x:number,y:number}} p @returns {{x:number,y:number}} */
    const S = (p) => {
      const wx = box.x + p.x * box.w, wy = box.y + p.y * box.h;
      return cam.worldToScreen(wx, wy, { x: 0, y: 0 });
    };
    /** @param {{x:number,y:number}} a @param {{x:number,y:number}} h */
    const SH = (a, h) => S({ x: a.x + h.x, y: a.y + h.y });
    const tl = S(d.tl), tc = S(d.tc), tr = S(d.tr);
    const bl = S(d.bl), bc = S(d.bc), br = S(d.br);
    const htl = SH(d.tl, d.htl), htcl = SH(d.tc, d.htcl), htcr = SH(d.tc, d.htcr), htr = SH(d.tr, d.htr);
    const hbl = SH(d.bl, d.hbl), hbcl = SH(d.bc, d.hbcl), hbcr = SH(d.bc, d.hbcr), hbr = SH(d.br, d.hbr);
    /** @param {{x:number,y:number}} p */
    const c = (p) => `${p.x} ${p.y}`;
    this.edgesEl.setAttribute('d',
      `M ${c(tl)} C ${c(htl)}, ${c(htcl)}, ${c(tc)} C ${c(htcr)}, ${c(htr)}, ${c(tr)} ` +
      `L ${c(br)} C ${c(hbr)}, ${c(hbcr)}, ${c(bc)} C ${c(hbcl)}, ${c(hbl)}, ${c(bl)} Z`);
    this.spokesEl.setAttribute('d',
      `M ${c(tl)} L ${c(htl)} M ${c(tc)} L ${c(htcl)} M ${c(tc)} L ${c(htcr)} M ${c(tr)} L ${c(htr)} ` +
      `M ${c(bl)} L ${c(hbl)} M ${c(bc)} L ${c(hbcl)} M ${c(bc)} L ${c(hbcr)} M ${c(br)} L ${c(hbr)}`);
    /** @type {Record<keyof Distort, {x: number, y: number}>} */
    const pts = { tl, tc, tr, bl, bc, br, htl, htcl, htcr, htr, hbl, hbcl, hbcr, hbr };
    for (const [k, dot] of this._dots) {
      const p = pts[k];
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
    }
  }
}
