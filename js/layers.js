// LIVELLI — il documento è una lista ordinata (indice 0 = in fondo).
// Due nature: raster (un ChunkStore privato; pennello e gomma scrivono solo
// sul livello attivo) e testo (descrizione vettoriale, presentata come SVG
// dal gestore dei piani). Il modello non sa nulla del rendering.

import { ChunkStore } from './store.js';

/** @typedef {import('./text_layer.js').TextItem} TextItem */
/** @typedef {import('./text_layer.js').TextStyle} TextStyle */

export const MAX_LAYERS = 16;

/**
 * Livello del documento. kind decide quali campi opzionali sono presenti:
 * raster -> store; text -> item + style (+ svg/textEl creati dai piani).
 * @typedef {Object} Layer
 * @property {number} id
 * @property {'raster'|'text'} kind
 * @property {string} name
 * @property {boolean} visible
 * @property {number} opacity 0..1
 * @property {ChunkStore} [store]
 * @property {TextItem} [item]
 * @property {TextStyle} [style]
 * @property {boolean} [styleDirty] testo: attributi SVG da risincronizzare
 * @property {SVGSVGElement} [svg] testo: piano SVG (creato/posseduto da planes)
 * @property {SVGTextElement} [textEl]
 * @property {boolean} [thumbDirty] miniatura del pannello da rigenerare
 */

let nextLayerId = 1;

/** @param {string} name @param {import('./wasm_core.js').WasmHeap|null} heap @returns {Layer} */
export function makeRasterLayer(name, heap) {
  const id = nextLayerId++;
  return {
    id, kind: 'raster', name: name || `Livello ${id}`,
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
    item, style, styleDirty: true, thumbDirty: true,
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

  get canAdd() { return this.layers.length < MAX_LAYERS; }

  // Inserisce a un indice esplicito (undo) o sopra il livello attivo.
  /** @param {Layer} layer @param {number} [index] */
  insert(layer, index) {
    if (!layer || !layer.id) throw new Error('layer non valido');
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
