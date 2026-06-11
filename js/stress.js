// STRESS TEST — riempie il documento con B board × L layer dipinti, per
// vedere coi propri occhi dove il sistema regge e dove cede (draw call a
// zoom-out, VRAM residente, tetto del heap wasm). Riempimento incrementale
// via MessageChannel (~8 ms a fetta: la UI resta viva e il passo avanza
// anche con rAF sospeso); scrittura diretta nei chunk SENZA markDirty: le
// texture nascono on-demand alla vista, come da architettura ("la CPU è la
// verità"). Niente undo: il documento viene azzerato prima (clearAll).
// Attivazione: bottone ⚡ in toolbar, ?stress=BxL[xCOPERTURA%] nell'URL
// (auto-start a pagina caricata), __stress.start(B, L, cov) da console.
// Pagina dei preset pronti: stress.html.

import { CHUNK, CHUNK_BYTES } from './store.js';
import { makeRasterLayer, MAX_LAYERS } from './layers.js';
import { BOARD_SIZE, MAX_BOARDS } from './boards.js';
import { ZOOM_MIN, ZOOM_MAX } from './camera.js';
import { clamp } from './util.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {{store: import('./store.js').ChunkStore, layer: Layer, cx0: number, cy0: number, tpl: Uint8ClampedArray}} FillLayer */

// Passo della griglia dei board: lato + spazio, multiplo di CHUNK (i bordi
// dei board devono cadere sui confini dei tile).
const PITCH = BOARD_SIZE + CHUNK;
const SIDE = (BOARD_SIZE / CHUNK) | 0;   // chunk per lato (8)
const PER_LAYER = SIDE * SIDE;           // chunk per layer pieno (64)
const SLICE_MS = 8;                      // budget di una fetta di riempimento

// iOS non tollera PICCHI di allocazione: un commit improvviso di centinaia
// di MB (pre-grow monolitico, o fette di riempimento back-to-back) fa
// scattare jetsam anche quando il dispositivo reggerebbe quella memoria a
// regime (un iPad arriva a ~3 GB senza problemi). Quindi: heap cresciuto a
// passi piccoli durante il riempimento e pause tra le fette per dare al
// sistema il tempo di assorbire. Nessun tetto artificiale.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const GROW_STEP = 256;                   // chunk per passo di crescita (64 MB)
const PACE_MS = IS_IOS ? 24 : 0;         // respiro tra le fette su iOS
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
    // il passo del riempimento avanza a macrotask: non dipende da rAF e
    // lascia respirare rendering e input tra una fetta e l'altra
    this._chan = new MessageChannel();
    this._chan.port1.onmessage = () => this._tick();
    this._buildPanel();
  }

  // ---- pannello ----

  _buildPanel() {
    const root = el('section',
      'position:fixed;left:12px;top:64px;z-index:9999;width:300px;display:none;' +
      'background:#16171cdd;backdrop-filter:blur(6px);border:1px solid #3a3d4a;' +
      'border-radius:12px;padding:12px;color:#e8e9ee;font:12px system-ui;' +
      'box-shadow:0 8px 30px #0008;');
    root.id = 'stresspanel';

    const head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;');
    head.append(el('b', 'font-size:13px;', '⚡ Stress test — board × layer'));
    const close = el('button', BTN_CSS + 'padding:2px 8px;', '✕');
    close.title = 'Chiudi (un riempimento in corso continua)';
    close.addEventListener('click', () => this.show(false));
    head.append(close);

    // preset: un click = riempimento immediato
    const presets = el('div', 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;');
    /** @type {[string, string, number, number, number][]} nome, titolo, B, L, cov% */
    const defs = [
      ['4×4 pieno', '256 MB — riscaldamento', 4, 4, 100],
      ['8×8 pieno', '1 GB — comodo', 8, 8, 100],
      ['16×8 pieno', '2 GB — limite consigliato', 16, 8, 100],
      ['16×16 · 40%', '~1,6 GB — copertura realistica', 16, 16, 40],
      ['16×16 pieno', '4 GB — il muro: si ferma da solo ⚠', 16, 16, 100],
    ];
    for (const [name, title, b, l, c] of defs) {
      const btn = el('button', BTN_CSS, name);
      btn.title = title;
      btn.addEventListener('click', () => {
        this._inB.value = String(b); this._inL.value = String(l); this._inC.value = String(c);
        this._syncEstimate();
        this.start({ boards: b, layers: l, coverage: c / 100 });
      });
      presets.append(btn);
    }

    // riga custom: B × L × copertura
    const row = el('div', 'display:flex;align-items:center;gap:5px;margin-bottom:6px;flex-wrap:wrap;');
    this._inB = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    this._inL = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    this._inC = /** @type {HTMLInputElement} */ (el('input', INPUT_CSS));
    for (const [inp, val, max] of /** @type {[HTMLInputElement, string, number][]} */ ([
      [this._inB, '16', MAX_BOARDS], [this._inL, '16', MAX_LAYERS], [this._inC, '100', 100],
    ])) {
      inp.type = 'number'; inp.min = '1'; inp.max = String(max); inp.value = val;
      inp.addEventListener('input', () => this._syncEstimate());
    }
    row.append(el('span', '', 'board'), this._inB, el('span', '', '× layer'), this._inL,
      el('span', '', '· copertura %'), this._inC);

    this._estEl = el('div', 'opacity:.75;margin-bottom:8px;');

    const actions = el('div', 'display:flex;gap:5px;margin-bottom:8px;');
    this._goBtn = el('button', BTN_CSS + 'background:#3a5b3f;', 'Avvia');
    this._goBtn.addEventListener('click', () => this.start({
      boards: parseInt(this._inB.value, 10) || 1,
      layers: parseInt(this._inL.value, 10) || 1,
      coverage: (parseInt(this._inC.value, 10) || 100) / 100,
    }));
    this._stopBtn = el('button', BTN_CSS, 'Ferma');
    this._stopBtn.addEventListener('click', () => this.stop());
    const fitAll = el('button', BTN_CSS, 'Inquadra tutto');
    fitAll.title = 'Zoom-out su tutti i board: upload massivo + un draw per chunk — qui si vede il lag';
    fitAll.addEventListener('click', () => this._fitAll());
    const fitOne = el('button', BTN_CSS, 'Canvas 1');
    fitOne.title = 'Torna allo zoom di lavoro sul primo board';
    fitOne.addEventListener('click', () => {
      const b = this.app.boards.boards[0];
      if (b) this.app.fitBoard(b);
    });
    actions.append(this._goBtn, this._stopBtn, fitAll, fitOne);

    // progresso + stato + statistiche live
    const barWrap = el('div', 'height:6px;border-radius:3px;background:#2a2c36;overflow:hidden;margin-bottom:6px;');
    this._barEl = el('div', 'height:100%;width:0;background:#7aa2f7;');
    barWrap.append(this._barEl);
    this._statusEl = el('div', 'min-height:14px;margin-bottom:4px;');
    this._liveEl = el('div', 'opacity:.85;font-variant-numeric:tabular-nums;min-height:14px;');
    const note = el('div', 'opacity:.55;margin-top:8px;',
      'Sostituisce il documento, senza undo. Console (`) per i dettagli; poi zooma fuori e panna per sentire dove lagga.');

    root.append(head, presets, row, this._estEl, actions, barWrap, this._statusEl, this._liveEl, note);
    document.body.append(root);
    this._root = root;
    this._syncEstimate();

    const btn = document.getElementById('btn-stress');
    if (btn) btn.addEventListener('click', () => this.toggle());
  }

  _syncEstimate() {
    const b = clamp(parseInt(this._inB.value, 10) || 1, 1, MAX_BOARDS);
    const l = clamp(parseInt(this._inL.value, 10) || 1, 1, MAX_LAYERS);
    const c = clamp(parseInt(this._inC.value, 10) || 100, 1, 100) / 100;
    const chunks = Math.round(b * l * PER_LAYER * c);
    this._estEl.textContent = `≈ ${chunks} chunk · ${fmtBytes(chunks * CHUNK_BYTES)} di pixel CPU` +
      (this.app.heap ? ' (heap wasm, tetto 4 GB)' : ' (heap JS)');
  }

  /** @param {boolean} v */
  show(v) {
    this._root.style.display = v ? 'block' : 'none';
    if (v && !this._statTimer) this._statTimer = setInterval(() => this._liveStats(), 250);
    if (!v && this._statTimer) { clearInterval(this._statTimer); this._statTimer = null; }
  }

  toggle() { this.show(this._root.style.display === 'none'); }

  _liveStats() {
    const s = this.app.stats;
    const fps = s.frameMs > 0.01 ? Math.min(999, Math.round(1000 / s.frameMs)) : 0;
    this._liveEl.textContent = `${fps} fps · picco frame ${Math.round(s.frameMaxMs)} ms · ` +
      `${s.docChunks} chunk · CPU ${fmtBytes(s.cpuBytes)} · GPU ${fmtBytes(s.gpuBytes)}`;
  }

  // ---- riempimento ----

  /** @param {{boards: number, layers: number, coverage?: number}} opts */
  start(opts) {
    if (this._job) return; // un riempimento alla volta ("Ferma" per abortire)
    const B = clamp(Math.round(opts.boards), 1, MAX_BOARDS);
    const L = clamp(Math.round(opts.layers), 1, MAX_LAYERS);
    const cov = clamp(opts.coverage === undefined ? 1 : opts.coverage, 0.01, 1);
    this.show(true);

    const layers = this._buildDocument(B, L);
    // niente pre-grow monolitico: il heap cresce a passi di GROW_STEP
    // dentro _tick (su iOS il commit gigante in un colpo solo = jetsam)
    this._preGrow(GROW_STEP);

    this._job = {
      layers, li: 0, ci: 0, filled: 0,
      total: layers.length * PER_LAYER,
      cov1024: Math.round(cov * 1024),
      t0: performance.now(),
    };
    this._goBtn.setAttribute('disabled', '');
    this._statusEl.textContent = 'Riempio…';
    this._chan.port2.postMessage(0);
  }

  stop() {
    if (this._job) this._finish('Fermato a mano');
  }

  // Azzera il documento e costruisce B board in griglia con L layer ciascuno.
  // Ritorna i layer in ordine board-major (tpl = indice del layer nel board).
  /** @param {number} B @param {number} L @returns {FillLayer[]} */
  _buildDocument(B, L) {
    const app = this.app;
    app.clearAll();
    const boards = app.boards;
    const cols = Math.ceil(Math.sqrt(B));
    /** @type {FillLayer[]} */
    const out = [];
    /** @type {Uint8ClampedArray[]} un template di tile per indice di layer */
    const tpls = [];
    for (let l = 0; l < L; l++) tpls.push(this._template(l, L));

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
    }
    boards.activeId = boards.boards[0].id;
    boards.bump();
    app.fitBoard(boards.boards[0]); // si guarda il primo board riempirsi
    app.ui.layersUI.sync(true);
    return out;
  }

  // Tile 256x256 del layer idx su count: strisce diagonali (16 bande da 16px,
  // periodo 256 in x+y -> stesso template per OGNI chunk, i bordi combaciano)
  // ripartite tra i layer: la pila completa piastrella tutto il board e ogni
  // layer resta visibile. Premultiplied con alpha 255 = colore diretto.
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

  // Garantisce headroom per `chunks` chunk nel heap wasm (no-op se c'è già
  // spazio). Chiamata a passi di GROW_STEP durante il riempimento: pochi grow
  // (ogni grow rigenera le viste di tutti i chunk) ma mai un commit gigante,
  // che su iOS = jetsam. Se la crescita fallisce si procede comunque:
  // l'alloc incrementale si fermerà da solo al tetto.
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
    } catch { /* tetto wasm: si vedrà durante il riempimento */ }
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
        // copertura: hash deterministico per (chunk, layer) -> i buchi sono
        // a grana di chunk, perché è il chunk l'unità di costo della memoria
        let h = Math.imul(cx, 0x9E3779B1) ^ Math.imul(cy, 0x85EBCA77) ^ Math.imul(job.li + 1, 0xC2B2AE3D);
        h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D); h ^= h >>> 13;
        if (((h >>> 0) % 1024) < job.cov1024) {
          // crescita rotante: mantiene sempre ~GROW_STEP chunk di headroom
          // nel heap senza mai un commit gigante (no-op se c'è già spazio)
          if (job.filled % GROW_STEP === 0) this._preGrow(GROW_STEP);
          const c = fl.store.getOrCreate(cx, cy); // può lanciare: tetto wasm
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
      this._finish(`Memoria esaurita dopo ${job.filled} chunk (${fmtBytes(job.filled * CHUNK_BYTES)}): ${err}`);
      return;
    }
    const done = job.li * PER_LAYER + job.ci;
    this._barEl.style.width = (done / job.total * 100).toFixed(1) + '%';
    this._statusEl.textContent = `Riempio… ${job.filled} chunk · ${fmtBytes(job.filled * CHUNK_BYTES)}`;
    // su iOS una pausa vera tra le fette: il commit di memoria rallenta a un
    // ritmo che il sistema assorbe invece di uccidere la tab per il picco
    if (PACE_MS) setTimeout(() => this._chan.port2.postMessage(0), PACE_MS);
    else this._chan.port2.postMessage(0);
  }

  /** @param {string|null} problem null = completato */
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
      this._statusEl.textContent = `Fatto: ${job.filled} chunk · ${fmtBytes(bytes)} in ${secs}s`;
    }
    // Niente auto-zoom-out: su Safari l'inquadratura totale subito dopo il
    // riempimento (16x16) crasha. Si resta sul primo canvas; lo zoom-out lo
    // decide l'utente con «Inquadra tutto» o a mano.
    if (!problem) {
      this._statusEl.textContent += ' — «Inquadra tutto» per lo zoom-out';
    }
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

// Aggancia il pannello all'app, espone __stress e legge ?stress=BxL[xCOV%].
/** @param {App} app */
export function initStress(app) {
  const st = new StressTest(app);
  /** @type {any} */ (window).__stress = {
    /** @param {number} b @param {number} l @param {number} [cov] 0..1 */
    start: (b, l, cov) => st.start({ boards: b, layers: l, coverage: cov }),
    stop: () => st.stop(),
    toggle: () => st.toggle(),
    panel: st,
  };
  // ?stress=... oppure #stress=...: l'hash sopravvive ai server statici che
  // normalizzano index.html -> / perdendo la query (es. `serve`)
  const arg = new URLSearchParams(location.search).get('stress') ||
    (/[#&]stress=([0-9x]+)/.exec(location.hash) || [])[1] || '';
  const m = /^(\d{1,2})x(\d{1,2})(?:x(\d{1,3}))?$/.exec(arg);
  if (m) {
    st.show(true);
    st.start({ boards: +m[1], layers: +m[2], coverage: m[3] ? +m[3] / 100 : 1 });
  }
  return st;
}
