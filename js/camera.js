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
    this.dpr = 1;
    this._mat = new Float32Array(9);
    this.changed = true; // per sapere se ridisegnare
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.changed = true;
  }

  screenToWorld(sx, sy, out) {
    out.x = (sx - this.w * 0.5) / this.zoom + this.x;
    out.y = (sy - this.h * 0.5) / this.zoom + this.y;
    return out;
  }

  worldToScreen(wx, wy, out) {
    out.x = (wx - this.x) * this.zoom + this.w * 0.5;
    out.y = (wy - this.y) * this.zoom + this.h * 0.5;
    return out;
  }

  panBy(dxScreen, dyScreen) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.changed = true;
  }

  // Zoom mantenendo fisso il punto schermo (sx, sy)
  zoomAt(sx, sy, factor) {
    const z = clamp(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (z === this.zoom) return;
    const wx = (sx - this.w * 0.5) / this.zoom + this.x;
    const wy = (sy - this.h * 0.5) / this.zoom + this.y;
    this.zoom = z;
    this.x = wx - (sx - this.w * 0.5) / z;
    this.y = wy - (sy - this.h * 0.5) / z;
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
  visibleRect(out) {
    const hw = this.w * 0.5 / this.zoom;
    const hh = this.h * 0.5 / this.zoom;
    out.x0 = this.x - hw; out.y0 = this.y - hh;
    out.x1 = this.x + hw; out.y1 = this.y + hh;
    return out;
  }
}
