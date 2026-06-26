// TTF sources for the curated Google font list used by text_layer.js. The
// browser-facing Google Fonts CSS usually serves WOFF2, which is great for
// display but not useful for outline extraction here.
const FONT_TTF = {
  'Orbitron': 'https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf',
  'Anton': 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf',
  'Bebas Neue': 'https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf',
  'Montserrat': 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf',
  'Russo One': 'https://raw.githubusercontent.com/google/fonts/main/ofl/russoone/RussoOne-Regular.ttf',
  'Bungee': 'https://raw.githubusercontent.com/google/fonts/main/ofl/bungee/Bungee-Regular.ttf',
  'Press Start 2P': 'https://raw.githubusercontent.com/google/fonts/main/ofl/pressstart2p/PressStart2P-Regular.ttf',
  'Pacifico': 'https://raw.githubusercontent.com/google/fonts/main/ofl/pacifico/Pacifico-Regular.ttf',
  'Lobster': 'https://raw.githubusercontent.com/google/fonts/main/ofl/lobster/Lobster-Regular.ttf',
  'Playfair Display': 'https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf',
};

/** @typedef {{font: any|null, promise: Promise<any|null>|null}} FontEntry */

/** @type {Map<string, FontEntry>} */
const outlineFonts = new Map();

/** @type {Promise<any>|null} */
let opentypePromise = null;

function loadOpenType() {
  if (!opentypePromise) {
    opentypePromise = import('../node_modules/opentype.js/dist/opentype.min.mjs')
      .then((m) => m.default || m);
  }
  return opentypePromise;
}

/** @param {string} family @param {number} weight */
function cacheKey(family, weight) {
  return `${family}|${weight || 400}`;
}

/** @param {any} font @param {number} weight */
function applyWeight(font, weight) {
  try {
    if (font.variation && Number.isFinite(weight)) {
      font.variation.set({ wght: weight });
    }
  } catch {
    // Static fonts and older variation tables simply render at their default.
  }
  return font;
}

/**
 * Starts loading the outline font. Resolves to null on failure; callers should
 * keep their current vector fallback rather than blocking the UI.
 * @param {string} family
 * @param {number} weight
 * @returns {Promise<any|null>}
 */
export function ensureOutlineFont(family, weight) {
  const key = cacheKey(family, weight);
  const cur = outlineFonts.get(key);
  if (cur) return cur.font ? Promise.resolve(cur.font) : cur.promise || Promise.resolve(null);
  const url = FONT_TTF[family];
  if (!url) {
    outlineFonts.set(key, { font: null, promise: null });
    return Promise.resolve(null);
  }
  const entry = /** @type {FontEntry} */ ({ font: null, promise: null });
  entry.promise = fetch(url)
    .then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`font ${r.status}`)))
    .then(async (buf) => ({ buf, opentype: await loadOpenType() }))
    .then(({ buf, opentype }) => {
      const font = applyWeight(opentype.parse(buf), weight);
      entry.font = font;
      entry.promise = null;
      return font;
    })
    .catch((err) => {
      console.warn('[Text outline] font non disponibile:', family, err);
      entry.font = null;
      entry.promise = null;
      return null;
    });
  outlineFonts.set(key, entry);
  return entry.promise;
}

/**
 * @param {string} family
 * @param {number} weight
 * @returns {any|null}
 */
export function outlineFontSync(family, weight) {
  return outlineFonts.get(cacheKey(family, weight))?.font || null;
}

/**
 * Returns absolute OpenType path commands in world coordinates, centered around
 * the supplied x using the same measured width as the live SVG text.
 * @param {string} text
 * @param {number} x center x in world coordinates
 * @param {number} baselineY alphabetic baseline in world coordinates
 * @param {number} size font size in world px
 * @param {string} family
 * @param {number} weight
 * @param {number} measuredWidth browser-measured advance used by the app
 * @returns {any[]|null}
 */
export function outlineCommands(text, x, baselineY, size, family, weight, measuredWidth) {
  if (!text) return [];
  const font = outlineFontSync(family, weight);
  if (!font) return null;
  const left = x - measuredWidth / 2;
  return font.getPath(text, left, baselineY, size, { kerning: true }).commands;
}
