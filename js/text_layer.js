// LIVELLO TESTO VETTORIALE — vettore puro fino allo schermo, come Kittl:
// il testo vive in un overlay SVG sopra il canvas (pointer-events: none) e il
// viewBox segue la camera: il browser rasterizza i glifi alla risoluzione del
// device a ogni paint, quindi è nitido sempre, anche DURANTE il gesto di zoom.
// Nessuna texture, nessun re-raster nostro: scritture DOM solo quando camera
// o stile cambiano davvero.

/** @typedef {import('./camera.js').Camera} Camera */

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
function shadowCss(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.65)`;
}

/**
 * Stile del testo (persiste tra un posizionamento e l'altro). Le misure sono
 * in px mondo: scalano con lo zoom come il disegno.
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

const SVG_NS = 'http://www.w3.org/2000/svg';

export class TextLayer {
  constructor() {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.id = 'textsvg';
    this.svg.setAttribute('aria-hidden', 'true');
    // il viewBox ha lo stesso aspect del viewport: 'none' evita letterbox
    // da arrotondamenti e mappa mondo -> schermo esattamente come la camera
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.style.display = 'none';
    this.textEl = document.createElementNS(SVG_NS, 'text');
    this.textEl.setAttribute('text-anchor', 'middle');
    this.textEl.setAttribute('dominant-baseline', 'central');
    // il bordo è sotto il fill (paint-order): stroke centrato largo il doppio,
    // la metà interna è coperta -> bordo "esterno" come nei programmi di grafica
    this.textEl.setAttribute('paint-order', 'stroke');
    this.textEl.setAttribute('stroke-linejoin', 'round');
    this.svg.appendChild(this.textEl);
    document.body.appendChild(this.svg);

    /** @type {TextItem|null} */
    this.item = null;
    /** @type {TextStyle} */
    this.style = {
      font: 'Orbitron', weight: 700,
      stroke: 0, strokeColor: '#ffffff',
      shadowBlur: 0, shadowDist: 0, shadowColor: '#000000',
    };
    this.styleDirty = false;
    // camera dell'ultimo viewBox scritto (niente stringhe se non cambia nulla)
    this._cx = NaN; this._cy = NaN; this._cz = NaN; this._cw = NaN; this._ch = NaN;
  }

  // Posiziona (o riposiziona) il testo con il centro in (x, y) mondo.
  // size in px mondo: il chiamante la calcola dalla vista corrente.
  /** @param {number} x @param {number} y @param {string} fill @param {number} size */
  place(x, y, fill, size) {
    this.item = { text: 'M1M4.COM', x, y, size, fill };
    this.styleDirty = true;
    ensureFont(this.style.font, this.style.weight);
  }

  /** @param {string} family */
  setFont(family) {
    const def = TEXT_FONTS.find((f) => f.family === family);
    if (!def) return;
    this.style.font = def.family;
    this.style.weight = def.weight;
    this.styleDirty = true;
    ensureFont(def.family, def.weight);
  }

  clear() {
    this.item = null;
    this.styleDirty = true;
  }

  // Una chiamata per frame: applica stile e viewBox solo se cambiati.
  /** @param {Camera} camera */
  update(camera) {
    if (this.styleDirty) {
      this.styleDirty = false;
      this._applyStyle();
    }
    const it = this.item;
    if (!it) return;
    if (camera.x !== this._cx || camera.y !== this._cy || camera.zoom !== this._cz ||
        camera.w !== this._cw || camera.h !== this._ch) {
      this._cx = camera.x; this._cy = camera.y; this._cz = camera.zoom;
      this._cw = camera.w; this._ch = camera.h;
      const hw = camera.w * 0.5 / camera.zoom, hh = camera.h * 0.5 / camera.zoom;
      this.svg.setAttribute('viewBox', `${camera.x - hw} ${camera.y - hh} ${hw * 2} ${hh * 2}`);
    }
  }

  _applyStyle() {
    const it = this.item, t = this.textEl;
    if (!it) {
      this.svg.style.display = 'none';
      return;
    }
    const st = this.style;
    this.svg.style.display = 'block';
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
    // filter CSS su elemento SVG: le lunghezze sono in unità utente = px
    // mondo, quindi l'ombra scala con lo zoom da sola
    t.style.filter = (st.shadowBlur > 0 || st.shadowDist > 0)
      ? `drop-shadow(${st.shadowDist * 0.7071}px ${st.shadowDist * 0.7071}px ` +
        `${st.shadowBlur}px ${shadowCss(st.shadowColor)})`
      : '';
  }
}
