// STRUMENTO SPOSTA/TRASFORMA — sessione con bbox, maniglie di scala e
// rotazione, conferma esplicita (✓/Invio) o annullo (✗/Esc).
// Filosofia anti-lag e anti-degrado: durante i gesti NESSUN pixel si tocca —
// tutti i ritocchi si accumulano in un'unica affine (sposta+ruota+scala,
// pivot al centro della bbox) e l'anteprima è il quad del renderer (vedi
// TransformFrame); al ✓ si ricampiona UNA volta sola dai pixel originali.
// Traslazione intera pura al ✓ = translateStore: bit-exact, undo leggero.
// Testo: niente texture — sposta/scala vivono su item.x/y/size (vettoriale,
// zero perdita); la rotazione del testo non esiste nel modello (prima si
// rasterizza, poi si ruota).
// Ciclo di vita PER FRAME (sync): se il bersaglio (tool, livello, canvas)
// cambia con una trasformazione pendente, questa si conferma da sola —
// stile Procreate: uscire = applicare; l'annullo è solo esplicito.

import { brush } from './brush.js';
import { CHUNK, CHUNK_SHIFT, translateStore, transformStore } from './store.js';
import { blockBox } from './text_layer.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./renderer_gl.js').TransformFrame} TransformFrame */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Maniglie: posizione nella bbox in unità (u,v) 0..1.
// Angoli = scala uniforme, lati = stira un asse, 'rot' = ruota (solo raster).
/** @type {[string, number, number][]} */
const DOTS = [
  ['tl', 0, 0], ['tr', 1, 0], ['br', 1, 1], ['bl', 0, 1],
  ['tm', 0.5, 0], ['rm', 1, 0.5], ['bm', 0.5, 1], ['lm', 0, 0.5],
];
const CORNER = new Set(['tl', 'tr', 'br', 'bl']);
const ROT_SNAP = 0.026; // ~1.5°: aggancio a 0/90/180/270 (torna al lossless)

// bbox pixel-exact del contenuto (alpha > 0), in mondo inclusivo.
/** @param {ChunkStore} store @returns {{x0:number,y0:number,x1:number,y1:number}|null} */
function contentBBox(store) {
  let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
  for (const c of store.map.values()) {
    const d = c.data, bx = c.cx * CHUNK, by = c.cy * CHUNK;
    for (let y = 0; y < CHUNK; y++) {
      let o = y * CHUNK * 4 + 3;
      for (let x = 0; x < CHUNK; x++, o += 4) {
        if (d[o] === 0) continue;
        const wx = bx + x, wy = by + y;
        if (wx < X0) X0 = wx;
        if (wx > X1) X1 = wx;
        if (wy < Y0) Y0 = wy;
        if (wy > Y1) Y1 = wy;
      }
    }
  }
  return X1 < X0 ? null : { x0: X0, y0: Y0, x1: X1, y1: Y1 };
}

/**
 * Stato della sessione. La trasformazione è
 * T = Translate(c+t) · Rot(θ) · Scale(sx,sy) · Translate(-c), pivot c fisso.
 * @typedef {Object} TfSession
 * @property {number} layerId @property {number} boardId
 * @property {'raster'|'text'} kind
 * @property {number} stamp timbro per la texture del renderer
 * @property {number} bx @property {number} by bbox contenuto alla partenza
 * @property {number} bw @property {number} bh
 * @property {number} cx @property {number} cy pivot (centro bbox)
 * @property {number} tx @property {number} ty traslazione (px mondo interi)
 * @property {number} theta @property {number} sx @property {number} sy
 * @property {number} texX @property {number} texY hull chunk-aligned (raster)
 * @property {number} texW @property {number} texH
 * @property {number} ix0 @property {number} iy0 @property {number} s0 testo: item alla partenza
 */

export class TransformTool {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    /** @type {TfSession|null} */
    this._session = null;
    this._stamp = 0;
    this._emptyKey = ''; // livello visto vuoto: niente rescan a ogni frame
    /** @type {{kind: string, gx: number, gy: number, tx0: number, ty0: number, th0: number, sx0: number, sy0: number}|null} */
    this._drag = null;
    this._sig = '';
    this._visible = false;
    this._tmp = { x: 0, y: 0 };

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'tfgizmo');
    svg.setAttribute('aria-hidden', 'true');
    this.svg = svg;
    this.edgeEl = document.createElementNS(SVG_NS, 'path');
    this.edgeEl.setAttribute('class', 'tg-edge');
    this.spokeEl = document.createElementNS(SVG_NS, 'path');
    this.spokeEl.setAttribute('class', 'tg-spoke');
    svg.append(this.edgeEl, this.spokeEl);
    /** @type {Map<string, SVGCircleElement>} */
    this._dots = new Map();
    for (const [k] of DOTS) this._addDot(k, CORNER.has(k) ? 'tg-corner' : 'tg-side');
    this._addDot('rot', 'tg-rot');
    document.body.appendChild(svg);

    this.okBtn = this._button('tg-ok', '✓', 'Applica (Invio)', () => this.confirm());
    this.noBtn = this._button('tg-no', '✕', 'Annulla (Esc)', () => this.cancel());
  }

  /** @param {string} cls @param {string} label @param {string} title @param {() => void} fn */
  _button(cls, label, title, fn) {
    const b = document.createElement('button');
    b.className = 'tg-btn ' + cls;
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.display = 'none';
    b.addEventListener('click', fn);
    document.body.appendChild(b);
    return b;
  }

  /** @param {string} key @param {string} cls */
  _addDot(key, cls) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('r', key === 'rot' ? '7' : '6');
    c.addEventListener('pointerdown', (e) => this._handleDown(e, key));
    c.addEventListener('pointermove', (e) => this._handleMove(e));
    const up = () => { this._drag = null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    this.svg.appendChild(c);
    this._dots.set(key, c);
  }

  get active() { return this._session !== null; }
  get dragging() { return this._drag !== null; }

  // Trasformazione non-identità in attesa di ✓/✗ (blocca undo/redo).
  get pending() {
    const s = this._session;
    return !!s && (s.tx !== 0 || s.ty !== 0 || s.theta !== 0 || s.sx !== 1 || s.sy !== 1);
  }

  // T mondo→mondo come [a,b,c,d,e,f].
  /** @param {TfSession} s */
  _matrix(s) {
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const a = s.sx * cos, b = s.sx * sin, c = -s.sy * sin, d = s.sy * cos;
    return [a, b, c, d,
      s.cx + s.tx - a * s.cx - c * s.cy,
      s.cy + s.ty - b * s.cx - d * s.cy];
  }

  // ---- ciclo di vita (ogni frame, da App._frame) ----
  /** @param {import('./camera.js').Camera} cam */
  sync(cam) {
    const want = brush.tool === 'move' ? this._target() : null;
    const s = this._session;
    if (s && (!want || want.layer.id !== s.layerId)) this.confirm();
    if (!this._session && want) this._begin(want.board, want.layer);
    this._syncGizmo(cam);
  }

  _target() {
    const app = this.app;
    const board = app.boards.active;
    const layer = app.layerMgr.active;
    if (!board || !layer || !layer.visible || layer.opacity <= 0) return null;
    if (app.renderer.contextLost) return null;
    return { board, layer };
  }

  // La sessione corrente non vale più (undo, struttura cambiata): si chiude
  // SENZA commit — da chiamare solo a trasformazione identità.
  rebind() {
    this._session = null;
    this._drag = null;
    this._emptyKey = '';
  }

  /** @param {import('./boards.js').Board} board @param {Layer} layer */
  _begin(board, layer) {
    /** @type {TfSession} */
    const s = {
      layerId: layer.id, boardId: board.id, kind: layer.kind,
      stamp: ++this._stamp,
      bx: 0, by: 0, bw: 0, bh: 0, cx: 0, cy: 0,
      tx: 0, ty: 0, theta: 0, sx: 1, sy: 1,
      texX: 0, texY: 0, texW: 0, texH: 0,
      ix0: 0, iy0: 0, s0: 0,
    };
    if (layer.kind === 'raster') {
      const k = layer.id + '|' + layer.store.ver;
      if (this._emptyKey === k) return;
      // un commit in volo scriverebbe pixel sotto la fotografia
      this.app._flushPendingStroke();
      const bb = contentBBox(layer.store);
      if (!bb) { this._emptyKey = k; return; }
      this._emptyKey = '';
      s.bx = bb.x0; s.by = bb.y0;
      s.bw = bb.x1 - bb.x0 + 1; s.bh = bb.y1 - bb.y0 + 1;
      // hull chunk-aligned: è la texture dell'anteprima e l'hull del commit
      s.texX = (bb.x0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
      s.texY = (bb.y0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
      s.texW = (((bb.x1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - s.texX;
      s.texH = (((bb.y1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - s.texY;
    } else {
      if (!layer.item.text) return;
      const box = blockBox(layer.item, layer.style);
      s.bx = box.x; s.by = box.y; s.bw = box.w; s.bh = box.h;
      s.ix0 = layer.item.x; s.iy0 = layer.item.y; s.s0 = layer.item.size;
    }
    s.cx = s.bx + s.bw / 2;
    s.cy = s.by + s.bh / 2;
    this._session = s;
  }

  // Frame per planes/renderer: il livello si presenta come quad trasformato.
  /** @returns {TransformFrame|null} */
  frame() {
    const s = this._session;
    if (!s || s.kind !== 'raster') return null;
    const layer = this.app.boards.layerById(s.layerId);
    const b = this.app.boards.byId(s.boardId);
    if (!layer || !layer.store || !b) return null;
    return {
      id: s.stamp, layerId: s.layerId, store: layer.store,
      x: s.texX, y: s.texY, w: s.texW, h: s.texH,
      m: this._matrix(s),
      clip: { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 },
    };
  }

  // ---- gesto di traslazione (drag sul canvas, via hook stroke) ----
  /** @param {number} x @param {number} y mondo */
  dragStart(x, y) {
    const s = this._session;
    if (!s) return;
    this._drag = { kind: 'pan', gx: x, gy: y, tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy };
  }

  /** @param {number} x @param {number} y mondo */
  dragMove(x, y) {
    const d = this._drag, s = this._session;
    if (!d || !s || d.kind !== 'pan') return;
    // snap a pixel interi: la sola-traslazione resta bit-exact al commit
    s.tx = Math.round(d.tx0 + (x - d.gx));
    s.ty = Math.round(d.ty0 + (y - d.gy));
    if (s.kind === 'text') this._applyText();
  }

  dragEnd() { this._drag = null; }

  // Secondo dito (gesture camera): il GESTO si annulla, la sessione resta.
  dragCancel() {
    const d = this._drag, s = this._session;
    if (d && s && d.kind === 'pan') {
      s.tx = d.tx0;
      s.ty = d.ty0;
      if (s.kind === 'text') this._applyText();
    }
    this._drag = null;
  }

  // ---- gesti sulle maniglie (eventi DOM del gizmo) ----
  /** @param {PointerEvent} e @param {string} key */
  _handleDown(e, key) {
    const s = this._session;
    if (!s) return;
    if (s.kind === 'text' && !CORNER.has(key)) return; // testo: solo angoli
    const tgt = /** @type {SVGCircleElement} */ (e.currentTarget);
    try { tgt.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    this._drag = {
      kind: key, gx: this._tmp.x, gy: this._tmp.y,
      tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy,
    };
  }

  /** @param {PointerEvent} e */
  _handleMove(e) {
    const d = this._drag, s = this._session;
    if (!d || !s || d.kind === 'pan') return;
    e.preventDefault();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    const px = this._tmp.x, py = this._tmp.y;
    // pivot corrente nel mondo: c + t (R·S non lo spostano)
    const pcx = s.cx + s.tx, pcy = s.cy + s.ty;
    if (d.kind === 'rot') {
      let th = d.th0 + Math.atan2(py - pcy, px - pcx) - Math.atan2(d.gy - pcy, d.gx - pcx);
      // aggancio ai multipli di 90°: a 0 si torna al commit senza perdita
      const q = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(th - q) < ROT_SNAP) th = q;
      s.theta = th;
      return;
    }
    if (CORNER.has(d.kind)) {
      // scala uniforme: rapporto delle distanze dal pivot
      const dn = Math.hypot(d.gx - pcx, d.gy - pcy);
      if (dn < 1e-6) return;
      let k = Math.hypot(px - pcx, py - pcy) / dn;
      if (s.kind === 'text') {
        k = Math.max(k, 2 / s.s0); // corpo minimo 2px
        s.sx = s.sy = d.sx0 * k;
        this._applyText();
        return;
      }
      s.sx = d.sx0 * k;
      s.sy = d.sy0 * k;
      return;
    }
    // lati: stira lungo l'asse LOCALE della box (ruotato di θ); il segno
    // del rapporto può ribaltare il contenuto (flip), voluto
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const ax = d.kind === 'lm' || d.kind === 'rm' ? cos : -sin;
    const ay = d.kind === 'lm' || d.kind === 'rm' ? sin : cos;
    const den = (d.gx - pcx) * ax + (d.gy - pcy) * ay;
    if (Math.abs(den) < 1e-6) return;
    const k = ((px - pcx) * ax + (py - pcy) * ay) / den;
    if (d.kind === 'lm' || d.kind === 'rm') s.sx = d.sx0 * k;
    else s.sy = d.sy0 * k;
  }

  // Testo: item derivato dallo stato della sessione (niente drift).
  _applyText() {
    const s = this._session;
    const layer = this.app.boards.layerById(s.layerId);
    if (!layer || !layer.item) return;
    layer.item.x = s.cx + s.tx + (s.ix0 - s.cx) * s.sx;
    layer.item.y = s.cy + s.ty + (s.iy0 - s.cy) * s.sx;
    layer.item.size = Math.max(2, s.s0 * s.sx);
    layer.styleDirty = true;
  }

  // ---- conferma / annullo ----
  confirm() {
    if (this.app.blockMultiplayerUnsupported('Sposta livello')) return;
    const s = this._session;
    if (!s) return;
    this._session = null;
    this._drag = null;
    const app = this.app;
    const layer = app.boards.layerById(s.layerId);
    if (!layer) return;
    const identity = s.tx === 0 && s.ty === 0 && s.theta === 0 && s.sx === 1 && s.sy === 1;
    if (identity) return;
    if (s.kind === 'text') {
      app.undoMgr.pushStruct(/** @type {any} */ ({
        op: 'textform', layerId: s.layerId, boardId: s.boardId,
        x0: s.ix0, y0: s.iy0, s0: s.s0,
        x1: layer.item.x, y1: layer.item.y, s1: layer.item.size,
      }));
      layer.thumbDirty = true;
      app.ui.layersUI.scheduleThumbs();
      return;
    }
    app._flushPendingStroke();
    const board = app.boards.byId(s.boardId);
    if (!board) return;
    const clip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => app.renderer.disposeChunkTex(c);
    if (s.theta === 0 && s.sx === 1 && s.sy === 1) {
      // traslazione intera pura: zero ricampionamento, undo leggero
      const lost = translateStore(layer.store, s.tx, s.ty, clip, dispose);
      app.undoMgr.pushMove(/** @type {any} */ (
        { layerId: s.layerId, dx: s.tx, dy: s.ty, boardId: s.boardId, chunks: lost }));
    } else {
      // ricampionamento one-shot; undo = tile-diff come una pennellata
      app.undoMgr.captureBegin(s.layerId);
      transformStore(layer.store, this._matrix(s),
        { x: s.texX, y: s.texY, w: s.texW, h: s.texH }, clip,
        (key, cx, cy, before) =>
          app.undoMgr.captureChunk(key, cx, cy, /** @type {any} */ (before)),
        dispose);
      app.undoMgr.captureEnd();
    }
    layer.thumbDirty = true;
    app.ui.layersUI.scheduleThumbs();
    app.planes.invalidate();
  }

  cancel() {
    const s = this._session;
    if (!s) return;
    this._session = null;
    this._drag = null;
    if (s.kind === 'text') {
      const layer = this.app.boards.layerById(s.layerId);
      if (layer && layer.item) {
        layer.item.x = s.ix0;
        layer.item.y = s.iy0;
        layer.item.size = s.s0;
        layer.styleDirty = true;
      }
    }
    this.app.planes.invalidate();
  }

  // ---- gizmo a schermo (ogni frame) ----
  /** @param {import('./camera.js').Camera} cam */
  _syncGizmo(cam) {
    const s = this._session;
    if (!s) {
      if (this._visible) {
        this._visible = false;
        this.svg.style.display = 'none';
        this.okBtn.style.display = 'none';
        this.noBtn.style.display = 'none';
        this._sig = '';
      }
      return;
    }
    const sig = `${cam.x}|${cam.y}|${cam.zoom}|${cam.w}|${cam.h}|${s.stamp}|` +
      `${s.tx}|${s.ty}|${s.theta}|${s.sx}|${s.sy}`;
    if (sig === this._sig && this._visible) return;
    this._sig = sig;
    if (!this._visible) {
      this._visible = true;
      this.svg.style.display = 'block';
      this.okBtn.style.display = '';
      this.noBtn.style.display = '';
      // testo: niente rotazione né stira — si nascondono le maniglie
      const text = s.kind === 'text';
      for (const [k, dot] of this._dots) {
        dot.style.display = text && !CORNER.has(k) ? 'none' : '';
      }
    }
    const m = this._matrix(s);
    /** @type {(u: number, v: number) => {x: number, y: number}} */
    const P = (u, v) => {
      const lx = s.bx + u * s.bw, ly = s.by + v * s.bh;
      return cam.worldToScreen(
        m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5], { x: 0, y: 0 });
    };
    const tl = P(0, 0), tr = P(1, 0), br = P(1, 1), bl = P(0, 1);
    this.edgeEl.setAttribute('d',
      `M ${tl.x} ${tl.y} L ${tr.x} ${tr.y} L ${br.x} ${br.y} L ${bl.x} ${bl.y} Z`);
    const ctrX = (tl.x + tr.x + br.x + bl.x) / 4, ctrY = (tl.y + tr.y + br.y + bl.y) / 4;
    /** @type {Record<string, {x: number, y: number}>} */
    const pts = { tl, tr, br, bl };
    for (const [k, u, v] of DOTS) if (!pts[k]) pts[k] = P(u, v);
    // maniglia di rotazione: 28px schermo fuori dal lato alto
    const tm = pts.tm;
    const dlen = Math.hypot(tm.x - ctrX, tm.y - ctrY) || 1;
    pts.rot = {
      x: tm.x + (tm.x - ctrX) / dlen * 28,
      y: tm.y + (tm.y - ctrY) / dlen * 28,
    };
    this.spokeEl.setAttribute('d', `M ${tm.x} ${tm.y} L ${pts.rot.x} ${pts.rot.y}`);
    this.spokeEl.style.display = s.kind === 'text' ? 'none' : '';
    for (const [k, dot] of this._dots) {
      dot.setAttribute('cx', String(pts[k].x));
      dot.setAttribute('cy', String(pts[k].y));
    }
    // ✓/✗ sotto il punto più basso della box
    const byMax = Math.max(tl.y, tr.y, br.y, bl.y);
    this.okBtn.style.left = (ctrX - 40) + 'px';
    this.okBtn.style.top = (byMax + 14) + 'px';
    this.noBtn.style.left = (ctrX + 4) + 'px';
    this.noBtn.style.top = (byMax + 14) + 'px';
  }
}
