// COLORDROP UI — trascina il colore dal rail e lascialo cadere sul canvas.
// La goccia segue il dito con fisica gommosa (filtro goo SVG sull'alpha,
// squash&stretch dalla velocità, code che inseguono con tensione
// superficiale); fermarsi un attimo sul canvas SENZA rilasciare innesca
// l'anteprima del riempimento e da lì lo scorrimento ORIZZONTALE regola la
// soglia (banner in alto, come il "ColorDrop threshold" di Procreate); il
// rilascio conferma. Rilascio diretto senza pausa = fill immediato.
// Dopo un riempimento appaiono la pillola "Riempi al tocco" e lo slider
// della soglia, e restano (aiutano a colorare in serie) finché non si
// cambia strumento (o ✕/Esc). Pillola attiva = ogni tap sul canvas
// riempie subito con lo stesso colore (giù = anteprima, scorri = soglia,
// su = conferma) — è il ColorDrop continuo. La sessione passa dagli hook
// stroke dell'App (vedi main.js), quindi pan a due dita, barra
// spaziatrice e gomma/penna restano intatti.

import { brush } from './brush.js';
import { clamp } from './util.js';
import { FillSession } from './flood_fill.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./boards.js').Board} Board */

const DRAG_START_PX = 8;      // oltre: il pointer-down sul swatch diventa drag
const HOLD_MS = 200;          // pausa sul canvas che innesca l'anteprima
const STILL_PX = 5;           // sotto: il dito conta come fermo
const TOL_PER_PX = 0.22;      // percento di soglia per px orizzontale
const TAIL_MAX = 60;          // px: tensione superficiale (la coda non si stacca)

export class FillUI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    /** @type {number} soglia persistente tra i riempimenti (percento) */
    this.tolerance = 35;
    /** @type {FillSession|null} */
    this._session = null;
    /** @type {''|'drag'|'tap'} percorso della sessione in corso */
    this._mode = '';
    this.tapActive = false;

    this.drop = document.getElementById('fill-drop');
    this.goo = /** @type {HTMLElement} */ (this.drop.querySelector('.fd-goo'));
    this.b0 = /** @type {HTMLElement} */ (this.drop.querySelector('.fd-b0'));
    this.b1 = /** @type {HTMLElement} */ (this.drop.querySelector('.fd-b1'));
    this.b2 = /** @type {HTMLElement} */ (this.drop.querySelector('.fd-b2'));
    this.gloss = /** @type {HTMLElement} */ (this.drop.querySelector('.fd-gloss'));
    this.banner = document.getElementById('fill-banner');
    this.pill = document.getElementById('fill-pill');
    this.tolRow = document.getElementById('fill-tol');
    this.tolRange = /** @type {HTMLInputElement} */ (document.getElementById('fill-tol-range'));
    this.tolVal = document.getElementById('fill-tol-val');

    // fisica della goccia (px schermo)
    this._px = 0; this._py = 0;       // blob principale
    this._t1x = 0; this._t1y = 0;     // coda 1
    this._t2x = 0; this._t2y = 0;     // coda 2
    this._tx = 0; this._ty = 0;       // bersaglio (dito o ancora)
    this._raf = 0;
    this._dropVisible = false;
    this._flyBack = false;

    // drag dal swatch
    this._dragId = -1;
    this._dragging = false;
    this._downX = 0; this._downY = 0;
    this._suppressClick = false;
    this._stillX = 0; this._stillY = 0;
    this._stillT = 0;

    // regolazione soglia (comune a drag e tap)
    this._adjBaseTol = 0;
    this._adjBaseX = 0;
    this._pendingTol = -1;            // run differita al prossimo frame
    this._anchorWx = 0; this._anchorWy = 0;

    this._bannerT = 0;
    this._tmpPt = { x: 0, y: 0 };

    this._bindSwatch();
    this._bindPill();
    this._bindTol();
  }

  // Sessione aperta (dito giù): blocca undo/redo e Canc come gli altri tool.
  get pending() { return this._session !== null; }

  // L'App instrada i punti/fine stroke qui finché la sessione tap è viva.
  get adjusting() { return this._mode === 'tap' && this._session !== null; }

  // ---- percorso 1: drag & drop dal swatch ----

  _bindSwatch() {
    const wrap = document.getElementById('color-wrap');
    wrap.addEventListener('pointerdown', (e) => {
      if (this._dragId !== -1) return;
      this._dragId = e.pointerId;
      this._dragging = false;
      this._downX = e.clientX; this._downY = e.clientY;
      try { wrap.setPointerCapture(e.pointerId); } catch { /* pointer già perso */ }
    });
    wrap.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._dragId) return;
      const x = e.clientX, y = e.clientY;
      if (!this._dragging) {
        if (Math.hypot(x - this._downX, y - this._downY) < DRAG_START_PX) return;
        // il gesto è un drag: niente picker al click che seguirà
        this._dragging = true;
        this._suppressClick = true;
        this._showDrop(x, y);
        this._stillX = x; this._stillY = y; this._stillT = performance.now();
      }
      this._tx = x; this._ty = y;
      if (this._session) {
        // anteprima innescata: orizzontale = soglia (la goccia resta ancorata)
        this._setPendingTol(this._adjBaseTol + (x - this._adjBaseX) * TOL_PER_PX);
        return;
      }
      if (Math.hypot(x - this._stillX, y - this._stillY) > STILL_PX) {
        this._stillX = x; this._stillY = y; this._stillT = performance.now();
      }
      // l'ingresso su un canvas non attivo lo seleziona subito: il warm-up
      // (proxy -> texture) corre mentre il dito è ancora in viaggio
      const board = this._boardAt(x, y);
      if (board && board.id !== this.app.boards.activeId) this.app.selectBoard(board.id);
    });
    /** @param {PointerEvent} e */
    const up = (e) => {
      if (e.pointerId !== this._dragId) return;
      this._dragId = -1;
      if (!this._dragging) return; // click semplice: si apre il picker nativo
      this._dragging = false;
      if (this._session) { this._finishSession(); return; }
      // rilascio diretto: fill immediato nel punto di rilascio
      const board = this._boardAt(e.clientX, e.clientY);
      if (board && this._startSession(board, e.clientX, e.clientY, 'drag')) {
        this._finishSession();
      } else {
        this._flyBackToSwatch();
      }
    };
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== this._dragId) return;
      this._dragId = -1;
      this._dragging = false;
      this._cancelSession();
      this._hideDrop();
    });
    // il click post-drag aprirebbe il picker: soppresso una volta sola
    wrap.addEventListener('click', (e) => {
      if (!this._suppressClick) return;
      this._suppressClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // Board sotto il punto SCHERMO, solo se il punto è davvero sul piano di
  // lavoro (non sopra un pannello/toolbar: elementFromPoint fa da hit-test).
  /** @param {number} sx @param {number} sy @returns {Board|null} */
  _boardAt(sx, sy) {
    const el = document.elementFromPoint(sx, sy);
    if (!el || !this.app.planesEl.contains(el)) return null;
    const w = this.app.camera.screenToWorld(sx, sy, this._tmpPt);
    return this.app.boards.hitTest(w.x, w.y);
  }

  // ---- percorso 2: "Riempi al tocco" (via hook stroke dell'App) ----

  _bindPill() {
    this.pill.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('#fill-pill-x')) {
        this.dismiss();
        return;
      }
      this.setTapActive(!this.tapActive);
    });
  }

  _bindTol() {
    // lo slider regola la soglia dei prossimi riempimenti; con una
    // sessione viva (secondo dito sul touch) riesegue l'anteprima al volo
    this.tolRange.addEventListener('input', () => {
      const v = +this.tolRange.value;
      if (this._session) this._setPendingTol(v);
      else { this.tolerance = v; this._syncTol(v); }
    });
  }

  /** @param {number} pct allinea slider ed etichetta */
  _syncTol(pct) {
    this.tolRange.value = String(pct);
    this.tolVal.textContent = pct.toFixed(1) + '%';
  }

  // Pillola + slider della soglia: compaiono dopo un riempimento riuscito
  // e restano finché non si cambia strumento (o ✕/Esc).
  _showHelpers() {
    this._syncTol(this.tolerance);
    this.pill.hidden = false;
    this.tolRow.hidden = false;
  }

  /** @param {boolean} v */
  setTapActive(v) {
    this.tapActive = v;
    this.pill.classList.toggle('active', v);
    this.app.planesEl.classList.toggle('fill-tap', v);
    if (!v && this._mode === 'tap') this._cancelSession();
  }

  // Cambio strumento / Esc / ✕ della pillola: spegne la modalità e
  // nasconde pillola e slider.
  dismiss() {
    this._cancelSession();
    this.setTapActive(false);
    this.pill.hidden = true;
    this.tolRow.hidden = true;
    this._hideBanner();
    if (this._dragId === -1) this._hideDrop();
  }

  // Pointer-down sul canvas con la modalità attiva (da App.startStroke):
  // anteprima immediata, poi scorri per la soglia, su per confermare.
  /** @param {Board} board @param {number} wx @param {number} wy mondo */
  tapStart(board, wx, wy) {
    const s = this.app.camera.worldToScreen(wx, wy, this._tmpPt);
    if (this._startSession(board, s.x, s.y, 'tap')) {
      this._showDrop(s.x, s.y);
      this.drop.classList.add('anchored');
    }
  }

  /** @param {number} wx @param {number} wy mondo */
  tapMove(wx, wy) {
    if (!this._session) return;
    // delta orizzontale in px SCHERMO: il gesto fisico comanda la soglia
    const dx = (wx - this._anchorWx) * this.app.camera.zoom;
    this._setPendingTol(this._adjBaseTol + dx * TOL_PER_PX);
  }

  tapEnd() { this._finishSession(); }

  tapCancel() { this._cancelSession(); this._hideDrop(); }

  // ---- sessione (comune ai due percorsi) ----

  /** @param {Board} board @param {number} sx @param {number} sy schermo @param {'drag'|'tap'} mode */
  _startSession(board, sx, sy, mode) {
    const a = this.app;
    if (this._session) return true;
    if (board.id !== a.boards.activeId) { a.selectBoard(board.id); return false; }
    if (a.proxy.isLoading(board.id)) return false; // warm-up: si riempirebbe alla cieca
    // un commit di stroke ancora in volo va chiuso PRIMA di fotografare
    if (a.strokeLive || a.commitJob) a._flushPendingStroke();
    if (a.strokeLive || a.commitJob || a.transform.pending || a.transform.dragging) return false;
    for (const t of a.fxTools) if (t.pending) t.cancel();
    const layer = board.mgr.paintTarget;
    if (!layer) {
      this._showBanner('The active layer is not paintable', false);
      return false;
    }
    const w = a.camera.screenToWorld(sx, sy, this._tmpPt);
    if (w.x < board.x || w.y < board.y ||
      w.x >= board.x + board.w || w.y >= board.y + board.h) return false;
    this._anchorWx = w.x; this._anchorWy = w.y;
    this._session = new FillSession(a, board, layer, w.x, w.y, brush.color);
    this._mode = mode;
    this._session.run(this.tolerance);
    this._adjBaseTol = this.tolerance;
    this._adjBaseX = sx;
    this._pendingTol = -1;
    this.drop.classList.add('anchored');
    // feedback della soglia: sullo slider se c'è già, altrimenti banner
    if (this.tolRow.hidden) this._showBanner(this._tolText(this.tolerance), true);
    else this._syncTol(this.tolerance);
    return true;
  }

  /** @param {number} pct */
  _setPendingTol(pct) {
    if (!this._session) return;
    pct = clamp(pct, 0, 100);
    this._pendingTol = pct;
    // il feedback non aspetta il frame: slider se visibile, altrimenti banner
    if (this.tolRow.hidden) this._showBanner(this._tolText(pct), true);
    else this._syncTol(pct);
    this._ensureLoop();
  }

  // Conferma: eventuale soglia in coda applicata in sincrono, poi commit.
  _finishSession() {
    const s = this._session;
    if (!s) { this._hideDrop(); return; }
    if (this._pendingTol >= 0 && this._pendingTol !== s.tolerance) {
      s.run(this._pendingTol);
    }
    this.tolerance = s.tolerance; // persiste per i prossimi riempimenti
    const committed = s.commit();
    this._session = null;
    this._mode = '';
    this._pendingTol = -1;
    // pillola e slider aiutano solo DOPO aver riempito davvero qualcosa:
    // da lì restano (si colora in serie) finché non si cambia strumento
    if (committed) this._showHelpers();
    if (this.tolRow.hidden) this._showBanner(this._tolText(this.tolerance), false, 2400);
    else this._hideBanner(); // lo slider mostra già il valore
    this._splash();
  }

  _cancelSession() {
    const s = this._session;
    if (!s) return;
    s.cancel();
    this._session = null;
    this._mode = '';
    this._pendingTol = -1;
    this._hideBanner();
    this.drop.classList.remove('anchored');
  }

  /** @param {number} pct */
  _tolText(pct) {
    return `Fill threshold · <b>${pct.toFixed(1)}%</b>`;
  }

  // ---- goccia: presentazione e fisica ----

  /** @param {number} x @param {number} y */
  _showDrop(x, y) {
    const c = brush.color;
    this.drop.style.color = `rgb(${c.r} ${c.g} ${c.b})`;
    this._px = this._t1x = this._t2x = this._tx = x;
    this._py = this._t1y = this._t2y = this._ty = y;
    this.drop.classList.remove('pop', 'anchored');
    this.drop.hidden = false;
    this._dropVisible = true;
    this._flyBack = false;
    this._ensureLoop();
  }

  _hideDrop() {
    this._dropVisible = false;
    this._flyBack = false;
    this.drop.hidden = true;
    this.drop.classList.remove('pop', 'anchored');
  }

  // Rilascio a vuoto: la goccia torna al swatch e sparisce.
  _flyBackToSwatch() {
    const r = document.getElementById('color-wrap').getBoundingClientRect();
    this._tx = r.left + r.width / 2;
    this._ty = r.top + r.height / 2;
    this._flyBack = true;
    this.drop.classList.remove('anchored');
    this._ensureLoop();
  }

  // Conferma: la goccia "scoppia" nel punto del fill, schizzi compresi.
  _splash() {
    const x = this._px, y = this._py;
    const c = brush.color;
    for (let i = 0; i < 7; i++) {
      const sp = document.createElement('div');
      sp.className = 'fd-splat';
      const ang = (i / 7) * Math.PI * 2 + (i % 2) * 0.4;
      const dist = 26 + (i % 3) * 14;
      sp.style.left = x + 'px';
      sp.style.top = y + 'px';
      sp.style.background = `rgb(${c.r} ${c.g} ${c.b})`;
      sp.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      sp.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
      sp.addEventListener('animationend', () => sp.remove());
      document.body.appendChild(sp);
    }
    this.drop.classList.remove('anchored');
    this.drop.classList.add('pop');
    setTimeout(() => { if (!this._dragging) this._hideDrop(); }, 300);
  }

  _ensureLoop() {
    if (this._raf === 0) this._raf = requestAnimationFrame(this._loop);
  }

  _loop = () => {
    this._raf = 0;
    if (!this._dropVisible && this._pendingTol < 0) return;
    this._raf = requestAnimationFrame(this._loop);

    // run di soglia differita: una sola per frame, mai nel pointermove
    if (this._session && this._pendingTol >= 0 && this._pendingTol !== this._session.tolerance) {
      this._session.run(this._pendingTol);
    }

    // pausa sul canvas durante il drag = innesco dell'anteprima
    if (this._mode === '' && this._dragging && !this._session &&
      performance.now() - this._stillT > HOLD_MS) {
      const board = this._boardAt(this._stillX, this._stillY);
      if (board) {
        if (this._startSession(board, this._stillX, this._stillY, 'drag')) {
          this._adjBaseX = this._tx; // la soglia parte dal dito, non dall'ancora
        } else {
          this._stillT = performance.now(); // riprova (warm-up in corso)
        }
      } else {
        this._stillT = performance.now();
      }
    }

    if (!this._dropVisible) return;

    // ancorata: il bersaglio è il seed (la camera può zoomare sotto il dito)
    let tx = this._tx, ty = this._ty;
    if (this._session) {
      const s = this.app.camera.worldToScreen(this._anchorWx, this._anchorWy, this._tmpPt);
      tx = s.x; ty = s.y;
    }

    const ppx = this._px, ppy = this._py;
    this._px += (tx - this._px) * 0.5;
    this._py += (ty - this._py) * 0.5;
    // code con tensione superficiale: inseguono ma non si staccano
    this._t1x += (this._px - this._t1x) * 0.32;
    this._t1y += (this._py - this._t1y) * 0.32;
    let dx = this._t1x - this._px, dy = this._t1y - this._py;
    let d = Math.hypot(dx, dy);
    if (d > TAIL_MAX) { this._t1x = this._px + dx / d * TAIL_MAX; this._t1y = this._py + dy / d * TAIL_MAX; }
    this._t2x += (this._t1x - this._t2x) * 0.26;
    this._t2y += (this._t1y - this._t2y) * 0.26;
    dx = this._t2x - this._t1x; dy = this._t2y - this._t1y;
    d = Math.hypot(dx, dy);
    if (d > TAIL_MAX * 0.7) { this._t2x = this._t1x + dx / d * TAIL_MAX * 0.7; this._t2y = this._t1y + dy / d * TAIL_MAX * 0.7; }

    // squash & stretch dalla velocità, allineato alla direzione del moto
    const vx = this._px - ppx, vy = this._py - ppy;
    const v = Math.hypot(vx, vy);
    const s = Math.min(0.55, v * 0.022);
    const ang = v > 0.5 ? Math.atan2(vy, vx) : 0;
    this.drop.style.transform = `translate3d(${this._px}px, ${this._py}px, 0)`;
    this.b0.style.transform = `rotate(${ang}rad) scale(${1 + s}, ${1 / (1 + s)})`;
    this.b1.style.transform = `translate(${this._t1x - this._px}px, ${this._t1y - this._py}px)`;
    this.b2.style.transform = `translate(${this._t2x - this._px}px, ${this._t2y - this._py}px)`;

    // ritorno al swatch completato: la goccia si riassorbe
    if (this._flyBack && Math.hypot(tx - this._px, ty - this._py) < 5) this._hideDrop();
  };

  // ---- banner della soglia ----

  /** @param {string} html @param {boolean} sticky @param {number} [ms] */
  _showBanner(html, sticky, ms = 1100) {
    this.banner.innerHTML = html;
    // a slider visibile i messaggi scivolano una riga sotto (non lo coprono)
    this.banner.classList.toggle('below', !this.tolRow.hidden);
    this.banner.hidden = false;
    this.banner.classList.add('show');
    clearTimeout(this._bannerT);
    if (!sticky) {
      this._bannerT = setTimeout(() => this._hideBanner(), ms);
    }
  }

  _hideBanner() {
    this.banner.classList.remove('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => { this.banner.hidden = true; }, 250);
  }
}
