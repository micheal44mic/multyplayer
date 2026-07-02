// BASE DEI TOOL A SESSIONE (pannello Effetti, Stile livello) — un solo
// posto per il ciclo di vita delicato: durante l'anteprima NESSUN pixel si
// tocca (il livello si presenta come quad cotto dal renderer, vedi FxFrame
// in renderer_gl.js), al ✓ il risultato si rasterizza one-shot nei chunk
// con undo a tile-diff. L'uscita implicita è l'ANNULLO: cambiare livello/
// canvas/strumento o iniziare un tratto butta l'anteprima senza costi —
// applicare è solo esplicito (✓/Invio). Le sottoclassi forniscono pannello
// e parametri: _refresh() (DOM), _params(s, b) (campi del FxFrame),
// _cpuApply(data, s, b) (fallback CPU del commit).

import { brush } from './brush.js';
import { CHUNK_SHIFT, contentBBox } from './store.js';
import { GLRenderer, FX_SIGMA_MAX } from './renderer_gl.js';
import { snapshotRect, applyFxResult } from './fx_blur.js';
import { createRangeRow } from './panel_controls.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./renderer_gl.js').FxFrame} FxFrame */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./boards.js').Board} Board */

// padding dell'hull per gli effetti che si spandono (3σmax dei blur; la
// traccia esterna è tappata a 60 << PAD)
export const PAD = 3 * FX_SIGMA_MAX;
const SINGLE_LAYER_HINT = 'Select a single layer to apply effects or layer styles.';

export class FxSessionTool {
  /** @param {App} app @param {string} panelId @param {string} btnId @param {string} closeId */
  constructor(app, panelId, btnId, closeId) {
    this.app = app;
    /** @type {any} sessione viva (campi comuni + parametri del tool) */
    this._session = null;
    this._stamp = 0;
    this._sig = '';
    this.panel = document.getElementById(panelId);
    this.btn = document.getElementById(btnId);
    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById(closeId).addEventListener('click', () => this.openPanel(false));
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  // Anteprima viva in attesa di ✓/✗ (blocca undo/redo come il transform).
  get pending() { return this._session !== null; }

  toggle() { this.openPanel(!this.isOpen); }

  /** @param {boolean} v */
  openPanel(v) {
    if (v === this.isOpen) return;
    if (!v && this._session) this.cancel();
    this.panel.classList.toggle('open', v);
    this.btn.classList.toggle('active', v);
    if (v) {
      // un pannello alla volta sul lato destro; un solo tool a sessione vivo
      this.app.ui.layersUI.open(false);
      this.app.ui.textUI.open(false);
      this.app.ui.svgUI.open(false);
      if (this.app.fxTools) {
        for (const t of this.app.fxTools) if (t !== this) t.openPanel(false);
      }
      this._sig = '';
      this._refresh();
    }
  }

  // Esc: prima l'annullo della sessione, poi la chiusura del pannello.
  escape() {
    if (this._session) this.cancel();
    else this.openPanel(false);
  }

  // Riga slider riusabile: testata label+valore, input range, set() scrive
  // nella sessione e il frame loop ridipinge da sé.
  /**
   * @param {string} label @param {number} min @param {number} max
   * @param {string} suffix
   * @param {(s: any, v: number) => void} set
   * @param {(s: any) => number} get
   */
  _sliderRow(label, min, max, suffix, set, get) {
    const control = createRangeRow({
      label,
      min,
      max,
      step: 1,
      get: () => {
        const s = this._session;
        return s ? get(s) : min;
      },
      set: (v) => {
        const s = this._session;
        if (s) set(s, v);
      },
      fmt: (v) => v + suffix,
      formatFromInput: true,
      initialSync: false,
      roundOnInput: false,
      beforeInput: () => {
        const s = this._session;
        return !!s;
      },
    });
    return {
      root: control.row,
      input: control.input,
      /** @param {any} s */
      refresh: (s) => {
        control.sync(get(s));
      },
    };
  }

  /**
   * @param {string[]} kinds
   * @param {Record<string, {icon: string, label: string}>} meta
   * @param {(kind: any) => void} pick
   */
  _makeItemList(kinds, meta, pick) {
    const list = document.createElement('div');
    list.className = 'fx-list';
    for (const kind of kinds) {
      const item = document.createElement('button');
      item.className = 'fx-item';
      item.type = 'button';
      item.innerHTML = meta[kind].icon + `<span>${meta[kind].label}</span>`;
      item.addEventListener('click', () => pick(kind));
      list.appendChild(item);
    }
    return list;
  }

  // Bottoni ✓/✗ del pannello.
  _makeActions() {
    const actions = document.createElement('div');
    actions.className = 'fx-actions';
    const button = (cls, text, title, fn) => {
      const b = document.createElement('button');
      b.className = cls;
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    actions.append(
      button('fx-ok', '✓ Apply & Rasterize', 'Apply and rasterize (Enter)', () => this.confirm()),
      button('fx-no', '✕ Cancel', 'Cancel (Esc)', () => this.cancel()),
    );
    return actions;
  }

  // Blocco del messaggio contestuale (testo da rasterizzare, vuoto...).
  _makeHint() {
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'fx-hint';
    this.hintEl.hidden = true;
    this.hintText = document.createElement('span');
    this.rastBtn = document.createElement('button');
    this.rastBtn.type = 'button';
    this.rastBtn.textContent = 'Rasterize Text';
    this.rastBtn.hidden = true;
    this.rastBtn.addEventListener('click', () => {
      this.app.rasterizeTextLayer(this.app.layerMgr.activeId);
      this._sig = '';
      this._refresh();
    });
    this.hintEl.append(this.hintText, this.rastBtn);
    return this.hintEl;
  }

  /** @param {string} msg */
  _flash(msg) {
    this.hintText.textContent = msg;
    this.rastBtn.hidden = true;
    this.hintEl.hidden = false;
  }

  // Coda comune di _refresh: il messaggio contestuale per lo stato corrente.
  /** @param {Layer|undefined} layer @param {boolean} inSession */
  _hintFor(layer, inSession) {
    let hint = '';
    let rast = false;
    if (!inSession) {
      if (this.app.layerMgr.selectedCount > 1) hint = SINGLE_LAYER_HINT;
      else if (!layer) hint = 'No layer selected.';
      else if (layer.kind === 'text') { hint = 'Text must be rasterized first.'; rast = true; }
      else if (!layer.visible) hint = 'The layer is hidden: make it visible.';
    }
    this.hintText.textContent = hint;
    this.rastBtn.hidden = !rast;
    this.hintEl.hidden = inSession || (hint === '' && !rast);
  }

  // Guardie comuni del click su una voce: ritorna il livello bersaglio o
  // null (con messaggio già mostrato).
  /** @returns {Layer|null} */
  _pickGuard() {
    if (this._session) return null;
    if (this.app.layerMgr.selectedCount > 1) {
      this._flash(SINGLE_LAYER_HINT);
      return null;
    }
    const layer = this.app.layerMgr.active;
    if (!layer) { this._flash('No layer selected.'); return null; }
    if (layer.kind === 'text') { this._flash('Text must be rasterized first.'); return null; }
    if (!layer.visible) { this._flash('The layer is hidden: make it visible.'); return null; }
    return layer;
  }

  // Apre la sessione sul livello attivo. Hull chunk-aligned (la texture si
  // monta per copia diretta dei chunk): bbox contenuto ∩ board ± pad, o il
  // board intero ± pad (fullBoard, per gli effetti che raggiungono tutto).
  // params = campi specifici del tool, copiati nella sessione.
  /** @param {string} kind @param {number} pad @param {boolean} fullBoard @param {Object} params */
  _beginSession(kind, pad, fullBoard, params) {
    const app = this.app;
    const board = app.boards.active;
    const layer = app.layerMgr.active;
    if (!board || !layer || layer.kind !== 'raster' || !layer.visible) return false;
    if (app.renderer.contextLost) return false;
    // un commit in volo scriverebbe pixel sotto la fotografia
    app._flushPendingStroke();
    const bb = contentBBox(layer.store);
    if (!bb) return false;
    let x0, y0, x1, y1;
    if (fullBoard) {
      x0 = board.x - pad; y0 = board.y - pad;
      x1 = board.x + board.w - 1 + pad; y1 = board.y + board.h - 1 + pad;
    } else {
      x0 = Math.max(bb.x0, board.x) - pad;
      y0 = Math.max(bb.y0, board.y) - pad;
      x1 = Math.min(bb.x1, board.x + board.w - 1) + pad;
      y1 = Math.min(bb.y1, board.y + board.h - 1) + pad;
    }
    const texX = (x0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
    const texY = (y0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
    this._session = Object.assign({
      kind,
      layerId: layer.id, boardId: board.id, stamp: ++this._stamp,
      ver0: layer.store.ver, tool0: brush.tool,
      texX, texY,
      texW: (((x1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - texX,
      texH: (((y1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - texY,
    }, params);
    return true;
  }

  // FxFrame completo: i parametri non usati dal kind restano a zero (entrano
  // nella firma di cache del renderer, innocui).
  /** @param {any} s @param {Layer} layer @param {Board} b @returns {FxFrame} */
  _buildFrame(s, layer, b) {
    return Object.assign({
      id: s.stamp, kind: s.kind, layerId: s.layerId, store: layer.store,
      x: s.texX, y: s.texY, w: s.texW, h: s.texH,
      sigma: 0, radius: 0, spacing: 0, angle: 0, dist: 0, k: 0, cx: 0, cy: 0,
      amount: 0, colorMix: 0, grainSize: 1, roughness: 0, seed: 0, thresh: 0,
      strokeW: 0, strokePos: 0, strokeR: 0, strokeG: 0, strokeB: 0,
      bevel: null,
      clip: { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 },
    }, this._params(s, b));
  }

  // Frame per i renderer: il livello si presenta come quad cotto.
  /** @returns {FxFrame|null} */
  frame() {
    const s = this._session;
    if (!s) return null;
    const layer = this.app.boards.layerById(s.layerId);
    const b = this.app.boards.byId(s.boardId);
    if (!layer || !layer.store || !b) return null;
    return this._buildFrame(s, layer, b);
  }

  // Ciclo di vita (ogni frame, da App._frame): il bersaglio non vale più
  // (livello/canvas/strumento cambiato, pixel mutati, contesto perso) =
  // annullo implicito. L'applicazione è solo esplicita.
  sync() {
    const s = this._session;
    if (s) {
      const app = this.app;
      const layer = app.boards.layerById(s.layerId);
      const ok = layer && layer.kind === 'raster' && layer.visible && layer.opacity > 0 &&
        app.boards.activeId === s.boardId && app.layerMgr.activeId === s.layerId &&
        layer.store.ver === s.ver0 && brush.tool === s.tool0 &&
        !app.renderer.contextLost;
      if (!ok) this.cancel();
    }
    if (this.isOpen) this._refresh();
  }

  // ✓: il risultato si rasterizza nei chunk, annullabile col tile-diff.
  // Path normale (WebGL): readback del risultato GPU dell'anteprima — il
  // commit è ESATTAMENTE ciò che si vedeva. Fallback (renderer 2D, contesto
  // perso): stesso effetto su CPU dai chunk, che sono la verità.
  confirm() {
    const s = this._session;
    if (!s) return;
    this._session = null;
    const app = this.app;
    this._sig = '';
    if (this.isOpen) this._refresh();
    app.planes.invalidate();
    const layer = app.boards.layerById(s.layerId);
    const board = app.boards.byId(s.boardId);
    if (!layer || !layer.store || !board) return;
    const frame = this._buildFrame(s, layer, board);
    let res = app.renderer instanceof GLRenderer ? app.renderer.fxReadback(frame) : null;
    if (!res) {
      const data = snapshotRect(layer.store, s.texX, s.texY, s.texW, s.texH);
      this._cpuApply(data, s, board);
      res = { x: s.texX, y: s.texY, w: s.texW, h: s.texH, data };
    }
    app.undoMgr.captureBegin(s.layerId);
    applyFxResult(layer.store, res, frame.clip,
      (key, cx, cy, before) => app.undoMgr.captureChunk(key, cx, cy, before),
      (c) => app.renderer.disposeChunkTex(c));
    app.undoMgr.captureEnd();
    layer.thumbDirty = true;
    app.ui.layersUI.scheduleThumbs();
  }

  // ✗: la sessione muore, zero costi (i pixel non sono mai stati toccati).
  cancel() {
    if (!this._session) return;
    this._session = null;
    this._sig = '';
    if (this.isOpen) this._refresh();
    this.app.planes.invalidate();
  }

  // ---- hook delle sottoclassi ----

  // Campi del FxFrame propri del tool (sovrascrivono gli zeri di default).
  /** @param {any} _s @param {Board} _b @returns {Object} */
  _params(_s, _b) { return {}; }

  // Commit su CPU (fallback): applica l'effetto IN PLACE al buffer.
  /** @param {Uint8ClampedArray} _data @param {any} _s @param {Board} _b */
  _cpuApply(_data, _s, _b) {}

  // Riallinea il pannello allo stato (firma in this._sig per il no-op).
  _refresh() {}
}
