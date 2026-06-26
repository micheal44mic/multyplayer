// STRESS TEST: fills the document with B boards x L painted layers (plus T
// text layers per board, interleaved through the stack) so limits are visible:
// zoomed-out draw calls, resident VRAM, and the wasm heap ceiling.
// Incremental filling runs through MessageChannel (~8 ms per slice so the UI
// stays responsive and progress continues even when rAF is suspended). Chunks
// are written directly without markDirty: textures are created on demand when
// visible, matching the architecture ("CPU is the source of truth").
// No undo: the document is reset first (clearAll).
// The app no longer has a HUD or app.stats; this panel measures itself: fps
// and peak frame time from its own rAF chain, plus memory by counting chunks
// and resident textures.
// Activation: ⚡ toolbar button, ?stress=BxL[xCOVERAGE%][tN] in the URL
// (auto-start on page load; t = 1 text layer per board, t3 = 3), or
// __stress.start(B, L, cov, texts) from the console.
// Ready-made preset page: stress.html.

import { CHUNK, CHUNK_BYTES } from './store.js';
import { makeRasterLayer, makeTextLayer, MAX_LAYERS } from './layers.js';
import { makeTextItem, defaultTextStyle } from './text_layer.js';
import { BOARD_SIZE, MAX_BOARDS } from './boards.js';
import { ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { clamp } from './util.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {{store: import('./store.js').ChunkStore, layer: Layer, cx0: number, cy0: number, tpl: Uint8ClampedArray}} FillLayer */

// Board grid pitch: side + gap, kept as a CHUNK multiple so board edges land
// on tile boundaries.
const PITCH = BOARD_SIZE + CHUNK;
const SIDE = (BOARD_SIZE / CHUNK) | 0;   // chunk per lato (8)
const PER_LAYER = SIDE * SIDE;           // chunks per full layer (64)
const SLICE_MS = 8;                      // fill-slice budget
const PROXY_BYTES = 1024 * 1024 * 4;     // flat texture for one board proxy

// iOS does not tolerate allocation spikes: an abrupt commit of hundreds of MB
// (monolithic pre-grow or back-to-back fill slices) can trigger jetsam even
// when the device can hold that memory at steady state. Grow the heap in small
// steps while filling, and pause between slices so the system can absorb the
// commits. No artificial cap.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const GROW_STEP = 256;                   // chunks per growth step (64 MB)
const PACE_MS = IS_IOS ? 24 : 0;         // breathing room between slices on iOS
/** @param {number} b */
const fmtBytes = (b) => b >= (1 << 30) ? (b / (1 << 30)).toFixed(2) + ' GB'
  : Math.max(1, Math.round(b / (1 << 20))) + ' MB';

/** hsv -> [r,g,b] 0..255 @param {number} h 0..1 @param {number} s @param {number} v */
function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const c = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [c[0] * 255 | 0, c[1] * 255 | 0, c[2] * 255 | 0];
}

/** @param {number} h 0..1 @param {number} s @param {number} v */
function hsvHex(h, s, v) {
  const [r, g, b] = hsv(h, s, v);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** @param {string} tag @param {string} css @param {string} [text] */
function el(tag, css, text) {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

const BTN_CSS = 'background:#2a2c36;color:#e8e9ee;border:1px solid #3a3d4a;' +
  'border-radius:7px;padding:5px 9px;font:12px system-ui;cursor:pointer;';
const INPUT_CSS = 'width:52px;background:#1d1f27;color:#e8e9ee;border:1px solid #3a3d4a;' +
  'border-radius:6px;padding:4px 6px;font:12px system-ui;';

export class StressTest {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    /** @type {{layers: FillLayer[], li: number, ci: number, filled: number, total: number, cov1024: number, t0: number}|null} */
    this._job = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._statTimer = null;
    // Self-contained fps meter: deltas between rAF ticks. It runs only while
    // the panel is open, costs ~0, and resets the peak roughly every 2 s.
    this._mLast = 0; this._mT0 = 0; this._mFrames = 0;
    this._mPeak = 0; this._mPeakShown = 0; this._mTicks = 0;
    this._meterCb = (/** @type {number} */ t) => this._meter(t);
    // Fill progress advances as macrotasks: independent from rAF, with room
    // for rendering and input between slices.
    this._chan = new MessageChannel();
    this._chan.port1.onmessage = () => this._tick();
    this._buildPanel();
  }

  // ---- panel ----

  _buildPanel() {
    const root = el('section',
      'position:fixed;left:12px;top:64px;z-index:9999;width:310px;display:none;' +
      'background:#16171cdd;backdrop-filter:blur(6px);border:1px solid #3a3d4a;' +
      'border-radius:12px;padding:12px;color:#e8e9ee;font:12px system-ui;' +
      'box-shadow:0 8px 30px #0008;');
    root.id = 'stresspanel';

    const head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;');
    head.append(el('b', 'font-size:13px;', '⚡ Stress test — boards × layers'));
    const close = el('button', BTN_CSS + 'padding:2px 8px;', '✕');
    close.title = 'Close (an active fill keeps running)';
    close.addEventListener('click', () => this.show(false));
    head.append(close);

    // Presets: one click starts filling immediately.
    const presets = el('div', 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;');
    /** @type {[string, string, number, number, number, number][]} name, title, B, L, coverage%, texts */
    const defs = [
      ['4×4 full', '256 MB - warm-up', 4, 4, 100, 0],
      ['8×8 full', '1 GB - comfortable', 8, 8, 100, 0],
      ['16×8 full', '2 GB - recommended limit', 16, 8, 100, 0],
      ['16×16 · 40%', '~1.6 GB - realistic coverage', 16, 16, 40, 0],
      ['16×14 + 2 texts', '~3.5 GB - sandwich stack: text is baked into quads', 16, 14, 100, 2],
      ['16×16 full', '4 GB - the wall: it stops by itself ⚠', 16, 16, 100, 0],
    ];
    for (const [name, title, b, l, c, t] of defs) {
      const btn = el('button', BTN_CSS, name);
      btn.title = title;
      btn.addEventListener('click', () => {
        this.setPanelInputs(b, l, c, t);
        this.start({ boards: b, layers: l, coverage: c / 100, texts: t });
      });
      presets.append(btn);
    }

    // Custom row: B x L x coverage.
    const row = el('div', 'display:flex;align-items:center;gap:5px;margin-bottom:6px;flex-wrap:wrap;');
    this._inB = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    this._inL = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    this._inC = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    // Default target: 16 boards x 16 layers, fully filled.
    for (const [inp, val, min, max] of /** @type {[HTMLInputElement, string, number, number][]} */ ([
      [this._inB, '16', 1, MAX_BOARDS], [this._inL, '16', 1, MAX_LAYERS], [this._inC, '100', 1, 100],
    ])) {
      inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.value = val;
      inp.addEventListener('input', () => this._syncEstimate());
    }
    row.append(el('span', '', 'board'), this._inB, el('span', '', '× layer'), this._inL,
      el('span', '', '· coverage %'), this._inC);

    // Text row: T text layers for every board, interleaved through the stack at
    // uniform intervals. This is the worst real case for planes (it would split
    // raster runs without baked quads) and for the proxy (sandwich stack to
    // bake). Every text item is a layer: raster + text <= 16 per board.
    const rowT = el('div', 'display:flex;align-items:center;gap:5px;margin-bottom:6px;flex-wrap:wrap;');
    this._inT = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    this._inT.type = 'number'; this._inT.min = '0'; this._inT.max = String(MAX_LAYERS - 1);
    this._inT.value = '0';
    this._inT.addEventListener('input', () => this._syncEstimate());
    rowT.append(el('span', '', 'texts per board'), this._inT,
      el('span', 'opacity:.6;', '(0 = none; 1 text = 1 layer)'));

    this._estEl = el('div', 'opacity:.75;margin-bottom:8px;');

    const actions = el('div', 'display:flex;gap:5px;margin-bottom:8px;');
    this._goBtn = el('button', BTN_CSS + 'background:#3a5b3f;', 'Start');
    this._goBtn.addEventListener('click', () => this.start({
      boards: parseInt(this._inB.value, 10) || 1,
      layers: parseInt(this._inL.value, 10) || 1,
      coverage: (parseInt(this._inC.value, 10) || 100) / 100,
      texts: parseInt(this._inT.value, 10) || 0,
    }));
    this._stopBtn = el('button', BTN_CSS, 'Stop');
    this._stopBtn.addEventListener('click', () => this.stop());
    const fitAll = el('button', BTN_CSS, 'Fit All');
    fitAll.title = 'Zoom out across all boards: massive upload + one draw per chunk - this reveals lag';
    fitAll.addEventListener('click', () => this._fitAll());
    const fitOne = el('button', BTN_CSS, 'Canvas 1');
    fitOne.title = 'Return to working zoom on the first board';
    fitOne.addEventListener('click', () => {
      const b = this.app.boards.boards[0];
      if (b) this.app.fitBoard(b);
    });
    actions.append(this._goBtn, this._stopBtn, fitAll, fitOne);

    // Progress + status + live statistics (two rows: timing and memory).
    const barWrap = el('div', 'height:6px;border-radius:3px;background:#2a2c36;overflow:hidden;margin-bottom:6px;');
    this._barEl = el('div', 'height:100%;width:0;background:#7aa2f7;');
    barWrap.append(this._barEl);
    this._statusEl = el('div', 'min-height:14px;margin-bottom:4px;');
    this._liveEl = el('div', 'opacity:.85;font-variant-numeric:tabular-nums;min-height:14px;');
    this._memEl = el('div', 'opacity:.85;font-variant-numeric:tabular-nums;min-height:14px;');
    const note = el('div', 'opacity:.55;margin-top:8px;',
      'Replaces the document, with no undo. Then zoom out, pan between boards, ' +
      'and draw on a layer: fps and peak frame time above show where it lags.');

    root.append(head, presets, row, rowT, this._estEl, actions, barWrap,
      this._statusEl, this._liveEl, this._memEl, note);
    document.body.append(root);
    this._root = root;
    this._syncEstimate();

    const btn = document.getElementById('btn-stress');
    if (btn) btn.addEventListener('click', () => this.toggle());
  }

  // Reflect the active parameters in the panel (preset or URL launch).
  /** @param {number} b @param {number} l @param {number} covPct @param {number} texts */
  setPanelInputs(b, l, covPct, texts) {
    this._inB.value = String(b); this._inL.value = String(l);
    this._inC.value = String(covPct); this._inT.value = String(texts);
    this._syncEstimate();
  }

  _syncEstimate() {
    const b = clamp(parseInt(this._inB.value, 10) || 1, 1, MAX_BOARDS);
    const t = clamp(parseInt(this._inT.value, 10) || 0, 0, MAX_LAYERS - 1);
    // Text layers take slots in the stack, so raster layers stop at MAX - T.
    const l = clamp(parseInt(this._inL.value, 10) || 1, 1, MAX_LAYERS - t);
    const c = clamp(parseInt(this._inC.value, 10) || 100, 1, 100) / 100;
    const chunks = Math.round(b * l * PER_LAYER * c);
    this._estEl.textContent = `≈ ${chunks} chunks · ${fmtBytes(chunks * CHUNK_BYTES)} of CPU pixels · ` +
      `${l + t} layers/board` +
      (t ? ` · ${b * t} texts (${t}/board)` : '') +
      (this.app.heap ? ' · wasm heap, 4 GB ceiling' : ' · JS heap');
  }

  /** @param {boolean} v */
  show(v) {
    this._root.style.display = v ? 'block' : 'none';
    if (v && !this._statTimer) {
      this._statTimer = setInterval(() => this._liveStats(), 500);
      this._mLast = 0; this._mT0 = performance.now();
      this._mFrames = 0; this._mPeak = 0; this._mTicks = 0;
      requestAnimationFrame(this._meterCb);
    }
    if (!v && this._statTimer) { clearInterval(this._statTimer); this._statTimer = null; }
  }

  toggle() { this.show(this._root.style.display === 'none'); }

  // ---- live statistics (the app has no HUD, so this measures itself) ----

  /** @param {number} t */
  _meter(t) {
    if (this._mLast) {
      const dt = t - this._mLast;
      this._mFrames++;
      if (dt > this._mPeak) this._mPeak = dt;
    }
    this._mLast = t;
    if (this._statTimer) requestAnimationFrame(this._meterCb); // closed panel: shuts itself down
  }

  _liveStats() {
    const now = performance.now();
    const fps = Math.min(999, Math.round(this._mFrames * 1000 / Math.max(1, now - this._mT0)));
    this._mT0 = now; this._mFrames = 0;
    // Peak displayed over a ~2 s window (4 ticks), so a single hitch stays
    // readable instead of disappearing on the next tick.
    if (++this._mTicks >= 4) { this._mTicks = 0; this._mPeakShown = this._mPeak; this._mPeak = 0; }
    else this._mPeakShown = Math.max(this._mPeakShown, this._mPeak);

    let chunks = 0;
    for (const s of this.app.boards.allRasterStores()) chunks += s.count;
    const heap = this.app.heap;
    this._liveEl.textContent = `${fps} fps · peak frame ${Math.round(this._mPeakShown)} ms · ${chunks} chunks`;
    this._memEl.textContent = `CPU ${fmtBytes(chunks * CHUNK_BYTES)}` +
      (heap ? ` · heap wasm ${fmtBytes(heap.memory.buffer.byteLength)}` : '') +
      ` · GPU≈ ${fmtBytes(this._gpuEstimate())}`;
  }

  // Resident VRAM estimated from countable objects: chunk textures/canvases
  // (256 KB each, +1/3 mip chain in GL), flat board-proxy quads, and text
  // bakes. Pool 2D planes are excluded, so this is an approximate estimate.
  _gpuEstimate() {
    const app = this.app;
    const gl = app.renderer.kind !== 'Canvas2D';
    let b = (app.renderer.texCount || 0) * CHUNK_BYTES * (gl ? 4 / 3 : 1);
    const pm = /** @type {any} */ (app.proxy)._map;
    if (pm) for (const e of pm.values()) { if (e.tex) b += PROXY_BYTES * 4 / 3; }
    const tq = /** @type {any} */ (app.textQuads)._map;
    if (tq) for (const e of tq.values()) {
      if (e.canvas) b += e.canvas.width * e.canvas.height * 4 * (e.tex ? 2 : 1);
    }
    return Math.round(b);
  }

  // ---- filling ----

  /** @param {{boards: number, layers: number, coverage?: number, texts?: number|boolean}} opts */
  start(opts) {
    if (this._job) return; // one fill at a time ("Stop" aborts)
    // During multiplayer, filling writes pixels outside commands, so peers
    // would diverge. Same lockdown as non-deterministic tools.
    const collab = this.app.collab;
    if (collab && collab.active) {
      this.show(true);
      this._statusEl.textContent = '⚠ Disabled during multiplayer sessions.';
      if (collab.ui && collab.ui.toast) collab.ui.toast('Stress test disabled during multiplayer sessions.');
      return;
    }
    const B = clamp(Math.round(opts.boards), 1, MAX_BOARDS);
    // Compatibility: texts used to be a boolean (one text at mid-stack); now it is a number.
    const T = clamp(opts.texts === true ? 1 : Math.round(Number(opts.texts) || 0), 0, MAX_LAYERS - 1);
    // Text layers take slots in the stack, so raster layers stop at MAX - T.
    const L = clamp(Math.round(opts.layers), 1, MAX_LAYERS - T);
    const cov = clamp(opts.coverage === undefined ? 1 : opts.coverage, 0.01, 1);
    this.show(true);

    const layers = this._buildDocument(B, L, T);
    // No monolithic pre-grow: the heap grows in GROW_STEP increments inside
    // _tick (on iOS, a giant one-shot commit can trigger jetsam).
    this._preGrow(GROW_STEP);

    this._job = {
      layers, li: 0, ci: 0, filled: 0,
      total: layers.length * PER_LAYER,
      cov1024: Math.round(cov * 1024),
      t0: performance.now(),
    };
    this._goBtn.setAttribute('disabled', '');
    this._statusEl.textContent = 'Filling...';
    this._chan.port2.postMessage(0);
  }

  stop() {
    if (this._job) this._finish('Stopped manually');
  }

  // Reset the document and build B boards in a grid with L raster layers each.
  // With T > 0, also add T text layers per board, interleaved through the stack
  // at uniform intervals: the true worst case (sandwich stacks, with text baked
  // into renderer quads and proxy bakes). Returns raster layers in board-major
  // order.
  /** @param {number} B @param {number} L @param {number} T @returns {FillLayer[]} */
  _buildDocument(B, L, T) {
    const app = this.app;
    app.clearAll();
    const boards = app.boards;
    const cols = Math.ceil(Math.sqrt(B));
    /** @type {FillLayer[]} */
    const out = [];
    /** @type {Uint8ClampedArray[]} one tile template per layer index */
    const tpls = [];
    for (let l = 0; l < L; l++) tpls.push(this._template(l, L));
    // Text body size: stacked in a column, all text items must fit inside the board.
    const tSize = Math.max(60, Math.min(300, Math.floor(BOARD_SIZE / (T + 1) * 0.45)));

    for (let i = 0; i < B; i++) {
      const b = i === 0 ? boards.boards[0] : boards.add(`Canvas ${i + 1}`);
      b.x = (i % cols) * PITCH;
      b.y = Math.floor(i / cols) * PITCH;
      while (b.mgr.layers.length < L) {
        const layer = makeRasterLayer('', app.heap);
        b.mgr.insert(layer);
        app._allStores.add(layer.store);
      }
      for (let l = 0; l < L; l++) {
        const layer = b.mgr.layers[l];
        out.push({ store: layer.store, layer, cx0: b.x >> 8, cy0: b.y >> 8, tpl: tpls[l] });
      }
      // T texts at evenly spaced final indices in the L+T stack (for T=1 and
      // L=15, index 8 is the middle, matching the old single-text case).
      // Inserting in ascending order makes indices final immediately.
      for (let k = 0; k < T; k++) {
        const item = makeTextItem(b.x + b.w / 2, b.y + b.h * (k + 1) / (T + 1),
          hsvHex((i / B + k * 0.37) % 1, 0.25, 1), tSize);
        item.text = T === 1 ? b.name.toUpperCase() : `${b.name.toUpperCase()} · ${k + 1}`;
        const tl = makeTextLayer(`Text ${k + 1}`, item, defaultTextStyle());
        const at = clamp(Math.round((k + 1) * (L + T) / (T + 1)), 1, b.mgr.layers.length);
        b.mgr.insert(tl, at);
      }
      // The brush must be able to write immediately: activate a raster layer, not text.
      if (T > 0) b.mgr.activeId = b.mgr.layers[0].id;
    }
    boards.activeId = boards.boards[0].id;
    boards.bump();
    app.fitBoard(boards.boards[0]); // watch the first board fill
    app.ui.layersUI.sync(true);
    return out;
  }

  // 256x256 tile for layer idx of count: diagonal stripes (16 bands of 16 px,
  // period 256 in x+y, so the same template works for every chunk and edges
  // align). Stripes are distributed across layers, so the full stack tiles the
  // board and every layer remains visible. Premultiplied alpha 255 means direct
  // color.
  /** @param {number} idx @param {number} count */
  _template(idx, count) {
    const d = new Uint8ClampedArray(CHUNK_BYTES);
    const [r, g, b] = hsv(idx / Math.max(1, count), 0.65, 0.95);
    let i = 0;
    for (let y = 0; y < CHUNK; y++) {
      for (let x = 0; x < CHUNK; x++, i += 4) {
        if ((((x + y) >> 4) & 15) % count !== idx) continue;
        const k = 0.72 + 0.28 * (((x ^ (y << 1)) & 63) / 63);
        d[i] = r * k; d[i + 1] = g * k; d[i + 2] = b * k; d[i + 3] = 255;
      }
    }
    return d;
  }

  // Ensure headroom for `chunks` chunks in the wasm heap (no-op if space already
  // exists). Called in GROW_STEP increments while filling: few grows (each grow
  // refreshes every chunk view), but never a giant commit, which can cause
  // jetsam on iOS. If growth fails, continue anyway: incremental allocation
  // will stop by itself at the ceiling.
  /** @param {number} chunks */
  _preGrow(chunks) {
    const heap = this.app.heap;
    if (!heap) return;
    const target = heap.heapBytes + chunks * CHUNK_BYTES + (64 << 20);
    const cur = heap.memory.buffer.byteLength;
    if (target <= cur) return;
    try {
      heap.memory.grow(Math.ceil((target - cur) / 65536));
      if (heap.onGrow) heap.onGrow();
    } catch { /* wasm ceiling: it will show up during filling */ }
  }

  _tick() {
    const job = this._job;
    if (!job) return;
    const t0 = performance.now();
    try {
      while (performance.now() - t0 < SLICE_MS) {
        if (job.li >= job.layers.length) { this._finish(null); return; }
        const fl = job.layers[job.li];
        const ci = job.ci++;
        const cx = fl.cx0 + (ci % SIDE), cy = fl.cy0 + ((ci / SIDE) | 0);
        // Coverage: deterministic hash for (chunk, layer). Holes are chunk-
        // granularity because chunks are the memory-cost unit.
        let h = Math.imul(cx, 0x9E3779B1) ^ Math.imul(cy, 0x85EBCA77) ^ Math.imul(job.li + 1, 0xC2B2AE3D);
        h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D); h ^= h >>> 13;
        if (((h >>> 0) % 1024) < job.cov1024) {
          // Rolling growth: keep about GROW_STEP chunks of headroom in the heap
          // without ever making a giant commit (no-op if space already exists).
          if (job.filled % GROW_STEP === 0) this._preGrow(GROW_STEP);
          const c = fl.store.getOrCreate(cx, cy); // may throw at the wasm ceiling
          c.data.set(fl.tpl);
          c.touched = true;
          job.filled++;
        }
        if (job.ci >= PER_LAYER) {
          fl.layer.thumbDirty = true;
          fl.store.ver++; // contenuto cambiato: i proxy dei board si invalidano
          job.li++; job.ci = 0;
        }
      }
    } catch (err) {
      this._finish(`Out of memory after ${job.filled} chunks (${fmtBytes(job.filled * CHUNK_BYTES)}): ${err}`);
      return;
    }
    const done = job.li * PER_LAYER + job.ci;
    const rate = job.filled * CHUNK_BYTES / Math.max(1, performance.now() - job.t0) * 1000;
    this._barEl.style.width = (done / job.total * 100).toFixed(1) + '%';
    this._statusEl.textContent =
      `Filling... ${job.filled} chunks · ${fmtBytes(job.filled * CHUNK_BYTES)} · ${fmtBytes(rate)}/s`;
    // On iOS, pause for real between slices: memory commits slow to a rhythm
    // the system can absorb instead of killing the tab because of the spike.
    if (PACE_MS) setTimeout(() => this._chan.port2.postMessage(0), PACE_MS);
    else this._chan.port2.postMessage(0);
  }

  /** @param {string|null} problem null = completed */
  _finish(problem) {
    const job = this._job;
    this._job = null;
    this._goBtn.removeAttribute('disabled');
    if (!job) return;
    const secs = ((performance.now() - job.t0) / 1000).toFixed(1);
    const bytes = job.filled * CHUNK_BYTES;
    this._barEl.style.width = '100%';

    this.app.planes.invalidate();
    this.app.ui.layersUI.sync(true);
    this.app.ui.layersUI.scheduleThumbs();

    if (problem) {
      this._statusEl.textContent = `⚠ ${problem}`;
      console.warn('[stress]', problem);
    } else {
      this._statusEl.textContent = `Done: ${job.filled} chunks · ${fmtBytes(bytes)} in ${secs}s` +
        ' - use "Fit All" to zoom out';
    }
    // No automatic zoom-out: on Safari, fitting everything immediately after a
    // 16x16 fill can crash. Stay on the first canvas; the user chooses zoom-out
    // with "Fit All" or manually.
  }

  _fitAll() {
    const bs = this.app.boards.boards;
    if (bs.length === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of bs) {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    const cam = this.app.camera;
    cam.zoom = clamp(Math.min(cam.w / (x1 - x0), cam.h / (y1 - y0)) * 0.92, ZOOM_MIN, ZOOM_MAX);
    cam.x = (x0 + x1) / 2;
    cam.y = (y0 + y1) / 2;
    cam.changed = true;
  }
}

// Attach the panel to the app, expose __stress, and read ?stress=BxL[xCOV%][tN]
// (t = 1 text layer per board, t3 = 3, interleaved through the stack).
/** @param {App} app */
export function initStress(app) {
  const st = new StressTest(app);
  /** @type {any} */ (window).__stress = {
    /** @param {number} b @param {number} l @param {number} [cov] 0..1 @param {number|boolean} [texts] */
    start: (b, l, cov, texts) => st.start({ boards: b, layers: l, coverage: cov, texts }),
    stop: () => st.stop(),
    toggle: () => st.toggle(),
    panel: st,
  };
  // ?stress=... or #stress=...: the hash survives static servers that normalize
  // index.html -> / and lose the query (for example, `serve`).
  const arg = new URLSearchParams(location.search).get('stress') ||
    (/[#&]stress=([0-9xt]+)/.exec(location.hash) || [])[1] || '';
  const m = /^(\d{1,2})x(\d{1,2})(?:x(\d{1,3}))?(?:t(\d{0,2}))?$/.exec(arg);
  if (m) {
    const texts = m[4] === undefined ? 0 : (m[4] === '' ? 1 : +m[4]);
    st.show(true);
    st.setPanelInputs(+m[1], +m[2], m[3] ? +m[3] : 100, texts);
    st.start({ boards: +m[1], layers: +m[2], coverage: m[3] ? +m[3] / 100 : 1, texts });
  }
  return st;
}
