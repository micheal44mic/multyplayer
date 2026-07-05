// SVG IMPORTATI — livello vettoriale statico.
// Il contenuto importato resta SVG, ma viene sanitizzato e montato dentro un
// piano SVG del documento: opacita, visibilita, ordine livelli e transform
// restano proprieta del layer, come per i testi live.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {Object} SvgItem
 * @property {string} content markup interno sanitizzato dell'SVG originale
 * @property {number} viewX
 * @property {number} viewY
 * @property {number} viewW
 * @property {number} viewH
 * @property {number} x mondo: riquadro di import
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {[number, number, number, number, number, number]} m matrice mondo->mondo
 * @property {[string, string][]} [rootAttrs] attributi sanitizzati della root SVG originale
 * @property {number} [paintGroupVersion]
 * @property {number} [paintGroupNextId]
 * @property {import('./pen_tool.js').PenData} [pen] tracciato Penna: geometria strutturata (lo stile resta negli attributi del path in content)
 */

/**
 * @typedef {Object} SvgPaint
 * @property {string} key
 * @property {string} hex #RRGGBB
 * @property {number} opacity 0..1
 * @property {number} count
 */

const PAINT_PROPS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'];
const PAINT_PROP_SET = new Set(PAINT_PROPS);
const OPACITY_PROP = {
  fill: 'fill-opacity',
  stroke: 'stroke-opacity',
  'stop-color': 'stop-opacity',
  'flood-color': 'flood-opacity',
};
const PAINT_GROUP_VERSION = 1;
const CSS_PAINT_MARKER_RE = /^\s*\/\*fp-svg-paint:([a-z0-9_-]+)\*\//i;
const CSS_PAINT_MARKER_ANY_RE = /\/\*fp-svg-paint:([a-z0-9_-]+)\*\//gi;
const COLOR_NAMES = new Set([
  'black', 'silver', 'gray', 'white', 'maroon', 'red', 'purple', 'fuchsia',
  'green', 'lime', 'olive', 'yellow', 'navy', 'blue', 'teal', 'aqua',
  'orange', 'transparent',
]);
const COLOR_TOKEN_RE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|rgba?\(\s*[^)]+\)|\b(?:black|silver|gray|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|orange|transparent)\b/gi;
const ROOT_ATTR_SKIP = new Set([
  'xmlns', 'xmlns:xlink', 'version',
  'x', 'y', 'width', 'height', 'viewbox', 'preserveaspectratio', 'overflow',
]);
const ROOT_STYLE_SKIP = new Set([
  'x', 'y', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'left', 'top', 'right', 'bottom', 'position', 'overflow',
]);

/** @param {string} v @returns {number} */
function parseLength(v) {
  const m = String(v || '').trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  return m ? Number(m[0]) : NaN;
}

/** @param {SVGSVGElement} root */
function readViewBox(root) {
  const raw = root.getAttribute('viewBox') || '';
  const nums = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  if (nums.length === 4 && nums[2] > 0 && nums[3] > 0) {
    return { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
  }
  const w = parseLength(root.getAttribute('width') || '');
  const h = parseLength(root.getAttribute('height') || '');
  return {
    x: 0, y: 0,
    w: Number.isFinite(w) && w > 0 ? w : 1024,
    h: Number.isFinite(h) && h > 0 ? h : 1024,
  };
}

/** @param {string} css */
function scrubCss(css) {
  return String(css || '')
    .replace(/@import[^;{}]*(?:;|$)/gi, '')
    .replace(/url\(\s*(['"]?)(?!#)[^)]+\1\s*\)/gi, 'none')
    .replace(/javascript\s*:/gi, '');
}

/** @param {string} v */
function safeUrlValue(v) {
  const s = String(v || '').trim();
  if (/javascript\s*:/i.test(s)) return false;
  if (/url\(\s*(['"]?)(?!#)[^)]+\1\s*\)/i.test(s)) return false;
  return true;
}

/** @param {string} v */
function escapeAttr(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** @param {string} name */
function isBlockedTag(name) {
  return new Set([
    'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video',
    'canvas', 'image',
  ]).has(name);
}

/** @param {string} s */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {number} v */
function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
}

/** @param {number} v */
function hex2(v) {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
}

/** @param {string} hex */
function normalizeHex(hex) {
  let h = String(hex || '').trim();
  if (!h.startsWith('#')) h = '#' + h;
  if (/^#[0-9a-f]{3,4}$/i.test(h)) {
    const r = h[1], g = h[2], b = h[3], a = h[4];
    h = '#' + r + r + g + g + b + b + (a ? a + a : '');
  }
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(h)) return '#000000';
  return h.slice(0, 7).toUpperCase();
}

/** @param {string} hex @param {number} opacity */
export function svgPaintKey(hex, opacity) {
  return `${normalizeHex(hex)}|${Math.round(clamp01(opacity) * 1000)}`;
}

/**
 * @param {string} value
 * @returns {{hex: string, opacity: number}|null}
 */
function parseColor(value) {
  const raw = String(value || '').trim();
  const low = raw.toLowerCase();
  if (!raw || low === 'none' || low === 'currentcolor' ||
    low === 'inherit' || low === 'unset' || low === 'initial' ||
    low.startsWith('url(') || low.startsWith('var(') ||
    low === 'context-fill' || low === 'context-stroke') return null;
  if (low === 'transparent') return { hex: '#000000', opacity: 0 };
  let m = raw.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const opacity = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { hex: ('#' + h.slice(0, 6)).toUpperCase(), opacity };
  }
  m = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[,/ ]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const rgb = parts.slice(0, 3).map((p) => p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p));
      const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
      if (rgb.every(Number.isFinite)) return {
        hex: '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]),
        opacity: clamp01(Number.isFinite(a) ? a : 1),
      };
    }
  }
  if (COLOR_NAMES.has(low) && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillStyle = raw;
      const parsed = parseColor(ctx.fillStyle);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** @param {string} hex @param {number} opacity */
function colorCss(hex, opacity = 1) {
  const h = normalizeHex(hex);
  const a = clamp01(opacity);
  if (a >= 0.999) return h;
  return `rgba(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}, ${Math.round(a * 1000) / 1000})`;
}

/** @param {string} v */
function cleanPaintGroupId(v) {
  const id = String(v || '').trim();
  return /^[a-z][a-z0-9_-]*$/i.test(id) ? id : '';
}

/** @param {string} id */
function paintGroupNumber(id) {
  const m = cleanPaintGroupId(id).match(/^g(\d+)$/i);
  return m ? Number(m[1]) || 0 : 0;
}

/** @param {'attr'|'style'} kind @param {string} prop */
function paintGroupAttr(kind, prop) {
  return `data-fp-svg-${kind}-${prop.replace(/[^a-z0-9_-]/gi, '-')}-group`;
}

/** @param {Element} el @param {'attr'|'style'} kind @param {string} prop */
function readPaintGroup(el, kind, prop) {
  return cleanPaintGroupId(el.getAttribute(paintGroupAttr(kind, prop)) || '');
}

/** @param {Element} el @param {'attr'|'style'} kind @param {string} prop @param {string} groupId */
function setPaintGroup(el, kind, prop, groupId) {
  el.setAttribute(paintGroupAttr(kind, prop), groupId);
}

/** @param {string} groupId */
function cssPaintMarker(groupId) {
  return `/*fp-svg-paint:${groupId}*/`;
}

/** @param {string} css @param {number} afterColorIndex */
function readCssPaintGroup(css, afterColorIndex) {
  const m = String(css || '').slice(afterColorIndex).match(CSS_PAINT_MARKER_RE);
  return m ? cleanPaintGroupId(m[1]) : '';
}

/** @param {string} css @param {number} start @param {string} ch */
function findCssTopLevel(css, start, ch) {
  let quote = '', paren = 0;
  for (let i = start; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '*') {
      i = css.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')' && paren > 0) { paren--; continue; }
    if (paren === 0 && c === ch) return i;
  }
  return -1;
}

/** @param {string} css @param {number} open */
function findCssCloseBrace(css, open) {
  let depth = 1, quote = '', paren = 0;
  for (let i = open + 1; i < css.length; i++) {
    const c = css[i], n = css[i + 1];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '*') {
      i = css.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')' && paren > 0) { paren--; continue; }
    if (paren !== 0) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * @param {string} css
 * @param {(token: string, absoluteOffset: number) => string} cb
 * @param {number} [baseOffset]
 */
function replaceCssDeclarationColors(css, cb, baseOffset = 0) {
  let out = '', i = 0;
  while (i < css.length) {
    const open = findCssTopLevel(css, i, '{');
    if (open < 0) { out += css.slice(i); break; }
    const close = findCssCloseBrace(css, open);
    if (close < 0) { out += css.slice(i); break; }
    const body = css.slice(open + 1, close);
    out += css.slice(i, open + 1);
    if (findCssTopLevel(body, 0, '{') >= 0) {
      out += replaceCssDeclarationColors(body, cb, baseOffset + open + 1);
    } else {
      out += replaceCssDeclarationBodyColors(body, cb, baseOffset + open + 1);
    }
    out += '}';
    i = close + 1;
  }
  return out;
}

/**
 * @param {string} body
 * @param {(token: string, absoluteOffset: number) => string} cb
 * @param {number} baseOffset
 */
function replaceCssDeclarationBodyColors(body, cb, baseOffset) {
  let out = '', i = 0;
  while (i < body.length) {
    const semi = findCssTopLevel(body, i, ';');
    const colon = findCssTopLevel(body, i, ':');
    if (colon < 0 || (semi >= 0 && semi < colon)) {
      const end = semi >= 0 ? semi + 1 : body.length;
      out += body.slice(i, end);
      i = end;
      continue;
    }
    const valueEnd = findCssTopLevel(body, colon + 1, ';');
    const end = valueEnd >= 0 ? valueEnd : body.length;
    const prop = body.slice(i, colon).trim().toLowerCase();
    if (!PAINT_PROP_SET.has(prop)) {
      out += body.slice(i, valueEnd >= 0 ? valueEnd + 1 : body.length);
      i = valueEnd >= 0 ? valueEnd + 1 : body.length;
      continue;
    }
    out += body.slice(i, colon + 1);
    const value = body.slice(colon + 1, end);
    COLOR_TOKEN_RE.lastIndex = 0;
    out += value.replace(COLOR_TOKEN_RE, (tok, offset) =>
      isCssPaintToken(value, offset, tok) ? cb(tok, baseOffset + colon + 1 + offset) : tok);
    if (valueEnd >= 0) out += ';';
    i = valueEnd >= 0 ? valueEnd + 1 : body.length;
  }
  return out;
}

/**
 * @param {string} value
 * @param {number} offset
 * @param {string} tok
 */
function isCssPaintToken(value, offset, tok) {
  const before = value[offset - 1] || '';
  const after = value[offset + tok.length] || '';
  if (/^[a-z]/i.test(tok) && (/[#\w-]/.test(before) || /[\w-]/.test(after))) return false;
  if (tok[0] === '#' && /[\w-]/.test(before)) return false;
  const stack = cssFunctionStackAt(value, offset);
  if (stack.includes('url')) return false;
  if (stack.length && !/^rgba?\(/i.test(tok)) return false;
  return true;
}

/** @param {string} s @param {number} offset */
function cssFunctionStackAt(s, offset) {
  /** @type {string[]} */
  const stack = [];
  let quote = '';
  for (let i = 0; i < offset; i++) {
    const c = s[i], n = s[i + 1];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0 || i >= offset) break;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ')') { stack.pop(); continue; }
    if (c !== '(') continue;
    const head = s.slice(0, i).match(/([a-z_-][\w-]*)\s*$/i);
    stack.push(head ? head[1].toLowerCase() : '');
  }
  return stack;
}

/**
 * @param {string} css
 * @param {(token: string, absoluteOffset: number) => void} cb
 */
function forEachCssDeclarationColor(css, cb) {
  replaceCssDeclarationColors(css, (tok, offset) => {
    cb(tok, offset);
    return tok;
  });
}

/**
 * @param {string} css
 * @param {Map<string, string>} ids
 * @param {number} [baseOffset]
 */
function rewriteCssIdSelectors(css, ids, baseOffset = 0) {
  if (ids.size === 0) return css;
  let out = '', i = 0;
  while (i < css.length) {
    const open = findCssTopLevel(css, i, '{');
    if (open < 0) { out += rewriteCssSelectorText(css.slice(i), ids); break; }
    const close = findCssCloseBrace(css, open);
    if (close < 0) { out += rewriteCssSelectorText(css.slice(i), ids); break; }
    const body = css.slice(open + 1, close);
    out += rewriteCssSelectorText(css.slice(i, open), ids) + '{';
    out += findCssTopLevel(body, 0, '{') >= 0
      ? rewriteCssIdSelectors(body, ids, baseOffset + open + 1)
      : body;
    out += '}';
    i = close + 1;
  }
  return out;
}

/** @param {string} s @param {Map<string, string>} ids */
function rewriteCssSelectorText(s, ids) {
  let out = s;
  for (const [oldId, newId] of ids) {
    out = out.replace(new RegExp(`(^|[^\\\\])#${reEscape(oldId)}(?=$|[^a-z0-9_-])`, 'gi'), `$1#${newId}`);
  }
  return out;
}

/** @param {string} s @returns {{order: string[], map: Map<string, string>}} */
function parseStyleDecls(s) {
  const order = [];
  const map = new Map();
  for (const part of String(s || '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!name) continue;
    if (!map.has(name)) order.push(name);
    map.set(name, val);
  }
  return { order, map };
}

/** @param {{order: string[], map: Map<string, string>}} decls */
function styleDeclsText(decls) {
  const names = decls.order.filter((name) => decls.map.has(name));
  return names.map((name) => `${name}: ${decls.map.get(name)}`).join('; ');
}

/** @param {string} name */
function safeAttrName(name) {
  return /^[a-z_][\w:.-]*$/i.test(name);
}

/** @param {string} style */
function scrubRootStyle(style) {
  return scrubCss(style).split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const i = part.indexOf(':');
      if (i < 0) return false;
      return !ROOT_STYLE_SKIP.has(part.slice(0, i).trim().toLowerCase());
    })
    .join('; ');
}

/** @param {SVGSVGElement} root @returns {[string, string][]} */
function svgRootAttrs(root) {
  /** @type {[string, string][]} */
  const out = [];
  for (const attr of Array.from(root.attributes)) {
    const name = attr.name;
    const low = name.toLowerCase();
    if (!safeAttrName(name) || ROOT_ATTR_SKIP.has(low) || low.startsWith('on') || low === 'src') continue;
    let value = attr.value;
    if ((low === 'href' || low === 'xlink:href') && !value.trim().startsWith('#')) continue;
    if (low === 'style') value = scrubRootStyle(value);
    if (!value.trim() || !safeUrlValue(value)) continue;
    out.push([name, value]);
  }
  return out;
}

/** @param {SvgItem} item */
function svgRootAttrsKey(item) {
  return (item.rootAttrs || []).map(([name, value]) => `${name}=${value}`).join('|');
}

/** @param {Element} el @param {SvgItem} item */
function applySvgRootAttrs(el, item) {
  for (const pair of item.rootAttrs || []) {
    if (!pair || pair.length < 2) continue;
    const name = String(pair[0] || '');
    const low = name.toLowerCase();
    if (!safeAttrName(name) || ROOT_ATTR_SKIP.has(low)) continue;
    el.setAttribute(name, String(pair[1] || ''));
  }
}

/** @param {SvgItem} item */
function svgRootAttrsMarkup(item) {
  let out = '';
  for (const pair of item.rootAttrs || []) {
    if (!pair || pair.length < 2) continue;
    const name = String(pair[0] || '');
    const low = name.toLowerCase();
    if (!safeAttrName(name) || ROOT_ATTR_SKIP.has(low)) continue;
    out += ` ${name}="${escapeAttr(pair[1])}"`;
  }
  return out;
}

/**
 * @param {Element} el
 * @param {string} prop
 * @param {{order: string[], map: Map<string, string>}|null} decls
 * @param {number} fallback
 */
function paintOpacity(el, prop, decls, fallback) {
  const op = OPACITY_PROP[prop];
  if (!op) return fallback;
  const styled = decls && decls.map.has(op) ? parseFloat(decls.map.get(op)) : NaN;
  if (Number.isFinite(styled)) return clamp01(styled);
  const attr = parseFloat(el.getAttribute(op) || '');
  return Number.isFinite(attr) ? clamp01(attr) : fallback;
}

/**
 * @param {Map<string, SvgPaint>} out
 * @param {string} groupId
 * @param {string} hex
 * @param {number} opacity
 */
function addPaint(out, groupId, hex, opacity) {
  const id = groupId || svgPaintKey(hex, opacity);
  const h = normalizeHex(hex);
  const a = clamp01(opacity);
  const prev = out.get(id);
  if (prev) prev.count++;
  else out.set(id, { key: id, hex: h, opacity: a, count: 1 });
}

/**
 * @param {SvgItem} item
 * @returns {SVGSVGElement|null}
 */
function parseContentRoot(item) {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink">${item.content || ''}</svg>`,
    'image/svg+xml');
  const root = /** @type {SVGSVGElement|null} */ (doc.documentElement);
  return root && root.localName.toLowerCase() === 'svg' ? root : null;
}

/**
 * @param {Map<string, string>} byPaintKey
 * @param {string} groupId
 * @param {string} hex
 * @param {number} opacity
 */
function seedPaintGroup(byPaintKey, groupId, hex, opacity) {
  if (!groupId) return;
  const key = svgPaintKey(hex, opacity);
  const prev = byPaintKey.get(key);
  if (prev === undefined) byPaintKey.set(key, groupId);
  else if (prev !== groupId) byPaintKey.set(key, '');
}

/**
 * @param {SVGSVGElement} root
 * @returns {{maxId: number, byPaintKey: Map<string, string>}}
 */
function collectPaintGroupSeeds(root) {
  let maxId = 0;
  /** @type {Map<string, string>} */
  const byPaintKey = new Map();
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^data-fp-svg-.*-group$/i.test(attr.name)) {
        maxId = Math.max(maxId, paintGroupNumber(attr.value));
      }
    }
    if (el.localName.toLowerCase() === 'style') {
      const css = el.textContent || '';
      for (const m of css.matchAll(CSS_PAINT_MARKER_ANY_RE)) {
        maxId = Math.max(maxId, paintGroupNumber(m[1]));
      }
      forEachCssDeclarationColor(css, (tok, offset) => {
        const c = parseColor(tok);
        if (!c) return;
        const groupId = readCssPaintGroup(css, offset + tok.length);
        if (groupId) seedPaintGroup(byPaintKey, groupId, c.hex, c.opacity);
      });
      continue;
    }
    const styleRaw = el.getAttribute('style') || '';
    const decls = styleRaw ? parseStyleDecls(styleRaw) : null;
    for (const prop of PAINT_PROPS) {
      if (el.hasAttribute(prop)) {
        const c = parseColor(el.getAttribute(prop));
        if (c) {
          const groupId = readPaintGroup(el, 'attr', prop);
          if (groupId) seedPaintGroup(byPaintKey, groupId, c.hex, paintOpacity(el, prop, decls, c.opacity));
        }
      }
      if (decls && decls.map.has(prop)) {
        const c = parseColor(decls.map.get(prop));
        if (c) {
          const groupId = readPaintGroup(el, 'style', prop);
          if (groupId) seedPaintGroup(byPaintKey, groupId, c.hex, paintOpacity(el, prop, decls, c.opacity));
        }
      }
    }
  }
  return { maxId, byPaintKey };
}

/**
 * Adds stable, non-rendering group ids to every editable paint occurrence.
 * Equal colors in the original SVG share a group id; once assigned, those ids
 * stay with the original occurrences even if two groups later look identical.
 * @param {SvgItem} item
 */
export function ensureSvgPaintGroups(item) {
  const root = parseContentRoot(item);
  if (!root) return false;
  const seeds = collectPaintGroupSeeds(root);
  let nextId = Math.max(1, Number(item.paintGroupNextId) || 1, seeds.maxId + 1);
  let changed = false;

  /** @param {string} hex @param {number} opacity */
  const groupFor = (hex, opacity) => {
    const key = svgPaintKey(hex, opacity);
    const seeded = seeds.byPaintKey.get(key);
    if (seeded) return seeded;
    const groupId = `g${nextId++}`;
    seeds.byPaintKey.set(key, groupId);
    return groupId;
  };

  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.localName.toLowerCase() === 'style') {
      const css = el.textContent || '';
      const next = replaceCssDeclarationColors(css, (tok, offset) => {
        const c = parseColor(tok);
        if (!c || readCssPaintGroup(css, offset + tok.length)) return tok;
        changed = true;
        return tok + cssPaintMarker(groupFor(c.hex, c.opacity));
      });
      if (next !== css) el.textContent = next;
      continue;
    }
    const styleRaw = el.getAttribute('style') || '';
    const decls = styleRaw ? parseStyleDecls(styleRaw) : null;
    for (const prop of PAINT_PROPS) {
      if (el.hasAttribute(prop) && !readPaintGroup(el, 'attr', prop)) {
        const c = parseColor(el.getAttribute(prop));
        if (c) {
          setPaintGroup(el, 'attr', prop, groupFor(c.hex, paintOpacity(el, prop, decls, c.opacity)));
          changed = true;
        }
      }
      if (decls && decls.map.has(prop) && !readPaintGroup(el, 'style', prop)) {
        const c = parseColor(decls.map.get(prop));
        if (c) {
          setPaintGroup(el, 'style', prop, groupFor(c.hex, paintOpacity(el, prop, decls, c.opacity)));
          changed = true;
        }
      }
    }
  }

  if (changed) item.content = root.innerHTML;
  if (item.paintGroupVersion !== PAINT_GROUP_VERSION || item.paintGroupNextId !== nextId) {
    item.paintGroupVersion = PAINT_GROUP_VERSION;
    item.paintGroupNextId = nextId;
    changed = true;
  }
  return changed;
}

/** @param {SvgItem} item */
function ensureSvgPaintGroupsOnce(item) {
  if (item.paintGroupVersion === PAINT_GROUP_VERSION && Number(item.paintGroupNextId) > 0) return false;
  return ensureSvgPaintGroups(item);
}

/** @param {SvgItem} item @returns {SvgPaint[]} */
export function listSvgPaints(item) {
  ensureSvgPaintGroups(item);
  const root = parseContentRoot(item);
  if (!root) return [];
  /** @type {Map<string, SvgPaint>} */
  const out = new Map();
  const all = Array.from(root.querySelectorAll('*'));
  for (const el of all) {
    if (el.localName.toLowerCase() === 'style') {
      const css = el.textContent || '';
      forEachCssDeclarationColor(css, (tok, offset) => {
        const c = parseColor(tok);
        if (c) addPaint(out, readCssPaintGroup(css, offset + tok.length), c.hex, c.opacity);
      });
      continue;
    }
    const styleRaw = el.getAttribute('style') || '';
    const decls = styleRaw ? parseStyleDecls(styleRaw) : null;
    for (const prop of PAINT_PROPS) {
      if (el.hasAttribute(prop)) {
        const c = parseColor(el.getAttribute(prop));
        if (c) addPaint(out, readPaintGroup(el, 'attr', prop), c.hex, paintOpacity(el, prop, decls, c.opacity));
      }
      if (decls && decls.map.has(prop)) {
        const c = parseColor(decls.map.get(prop));
        if (c) addPaint(out, readPaintGroup(el, 'style', prop), c.hex, paintOpacity(el, prop, decls, c.opacity));
      }
    }
  }
  return Array.from(out.values());
}

/**
 * @param {string} value
 * @param {string} nextHex
 * @param {number|null} nextOpacity
 */
function rewriteColorValue(value, nextHex, nextOpacity) {
  const c = parseColor(value);
  if (!c) return value;
  return colorCss(nextHex, nextOpacity === null ? c.opacity : nextOpacity);
}

/**
 * @param {string} wanted
 * @param {string} groupId
 * @param {string} hex
 * @param {number} opacity
 */
function paintTargetMatches(wanted, groupId, hex, opacity) {
  return groupId ? groupId === wanted : svgPaintKey(hex, opacity) === wanted;
}

/**
 * @param {SVGSVGElement} root
 * @param {string} key stable paint group id
 * @param {string} nextHex
 */
function setSvgPaintColorInRoot(root, key, nextHex) {
  let changed = false;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.localName.toLowerCase() === 'style') {
      const css = el.textContent || '';
      const next = replaceCssDeclarationColors(css, (tok, offset) => {
        const c = parseColor(tok);
        const groupId = readCssPaintGroup(css, offset + tok.length);
        return c && paintTargetMatches(key, groupId, c.hex, c.opacity) ? colorCss(nextHex, c.opacity) : tok;
      });
      if (next !== css) { el.textContent = next; changed = true; }
      continue;
    }
    const styleRaw = el.getAttribute('style') || '';
    const decls = styleRaw ? parseStyleDecls(styleRaw) : null;
    let styleChanged = false;
    for (const prop of PAINT_PROPS) {
      if (el.hasAttribute(prop)) {
        const c = parseColor(el.getAttribute(prop));
        const paintAlpha = c ? paintOpacity(el, prop, decls, c.opacity) : 1;
        const cur = el.getAttribute(prop);
        const next = c && paintTargetMatches(key, readPaintGroup(el, 'attr', prop), c.hex, paintAlpha)
          ? rewriteColorValue(cur, nextHex, null)
          : cur;
        if (next !== el.getAttribute(prop)) { el.setAttribute(prop, next); changed = true; }
      }
      if (decls && decls.map.has(prop)) {
        const c = parseColor(decls.map.get(prop));
        const paintAlpha = c ? paintOpacity(el, prop, decls, c.opacity) : 1;
        const cur = decls.map.get(prop);
        const next = c && paintTargetMatches(key, readPaintGroup(el, 'style', prop), c.hex, paintAlpha)
          ? rewriteColorValue(cur, nextHex, null)
          : cur;
        if (next !== cur) { decls.map.set(prop, next); changed = true; styleChanged = true; }
      }
    }
    if (decls && styleChanged) el.setAttribute('style', styleDeclsText(decls));
  }
  return changed;
}

/**
 * @param {SVGSVGElement} root
 * @param {string} key stable paint group id
 * @param {number} opacity
 */
function setSvgPaintOpacityInRoot(root, key, opacity) {
  const a = clamp01(opacity);
  let changed = false;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.localName.toLowerCase() === 'style') {
      const css = el.textContent || '';
      const next = replaceCssDeclarationColors(css, (tok, offset) => {
        const c = parseColor(tok);
        const groupId = readCssPaintGroup(css, offset + tok.length);
        return c && paintTargetMatches(key, groupId, c.hex, c.opacity) ? colorCss(c.hex, a) : tok;
      });
      if (next !== css) { el.textContent = next; changed = true; }
      continue;
    }
    const styleRaw = el.getAttribute('style') || '';
    const decls = styleRaw ? parseStyleDecls(styleRaw) : null;
    let styleChanged = false;
    for (const prop of PAINT_PROPS) {
      const opProp = OPACITY_PROP[prop];
      if (el.hasAttribute(prop)) {
        const c = parseColor(el.getAttribute(prop));
        if (c && paintTargetMatches(key, readPaintGroup(el, 'attr', prop), c.hex, paintOpacity(el, prop, decls, c.opacity))) {
          if (opProp) el.setAttribute(opProp, String(Math.round(a * 1000) / 1000));
          else el.setAttribute(prop, colorCss(c.hex, a));
          changed = true;
        }
      }
      if (decls && decls.map.has(prop)) {
        const c = parseColor(decls.map.get(prop));
        if (c && paintTargetMatches(key, readPaintGroup(el, 'style', prop), c.hex, paintOpacity(el, prop, decls, c.opacity))) {
          if (opProp) {
            if (!decls.map.has(opProp)) decls.order.push(opProp);
            decls.map.set(opProp, String(Math.round(a * 1000) / 1000));
          } else {
            decls.map.set(prop, colorCss(c.hex, a));
          }
          changed = true;
          styleChanged = true;
        }
      }
    }
    if (decls && styleChanged) el.setAttribute('style', styleDeclsText(decls));
  }
  return changed;
}

/** @param {import('./layers.js').Layer} layer */
function mountedSvgContentRoot(layer) {
  const source = layer.svgSourceEl;
  if (!source) return null;
  const root = source.querySelector('svg');
  return root && root.localName.toLowerCase() === 'svg' ? /** @type {SVGSVGElement} */ (root) : null;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {boolean} groupsChanged
 */
function editableSvgRoot(layer, groupsChanged) {
  const liveRoot = mountedSvgContentRoot(layer);
  if (liveRoot) {
    if (groupsChanged && layer.svgItem) liveRoot.innerHTML = layer.svgItem.content;
    return { root: liveRoot, mounted: true };
  }
  if (!layer.svgItem) return null;
  const root = parseContentRoot(layer.svgItem);
  return root ? { root, mounted: false } : null;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {string} key stable paint group id
 * @param {string} nextHex
 */
export function setSvgPaintColor(layer, key, nextHex) {
  if (!layer.svgItem) return false;
  const groupsChanged = ensureSvgPaintGroupsOnce(layer.svgItem);
  const editable = editableSvgRoot(layer, groupsChanged);
  if (!editable) return false;
  const changed = setSvgPaintColorInRoot(editable.root, key, nextHex);
  if (!changed) return false;
  layer.svgItem.content = editable.root.innerHTML;
  if (editable.mounted) {
    layer.svgKey = svgPlaneContentKey(layer.svgItem);
    touchSvgInPlace(layer);
  } else {
    touchSvg(layer);
  }
  return true;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {string} key stable paint group id
 * @param {number} opacity
 */
export function setSvgPaintOpacity(layer, key, opacity) {
  if (!layer.svgItem) return false;
  const groupsChanged = ensureSvgPaintGroupsOnce(layer.svgItem);
  const editable = editableSvgRoot(layer, groupsChanged);
  if (!editable) return false;
  const changed = setSvgPaintOpacityInRoot(editable.root, key, opacity);
  if (!changed) return false;
  layer.svgItem.content = editable.root.innerHTML;
  if (editable.mounted) {
    layer.svgKey = svgPlaneContentKey(layer.svgItem);
    touchSvgInPlace(layer);
  } else {
    touchSvg(layer);
  }
  return true;
}

/**
 * @param {SVGSVGElement} root
 * @param {string} prefix
 */
function sanitize(root, prefix) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  const all = [root, ...Array.from(root.querySelectorAll('*'))];

  for (const el of all) {
    const name = el.localName.toLowerCase();
    if (el !== root && isBlockedTag(name)) {
      el.remove();
      continue;
    }
    if (name === 'style') {
      const css = scrubCss(el.textContent || '');
      if (css.trim()) el.textContent = css;
      else el.remove();
      continue;
    }
    const id = el.getAttribute('id');
    if (id) {
      const next = `${prefix}-${id.replace(/[^\w.-]/g, '_')}`;
      ids.set(id, next);
      el.setAttribute('id', next);
    }
  }

  const live = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of live) {
    if (el.localName.toLowerCase() === 'style') {
      let css = el.textContent || '';
      for (const [oldId, newId] of ids) {
        css = css.replace(new RegExp(`url\\(\\s*(['"]?)#${reEscape(oldId)}\\1\\s*\\)`, 'g'), `url(#${newId})`);
      }
      css = rewriteCssIdSelectors(css, ids);
      el.textContent = css;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const low = name.toLowerCase();
      let val = attr.value;
      if (low.startsWith('on') || low === 'src') {
        el.removeAttribute(name);
        continue;
      }
      if ((low === 'href' || low === 'xlink:href') && !val.trim().startsWith('#')) {
        el.removeAttribute(name);
        continue;
      }
      if (low === 'style') {
        val = scrubCss(val);
        if (val.trim()) el.setAttribute(name, val);
        else el.removeAttribute(name);
        continue;
      }
      if (!safeUrlValue(val)) {
        el.removeAttribute(name);
        continue;
      }
      for (const [oldId, newId] of ids) {
        const esc = reEscape(oldId);
        val = val
          .replace(new RegExp(`url\\(\\s*(['"]?)#${esc}\\1\\s*\\)`, 'g'), `url(#${newId})`)
          .replace(new RegExp(`^#${esc}$`), `#${newId}`);
      }
      if (val !== attr.value) el.setAttribute(name, val);
    }
  }
}

/** @param {string} name */
export function svgLayerName(name) {
  const base = (name || 'SVG').replace(/\.[^.]+$/, '').trim();
  return base || 'SVG';
}

/**
 * @param {string} text
 * @param {{x: number, y: number, w: number, h: number}} board
 * @param {{x: number, y: number, w: number, h: number}|null} [placeBox]
 * @returns {SvgItem}
 */
export function svgItemFromText(text, board, placeBox = null) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  const root = /** @type {SVGSVGElement|null} */ (doc.documentElement);
  if (err || !root || root.localName.toLowerCase() !== 'svg') {
    throw new Error('The selected SVG is invalid.');
  }

  const vb = readViewBox(root);
  const prefix = `fp-svg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  sanitize(root, prefix);
  const rootAttrs = svgRootAttrs(root);

  let x, y, w, h;
  if (placeBox && placeBox.w > 0 && placeBox.h > 0) {
    x = placeBox.x;
    y = placeBox.y;
    w = placeBox.w;
    h = placeBox.h;
  } else {
    const maxW = board.w * 0.7;
    const maxH = board.h * 0.7;
    const maxDim = Math.max(vb.w, vb.h);
    let scale = Math.min(1, maxW / vb.w, maxH / vb.h);
    if (maxDim < 512) scale = Math.min(maxW / vb.w, maxH / vb.h, 512 / maxDim);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    w = Math.max(1, vb.w * scale);
    h = Math.max(1, vb.h * scale);
    x = board.x + (board.w - w) / 2;
    y = board.y + (board.h - h) / 2;
  }

  /** @type {SvgItem} */
  const item = {
    content: root.innerHTML,
    viewX: vb.x, viewY: vb.y, viewW: vb.w, viewH: vb.h,
    x, y,
    w, h,
    m: [1, 0, 0, 1, 0, 0],
    rootAttrs,
  };
  ensureSvgPaintGroups(item);
  return item;
}

/**
 * @param {File} file
 * @param {{x: number, y: number, w: number, h: number}} board
 * @returns {Promise<SvgItem>}
 */
export async function svgItemFromFile(file, board) {
  if (!file) throw new Error('Missing SVG file.');
  return svgItemFromText(await file.text(), board);
}

/** @param {import('./layers.js').Layer} layer */
export function touchSvg(layer) {
  layer.svgDirty = true;
  layer.ver = (layer.ver || 0) + 1;
  layer.thumbDirty = true;
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('fablepaint:dirty'));
}

/** @param {import('./layers.js').Layer} layer */
function touchSvgInPlace(layer) {
  layer.ver = (layer.ver || 0) + 1;
  layer.thumbDirty = true;
  if (typeof document !== 'undefined') document.dispatchEvent(new Event('fablepaint:dirty'));
}

/** @param {SvgItem} item */
function svgPlaneContentKey(item) {
  return `${item.content.length}|${svgRootAttrsKey(item)}|${item.viewX}|${item.viewY}|${item.viewW}|${item.viewH}|${item.x}|${item.y}|${item.w}|${item.h}`;
}

/** @param {[number, number, number, number, number, number]} m */
export function matrixAttr(m) {
  return `matrix(${m.map((v) => Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0).join(' ')})`;
}

/** @param {SvgItem} item */
export function svgItemBounds(item) {
  if (!item || !(item.w > 0) || !(item.h > 0)) return null;
  const m = item.m || [1, 0, 0, 1, 0, 0];
  const x0 = item.x, y0 = item.y, x1 = item.x + item.w, y1 = item.y + item.h;
  const pts = [
    [x0, y0], [x1, y0], [x1, y1], [x0, y1],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    const tx = m[0] * x + m[2] * y + m[4];
    const ty = m[1] * x + m[3] * y + m[5];
    if (tx < minX) minX = tx;
    if (ty < minY) minY = ty;
    if (tx > maxX) maxX = tx;
    if (ty > maxY) maxY = ty;
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return null;
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * @param {[number, number, number, number, number, number]} a
 * @param {[number, number, number, number, number, number]} b
 * @returns {[number, number, number, number, number, number]}
 */
export function multiplyMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** @param {SvgItem} item */
export function svgWorldBox(item) {
  const m = item.m || [1, 0, 0, 1, 0, 0];
  const pts = [
    [item.x, item.y],
    [item.x + item.w, item.y],
    [item.x + item.w, item.y + item.h],
    [item.x, item.y + item.h],
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    const x = m[0] * p[0] + m[2] * p[1] + m[4];
    const y = m[1] * p[0] + m[3] * p[1] + m[5];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || x1 <= x0 || y1 <= y0) {
    return null;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** @param {import('./layers.js').Layer} layer */
export function createSvgPlane(layer) {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('class', 'svgplane');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('preserveAspectRatio', 'none');
  root.style.transformOrigin = '0 0';

  const defs = document.createElementNS(SVG_NS, 'defs');
  const cp = document.createElementNS(SVG_NS, 'clipPath');
  cp.setAttribute('id', 'svgclip' + layer.id);
  cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
  const cr = document.createElementNS(SVG_NS, 'rect');
  cp.appendChild(cr);
  defs.appendChild(cp);

  const source = document.createElementNS(SVG_NS, 'g');
  source.setAttribute('id', 'svgsrc' + layer.id);
  defs.appendChild(source);

  const clip = document.createElementNS(SVG_NS, 'g');
  clip.setAttribute('clip-path', `url(#svgclip${layer.id})`);
  root.append(defs, clip);

  layer.svgPlane = root;
  layer.svgSourceEl = source;
  layer.svgUseEls = [];
  layer.svgClipRectEl = cr;
  layer.svgDirty = true;
  layer.svgClipKey = '';
  layer.svgPatternKey = '';
  return root;
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {{x: number, y: number, w: number, h: number}|null} [patternTile]
 */
export function syncSvgLayer(layer, patternTile = null) {
  if (!layer.svgItem) return;
  if (!layer.svgPlane || !layer.svgSourceEl) {
    if (layer.svgPlane) layer.svgPlane.remove();
    createSvgPlane(layer);
  }
  const item = layer.svgItem;
  const root = layer.svgPlane;
  const source = layer.svgSourceEl;
  root.style.display = layer.visible && layer.opacity > 0 ? 'block' : 'none';
  root.style.opacity = String(layer.opacity);
  const key = svgPlaneContentKey(item);
  if (layer.svgDirty || layer.svgKey !== key) {
    source.textContent = '';
    const inner = document.createElementNS(SVG_NS, 'svg');
    applySvgRootAttrs(inner, item);
    inner.setAttribute('x', String(item.x));
    inner.setAttribute('y', String(item.y));
    inner.setAttribute('width', String(item.w));
    inner.setAttribute('height', String(item.h));
    inner.setAttribute('viewBox', `${item.viewX} ${item.viewY} ${item.viewW} ${item.viewH}`);
    inner.setAttribute('preserveAspectRatio', 'none');
    inner.setAttribute('overflow', 'hidden');
    inner.innerHTML = item.content;
    source.appendChild(inner);
    layer.svgDirty = false;
    layer.svgKey = key;
    layer.svgPatternKey = '';
  }
  syncSvgPatternUses(layer, patternTile);
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {{x: number, y: number, w: number, h: number}|null} patternTile
 */
function syncSvgPatternUses(layer, patternTile) {
  const item = layer.svgItem;
  const root = layer.svgPlane;
  const m = item.m || [1, 0, 0, 1, 0, 0];
  const repeat = patternTile && patternTile.w > 0 && patternTile.h > 0;
  /** @type {[number, number][]} */
  const offsets = repeat
    ? [[-patternTile.w, -patternTile.h], [0, -patternTile.h], [patternTile.w, -patternTile.h],
      [-patternTile.w, 0], [0, 0], [patternTile.w, 0],
      [-patternTile.w, patternTile.h], [0, patternTile.h], [patternTile.w, patternTile.h]]
    : [[0, 0]];
  const key = `${m.join(',')}|${repeat ? `${patternTile.w}|${patternTile.h}` : '0'}|${offsets.length}`;
  if (layer.svgPatternKey === key && layer.svgUseEls && layer.svgUseEls.length === offsets.length) return;
  layer.svgPatternKey = key;
  const clip = root.lastElementChild;
  if (!clip) return;
  clip.textContent = '';
  layer.svgUseEls = [];
  for (const [ox, oy] of offsets) {
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#svgsrc' + layer.id);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#svgsrc' + layer.id);
    use.setAttribute('transform', matrixAttr([m[0], m[1], m[2], m[3], m[4] + ox, m[5] + oy]));
    clip.appendChild(use);
    layer.svgUseEls.push(use);
  }
}

/** @param {import('./layers.js').Layer} layer */
export function syncSvgClip(layer) {
  const b = layer.clipBoard;
  const r = layer.svgClipRectEl;
  if (!b || !r) return;
  const key = `${b.x}|${b.y}|${b.w}|${b.h}`;
  if (layer.svgClipKey === key) return;
  layer.svgClipKey = key;
  r.setAttribute('x', String(b.x));
  r.setAttribute('y', String(b.y));
  r.setAttribute('width', String(b.w));
  r.setAttribute('height', String(b.h));
}

/** @param {import('./layers.js').Layer} layer */
export function freeSvgPlane(layer) {
  if (layer.svgPlane) layer.svgPlane.remove();
  layer.svgPlane = null;
  layer.svgSourceEl = null;
  layer.svgUseEls = null;
  layer.svgClipRectEl = null;
  layer.svgKey = '';
  layer.svgClipKey = '';
  layer.svgPatternKey = '';
}

/**
 * @param {import('./layers.js').Layer} layer
 * @param {{x: number, y: number, w: number, h: number}} board
 * @param {number} [opacity]
 */
export function svgLayerMarkup(layer, board, opacity = layer.opacity) {
  const item = layer.svgItem;
  const clipId = `clip-${layer.id}`;
  const sourceId = `src-${layer.id}`;
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    `width="${board.w}" height="${board.h}" viewBox="${board.x} ${board.y} ${board.w} ${board.h}">` +
    `<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">` +
    `<rect x="${board.x}" y="${board.y}" width="${board.w}" height="${board.h}"/>` +
    `</clipPath><g id="${sourceId}">` +
    `<svg x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" ` +
    `viewBox="${item.viewX} ${item.viewY} ${item.viewW} ${item.viewH}" preserveAspectRatio="none" overflow="hidden"` +
    `${svgRootAttrsMarkup(item)}>` +
    item.content +
    `</svg></g></defs>` +
    `<g clip-path="url(#${clipId})" opacity="${opacity}">` +
    `<use href="#${sourceId}" xlink:href="#${sourceId}" ` +
    `transform="${matrixAttr(item.m || [1, 0, 0, 1, 0, 0])}"/>` +
    '</g></svg>';
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./layers.js').Layer} layer
 * @param {{x: number, y: number, w: number, h: number}} board
 * @param {number} [opacity]
 * @param {boolean} [respectVisibility]
 */
export async function drawSvgLayerToCanvas(ctx, layer, board, opacity = layer.opacity, respectVisibility = true) {
  if ((respectVisibility && !layer.visible) || opacity <= 0 || !layer.svgItem) return;
  const blob = new Blob([svgLayerMarkup(layer, board, opacity)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('SVG export failed.'));
      im.src = url;
    });
    ctx.drawImage(/** @type {HTMLImageElement} */ (img), 0, 0, board.w, board.h);
  } finally {
    URL.revokeObjectURL(url);
  }
}
