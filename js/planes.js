// PIANI — la lista livelli diventa una pila di piani DOM.
// I run consecutivi di livelli raster si raggruppano: il gruppo PIÙ IN BASSO
// usa il renderer principale (WebGL, o il fallback 2D), i gruppi sopra un
// testo usano renderer Canvas2D dedicati; ogni livello testo è un piano SVG
// (vettore puro, dipinto dal browser). L'ordine dei figli del container è
// l'ordine della pila. Caso comune (niente sandwich): un canvas + eventuali
// SVG in cima — zero overhead rispetto a prima.

import { syncTextSvg, createTextSvg } from './text_layer.js';
import { Canvas2DRenderer } from './renderer_2d.js';

/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./layers.js').LayerManager} LayerManager */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./renderer_gl.js').GLRenderer} GLRenderer */

/** @typedef {{type: 'raster', layers: Layer[]}|{type: 'text', layer: Layer}} Group */

export class Planes {
  /** @param {HTMLElement} container @param {HTMLElement} gridEl */
  constructor(container, gridEl) {
    this.container = container;
    this.gridEl = gridEl;
    /** @type {Group[]} */
    this.groups = [];
    /** @type {Canvas2DRenderer[]} pool dei renderer dei gruppi superiori */
    this._pool = [];
    /** @type {Map<number, number>} layerId -> indice piano (-1 = bottom) per la migrazione */
    this._where = new Map();
    this._epoch = 0;
    this._forceDraw = false;
    // cache camera per griglia/viewBox (niente stringhe se non cambia nulla)
    this._cx = NaN; this._cy = NaN; this._cz = NaN; this._cw = NaN; this._ch = NaN;
    this._camChanged = true;
    this._vb = '';
    this._w = 1; this._h = 1; this._dpr = 1;
  }

  /** @param {number} w @param {number} h @param {number} dpr */
  resize(w, h, dpr) {
    this._w = w; this._h = h; this._dpr = dpr;
    for (const r of this._pool) r.resize(w, h, dpr);
    this._camChanged = true;
  }

  // Ricostruisce gruppi e ordine DOM. bottomCanvas = canvas del renderer
  // principale (può essere appena stato sostituito: toggle desync).
  /**
   * @param {LayerManager} mgr
   * @param {HTMLCanvasElement} bottomCanvas
   * @param {{disposeChunkTex: (c: import('./store.js').Chunk) => void}} bottomRenderer
   */
  _rebuild(mgr, bottomCanvas, bottomRenderer) {
    /** @type {Group[]} */
    const groups = [];
    /** @type {{type: 'raster', layers: Layer[]}|null} */
    let run = null;
    for (const layer of mgr.layers) {
      if (layer.kind === 'text') {
        groups.push({ type: 'text', layer });
        run = null;
      } else {
        if (!run) { run = { type: 'raster', layers: [] }; groups.push(run); }
        run.layers.push(layer);
      }
    }
    this.groups = groups;

    // assegna i piani: primo gruppo raster -> bottom (-1), i successivi -> pool
    let c2dIdx = 0;
    let bottomDone = false;
    /** @type {Map<number, number>} */
    const where = new Map();
    /** @type {Element[]} */
    const order = [this.gridEl];
    for (const g of groups) {
      if (g.type === 'text') {
        if (!g.layer.svg) createTextSvg(g.layer);
        order.push(g.layer.svg);
        where.set(g.layer.id, -2); // i testi non migrano: piano proprio
        continue;
      }
      if (!bottomDone) {
        bottomDone = true;
        order.push(bottomCanvas);
        for (const l of g.layers) where.set(l.id, -1);
      } else {
        let r = this._pool[c2dIdx];
        if (!r) {
          const cnv = document.createElement('canvas');
          cnv.className = 'plane2d';
          r = new Canvas2DRenderer(cnv);
          this._pool[c2dIdx] = r;
        }
        r.resize(this._w, this._h, this._dpr);
        order.push(r.canvas);
        for (const l of g.layers) where.set(l.id, c2dIdx);
        c2dIdx++;
      }
    }
    // canvas WebGL sempre nel DOM anche senza livelli raster (testo-only):
    // il contesto resta vivo e il piano è pronto a riempirsi
    if (!bottomDone) order.splice(1, 0, bottomCanvas);

    // migrazione: un raster che cambia piano ha texture/c2d stantii — si
    // dimenticano (la CPU è la verità, tutto rinasce on-demand alla vista)
    for (const [id, slot] of where) {
      const prev = this._where.get(id);
      if (prev !== undefined && prev !== slot && slot !== -2) {
        const layer = mgr.byId(id);
        if (layer && layer.store) {
          layer.store.forEachChunkAll((c) => {
            bottomRenderer.disposeChunkTex(c);
            c.c2d = null;
            c.texDirty = true;
          });
        }
      }
    }
    this._where = where;
    // i contatori dei renderer 2D si riallineano al mondo reale
    for (let i = 0; i < this._pool.length; i++) this._recount(this._pool[i], i);

    // ordine DOM: rimpiazza i figli (gli elementi riusati non si ricreano)
    this.container.replaceChildren(...order);

    // un canvas di gruppo può essere appena (ri)entrato in scena con sopra
    // il contenuto di un'altra epoca/camera: ridisegno forzato, sempre
    this._forceDraw = true;
  }

  /** @param {Canvas2DRenderer} r @param {number} poolIdx */
  _recount(r, poolIdx) {
    let n = 0;
    for (const g of this.groups) {
      if (g.type !== 'raster') continue;
      for (const l of g.layers) {
        if (this._where.get(l.id) !== poolIdx) break;
        l.store.forEachChunkAll((c) => { if (c.c2d) n++; });
      }
    }
    r.texCount = n;
  }

  /**
   * Aggiorna upload, disegno dei piani, viewBox dei testi e griglia.
   * bottom = renderer principale dell'App (GL o fallback 2D).
   * @param {Object} o
   * @param {Camera} o.camera
   * @param {LayerManager} o.mgr
   * @param {ChunkStore} o.strokeStore
   * @param {number} o.liveOpacity
   * @param {boolean} o.eraserLive
   * @param {GLRenderer|Canvas2DRenderer} o.bottom
   * @param {HTMLCanvasElement} o.bottomCanvas
   * @returns {{uploadMs: number, drawMs: number}}
   */
  render(o) {
    const { camera, mgr, strokeStore, bottom } = o;
    if (this._epoch !== mgr.epoch) {
      this._epoch = mgr.epoch;
      this._rebuild(mgr, o.bottomCanvas, bottom);
    }

    const camChanged = camera.x !== this._cx || camera.y !== this._cy ||
      camera.zoom !== this._cz || camera.w !== this._cw || camera.h !== this._ch;
    if (camChanged) {
      this._cx = camera.x; this._cy = camera.y; this._cz = camera.zoom;
      this._cw = camera.w; this._ch = camera.h;
      this._syncGrid(camera);
      const hw = camera.w * 0.5 / camera.zoom, hh = camera.h * 0.5 / camera.zoom;
      this._vb = `${camera.x - hw} ${camera.y - hh} ${hw * 2} ${hh * 2}`;
    }

    const activeId = mgr.activeId;
    const t0 = performance.now();

    // upload dei chunk sporchi, ciascuno sul renderer del proprio piano
    let bottomDone = false;
    let c2dIdx = 0;
    let uploaded = 0;
    for (const g of this.groups) {
      if (g.type === 'text') continue;
      const r = bottomDone ? this._pool[c2dIdx++] : bottom;
      bottomDone = true;
      for (const l of g.layers) {
        uploaded += r.uploadDirty(l.store);
        if (l.id === activeId) uploaded += r.uploadDirty(strokeStore);
      }
    }
    const t1 = performance.now();

    // disegno: bottom sempre (è anche lo sfondo del documento), i piani 2D
    // solo se è cambiato qualcosa (camera, contenuto, tratto live nel gruppo)
    bottomDone = false;
    c2dIdx = 0;
    for (const g of this.groups) {
      if (g.type === 'text') {
        if (g.layer.styleDirty) { g.layer.styleDirty = false; syncTextSvg(g.layer); }
        if (camChanged || g.layer.svg.getAttribute('viewBox') !== this._vb) {
          g.layer.svg.setAttribute('viewBox', this._vb);
        }
        continue;
      }
      const hasActive = g.layers.some((l) => l.id === activeId);
      const stroke = hasActive ? strokeStore : null;
      if (!bottomDone) {
        bottomDone = true;
        bottom.render(camera, g.layers, activeId, stroke, o.liveOpacity, o.eraserLive);
      } else {
        const r = this._pool[c2dIdx++];
        const liveHere = stroke && stroke.map.size > 0;
        if (camChanged || r.uploadsThisFrame > 0 || liveHere || this._forceDraw) {
          r.render(camera, g.layers, activeId, stroke, o.liveOpacity, o.eraserLive);
        }
      }
    }
    // niente gruppi raster: il bottom presenta comunque (pulisce il canvas)
    if (!bottomDone) bottom.render(camera, [], activeId, null, 1, false);
    this._forceDraw = false;
    const t2 = performance.now();

    return { uploadMs: t1 - t0, drawMs: t2 - t1 };
  }

  // Forza il ridisegno dei piani 2D al prossimo frame (undo, visibilità...).
  invalidate() { this._forceDraw = true; }

  /** @param {Camera} camera */
  _syncGrid(camera) {
    const z = camera.zoom;
    const cell = 64 * z;
    const sx = (-camera.x * z + camera.w * 0.5) - 32 * z;
    const sy = (-camera.y * z + camera.h * 0.5) - 32 * z;
    const st = this.gridEl.style;
    st.backgroundSize = `${cell}px ${cell}px`;
    st.backgroundPosition = `${sx}px ${sy}px`;
    st.opacity = String(Math.max(0, Math.min(1, (cell - 7) / 30)) * 0.16);
  }

  // Eviction dei piani 2D (i loro canvas-chunk sono memoria come le texture).
  /** @param {Camera} camera */
  evict(camera) {
    let bottomDone = false;
    let c2dIdx = 0;
    for (const g of this.groups) {
      if (g.type !== 'raster') continue;
      if (!bottomDone) { bottomDone = true; continue; } // il bottom lo fa l'App
      const r = this._pool[c2dIdx++];
      r.evict(g.layers.map((l) => l.store), camera, 512);
    }
  }

  get gpuBytes() {
    let b = 0;
    for (const r of this._pool) b += r.gpuBytes;
    return b;
  }
}
