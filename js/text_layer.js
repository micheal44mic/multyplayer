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
 */

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
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('id', 'tsrc' + layer.id); // id unico nel documento
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'alphabetic');
  defs.appendChild(t);
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
  measurer.font = textFont(it, st);
  const tw = Math.max(measurer.measureText(it.text).width, it.text.length * it.size * 0.8);
  const hw = tw / 2 + st.stroke + it.size * 0.15;
  const hh = it.size * 0.9 + st.stroke;
  const pad = st.shadowBlur * 1.5 + 2;
  // la corsa dell'effetto estende il box solo dal lato verso cui punta
  const { ux, uy } = shadowDir(st);
  const ddx = ux * st.shadowDist, ddy = uy * st.shadowDist;
  return {
    x: it.x - hw - pad + Math.min(0, ddx),
    y: it.y - hh - pad + Math.min(0, ddy),
    w: hw * 2 + Math.abs(ddx) + pad * 2,
    h: hh * 2 + Math.abs(ddy) + pad * 2,
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
  ctx.textAlign = 'center';
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
  const bx = it.x, by = textBaselineY(it, st);
  // Si parte da 1: i=0 è la faccia frontale, già coperta dal testo SVG.
  // Disegnarla anche nella bitmap crea un alone/offset apparente sopra il fill.
  for (let i = 1; i <= n; i++) {
    if (st.stroke > 0) ctx.strokeText(it.text, bx + sx * i, by + sy * i);
    ctx.fillText(it.text, bx + sx * i, by + sy * i);
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

// Applica item + stile + visibilità/opacità del livello agli attributi SVG
// e all'opacità del canvas dell'effetto (che cambia live, senza rigenerare).
/** @param {Layer} layer */
export function syncTextSvg(layer) {
  const it = layer.item, t = layer.textEl, st = layer.style;
  const main = layer.mainEl;
  if (!t) return;
  layer.svg.style.display = layer.visible && layer.opacity > 0 ? 'block' : 'none';
  layer.svg.style.opacity = String(layer.opacity);
  t.textContent = it.text;
  t.setAttribute('x', String(it.x));
  t.setAttribute('y', String(textBaselineY(it, st)));
  t.setAttribute('font-size', String(it.size));
  t.setAttribute('font-family', `"${st.font}", sans-serif`);
  t.setAttribute('font-weight', String(st.weight));
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
  layer.blockCanvas.style.opacity =
    String(layer.opacity * (st.shadowOpacity ?? 0.65));
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
  const on = (st.block ? st.shadowDist > 0 : st.shadowBlur > 0 || st.shadowDist > 0) &&
    layer.visible && layer.opacity > 0 && it.text.length > 0;
  if (!on) {
    if (layer.blockKey) freeBlockBitmap(layer);
    return;
  }
  layer.blockStable = camChanged ? 0 : (layer.blockStable || 0) + 1;
  if (_gpuOn) {
    const fx = _fxInst();
    if (fx && fx.ok) return _refreshGpu(fx, layer, camera);
  }
  // contenuto della bitmap (posizione esclusa: sposta solo il transform).
  // Lo stato del font fa parte della chiave: una bitmap generata col font
  // di fallback si rigenera da sola quando il font vero atterra.
  const fontReady = document.fonts.check(`${st.weight} 16px "${st.font}"`) ? 1 : 0;
  const key = `${st.block ? 'B' : 'S'}|${it.text}|${it.size}|${st.font}|${st.weight}|` +
    `${st.stroke}|${st.shadowColor}|${st.shadowBlur}|${st.shadowDist}|` +
    `${st.shadowAngle ?? 45}|F${fontReady}`;
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
