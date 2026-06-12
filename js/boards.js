// CANVAS (artboard) — il disegno non è più libero: vive solo dentro
// rettangoli "canvas" affiancati sul piano di lavoro. Ogni canvas ha i SUOI
// livelli (un LayerManager privato); il pannello livelli mostra sempre quelli
// del canvas attivo. I rettangoli sono allineati alla griglia dei chunk
// (multipli di 256): un canvas 2048x2048 copre esattamente 8x8 chunk e il
// clip del tratto cade sui bordi dei tile.

import { LayerManager } from './layers.js';

export const BOARD_SIZE = 2048;   // lato del canvas di default
export const MAX_BOARDS = 16;
const GAP = 256;                  // spazio tra canvas (multiplo di chunk)

let nextBoardId = 1;

/**
 * Un canvas del documento: rettangolo mondo + pila di livelli propria.
 * @typedef {Board} BoardT
 */
export class Board {
  /** @param {string} name @param {number} x @param {number} y @param {number} w @param {number} h @param {number} [id] */
  constructor(name, x, y, w, h, id) {
    this.id = id || nextBoardId++;
    if (this.id >= nextBoardId) nextBoardId = this.id + 1;
    this.name = name;
    this.x = x; this.y = y;
    this.w = w; this.h = h;
    this.mgr = new LayerManager();
  }
}

export class BoardManager {
  constructor() {
    /** @type {Board[]} */
    this.boards = [];
    this.activeId = 0;
    // struttura/selezione cambiata: il piano DOM dei canvas si risincronizza
    this.epoch = 1;
  }

  bump() { this.epoch++; }

  /** @param {number} id */
  byId(id) { return this.boards.find((b) => b.id === id); }

  get active() { return this.byId(this.activeId); }

  get canAdd() { return this.boards.length < MAX_BOARDS; }

  // Crea un canvas a destra dell'ultimo (stessa riga), lo rende attivo.
  /** @param {string} [name] @param {number} [w] @param {number} [h] */
  add(name, w = BOARD_SIZE, h = BOARD_SIZE) {
    let x = 0;
    for (const b of this.boards) x = Math.max(x, b.x + b.w + GAP);
    const board = new Board(name || `Canvas ${this.boards.length + 1}`, x, 0, w, h);
    this.boards.push(board);
    this.activeId = board.id;
    this.bump();
    return board;
  }

  /** @param {{id:number,name:string,x:number,y:number,w:number,h:number}} state */
  addRestored(state) {
    const board = new Board(state.name || `Canvas ${this.boards.length + 1}`,
      state.x || 0, state.y || 0, state.w || BOARD_SIZE, state.h || BOARD_SIZE, state.id);
    this.boards.push(board);
    this.activeId = board.id;
    this.bump();
    return board;
  }

  // Canvas sotto il punto mondo (null = piano di lavoro vuoto).
  /** @param {number} wx @param {number} wy */
  hitTest(wx, wy) {
    for (const b of this.boards) {
      if (wx >= b.x && wy >= b.y && wx < b.x + b.w && wy < b.y + b.h) return b;
    }
    return null;
  }

  // Gli id dei livelli sono globali: si cerca su tutti i canvas (undo,
  // commit di un tratto finito dopo un cambio di canvas, miniature).
  /** @param {number} layerId */
  layerById(layerId) {
    for (const b of this.boards) {
      const l = b.mgr.byId(layerId);
      if (l) return l;
    }
    return undefined;
  }

  /** @param {number} layerId */
  boardOfLayer(layerId) {
    for (const b of this.boards) if (b.mgr.byId(layerId)) return b;
    return undefined;
  }

  // Contatore composito monotono: cambia se cambia la struttura dei canvas
  // O di una qualunque pila di livelli (i piani DOM ricostruiscono i gruppi).
  get combinedEpoch() {
    let e = this.epoch;
    for (const b of this.boards) e += b.mgr.epoch;
    return e;
  }

  /** Tutti gli store raster di tutti i canvas, in ordine di pila. */
  allRasterStores() {
    /** @type {import('./store.js').ChunkStore[]} */
    const out = [];
    for (const b of this.boards) {
      for (const l of b.mgr.layers) if (l.kind === 'raster') out.push(l.store);
    }
    return out;
  }
}
