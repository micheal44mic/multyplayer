// Ink overlay — fase 0 del piano WebGPU (docs/webgpu-engine-plan.md).
// La punta del tratto come geometria PROVVISORIA su un canvas 2D sopra i
// piani: copre il lag percepito senza toccare la matematica dei pixel.
// Tre pezzi, dal fondo alla punta:
//   1. i descrittori IN VOLO (coda main non ancora rasterizzata, o entry non
//      ancora drenate dal worker via bridge.inkRing) — geometria esatta,
//      raggio compreso, quindi specchio/pattern coperti gratis;
//   2. il gap dello stabilizzatore: dall'ultimo nodo emesso alla punta RAW
//      (alla Procreate: si mostra il dito, non il punto stabilizzato);
//   3. 1-2 frame di predizione lineare oltre la punta.
// Il raster vero lo sostituisce frame per frame; al pen-up l'overlay sparisce
// (l'endpass ridisegna la punta rastremata: la geometria piena sarebbe falsa).
// Gate: SOLO tratto locale di pennello (niente gomma/aqua/selezione/snap,
// mai replay collab, sfumino o liquify — quelli non passano da strokeBegin).
// L'opacità del tratto è sul CANVAS (style.opacity): dentro si disegna a
// colore pieno, così le sovrapposizioni interne non scuriscono (semantica
// wash del motore).

import { STRIDE, T_DAB } from './stroke.js';

/** @typedef {import('./stroke.js').StrokeEngine} StrokeEngine */
/** @typedef {import('./stroke.js').DabQueue} DabQueue */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./raster_bridge.js').RasterBridge} RasterBridge */

/**
 * Sottoinsieme dell'App letto dall'overlay (duck-typed: niente import del
 * modulo main).
 * @typedef {Object} InkApp
 * @property {StrokeEngine} engine
 * @property {DabQueue} queue
 * @property {Camera} camera
 * @property {boolean} strokeLive
 * @property {string} rasterMode
 * @property {RasterBridge} rasterBridge
 * @property {object|null} _strokeSel
 * @property {{x0: number, y0: number, x1: number, y1: number}|null} _strokeClip
 */

const RING = 64;                 // punti raw tenuti (coalesced 240Hz ≈ 250ms)
const PRED_MS = 14;              // orizzonte di predizione (~1 frame + margine)
const PRED_CAP_CSS = 28;         // tetto allo spostamento predetto (px CSS):
                                 // al pen-up la predizione sparisce, oltre
                                 // questo si percepisce la punta "ritirarsi"
const PRED_MIN_SPEED = 0.05;     // sotto (px CSS/ms) niente predizione: jitter
const TIP_MAX_PTS = 24;          // punti raw massimi nella polilinea di punta
const CHAIN_MAX = 12;            // catene aperte (specchio ×2, pattern ×9)
const CHAIN_W_TOL = 0.12;        // tolleranza di larghezza per unire capsule
const MIN_W_CSS = 0.6;           // sotto questa larghezza schermo non si vede

export class InkOverlay {
  constructor() {
    this.el = document.createElement('canvas');
    this.el.id = 'ink-overlay';
    this.el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.el);
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    this._w = 1; this._h = 1; this._dpr = 1;
    this._sized = false;         // backing store allineato alle misure correnti
    this._active = false;        // tratto locale di pennello in corso
    this._tail = false;          // pen-up fatto ma pipeline non drenata: si
                                 // continua a coprire il SOLO in-volo (sui
                                 // pennelli grandi la scia non scatta indietro)
    this._opacity = '';          // ultima style.opacity applicata
    // bbox CSS px sporcata dall'ultimo draw (da pulire al frame dopo)
    this._dx0 = 0; this._dy0 = 0; this._dx1 = -1; this._dy1 = -1;
    // ring dei punti raw del tratto corrente (coordinate documento)
    this._rn = 0;
    this._rx = new Float64Array(RING);
    this._ry = new Float64Array(RING);
    this._rp = new Float64Array(RING);
    this._rt = new Float64Array(RING);
    // catene di capsule in costruzione (riusate, niente allocazioni a regime)
    /** @type {{n: number, w: number, tx: number, ty: number, xs: Float64Array, ys: Float64Array}[]} */
    this._chains = [];
    for (let i = 0; i < CHAIN_MAX; i++) {
      this._chains.push({ n: 0, w: 0, tx: 0, ty: 0, xs: new Float64Array(256), ys: new Float64Array(256) });
    }
    this._chainN = 0;            // catene attive in [0, _chainN)
  }

  /**
   * Misure del riquadro dei piani (stesse dell'App._resize); il canvas si
   * riposiziona lì sopra. Il backing store si (ri)alloca pigro al prossimo
   * frame attivo: chi non disegna non paga la VRAM dell'overlay.
   * @param {number} w @param {number} h @param {number} dpr
   * @param {number} left @param {number} top
   */
  resize(w, h, dpr, left, top) {
    this._w = Math.max(1, w); this._h = Math.max(1, h);
    this._dpr = dpr;
    this.el.style.left = left + 'px';
    this.el.style.top = top + 'px';
    this._sized = false;
    // NIENTE reset del dirty rect: il backing store si rialloca solo in
    // _applySize (pigro, al prossimo frame attivo) — fino ad allora i pixel
    // vecchi restano e _clearPrev li deve ancora sapere pulire (transform e
    // coordinate del vecchio backing sono intatte, quindi il rect è valido)
  }

  /** Pen-down di un tratto locale di pennello (chiamato SOLO da startStroke).
   * @param {number} x @param {number} y @param {number} p @param {number} t */
  strokeBegin(x, y, p, t) {
    this._active = true;
    this._tail = false;
    this._rn = 0;
    this._pushRaw(x, y, p, t);
  }

  /** Punto raw (pre-stabilizzatore, coordinate documento, coalesced inclusi).
   * @param {number} x @param {number} y @param {number} p @param {number} t */
  strokePoint(x, y, p, t) {
    if (this._active) this._pushRaw(x, y, p, t);
  }

  /** Pen-up o annullo: la punta raw+predizione sparisce al prossimo frame;
   * l'in-volo resta coperto finché la pipeline non è drenata (_tail). */
  strokeEnd() {
    this._active = false;
    this._tail = true;
  }

  /**
   * Da chiamare una volta per frame, dopo planes.render. Decide da solo se
   * disegnare o pulire.
   * @param {InkApp} app
   */
  frame(app) {
    const eng = app.engine;
    const snap = eng.snap;
    // live = penna giù (in-volo + punta raw + predizione); tail = pen-up
    // fatto ma pipeline non drenata (SOLO in-volo: sui pennelli grandi la
    // scia resta coperta mentre il worker recupera, e il replay rastremato
    // della punta passa anch'esso dall'in-volo del bridge)
    const gates = snap !== null && !eng.snapMode && !snap.eraser && !snap.aqua &&
      app._strokeSel === null;
    const live = this._active && app.strokeLive && eng.active && gates;
    const tail = !this._active && this._tail && app.strokeLive && gates;
    if (!live && !tail) {
      if (!this._active) {
        this._rn = 0;
        if (!app.strokeLive) this._tail = false;
      }
      this._clearPrev();
      return;
    }
    if (!this._sized) this._applySize();
    const ctx = this.ctx;
    if (!ctx) return;
    this._clearPrev();

    const s = /** @type {NonNullable<typeof snap>} */ (snap);
    // opacità del tratto sull'elemento: il disegno interno resta a colore
    // pieno e le sovrapposizioni non scuriscono
    const alpha = s.buildup ? Math.min(1, s.opacity) : s.globalOpacity;
    if (alpha < 0.02) return;
    const aStr = alpha >= 0.999 ? '' : String(Math.round(alpha * 1000) / 1000);
    if (this._opacity !== aStr) {
      this._opacity = aStr;
      this.el.style.opacity = aStr;
    }

    ctx.save();
    // il raster clampa i bbox ai bordi del canvas attivo: l'overlay pure
    const clip = app._strokeClip;
    const cam = app.camera;
    if (clip) {
      const x0 = this._sx(cam, clip.x0), y0 = this._sy(cam, clip.y0);
      const x1 = this._sx(cam, clip.x1 + 1), y1 = this._sy(cam, clip.y1 + 1);
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
    }
    ctx.fillStyle = ctx.strokeStyle = `rgb(${s.colR},${s.colG},${s.colB})`;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. descrittori in volo (geometria esatta ancora da rasterizzare)
    this._chainN = 0;
    if (app.rasterMode === 'worker') this._inFlightWorker(ctx, app.rasterBridge, cam);
    else this._inFlightQueue(ctx, app.queue, cam);
    this._flushChains(ctx, cam);

    // 2+3. punta raw + predizione (e la sua copia specchiata) — solo a
    // penna giù: al pen-up si ritirano subito, il tratto vero arriva lì
    if (live) {
      this._drawTip(ctx, app, 0);
      const ax = app.queue.mirrorX;
      if (ax !== null) this._drawTip(ctx, app, ax * 2);
    }

    ctx.restore();
  }

  // ---- trasformazione documento -> px CSS locali al canvas ----
  // (il canvas è incollato al riquadro dei piani: niente offset ox/oy)

  /** @param {Camera} cam @param {number} wx */
  _sx(cam, wx) { return (wx - cam.x) * cam.zoom + this._w * 0.5; }
  /** @param {Camera} cam @param {number} wy */
  _sy(cam, wy) { return (wy - cam.y) * cam.zoom + this._h * 0.5; }

  // ---- punta ----

  /**
   * Polilinea dall'ancora (ultimo nodo emesso) attraverso i punti raw recenti
   * fino alla punta + predizione. ox != 0 = copia specchiata (x' = ox - x).
   * @param {CanvasRenderingContext2D} ctx @param {InkApp} app @param {number} ox
   */
  _drawTip(ctx, app, ox) {
    const n = this._rn;
    if (n === 0) return;
    const eng = app.engine;
    const s = /** @type {NonNullable<typeof eng.snap>} */ (eng.snap);
    const cam = app.camera;
    const zoom = cam.zoom;
    const mir = ox !== 0;
    const tipI = (n - 1) % RING;
    const tx = this._rx[tipI], ty = this._ry[tipI];

    // ancora: ultimo nodo emesso (via continua), ultima emissione discreta,
    // altrimenti il punto stabilizzato (pen-down, finestra d'inizio aperta)
    let ax, ay;
    if (eng._segStarted) { ax = eng._fx; ay = eng._fy; }
    else if (eng._enValid) { ax = eng._enX; ay = eng._enY; }
    else { ax = eng.debug.outX; ay = eng.debug.outY; }

    // raggio della punta: quello dell'ultima emissione; prima di ogni
    // emissione (finestra d'inizio) una stima da pressione + taper
    let r = 0;
    if (eng._segStarted && eng._fr > 0) r = eng._fr;
    else if (eng._lemM >= 0) r = s.baseR * eng._lemM;
    if (r <= 0) {
      const th = s.taperStart + (1 - s.taperStart) * 0.5;
      r = s.baseR * eng._pressMult(this._rp[tipI]) * th;
    }
    const wCss = Math.max(r * 2 * zoom, MIN_W_CSS);

    // punti raw fra ancora e punta: si cammina all'indietro dalla punta
    // accumulando lunghezza fino alla distanza ancora->punta (lo stabilizzato
    // insegue il percorso raw di circa quel tanto)
    const budget = Math.hypot(tx - ax, ty - ay) * 1.15 + 1;
    let count = 0, acc = 0;
    let px = tx, py = ty;
    const lo = Math.max(0, n - RING);
    for (let i = n - 2; i >= lo && count < TIP_MAX_PTS; i--) {
      const j = i % RING;
      const x = this._rx[j], y = this._ry[j];
      acc += Math.hypot(x - px, y - py);
      if (acc > budget) break;
      px = x; py = y;
      count++;
    }

    ctx.lineWidth = wCss;
    ctx.beginPath();
    ctx.moveTo(this._sx(cam, mir ? ox - ax : ax), this._sy(cam, ay));
    for (let i = n - 1 - count; i <= n - 1; i++) {
      const j = i % RING;
      const x = mir ? ox - this._rx[j] : this._rx[j];
      ctx.lineTo(this._sx(cam, x), this._sy(cam, this._ry[j]));
    }

    // predizione: velocità dagli ultimi campioni raw, orizzonte PRED_MS,
    // spostamento tappato (overshoot contenuto alla Procreate)
    let vj = -1;
    for (let i = n - 2; i >= lo && i >= n - 9; i--) {
      if (this._rt[tipI] - this._rt[i % RING] >= 4) { vj = i % RING; break; }
    }
    if (vj >= 0) {
      const dt = Math.min(50, Math.max(2, this._rt[tipI] - this._rt[vj]));
      let vx = (tx - this._rx[vj]) / dt, vy = (ty - this._ry[vj]) / dt;
      const spCss = Math.hypot(vx, vy) * zoom;
      if (spCss > PRED_MIN_SPEED) {
        let dx = vx * PRED_MS, dy = vy * PRED_MS;
        const dCss = Math.hypot(dx, dy) * zoom;
        if (dCss > PRED_CAP_CSS) {
          const k = PRED_CAP_CSS / dCss;
          dx *= k; dy *= k;
        }
        const qx = mir ? ox - (tx + dx) : tx + dx;
        ctx.lineTo(this._sx(cam, qx), this._sy(cam, ty + dy));
      }
    }
    ctx.stroke();
    this._mark(this._sx(cam, mir ? ox - tx : tx), this._sy(cam, ty),
      wCss * 0.5 + PRED_CAP_CSS + budget * zoom + 2);
  }

  // ---- descrittori in volo ----

  /**
   * Coda main non ancora consumata dal budget del raster (entry [head, head+count)).
   * @param {CanvasRenderingContext2D} ctx @param {DabQueue} queue @param {Camera} cam
   */
  _inFlightQueue(ctx, queue, cam) {
    const cnt = queue.count;
    if (cnt === 0) return;
    const q = queue.buf, cap = queue.cap;
    for (let i = 0; i < cnt; i++) {
      const o = ((queue.head + i) % cap) * STRIDE;
      if (q[o] === T_DAB) this._dab(ctx, cam, q[o + 1], q[o + 2], q[o + 3]);
      else this._seg(ctx, cam, q[o + 1], q[o + 2], q[o + 3], q[o + 5], q[o + 6], q[o + 7]);
    }
  }

  /**
   * Entry mandate al worker ma non ancora drenate: (tickDrained, sent] nel
   * ring del bridge (tickDrained = drained fotografato al tick, cioè fin dove
   * i pixel sono davvero arrivati allo store specchio in questo frame).
   * @param {CanvasRenderingContext2D} ctx @param {RasterBridge} bridge @param {Camera} cam
   */
  _inFlightWorker(ctx, bridge, cam) {
    const ring = bridge.inkRing;
    if (!ring) return;
    const cap = ring.length >> 3;
    const hi = bridge.sent;
    const lo = Math.max(bridge.tickDrained + 1, hi - cap + 1);
    for (let idx = lo; idx <= hi; idx++) {
      const o = (idx & (cap - 1)) * 8;
      if (ring[o] === T_DAB) this._dab(ctx, cam, ring[o + 1], ring[o + 2], ring[o + 3]);
      else this._seg(ctx, cam, ring[o + 1], ring[o + 2], ring[o + 3], ring[o + 4], ring[o + 5], ring[o + 6]);
    }
  }

  /** Dab: cerchio pieno, immediato. @param {CanvasRenderingContext2D} ctx @param {Camera} cam
   * @param {number} x @param {number} y @param {number} r */
  _dab(ctx, cam, x, y, r) {
    const rc = r * cam.zoom;
    if (rc < MIN_W_CSS * 0.5) return;
    const sx = this._sx(cam, x), sy = this._sy(cam, y);
    ctx.beginPath();
    ctx.arc(sx, sy, rc, 0, Math.PI * 2);
    ctx.fill();
    this._mark(sx, sy, rc + 1);
  }

  /**
   * Capsula: si accoda alla catena che finisce dove questa comincia (stessa
   * larghezza entro tolleranza) — le catene continue del motore collassano in
   * poche stroke() anche con centinaia di entry in volo.
   * @param {CanvasRenderingContext2D} ctx @param {Camera} cam
   * @param {number} x1 @param {number} y1 @param {number} r1
   * @param {number} x2 @param {number} y2 @param {number} r2
   */
  _seg(ctx, cam, x1, y1, r1, x2, y2, r2) {
    const w = Math.max(r1, r2) * 2 * cam.zoom;
    if (w < MIN_W_CSS) return;
    for (let i = 0; i < this._chainN; i++) {
      const c = this._chains[i];
      if (c.tx === x1 && c.ty === y1 && Math.abs(c.w - w) <= c.w * CHAIN_W_TOL) {
        if (c.n === c.xs.length) {
          this._strokeChain(ctx, cam, c);
          c.xs[0] = x1; c.ys[0] = y1; c.n = 1;
        }
        c.xs[c.n] = x2; c.ys[c.n] = y2; c.n++;
        c.tx = x2; c.ty = y2;
        return;
      }
    }
    let c;
    if (this._chainN < CHAIN_MAX) {
      c = this._chains[this._chainN++];
    } else {
      // niente slot: si chiude la catena più lunga e si riusa il suo posto
      c = this._chains[0];
      for (let i = 1; i < CHAIN_MAX; i++) if (this._chains[i].n > c.n) c = this._chains[i];
      this._strokeChain(ctx, cam, c);
    }
    c.w = w;
    c.xs[0] = x1; c.ys[0] = y1;
    c.xs[1] = x2; c.ys[1] = y2;
    c.n = 2;
    c.tx = x2; c.ty = y2;
  }

  /** @param {CanvasRenderingContext2D} ctx @param {Camera} cam
   * @param {{n: number, w: number, xs: Float64Array, ys: Float64Array}} c */
  _strokeChain(ctx, cam, c) {
    if (c.n < 2) { c.n = 0; return; }
    ctx.lineWidth = c.w;
    ctx.beginPath();
    let sx = this._sx(cam, c.xs[0]), sy = this._sy(cam, c.ys[0]);
    ctx.moveTo(sx, sy);
    let x0 = sx, y0 = sy, x1 = sx, y1 = sy;
    for (let i = 1; i < c.n; i++) {
      sx = this._sx(cam, c.xs[i]); sy = this._sy(cam, c.ys[i]);
      ctx.lineTo(sx, sy);
      if (sx < x0) x0 = sx; else if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy; else if (sy > y1) y1 = sy;
    }
    ctx.stroke();
    const pad = c.w * 0.5 + 1;
    this._markRect(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
    c.n = 0;
  }

  /** @param {CanvasRenderingContext2D} ctx @param {Camera} cam */
  _flushChains(ctx, cam) {
    for (let i = 0; i < this._chainN; i++) this._strokeChain(ctx, cam, this._chains[i]);
    this._chainN = 0;
  }

  // ---- pulizia / misure ----

  /** @param {number} x @param {number} y @param {number} pad */
  _mark(x, y, pad) {
    this._markRect(x - pad, y - pad, x + pad, y + pad);
  }

  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
  _markRect(x0, y0, x1, y1) {
    if (this._dx1 < this._dx0) {
      this._dx0 = x0; this._dy0 = y0; this._dx1 = x1; this._dy1 = y1;
      return;
    }
    if (x0 < this._dx0) this._dx0 = x0;
    if (y0 < this._dy0) this._dy0 = y0;
    if (x1 > this._dx1) this._dx1 = x1;
    if (y1 > this._dy1) this._dy1 = y1;
  }

  _clearPrev() {
    if (this._dx1 < this._dx0 || !this.ctx) return;
    const x0 = Math.max(0, this._dx0 - 2), y0 = Math.max(0, this._dy0 - 2);
    this.ctx.clearRect(x0, y0,
      Math.min(this._w, this._dx1 + 2) - x0, Math.min(this._h, this._dy1 + 2) - y0);
    this._dx1 = -1; this._dy1 = -1; this._dx0 = 0; this._dy0 = 0;
  }

  _applySize() {
    this._sized = true;
    this.el.width = Math.max(1, Math.round(this._w * this._dpr));
    this.el.height = Math.max(1, Math.round(this._h * this._dpr));
    this.el.style.width = this._w + 'px';
    this.el.style.height = this._h + 'px';
    // NIENTE hint desynchronized: su Chrome Android il canvas low-latency
    // non supporta la trasparenza e diventa una superficie NERA opaca che
    // copre l'intero workspace (visto dal campo). Il set di width azzera lo
    // stato: la transform DPR va rimessa qui.
    if (!this.ctx) {
      this.ctx = this.el.getContext('2d');
    }
    if (this.ctx) this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    this._dx1 = -1; this._dy1 = -1;
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  _pushRaw(x, y, p, t) {
    const j = this._rn % RING;
    this._rx[j] = x; this._ry[j] = y; this._rp[j] = p; this._rt[j] = t;
    this._rn++;
  }
}
