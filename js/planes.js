// PIANI — la lista livelli diventa una pila di piani DOM.
// I run consecutivi di livelli si raggruppano: il gruppo PIÙ IN BASSO usa il
// renderer principale (WebGL, o il fallback 2D), i gruppi sopra un piano SVG
// usano renderer Canvas2D dedicati. Un livello testo è un piano SVG (vettore
// puro, dipinto dal browser) SOLO quando è in editing (liveTextId: il testo
// attivo del board attivo); tutti gli altri testi restano DENTRO il run
// raster e il renderer li disegna come quad cotti (TextQuadCache) alla loro
// posizione nella pila — i run non si spezzano, niente piani 2D scadenti in
// minificazione sopra i testi. Caso comune (nessun testo in editing): UN
// canvas WebGL per tutto il documento.

import { syncTextSvg, createTextSvg, refreshBlockBitmap, syncBlockTransform, syncTextClip, freeBlockBitmap, COARSE_POINTER } from './text_layer.js';
import { Canvas2DRenderer } from './renderer_2d.js';

/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./boards.js').BoardManager} BoardManager */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./renderer_gl.js').GLRenderer} GLRenderer */

/** @typedef {{type: 'raster', layers: Layer[]}|{type: 'text', layer: Layer}} Group */

// Frame a camera ferma prima di scongelare i piani testo dopo uno zoom
// touch (~100ms a 60Hz: il repaint nitido arriva subito dopo il rilascio).
const FREEZE_SETTLE_FRAMES = 6;

export class Planes {
  /** @param {HTMLElement} container @param {HTMLElement} gridEl @param {HTMLElement} boardsEl */
  constructor(container, gridEl, boardsEl) {
    this.container = container;
    this.gridEl = gridEl;
    // piano dei canvas: rettangoli bianchi (sfondo + bordo) sotto i disegni
    this.boardsEl = boardsEl;
    /** @type {Map<number, {root: HTMLDivElement, label: HTMLDivElement, w: number, h: number, name: string}>} */
    this._boardEls = new Map();
    this._bEpoch = 0;
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
    // Freeze del testo durante lo zoom touch: finché lo zoom si muove i
    // piani SVG restano dipinti al viewBox di partenza e il delta lo fa un
    // transform CSS (compositor: leggera sfocatura, come le anteprime degli
    // slider); a gesto fermo tornano vettoriali e nitidi. Solo pointer
    // coarse: su desktop ridipingere i glifi a ogni frame regge ed è nitido.
    this._freezeOk = COARSE_POINTER;
    this._frozen = false;
    this._fz = { x: 0, y: 0, z: 1, w: 0, h: 0 }; // camera del viewBox congelato
    this._fzVb = '';
    this._fzT = '';
    this._fzStable = 0;
    this._hadLoading = false; // board in warm-up nel frame precedente
    // testi nascosti perché il loro board è coperto da un quad proxy
    // (visibility, non display: display appartiene a syncTextSvg)
    /** @type {Set<number>} */
    this._hiddenText = new Set();
    this._skipKey = 0; // firma dello skip dei proxy nel frame precedente
    // testo in editing (SVG vivo); il cambio bumpa l'epoch dei board (App)
    this._liveTextId = 0;
  }

  /** @param {number} w @param {number} h @param {number} dpr */
  resize(w, h, dpr) {
    this._w = w; this._h = h; this._dpr = dpr;
    for (const r of this._pool) r.resize(w, h, dpr);
    this._camChanged = true;
  }

  // Ricostruisce gruppi e ordine DOM. bottomCanvas = canvas del renderer
  // principale (può essere appena stato sostituito: toggle desync).
  // I livelli di TUTTI i canvas entrano nella stessa pila di piani: i canvas
  // non si sovrappongono nello spazio, quindi l'ordine tra canvas diversi è
  // irrilevante e i run raster possono attraversare i confini (meno piani).
  /**
   * @param {BoardManager} boards
   * @param {HTMLCanvasElement} bottomCanvas
   * @param {{disposeChunkTex: (c: import('./store.js').Chunk) => void}} bottomRenderer
   */
  _rebuild(boards, bottomCanvas, bottomRenderer) {
    /** @type {Group[]} */
    const groups = [];
    /** @type {{type: 'raster', layers: Layer[]}|null} */
    let run = null;
    for (const board of boards.boards) {
      for (const layer of board.mgr.layers) {
        if (layer.kind === 'text' && layer.id === this._liveTextId) {
          // in editing: piano SVG vettoriale, il run si spezza qui
          layer.clipBoard = board; // maschera al rettangolo del suo canvas
          groups.push({ type: 'text', layer });
          run = null;
        } else {
          // raster, o testo cotto: resta nel run — lo disegna il renderer
          // del gruppo come quad (scissor/clip al board via clipBoard)
          if (layer.kind === 'text') {
            layer.clipBoard = board;
            // la bitmap dell'effetto live (canvas + SDF GPU) serve solo al
            // piano SVG: cotto, si libera (no-op se già vuota)
            freeBlockBitmap(layer);
          }
          if (!run) { run = { type: 'raster', layers: [] }; groups.push(run); }
          run.layers.push(layer);
        }
      }
    }
    this.groups = groups;

    // assegna i piani: primo gruppo raster -> bottom (-1), i successivi -> pool
    let c2dIdx = 0;
    let bottomDone = false;
    /** @type {Map<number, number>} */
    const where = new Map();
    /** @type {Element[]} */
    const order = [this.gridEl, this.boardsEl];
    for (const g of groups) {
      if (g.type === 'text') {
        if (!g.layer.svg) createTextSvg(g.layer);
        // rientro in editing: la visibility può essere rimasta 'hidden' da
        // una copertura proxy di quando il livello era cotto (il registro
        // _hiddenText lo dimentica appena il testo esce dal piano SVG)
        if (!this._hiddenText.has(g.layer.id)) {
          g.layer.svg.style.visibility = '';
          g.layer.blockCanvas.style.visibility = '';
        }
        // canvas dell'effetto subito sotto il suo testo vettoriale
        order.push(g.layer.blockCanvas, g.layer.svg);
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
    if (!bottomDone) order.splice(2, 0, bottomCanvas);

    // migrazione: un raster che cambia piano ha texture/c2d stantii — si
    // dimenticano (la CPU è la verità, tutto rinasce on-demand alla vista)
    for (const [id, slot] of where) {
      const prev = this._where.get(id);
      if (prev !== undefined && prev !== slot && slot !== -2) {
        const layer = boards.layerById(id);
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
    // testi spariti dalla pila: via dal registro dei nascosti
    for (const id of this._hiddenText) {
      if (where.get(id) !== -2) this._hiddenText.delete(id);
    }
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
        if (!l.store) continue; // testo cotto nel run: niente chunk
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
   * @param {BoardManager} o.boards
   * @param {number} o.activeId livello attivo del canvas attivo
   * @param {ChunkStore} o.strokeStore
   * @param {number} o.liveOpacity
   * @param {boolean} o.eraserLive
   * @param {GLRenderer|Canvas2DRenderer} o.bottom
   * @param {HTMLCanvasElement} o.bottomCanvas
   * @param {import('./board_proxy.js').ProxyFrame|null} [o.proxies] board coperti dal quad piatto (zoom-out)
   * @param {import('./renderer_gl.js').TransformFrame|null} [o.transform] sessione Sposta/Trasforma
   * @param {import('./renderer_gl.js').FxFrame|null} [o.fx] sessione del pannello Effetti (blur)
   * @param {import('./text_quad.js').TextQuadCache|null} [o.textQuads] bake dei testi non in editing
   * @param {number} [o.liveTextId] testo in editing (piano SVG vivo)
   */
  render(o) {
    const { camera, boards, strokeStore, bottom } = o;
    // PRIMA del check epoch: il cambio di liveTextId arriva insieme a un
    // bump dei board (App), la rebuild deve leggere il valore nuovo
    this._liveTextId = o.liveTextId || 0;
    const epoch = boards.combinedEpoch;
    if (this._epoch !== epoch) {
      this._epoch = epoch;
      this._rebuild(boards, o.bottomCanvas, bottom);
    }

    const camChanged = camera.x !== this._cx || camera.y !== this._cy ||
      camera.zoom !== this._cz || camera.w !== this._cw || camera.h !== this._ch;
    // PRIMA dell'aggiornamento della cache: la base del freeze è la camera
    // dell'ultimo frame dipinto
    if (this._freezeOk) this._updateFreeze(camera, camChanged);
    if (camChanged) {
      this._cx = camera.x; this._cy = camera.y; this._cz = camera.zoom;
      this._cw = camera.w; this._ch = camera.h;
      this._syncGrid(camera);
      const hw = camera.w * 0.5 / camera.zoom, hh = camera.h * 0.5 / camera.zoom;
      this._vb = `${camera.x - hw} ${camera.y - hh} ${hw * 2} ${hh * 2}`;
    }
    // rettangoli dei canvas: seguono camera e struttura/selezione; mentre
    // un board si sta caricando (warm-up del proxy) si risincronizzano ogni
    // frame per la percentuale sull'etichetta (e un frame oltre, per pulire)
    const loading = o.proxies && o.proxies.loading.size > 0 ? o.proxies.loading : null;
    if (camChanged || boards.epoch !== this._bEpoch || loading !== null || this._hadLoading) {
      this._bEpoch = boards.epoch;
      this._syncBoards(camera, boards, loading);
    }
    this._hadLoading = loading !== null;

    const activeId = o.activeId;

    // upload dei chunk sporchi, ciascuno sul renderer del proprio piano.
    // I layer coperti da un proxy non si caricano: si segnano texDirty e
    // rinasceranno on-demand quando il board tornerà al path per-chunk.
    const skip = o.proxies ? o.proxies.skip : null;
    // la copertura dei proxy è cambiata (board coperto/scoperto): i piani 2D
    // devono ridipingere anche a camera ferma
    let skipKey = 0;
    if (skip !== null) for (const id of skip) skipKey = (Math.imul(skipKey, 31) + id) | 0;
    if (skipKey !== this._skipKey) {
      this._skipKey = skipKey;
      this._forceDraw = true;
    }
    let bottomDone = false;
    let c2dIdx = 0;
    for (const g of this.groups) {
      if (g.type === 'text') continue;
      const r = bottomDone ? this._pool[c2dIdx++] : bottom;
      bottomDone = true;
      for (const l of g.layers) {
        if (!l.store) continue; // testo cotto nel run: niente chunk
        if (skip !== null && skip.has(l.id)) {
          for (const c of l.store.dirty) c.texDirty = true;
          l.store.dirty.clear();
          continue;
        }
        r.uploadDirty(l.store);
        if (l.id === activeId) r.uploadDirty(strokeStore);
      }
    }

    // disegno: bottom sempre (è anche lo sfondo del documento), i piani 2D
    // solo se è cambiato qualcosa (camera, contenuto, tratto live nel gruppo)
    bottomDone = false;
    c2dIdx = 0;
    for (const g of this.groups) {
      if (g.type === 'text') {
        // board coperto da un quad proxy (che cuoce anche il testo): piano
        // SVG e bitmap dell'effetto spenti, zero repaint del browser. Lo
        // styleDirty NON si consuma: si sincronizza tutto al rientro.
        if (skip !== null && skip.has(g.layer.id)) {
          if (!this._hiddenText.has(g.layer.id)) {
            this._hiddenText.add(g.layer.id);
            g.layer.svg.style.visibility = 'hidden';
            g.layer.blockCanvas.style.visibility = 'hidden';
          }
          continue;
        }
        const unhide = this._hiddenText.delete(g.layer.id);
        if (unhide) {
          g.layer.svg.style.visibility = '';
          g.layer.blockCanvas.style.visibility = '';
        }
        const wasDirty = g.layer.styleDirty;
        if (wasDirty) { g.layer.styleDirty = false; syncTextSvg(g.layer); }
        if (this._frozen) {
          // zoom in corso: viewBox fermo alla base, il delta lo fa il
          // compositor (l'effetto bitmap resta allineato: stessa affine)
          if (g.layer.svg.getAttribute('viewBox') !== this._fzVb) {
            g.layer.svg.setAttribute('viewBox', this._fzVb);
          }
          if (g.layer.svg.style.transform !== this._fzT) {
            g.layer.svg.style.transform = this._fzT;
          }
        } else {
          if (g.layer.svg.style.transform) g.layer.svg.style.transform = '';
          if (camChanged || g.layer.svg.getAttribute('viewBox') !== this._vb) {
            g.layer.svg.setAttribute('viewBox', this._vb);
          }
        }
        // bitmap dell'effetto: a regime è un confronto e basta (al rientro
        // dal proxy si forza il controllo: la camera può essere cambiata
        // mentre il piano era spento)
        refreshBlockBitmap(g.layer, camera, camChanged || unhide);
        // l'ancora del canvas segue camera e spostamenti del testo
        if (camChanged || wasDirty || unhide) syncBlockTransform(g.layer, camera);
        // maschera al board (dopo l'eventuale rigenerazione: la chiave
        // del clip dipende da scala/ancora della bitmap)
        syncTextClip(g.layer);
        continue;
      }
      const hasActive = g.layers.some((l) => l.id === activeId);
      const stroke = hasActive ? strokeStore : null;
      const tf = o.transform || null;
      const fxF = o.fx || null;
      const tq = o.textQuads || null;
      if (!bottomDone) {
        bottomDone = true;
        bottom.render(camera, g.layers, activeId, stroke, o.liveOpacity, o.eraserLive,
          o.proxies || null, tf, fxF, tq);
      } else {
        const r = this._pool[c2dIdx++];
        const liveHere = stroke && stroke.map.size > 0;
        // un livello del gruppo è in sessione Sposta/Trasforma o Effetti:
        // matrice/sigma possono cambiare a ogni frame, il piano va ridipinto
        const tfHere = tf !== null && g.layers.some((l) => l.id === tf.layerId);
        const fxHere = fxF !== null && g.layers.some((l) => l.id === fxF.layerId);
        if (camChanged || r.uploadsThisFrame > 0 || liveHere || tfHere || fxHere || this._forceDraw) {
          // i proxy servono anche qui: i layer dei board coperti non si
          // ridisegnano per-chunk sopra il loro quad (i quad li fa il bottom)
          r.render(camera, g.layers, activeId, stroke, o.liveOpacity, o.eraserLive,
            o.proxies || null, tf, fxF, tq);
        }
      }
    }
    // niente gruppi raster: il bottom presenta comunque (pulisce il canvas)
    if (!bottomDone) {
      bottom.render(camera, [], activeId, null, 1, false, o.proxies || null, null, null,
        o.textQuads || null);
    }
    this._forceDraw = false;
  }

  // Forza il ridisegno dei piani 2D al prossimo frame (undo, visibilità...).
  invalidate() { this._forceDraw = true; }

  // Piano dei canvas: un div bianco per canvas (sfondo + bordo) e una
  // etichetta, posizionati in px schermo. Niente scale(): larghezza/altezza
  // in px già moltiplicati per lo zoom, così il bordo resta a spessore
  // costante a qualunque ingrandimento. loading: boardId -> 0..1, mostra
  // barra e percentuale finché il board non ha ricaricato le texture.
  /** @param {Camera} camera @param {BoardManager} boards @param {Map<number, number>|null} [loading] */
  _syncBoards(camera, boards, loading = null) {
    const z = camera.zoom;
    const seen = new Set();
    for (const b of boards.boards) {
      seen.add(b.id);
      let el = this._boardEls.get(b.id);
      if (!el) {
        const root = document.createElement('div');
        root.className = 'board';
        const label = document.createElement('div');
        label.className = 'board-label';
        this.boardsEl.append(root, label);
        el = { root, label, w: 0, h: 0, name: '' };
        this._boardEls.set(b.id, el);
      }
      const sx = (b.x - camera.x) * z + camera.w * 0.5;
      const sy = (b.y - camera.y) * z + camera.h * 0.5;
      const w = b.w * z, h = b.h * z;
      if (el.w !== w || el.h !== h) {
        el.w = w; el.h = h;
        el.root.style.width = w + 'px';
        el.root.style.height = h + 'px';
      }
      el.root.style.transform = `translate(${sx}px, ${sy}px)`;
      el.label.style.transform = `translate(${sx}px, ${sy - 22}px)`;
      const active = b.id === boards.activeId;
      el.root.classList.toggle('active', active);
      el.label.classList.toggle('active', active);
      const pct = loading !== null ? loading.get(b.id) : undefined;
      el.root.classList.toggle('loading', pct !== undefined);
      const name = pct !== undefined
        ? `${b.name} · carico ${Math.round(pct * 100)}%`
        : `${b.name} · ${b.w}×${b.h}`;
      if (el.name !== name) { el.name = name; el.label.textContent = name; }
    }
    // canvas spariti (clearAll): via anche i loro div
    for (const [id, el] of this._boardEls) {
      if (!seen.has(id)) {
        el.root.remove();
        el.label.remove();
        this._boardEls.delete(id);
      }
    }
  }

  // Gestisce il freeze dei piani testo durante lo zoom touch. Parte quando
  // CAMBIA lo zoom (il pan puro resta live: trasla soltanto), tiene fermo il
  // viewBox della base e mappa base→camera con un transform CSS esatto:
  // T(S0(w)) = S(w) per ogni punto mondo w, quindi il testo resta incollato
  // ai raster sottostanti. Dopo FREEZE_SETTLE_FRAMES a camera ferma si
  // scongela: i piani tolgono il transform e riprendono il viewBox vivo.
  /** @param {Camera} camera @param {boolean} camChanged */
  _updateFreeze(camera, camChanged) {
    if (!this._frozen) {
      if (!(camChanged && Number.isFinite(this._cz) && camera.zoom !== this._cz &&
        camera.w === this._cw && camera.h === this._ch)) return;
      this._frozen = true;
      this._fz.x = this._cx; this._fz.y = this._cy; this._fz.z = this._cz;
      this._fz.w = this._cw; this._fz.h = this._ch;
      this._fzVb = this._vb;
      this._fzStable = 0;
    }
    if (camera.w !== this._fz.w || camera.h !== this._fz.h) {
      // resize a metà gesto: la base non vale più, si torna vettoriali
      this._frozen = false;
      return;
    }
    if (camChanged) {
      this._fzStable = 0;
      const k = camera.zoom / this._fz.z;
      const tx = (this._fz.x - camera.x) * camera.zoom + camera.w * 0.5 * (1 - k);
      const ty = (this._fz.y - camera.y) * camera.zoom + camera.h * 0.5 * (1 - k);
      this._fzT = `translate3d(${tx}px,${ty}px,0) scale(${k})`;
    } else if (++this._fzStable >= FREEZE_SETTLE_FRAMES) {
      this._frozen = false;
    }
  }

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

  // Il renderer 2D del pool che possiede il livello (null = bottom GL o
  // testo): è lui il proprietario della cache c2d dei suoi chunk.
  /** @param {number} layerId @returns {Canvas2DRenderer|null} */
  poolRendererFor(layerId) {
    const i = this._where.get(layerId);
    return i !== undefined && i >= 0 ? this._pool[i] || null : null;
  }

  // Eviction dei piani 2D (i loro canvas-chunk sono memoria come le texture).
  // covered: store dei board coperti da un quad proxy — non si disegnano,
  // quindi evictabili anche se dentro la vista.
  /** @param {Camera} camera @param {Set<ChunkStore>|null} [covered] */
  evict(camera, covered = null) {
    let bottomDone = false;
    let c2dIdx = 0;
    for (const g of this.groups) {
      if (g.type !== 'raster') continue;
      if (!bottomDone) { bottomDone = true; continue; } // il bottom lo fa l'App
      const r = this._pool[c2dIdx++];
      const stores = [];
      for (const l of g.layers) if (l.store) stores.push(l.store);
      r.evict(stores, camera, 512, covered);
    }
  }
}
