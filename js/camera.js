// Vista: pan/zoom come pura matrice. Nessun pixel viene toccato quando cambia.
import { clamp } from './util.js';

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 64;

export class Camera {
  constructor() {
    this.x = 0;          // coordinata mondo al centro dello schermo
    this.y = 0;
    this.zoom = 1;       // px CSS per px documento
    this.w = 1;          // viewport in px CSS
    this.h = 1;
    this.ox = 0;         // origine CSS del viewport di lavoro nella pagina
    this.oy = 0;
    this.dpr = 1;
    this._mat = new Float32Array(9);
    this.changed = true; // per sapere se ridisegnare
  }

  /** @param {number} w @param {number} h @param {number} dpr @param {number} [ox] @param {number} [oy] */
  resize(w, h, dpr, ox = 0, oy = 0) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.ox = ox; this.oy = oy;
    this.changed = true;
  }

  /**
   * @param {number} sx @param {number} sy
   * @param {{x: number, y: number}} out
   */
  screenToWorld(sx, sy, out) {
    const lx = sx - this.ox;
    const ly = sy - this.oy;
    out.x = (lx - this.w * 0.5) / this.zoom + this.x;
    out.y = (ly - this.h * 0.5) / this.zoom + this.y;
    return out;
  }

  /**
   * @param {number} wx @param {number} wy
   * @param {{x: number, y: number}} out
   */
  worldToScreen(wx, wy, out) {
    out.x = (wx - this.x) * this.zoom + this.w * 0.5 + this.ox;
    out.y = (wy - this.y) * this.zoom + this.h * 0.5 + this.oy;
    return out;
  }

  /** @param {number} dxScreen @param {number} dyScreen */
  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.changed = true;
  }

  // Zoom mantenendo fisso il punto schermo (sx, sy)
  /** @param {number} sx @param {number} sy @param {number} factor */
  zoomAt(sx, sy, factor) {
    const z = clamp(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (z === this.zoom) return;
    const lx = sx - this.ox;
    const ly = sy - this.oy;
    const wx = (lx - this.w * 0.5) / this.zoom + this.x;
    const wy = (ly - this.h * 0.5) / this.zoom + this.y;
    this.zoom = z;
    this.x = wx - (lx - this.w * 0.5) / z;
    this.y = wy - (ly - this.h * 0.5) / z;
    this.changed = true;
  }

  reset() {
    this.x = 0; this.y = 0; this.zoom = 1;
    this.changed = true;
  }

  // Matrice mondo -> clip space (column-major 3x3 per WebGL)
  matrix() {
    const m = this._mat;
    const sx = 2 * this.zoom / this.w;
    const sy = -2 * this.zoom / this.h;
    m[0] = sx; m[1] = 0; m[2] = 0;
    m[3] = 0; m[4] = sy; m[5] = 0;
    m[6] = -this.x * sx; m[7] = -this.y * sy; m[8] = 1;
    return m;
  }

  // Rettangolo mondo visibile {x0,y0,x1,y1}
  /** @param {{x0: number, y0: number, x1: number, y1: number}} out */
  visibleRect(out) {
    const hw = this.w * 0.5 / this.zoom;
    const hh = this.h * 0.5 / this.zoom;
    out.x0 = this.x - hw; out.y0 = this.y - hh;
    out.x1 = this.x + hw; out.y1 = this.y + hh;
    return out;
  }
}
