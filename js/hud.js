// Console prestazioni: collassabile, aggiornata senza allocazioni per frame.
// Testo a 4 Hz, sparkline dei frame time a ogni frame.
// Diagnosi lag: ogni frame sopra soglia viene attribuito alla componente
// dominante (input/raster/commit/upload/draw, o "altro" = tempo fuori dalle
// fasi misurate: GC, compositor, browser). Il tasto "copia" mette negli
// appunti un report testuale completo della finestra, da incollare per la
// diagnosi remota.

import { brush } from './brush.js';
import { strokeProfiler } from './stroke_profiler.js';

const HISTORY = 120;
const SLOW_MS = 18; // frame oltre questa soglia contano come lag

// indici componenti nelle ring (e nomi per verdetto/report)
const COMP_NAMES = ['input', 'raster', 'commit', 'upload', 'draw', 'altro'];

/**
 * Statistiche per frame, oggetto riusato dal main loop (zero allocazioni).
 * @typedef {Object} Stats
 * @property {number} frameMs
 * @property {number} frameMaxMs
 * @property {{input: number, raster: number, tex: number, commit: number, upload: number, draw: number}} timings
 * @property {number} texDabs
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
 * @property {string} engine
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
    // ring per componente, stesso indice di frameTimes
    this._rInput = new Float32Array(HISTORY);
    this._rRaster = new Float32Array(HISTORY);
    this._rTex = new Float32Array(HISTORY);
    this._rCommit = new Float32Array(HISTORY);
    this._rUpload = new Float32Array(HISTORY);
    this._rDraw = new Float32Array(HISTORY);
    this._rQueue = new Float32Array(HISTORY);
    this.fi = 0;
    this._lastText = 0;
    this._fpsAcc = 0;
    this._fpsN = 0;
    this._fps = 0;
    /** @type {Stats|null} */
    this._lastStats = null;

    const toggle = () => this.el.classList.toggle('collapsed');
    document.getElementById('hud-head').addEventListener('click', toggle);

    const copyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('hud-copy'));
    this.copyBtn = copyBtn;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // il click sull'header collassa la console
      this._copyReport();
    });

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.graph.width = 280 * dpr;
    this.graph.height = 48 * dpr;
    this.gctx.scale(dpr, dpr);
  }

  toggle() { this.el.classList.toggle('collapsed'); }

  // stats: oggetto riusato dal main loop
  /** @param {Stats} stats */
  update(stats) {
    this._lastStats = stats;
    const ft = stats.frameMs;
    const t = stats.timings;
    const i = this.fi;
    this.frameTimes[i] = ft;
    this._rInput[i] = t.input;
    this._rRaster[i] = t.raster;
    this._rTex[i] = t.tex;
    this._rCommit[i] = t.commit;
    this._rUpload[i] = t.upload;
    this._rDraw[i] = t.draw;
    this._rQueue[i] = stats.queueDepth;
    this.fi = (i + 1) % HISTORY;

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
    this.textEl.innerHTML =
      `frame    <b>${ft.toFixed(2).padStart(6)}</b> ms  (max ${stats.frameMaxMs.toFixed(1)})\n` +
      `<b>causa    ${this._verdict()}</b>\n` +
      `  input  ${t.input.toFixed(2).padStart(6)} ms   raster ${t.raster.toFixed(2).padStart(5)} ms` +
      ` (tex ${t.tex.toFixed(2)})\n` +
      `  commit ${t.commit.toFixed(2).padStart(6)} ms   upload ${t.upload.toFixed(2).padStart(5)} ms` +
      `   draw ${t.draw.toFixed(2)} ms\n` +
      `budget   <b>${(stats.budgetPx / 1e6).toFixed(2)}</b> Mpx/frame  usati ${(stats.rasterPx / 1e6).toFixed(2)}\n` +
      `coda     ${String(stats.queueDepth).padStart(6)} descrittori${stats.queueDepth > 0 ? ' (catch-up)' : ''}\n` +
      `dab/f    ${String(stats.dabsFrame).padStart(6)} (tex ${stats.texDabs})   eventi/s ${stats.eventsPerSec.toFixed(0)}\n` +
      `chunk    ${String(stats.docChunks).padStart(6)} doc / ${stats.strokeChunks} stroke\n` +
      `mem CPU  ${mb(stats.cpuBytes).padStart(6)} MB   GPU ${mb(stats.gpuBytes)} MB\n` +
      `undo     ${String(stats.undoCount).padStart(6)} step  (${mb(stats.undoBytes)} MB)\n` +
      `stamp    ${String(stats.stampCache).padStart(6)} in cache (${stats.stampGen} generati)\n` +
      `vista    zoom ${(stats.zoom * 100).toFixed(0)}%  dpr ${stats.dpr}\n` +
      `renderer <b>${stats.renderer}</b>  raster <b>${stats.engine}</b>${stats.contextLost ? '  ⚠ context lost' : ''}`;
  }

  // Attribuzione del lag nella finestra: per ogni frame lento la componente
  // dominante prende il punto; "altro" = il grosso del tempo non è in nessuna
  // fase misurata (GC, compositor, preview del browser).
  _verdict() {
    let slow = 0, n = 0;
    const counts = [0, 0, 0, 0, 0, 0];
    let texShareAcc = 0, texShareN = 0;
    for (let k = 0; k < HISTORY; k++) {
      const ft = this.frameTimes[k];
      if (ft <= 0) continue;
      n++;
      if (ft <= SLOW_MS) continue;
      slow++;
      const p0 = this._rInput[k], p1 = this._rRaster[k], p2 = this._rCommit[k];
      const p3 = this._rUpload[k], p4 = this._rDraw[k];
      const sum = p0 + p1 + p2 + p3 + p4;
      let top = 0, topV = p0;
      if (p1 > topV) { top = 1; topV = p1; }
      if (p2 > topV) { top = 2; topV = p2; }
      if (p3 > topV) { top = 3; topV = p3; }
      if (p4 > topV) { top = 4; topV = p4; }
      if (ft - sum > topV) top = 5; // "altro"
      counts[top]++;
      if (top === 1 && p1 > 0) { texShareAcc += this._rTex[k] / p1; texShareN++; }
    }
    if (n === 0) return 'in attesa di dati';
    const q = this._lastStats ? this._lastStats.queueDepth : 0;
    if (slow === 0) {
      return q > 0 ? `frame ok, ma coda raster ${q} -> tratto in ritardo` : 'nessun lag nella finestra';
    }
    let main = 0, best = -1;
    for (let c = 0; c < 6; c++) if (counts[c] > best) { best = counts[c]; main = c; }
    let extra = '';
    if (main === 1 && texShareN > 0) extra = ` (texture ${(100 * texShareAcc / texShareN).toFixed(0)}% del raster)`;
    if (main === 5) extra = ' (tempo fuori dalle fasi: GC/browser)';
    return `${slow}/${n} frame > ${SLOW_MS} ms -> ${COMP_NAMES[main]}${extra}${q > 0 ? ` · coda ${q}` : ''}`;
  }

  // Report testuale completo negli appunti (per la diagnosi remota).
  _copyReport() {
    const s = this._lastStats;
    const L = [];
    L.push('=== FABLE PAINT - REPORT DIAGNOSTICO ===');
    L.push(new Date().toISOString());
    L.push(`ua: ${navigator.userAgent}`);
    if (s) {
      L.push(`renderer: ${s.renderer}  motore raster: ${s.engine}  dpr: ${s.dpr}  zoom: ${(s.zoom * 100).toFixed(0)}%${s.contextLost ? '  CONTEXT LOST' : ''}`);
    }
    L.push(`pennello: size ${brush.size}px  spacing ${(brush.spacing * 100).toFixed(1)}%  hardness ${brush.hardness}  opacity ${brush.opacity}  buildup ${brush.buildup}  scatter ${brush.scatter}  smoothing ${brush.smoothing}  tool ${brush.tool}`);
    if (brush.texture && brush.textureOn) {
      L.push(`texture: "${brush.texture.name}" ${brush.texture.w}x${brush.texture.h}  scala ${(brush.textureScale * 100).toFixed(0)}%  profondita ${(brush.textureDepth * 100).toFixed(0)}%  contrasto ${(brush.textureContrast * 100).toFixed(0)}%  minimo ${(brush.textureFloor * 100).toFixed(0)}%  invert ${brush.textureInvert}  moving ${brush.textureMoving}  colori ${brush.textureUseColor}`);
    } else {
      L.push('texture: off');
    }

    // aggregati della finestra
    let n = 0, ftSum = 0, ftMax = 0;
    const sums = [0, 0, 0, 0, 0, 0]; // input raster commit upload draw tex
    const maxs = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < HISTORY; k++) {
      const ft = this.frameTimes[k];
      if (ft <= 0) continue;
      n++;
      ftSum += ft;
      if (ft > ftMax) ftMax = ft;
      const vals = [this._rInput[k], this._rRaster[k], this._rCommit[k],
        this._rUpload[k], this._rDraw[k], this._rTex[k]];
      for (let c = 0; c < 6; c++) {
        sums[c] += vals[c];
        if (vals[c] > maxs[c]) maxs[c] = vals[c];
      }
    }
    if (n > 0) {
      L.push(`finestra: ${n} frame  media ${(ftSum / n).toFixed(2)} ms (${(1000 * n / ftSum).toFixed(0)} fps)  max ${ftMax.toFixed(1)} ms`);
      const names = ['input', 'raster', 'commit', 'upload', 'draw', 'tex(in raster)'];
      for (let c = 0; c < 6; c++) {
        L.push(`  ${names[c].padEnd(14)} media ${(sums[c] / n).toFixed(2).padStart(6)} ms  max ${maxs[c].toFixed(2).padStart(6)} ms`);
      }
    }
    L.push(`verdetto: ${this._verdict()}`);
    if (s) {
      L.push(`adesso: coda ${s.queueDepth}  budget ${(s.budgetPx / 1e6).toFixed(2)} Mpx  usati ${(s.rasterPx / 1e6).toFixed(2)} Mpx  dab/f ${s.dabsFrame} (tex ${s.texDabs})  eventi/s ${s.eventsPerSec.toFixed(0)}`);
      L.push(`memoria: cpu ${(s.cpuBytes / 1048576).toFixed(1)} MB  gpu ${(s.gpuBytes / 1048576).toFixed(1)} MB  chunk ${s.docChunks}+${s.strokeChunks}  stamp cache ${s.stampCache}`);
    }

    // i 5 frame peggiori della finestra, con la scomposizione
    /** @type {number[]} */
    const idx = [];
    for (let k = 0; k < HISTORY; k++) if (this.frameTimes[k] > 0) idx.push(k);
    idx.sort((a, b) => this.frameTimes[b] - this.frameTimes[a]);
    const top = idx.slice(0, 5);
    if (top.length) {
      L.push('frame peggiori (ms): frame | input raster(tex) commit upload draw | altro | coda');
      for (const k of top) {
        const ft = this.frameTimes[k];
        const rest = ft - (this._rInput[k] + this._rRaster[k] + this._rCommit[k] + this._rUpload[k] + this._rDraw[k]);
        L.push(`  ${ft.toFixed(1).padStart(7)} | ${this._rInput[k].toFixed(1)} ${this._rRaster[k].toFixed(1)}(${this._rTex[k].toFixed(1)}) ${this._rCommit[k].toFixed(1)} ${this._rUpload[k].toFixed(1)} ${this._rDraw[k].toFixed(1)} | ${rest.toFixed(1)} | ${this._rQueue[k]}`);
      }
    }

    // l'ultimo tratto profilato (lo stesso report stampato in console)
    if (strokeProfiler.lastReport) {
      L.push('');
      L.push(strokeProfiler.lastReport);
    }

    const text = L.join('\n');
    const done = () => {
      const old = this.copyBtn.textContent;
      this.copyBtn.textContent = 'copiato ✓';
      setTimeout(() => { this.copyBtn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => this._copyFallback(text, done));
    } else {
      this._copyFallback(text, done);
    }
  }

  /** @param {string} text @param {() => void} done */
  _copyFallback(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { /* appunti negati */ }
    ta.remove();
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
