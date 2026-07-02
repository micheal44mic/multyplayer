// TESTO VETTORIALE — vettore puro fino allo schermo: ogni livello testo è un
// piano SVG (pointer-events: none) il cui viewBox segue la camera; il browser
// rasterizza i glifi alla risoluzione del device a ogni paint, quindi il
// testo è nitido sempre — anche durante lo zoom su desktop; sul touch lo
// zoom congela il piano in texture (vedi il freeze in planes.js) e la
// nitidezza torna al rilascio. Questo modulo tiene font, stile e la
// sincronizzazione attributi; la creazione/ordinamento dei piani è del
// gestore in planes.js.

import { TextFxGL } from './text_gl.js';
import { distortedOutlinePathData, ensureDistortOutlineFont } from './text_distort_path.js';

/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */

// Font Google curati (alcuni esistono solo nel 400: il peso va dichiarato qui).
export const TEXT_FONTS = [
  { family: 'Orbitron', weight: 700 },
  { family: 'Anton', weight: 400 },
  { family: 'Bebas Neue', weight: 400 },
  { family: 'Montserrat', weight: 800 },
  { family: 'Russo One', weight: 400 },
  { family: 'Bungee', weight: 400 },
  { family: 'Press Start 2P', weight: 400 },
  { family: 'Pacifico', weight: 400 },
  { family: 'Lobster', weight: 400 },
  { family: 'Playfair Display', weight: 700 },
];

/** @type {Map<string, Promise<void>>} */
const fontLoads = new Map();

// Inietta lo stylesheet Google Fonts e forza il download del font (utile per
// l'anteprima nel menu a tendina; il testo in pagina farebbe partire il fetch
// da solo). Risolve sempre, anche offline: si resta sul fallback di sistema.
/** @param {string} family @param {number} weight @returns {Promise<void>} */
export function ensureFont(family, weight) {
  let p = fontLoads.get(family);
  if (p) return p;
  p = new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, 5000);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=' +
      family.replace(/ /g, '+') + ':wght@' + weight + '&display=swap';
    // fonts.load matcha le @font-face solo dopo il parse del CSS: si aggancia
    // all'onload del link, non si chiama subito
    link.onload = () => {
      document.fonts.load(`${weight} 64px "${family}"`).then(done, done);
    };
    link.onerror = done;
    document.head.appendChild(link);
  });
  fontLoads.set(family, p);
  return p;
}

// Colore ombra: l'input color dà un hex pieno, l'alpha la decide lo stile.
/** @param {string} hex @param {number} [a] */
export function shadowCss(hex, a = 1) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Stile del testo. Le misure sono in px mondo: scalano con lo zoom.
 * @typedef {Object} TextStyle
 * @property {string} font
 * @property {number} weight
 * @property {number} stroke larghezza bordo (px mondo, 0 = niente)
 * @property {string} strokeColor
 * @property {boolean} block ombra a blocco 3D: estrusione solida invece dell'ombra morbida
 * @property {number} shadowBlur sfocatura ombra (px mondo, 0 = niente)
 * @property {number} shadowDist distanza ombra (px mondo)
 * @property {number} shadowAngle direzione ombra in gradi (0 = destra, 90 = giù)
 * @property {string} shadowColor
 * @property {'none'|'arc'|'circle'|'wave'|'distort'} warp trasformazione del tracciato
 * @property {number} warpBend arco: curvatura totale in gradi (>0 verso l'alto)
 * @property {number} warpRadius cerchio: raggio in px mondo (0 = auto, cerchio pieno)
 * @property {number} warpAmp onda: ampiezza in px mondo
 * @property {number} warpFreq onda: numero di onde sull'intero testo
 * @property {Distort} [distort] gabbia della distorsione (creata al primo uso)
 * @property {number} [distortVer] timbro monotono: cambia a ogni modifica della gabbia
 * @property {{x:number,y:number,w:number,h:number,vBase:number}} [distortFrame]
 *   frame congelato della gabbia in unità di corpo, relativo a item.x/y
 */

/**
 * Gabbia di distorsione stile envelope: coordinate normalizzate alla bbox del
 * testo non deformato. Il renderer Distort converte i glifi in outline SVG e
 * deforma i punti del path dentro questa gabbia.
 * @typedef {Object} Distort
 * @property {{x:number,y:number}} tl @property {{x:number,y:number}} tc @property {{x:number,y:number}} tr
 * @property {{x:number,y:number}} bl @property {{x:number,y:number}} bc @property {{x:number,y:number}} br
 * @property {{x:number,y:number}} htl @property {{x:number,y:number}} htcl @property {{x:number,y:number}} htcr @property {{x:number,y:number}} htr
 * @property {{x:number,y:number}} hbl @property {{x:number,y:number}} hbcl @property {{x:number,y:number}} hbcr @property {{x:number,y:number}} hbr
 */

/** @returns {Distort} */
export function defaultDistort() {
  const H = 1 / 6;
  return {
    tl: { x: 0, y: 0 }, tc: { x: 0.5, y: 0 }, tr: { x: 1, y: 0 },
    bl: { x: 0, y: 1 }, bc: { x: 0.5, y: 1 }, br: { x: 1, y: 1 },
    htl: { x: H, y: 0 }, htcl: { x: -H, y: 0 }, htcr: { x: H, y: 0 }, htr: { x: -H, y: 0 },
    hbl: { x: H, y: 0 }, hbcl: { x: -H, y: 0 }, hbcr: { x: H, y: 0 }, hbr: { x: -H, y: 0 },
  };
}

let _distortStamp = 0;

/** @param {TextStyle} st */
export function bumpDistort(st) {
  st.distortVer = ++_distortStamp;
}

/**
 * @typedef {Object} TextItem
 * @property {string} text
 * @property {number} x centro in coordinate mondo
 * @property {number} y
 * @property {number} size corpo del font in px mondo
 * @property {string} fill
 */

/** @returns {TextStyle} */
export function defaultTextStyle() {
  return {
    font: 'Orbitron', weight: 700,
    stroke: 0, strokeColor: '#ffffff',
    block: false, shadowBlur: 0, shadowDist: 0, shadowAngle: 45,
    shadowColor: '#000000',
    // raggio/ampiezza a 0 = "da proporzionare al testo": li inizializza il
    // pannello al primo uso della forma, poi restano editabili
    warp: 'none', warpBend: 90, warpRadius: 0, warpAmp: 0, warpFreq: 2,
  };
}

// Direzione dell'ombra come versore (gradi -> cos/sin; ?? per stili nati
// prima dell'angolo, vivi solo dentro la stessa sessione).
/** @param {TextStyle} st */
function shadowDir(st) {
  const rad = (st.shadowAngle ?? 45) * Math.PI / 180;
  return { ux: Math.cos(rad), uy: Math.sin(rad) };
}

/** @param {TextItem} it @param {TextStyle} st */
function textFont(it, st) {
  return `${st.weight} ${it.size}px "${st.font}", sans-serif`;
}

/**
 * item.y resta il centro visivo del testo. Per evitare le differenze fra
 * SVG central/middle e Canvas middle, entrambi disegnano su baseline alfabetica.
 * @param {TextItem} it @param {TextStyle} st
 */
export function textBaselineY(it, st) {
  measurer.font = textFont(it, st);
  measurer.textBaseline = 'alphabetic';
  const m = measurer.measureText(it.text || 'M');
  const asc = m.actualBoundingBoxAscent || it.size * 0.75;
  const des = m.actualBoundingBoxDescent || it.size * 0.25;
  return it.y + (asc - des) * 0.5;
}

/** Larghezza misurata del testo in px mondo (fallback per-carattere se il font non è pronto). */
/** @param {TextItem} it @param {TextStyle} st */
export function textWidth(it, st) {
  measurer.font = textFont(it, st);
  return Math.max(measurer.measureText(it.text).width, it.text.length * it.size * 0.8);
}

/** @param {TextItem} it @param {TextStyle} st */
function _distortInkBox(it, st) {
  measurer.font = textFont(it, st);
  measurer.textAlign = 'center';
  const m = measurer.measureText(it.text || 'M');
  measurer.textAlign = 'start';
  const asc = m.actualBoundingBoxAscent || it.size * 0.75;
  const desc = m.actualBoundingBoxDescent || it.size * 0.25;
  const half = textWidth(it, st) / 2;
  const left = m.actualBoundingBoxLeft || half;
  const right = m.actualBoundingBoxRight || half;
  const baseY = textBaselineY(it, st);
  return {
    x: it.x - left, y: baseY - asc,
    w: left + right, h: asc + desc,
    vBase: asc / (asc + desc),
  };
}

/** @param {TextItem} it @param {TextStyle} st */
export function distortBox(it, st) {
  const f = st.distortFrame;
  if (f) {
    return {
      x: it.x + f.x * it.size, y: it.y + f.y * it.size,
      w: f.w * it.size, h: f.h * it.size, vBase: f.vBase,
    };
  }
  const live = _distortInkBox(it, st);
  st.distortFrame = {
    x: (live.x - it.x) / it.size, y: (live.y - it.y) / it.size,
    w: live.w / it.size, h: live.h / it.size, vBase: live.vBase,
  };
  return live;
}

const DISTORT_COLS = 48;
const DISTORT_ROWS = 18;

/** @param {TextStyle} st */
function distortOn(st) {
  return st.warp === 'distort' && !!st.distort;
}

/**
 * @param {{x:number,y:number}} p0 @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2 @param {{x:number,y:number}} p3
 * @param {number} t @param {{x:number,y:number,dx:number,dy:number}} out
 */
function evalCubic(p0, p1, p2, p3, t, out) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
  const da = 3 * mt * mt, db = 6 * mt * t, dc = 3 * t * t;
  out.x = a * p0.x + b * p1.x + c * p2.x + e * p3.x;
  out.y = a * p0.y + b * p1.y + c * p2.y + e * p3.y;
  out.dx = da * (p1.x - p0.x) + db * (p2.x - p1.x) + dc * (p3.x - p2.x);
  out.dy = da * (p1.y - p0.y) + db * (p2.y - p1.y) + dc * (p3.y - p2.y);
  return out;
}

const _ec1 = { x: 0, y: 0 }, _ec2 = { x: 0, y: 0 };
/** @param {{x:number,y:number}} p @param {{x:number,y:number}} h @param {{x:number,y:number}} out */
function _addH(p, h, out) { out.x = p.x + h.x; out.y = p.y + h.y; return out; }

/**
 * @param {Distort} d @param {boolean} top @param {number} u
 * @param {{x:number,y:number,dx:number,dy:number}} out
 */
function evalEdge(d, top, u, out) {
  const a = top ? d.tl : d.bl, c = top ? d.tc : d.bc, b = top ? d.tr : d.br;
  const ha = top ? d.htl : d.hbl, hcl = top ? d.htcl : d.hbcl;
  const hcr = top ? d.htcr : d.hbcr, hb = top ? d.htr : d.hbr;
  const uc = Math.max(0, Math.min(1, u));
  if (uc <= 0.5) evalCubic(a, _addH(a, ha, _ec1), _addH(c, hcl, _ec2), c, uc * 2, out);
  else evalCubic(c, _addH(c, hcr, _ec1), _addH(b, hb, _ec2), b, uc * 2 - 1, out);
  out.dx *= 2;
  out.dy *= 2;
  if (u !== uc) {
    out.x += out.dx * (u - uc);
    out.y += out.dy * (u - uc);
  }
  return out;
}

/** Public preloader used by the text panel. @param {string} family @param {number} weight */
export function ensureTextOutlineFont(family, weight) {
  return ensureDistortOutlineFont(family, weight);
}

/** @param {TextItem} it @param {TextStyle} st */
function textDistortPathData(it, st) {
  return distortedOutlinePathData(it, st, {
    baseY: textBaselineY(it, st),
    measuredWidth: textWidth(it, st),
    frame: distortBox(it, st),
    sbox: _distortInkBox(it, st),
    evalEdge,
  });
}

/** @param {TextItem} it @param {TextStyle} st */
function _distortMargin(it, st) {
  return st.stroke + it.size * 0.08 + 2;
}

/** @param {TextItem} it @param {TextStyle} st */
function distortHull(it, st) {
  const frame = distortBox(it, st);
  const sbox = _distortInkBox(it, st);
  const m = _distortMargin(it, st);
  const d = st.distort || defaultDistort();
  const v0 = -m / sbox.h, v1 = 1 + m / sbox.h;
  const u0 = -m / sbox.w, u1 = 1 + m / sbox.w;
  const eT = { x: 0, y: 0, dx: 0, dy: 0 };
  const eB = { x: 0, y: 0, dx: 0, dy: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let r = 0; r <= DISTORT_ROWS; r++) {
    const v = v0 + (v1 - v0) * r / DISTORT_ROWS;
    for (let c = 0; c <= DISTORT_COLS; c++) {
      const u = u0 + (u1 - u0) * c / DISTORT_COLS;
      evalEdge(d, true, u, eT);
      evalEdge(d, false, u, eB);
      const px = frame.x + (eT.x + (eB.x - eT.x) * v) * frame.w;
      const py = frame.y + (eT.y + (eB.y - eT.y) * v) * frame.h;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py);
      x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  }
  const sl = (x1 - x0 + y1 - y0) * 0.02 + 2;
  return { x: x0 - sl, y: y0 - sl, w: Math.max(1, x1 - x0 + sl * 2), h: Math.max(1, y1 - y0 + sl * 2) };
}

/** @param {TextItem} it @param {TextStyle} st */
function distortBlockBox(it, st) {
  const face = distortHull(it, st);
  const { ux, uy } = shadowDir(st);
  const effectOn = st.block ? st.shadowDist > 0 : (st.shadowBlur > 0 || st.shadowDist > 0);
  const ddx = effectOn ? ux * st.shadowDist : 0;
  const ddy = effectOn ? uy * st.shadowDist : 0;
  const pad = (effectOn ? st.shadowBlur * 1.5 : 0) + 2;
  const x0 = Math.min(face.x, face.x + ddx) - pad;
  const y0 = Math.min(face.y, face.y + ddy) - pad;
  const x1 = Math.max(face.x + face.w, face.x + face.w + ddx) + pad;
  const y1 = Math.max(face.y + face.h, face.y + face.h + ddy) + pad;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** @param {TextStyle} st @returns {'none'|'arc'|'circle'|'wave'} */
function warpMode(st) {
  const mode = st.warp ?? 'none';
  return mode === 'arc' || mode === 'circle' || mode === 'wave' ? mode : 'none';
}

// ---- trasformazioni del tracciato (arco / cerchio / onda) -----------------
// Un layout per-glifo condiviso da TUTTE le rese: SVG (tspan x/y/rotate),
// effetti canvas ed export disegnano gli stessi numeri, quindi combaciano al
// pixel. Ogni glifo è ancorato alla SUA origine (baseline a sinistra): è il
// pivot di rotazione sia di `rotate` negli SVG sia di translate+rotate nei
// canvas. Il centro dell'avanzamento del glifo giace sulla curva, col glifo
// ruotato lungo la tangente. Le spaziature non si disegnano ma avanzano.

/**
 * @typedef {Object} WarpGlyph
 * @property {string} ch
 * @property {number} x origine (baseline sinistra) in px mondo
 * @property {number} y
 * @property {number} a rotazione in radianti
 * @property {number} w avanzamento del glifo in px mondo
 */

// Memo a una voce: il layout serve a sync SVG, blockBox e renderEffectInto
// nello stesso giro; la chiave include lo stato del font (le metriche col
// fallback differiscono).
let _wlKey = '';
/** @type {WarpGlyph[]|null} */
let _wlVal = null;

/** @param {TextItem} it @param {TextStyle} st @returns {WarpGlyph[]|null} null = testo dritto */
export function warpLayout(it, st) {
  const mode = warpMode(st);
  if (mode === 'none' || !it.text) return null;
  const ready = document.fonts.check(`${st.weight} 16px "${st.font}"`) ? 1 : 0;
  const key = `${it.text}|${it.x}|${it.y}|${it.size}|${st.font}|${st.weight}|${mode}|` +
    `${st.warpBend ?? 0}|${st.warpRadius ?? 0}|${st.warpAmp ?? 0}|${st.warpFreq ?? 0}|F${ready}`;
  if (key === _wlKey) return _wlVal;
  const chars = [...it.text];
  measurer.font = textFont(it, st);
  const adv = chars.map((c) => measurer.measureText(c).width);
  const total = adv.reduce((a, b) => a + b, 0);
  let R = 0;
  if (total <= 0) {
    _wlKey = key;
    return (_wlVal = null);
  }
  if (mode === 'arc') {
    const rad = (st.warpBend ?? 0) * Math.PI / 180;
    if (Math.abs(rad) < 0.01) { _wlKey = key; return (_wlVal = null); }
    R = total / rad;
  } else if (mode === 'circle') {
    // mai sotto il giro completo: i glifi non si accavallano oltre i 360°
    R = Math.max(st.warpRadius || 0, total / (2 * Math.PI));
  }
  const baseY = textBaselineY(it, st);
  const amp = st.warpAmp || 0;
  const omega = 2 * Math.PI * Math.max(0.1, st.warpFreq ?? 2) / total;
  /** @type {WarpGlyph[]} */
  const out = [];
  let s = -total / 2; // ascissa curvilinea, 0 al centro del testo
  for (let i = 0; i < chars.length; i++) {
    const w = adv[i];
    const sm = s + w / 2;
    s += w;
    if (chars[i].trim() === '') continue;
    let px, py, a;
    if (mode === 'wave') {
      px = it.x + sm;
      py = baseY + amp * Math.sin(omega * sm);
      a = Math.atan(amp * omega * Math.cos(omega * sm));
    } else {
      // arco e cerchio: curva per (it.x, baseY) con centro a distanza R sotto;
      // R negativo (arco in giù) torna dalle stesse formule
      const phi = sm / R;
      px = it.x + R * Math.sin(phi);
      py = baseY + R * (1 - Math.cos(phi));
      a = phi;
    }
    out.push({ ch: chars[i], x: px - Math.cos(a) * w / 2, y: py - Math.sin(a) * w / 2, a, w });
  }
  _wlKey = key;
  return (_wlVal = out.length ? out : null);
}

// Una passata di testo (bordo O fill) su un contesto 2D già configurato
// (font, baseline, stili): dritta in una chiamata, deformata glifo per
// glifo. ox/oy traslano in px mondo (corsa dell'estrusione, origine export).
/**
 * @param {CanvasRenderingContext2D} ctx @param {TextItem} it
 * @param {WarpGlyph[]|null} layout @param {number} baseY
 * @param {boolean} stroke @param {number} [ox] @param {number} [oy]
 */
export function drawTextPass(ctx, it, layout, baseY, stroke, ox = 0, oy = 0) {
  if (!layout) {
    ctx.textAlign = 'center';
    if (stroke) ctx.strokeText(it.text, it.x + ox, baseY + oy);
    else ctx.fillText(it.text, it.x + ox, baseY + oy);
    return;
  }
  ctx.textAlign = 'left';
  for (const g of layout) {
    ctx.save();
    ctx.translate(g.x + ox, g.y + oy);
    ctx.rotate(g.a);
    if (stroke) ctx.strokeText(g.ch, 0, 0);
    else ctx.fillText(g.ch, 0, 0);
    ctx.restore();
  }
}

// EFFETTI (estrusione 3D e ombra morbida) — rasterizzati su un canvas HTML
// persistente, ancorato in coordinate mondo e posizionato con un transform
// CSS: durante pan/zoom il compositor scala solo una texture. Un filtro
// CSS/SVG (il vecchio drop-shadow dell'ombra morbida) verrebbe invece
// rieseguito a ogni frame di zoom, a risoluzione device: ingestibile.
// Mentre un gesto è in corso (slider, tastiera) si rigenerano ANTEPRIME a
// metà risoluzione e passo largo; la qualità piena arriva a gesto fermo.
// Niente toBlob/PNG: si disegna nel canvas mostrato, zero encode/decode.

/** @param {number} x @param {number} y @param {string} fill @param {number} size @returns {TextItem} */
export function makeTextItem(x, y, fill, size) {
  return { text: 'M1M4.COM', x, y, size, fill };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Crea il piano SVG di un livello testo e il canvas del suo effetto (li
// possiede planes.js, che li inserisce adiacenti: canvas sotto, svg sopra).
// La geometria vive UNA volta in <defs><text>: il testo visibile è uno <use>
// che la riferisce — fill/stroke arrivano per eredità perché la sorgente non
// li dichiara.
/** @param {Layer} layer */
export function createTextSvg(layer) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'textplane');
  svg.setAttribute('aria-hidden', 'true');
  // il viewBox ha lo stesso aspect del viewport: 'none' evita letterbox
  // da arrotondamenti e mappa mondo -> schermo esattamente come la camera
  svg.setAttribute('preserveAspectRatio', 'none');
  // origine in alto a sinistra per il freeze dello zoom touch (planes.js
  // scala il piano già dipinto col compositor invece di ridipingerlo)
  svg.style.transformOrigin = '0 0';
  const defs = document.createElementNS(SVG_NS, 'defs');
  // la sorgente è un <g>: font e baseline si ereditano dal <text> unico e
  // dai <tspan> per-glifo di arco/cerchio/onda.
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('id', 'tsrc' + layer.id); // id unico nel documento
  g.setAttribute('dominant-baseline', 'alphabetic');
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('text-anchor', 'middle');
  g.appendChild(t);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill-rule', 'nonzero');
  defs.appendChild(g);
  const sf = document.createElementNS(SVG_NS, 'filter');
  sf.setAttribute('id', 'tshadow' + layer.id);
  sf.setAttribute('filterUnits', 'userSpaceOnUse');
  const sb = document.createElementNS(SVG_NS, 'feGaussianBlur');
  sf.appendChild(sb);
  defs.appendChild(sf);
  // maschera al board: rect in coordinate mondo (il viewBox È il mondo,
  // quindi vale a ogni pan/zoom e anche col freeze touch, che trasforma
  // l'intero svg). Lo aggiorna syncTextClip quando il board cambia rettangolo.
  const cp = document.createElementNS(SVG_NS, 'clipPath');
  cp.setAttribute('id', 'tclip' + layer.id); // id unico nel documento
  cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
  const cr = document.createElementNS(SVG_NS, 'rect');
  cp.appendChild(cr);
  defs.appendChild(cp);
  const main = document.createElementNS(SVG_NS, 'use');
  main.setAttribute('href', '#tsrc' + layer.id);
  main.setAttribute('clip-path', `url(#tclip${layer.id})`);
  // il bordo è sotto il fill (paint-order): stroke centrato largo il doppio,
  // la metà interna è coperta -> bordo "esterno" come nei programmi di grafica
  main.setAttribute('paint-order', 'stroke');
  main.setAttribute('stroke-linejoin', 'round');
  const fx = document.createElementNS(SVG_NS, 'g');
  fx.setAttribute('clip-path', `url(#tclip${layer.id})`);
  fx.setAttribute('paint-order', 'stroke');
  fx.setAttribute('stroke-linejoin', 'round');
  svg.append(defs, fx, main);
  // canvas dell'effetto: dimensionato/posizionato a ogni rigenerazione.
  // Stili inline per vincere su `#planes > *` (inset/width/height 100%);
  // will-change lo tiene su un layer compositor suo: pan/zoom non
  // ridipingono mai questi pixel
  const cnv = document.createElement('canvas');
  cnv.className = 'fxplane';
  cnv.setAttribute('aria-hidden', 'true');
  cnv.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;' +
    'transform-origin:0 0;will-change:transform;display:none;';
  layer.svg = svg;
  layer.srcEl = g;
  layer.textEl = t;
  layer.pathEl = path;
  layer.shadowFilterEl = sf;
  layer.shadowBlurEl = sb;
  layer.hardShadowEl = fx;
  layer.blockCanvas = cnv;
  layer.mainEl = main;
  layer.clipRectEl = cr;
  layer.clipKey = '';
  layer.blockClipKey = '';
  layer.outlineFaceOn = false;
  layer.svgHardShadowOn = false;
  layer.styleDirty = true;
  return svg;
}

// Misuratore condiviso per l'ingombro del testo (mai nel path per-frame).
const measurer = document.createElement('canvas').getContext('2d');

// Ingombro mondo dell'effetto: testo + corsa di estrusione/ombra + margine
// blur. La larghezza misurata può essere corta se il font non è ancora
// pronto: il fallback per-carattere tiene il box abbondante.
/** @param {TextItem} it @param {TextStyle} st */
export function blockBox(it, st) {
  if (distortOn(st)) return distortBlockBox(it, st);
  const pad = st.shadowBlur * 1.5 + 2;
  // la corsa dell'effetto estende il box solo dal lato verso cui punta
  const { ux, uy } = shadowDir(st);
  const ddx = ux * st.shadowDist, ddy = uy * st.shadowDist;
  const layout = warpLayout(it, st);
  let x0, y0, x1, y1;
  if (layout) {
    // estremi delle origini e dei fine-avanzamento dei glifi, con un margine
    // uniforme che copre ascendenti/discendenti a qualunque rotazione
    const m = it.size * 1.05 + st.stroke;
    x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
    for (const g of layout) {
      const ex = g.x + Math.cos(g.a) * g.w, ey = g.y + Math.sin(g.a) * g.w;
      x0 = Math.min(x0, g.x, ex); x1 = Math.max(x1, g.x, ex);
      y0 = Math.min(y0, g.y, ey); y1 = Math.max(y1, g.y, ey);
    }
    x0 -= m; y0 -= m; x1 += m; y1 += m;
  } else {
    const hw = textWidth(it, st) / 2 + st.stroke + it.size * 0.15;
    const hh = it.size * 0.9 + st.stroke;
    x0 = it.x - hw; x1 = it.x + hw;
    y0 = it.y - hh; y1 = it.y + hh;
  }
  return {
    x: x0 - pad + Math.min(0, ddx),
    y: y0 - pad + Math.min(0, ddy),
    w: (x1 - x0) + Math.abs(ddx) + pad * 2,
    h: (y1 - y0) + Math.abs(ddy) + pad * 2,
  };
}

// Disegna l'effetto nel canvas dato a `r` px bitmap per px mondo.
// Blocco 3D: copie a passo ~stepDev px DEVICE (lisce a quella scala), bordo
// incluso nella sagoma; ombra morbida: una sola copia alla distanza piena.
// Il blur usa l'ombra di un drawImage (ctx.filter manca su alcuni Safari)
// via `scratch`, sulla sagoma già fusa: niente sovrapposizioni che
// scuriscono. Colore pieno: l'alpha la mette l'elemento (o l'export),
// uniforme. Ritorna il numero di copie (per la diagnostica).
/**
 * @param {HTMLCanvasElement} cnv @param {HTMLCanvasElement} scratch
 * @param {TextItem} it @param {TextStyle} st @param {number} r
 * @param {ReturnType<typeof blockBox>} box @param {number} stepDev
 */
function renderEffectInto(cnv, scratch, it, st, r, box, stepDev) {
  const cw = Math.max(1, Math.round(box.w * r));
  const ch = Math.max(1, Math.round(box.h * r));
  const blur = st.shadowBlur > 0;
  // i canvas sono riusati fra le rigenerazioni: si ridimensiona (= rialloca)
  // solo se serve, altrimenti basta pulire
  const base = blur ? scratch : cnv;
  if (base.width !== cw || base.height !== ch) { base.width = cw; base.height = ch; }
  const ctx = base.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowColor = 'rgba(0,0,0,0)'; // stato residuo di un uso precedente
  ctx.clearRect(0, 0, cw, ch);
  ctx.scale(r, r);
  ctx.translate(-box.x, -box.y);
  ctx.font = textFont(it, st);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.fillStyle = st.shadowColor;
  ctx.strokeStyle = st.shadowColor;
  ctx.lineWidth = st.stroke * 2;
  const n = st.block
    ? Math.max(1, Math.min(400, Math.ceil(st.shadowDist * r / stepDev)))
    : 1;
  const { ux, uy } = shadowDir(st);
  const sx = ux * st.shadowDist / n, sy = uy * st.shadowDist / n;
  // SVG e Canvas usano entrambi la baseline alfabetica di textBaselineY();
  // non correggerla con getBBox(): sugli SVG <text> descrive una scatola
  // font/logica, non il contorno visivo dei pixel.
  const by = textBaselineY(it, st);
  const layout = warpLayout(it, st);
  // Si parte da 1: i=0 è la faccia frontale, già coperta dal testo SVG.
  // Disegnarla anche nella bitmap crea un alone/offset apparente sopra il fill.
  for (let i = 1; i <= n; i++) {
    if (st.stroke > 0) drawTextPass(ctx, it, layout, by, true, sx * i, sy * i);
    drawTextPass(ctx, it, layout, by, false, sx * i, sy * i);
  }
  if (blur) {
    if (cnv.width !== cw || cnv.height !== ch) { cnv.width = cw; cnv.height = ch; }
    const x2 = cnv.getContext('2d');
    x2.setTransform(1, 0, 0, 1, 0, 0);
    x2.clearRect(0, 0, cw, ch);
    x2.shadowColor = st.shadowColor;
    x2.shadowBlur = st.shadowBlur * r;
    x2.shadowOffsetX = cw + ch; // la sorgente sta fuori, in vista solo l'ombra
    x2.drawImage(base, -(cw + ch), 0);
    x2.shadowColor = 'rgba(0,0,0,0)'; // il canvas può fare da `base` dopo
    x2.shadowBlur = 0;
    x2.shadowOffsetX = 0;
  }
  return n;
}

// Variante one-shot per l'export: disegna l'effetto su un canvas NUOVO alla
// risoluzione richiesta e lo restituisce col suo ingombro mondo.
/** @param {TextItem} it @param {TextStyle} st @param {number} r @param {ReturnType<typeof blockBox>} [box] */
export function renderBlockCanvas(it, st, r, box = blockBox(it, st)) {
  const cnv = document.createElement('canvas');
  renderEffectInto(cnv, document.createElement('canvas'), it, st, r, box, FULL_STEP);
  return { canvas: cnv, box };
}

/** @param {TextStyle} st */
function textFxOn(st) {
  return st.block ? st.shadowDist > 0 : (st.shadowBlur > 0 || st.shadowDist > 0);
}

/** @param {CanvasRenderingContext2D} ctx @param {Path2D} path @param {TextStyle} st */
function fillShadowPath(ctx, path, st) {
  ctx.lineJoin = 'round';
  if (st.stroke > 0) {
    ctx.strokeStyle = st.shadowColor;
    ctx.lineWidth = st.stroke * 2;
    ctx.stroke(path);
  }
  ctx.fillStyle = st.shadowColor;
  ctx.fill(path);
}

/**
 * @param {CanvasRenderingContext2D} ctx @param {Path2D} path
 * @param {TextStyle} st @param {number} x0 @param {number} y0
 * @param {number} alpha @param {number} effectScaleX @param {number} effectScaleY
 */
function drawPathShadow(ctx, path, st, x0, y0, alpha, effectScaleX, effectScaleY) {
  if (!textFxOn(st)) return;
  const { ux, uy } = shadowDir(st);
  const n = st.block ? Math.max(1, Math.min(160, Math.ceil(st.shadowDist))) : 1;
  const blurScale = Math.max(Math.abs(effectScaleX), Math.abs(effectScaleY));
  ctx.save();
  ctx.translate(-x0, -y0);
  ctx.globalAlpha = alpha;
  if (!st.block && st.shadowBlur > 0) {
    ctx.shadowColor = st.shadowColor;
    ctx.shadowBlur = st.shadowBlur * blurScale;
    ctx.shadowOffsetX = ux * st.shadowDist * effectScaleX;
    ctx.shadowOffsetY = uy * st.shadowDist * effectScaleY;
    fillShadowPath(ctx, path, st);
  } else {
    for (let i = 1; i <= n; i++) {
      const t = st.block ? i / n : 1;
      ctx.save();
      ctx.translate(ux * st.shadowDist * t, uy * st.shadowDist * t);
      fillShadowPath(ctx, path, st);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {Path2D} path @param {TextItem} it @param {TextStyle} st @param {number} x0 @param {number} y0 @param {number} alpha */
function drawPathFace(ctx, path, it, st, x0, y0, alpha) {
  ctx.save();
  ctx.translate(-x0, -y0);
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  if (st.stroke > 0) {
    ctx.strokeStyle = st.strokeColor;
    ctx.lineWidth = st.stroke * 2;
    ctx.stroke(path);
  }
  ctx.fillStyle = it.fill;
  ctx.fill(path);
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {TextItem} it @param {TextStyle} st @param {number} x0 @param {number} y0 @param {number} alpha @param {number} effectScaleX @param {number} effectScaleY */
function drawVectorDistortDocument(ctx, it, st, x0, y0, alpha, effectScaleX, effectScaleY) {
  const d = textDistortPathData(it, st);
  if (d === null || typeof Path2D !== 'function') return false;
  const path = new Path2D(d);
  drawPathShadow(ctx, path, st, x0, y0, alpha, effectScaleX, effectScaleY);
  drawPathFace(ctx, path, it, st, x0, y0, alpha);
  ctx.globalAlpha = 1;
  return true;
}

// Disegna il livello testo COMPLETO (effetto + faccia, stessa resa dell'SVG)
// nel contesto dato, a 1 px canvas = 1 px mondo, con origine mondo (x0,y0).
// One-shot a qualità piena, ignora camera e cache live: è il renderer
// dell'export PNG e della rasterizzazione del livello. `alpha` è l'opacità
// del livello da cuocere nei pixel (l'export la cuoce, la rasterizzazione
// no: resta proprietà del livello raster).
/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {TextItem} it @param {TextStyle} st
 * @param {number} x0 @param {number} y0 @param {number} [alpha]
 * @param {number} [effectScaleX] px canvas per px mondo del target corrente
 * @param {number} [effectScaleY]
 */
export function drawTextDocument(ctx, it, st, x0, y0, alpha = 1, effectScaleX = 1, effectScaleY = effectScaleX) {
  const blurScale = Math.max(Math.abs(effectScaleX), Math.abs(effectScaleY));
  if (distortOn(st)) {
    drawVectorDistortDocument(ctx, it, st, x0, y0, alpha, effectScaleX, effectScaleY);
    return;
  }
  ctx.globalAlpha = alpha;
  ctx.font = textFont(it, st);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const layout = warpLayout(it, st);
  const by = textBaselineY(it, st);
  const block3d = st.block && st.shadowDist > 0;
  // anche l'ombra morbida del testo deformato passa dalla bitmap: glifo
  // per glifo le ombre di ctx.shadow* si sovrapporrebbero scurendosi
  const bitmapFx = block3d ||
    (layout && (st.shadowBlur > 0 || st.shadowDist > 0));
  if (bitmapFx) {
    // stesso renderer della bitmap live, alla risoluzione del documento;
    // opacità dell'ombra in un colpo solo (l'overlap non scurisce)
    const blk = renderBlockCanvas(it, st, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(blk.canvas, blk.box.x - x0, blk.box.y - y0);
    ctx.restore();
  } else if (st.shadowBlur > 0 || st.shadowDist > 0) {
    const rad = (st.shadowAngle ?? 45) * Math.PI / 180;
    ctx.shadowColor = shadowCss(st.shadowColor, 1);
    ctx.shadowBlur = st.shadowBlur * blurScale;
    ctx.shadowOffsetX = Math.cos(rad) * st.shadowDist * effectScaleX;
    ctx.shadowOffsetY = Math.sin(rad) * st.shadowDist * effectScaleY;
  }
  if (st.stroke > 0) {
    ctx.strokeStyle = st.strokeColor;
    ctx.lineWidth = st.stroke * 2;
    drawTextPass(ctx, it, layout, by, true, -x0, -y0);
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.fillStyle = it.fill;
    drawTextPass(ctx, it, layout, by, false, -x0, -y0);
  } else {
    ctx.fillStyle = it.fill;
    drawTextPass(ctx, it, layout, by, false, -x0, -y0);
    ctx.shadowColor = 'rgba(0,0,0,0)';
  }
  ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  ctx.globalAlpha = 1;
}

/** @param {Layer} layer @param {boolean} on */
function syncSvgShadowFilter(layer, on) {
  const fx = layer.hardShadowEl;
  const filter = layer.shadowFilterEl;
  const blurEl = layer.shadowBlurEl;
  if (!fx || !filter || !blurEl) return;
  if (!on) {
    fx.removeAttribute('filter');
    return;
  }
  const box = blockBox(layer.item, layer.style);
  filter.setAttribute('x', String(box.x));
  filter.setAttribute('y', String(box.y));
  filter.setAttribute('width', String(box.w));
  filter.setAttribute('height', String(box.h));
  blurEl.setAttribute('stdDeviation', String(layer.style.shadowBlur || 0));
  fx.setAttribute('filter', `url(#tshadow${layer.id})`);
}

/** @param {Layer} layer @param {boolean} sourceVisible @param {boolean} [allowBlur] */
function syncSvgHardShadow(layer, sourceVisible, allowBlur = false) {
  const fx = layer.hardShadowEl;
  if (!fx) return;
  const st = layer.style;
  const it = layer.item;
  const blur = st.shadowBlur || 0;
  const canBlur = allowBlur && blur > 0;
  const hardShadow = sourceVisible && it.text.length > 0 &&
    (allowBlur || blur <= 0) &&
    (st.block ? st.shadowDist > 0 : (st.shadowDist > 0 || canBlur));
  if (!hardShadow) {
    if (layer.svgHardShadowOn) fx.replaceChildren();
    fx.style.display = 'none';
    syncSvgShadowFilter(layer, false);
    layer.svgHardShadowOn = false;
    layer.svgHardShadowKey = '';
    return;
  }
  fx.style.display = '';
  syncSvgShadowFilter(layer, canBlur);
  fx.setAttribute('opacity', '1');
  fx.setAttribute('fill', st.shadowColor);
  if (st.stroke > 0) {
    fx.setAttribute('stroke', st.shadowColor);
    fx.setAttribute('stroke-width', String(st.stroke * 2));
  } else {
    fx.removeAttribute('stroke');
    fx.removeAttribute('stroke-width');
  }
  const { ux, uy } = shadowDir(st);
  const dx = ux * st.shadowDist, dy = uy * st.shadowDist;
  const n = st.block ? Math.max(1, Math.min(160, Math.ceil(st.shadowDist))) : 1;
  const wantKey = `${st.block ? 'B' : 'S'}|${n}|` +
    `${st.shadowDist}|${st.shadowAngle ?? 45}|${st.shadowColor}|${st.stroke}|` +
    `${blur}|${allowBlur ? 'V' : 'H'}|${layer.id}`;
  if (layer.svgHardShadowKey === wantKey) {
    layer.svgHardShadowOn = true;
    return;
  }
  layer.svgHardShadowKey = wantKey;
  fx.replaceChildren();
  const copies = n;
  for (let i = 1; i <= copies; i++) {
    const t = st.block ? i / copies : 1;
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#tsrc' + layer.id);
    u.setAttribute('transform', `translate(${dx * t} ${dy * t})`);
    fx.appendChild(u);
  }
  layer.svgHardShadowOn = true;
}

// Applica item + stile + visibilità/opacità del livello agli attributi SVG
// e all'opacità del canvas dell'effetto (che cambia live, senza rigenerare).
// Ogni modifica visibile di un testo passa da qui: styleDirty risincronizza
// l'SVG, ver invalida la contentKey del proxy zoom-out (il quad cuoce anche
// il testo e deve rinascere quando il testo cambia).
/** @param {import('./layers.js').Layer} layer */
export function touchText(layer) {
  layer.styleDirty = true;
  layer.ver = (layer.ver | 0) + 1;
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('fablepaint:dirty'));
}

/** @param {Layer} layer */
export function syncTextSvg(layer) {
  const it = layer.item, t = layer.textEl, st = layer.style;
  const main = layer.mainEl, src = layer.srcEl;
  if (!t) return;
  layer.svg.style.display = layer.visible && layer.opacity > 0 ? 'block' : 'none';
  layer.svg.style.opacity = String(layer.opacity);
  const isDistort = distortOn(st);
  const layout = isDistort ? null : warpLayout(it, st);
  let sourceVisible = !isDistort;
  if (isDistort) {
    const d = textDistortPathData(it, st);
    if (d !== null) {
      const p = layer.pathEl;
      p.setAttribute('d', d);
      if (p.parentNode !== src) src.replaceChildren(p);
      main.style.display = '';
      layer.outlineFaceOn = true;
      sourceVisible = true;
    } else {
      src.replaceChildren();
      main.style.display = 'none';
      layer.outlineFaceOn = false;
      ensureTextOutlineFont(st.font, st.weight).then((font) => { if (font) touchText(layer); });
    }
  } else if (layout) {
    // un tspan per glifo: x/y assoluti (origine = baseline sinistra, ancora
    // 'start') e rotate attorno a quell'origine — lo stesso pivot dei path
    // canvas, quindi faccia SVG ed effetti combaciano al pixel
    main.style.display = '';
    if (t.parentNode !== src) src.replaceChildren(t);
    t.setAttribute('text-anchor', 'start');
    t.textContent = '';
    for (const g of layout) {
      const ts = document.createElementNS(SVG_NS, 'tspan');
      ts.setAttribute('x', String(g.x));
      ts.setAttribute('y', String(g.y));
      ts.setAttribute('rotate', String(g.a * 180 / Math.PI));
      ts.textContent = g.ch;
      t.appendChild(ts);
    }
  } else {
    main.style.display = '';
    if (t.parentNode !== src) src.replaceChildren(t);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = it.text;
    t.setAttribute('x', String(it.x));
    t.setAttribute('y', String(textBaselineY(it, st)));
  }
  if (!isDistort) layer.outlineFaceOn = false;
  syncSvgHardShadow(layer, sourceVisible, isDistort && layer.outlineFaceOn);
  // layout calcolato col font di fallback: si rifà quando atterra il vero
  if ((layout || isDistort) && !document.fonts.check(`${st.weight} 16px "${st.font}"`)) {
    ensureFont(st.font, st.weight).then(() => touchText(layer));
  }
  // font sul <g>: lo ereditano il <text> unico e i glifi curvati.
  src.setAttribute('font-size', String(it.size));
  src.setAttribute('font-family', `"${st.font}", sans-serif`);
  src.setAttribute('font-weight', String(st.weight));
  main.setAttribute('fill', it.fill);
  if (st.stroke > 0) {
    main.setAttribute('stroke', st.strokeColor);
    main.setAttribute('stroke-width', String(st.stroke * 2));
  } else {
    main.removeAttribute('stroke');
    main.removeAttribute('stroke-width');
  }
  // alpha dell'effetto canvas per i warp non-distort. Distort usa solo SVG.
  layer.blockCanvas.style.opacity = String(layer.opacity);
}

// Profilo device, deciso una volta al load: sul touch (mobile/tablet) le
// anteprime costano — dpr alto, CPU lenta — quindi cadenza più rada,
// risoluzione più bassa e passo più largo; sul desktop una per frame.
export const COARSE_POINTER =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Cadenza delle rigenerazioni: durante un gesto si disegnano anteprime a
// risoluzione ridotta, mai più ravvicinate di PREVIEW_MS; a gesto fermo da
// SETTLE_MS l'ultima anteprima viene promossa a qualità piena. Tutto
// sincrono: niente blob in volo da arbitrare.
const PREVIEW_MS = COARSE_POINTER ? 40 : 16;
const SETTLE_MS = COARSE_POINTER ? 200 : 120;
const PREVIEW_SCALE = COARSE_POINTER ? 0.4 : 0.5; // risoluzione anteprime (lato)
const FULL_STEP = 0.6;       // passo estrusione in px device, qualità piena
const PREVIEW_STEP = COARSE_POINTER ? 2.4 : 1.8;  // passo largo in anteprima
// Quanti frame la camera deve stare ferma prima di rigenerare la bitmap
// solo perché lo zoom è cambiato (le modifiche di stile non aspettano).
const BLOCK_STABLE_FRAMES = 12;
const BLOCK_MAX_SIDE = 4096;       // lato massimo della bitmap
const BLOCK_MAX_AREA = 4_000_000;  // ~16 MB RGBA per livello, al massimo

// ---- path GPU (text_gl) ---------------------------------------------------
// Quando il WebGL c'è, gli effetti si disegnano su GPU: la SDF della stringa
// si rigenera solo su cambio testo/font/bucket, tutto il resto è uniform →
// qualità piena a ogni evento di slider, niente anteprime né promozioni.
// Il path CPU sotto resta come fallback (e per l'export, che è one-shot).
/** @type {TextFxGL|null|undefined} undefined = non ancora provato */
let _fx;
let _gpuOn = true;

function _fxInst() {
  if (_fx === undefined) _fx = TextFxGL.create();
  return _fx;
}

// Toggle runtime (console: __textGpu()) per confrontare GPU e CPU dal vivo.
/** @param {boolean} [v] undefined = toggle @returns {boolean} stato attuale */
export function setTextGpu(v) {
  _gpuOn = v === undefined ? !_gpuOn : !!v;
  console.info(`[Text GPU] ${_gpuOn ? 'ON' : 'OFF (path CPU)'}`);
  return _gpuOn;
}

// Bucket della portata SDF in em: la distanza massima campionabile attorno
// ai glifi è cotta nella texture; a bucket (e non al valore esatto) così gli
// slider non la rigenerano mai, salvo attraversare una soglia.
/** @param {TextItem} it @param {TextStyle} st */
function _reachBucket(it, st) {
  const em = (st.shadowDist + st.shadowBlur * 1.5 + st.stroke + 4) / it.size;
  return em <= 0.5 ? 0.5 : em <= 1 ? 1 : em <= 2 ? 2 : 4;
}

/** @param {TextFxGL} fx @param {Layer} layer @param {Camera} camera */
function _refreshGpu(fx, layer, camera) {
  const st = layer.style, it = layer.item;
  const fontReady = document.fonts.check(`${st.weight} 16px "${st.font}"`) ? 1 : 0;
  const padEm = _reachBucket(it, st);
  const sdfKey = `${it.text}|${st.font}|${st.weight}|P${padEm}|F${fontReady}`;
  // tutto il resto è uniform: cambia la bitmap renderizzata, non la SDF
  const key = `G|${sdfKey}|${it.size}|${st.stroke}|${st.shadowColor}|` +
    `${st.shadowBlur}|${st.shadowDist}|${st.shadowAngle ?? 45}|${st.block ? 'B' : 'S'}`;
  let scale = 0;
  if (layer.blockKey !== key) {
    scale = -1; // qualunque: forza il render
  } else {
    // zoom assestato su una scala troppo diversa da quella renderizzata
    const ideal = _blockScale(camera, layer.blockBoxW || 1, layer.blockBoxH || 1);
    if (Math.abs(Math.log2(ideal / layer.blockScale)) > 0.4 &&
      layer.blockStable >= BLOCK_STABLE_FRAMES) scale = ideal;
  }
  if (!scale) return;
  if (!fx.ensureSdf(layer, sdfKey, it, st, padEm)) return _fallbackCpu(layer, camera);
  const box = blockBox(it, st);
  const r = _blockScale(camera, box.w, box.h);
  if (!fx.render(layer, it, st, box, r, textBaselineY(it, st))) {
    return _fallbackCpu(layer, camera);
  }
  layer.blockKey = key;
  layer.blockOffX = box.x - it.x;
  layer.blockOffY = box.y - it.y;
  layer.blockBoxW = box.w;
  layer.blockBoxH = box.h;
  layer.blockScale = r;
  layer.blockQuality = 'full';
  const cnv = layer.blockCanvas;
  cnv.style.width = cnv.width + 'px';
  cnv.style.height = cnv.height + 'px';
  cnv.style.display = '';
  syncBlockTransform(layer, camera);
  if (debug3d) _debugDump(layer, box, r, st.block ? -1 : 1); // -1 = march GPU
}

// Il contesto GL è morto o la SDF non si è creata: da qui in poi path CPU.
/** @param {Layer} layer @param {Camera} camera */
function _fallbackCpu(layer, camera) {
  console.warn('[Text GPU] non disponibile: passo al path CPU');
  _gpuOn = false;
  layer.blockKey = '';
  _generateBlock(layer, camera, false);
}

// Chiamata dai piani a ogni frame per ogni livello testo: decide se la
// bitmap dell'effetto va (ri)generata e a quale qualità. Tutte le uscite
// veloci sono confronti su numeri/stringhe: a regime non alloca e non
// disegna nulla.
/** @param {Layer} layer @param {Camera} camera @param {boolean} camChanged */
export function refreshBlockBitmap(layer, camera, camChanged) {
  const st = layer.style, it = layer.item;
  if (distortOn(st)) {
    if (layer.blockKey || layer.blockCanvas.style.display !== 'none') freeBlockBitmap(layer);
    return;
  }
  const effectOn = textFxOn(st);
  const on = effectOn && !layer.svgHardShadowOn &&
    layer.visible && layer.opacity > 0 && it.text.length > 0;
  if (!on) {
    if (layer.blockKey) freeBlockBitmap(layer);
    return;
  }
  layer.blockStable = camChanged ? 0 : (layer.blockStable || 0) + 1;
  // col warp attivo la SDF (che cuoce la stringa DRITTA in texture) andrebbe
  // rigenerata a ogni tacca degli slider di forma: si resta sul path CPU,
  // che ha già anteprime throttlate e promozione a gesto fermo
  const warped = warpMode(st) !== 'none';
  if (_gpuOn && !warped) {
    const fx = _fxInst();
    if (fx && fx.ok) return _refreshGpu(fx, layer, camera);
  }
  // contenuto della bitmap (posizione esclusa: sposta solo il transform).
  // Lo stato del font fa parte della chiave: una bitmap generata col font
  // di fallback si rigenera da sola quando il font vero atterra.
  const fontReady = document.fonts.check(`${st.weight} 16px "${st.font}"`) ? 1 : 0;
  const key = `${st.block ? 'B' : 'S'}|${it.text}|${it.size}|${st.font}|${st.weight}|` +
    `${st.stroke}|${st.shadowColor}|${st.shadowBlur}|${st.shadowDist}|` +
    `${st.shadowAngle ?? 45}|F${fontReady}|W${warpMode(st)},${st.warpBend ?? 0},` +
    `${st.warpRadius ?? 0},${st.warpAmp ?? 0},${st.warpFreq ?? 0}`;
  const now = performance.now();
  if (layer.blockKey !== key) {
    // stile/testo cambiati: anteprima subito ma con un tetto di frequenza,
    // così il drag di uno slider non disegna una bitmap a ogni evento
    if (!layer.blockKey || now - (layer.blockT || 0) > PREVIEW_MS) {
      layer.blockKey = key;
      layer.blockT = now;
      _generateBlock(layer, camera, true);
    }
    return;
  }
  // gesto fermo: l'ultima anteprima viene promossa a qualità piena
  if (layer.blockQuality !== 'full') {
    if (now - (layer.blockT || 0) > SETTLE_MS && layer.blockStable >= 2) {
      layer.blockT = now;
      _generateBlock(layer, camera, false);
    }
    return;
  }
  // zoom assestato su una scala troppo diversa da quella renderizzata
  const ideal = _blockScale(camera, layer.blockBoxW || 1, layer.blockBoxH || 1);
  if (Math.abs(Math.log2(ideal / layer.blockScale)) > 0.4 &&
    layer.blockStable >= BLOCK_STABLE_FRAMES) {
    layer.blockT = now;
    _generateBlock(layer, camera, false);
  }
}

/** @param {Camera} camera @param {number} w @param {number} h */
function _blockScale(camera, w, h) {
  const cap = Math.min(
    BLOCK_MAX_SIDE / w,
    BLOCK_MAX_SIDE / h,
    Math.sqrt(BLOCK_MAX_AREA / (w * h)));
  return Math.max(0.05, Math.min(camera.zoom * camera.dpr, cap));
}

// Scratch condiviso per la passata di blur (sagoma pre-sfocatura): riusato
// fra tutte le rigenerazioni live, mai più grande di BLOCK_MAX_SIDE².
/** @type {HTMLCanvasElement|null} */
let _scratch = null;

/** @param {Layer} layer @param {Camera} camera @param {boolean} preview */
function _generateBlock(layer, camera, preview) {
  const it = layer.item, st = layer.style;
  const box = blockBox(it, st);
  // ancora relativa al testo: se item.x/y si sposta, l'effetto lo segue
  // dal transform senza rigenerare
  layer.blockOffX = box.x - it.x;
  layer.blockOffY = box.y - it.y;
  layer.blockBoxW = box.w;
  layer.blockBoxH = box.h;
  const r = Math.max(0.05,
    _blockScale(camera, box.w, box.h) * (preview ? PREVIEW_SCALE : 1));
  layer.blockScale = r;
  layer.blockQuality = preview ? 'preview' : 'full';
  if (!_scratch) _scratch = document.createElement('canvas');
  const cnv = layer.blockCanvas;
  const n = renderEffectInto(cnv, _scratch, it, st, r, box,
    preview ? PREVIEW_STEP : FULL_STEP);
  // dimensione CSS = pixel della bitmap: la scala visiva la fa il transform
  cnv.style.width = cnv.width + 'px';
  cnv.style.height = cnv.height + 'px';
  cnv.style.display = '';
  syncBlockTransform(layer, camera);
  if (debug3d) _debugDump(layer, box, r, n);
}

// Ancora il canvas dell'effetto allo schermo: stessa mappatura mondo→schermo
// del viewBox, come transform CSS. Durante pan/zoom cambia SOLO questa
// stringa: il compositor scala la texture, niente repaint, niente filtri.
/** @param {Layer} layer @param {Camera} camera */
export function syncBlockTransform(layer, camera) {
  if (!layer.blockScale) return;
  const wx = layer.item.x + (layer.blockOffX || 0);
  const wy = layer.item.y + (layer.blockOffY || 0);
  const sx = (wx - camera.x) * camera.zoom + camera.w * 0.5;
  const sy = (wy - camera.y) * camera.zoom + camera.h * 0.5;
  const k = camera.zoom / layer.blockScale;
  layer.blockCanvas.style.transform =
    `translate3d(${sx}px,${sy}px,0) scale(${k})`;
}

// Maschera il livello testo al rettangolo del suo board, come i tratti:
// rect del clipPath SVG in coordinate mondo + clip-path CSS sul canvas
// dell'effetto in px bitmap (il clip locale viaggia col transform, quindi
// pan/zoom non lo toccano). Chiamata dai piani a ogni frame DOPO
// refreshBlockBitmap/syncBlockTransform: a regime è un confronto di stringhe.
/** @param {Layer} layer */
export function syncTextClip(layer) {
  const b = layer.clipBoard;
  if (!b) {
    // livello fuori dai board (non dovrebbe accadere): nessuna maschera
    if (layer.clipKey) {
      layer.clipKey = '';
      layer.mainEl.removeAttribute('clip-path');
      if (layer.hardShadowEl) layer.hardShadowEl.removeAttribute('clip-path');
      layer.blockCanvas.style.clipPath = '';
      layer.blockClipKey = '';
    }
    return;
  }
  const key = `${b.x},${b.y},${b.w},${b.h}`;
  if (layer.clipKey !== key) {
    layer.clipKey = key;
    if (!layer.mainEl.hasAttribute('clip-path')) {
      layer.mainEl.setAttribute('clip-path', `url(#tclip${layer.id})`);
    }
    if (layer.hardShadowEl && !layer.hardShadowEl.hasAttribute('clip-path')) {
      layer.hardShadowEl.setAttribute('clip-path', `url(#tclip${layer.id})`);
    }
    const r = layer.clipRectEl;
    r.setAttribute('x', String(b.x));
    r.setAttribute('y', String(b.y));
    r.setAttribute('width', String(b.w));
    r.setAttribute('height', String(b.h));
  }
  // canvas dell'effetto: board in px locali della bitmap (CSS width = px
  // bitmap). inset() clampato a 0: lato dentro il board = nessun taglio.
  const cnv = layer.blockCanvas, s = layer.blockScale;
  if (!cnv || !s || !cnv.width) return;
  const wx = layer.item.x + (layer.blockOffX || 0);
  const wy = layer.item.y + (layer.blockOffY || 0);
  const bKey = `${key}|${wx},${wy}|${s}|${cnv.width},${cnv.height}`;
  if (layer.blockClipKey === bKey) return;
  layer.blockClipKey = bKey;
  const x0 = Math.max(0, (b.x - wx) * s);
  const y0 = Math.max(0, (b.y - wy) * s);
  const x1 = Math.max(0, cnv.width - (b.x + b.w - wx) * s);
  const y1 = Math.max(0, cnv.height - (b.y + b.h - wy) * s);
  cnv.style.clipPath = (x0 || y0 || x1 || y1)
    ? `inset(${y0.toFixed(1)}px ${x1.toFixed(1)}px ${y1.toFixed(1)}px ${x0.toFixed(1)}px)`
    : '';
}

// Libera la bitmap dell'effetto (toggle off, livello morto, clearAll),
// compresa l'eventuale texture SDF del path GPU.
/** @param {Layer} layer */
export function freeBlockBitmap(layer) {
  const cnv = layer.blockCanvas;
  if (cnv) {
    cnv.style.display = 'none';
    cnv.width = 0;  // backing store libero subito
    cnv.height = 0;
  }
  if (layer.blockSdf && _fx) _fx.free(layer);
  layer.blockKey = '';
  layer.blockScale = 0;
  layer.blockQuality = '';
}

// ---- diagnostica estrusione/ombra ----------------------------------------
// OFF di default: il suo path legge l'intera bitmap con getImageData (più
// getBBox e console.table), un costo enorme se resta acceso durante i gesti
// — era la prima causa del lag degli slider. Si comanda dalla console:
//   __textDebug3d()       toggle
//   __textDebug3d(true)   accende     __textDebug3d(false)   spegne
// Stampa la diagnosi a ogni rigenerazione successiva, anteprime incluse.
let debug3d = false;

/** @param {boolean} [v] undefined = toggle @returns {boolean} stato attuale */
export function setBlockDebug3d(v) {
  debug3d = v === undefined ? !debug3d : !!v;
  console.info(`[Text 3D debug] ${debug3d ? 'ON' : 'OFF'}`);
  return debug3d;
}

/** @param {number} n */
function dbgN(n) { return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n; }

/** @param {{x: number, y: number, width?: number, height?: number, w?: number, h?: number}|null} r */
function dbgRect(r) {
  if (!r) return null;
  const w = r.width ?? r.w ?? 0, h = r.height ?? r.h ?? 0;
  return { x: dbgN(r.x), y: dbgN(r.y), w: dbgN(w), h: dbgN(h) };
}

/**
 * @param {HTMLCanvasElement} canvas @param {number} r @param {ReturnType<typeof blockBox>} box
 */
function debugAlphaBounds(canvas, r, box) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (d[(y * canvas.width + x) * 4 + 3] <= 4) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      count++;
    }
  }
  if (!count) return null;
  return {
    px: { x: x0, y: y0, w: x1 + 1 - x0, h: y1 + 1 - y0, count },
    world: {
      x: dbgN(box.x + x0 / r),
      y: dbgN(box.y + y0 / r),
      w: dbgN((x1 + 1 - x0) / r),
      h: dbgN((y1 + 1 - y0) / r),
    },
  };
}

/**
 * @param {Layer} layer @param {ReturnType<typeof blockBox>} box @param {number} r
 * @param {number} n copie disegnate nella bitmap
 * @param {{x: number, y: number, width: number, height: number}|null} svgBox
 * @param {TextMetrics|null} metrics
 */
function debugBlock3d(layer, box, r, n, svgBox, metrics) {
  const it = layer.item, st = layer.style;
  const alpha = debugAlphaBounds(layer.blockCanvas, r, box);
  const { ux, uy } = shadowDir(st);
  const mLeft = metrics?.actualBoundingBoxLeft ?? 0;
  const mRight = metrics?.actualBoundingBoxRight ?? 0;
  const mAsc = metrics?.actualBoundingBoxAscent ?? 0;
  const mDes = metrics?.actualBoundingBoxDescent ?? 0;
  const baseY = textBaselineY(it, st);
  const canvasBox = metrics ? {
    x: it.x - mLeft,
    y: baseY - mAsc,
    width: mLeft + mRight,
    height: mAsc + mDes,
  } : null;
  const delta = svgBox && canvasBox ? {
    canvasMinusSvgX: dbgN(canvasBox.x - svgBox.x),
    canvasMinusSvgY: dbgN(canvasBox.y - svgBox.y),
    canvasMinusSvgRight: dbgN((canvasBox.x + canvasBox.width) - (svgBox.x + svgBox.width)),
    canvasMinusSvgBottom: dbgN((canvasBox.y + canvasBox.height) - (svgBox.y + svgBox.height)),
  } : null;
  const alphaDelta = svgBox && alpha ? {
    alphaMinusSvgX: dbgN(alpha.world.x - svgBox.x),
    alphaMinusSvgY: dbgN(alpha.world.y - svgBox.y),
    alphaMinusSvgRight: dbgN((alpha.world.x + alpha.world.w) - (svgBox.x + svgBox.width)),
    alphaMinusSvgBottom: dbgN((alpha.world.y + alpha.world.h) - (svgBox.y + svgBox.height)),
  } : null;
  const warnings = [];
  if (!svgBox) warnings.push('SVG getBBox unavailable: baseline not verified');
  if (svgBox && alpha) {
    const eps = 0.5;
    if (uy >= 0 && alpha.world.y < svgBox.y - eps) {
      warnings.push(`bitmap pixels above text by ${dbgN(svgBox.y - alpha.world.y)}px`);
    }
    if (ux >= 0 && alpha.world.x < svgBox.x - eps) {
      warnings.push(`bitmap pixels left of text by ${dbgN(svgBox.x - alpha.world.x)}px`);
    }
  }
  console.warn('[Text 3D debug] quick diagnosis', {
    text: it.text,
    baselineY: dbgN(baseY),
    alphaMinusSvgY: alphaDelta?.alphaMinusSvgY ?? null,
    alphaMinusSvgX: alphaDelta?.alphaMinusSvgX ?? null,
    firstCopy: 'i=1, first copy offset from front text',
    note: warnings.length ? warnings.join(' | ') : 'no bbox drift beyond 0.5px',
  });
  console.groupCollapsed(`[Text 3D debug] "${it.text}" layer ${layer.id}`);
  console.table({
    font: `${st.weight} ${it.size}px ${st.font}`,
    mode: st.block ? '3D block' : 'soft shadow',
    quality: layer.blockQuality,
    shadowDist: st.shadowDist,
    shadowAngle: st.shadowAngle ?? 45,
    dirX: dbgN(ux),
    dirY: dbgN(uy),
    bitmapScale: dbgN(r),
    copies: n,
    firstCopy: 'i=1, first copy offset from front text',
    firstStepX: dbgN(ux * st.shadowDist / n),
    firstStepY: dbgN(uy * st.shadowDist / n),
    baselineY: dbgN(baseY),
  });
  console.log('svg text bbox', dbgRect(svgBox));
  console.log('canvas text bbox', dbgRect(canvasBox));
  console.log('effect box world', dbgRect(box));
  console.log('bitmap alpha bbox', alpha);
  console.log('delta canvas-vs-svg', delta);
  console.log('delta alpha-vs-svg', alphaDelta);
  if (warnings.length) console.warn('[Text 3D debug] possible cause:', warnings.join(' | '));
  console.groupEnd();
}

// Collect comparison measurements and print the diagnosis. getBBox forces a
// synchronous layout flush: it lives only here, never on the regeneration path.
/** @param {Layer} layer @param {ReturnType<typeof blockBox>} box @param {number} r @param {number} n */
function _debugDump(layer, box, r, n) {
  const it = layer.item, st = layer.style;
  /** @type {{x: number, y: number, width: number, height: number}|null} */
  let svgBox = null;
  /** @type {TextMetrics|null} */
  let metrics = null;
  try {
    const sb = layer.mainEl.getBBox();
    if (sb.width > 0) {
      svgBox = { x: sb.x, y: sb.y, width: sb.width, height: sb.height };
      measurer.font = textFont(it, st);
      measurer.textAlign = 'center';
      measurer.textBaseline = 'alphabetic';
      metrics = measurer.measureText(it.text);
    }
  } catch (err) {
    console.warn('[Text 3D debug] getBBox fallito:', err);
    // SVG non renderizzato: si resta senza confronto
  }
  debugBlock3d(layer, box, r, n, svgBox, metrics);
}
