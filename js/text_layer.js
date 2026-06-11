// TESTO VETTORIALE — vettore puro fino allo schermo: ogni livello testo è un
// piano SVG (pointer-events: none) il cui viewBox segue la camera; il browser
// rasterizza i glifi alla risoluzione del device a ogni paint, quindi il
// testo è nitido sempre — anche durante lo zoom su desktop; sul touch lo
// zoom congela il piano in texture (vedi il freeze in planes.js) e la
// nitidezza torna al rilascio. Questo modulo tiene font, stile e la
// sincronizzazione attributi; la creazione/ordinamento dei piani è del
// gestore in planes.js.

import { TextFxGL } from './text_gl.js';

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
export function shadowCss(hex, a = 0.65) {
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
 * @property {number} shadowOpacity alpha dell'ombra 0..1 (morbida e blocco 3D)
 * @property {string} shadowColor
 * @property {'none'|'arc'|'circle'|'wave'|'distort'} warp trasformazione del tracciato
 * @property {number} warpBend arco: curvatura totale in gradi (>0 verso l'alto)
 * @property {number} warpRadius cerchio: raggio in px mondo (0 = auto, cerchio pieno)
 * @property {number} warpAmp onda: ampiezza in px mondo
 * @property {number} warpFreq onda: numero di onde sull'intero testo
 * @property {Distort} [distort] gabbia della distorsione (creata al primo uso)
 * @property {number} [distortVer] timbro monotono: cambia a ogni modifica della gabbia
 * @property {{x:number,y:number,w:number,h:number,vBase:number}} [distortFrame]
 *   frame CONGELATO della gabbia in unità di corpo, relativo a item.x/y:
 *   cambiare testo o font non lo tocca (il contenuto si stira dentro),
 *   spostare il testo lo trasla, cambiare corpo lo scala
 */

/**
 * Gabbia di distorsione stile envelope: coordinate NORMALIZZATE alla bbox del
 * testo non deformato (u: 0..1 da sinistra, v: 0..1 dall'alto) — cambiando
 * testo/corpo/font la forma si conserva. Bordi alto e basso = due cubiche per
 * lato passanti per il punto centrale; i lati verticali restano dritti.
 * Ancore: 4 angoli + 2 centri (tc/bc). Maniglie come OFFSET dall'ancora:
 * gli angoli ne hanno UNA (verso il centro), i centri DUE (htcl/htcr, hbcl/hbcr).
 * @typedef {Object} Distort
 * @property {{x:number,y:number}} tl @property {{x:number,y:number}} tc @property {{x:number,y:number}} tr
 * @property {{x:number,y:number}} bl @property {{x:number,y:number}} bc @property {{x:number,y:number}} br
 * @property {{x:number,y:number}} htl @property {{x:number,y:number}} htcl @property {{x:number,y:number}} htcr @property {{x:number,y:number}} htr
 * @property {{x:number,y:number}} hbl @property {{x:number,y:number}} hbcl @property {{x:number,y:number}} hbcr @property {{x:number,y:number}} hbr
 */

/** Gabbia identità. Maniglie a 1/6 ESATTO: controlli equispaziati sulla
 * corda = cubica a parametrizzazione lineare, quindi scala locale 1 ovunque
 * (a 0.17 i glifi oscillerebbero di un ~0.5% di scala). */
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

// Timbro globale per le chiavi di cache: distinto anche fra livelli diversi.
let _distortStamp = 0;

/** Da chiamare a ogni modifica della gabbia (gizmo, reset). @param {TextStyle} st */
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
    shadowOpacity: 0.65, shadowColor: '#000000',
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

// Bbox mondo dell'INCHIOSTRO del testo dritto (senza bordo/ombra): è il box
// SORGENTE della distort, da cui si rasterizza la bitmap da piegare.
// Orizzontale come il verticale: misure d'inchiostro reali, prese col
// textAlign center del disegno (left/right relativi a it.x). textWidth non
// va bene qui: è avanzamento, col pavimento per-carattere che gonfia il box
// sui font stretti -> gabbia che non aderisce. vBase = quota baseline (0..1).
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

// Frame mondo della GABBIA distort (i punti normalizzati u/v vivono qui).
// È l'inchiostro del testo CONGELATO al primo uso, salvato in unità di corpo
// relative a it.x/y: cambiando testo o font la gabbia NON si muove — il
// contenuto nuovo si stira dentro, stile envelope ("Reimposta gabbia"
// ricattura). Il box della bitmap effetto resta separato in blockBox().
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

// Punto + derivata di una cubica di Bézier (coordinate normalizzate gabbia).
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

const _ec1 = { x: 0, y: 0 }, _ec2 = { x: 0, y: 0 }; // controlli riusati
/** @param {{x:number,y:number}} p @param {{x:number,y:number}} h @param {{x:number,y:number}} out */
function _addH(p, h, out) { out.x = p.x + h.x; out.y = p.y + h.y; return out; }

// Bordo della gabbia (alto o basso): due cubiche a..c e c..b, u in 0..1.
// La derivata torna rispetto a u (fattore 2 del cambio di parametro).
// Fuori da [0,1] estende LINEARMENTE dal punto estremo lungo la tangente:
// è la zona dei margini sorgente (bordo del testo), mai i glifi stessi.
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

// Memo a una voce: il layout serve a sync SVG, blockBox e renderEffectInto
// nello stesso giro; la chiave include lo stato del font (le metriche col
// fallback differiscono).
let _wlKey = '';
/** @type {WarpGlyph[]|null} */
let _wlVal = null;

/** @param {TextItem} it @param {TextStyle} st @returns {WarpGlyph[]|null} null = testo dritto */
export function warpLayout(it, st) {
  const mode = st.warp ?? 'none';
  if (mode === 'none' || !it.text) return null;
  const ready = document.fonts.check(`${st.weight} 16px "${st.font}"`) ? 1 : 0;
  const key = `${it.text}|${it.x}|${it.y}|${it.size}|${st.font}|${st.weight}|${mode}|` +
    `${st.warpBend ?? 0}|${st.warpRadius ?? 0}|${st.warpAmp ?? 0}|${st.warpFreq ?? 0}|` +
    `V${st.distortVer ?? 0}|F${ready}`;
  if (key === _wlKey) return _wlVal;
  // la distort NON è per-glifo: deforma il blocco intero come raster a
  // strisce (vedi _renderDistortInto) — qui non produce layout
  if (mode === 'distort') { _wlKey = key; return (_wlVal = null); }
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
  // la sorgente è un <g>: font e baseline si ereditano sia dal <text> unico
  // (dritto/arco/cerchio/onda) sia dai <text> per-glifo della distort (che
  // hanno transform con scala, impossibile su un tspan)
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('id', 'tsrc' + layer.id); // id unico nel documento
  g.setAttribute('dominant-baseline', 'alphabetic');
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('text-anchor', 'middle');
  g.appendChild(t);
  defs.appendChild(g);
  const main = document.createElementNS(SVG_NS, 'use');
  main.setAttribute('href', '#tsrc' + layer.id);
  // il bordo è sotto il fill (paint-order): stroke centrato largo il doppio,
  // la metà interna è coperta -> bordo "esterno" come nei programmi di grafica
  main.setAttribute('paint-order', 'stroke');
  main.setAttribute('stroke-linejoin', 'round');
  svg.append(defs, main);
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
  layer.blockCanvas = cnv;
  layer.mainEl = main;
  layer.styleDirty = true;
  return svg;
}

// Misuratore condiviso per l'ingombro del testo (mai nel path per-frame).
const measurer = document.createElement('canvas').getContext('2d');

// Ingombro mondo dell'effetto: testo + corsa di estrusione/ombra + margine
// blur. La larghezza misurata può essere corta se il font non è ancora
// pronto: il fallback per-carattere tiene il box abbondante.
/** @param {TextItem} it @param {TextStyle} st */
function blockBox(it, st) {
  const pad = st.shadowBlur * 1.5 + 2;
  // la corsa dell'effetto estende il box solo dal lato verso cui punta
  const { ux, uy } = shadowDir(st);
  const ddx = ux * st.shadowDist, ddy = uy * st.shadowDist;
  const distort = st.warp === 'distort' ? st.distort : null;
  const layout = distort ? null : warpLayout(it, st);
  let x0, y0, x1, y1;
  if (distort) {
    // estremi della gabbia campionando i bordi (33 punti per lato, oltre i
    // margini sorgente in u e v: il warp mappa anche la corona del bordo).
    // La corona è in unità del box SORGENTE, le posizioni sul frame congelato.
    const frame = distortBox(it, st);
    const sbox = _distortInkBox(it, st);
    const m = _distortMargin(it, st);
    const vT = -m / sbox.h, vB = 1 + m / sbox.h;
    const uL = -m / sbox.w, uR = 1 + m / sbox.w;
    const eT = { x: 0, y: 0, dx: 0, dy: 0 }, eB = { x: 0, y: 0, dx: 0, dy: 0 };
    x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
    for (let i = 0; i <= 32; i++) {
      const u = uL + (uR - uL) * i / 32;
      evalEdge(distort, true, u, eT);
      evalEdge(distort, false, u, eB);
      for (const v of [vT, vB]) {
        const px = frame.x + (eT.x + (eB.x - eT.x) * v) * frame.w;
        const py = frame.y + (eT.y + (eB.y - eT.y) * v) * frame.h;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
    }
    // slack per gli estremi delle cubiche fra un campione e l'altro
    const sl = (x1 - x0 + y1 - y0) * 0.02 + 2;
    x0 -= sl; y0 -= sl; x1 += sl; y1 += sl;
  } else if (layout) {
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

// ---- distort: warp raster a strisce -----------------------------------
// La distort deforma il TESTO INTERO come un pezzo unico (stile Kittl):
// niente glifi che scivolano uno sull'altro. Il testo dritto (bordo+fill)
// si rasterizza una volta, poi si piega attraverso la gabbia a strisce
// verticali triangolate; l'effetto (estrusione/ombra) è la stessa sagoma
// deformata, copiata lungo la direzione. La faccia quindi NON è più SVG:
// vive nella stessa bitmap dell'effetto (nitidezza gestita dalle
// rigenerazioni a zoom assestato, come già per gli effetti).

// Corona attorno alla bbox cotta nella sorgente: bordo + sbavature glifo.
/** @param {TextItem} it @param {TextStyle} st */
function _distortMargin(it, st) {
  return st.stroke + it.size * 0.08 + 2;
}

// Triangolo con texture: mappa il triangolo sorgente (px immagine) su quello
// di destinazione (coordinate del ctx, già in mondo). La mappatura affine è
// esatta sui vertici; il clip è gonfiato di `ex` dal baricentro per coprire
// le cuciture dell'antialias (la trasformazione resta quella esatta).
/**
 * @param {CanvasRenderingContext2D} ctx @param {HTMLCanvasElement} img
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {number} x2 @param {number} y2
 * @param {number} u0 @param {number} v0 @param {number} u1 @param {number} v1
 * @param {number} u2 @param {number} v2 @param {number} ex
 */
function _drawTri(ctx, img, x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2, ex) {
  const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
  if (!det) return;
  const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det;
  const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / det;
  const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / det;
  const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / det;
  const e = x0 - a * u0 - c * v0;
  const f = y0 - b * u0 - d * v0;
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  ctx.save();
  ctx.beginPath();
  let dx = x0 - cx, dy = y0 - cy, l = Math.hypot(dx, dy) || 1;
  ctx.moveTo(x0 + dx / l * ex, y0 + dy / l * ex);
  dx = x1 - cx; dy = y1 - cy; l = Math.hypot(dx, dy) || 1;
  ctx.lineTo(x1 + dx / l * ex, y1 + dy / l * ex);
  dx = x2 - cx; dy = y2 - cy; l = Math.hypot(dx, dy) || 1;
  ctx.lineTo(x2 + dx / l * ex, y2 + dy / l * ex);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

const _wsT = { x: 0, y: 0, dx: 0, dy: 0 }, _wsB = { x: 0, y: 0, dx: 0, dy: 0 };

// Disegna `src` (testo dritto + corona di margine m) deformato dalla gabbia,
// su un ctx già in coordinate mondo. Le colonne fra strisce adiacenti sono
// IDENTICHE (calcolate una volta e riusate): i lati combaciano, zero crepe.
// sbox = box d'inchiostro della sorgente (la corona vive nelle sue unità);
// frame = gabbia congelata su cui le posizioni si stirano.
/**
 * @param {CanvasRenderingContext2D} ctx @param {HTMLCanvasElement} src
 * @param {Distort} d @param {ReturnType<typeof distortBox>} frame
 * @param {ReturnType<typeof _distortInkBox>} sbox
 * @param {number} m @param {number} r @param {number} N
 */
function _warpStrips(ctx, src, d, frame, sbox, m, r, N) {
  const sw = src.width, sh = src.height;
  const vT = -m / sbox.h, vB = 1 + m / sbox.h;
  const uL = -m / sbox.w, uR = 1 + m / sbox.w;
  const ex = 0.6 / r; // clip gonfiato ~0.6 px device
  /** @param {number} u @param {{tx:number,ty:number,bx:number,by:number}} out */
  const col = (u, out) => {
    evalEdge(d, true, u, _wsT);
    evalEdge(d, false, u, _wsB);
    out.tx = frame.x + (_wsT.x + (_wsB.x - _wsT.x) * vT) * frame.w;
    out.ty = frame.y + (_wsT.y + (_wsB.y - _wsT.y) * vT) * frame.h;
    out.bx = frame.x + (_wsT.x + (_wsB.x - _wsT.x) * vB) * frame.w;
    out.by = frame.y + (_wsT.y + (_wsB.y - _wsT.y) * vB) * frame.h;
  };
  const L = { tx: 0, ty: 0, bx: 0, by: 0 }, R = { tx: 0, ty: 0, bx: 0, by: 0 };
  col(uL, L);
  for (let i = 0; i < N; i++) {
    col(uL + (uR - uL) * (i + 1) / N, R);
    const sx0 = sw * i / N, sx1 = sw * (i + 1) / N;
    _drawTri(ctx, src, L.tx, L.ty, R.tx, R.ty, L.bx, L.by, sx0, 0, sx1, 0, sx0, sh, ex);
    _drawTri(ctx, src, R.tx, R.ty, R.bx, R.by, L.bx, L.by, sx1, 0, sx1, sh, sx0, sh, ex);
    L.tx = R.tx; L.ty = R.ty; L.bx = R.bx; L.by = R.by;
  }
}

/** @param {Distort} d */
function _distortIsIdentity(d) {
  const eps = 1e-6;
  /** @type {(p: {x:number,y:number}, x: number, y: number) => boolean} */
  const near = (p, x, y) => Math.abs(p.x - x) <= eps && Math.abs(p.y - y) <= eps;
  const H = 1 / 6;
  return near(d.tl, 0, 0) && near(d.tc, 0.5, 0) && near(d.tr, 1, 0) &&
    near(d.bl, 0, 1) && near(d.bc, 0.5, 1) && near(d.br, 1, 1) &&
    near(d.htl, H, 0) && near(d.htcl, -H, 0) &&
    near(d.htcr, H, 0) && near(d.htr, -H, 0) &&
    near(d.hbl, H, 0) && near(d.hbcl, -H, 0) &&
    near(d.hbcr, H, 0) && near(d.hbr, -H, 0);
}

/** @type {{canvas: HTMLCanvasElement, gl: WebGLRenderingContext, prog: WebGLProgram, buf: WebGLBuffer, tex: WebGLTexture, aPos: number, aUv: number, uTex: WebGLUniformLocation}|null|false} */
let _warpGL = null;

/** @param {WebGLRenderingContext} gl @param {number} type @param {string} src */
function _glShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

function _warpGlInst() {
  if (_warpGL !== null) return _warpGL || null;
  try {
    const canvas = document.createElement('canvas');
    const gl = /** @type {WebGLRenderingContext|null} */ (
      canvas.getContext('webgl', {
        alpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: true,
      }) || canvas.getContext('experimental-webgl'));
    if (!gl) return (_warpGL = false), null;
    const vs = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUv = aUv;
}`;
    const fs = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}`;
    const prog = gl.createProgram();
    gl.attachShader(prog, _glShader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, _glShader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const buf = gl.createBuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    _warpGL = {
      canvas, gl, prog, buf, tex,
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUv: gl.getAttribLocation(prog, 'aUv'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
    };
    return _warpGL;
  } catch {
    _warpGL = false;
    return null;
  }
}

/** @param {Distort} d @param {ReturnType<typeof distortBox>} frame @param {ReturnType<typeof _distortInkBox>} sbox @param {number} m @param {number} u @param {{tx:number,ty:number,bx:number,by:number}} out */
function _distortColumn(d, frame, sbox, m, u, out) {
  const vT = -m / sbox.h, vB = 1 + m / sbox.h;
  evalEdge(d, true, u, _wsT);
  evalEdge(d, false, u, _wsB);
  out.tx = frame.x + (_wsT.x + (_wsB.x - _wsT.x) * vT) * frame.w;
  out.ty = frame.y + (_wsT.y + (_wsB.y - _wsT.y) * vT) * frame.h;
  out.bx = frame.x + (_wsT.x + (_wsB.x - _wsT.x) * vB) * frame.w;
  out.by = frame.y + (_wsT.y + (_wsB.y - _wsT.y) * vB) * frame.h;
}

/**
 * @param {HTMLCanvasElement} src @param {Distort} d
 * @param {ReturnType<typeof distortBox>} frame
 * @param {ReturnType<typeof _distortInkBox>} sbox @param {number} m
 * @param {number} r @param {ReturnType<typeof blockBox>} box
 * @param {number} cw @param {number} ch @param {number} N
 * @returns {HTMLCanvasElement|null}
 */
function _warpMeshGL(src, d, frame, sbox, m, r, box, cw, ch, N) {
  const inst = _warpGlInst();
  if (!inst) return null;
  const { canvas, gl, prog, buf, tex } = inst;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw; canvas.height = ch;
  }
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // niente flip: la mesh assegna v=0 al bordo ALTO (riga 0 della sorgente),
  // stessa convenzione di _warpStrips
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.uniform1i(inst.uTex, 0);

  const verts = new Float32Array(N * 6 * 4);
  let o = 0;
  /** @param {number} wx @param {number} wy @param {number} u @param {number} v */
  const put = (wx, wy, u, v) => {
    const x = (wx - box.x) * r;
    const y = (wy - box.y) * r;
    verts[o++] = x / cw * 2 - 1;
    verts[o++] = 1 - y / ch * 2;
    verts[o++] = u;
    verts[o++] = v;
  };
  const uL = -m / sbox.w, uR = 1 + m / sbox.w;
  const L = { tx: 0, ty: 0, bx: 0, by: 0 }, R = { tx: 0, ty: 0, bx: 0, by: 0 };
  _distortColumn(d, frame, sbox, m, uL, L);
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N;
    _distortColumn(d, frame, sbox, m, uL + (uR - uL) * u1, R);
    put(L.tx, L.ty, u0, 0); put(R.tx, R.ty, u1, 0); put(L.bx, L.by, u0, 1);
    put(R.tx, R.ty, u1, 0); put(R.bx, R.by, u1, 1); put(L.bx, L.by, u0, 1);
    L.tx = R.tx; L.ty = R.ty; L.bx = R.bx; L.by = R.by;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
  gl.enableVertexAttribArray(inst.aPos);
  gl.vertexAttribPointer(inst.aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(inst.aUv);
  gl.vertexAttribPointer(inst.aUv, 2, gl.FLOAT, false, 16, 8);
  gl.drawArrays(gl.TRIANGLES, 0, N * 6);
  gl.flush();
  return canvas;
}

/**
 * Disegna la sorgente deformata su un contesto 2D in coordinate pixel canvas.
 * @param {CanvasRenderingContext2D} ctx @param {HTMLCanvasElement} src
 * @param {Distort} d @param {ReturnType<typeof distortBox>} frame
 * @param {ReturnType<typeof _distortInkBox>} sbox
 * @param {number} m @param {number} r @param {ReturnType<typeof blockBox>} box
 * @param {number} cw @param {number} ch @param {number} N
 */
function _drawWarpedBitmap(ctx, src, d, frame, sbox, m, r, box, cw, ch, N) {
  if (_distortIsIdentity(d)) {
    // gabbia identità: resta comunque lo stiramento inchiostro -> frame
    const kx = frame.w / sbox.w, ky = frame.h / sbox.h;
    ctx.drawImage(src,
      Math.round((frame.x - m * kx - box.x) * r),
      Math.round((frame.y - m * ky - box.y) * r),
      Math.max(1, Math.round((frame.w + 2 * m * kx) * r)),
      Math.max(1, Math.round((frame.h + 2 * m * ky) * r)));
    return;
  }
  const glCanvas = _warpMeshGL(src, d, frame, sbox, m, r, box, cw, ch, N);
  if (glCanvas) {
    ctx.drawImage(glCanvas, 0, 0);
    return;
  }
  ctx.save();
  ctx.setTransform(r, 0, 0, r, -box.x * r, -box.y * r);
  _warpStrips(ctx, src, d, frame, sbox, m, r, N);
  ctx.restore();
}

// Canvas di servizio della distort, riusati fra le rigenerazioni.
/** @type {HTMLCanvasElement|null} */ let _srcFace = null;
/** @type {HTMLCanvasElement|null} */ let _srcSil = null;
/** @type {HTMLCanvasElement|null} */ let _warpA = null;

// Effetto + FACCIA della distort, tutto nel canvas dato. L'alpha dell'ombra
// è cotta con un destination-in prima di posare la faccia (che resta piena);
// l'estrusione è per raddoppio (k drawImage coprono 2^k offset, niente
// scurimenti perché l'unione si fonde opaca prima dell'alpha).
/**
 * @param {HTMLCanvasElement} cnv @param {HTMLCanvasElement} scratch
 * @param {TextItem} it @param {TextStyle} st @param {number} r
 * @param {ReturnType<typeof blockBox>} box @param {number} stepDev
 */
function _renderDistortInto(cnv, scratch, it, st, r, box, stepDev) {
  const d = st.distort;
  const frame = distortBox(it, st);
  const sbox = _distortInkBox(it, st);
  const m = _distortMargin(it, st);
  // sorgente dritta: bordo sotto il fill, come l'SVG. Rasterizzata dal box
  // d'inchiostro a densità compensata per lo stiramento verso il frame
  // congelato (testo corto in gabbia larga = niente sfocatura da upscale)
  const rx = r * frame.w / sbox.w, ry = r * frame.h / sbox.h;
  const sw = Math.max(1, Math.round((sbox.w + 2 * m) * rx));
  const sh = Math.max(1, Math.round((sbox.h + 2 * m) * ry));
  if (!_srcFace) _srcFace = document.createElement('canvas');
  if (_srcFace.width !== sw || _srcFace.height !== sh) { _srcFace.width = sw; _srcFace.height = sh; }
  const fctx = _srcFace.getContext('2d');
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.clearRect(0, 0, sw, sh);
  fctx.setTransform(rx, 0, 0, ry, -(sbox.x - m) * rx, -(sbox.y - m) * ry);
  fctx.font = textFont(it, st);
  fctx.textAlign = 'center';
  fctx.textBaseline = 'alphabetic';
  fctx.lineJoin = 'round';
  const by = textBaselineY(it, st);
  if (st.stroke > 0) {
    fctx.strokeStyle = st.strokeColor;
    fctx.lineWidth = st.stroke * 2;
    fctx.strokeText(it.text, it.x, by);
  }
  fctx.fillStyle = it.fill;
  fctx.fillText(it.text, it.x, by);

  const cw = Math.max(1, Math.round(box.w * r));
  const ch = Math.max(1, Math.round(box.h * r));
  if (cnv.width !== cw || cnv.height !== ch) { cnv.width = cw; cnv.height = ch; }
  const ctx = cnv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, cw, ch);

  const preview = stepDev > FULL_STEP + 0.01;
  const meshGL = _warpGlInst() !== null;
  const N = preview
    ? Math.max(24, Math.min(meshGL ? 240 : 96, Math.round(cw / (meshGL ? 4 : 8))))
    : Math.max(48, Math.min(meshGL ? 1024 : 256, Math.round(cw / (meshGL ? 1.5 : 3))));

  const effOn = st.block ? st.shadowDist > 0 : (st.shadowBlur > 0 || st.shadowDist > 0);
  if (effOn) {
    // sagoma color ombra = faccia ricolorata (stessa copertura, bordo incluso)
    if (!_srcSil) _srcSil = document.createElement('canvas');
    if (_srcSil.width !== sw || _srcSil.height !== sh) { _srcSil.width = sw; _srcSil.height = sh; }
    const sctx = _srcSil.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(_srcFace, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = st.shadowColor;
    sctx.fillRect(0, 0, sw, sh);
    sctx.globalCompositeOperation = 'source-over';
    // sagoma deformata, allineata a box come cnv
    if (!_warpA) _warpA = document.createElement('canvas');
    if (_warpA.width !== cw || _warpA.height !== ch) { _warpA.width = cw; _warpA.height = ch; }
    const wctx = _warpA.getContext('2d');
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, cw, ch);
    _drawWarpedBitmap(wctx, _srcSil, d, frame, sbox, m, r, box, cw, ch, N);

    const { ux, uy } = shadowDir(st);
    const blur = st.shadowBlur > 0;
    const union = blur ? scratch : cnv;
    if (union !== cnv && (union.width !== cw || union.height !== ch)) {
      union.width = cw; union.height = ch;
    }
    const uctx = union.getContext('2d');
    uctx.setTransform(1, 0, 0, 1, 0, 0);
    uctx.shadowColor = 'rgba(0,0,0,0)';
    if (union !== cnv) uctx.clearRect(0, 0, cw, ch);
    if (st.block) {
      // copia 0 inclusa: sta sotto la faccia, e il raddoppio parte da lì
      uctx.drawImage(_warpA, 0, 0);
      const span = st.shadowDist * r;
      const steps = Math.max(1, Math.ceil(span / stepDev));
      const k = Math.ceil(Math.log2(steps + 1));
      const s = span / ((1 << k) - 1);
      for (let i = 0; i < k; i++) {
        const off = s * (1 << i);
        uctx.drawImage(union, ux * off, uy * off);
      }
    } else {
      uctx.drawImage(_warpA, ux * st.shadowDist * r, uy * st.shadowDist * r);
    }
    if (blur) {
      // il blur è l'ombra di un drawImage (ctx.filter manca su alcuni Safari)
      ctx.shadowColor = st.shadowColor;
      ctx.shadowBlur = st.shadowBlur * r;
      ctx.shadowOffsetX = cw + ch;
      ctx.drawImage(union, -(cw + ch), 0);
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
    }
    // alpha dell'ombra cotta ORA: la faccia posata dopo resta piena
    ctx.globalCompositeOperation = 'destination-in';
    ctx.globalAlpha = st.shadowOpacity ?? 0.65;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _drawWarpedBitmap(ctx, _srcFace, d, frame, sbox, m, r, box, cw, ch, N);
  return N;
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
  if (st.warp === 'distort' && st.distort) {
    return _renderDistortInto(cnv, scratch, it, st, r, box, stepDev);
  }
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
 */
export function drawTextDocument(ctx, it, st, x0, y0, alpha = 1) {
  ctx.globalAlpha = alpha;
  if (st.warp === 'distort' && st.distort) {
    // la bitmap della distort contiene già faccia + effetto (alpha
    // dell'ombra cotta): un solo drawImage
    const blk = renderBlockCanvas(it, st, 1);
    ctx.drawImage(blk.canvas, blk.box.x - x0, blk.box.y - y0);
    ctx.globalAlpha = 1;
    return;
  }
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
    // alpha dell'ombra in un colpo solo (l'overlap non scurisce)
    const blk = renderBlockCanvas(it, st, 1);
    ctx.save();
    ctx.globalAlpha = alpha * (st.shadowOpacity ?? 0.65);
    ctx.drawImage(blk.canvas, blk.box.x - x0, blk.box.y - y0);
    ctx.restore();
  } else if (st.shadowBlur > 0 || st.shadowDist > 0) {
    const rad = (st.shadowAngle ?? 45) * Math.PI / 180;
    ctx.shadowColor = shadowCss(st.shadowColor, st.shadowOpacity ?? 0.65);
    ctx.shadowBlur = st.shadowBlur;
    ctx.shadowOffsetX = Math.cos(rad) * st.shadowDist;
    ctx.shadowOffsetY = Math.sin(rad) * st.shadowDist;
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

// Applica item + stile + visibilità/opacità del livello agli attributi SVG
// e all'opacità del canvas dell'effetto (che cambia live, senza rigenerare).
/** @param {Layer} layer */
export function syncTextSvg(layer) {
  const it = layer.item, t = layer.textEl, st = layer.style;
  const main = layer.mainEl, src = layer.srcEl;
  if (!t) return;
  layer.svg.style.display = layer.visible && layer.opacity > 0 ? 'block' : 'none';
  layer.svg.style.opacity = String(layer.opacity);
  const layout = warpLayout(it, st);
  const distortOn = st.warp === 'distort' && !!st.distort;
  if (distortOn) {
    // distort: la faccia è DENTRO la bitmap dell'effetto (il testo intero si
    // deforma come un pezzo unico, l'SVG non sa piegare i glifi) — il piano
    // vettoriale resta vuoto
    if (t.parentNode) t.remove();
  } else if (layout) {
    // un tspan per glifo: x/y assoluti (origine = baseline sinistra, ancora
    // 'start') e rotate attorno a quell'origine — lo stesso pivot dei path
    // canvas, quindi faccia SVG ed effetti combaciano al pixel
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
    if (t.parentNode !== src) src.replaceChildren(t);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = it.text;
    t.setAttribute('x', String(it.x));
    t.setAttribute('y', String(textBaselineY(it, st)));
  }
  // layout calcolato col font di fallback: si rifà quando atterra il vero
  if ((layout || distortOn) && !document.fonts.check(`${st.weight} 16px "${st.font}"`)) {
    ensureFont(st.font, st.weight).then(() => { layer.styleDirty = true; });
  }
  // font sul <g>: lo ereditano il <text> unico e i glifi della distort
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
  // alpha dell'effetto sull'ELEMENTO: cambia live senza rigenerare la
  // bitmap; include l'opacità del livello (il canvas è fratello dell'svg,
  // non figlio). Il display lo governa refreshBlockBitmap/freeBlockBitmap.
  // Con la distort il canvas porta ANCHE la faccia: l'alpha dell'ombra è
  // cotta dentro, sull'elemento resta solo l'opacità del livello.
  layer.blockCanvas.style.opacity = distortOn
    ? String(layer.opacity)
    : String(layer.opacity * (st.shadowOpacity ?? 0.65));
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
const BLOCK_MAX_SIDE = 2048;       // lato massimo della bitmap
const BLOCK_MAX_AREA = 2_000_000;  // ~8 MB RGBA per livello, al massimo

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
  // con la distort la bitmap porta anche la FACCIA: serve pure senza effetti
  const distortOn = st.warp === 'distort' && !!st.distort;
  const on = (distortOn ||
    (st.block ? st.shadowDist > 0 : st.shadowBlur > 0 || st.shadowDist > 0)) &&
    layer.visible && layer.opacity > 0 && it.text.length > 0;
  if (!on) {
    if (layer.blockKey) freeBlockBitmap(layer);
    return;
  }
  layer.blockStable = camChanged ? 0 : (layer.blockStable || 0) + 1;
  // col warp attivo la SDF (che cuoce la stringa DRITTA in texture) andrebbe
  // rigenerata a ogni tacca degli slider di forma: si resta sul path CPU,
  // che ha già anteprime throttlate e promozione a gesto fermo
  const warped = (st.warp ?? 'none') !== 'none';
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
    `${st.shadowAngle ?? 45}|F${fontReady}|W${st.warp ?? 'none'},${st.warpBend ?? 0},` +
    `${st.warpRadius ?? 0},${st.warpAmp ?? 0},${st.warpFreq ?? 0},V${st.distortVer ?? 0}` +
    // la distort cuoce nella bitmap anche faccia e alpha dell'ombra
    (distortOn ? `|X${it.fill},${st.strokeColor},${st.shadowOpacity ?? 0.65}` : '');
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
  return Math.max(0.05, Math.min(
    camera.zoom * camera.dpr,
    BLOCK_MAX_SIDE / w, BLOCK_MAX_SIDE / h,
    Math.sqrt(BLOCK_MAX_AREA / (w * h))));
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
  if (!svgBox) warnings.push('getBBox SVG non disponibile: baseline non verificata');
  if (svgBox && alpha) {
    const eps = 0.5;
    if (uy >= 0 && alpha.world.y < svgBox.y - eps) {
      warnings.push(`pixel bitmap sopra al testo di ${dbgN(svgBox.y - alpha.world.y)}px`);
    }
    if (ux >= 0 && alpha.world.x < svgBox.x - eps) {
      warnings.push(`pixel bitmap a sinistra del testo di ${dbgN(svgBox.x - alpha.world.x)}px`);
    }
  }
  console.warn('[Text 3D debug] diagnosi rapida', {
    text: it.text,
    baselineY: dbgN(baseY),
    alphaMinusSvgY: alphaDelta?.alphaMinusSvgY ?? null,
    alphaMinusSvgX: alphaDelta?.alphaMinusSvgX ?? null,
    firstCopy: 'i=1, prima copia spostata dal testo frontale',
    note: warnings.length ? warnings.join(' | ') : 'nessuno scarto bbox oltre 0.5px',
  });
  console.groupCollapsed(`[Text 3D debug] "${it.text}" layer ${layer.id}`);
  console.table({
    font: `${st.weight} ${it.size}px ${st.font}`,
    mode: st.block ? 'blocco 3D' : 'ombra morbida',
    quality: layer.blockQuality,
    shadowDist: st.shadowDist,
    shadowAngle: st.shadowAngle ?? 45,
    dirX: dbgN(ux),
    dirY: dbgN(uy),
    bitmapScale: dbgN(r),
    copies: n,
    firstCopy: 'i=1, prima copia spostata dal testo frontale',
    firstStepX: dbgN(ux * st.shadowDist / n),
    firstStepY: dbgN(uy * st.shadowDist / n),
    baselineY: dbgN(baseY),
  });
  console.log('svg text bbox', dbgRect(svgBox));
  console.log('canvas text bbox', dbgRect(canvasBox));
  console.log('effect box mondo', dbgRect(box));
  console.log('bitmap alpha bbox', alpha);
  console.log('delta canvas-vs-svg', delta);
  console.log('delta alpha-vs-svg', alphaDelta);
  if (warnings.length) console.warn('[Text 3D debug] possibile causa:', warnings.join(' | '));
  console.groupEnd();
}

// Raccoglie le misure di confronto e stampa la diagnosi. getBBox forza un
// layout flush sincrono: vive SOLO qui, mai nel path di rigenerazione.
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
