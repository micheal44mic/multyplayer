// Console prestazioni: collassabile, aggiornata senza allocazioni per frame.
// Testo a 4 Hz, sparkline dei frame time a ogni frame.

const HISTORY = 120;

/**
 * Statistiche per frame, oggetto riusato dal main loop (zero allocazioni).
 * @typedef {Object} Stats
 * @property {number} frameMs
 * @property {number} frameMaxMs
 * @property {{input: number, sample: number, raster: number, upload: number, draw: number}} timings
 * @property {number} budgetPx
 * @property {number} rasterPx
 * @property {number} queueDepth
 * @property {number} dabsFrame
 * @property {number} eventsPerSec
 * @property {number} docChunks
 * @property {number} strokeChunks
 * @property {number} cpuBytes
 * @property {number} gpuBytes
 * @property {number} undoCount
 * @property {number} undoBytes
 * @property {number} stampCache
 * @property {number} stampGen
 * @property {number} zoom
 * @property {number} dpr
 * @property {string} renderer
 * @property {boolean} contextLost
 */

export class Hud {
  constructor() {
    this.el = document.getElementById('hud');
    this.fpsEl = document.getElementById('hud-fps');
    this.textEl = document.getElementById('hud-text');
    this.graph = /** @type {HTMLCanvasElement} */ (document.getElementById('hud-graph'));
    this.gctx = /** @type {CanvasRenderingContext2D} */ (this.graph.getContext('2d'));

    this.frameTimes = new Float32Array(HISTORY);
    this.fi = 0;
    this._lastText = 0;
    this._fpsAcc = 0;
    this._fpsN = 0;
    this._fps = 0;

    const toggle = () => this.el.classList.toggle('collapsed');
    document.getElementById('hud-head').addEventListener('click', toggle);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.graph.width = 280 * dpr;
    this.graph.height = 48 * dpr;
    this.gctx.scale(dpr, dpr);
  }

  toggle() { this.el.classList.toggle('collapsed'); }

  // stats: oggetto riusato dal main loop
  /** @param {Stats} stats */
  update(stats) {
    const ft = stats.frameMs;
    this.frameTimes[this.fi] = ft;
    this.fi = (this.fi + 1) % HISTORY;

    this._fpsAcc += ft;
    this._fpsN++;
    if (this._fpsAcc >= 500) {
      this._fps = 1000 * this._fpsN / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsN = 0;
      this.fpsEl.textContent = this._fps.toFixed(0) + ' fps';
      this.fpsEl.style.color = this._fps >= 50 ? '#6ee7a0' : this._fps >= 28 ? '#ffd166' : '#ff5d5d';
    }

    if (this.el.classList.contains('collapsed')) return;

    this._drawGraph();

    const now = performance.now();
    if (now - this._lastText < 250) return;
    this._lastText = now;

    /** @type {(b: number) => string} */
    const mb = (b) => (b / 1048576).toFixed(1);
    const t = stats.timings;
    this.textEl.innerHTML =
      `frame    <b>${ft.toFixed(2).padStart(6)}</b> ms  (max ${stats.frameMaxMs.toFixed(1)})\n` +
      `  input  ${t.input.toFixed(2).padStart(6)} ms   sample ${t.sample.toFixed(2).padStart(5)} ms\n` +
      `  raster ${t.raster.toFixed(2).padStart(6)} ms   upload ${t.upload.toFixed(2).padStart(5)} ms\n` +
      `  draw   ${t.draw.toFixed(2).padStart(6)} ms\n` +
      `budget   <b>${(stats.budgetPx / 1e6).toFixed(2)}</b> Mpx/frame  usati ${(stats.rasterPx / 1e6).toFixed(2)}\n` +
      `coda     ${String(stats.queueDepth).padStart(6)} descrittori${stats.queueDepth > 0 ? ' (catch-up)' : ''}\n` +
      `dab/f    ${String(stats.dabsFrame).padStart(6)}   eventi/s ${stats.eventsPerSec.toFixed(0)}\n` +
      `chunk    ${String(stats.docChunks).padStart(6)} doc / ${stats.strokeChunks} stroke\n` +
      `mem CPU  ${mb(stats.cpuBytes).padStart(6)} MB   GPU ${mb(stats.gpuBytes)} MB\n` +
      `undo     ${String(stats.undoCount).padStart(6)} step  (${mb(stats.undoBytes)} MB)\n` +
      `stamp    ${String(stats.stampCache).padStart(6)} in cache (${stats.stampGen} generati)\n` +
      `vista    zoom ${(stats.zoom * 100).toFixed(0)}%  dpr ${stats.dpr}\n` +
      `renderer <b>${stats.renderer}</b>${stats.contextLost ? '  ⚠ context lost' : ''}`;
  }

  _drawGraph() {
    const ctx = this.gctx, W = 280, H = 48;
    ctx.clearRect(0, 0, W, H);

    // linea 16.7ms (60fps) e 33.3ms (30fps)
    /** @type {(ms: number) => number} */
    const yFor = (ms) => H - Math.min(H, (ms / 40) * H);
    ctx.strokeStyle = 'rgba(110,231,160,0.35)';
    ctx.beginPath(); ctx.moveTo(0, yFor(16.7)); ctx.lineTo(W, yFor(16.7)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,93,93,0.35)';
    ctx.beginPath(); ctx.moveTo(0, yFor(33.3)); ctx.lineTo(W, yFor(33.3)); ctx.stroke();

    const bw = W / HISTORY;
    for (let i = 0; i < HISTORY; i++) {
      const ft = this.frameTimes[(this.fi + i) % HISTORY];
      if (ft <= 0) continue;
      const h = Math.min(H, (ft / 40) * H);
      ctx.fillStyle = ft <= 17.5 ? '#4f8cff' : ft <= 34 ? '#ffd166' : '#ff5d5d';
      ctx.fillRect(i * bw, H - h, Math.max(1, bw - 0.5), h);
    }
  }
}
