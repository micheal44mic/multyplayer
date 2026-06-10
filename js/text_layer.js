// TESTO VETTORIALE — vettore puro fino allo schermo: ogni livello testo è un
// piano SVG (pointer-events: none) il cui viewBox segue la camera; il browser
// rasterizza i glifi alla risoluzione del device a ogni paint, quindi il
// testo è nitido sempre, anche durante il gesto di zoom. Questo modulo tiene
// font, stile e la sincronizzazione attributi; la creazione/ordinamento dei
// piani è del gestore in planes.js.

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

// Estrusione 3D lungo la diagonale: copie del testo a passo sub-pixel,
// rasterizzate UNA volta su canvas e mostrate come <image> ancorata in
// coordinate mondo. Durante pan/zoom il compositor scala solo una texture
// (un filtro SVG verrebbe rieseguito a ogni frame: ingestibile su mobile);
// la bitmap si rigenera quando cambia lo stile o quando lo zoom si ferma
// su una scala troppo diversa da quella renderizzata.

/** @param {number} x @param {number} y @param {string} fill @param {number} size @returns {TextItem} */
export function makeTextItem(x, y, fill, size) {
  return { text: 'M1M4.COM', x, y, size, fill };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Crea il piano SVG di un livello testo (lo possiede planes.js).
// La geometria vive UNA volta in <defs><text>: il testo visibile e le copie
// dell'estrusione 3D sono <use> che la riferiscono — fill/stroke arrivano
// per eredità perché la sorgente non li dichiara.
/** @param {Layer} layer */
export function createTextSvg(layer) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'textplane');
  svg.setAttribute('aria-hidden', 'true');
  // il viewBox ha lo stesso aspect del viewport: 'none' evita letterbox
  // da arrotondamenti e mappa mondo -> schermo esattamente come la camera
  svg.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('id', 'tsrc' + layer.id); // id unico nel documento
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'alphabetic');
  defs.appendChild(t);
  // estrusione: bitmap cacheata, ancorata in px mondo sotto il testo
  const block = document.createElementNS(SVG_NS, 'image');
  block.setAttribute('preserveAspectRatio', 'none');
  block.style.display = 'none';
  const main = document.createElementNS(SVG_NS, 'use');
  main.setAttribute('href', '#tsrc' + layer.id);
  // il bordo è sotto il fill (paint-order): stroke centrato largo il doppio,
  // la metà interna è coperta -> bordo "esterno" come nei programmi di grafica
  main.setAttribute('paint-order', 'stroke');
  main.setAttribute('stroke-linejoin', 'round');
  svg.append(defs, block, main);
  layer.svg = svg;
  layer.textEl = t;
  layer.blockEl = block;
  layer.mainEl = main;
  layer.styleDirty = true;
  return svg;
}

// Misuratore condiviso per l'ingombro del testo (mai nel path per-frame).
const measurer = document.createElement('canvas').getContext('2d');

// Ingombro mondo dell'estrusione: testo + corsa del blocco + margine blur.
// La larghezza misurata può essere corta se il font non è ancora pronto:
// il fallback per-carattere tiene il box abbondante.
/** @param {TextItem} it @param {TextStyle} st */
function blockBox(it, st) {
  measurer.font = textFont(it, st);
  const tw = Math.max(measurer.measureText(it.text).width, it.text.length * it.size * 0.8);
  const hw = tw / 2 + st.stroke + it.size * 0.15;
  const hh = it.size * 0.9 + st.stroke;
  const pad = st.shadowBlur * 1.5 + 2;
  // la corsa dell'estrusione estende il box solo dal lato verso cui punta
  const { ux, uy } = shadowDir(st);
  const ddx = ux * st.shadowDist, ddy = uy * st.shadowDist;
  return {
    x: it.x - hw - pad + Math.min(0, ddx),
    y: it.y - hh - pad + Math.min(0, ddy),
    w: hw * 2 + Math.abs(ddx) + pad * 2,
    h: hh * 2 + Math.abs(ddy) + pad * 2,
  };
}

// Disegna l'estrusione su canvas a `r` px bitmap per px mondo: copie a passo
// ~0.6px DEVICE (lisce a quella scala), bordo incluso nella sagoma. Il blur
// usa l'ombra di un drawImage (ctx.filter manca su alcuni Safari) sul blocco
// già fuso: niente sovrapposizioni che scuriscono. Colore pieno: l'alpha
// 0.65 la mette l'elemento <image> (o l'export), uniforme.
// alignX/alignY: correzione baseline SVG/canvas (vedi _generateBlock).
/**
 * @param {TextItem} it @param {TextStyle} st @param {number} r
 * @param {ReturnType<typeof blockBox>} [box] @param {number} [alignX] @param {number} [alignY]
 */
export function renderBlockCanvas(it, st, r, box = blockBox(it, st), alignX = 0, alignY = 0) {
  const cw = Math.max(1, Math.round(box.w * r));
  const ch = Math.max(1, Math.round(box.h * r));
  const cnv = document.createElement('canvas');
  cnv.width = cw; cnv.height = ch;
  const ctx = cnv.getContext('2d');
  ctx.scale(r, r);
  ctx.translate(-box.x, -box.y);
  ctx.font = textFont(it, st);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.fillStyle = st.shadowColor;
  ctx.strokeStyle = st.shadowColor;
  ctx.lineWidth = st.stroke * 2;
  const n = Math.max(1, Math.min(400, Math.ceil(st.shadowDist * r / 0.6)));
  const { ux, uy } = shadowDir(st);
  const sx = ux * st.shadowDist / n, sy = uy * st.shadowDist / n;
  const bx = it.x + alignX, by = textBaselineY(it, st) + alignY;
  // Si parte da 1: i=0 è la faccia frontale, già coperta dal testo SVG.
  // Disegnarla anche nella bitmap crea un alone/offset apparente sopra il fill.
  for (let i = 1; i <= n; i++) {
    if (st.stroke > 0) ctx.strokeText(it.text, bx + sx * i, by + sy * i);
    ctx.fillText(it.text, bx + sx * i, by + sy * i);
  }
  if (st.shadowBlur > 0) {
    const c2 = document.createElement('canvas');
    c2.width = cw; c2.height = ch;
    const x2 = c2.getContext('2d');
    x2.shadowColor = st.shadowColor;
    x2.shadowBlur = st.shadowBlur * r;
    x2.shadowOffsetX = cw + ch; // la sorgente sta fuori, in vista solo l'ombra
    x2.drawImage(cnv, -(cw + ch), 0);
    return { canvas: c2, box };
  }
  return { canvas: cnv, box };
}

// Applica item + stile + visibilità/opacità del livello agli attributi SVG.
/** @param {Layer} layer */
export function syncTextSvg(layer) {
  const it = layer.item, t = layer.textEl, st = layer.style;
  const main = layer.mainEl, block = layer.blockEl;
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
  const block3d = st.block && st.shadowDist > 0;
  if (block3d) {
    // alpha sull'ELEMENTO: cambia live senza rigenerare la bitmap
    block.setAttribute('opacity', String(st.shadowOpacity ?? 0.65));
    block.style.display = '';
    // la bitmap si aggiorna in refreshBlockBitmap (chiamata dai piani):
    // qui basta che resti/diventi visibile
  } else {
    block.style.display = 'none';
  }
  // filter CSS su elemento SVG: lunghezze in unità utente = px mondo,
  // quindi l'ombra scala con lo zoom da sola
  if (!block3d && (st.shadowBlur > 0 || st.shadowDist > 0)) {
    const { ux, uy } = shadowDir(st);
    main.style.filter =
      `drop-shadow(${(ux * st.shadowDist).toFixed(2)}px ` +
      `${(uy * st.shadowDist).toFixed(2)}px ` +
      `${st.shadowBlur}px ${shadowCss(st.shadowColor, st.shadowOpacity ?? 0.65)})`;
  } else {
    main.style.filter = '';
  }
}

// Quanti frame la camera deve stare ferma prima di rigenerare la bitmap
// solo perché lo zoom è cambiato (le modifiche di stile non aspettano).
const BLOCK_STABLE_FRAMES = 12;
const BLOCK_MAX_SIDE = 2048;       // lato massimo della bitmap
const BLOCK_MAX_AREA = 2_000_000;  // ~8 MB RGBA per livello, al massimo
// Diagnostica temporanea: stampa in console le misure che allineano SVG e
// bitmap del blocco 3D, così si vede se lo scarto nasce da baseline/box/pixel.
const DEBUG_BLOCK_3D = true;

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
 * @param {number} ax @param {number} ay
 * @param {{x: number, y: number, width: number, height: number}|null} svgBox
 * @param {TextMetrics|null} metrics @param {HTMLCanvasElement} canvas
 */
function debugBlock3d(layer, box, r, ax, ay, svgBox, metrics, canvas) {
  const it = layer.item, st = layer.style;
  const alpha = debugAlphaBounds(canvas, r, box);
  const { ux, uy } = shadowDir(st);
  const n = Math.max(1, Math.min(400, Math.ceil(st.shadowDist * r / 0.6)));
  const mLeft = metrics?.actualBoundingBoxLeft ?? 0;
  const mRight = metrics?.actualBoundingBoxRight ?? 0;
  const mAsc = metrics?.actualBoundingBoxAscent ?? 0;
  const mDes = metrics?.actualBoundingBoxDescent ?? 0;
  const baseY = textBaselineY(it, st) + ay;
  const canvasBox = metrics ? {
    x: it.x + ax - mLeft,
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
    alignY: dbgN(ay),
    alphaMinusSvgY: alphaDelta?.alphaMinusSvgY ?? null,
    alphaMinusSvgX: alphaDelta?.alphaMinusSvgX ?? null,
    firstCopy: 'i=1, prima copia spostata dal testo frontale',
    note: warnings.length ? warnings.join(' | ') : 'nessuno scarto bbox oltre 0.5px',
  });
  console.groupCollapsed(`[Text 3D debug] "${it.text}" layer ${layer.id}`);
  console.table({
    font: `${st.weight} ${it.size}px ${st.font}`,
    shadowDist: st.shadowDist,
    shadowAngle: st.shadowAngle ?? 45,
    dirX: dbgN(ux),
    dirY: dbgN(uy),
    bitmapScale: dbgN(r),
    extrusionCopies: n,
    firstCopy: 'i=1, prima copia spostata dal testo frontale',
    firstStepX: dbgN(ux * st.shadowDist / n),
    firstStepY: dbgN(uy * st.shadowDist / n),
    alignX: dbgN(ax),
    baselineY: dbgN(baseY),
    alignY: dbgN(ay),
  });
  console.log('svg text bbox', dbgRect(svgBox));
  console.log('canvas text bbox dopo correzione', dbgRect(canvasBox));
  console.log('block image box mondo', dbgRect(box));
  console.log('bitmap alpha bbox', alpha);
  console.log('delta canvas-vs-svg', delta);
  console.log('delta alpha-vs-svg', alphaDelta);
  if (warnings.length) console.warn('[Text 3D debug] possibile causa:', warnings.join(' | '));
  console.groupEnd();
}

// Chiamata dai piani a ogni frame per ogni livello testo: decide se la
// bitmap dell'estrusione va (ri)generata. Tutte le uscite veloci sono
// confronti su numeri/stringhe: a regime non alloca e non disegna nulla.
/** @param {Layer} layer @param {Camera} camera @param {boolean} camChanged */
export function refreshBlockBitmap(layer, camera, camChanged) {
  const st = layer.style, it = layer.item;
  const on = st.block && st.shadowDist > 0 && layer.visible && layer.opacity > 0 &&
    it.text.length > 0;
  if (!on) {
    if (layer.blockUrl) freeBlockBitmap(layer);
    return;
  }
  layer.blockStable = camChanged ? 0 : (layer.blockStable || 0) + 1;
  // un blob è già in volo: aspettarlo, MAI accavallare le generazioni
  // (rigenerare prima che atterri lo scarterebbe, e da capo all'infinito)
  if (layer.blockPending) return;
  // contenuto della bitmap (posizione esclusa: sposta solo gli attributi).
  // Lo stato del font fa parte della chiave: una bitmap generata col font
  // di fallback si rigenera da sola quando il font vero atterra.
  const fontReady = document.fonts.check(`${st.weight} 16px "${st.font}"`) ? 1 : 0;
  const key = `${it.text}|${it.size}|${st.font}|${st.weight}|${st.stroke}|` +
    `${st.shadowColor}|${st.shadowBlur}|${st.shadowDist}|${st.shadowAngle ?? 45}|F${fontReady}`;
  const fresh = layer.blockKey === key && !!layer.blockUrl;
  if (!fresh) {
    // stile/testo cambiati: rigenera subito ma con un tetto di frequenza,
    // così il drag di uno slider non disegna una bitmap a ogni evento
    const now = performance.now();
    if (!layer.blockUrl || now - (layer.blockT || 0) > 80) {
      layer.blockKey = key;
      layer.blockT = now;
      _generateBlock(layer, camera);
    }
    return;
  }
  // zoom assestato su una scala troppo diversa da quella renderizzata
  const w = layer.blockBoxW || 1, h = layer.blockBoxH || 1;
  const ideal = _blockScale(camera, w, h);
  if (Math.abs(Math.log2(ideal / layer.blockScale)) > 0.4 &&
    layer.blockStable >= BLOCK_STABLE_FRAMES) {
    layer.blockT = performance.now();
    _generateBlock(layer, camera);
  }
}

/** @param {Camera} camera @param {number} w @param {number} h */
function _blockScale(camera, w, h) {
  return Math.max(0.05, Math.min(
    camera.zoom * camera.dpr,
    BLOCK_MAX_SIDE / w, BLOCK_MAX_SIDE / h,
    Math.sqrt(BLOCK_MAX_AREA / (w * h))));
}

/** @param {Layer} layer @param {Camera} camera */
function _generateBlock(layer, camera) {
  const it = layer.item, st = layer.style;
  const box = blockBox(it, st);
  layer.blockBoxW = box.w;
  layer.blockBoxH = box.h;
  const r = _blockScale(camera, box.w, box.h);
  layer.blockScale = r;
  // SVG e Canvas usano entrambi la baseline alfabetica calcolata da
  // textBaselineY(). Non usare getBBox() per correggerla: sugli SVG <text>
  // descrive una scatola font/logica, non il contorno visivo dei pixel.
  let ax = 0, ay = 0;
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
    if (DEBUG_BLOCK_3D) console.warn('[Text 3D debug] getBBox fallito:', err);
    // SVG non renderizzato: si resta senza correzione
  }
  const { canvas } = renderBlockCanvas(it, st, r, box, ax, ay);
  if (DEBUG_BLOCK_3D) debugBlock3d(layer, box, r, ax, ay, svgBox, metrics, canvas);
  // l'encoding è async: un token scarta i risultati superati (free/undo)
  const gen = (layer.blockGen = (layer.blockGen || 0) + 1);
  layer.blockPending = gen;
  canvas.toBlob((blob) => {
    if (layer.blockPending === gen) layer.blockPending = 0;
    if (!blob || gen !== layer.blockGen || !layer.blockEl) return;
    if (layer.blockUrl) URL.revokeObjectURL(layer.blockUrl);
    layer.blockUrl = URL.createObjectURL(blob);
    const b = layer.blockEl;
    b.setAttribute('href', layer.blockUrl);
    b.setAttribute('x', String(box.x));
    b.setAttribute('y', String(box.y));
    b.setAttribute('width', String(box.w));
    b.setAttribute('height', String(box.h));
  });
}

// Libera la bitmap dell'estrusione (toggle off, livello morto, clearAll).
/** @param {Layer} layer */
export function freeBlockBitmap(layer) {
  if (layer.blockUrl) {
    URL.revokeObjectURL(layer.blockUrl);
    layer.blockUrl = '';
  }
  if (layer.blockEl) layer.blockEl.removeAttribute('href');
  layer.blockScale = 0;
  layer.blockKey = '';
  layer.blockPending = 0;
  // un blob ancora in volo per questo livello muore qui
  layer.blockGen = (layer.blockGen || 0) + 1;
}
