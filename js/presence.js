// PRESENZA COLLABORATIVA — overlay DOM fuori da #planes (come #mirror-guide:
// la rebuild dei piani rimpiazza i figli). Due strati, entrambi inerti
// all'input: un canvas per le SCIE dei tratti remoti in corso (anteprima
// "quasi live": polilinea col colore/spessore del pennello, sostituita dal
// tratto esatto quando la pipeline lo committa) e un div per i CURSORI degli
// altri utenti (freccia + nome nel colore assegnato, posizione lerpata).
// Le coordinate viaggiano in px documento: la proiezione a schermo avviene
// qui a ogni frame con la camera, quindi pan/zoom locali non sfasano nulla.

/** @typedef {import('./camera.js').Camera} Camera */

const CURSOR_STALE_MS = 6000;  // senza aggiornamenti il cursore sparisce
const TRAIL_MAX_PTS = 8192;    // oltre, si scarta la metà più vecchia

export class CollabPresence {
  constructor() {
    const root = document.createElement('div');
    root.id = 'collab-overlay';
    root.setAttribute('aria-hidden', 'true');
    this.root = root;

    this.canvas = document.createElement('canvas');
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.cursorLayer = document.createElement('div');
    root.appendChild(this.cursorLayer);

    document.body.appendChild(root);

    /** @type {Map<number, {el: HTMLElement, name: HTMLElement, color: string, x: number, y: number, tx: number, ty: number, lastT: number, drawing: boolean, shown: boolean}>} */
    this.cursors = new Map();
    /** @type {Map<number, {sid: number, color: string, size: number, eraser: boolean, opacity: number, pts: Float32Array, n: number}>} */
    this.trails = new Map();
    this._trailsDirty = false;
    this._camKey = '';

    this._w = 0; this._h = 0; this._dpr = 1;
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
  }

  _resize() {
    this._w = window.innerWidth; this._h = window.innerHeight;
    this._dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(this._w * this._dpr));
    this.canvas.height = Math.max(1, Math.round(this._h * this._dpr));
    this.canvas.style.width = this._w + 'px';
    this.canvas.style.height = this._h + 'px';
    this._trailsDirty = true;
  }

  // ---- cursori ----

  /** @param {number} uid @param {string} name @param {string} color */
  ensureUser(uid, name, color) {
    let c = this.cursors.get(uid);
    if (!c) {
      const el = document.createElement('div');
      el.className = 'collab-cursor';
      el.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22">' +
        '<path d="M5 2.5 19.2 11l-6.2 1.4L9.5 18z" fill="currentColor" ' +
        'stroke="rgba(0,0,0,0.55)" stroke-width="1.2"/></svg>' +
        '<span class="cc-name"></span>';
      el.hidden = true;
      this.cursorLayer.appendChild(el);
      c = {
        el, name: /** @type {HTMLElement} */ (el.querySelector('.cc-name')),
        color, x: 0, y: 0, tx: 0, ty: 0, lastT: 0, drawing: false, shown: false,
      };
      this.cursors.set(uid, c);
    }
    c.color = color;
    c.el.style.setProperty('--cc', color);
    c.name.textContent = name;
    return c;
  }

  /** @param {number} uid @param {number} wx @param {number} wy @param {boolean} drawing */
  cursor(uid, wx, wy, drawing) {
    const c = this.cursors.get(uid);
    if (!c) return;
    if (!c.shown && c.lastT === 0) { c.x = wx; c.y = wy; } // primo update: niente volo
    c.tx = wx; c.ty = wy;
    c.drawing = drawing;
    c.lastT = performance.now();
  }

  /** @param {number} uid */
  remove(uid) {
    const c = this.cursors.get(uid);
    if (c) { c.el.remove(); this.cursors.delete(uid); }
    if (this.trails.delete(uid)) this._trailsDirty = true;
  }

  clear() {
    for (const c of this.cursors.values()) c.el.remove();
    this.cursors.clear();
    this.trails.clear();
    this._trailsDirty = true;
  }

  // ---- scie ----

  /**
   * @param {number} uid @param {number} sid
   * @param {{color: string, size: number, eraser: boolean, opacity: number}} meta
   * @param {number} x @param {number} y
   */
  trailBegin(uid, sid, meta, x, y) {
    const t = {
      sid, color: meta.color, size: meta.size, eraser: meta.eraser,
      opacity: meta.opacity, pts: new Float32Array(256), n: 0,
    };
    t.pts[0] = x; t.pts[1] = y; t.n = 1;
    this.trails.set(uid, t);
    this._trailsDirty = true;
  }

  /** @param {number} uid @param {number} x @param {number} y */
  trailPoint(uid, x, y) {
    const t = this.trails.get(uid);
    if (!t) return;
    if (t.n * 2 === t.pts.length) {
      if (t.n >= TRAIL_MAX_PTS) {
        // scarta la metà più vecchia: la scia è solo un'anteprima
        t.pts.copyWithin(0, t.n); // t.n float = metà delle coppie
        t.n = t.n >> 1;
      } else {
        const nb = new Float32Array(t.pts.length * 2);
        nb.set(t.pts);
        t.pts = nb;
      }
    }
    t.pts[t.n * 2] = x; t.pts[t.n * 2 + 1] = y; t.n++;
    this._trailsDirty = true;
  }

  // Fine scia: solo se sid corrisponde (un nuovo tratto può essere già partito).
  /** @param {number} uid @param {number} sid */
  trailEnd(uid, sid) {
    const t = this.trails.get(uid);
    if (t && t.sid === sid) {
      this.trails.delete(uid);
      this._trailsDirty = true;
    }
  }

  // ---- frame ----

  /** @param {Camera} cam */
  frame(cam) {
    const now = performance.now();

    // cursori: lerp verso il bersaglio, proiezione a schermo, stale -> nascosto
    for (const c of this.cursors.values()) {
      const stale = c.lastT === 0 || now - c.lastT > CURSOR_STALE_MS;
      if (stale) {
        if (c.shown) { c.el.hidden = true; c.shown = false; }
        continue;
      }
      c.x += (c.tx - c.x) * 0.4;
      c.y += (c.ty - c.y) * 0.4;
      const sx = (c.x - cam.x) * cam.zoom + cam.w * 0.5 + cam.ox;
      const sy = (c.y - cam.y) * cam.zoom + cam.h * 0.5 + cam.oy;
      const off = sx < cam.ox - 40 || sy < cam.oy - 40 ||
        sx > cam.ox + cam.w + 40 || sy > cam.oy + cam.h + 40;
      if (off) {
        if (c.shown) { c.el.hidden = true; c.shown = false; }
        continue;
      }
      c.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
      c.el.classList.toggle('drawing', c.drawing);
      if (!c.shown) { c.el.hidden = false; c.shown = true; }
    }

    // scie: ridisegno solo se sono cambiate o se la camera si è mossa
    const camKey = this.trails.size > 0
      ? `${cam.x}|${cam.y}|${cam.zoom}|${cam.w}|${cam.h}|${cam.ox}|${cam.oy}` : '';
    if (!this._trailsDirty && camKey === this._camKey) return;
    this._camKey = camKey;
    this._trailsDirty = false;

    const ctx = this.ctx;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, this._w, this._h);
    if (this.trails.size === 0) return;

    const z = cam.zoom, hw = cam.w * 0.5 + cam.ox, hh = cam.h * 0.5 + cam.oy;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const t of this.trails.values()) {
      const p = t.pts, n = t.n;
      if (n < 1) continue;
      ctx.beginPath();
      ctx.moveTo((p[0] - cam.x) * z + hw, (p[1] - cam.y) * z + hh);
      for (let i = 1; i < n; i++) {
        ctx.lineTo((p[i * 2] - cam.x) * z + hw, (p[i * 2 + 1] - cam.y) * z + hh);
      }
      ctx.lineWidth = Math.max(1, t.size * z);
      if (t.eraser) {
        ctx.strokeStyle = 'rgba(154, 160, 171, 0.75)';
        ctx.setLineDash([10, 7]);
      } else {
        ctx.strokeStyle = t.color;
        ctx.globalAlpha = Math.max(0.25, Math.min(1, t.opacity)) * 0.9;
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      // puntino sull'ultima posizione: la "penna" dell'altro utente
      const lx = (p[(n - 1) * 2] - cam.x) * z + hw;
      const ly = (p[(n - 1) * 2 + 1] - cam.y) * z + hh;
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(2.5, t.size * z * 0.5 + 1.5), 0, Math.PI * 2);
      ctx.strokeStyle = t.eraser ? 'rgba(154,160,171,0.9)' : t.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this.root.remove();
  }
}
