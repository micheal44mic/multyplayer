// LIVELLI — il documento è una lista ordinata (indice 0 = in fondo).
// Tre nature: raster (un ChunkStore privato; pennello e gomma scrivono solo
// sul livello attivo), testo e SVG importati (descrizioni vettoriali,
// presentate come piani SVG dal gestore dei piani). Il modello non sa nulla
// del rendering.

import { ChunkStore } from './store.js';

/** @typedef {import('./text_layer.js').TextItem} TextItem */
/** @typedef {import('./text_layer.js').TextStyle} TextStyle */
/** @typedef {import('./svg_layer.js').SvgItem} SvgItem */

export const MAX_LAYERS = 16;

// Metodi di fusione (sottoinsieme Photoshop/W3C, semantica del modulo
// CSS Compositing). L'ordine è stabile: l'indice entra nella contentKey
// dei proxy — non riordinare, solo accodare.
// 'add' = Scherma lineare di Photoshop (somma con clamp).
export const BLEND_MODES = /** @type {const} */ ([
  'normal', 'multiply', 'screen', 'add', 'overlay', 'softlight',
  'darken', 'lighten', 'difference',
]);

/** @typedef {typeof BLEND_MODES[number]} BlendMode */

/** Indice stabile del metodo (per hash/chiavi). @param {Layer} l */
export function blendIndex(l) {
  const i = l.mode ? BLEND_MODES.indexOf(l.mode) : 0;
  return i < 0 ? 0 : i;
}

/**
 * Livello del documento. kind decide quali campi opzionali sono presenti:
 * raster -> store; text -> item + style; svg -> svgItem.
 * @typedef {Object} Layer
 * @property {number} id
 * @property {'raster'|'text'|'svg'} kind
 * @property {string} name
 * @property {boolean} visible
 * @property {number} opacity 0..1
 * @property {BlendMode} [mode] metodo di fusione (assente = 'normal'; solo raster, i figli clippati lo ignorano — la base lo applica al gruppo)
 * @property {boolean} [reference] fa da bordo per il flood fill anche dagli altri livelli (uno solo per board, alla Procreate)
 * @property {boolean} [clip] maschera di ritaglio alla Procreate: visibile solo dove il livello base sotto ha alpha (solo raster)
 * @property {Layer|null} [clipBase] base EFFETTIVA del ritaglio, risolta a ogni frame da refreshClipBases (transiente, mai persistita)
 * @property {ChunkStore} [store]
 * @property {TextItem} [item]
 * @property {TextStyle} [style]
 * @property {SvgItem} [svgItem]
 * @property {boolean} [styleDirty] testo: attributi SVG da risincronizzare
 * @property {boolean} [svgDirty] SVG importato: attributi/markup da risincronizzare
 * @property {number} [ver] testo/SVG: versione del contenuto (contentKey del proxy zoom-out)
 * @property {SVGSVGElement} [svg] testo: piano SVG (creato/posseduto da planes)
 * @property {SVGGElement} [srcEl] sorgente in <defs> (gruppo: font ereditati)
 * @property {SVGTextElement} [textEl] testo unico dentro srcEl
 * @property {SVGGElement} [hardShadowEl] ombra/estrusione vettoriale del piano SVG live
 * @property {HTMLCanvasElement} [blockCanvas] bitmap dell'effetto (estrusione 3D/ombra), fratello sotto l'svg
 * @property {SVGUseElement} [mainEl] testo visibile (fill/bordo)
 * @property {string} [blockKey] contenuto renderizzato nella bitmap ('' = nessuna)
 * @property {number} [blockScale] px bitmap per px mondo dell'ultimo render
 * @property {''|'preview'|'full'} [blockQuality] qualità dell'ultimo render
 * @property {number} [blockOffX] ancora della bitmap relativa a item.x/y (px mondo)
 * @property {number} [blockOffY]
 * @property {number} [blockBoxW] ingombro mondo dell'ultimo render
 * @property {number} [blockBoxH]
 * @property {number} [blockStable] frame consecutivi a camera ferma
 * @property {number} [blockT] timestamp ultima generazione (cadenza anteprime)
 * @property {import('./text_gl.js').SdfEntry|null} [blockSdf] cache SDF del path GPU
 * @property {boolean} [svgHardShadowOn] ombra/3D live mostrati in SVG, non bitmap
 * @property {string} [svgHardShadowKey] cache del gruppo ombra/3D SVG
 * @property {boolean} [thumbDirty] miniatura del pannello da rigenerare
 * @property {{x:number,y:number,w:number,h:number}|null} [clipBoard] testo: rettangolo mondo del board che lo maschera (riferimento vivo, assegnato dai piani)
 * @property {SVGRectElement} [clipRectEl] rect del clipPath SVG (coordinate mondo)
 * @property {string} [clipKey] cache del rect maschera SVG
 * @property {string} [blockClipKey] cache del clip-path CSS del canvas effetto
 * @property {SVGSVGElement} [svgPlane] SVG importato: piano vettoriale
 * @property {SVGElement} [svgSourceEl]
 * @property {SVGUseElement[]} [svgUseEls]
 * @property {SVGRectElement} [svgClipRectEl]
 * @property {string} [svgKey]
 * @property {string} [svgClipKey]
 * @property {string} [svgPatternKey]
 */

// Risolve la base EFFETTIVA delle maschere di ritaglio di UNA pila (mai
// attraverso i board: i gruppi dei piani attraversano i confini, qui no).
// Base = il primo livello NON clippato sotto la catena; valida solo se
// raster. layer.clipBase è transiente: ricalcolato a ogni frame prima del
// render (e on-demand da pannello/export), così riordini/eliminazioni/testi
// in mezzo si sistemano da soli senza stato da invalidare.
/** @param {Layer[]} layers */
export function refreshClipBases(layers) {
  /** @type {Layer|null} */
  let candidate = null; // ultimo livello non clippato incontrato salendo
  for (const l of layers) {
    if (l.clip && l.kind === 'raster') {
      l.clipBase = candidate && candidate.kind === 'raster' ? candidate : null;
    } else {
      l.clipBase = null;
      candidate = l;
    }
  }
}

let nextLayerId = 1;

// Collaborazione: ogni peer riceve una base id propria (slot * 1M) così i
// livelli creati in parallelo su client diversi non collidono mai. Le
// creazioni con id FORZATO (op remote) non toccano il contatore locale.
/** @param {number} n */
export function bumpLayerIds(n) {
  if (n > nextLayerId) nextLayerId = n;
}

/** @param {string} name @param {import('./wasm_core.js').WasmHeap|null} heap @returns {Layer} */
export function makeRasterLayer(name, heap) {
  const id = nextLayerId++;
  return {
    id, kind: 'raster', name: name || `Layer ${id}`,
    visible: true, opacity: 1,
    store: new ChunkStore('layer' + id, heap),
    thumbDirty: true,
  };
}

/** @param {string} name @param {TextItem} item @param {TextStyle} style @returns {Layer} */
export function makeTextLayer(name, item, style) {
  const id = nextLayerId++;
  return {
    id, kind: 'text', name,
    visible: true, opacity: 1,
    item, style, styleDirty: true, ver: 0, thumbDirty: true,
  };
}

/** @param {string} name @param {SvgItem} svgItem @returns {Layer} */
export function makeSvgLayer(name, svgItem) {
  const id = nextLayerId++;
  return {
    id, kind: 'svg', name: name || `SVG ${id}`,
    visible: true, opacity: 1,
    svgItem, svgDirty: true, ver: 0, thumbDirty: true,
  };
}

/**
 * @param {Layer} src
 * @param {string} name
 * @param {import('./wasm_core.js').WasmHeap|null} heap
 * @returns {Layer}
 */
export function duplicateLayer(src, name, heap) {
  /** @type {Layer} */
  let copy;
  if (src.kind === 'raster') {
    copy = makeRasterLayer(name, heap);
    for (const c of src.store.map.values()) {
      const dst = copy.store.getOrCreate(c.cx, c.cy);
      dst.data.set(c.data);
      dst.touched = c.touched;
      copy.store.markDirty(dst);
    }
    copy.clip = src.clip;
    copy.mode = src.mode;
  } else if (src.kind === 'text') {
    // Lo stile è mutabile e può contenere oggetti: la copia deve essere profonda.
    copy = makeTextLayer(name, { ...src.item }, structuredClone(src.style));
  } else {
    copy = makeSvgLayer(name, structuredClone(src.svgItem));
  }
  copy.visible = src.visible;
  copy.opacity = src.opacity;
  return copy;
}

export class LayerManager {
  constructor() {
    /** @type {Layer[]} */
    this.layers = [];
    this.activeId = 0;
    /** @type {Set<number>} */
    this.selectedIds = new Set();
    this.selectionAnchorId = 0;
    this.selectionEpoch = 1;
    // contatore di struttura: piani DOM e pannello si risincronizzano
    // quando vedono un valore diverso da quello che ricordano
    this.epoch = 1;
  }

  bump() { this.epoch++; }

  bumpSelection() { this.selectionEpoch++; }

  /** @param {number} id */
  byId(id) { return this.layers.find((l) => l.id === id); }

  /** @param {number} id */
  indexOf(id) { return this.layers.findIndex((l) => l.id === id); }

  get active() { return this.byId(this.activeId); }

  get selectedLayers() {
    const out = this.layers.filter((l) => this.selectedIds.has(l.id));
    if (out.length > 0) return out;
    const active = this.active;
    return active ? [active] : [];
  }

  get selectedCount() { return this.selectedLayers.length; }

  /** @param {number} id */
  isSelected(id) {
    return this.selectedIds.has(id) || (this.selectedIds.size === 0 && id === this.activeId);
  }

  /** @param {number[]} ids @param {number} [activeId] @param {number} [anchorId] */
  setSelection(ids, activeId = 0, anchorId = 0) {
    const next = [];
    for (const id of ids) {
      if (!this.byId(id) || next.includes(id)) continue;
      next.push(id);
    }
    let active = activeId && this.byId(activeId) ? activeId : 0;
    if (!active && next.length > 0) active = next[next.length - 1];
    if (active && !next.includes(active)) next.push(active);
    const prev = [...this.selectedIds].join(',');
    const sig = next.join(',');
    const activeChanged = this.activeId !== active;
    const anchor = anchorId && this.byId(anchorId) ? anchorId : active;
    if (prev === sig && !activeChanged && this.selectionAnchorId === anchor) return;
    this.selectedIds = new Set(next);
    this.activeId = active;
    this.selectionAnchorId = anchor;
    this.bumpSelection();
  }

  /** @param {number} id */
  selectOnly(id) {
    if (!this.byId(id)) return;
    this.setSelection([id], id, id);
  }

  /** @param {number} id */
  toggleSelected(id) {
    if (!this.byId(id)) return;
    const ids = this.selectedLayers.map((l) => l.id);
    const at = ids.indexOf(id);
    if (at >= 0) {
      if (ids.length <= 1) return this.selectOnly(id);
      ids.splice(at, 1);
      const active = ids.includes(this.activeId)
        ? this.activeId
        : ids[Math.min(at, ids.length - 1)];
      this.setSelection(ids, active, active);
      return;
    }
    ids.push(id);
    this.setSelection(ids, id, id);
  }

  /** @param {number} id */
  selectRange(id) {
    if (!this.byId(id)) return;
    const anchor = this.byId(this.selectionAnchorId) ? this.selectionAnchorId : this.activeId || id;
    const a = this.indexOf(anchor), b = this.indexOf(id);
    if (a < 0 || b < 0) return this.selectOnly(id);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    this.setSelection(this.layers.slice(lo, hi + 1).map((l) => l.id), id, anchor);
  }

  // Livello raster su cui pennello/gomma possono scrivere ora (null = nessuno).
  get paintTarget() {
    const l = this.active;
    return l && l.kind === 'raster' && l.visible ? l : null;
  }

  // Livello marcato come riferimento del flood fill (null = nessuno):
  // il fill misura i bordi su di lui anche riempiendo un altro livello.
  get referenceLayer() {
    return this.layers.find((l) => l.reference) || null;
  }

  // Marca/smarca il riferimento: al massimo uno per board.
  /** @param {number} id */
  toggleReference(id) {
    const l = this.byId(id);
    if (!l) return;
    const v = !l.reference;
    for (const x of this.layers) x.reference = false;
    l.reference = v;
  }

  get canAdd() { return this.layers.length < MAX_LAYERS; }

  // Inserisce a un indice esplicito (undo) o sopra il livello attivo.
  /** @param {Layer} layer @param {number} [index] */
  insert(layer, index) {
    if (!layer || !layer.id) throw new Error('Invalid layer');
    const at = index !== undefined
      ? Math.max(0, Math.min(index, this.layers.length))
      : (this.activeId ? this.indexOf(this.activeId) + 1 : this.layers.length);
    this.layers.splice(at, 0, layer);
    this.activeId = layer.id;
    this.selectedIds = new Set([layer.id]);
    this.selectionAnchorId = layer.id;
    this.bumpSelection();
    this.bump();
    return at;
  }

  // Stacca il livello dalla lista (NON lo distrugge: l'undo lo tiene in vita).
  /** @param {number} id @returns {{layer: Layer, index: number}|null} */
  detach(id) {
    const index = this.indexOf(id);
    if (index < 0) return null;
    const [layer] = this.layers.splice(index, 1);
    this.selectedIds.delete(id);
    if (this.activeId === id) {
      const next = this.layers[Math.min(index, this.layers.length - 1)];
      this.activeId = next ? next.id : 0;
    }
    if (this.activeId && this.selectedIds.size === 0) this.selectedIds.add(this.activeId);
    if (!this.byId(this.selectionAnchorId)) this.selectionAnchorId = this.activeId;
    this.bumpSelection();
    this.bump();
    return { layer, index };
  }

  /** @param {number} from @param {number} to */
  move(from, to) {
    if (from === to || from < 0 || from >= this.layers.length) return;
    const [layer] = this.layers.splice(from, 1);
    this.layers.splice(Math.max(0, Math.min(to, this.layers.length)), 0, layer);
    this.bump();
  }

  /** Solo gli store raster, dal basso verso l'alto. */
  rasterStores() {
    /** @type {ChunkStore[]} */
    const out = [];
    for (const l of this.layers) if (l.kind === 'raster') out.push(l.store);
    return out;
  }

  /** @param {number} id */
  noteContent(id) {
    const l = this.byId(id);
    if (l) l.thumbDirty = true;
  }
}
