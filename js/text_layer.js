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

// Colore ombra: l'input color dà un hex pieno, un'ombra naturale è semi-trasparente.
/** @param {string} hex */
export function shadowCss(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.65)`;
}

/**
 * Stile del testo. Le misure sono in px mondo: scalano con lo zoom.
 * @typedef {Object} TextStyle
 * @property {string} font
 * @property {number} weight
 * @property {number} stroke larghezza bordo (px mondo, 0 = niente)
 * @property {string} strokeColor
 * @property {number} shadowBlur sfocatura ombra (px mondo, 0 = niente)
 * @property {number} shadowDist distanza ombra lungo la diagonale (px mondo)
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
    shadowBlur: 0, shadowDist: 0, shadowColor: '#000000',
  };
}

/** @param {number} x @param {number} y @param {string} fill @param {number} size @returns {TextItem} */
export function makeTextItem(x, y, fill, size) {
  return { text: 'M1M4.COM', x, y, size, fill };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Crea il piano SVG di un livello testo (lo possiede planes.js).
/** @param {Layer} layer */
export function createTextSvg(layer) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'textplane');
  svg.setAttribute('aria-hidden', 'true');
  // il viewBox ha lo stesso aspect del viewport: 'none' evita letterbox
  // da arrotondamenti e mappa mondo -> schermo esattamente come la camera
  svg.setAttribute('preserveAspectRatio', 'none');
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'central');
  // il bordo è sotto il fill (paint-order): stroke centrato largo il doppio,
  // la metà interna è coperta -> bordo "esterno" come nei programmi di grafica
  t.setAttribute('paint-order', 'stroke');
  t.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(t);
  layer.svg = svg;
  layer.textEl = t;
  layer.styleDirty = true;
  return svg;
}

// Applica item + stile + visibilità/opacità del livello agli attributi SVG.
/** @param {Layer} layer */
export function syncTextSvg(layer) {
  const it = layer.item, t = layer.textEl, st = layer.style;
  if (!t) return;
  layer.svg.style.display = layer.visible && layer.opacity > 0 ? 'block' : 'none';
  layer.svg.style.opacity = String(layer.opacity);
  t.textContent = it.text;
  t.setAttribute('x', String(it.x));
  t.setAttribute('y', String(it.y));
  t.setAttribute('font-size', String(it.size));
  t.setAttribute('font-family', `"${st.font}", sans-serif`);
  t.setAttribute('font-weight', String(st.weight));
  t.setAttribute('fill', it.fill);
  if (st.stroke > 0) {
    t.setAttribute('stroke', st.strokeColor);
    t.setAttribute('stroke-width', String(st.stroke * 2));
  } else {
    t.removeAttribute('stroke');
    t.removeAttribute('stroke-width');
  }
  // filter CSS su elemento SVG: lunghezze in unità utente = px mondo,
  // quindi l'ombra scala con lo zoom da sola
  t.style.filter = (st.shadowBlur > 0 || st.shadowDist > 0)
    ? `drop-shadow(${st.shadowDist * 0.7071}px ${st.shadowDist * 0.7071}px ` +
      `${st.shadowBlur}px ${shadowCss(st.shadowColor)})`
    : '';
}
