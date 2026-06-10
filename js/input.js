// INPUT — passivo. Gli handler scrivono nel ring buffer preallocato ed escono.
// Tutta la logica (stroke, gesture pan/zoom) gira nel frame loop via drain().

const EV_DOWN = 1, EV_MOVE = 2, EV_UP = 3, EV_CANCEL = 4;
const PT_MOUSE = 0, PT_PEN = 1, PT_TOUCH = 2;
const FIELDS = 8; // type, id, x, y, pressure, ptrType, buttons, time
const CAP = 8192;

/** @typedef {import('./camera.js').Camera} Camera */

/**
 * t: timeStamp dell'evento (orologio di performance.now()) — serve alla
 * dinamica velocità/taper dello stroke engine.
 * @typedef {Object} InputHooks
 * @property {() => boolean} isPanTool
 * @property {(x: number, y: number, p: number, t: number) => void} onStrokeStart
 * @property {(x: number, y: number, p: number, t: number) => void} onStrokePoint
 * @property {(x: number, y: number, p: number, t: number) => void} onStrokeEnd
 * @property {() => void} onStrokeCancel
 */

export class InputManager {
  // hooks: onStrokeStart(x,y,p), onStrokePoint, onStrokeEnd(x,y,p), onStrokeCancel()
  // isPanTool() -> bool, camera
  // Il bersaglio è il CONTAINER dei piani (i piani figli sono pointer-events:
  // none): sopravvive alla sostituzione del canvas WebGL (toggle desync).
  /** @param {HTMLElement} canvas @param {Camera} camera @param {InputHooks} hooks */
  constructor(canvas, camera, hooks) {
    this.canvas = canvas;
    this.camera = camera;
    this.hooks = hooks;

    // Float64: i timeStamp (ms dall'avvio pagina) in f32 perdono precisione
    // sub-ms dopo ~4 ore di sessione, e la velocità ne ha bisogno.
    this.ring = new Float64Array(CAP * FIELDS);
    this.head = 0;
    this.tail = 0;

    this.eventsPerSec = 0;
    this._evCount = 0;
    this._evWindowStart = performance.now();

    // stato della macchina (solo nel drain, mai negli handler)
    this.drawingId = -1;
    this.drawingIsTouch = false;
    this.strokeStartT = 0;
    this.strokeDist = 0;
    this.panningId = -1;
    this._panLast = { x: 0, y: 0 };
    /** @type {Map<number, {x: number, y: number}>} */
    this.touches = new Map();        // id -> {x, y}
    this.gesture = false;
    this._gestA = -1; this._gestB = -1;
    this._gPrev = { ax: 0, ay: 0, bx: 0, by: 0 };
    this.spaceHeld = false;

    // wheel accumulato, applicato nel frame loop
    this._wheelDelta = 0;
    this._wheelX = 0; this._wheelY = 0;

    this.hover = { x: -100, y: -100, visible: false, touch: false };

    // Ultimo punto del tratto in corso (schermo), per chiusura da gesture
    this._lastPoint = { x: 0, y: 0, p: 0, t: 0 };

    // Pointer in contatto (down ricevuto, up/cancel non ancora).
    // Su mobile NON ci si può fidare di e.buttons: Safari iOS riporta
    // buttons=0 nei pointermove di tocchi e pencil attivi.
    /** @type {Set<number>} */
    this._contact = new Set();

    this._tmpW = { x: 0, y: 0 };
    this._bind();
  }

  /**
   * @param {number} type @param {number} id @param {number} x @param {number} y
   * @param {number} p @param {number} pt @param {number} buttons @param {number} t
   */
  _push(type, id, x, y, p, pt, buttons, t) {
    const next = (this.tail + 1) % CAP;
    if (next === this.head) return; // pieno: scarta il più vecchio implicito
    const o = this.tail * FIELDS, r = this.ring;
    r[o] = type; r[o + 1] = id; r[o + 2] = x; r[o + 3] = y;
    r[o + 4] = p; r[o + 5] = pt; r[o + 6] = buttons; r[o + 7] = t;
    this.tail = next;
    this._evCount++;
  }

  // Il bersaglio viene sostituito: si riallacciano i listener e si chiude
  // pulito lo stato attivo (un tratto in corso viene cancellato via EV_CANCEL).
  /** @param {HTMLElement} canvas */
  rebind(canvas) {
    this.canvas = canvas;
    if (this.drawingId !== -1) this._push(EV_CANCEL, this.drawingId, 0, 0, 0, 0, 0, performance.now());
    this.panningId = -1;
    this.gesture = false;
    this._gestA = -1; this._gestB = -1;
    this.touches.clear();
    this._contact.clear();
    this._bindCanvas();
  }

  _bind() {
    this._bindCanvas();

    // Listener a livello window: agganciati una volta sola, sopravvivono
    // alla sostituzione del canvas (rebind).
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      window.addEventListener(ev, (e) => e.preventDefault());
    }
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) this.spaceHeld = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
    window.addEventListener('blur', () => { this.spaceHeld = false; });
  }

  _bindCanvas() {
    const c = this.canvas;
    /** @type {(e: PointerEvent) => number} */
    const ptType = (e) => e.pointerType === 'pen' ? PT_PEN : e.pointerType === 'touch' ? PT_TOUCH : PT_MOUSE;
    // Solo la penna ha pressione vera (la rampa al pen-down/lift-off fa le
    // punte da sola); il tocco riporta uno 0.5 fisso senza informazione e il
    // mouse 0.5/1: per entrambi 1 = fattore pressione neutro, ci pensa la
    // dinamica velocità.
    /** @type {(e: PointerEvent, pt: number) => number} */
    const press = (e, pt) => pt === PT_PEN ? (e.pressure > 0 ? e.pressure : 0.5) : 1;
    // alcuni browser danno timeStamp 0 sui coalesced: fallback all'evento padre
    /** @type {(e: PointerEvent, fb: number) => number} */
    const time = (e, fb) => e.timeStamp > 0 ? e.timeStamp : fb;

    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* eventi sintetici o pointer già rilasciato */ }
      const pt = ptType(e);
      this._contact.add(e.pointerId);
      this._push(EV_DOWN, e.pointerId, e.clientX, e.clientY, press(e, pt), pt, e.buttons, time(e, performance.now()));
      e.preventDefault();
    });

    c.addEventListener('pointermove', (e) => {
      const pt = ptType(e);
      if (!this._contact.has(e.pointerId)) {
        // solo hover: aggiorna il cursore, niente ring
        this.hover.x = e.clientX; this.hover.y = e.clientY;
        this.hover.visible = pt !== PT_TOUCH;
        return;
      }
      this.hover.x = e.clientX; this.hover.y = e.clientY;
      // coalesced: nessun campione perso da una penna a 240 Hz
      const co = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (co && co.length > 0) {
        const tFb = time(e, performance.now());
        for (let i = 0; i < co.length; i++) {
          const ce = co[i];
          this._push(EV_MOVE, e.pointerId, ce.clientX, ce.clientY, press(ce, pt), pt, e.buttons, time(ce, tFb));
        }
      } else {
        this._push(EV_MOVE, e.pointerId, e.clientX, e.clientY, press(e, pt), pt, e.buttons, time(e, performance.now()));
      }
      e.preventDefault();
    });

    /** @param {PointerEvent} e */
    const up = (e) => {
      const pt = ptType(e);
      this._contact.delete(e.pointerId);
      this._push(EV_UP, e.pointerId, e.clientX, e.clientY, press(e, pt), pt, 0, time(e, performance.now()));
      e.preventDefault();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => {
      this._contact.delete(e.pointerId);
      this._push(EV_CANCEL, e.pointerId, e.clientX, e.clientY, 0, ptType(e), 0, time(e, performance.now()));
    });
    // capture persa senza up (rarissimo, browser mobile): tratta come cancel
    c.addEventListener('lostpointercapture', (e) => {
      if (this._contact.has(e.pointerId)) {
        this._contact.delete(e.pointerId);
        this._push(EV_CANCEL, e.pointerId, e.clientX, e.clientY, 0, ptType(e), 0, time(e, performance.now()));
      }
    });
    c.addEventListener('pointerleave', () => { this.hover.visible = false; });

    // Cinture di sicurezza mobile: blocca pinch/double-tap zoom della PAGINA
    // (Safari iOS ignora user-scalable=no; preventDefault sui touch event
    // non interferisce con i pointer event, che restano la fonte di verità).
    c.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    c.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._wheelDelta += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this._wheelX = e.clientX;
      this._wheelY = e.clientY;
    }, { passive: false });

    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Drenato una volta per frame dal frame loop.
  drain() {
    const cam = this.camera, H = this.hooks, r = this.ring, w = this._tmpW;

    // zoom da rotella
    if (this._wheelDelta !== 0) {
      const f = Math.pow(1.0015, -this._wheelDelta);
      cam.zoomAt(this._wheelX, this._wheelY, f);
      this._wheelDelta = 0;
    }

    while (this.head !== this.tail) {
      const o = this.head * FIELDS;
      this.head = (this.head + 1) % CAP;
      const type = r[o], id = r[o + 1], x = r[o + 2], y = r[o + 3];
      const p = r[o + 4], pt = r[o + 5], buttons = r[o + 6], t = r[o + 7];

      if (type === EV_DOWN) this._onDown(id, x, y, p, pt, buttons, t);
      else if (type === EV_MOVE) this._onMove(id, x, y, p, pt, t);
      else this._onUp(id, x, y, p, pt, type === EV_CANCEL, t);
    }

    // contatore eventi/s per HUD
    const now = performance.now();
    if (now - this._evWindowStart >= 1000) {
      this.eventsPerSec = this._evCount * 1000 / (now - this._evWindowStart);
      this._evCount = 0;
      this._evWindowStart = now;
    }
  }

  /**
   * @param {number} id @param {number} x @param {number} y @param {number} p
   * @param {number} pt @param {number} buttons @param {number} t
   */
  _onDown(id, x, y, p, pt, buttons, t) {
    const H = this.hooks, cam = this.camera;

    if (pt === PT_TOUCH) {
      this.touches.set(id, { x, y });

      if (this.touches.size === 2) {
        // secondo dito: se lo stroke è appena iniziato lo si annulla -> gesture
        if (this.drawingId !== -1 && this.drawingIsTouch) {
          const young = performance.now() - this.strokeStartT < 300 && this.strokeDist < 24;
          if (young) H.onStrokeCancel();
          else {
            const e = this._lastPoint;
            cam.screenToWorld(e.x, e.y, this._tmpW);
            H.onStrokeEnd(this._tmpW.x, this._tmpW.y, e.p, e.t);
          }
          this.drawingId = -1;
        }
        if (this.panningId !== -1) this.panningId = -1;
        this._startGesture();
        return;
      }
      if (this.touches.size > 2) return; // dita extra ignorate
    }

    if (this.gesture) return;

    const wantPan = H.isPanTool() || this.spaceHeld ||
      (pt === PT_MOUSE && (buttons & 4) !== 0) ||  // tasto centrale
      (pt === PT_MOUSE && (buttons & 2) !== 0);    // tasto destro
    if (wantPan) {
      this.panningId = id;
      this._panLast.x = x; this._panLast.y = y;
      return;
    }

    if (this.drawingId !== -1) return; // già si disegna con un altro pointer

    this.drawingId = id;
    this.drawingIsTouch = pt === PT_TOUCH;
    this.strokeStartT = performance.now();
    this.strokeDist = 0;
    this._lastPoint = { x, y, p, t };
    cam.screenToWorld(x, y, this._tmpW);
    H.onStrokeStart(this._tmpW.x, this._tmpW.y, p, t);
  }

  /** @param {number} id @param {number} x @param {number} y @param {number} p @param {number} pt @param {number} t */
  _onMove(id, x, y, p, pt, t) {
    const H = this.hooks, cam = this.camera;

    if (pt === PT_TOUCH && this.touches.has(id)) {
      const t = this.touches.get(id);
      if (this.gesture && (id === this._gestA || id === this._gestB)) {
        t.x = x; t.y = y;
        this._applyGesture();
        return;
      }
      t.x = x; t.y = y;
    }

    if (id === this.panningId) {
      cam.panBy(x - this._panLast.x, y - this._panLast.y);
      this._panLast.x = x; this._panLast.y = y;
      return;
    }

    if (id === this.drawingId) {
      const lp = this._lastPoint;
      this.strokeDist += Math.hypot(x - lp.x, y - lp.y);
      lp.x = x; lp.y = y; lp.p = p; lp.t = t;
      cam.screenToWorld(x, y, this._tmpW);
      H.onStrokePoint(this._tmpW.x, this._tmpW.y, p, t);
    }
  }

  /**
   * @param {number} id @param {number} x @param {number} y @param {number} p
   * @param {number} pt @param {boolean} cancelled @param {number} t
   */
  _onUp(id, x, y, p, pt, cancelled, t) {
    const H = this.hooks, cam = this.camera;

    if (pt === PT_TOUCH) {
      this.touches.delete(id);
      if (this.gesture && (id === this._gestA || id === this._gestB)) {
        // gesture finita (o continua con un dito rimasto -> pan singolo)
        this.gesture = false;
        this._gestA = -1; this._gestB = -1;
        if (this.touches.size === 1) {
          const [restId] = this.touches.keys();
          const rest = this.touches.get(restId);
          this.panningId = restId;
          this._panLast.x = rest.x; this._panLast.y = rest.y;
        }
        return;
      }
    }

    if (id === this.panningId) { this.panningId = -1; return; }

    if (id === this.drawingId) {
      this.drawingId = -1;
      if (cancelled) H.onStrokeCancel();
      else {
        cam.screenToWorld(x, y, this._tmpW);
        H.onStrokeEnd(this._tmpW.x, this._tmpW.y, p, t);
      }
    }
  }

  _startGesture() {
    const ids = [...this.touches.keys()];
    this._gestA = ids[0]; this._gestB = ids[1];
    const a = this.touches.get(this._gestA), b = this.touches.get(this._gestB);
    this._gPrev.ax = a.x; this._gPrev.ay = a.y;
    this._gPrev.bx = b.x; this._gPrev.by = b.y;
    this.gesture = true;
  }

  _applyGesture() {
    const cam = this.camera, g = this._gPrev;
    const a = this.touches.get(this._gestA), b = this.touches.get(this._gestB);
    if (!a || !b) return;

    const pcx = (g.ax + g.bx) * 0.5, pcy = (g.ay + g.by) * 0.5;
    const ccx = (a.x + b.x) * 0.5, ccy = (a.y + b.y) * 0.5;
    const pd = Math.hypot(g.bx - g.ax, g.by - g.ay) || 1;
    const cd = Math.hypot(b.x - a.x, b.y - a.y) || 1;

    cam.panBy(ccx - pcx, ccy - pcy);
    cam.zoomAt(ccx, ccy, cd / pd);

    g.ax = a.x; g.ay = a.y; g.bx = b.x; g.by = b.y;
  }

  get isDrawing() { return this.drawingId !== -1; }
}
