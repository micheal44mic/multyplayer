// LIVELLI — il documento è una lista ordinata (indice 0 = in fondo).
// Due nature: raster (un ChunkStore privato; pennello e gomma scrivono solo
// sul livello attivo) e testo (descrizione vettoriale, presentata come SVG
// dal gestore dei piani). Il modello non sa nulla del rendering.

import { ChunkStore } from './store.js';

/** @typedef {import('./text_layer.js').TextItem} TextItem */
/** @typedef {import('./text_layer.js').TextStyle} TextStyle */

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
 * raster -> store; text -> item + style (+ svg/textEl creati dai piani).
 * @typedef {Object} Layer
 * @property {number} id
 * @property {'raster'|'text'} kind
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
 * @property {boolean} [styleDirty] testo: attributi SVG da risincronizzare
 * @property {number} [ver] testo: versione del contenuto (contentKey del proxy zoom-out)
 * @property {SVGSVGElement} [svg] testo: piano SVG (creato/posseduto da planes)
 * @property {SVGGElement} [srcEl] sorgente in <defs> (gruppo: font ereditati)
 * @property {SVGTextElement} [textEl] testo unico dentro srcEl (modalità non-distort)
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
 * @property {boolean} [thumbDirty] miniatura del pannello da rigenerare
 * @property {{x:number,y:number,w:number,h:number}|null} [clipBoard] testo: rettangolo mondo del board che lo maschera (riferimento vivo, assegnato dai piani)
 * @property {SVGRectElement} [clipRectEl] rect del clipPath SVG (coordinate mondo)
 * @property {string} [clipKey] cache del rect maschera SVG
 * @property {string} [blockClipKey] cache del clip-path CSS del canvas effetto
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

export class LayerManager {
  constructor() {
    /** @type {Layer[]} */
    this.layers = [];
    this.activeId = 0;
    // contatore di struttura: piani DOM e pannello si risincronizzano
    // quando vedono un valore diverso da quello che ricordano
    this.epoch = 1;
  }

  bump() { this.epoch++; }

  /** @param {number} id */
  byId(id) { return this.layers.find((l) => l.id === id); }

  /** @param {number} id */
  indexOf(id) { return this.layers.findIndex((l) => l.id === id); }

  get active() { return this.byId(this.activeId); }

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
    this.bump();
    return at;
  }

  // Stacca il livello dalla lista (NON lo distrugge: l'undo lo tiene in vita).
  /** @param {number} id @returns {{layer: Layer, index: number}|null} */
  detach(id) {
    const index = this.indexOf(id);
    if (index < 0) return null;
    const [layer] = this.layers.splice(index, 1);
    if (this.activeId === id) {
      const next = this.layers[Math.min(index, this.layers.length - 1)];
      this.activeId = next ? next.id : 0;
    }
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
