// Preview del pennello (Brush Studio): un tratto a S con tempi sintetici da
// pennellata decisa (velocità costante e alta) così la dinamica delle punte
// mostra i coni ai due estremi. Renderizzato con la STESSA pipeline del
// canvas (StrokeEngine -> Rasterizer JS) su un mini ChunkStore dedicato.
// Seed fisso: trascinare uno slider non fa "ballare" scatter e jitter tra un
// re-render e l'altro.
//
// La dimensione del tratto è quella vera finché entra in altezza; oltre,
// scala: tutti i parametri del pennello sono relativi al diametro, quindi
// l'aspetto (spacing, scatter, jitter) resta fedele.

import { brush, StampCache } from './brush.js';
import { ChunkStore, CHUNK, CHUNK_SHIFT } from './store.js';
import { DabQueue, StrokeEngine } from './stroke.js';
import { Rasterizer } from './raster.js';

const SEED = 0x51ed270b;
const POINTS = 56; // campioni lungo la curva (più il catch-up dello smoother)

export class BrushPreview {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    this.store = new ChunkStore('preview', null); // heap null: path JS puro
    this.sampleStore = new ChunkStore('preview-sample', null);
    this.cache = new StampCache(48, null);
    this.queue = new DabQueue(1 << 12);
    this.engine = new StrokeEngine(this.queue);
    this.raster = new Rasterizer(this.store, this.cache, null);
    this._raf = 0;
    this._tmp = document.createElement('canvas');
    this._tctx = /** @type {CanvasRenderingContext2D} */ (this._tmp.getContext('2d'));
    /** @type {CanvasPattern|null} */
    this._checker = null;
    this._checkerDpr = 0;
  }

  // Debounce a rAF: gli slider sparano `input` a raffica.
  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  // cfg: di default il pennello vivo; il popup dei preset passa la ricetta
  // del preset per disegnare la sua anteprima senza toccare il pennello.
  /** @param {import('./brush.js').Brush} [cfg] */
  render(cfg = brush) {
    const cssW = this.canvas.clientWidth, cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return; // studio non ancora in layout
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;

    // --- 1. tratto di prova nella pipeline reale -------------------------
    const sizePx = Math.min(cfg.size * dpr, H * 0.66);
    const pad = 4 * dpr + sizePx * 0.5;
    const x0 = pad, x1 = Math.max(x0 + 1, W - pad);
    const cy = H * 0.5;
    const amp = Math.max(0, (H - sizePx) * 0.5 - 5 * dpr);

    /** @type {(t: number) => number} */
    const px = (t) => x0 + (x1 - x0) * t;
    // S-curve con inviluppo sin(πt): pendenza nulla agli estremi, così la
    // punta esce dritta e non "a gancio".
    /** @type {(t: number) => number} */
    const py = (t) => cy - amp * Math.sin(t * Math.PI * 2) * Math.sin(t * Math.PI) * 1.15;

    // Tempi sintetici deterministici a velocità costante e ALTA (sopra la
    // soglia di punta piena): la dinamica disegna i coni ai due estremi,
    // lunghi fino ai tetti — la forma del tratto di una pennellata decisa.
    // I rapporti impostati (spessore iniziale/finale) restano visibili tali
    // e quali: a questa velocità il pavimento del moncone è zero.
    const times = new Float64Array(POINTS + 1);
    {
      const V = 2.2; // px/ms
      let len = 0;
      for (let i = 1; i <= POINTS; i++) {
        len += Math.hypot(px(i / POINTS) - px((i - 1) / POINTS), py(i / POINTS) - py((i - 1) / POINTS));
        times[i] = len / V;
      }
    }

    this.queue.clear();
    const sampleStore = cfg.aquaEnabled ? this._prepareAquaSample(W, H) : null;
    const engine = this.engine;
    engine.begin(px(0), py(0), 1, 0, { ...cfg, size: sizePx, tool: 'brush' }, SEED, 1);
    this.raster.beginStroke(engine.snap, null, null, sampleStore);
    for (let i = 1; i <= POINTS; i++) {
      engine.move(px(i / POINTS), py(i / POINTS), 1, times[i]);
    }
    engine.end(x1, py(1), 1, times[POINTS]);
    if (engine.endPassNeeded) {
      // pass finale come nell'app: si scarta il live e si ridisegna col cono
      this.queue.clear();
      this.store.releaseAll(() => { /* store CPU-only */ });
      this.raster.beginStroke(engine.snap, null, null, sampleStore);
      engine.replay();
    }
    this.raster.run(this.queue, Infinity);

    // --- 2. composito chunk -> ImageData (unpremultiply) -----------------
    const img = this._tctx.createImageData(W, H);
    this._copyStoreToImage(this.store, img, W, H);
    if (this._tmp.width !== W) this._tmp.width = W;
    if (this._tmp.height !== H) this._tmp.height = H;

    // --- 3. presentazione: scacchiera + tratto con opacità globale -------
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = this._checkerPattern(dpr);
    ctx.fillRect(0, 0, W, H);
    if (sampleStore) {
      const bg = this._tctx.createImageData(W, H);
      this._copyStoreToImage(sampleStore, bg, W, H);
      this._tctx.clearRect(0, 0, W, H);
      this._tctx.putImageData(bg, 0, 0);
      ctx.drawImage(this._tmp, 0, 0);
    }
    this._tctx.clearRect(0, 0, W, H);
    this._tctx.putImageData(img, 0, 0);
    // wash: lo slider opacità agisce sul composito (come liveOpacity nel renderer)
    ctx.globalAlpha = engine.snap ? engine.snap.globalOpacity : 1;
    ctx.drawImage(this._tmp, 0, 0);
    ctx.globalAlpha = 1;

    this.store.releaseAll(() => { /* nessuna texture: store CPU-only */ });
    this.sampleStore.releaseAll(() => { /* preview sample CPU-only */ });
  }

  /** @param {number} W @param {number} H */
  _prepareAquaSample(W, H) {
    this.sampleStore.releaseAll(() => { /* preview sample CPU-only */ });
    const store = this.sampleStore;
    const cx1 = (W - 1) >> CHUNK_SHIFT;
    const cy1 = (H - 1) >> CHUNK_SHIFT;
    for (let cy = 0; cy <= cy1; cy++) {
      for (let cx = 0; cx <= cx1; cx++) {
        const chunk = store.getOrCreate(cx, cy);
        const data = chunk.data;
        const ox = cx * CHUNK, oy = cy * CHUNK;
        const xMax = Math.min(CHUNK, W - ox);
        const yMax = Math.min(CHUNK, H - oy);
        for (let y = 0; y < yMax; y++) {
          let o = (y << CHUNK_SHIFT) << 2;
          const wy = oy + y;
          for (let x = 0; x < xMax; x++, o += 4) {
            const wx = ox + x;
            const t = W > 1 ? wx / (W - 1) : 0;
            const band = Math.sin(wx * 0.035 + wy * 0.09) * 12;
            let r = 246, g = 246, b = 242;
            if (t < 0.38) {
              r = 72 + band; g = 144 + band; b = 220;
            } else if (t < 0.68) {
              r = 235 + band; g = 128 + band * 0.4; b = 96;
            } else {
              r = 78 + band * 0.4; g = 190 + band; b = 150 + band;
            }
            data[o] = Math.max(0, Math.min(255, Math.round(r)));
            data[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
            data[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
            data[o + 3] = 255;
          }
        }
        chunk.touched = true;
      }
    }
    return store;
  }

  /**
   * @param {ChunkStore} store @param {ImageData} img @param {number} W @param {number} H
   */
  _copyStoreToImage(store, img, W, H) {
    const d = img.data;
    for (const c of store.map.values()) {
      const ox = c.cx * CHUNK, oy = c.cy * CHUNK;
      const lx0 = Math.max(0, -ox), ly0 = Math.max(0, -oy);
      const lx1 = Math.min(CHUNK, W - ox), ly1 = Math.min(CHUNK, H - oy);
      if (lx1 <= lx0 || ly1 <= ly0) continue;
      const s = c.data;
      for (let y = ly0; y < ly1; y++) {
        let si = ((y << CHUNK_SHIFT) + lx0) << 2;
        let di = ((oy + y) * W + (ox + lx0)) << 2;
        for (let x = lx0; x < lx1; x++, si += 4, di += 4) {
          const a = s[si + 3];
          if (a === 0) continue;
          d[di] = Math.min(255, Math.round(s[si] * 255 / a));
          d[di + 1] = Math.min(255, Math.round(s[si + 1] * 255 / a));
          d[di + 2] = Math.min(255, Math.round(s[si + 2] * 255 / a));
          d[di + 3] = a;
        }
      }
    }
  }

  // Scacchiera "trasparenza" chiara, in cache per dpr.
  /** @param {number} dpr */
  _checkerPattern(dpr) {
    if (this._checker && this._checkerDpr === dpr) return this._checker;
    const sq = Math.round(7 * dpr);
    const c = document.createElement('canvas');
    c.width = sq * 2; c.height = sq * 2;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, sq * 2, sq * 2);
    x.fillStyle = '#e2e3e9';
    x.fillRect(sq, 0, sq, sq);
    x.fillRect(0, sq, sq, sq);
    this._checker = this.ctx.createPattern(c, 'repeat');
    this._checkerDpr = dpr;
    return this._checker;
  }
}
