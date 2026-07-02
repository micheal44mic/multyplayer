import { MAX_BOARDS, BOARD_SIZE } from './boards.js';
import { BLEND_MODES, MAX_LAYERS, makeRasterLayer, makeTextLayer } from './layers.js';
import { CHUNK, CHUNK_BYTES } from './store.js';
import { clamp } from './util.js';
import {
  TEXT_FONTS,
  defaultTextStyle,
  freeBlockBitmap,
  makeTextItem,
  touchText,
} from './text_layer.js';

const BOARD_GAP = CHUNK;
const PANEL_REFRESH_MS = 500;
const SAMPLE_WINDOW_MS = 5000;
const SWEEP_DURATION_MS = 10000;
const SWEEP_DETAIL_ZOOM_MULT = 2.8;
const SPACE_TEXT_NODE_MAX = 1000;
const SPACE_TEXT_NODE_W = 384;
const SPACE_TEXT_NODE_H = 384;
const SPACE_TEXT_NODE_BATCH = 80;
const SPACE_IMAGE_NODE_MAX = 400;
const SPACE_IMAGE_NODE_W = 448;
const SPACE_IMAGE_NODE_BATCH = 6;
const SPACE_IMAGE_URL = 'stress_image.jpg';
// taglie realistiche delle generazioni (1K dominante, qualche 2K)
const SPACE_IMAGE_SIZES = [1024, 1024, 1344, 2048, 832];
const TEXTS = ['FABLE', 'M1M4.COM', 'DROP 01', 'PRINT TEST', 'VECTOR', 'CANVAS'];
const PALETTE = [
  [28, 88, 224], [241, 72, 96], [26, 176, 132], [248, 186, 44],
  [152, 91, 231], [245, 111, 47], [24, 24, 28], [255, 255, 255],
];
const PRESETS = [
  {
    id: 'light', label: 'Leggero',
    values: { boards: 4, layers: 4, textLayers: 1, paintedLayers: 2, chunksPerLayer: 4, marksPerChunk: 4, spaceTextNodes: 24, spaceImageNodes: 8 },
  },
  {
    id: 'medium', label: 'Medio',
    values: { boards: 8, layers: 8, textLayers: 2, paintedLayers: 4, chunksPerLayer: 8, marksPerChunk: 6, spaceTextNodes: 120, spaceImageNodes: 40 },
  },
  {
    id: 'heavy', label: 'Pesante',
    values: { boards: 12, layers: 12, textLayers: 3, paintedLayers: 8, chunksPerLayer: 18, marksPerChunk: 8, spaceTextNodes: 320, spaceImageNodes: 120 },
  },
  {
    id: 'ultra', label: 'Ultra pesante',
    values: { boards: 16, layers: 16, textLayers: 4, paintedLayers: 12, chunksPerLayer: 40, marksPerChunk: 10, spaceTextNodes: 640, spaceImageNodes: 240 },
  },
];

/** @typedef {import('./main.js').App} App */

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtMs(v) {
  return Number.isFinite(v) ? `${v.toFixed(v >= 100 ? 0 : 1)} ms` : '-';
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerpLog(a, b, t) {
  const lo = Math.max(0.0001, a);
  const hi = Math.max(0.0001, b);
  return Math.exp(lerp(Math.log(lo), Math.log(hi), t));
}

function medianLike(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function overPremul(data, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= CHUNK || y >= CHUNK || a <= 0) return;
  const o = ((y << 8) + x) * 4;
  const inv = 1 - a / 255;
  data[o] = Math.min(255, Math.round(r * a / 255 + data[o] * inv));
  data[o + 1] = Math.min(255, Math.round(g * a / 255 + data[o + 1] * inv));
  data[o + 2] = Math.min(255, Math.round(b * a / 255 + data[o + 2] * inv));
  data[o + 3] = Math.min(255, Math.round(a + data[o + 3] * inv));
}

function paintDab(data, cx, cy, radius, color, alpha) {
  const rr = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(CHUNK - 1, Math.ceil(cx + radius));
  const y1 = Math.min(CHUNK - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > rr) continue;
      const soft = 1 - Math.sqrt(d2 / rr);
      overPremul(data, x, y, color[0], color[1], color[2], Math.round(alpha * (0.35 + soft * 0.65)));
    }
  }
}

function paintStrokeInChunk(data, rng, markCount, variant) {
  for (let i = 0; i < markCount; i++) {
    const color = PALETTE[(variant + i + Math.floor(rng() * PALETTE.length)) % PALETTE.length];
    const radius = 4 + Math.floor(rng() * 12);
    const steps = 3 + Math.floor(rng() * 6);
    const sx = rng() * CHUNK;
    const sy = rng() * CHUNK;
    const len = 36 + rng() * 180;
    const angle = rng() * Math.PI * 2;
    const dx = Math.cos(angle) * len / Math.max(1, steps - 1);
    const dy = Math.sin(angle) * len / Math.max(1, steps - 1);
    const alpha = 72 + Math.floor(rng() * 150);
    for (let s = 0; s < steps; s++) {
      const wobble = (rng() - 0.5) * radius * 1.5;
      paintDab(data, sx + dx * s + wobble, sy + dy * s - wobble, radius, color, alpha);
    }
  }
}

function setDisabled(root, disabled) {
  for (const el of root.querySelectorAll('input, button, select')) {
    if (el.id === 'st-close') continue;
    el.disabled = disabled;
  }
}

export class StressTestPanel {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('stresspanel');
    this.body = document.getElementById('st-body');
    this.closeBtn = document.getElementById('st-close');
    this.toggleBtn = document.getElementById('btn-stress');
    this.fields = {};
    this.metrics = {};
    this.samples = [];
    this._lastFrameT = 0;
    this._lastPaintT = 0;
    this._gpuName = '';
    this._uaMemoryBytes = 0;
    this._uaMemoryT = 0;
    this._generating = false;
    this._sweep = null;
    this._build();
    this.toggleBtn.addEventListener('click', () => this.toggle());
    this.closeBtn.addEventListener('click', () => this.open(false));
    /** @type {any} */ (window).__stressTest = this;
  }

  toggle() { this.open(!this.panel.classList.contains('open')); }

  /** @param {boolean} v */
  open(v) {
    this.panel.classList.toggle('open', v);
    this.toggleBtn.classList.toggle('active', v);
    this.toggleBtn.setAttribute('aria-pressed', String(v));
    if (v) {
      this.app.ui.layersUI.open(false);
      this.app.ui.textUI.open(false);
      this.app.ui.svgUI.open(false);
      if (this.app.fxTools) for (const t of this.app.fxTools) t.openPanel(false);
      this.renderMetrics(true);
    }
  }

  _build() {
    this.body.textContent = '';
    this.body.appendChild(this._section('Presets'));
    const presets = document.createElement('div');
    presets.className = 'st-presets';
    for (const preset of PRESETS) {
      const btn = this._button(preset.label, () => this._applyPreset(preset));
      btn.classList.add('st-preset');
      btn.dataset.preset = preset.id;
      presets.appendChild(btn);
    }
    this.body.appendChild(presets);

    this.body.appendChild(this._section('Project'));
    this._addRange('boards', 'Artboards', 1, MAX_BOARDS, Math.min(8, MAX_BOARDS), 1);
    this._addRange('layers', 'Layers / artboard', 1, MAX_LAYERS, Math.min(12, MAX_LAYERS), 1);
    this._addRange('textLayers', 'Text layers / artboard', 0, MAX_LAYERS, 2, 1);
    this._addRange('paintedLayers', 'Painted raster layers', 0, MAX_LAYERS, 6, 1);
    this._addRange('chunksPerLayer', 'Drawn chunks / layer', 1, 64, 10, 1);
    this._addRange('marksPerChunk', 'Marks / chunk', 2, 12, 6, 1);
    this._addRange('spaceTextNodes', 'Spaces text nodes', 0, SPACE_TEXT_NODE_MAX, 120, 10);
    this._addRange('spaceImageNodes', 'Spaces image nodes', 0, SPACE_IMAGE_NODE_MAX, 40, 4);
    this._addRange('seed', 'Seed', 1, 9999, 44, 1);

    const actions = document.createElement('div');
    actions.className = 'st-actions';
    const generate = this._button('Generate', () => this.generate());
    const fit = this._button('Fit All', () => this.fitAll());
    const sweep = this._button('Sweep 10s', () => this.toggleSweep());
    this.generateBtn = generate;
    this.sweepBtn = sweep;
    actions.append(generate, fit, sweep);
    this.body.appendChild(actions);

    this.status = document.createElement('div');
    this.status.className = 'st-status';
    this.body.appendChild(this.status);

    this.body.appendChild(this._section('Console'));
    const grid = document.createElement('div');
    grid.className = 'st-metrics';
    for (const [id, label] of [
      ['fps', 'FPS'], ['frame', 'Frame'], ['p95', 'P95'],
      ['raster', 'Raster'], ['present', 'Present'], ['uploads', 'Uploads'],
      ['doc', 'Doc CPU'], ['heap', 'JS heap'], ['wasm', 'Wasm'],
      ['gpu', 'GPU est.'], ['boardMode', 'Artboards'], ['proxy', 'Proxy'],
      ['layerMode', 'Layers'], ['counts', 'Project'], ['spaces', 'Spaces'],
      ['renderer', 'Renderer'],
      ['device', 'Device'], ['ua', 'UA memory'],
    ]) {
      const row = document.createElement('div');
      row.className = 'st-metric';
      const k = document.createElement('span');
      k.textContent = label;
      const v = document.createElement('strong');
      v.textContent = '-';
      row.append(k, v);
      grid.appendChild(row);
      this.metrics[id] = v;
    }
    this.body.appendChild(grid);
    this._syncLimits();
    this._setStatus(`Limits: ${MAX_BOARDS} artboards, ${MAX_LAYERS} layers/artboard.`);
  }

  /** @param {string} title */
  _section(title) {
    const h = document.createElement('div');
    h.className = 'p-section';
    h.textContent = title;
    return h;
  }

  /** @param {string} label @param {() => void} onClick */
  _button(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'st-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  _addRange(id, label, min, max, value, step) {
    const row = document.createElement('label');
    row.className = 'p-row st-range';
    const head = document.createElement('div');
    head.className = 'p-row-head';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('span');
    val.className = 'p-val';
    head.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'st-num';
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = String(value);
    const sync = (raw) => {
      const lo = Number(input.min);
      const hi = Number(input.max);
      const v = Math.round(clamp(Number(raw) || lo, lo, hi));
      input.value = String(v);
      num.value = String(v);
      val.textContent = String(v);
      this._syncLimits();
    };
    input.addEventListener('input', () => sync(input.value));
    num.addEventListener('input', () => sync(num.value));
    row.append(head, input, num);
    this.body.appendChild(row);
    this.fields[id] = { input, num, val, min, max };
    sync(value);
  }

  /** @param {{id:string,label:string,values:Record<string,number>}} preset */
  _applyPreset(preset) {
    this._setValue('boards', preset.values.boards);
    this._setValue('layers', preset.values.layers);
    this._syncLimits();
    this._setValue('textLayers', preset.values.textLayers);
    this._syncLimits();
    this._setValue('paintedLayers', preset.values.paintedLayers);
    this._setValue('chunksPerLayer', preset.values.chunksPerLayer);
    this._setValue('marksPerChunk', preset.values.marksPerChunk);
    this._setValue('spaceTextNodes', preset.values.spaceTextNodes || 0);
    this._setValue('spaceImageNodes', preset.values.spaceImageNodes || 0);
    this._syncLimits();
    this._setStatus(`${preset.label}: valori caricati. Premi Generate per costruire il test.`);
  }

  /** @param {string} id @param {number} raw */
  _setValue(id, raw) {
    const f = this.fields[id];
    if (!f) return;
    const lo = Number(f.input.min);
    const hi = Number(f.input.max);
    const v = Math.round(clamp(raw, lo, hi));
    f.input.value = String(v);
    f.num.value = String(v);
    f.val.textContent = String(v);
  }

  _syncLimits() {
    if (!this.fields.layers) return;
    const layers = this._value('layers');
    this._setMax('textLayers', layers);
    if (!this.fields.textLayers || !this.fields.paintedLayers) return;
    const text = this._value('textLayers');
    this._setMax('paintedLayers', Math.max(0, layers - text));
    if (!this.fields.chunksPerLayer) return;
    this._setMax('chunksPerLayer', (BOARD_SIZE / CHUNK) ** 2);
  }

  /** @param {string} id */
  _value(id) {
    return Number(this.fields[id].input.value) || 0;
  }

  /** @param {string} id @param {number} max */
  _setMax(id, max) {
    const f = this.fields[id];
    if (!f) return;
    const next = Math.max(Number(f.input.min), Math.floor(max));
    f.input.max = String(next);
    f.num.max = String(next);
    if (Number(f.input.value) > next) {
      f.input.value = String(next);
      f.num.value = String(next);
    }
    f.val.textContent = f.input.value;
  }

  _options() {
    const layers = clamp(this._value('layers'), 1, MAX_LAYERS);
    const textLayers = clamp(this._value('textLayers'), 0, layers);
    const rasterLayers = layers - textLayers;
    return {
      boards: clamp(this._value('boards'), 1, MAX_BOARDS),
      layers,
      textLayers,
      rasterLayers,
      paintedLayers: clamp(this._value('paintedLayers'), 0, rasterLayers),
      chunksPerLayer: clamp(this._value('chunksPerLayer'), 1, (BOARD_SIZE / CHUNK) ** 2),
      marksPerChunk: clamp(this._value('marksPerChunk'), 1, 12),
      spaceTextNodes: clamp(this._value('spaceTextNodes'), 0, SPACE_TEXT_NODE_MAX),
      spaceImageNodes: clamp(this._value('spaceImageNodes'), 0, SPACE_IMAGE_NODE_MAX),
      seed: clamp(this._value('seed'), 1, 9999),
    };
  }

  async generate() {
    if (this._generating) return;
    if (!confirm('Replace the current project with a stress-test project?')) return;
    const opts = this._options();
    this._generating = true;
    this.stopSweep();
    setDisabled(this.body, true);
    this._setStatus('Preparing stress project...');
    try {
      await this._replaceProject(opts);
      this.fitAll();
      if (opts.spaceTextNodes > 0 || opts.spaceImageNodes > 0) {
        this.app.ui.setRailMode('spaces');
        this.open(true);
      }
      this.samples.length = 0;
      this._setStatus(`Generated ${opts.boards} artboards, ${opts.layers} layers each, ${opts.spaceTextNodes} Spaces text + ${opts.spaceImageNodes} image nodes.`);
      this.renderMetrics(true);
    } catch (err) {
      console.error(err);
      this._setStatus(err instanceof Error ? err.message : 'Stress generation failed.');
    } finally {
      this._generating = false;
      setDisabled(this.body, false);
    }
  }

  /** @param {ReturnType<StressTestPanel['_options']>} opts */
  async _replaceProject(opts) {
    const app = this.app;
    app._flushPendingStroke();
    app.cancelStroke();
    app.cancelLasso();
    app.selection.clear();
    app.transform.cancel();
    app.fx.escape();
    app.layerStyle.escape();
    if (app.fillUI) app.fillUI.dismiss();
    app.clearAll();
    app.ui?.spaceNodes?.clear();

    const first = app.boards.boards[0];
    this._emptyBoard(first);
    first.name = 'Stress 1';
    while (app.boards.boards.length < opts.boards && app.boards.canAdd) {
      app.boards.add(`Stress ${app.boards.boards.length + 1}`, BOARD_SIZE, BOARD_SIZE);
    }

    const cols = Math.ceil(Math.sqrt(opts.boards));
    for (let i = 0; i < app.boards.boards.length; i++) {
      const board = app.boards.boards[i];
      board.name = `Stress ${i + 1}`;
      board.w = BOARD_SIZE;
      board.h = BOARD_SIZE;
      board.x = (i % cols) * (BOARD_SIZE + BOARD_GAP);
      board.y = Math.floor(i / cols) * (BOARD_SIZE + BOARD_GAP);
      this._emptyBoard(board);
      this._fillBoard(board, i, opts);
      if (i % 2 === 1) {
        this._setStatus(`Generated ${i + 1}/${opts.boards} artboards...`);
        this.renderMetrics(true);
        await nextFrame();
      }
    }
    await this._fillSpaceTextNodes(opts);
    await this._fillSpaceImageNodes(opts);

    app.boards.activeId = app.boards.boards[0].id;
    app.boards.bump();
    app.undoMgr.clear();
    app.planes.invalidate();
    app.ui.layersUI.sync(true);
    app.ui.layersUI.scheduleThumbs();
  }

  /** @param {ReturnType<StressTestPanel['_options']>} opts */
  async _fillSpaceTextNodes(opts) {
    const nodes = this.app.ui?.spaceNodes;
    if (!nodes || opts.spaceTextNodes <= 0) return;
    const boards = this.app.boards.boards;
    if (!boards.length) return;
    const rng = mulberry32(opts.seed ^ 0x9E3779B9);
    for (let i = 0; i < opts.spaceTextNodes; i++) {
      const board = boards[i % boards.length];
      const cols = Math.max(1, Math.ceil(Math.sqrt(opts.spaceTextNodes / boards.length)));
      const cell = Math.min(board.w, board.h) / Math.max(2, cols + 1);
      const col = Math.floor(i / boards.length) % cols;
      const row = Math.floor(Math.floor(i / boards.length) / cols);
      const wobbleX = (rng() - 0.5) * cell * 0.28;
      const wobbleY = (rng() - 0.5) * cell * 0.28;
      const x = board.x + cell * (col + 1) + wobbleX;
      const y = board.y + cell * (row + 1) + wobbleY;
      const text = `${TEXTS[i % TEXTS.length]} prompt ${i + 1}`;
      nodes.createTextAtWorld(x, y, SPACE_TEXT_NODE_W, SPACE_TEXT_NODE_H, text, false);
      if (i % SPACE_TEXT_NODE_BATCH === SPACE_TEXT_NODE_BATCH - 1) {
        this._setStatus(`Generated ${i + 1}/${opts.spaceTextNodes} Spaces text nodes...`);
        this.renderMetrics(true);
        await nextFrame();
      }
    }
    nodes.sync(this.app.camera, true);
  }

  /**
   * Nodi image degli Spaces con risultato "generato": stress_image.jpg
   * decodificata in UN ImageBitmap per nodo (taglie realistiche 1K/2K) così
   * costo di disegno E memoria sono quelli veri di tante generazioni.
   * @param {ReturnType<StressTestPanel['_options']>} opts
   */
  async _fillSpaceImageNodes(opts) {
    const nodes = this.app.ui?.spaceNodes;
    if (!nodes || opts.spaceImageNodes <= 0) return;
    const boards = this.app.boards.boards;
    if (!boards.length) return;
    /** @type {Blob} */
    let blob;
    try {
      const res = await fetch(SPACE_IMAGE_URL);
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } catch {
      this._setStatus(`${SPACE_IMAGE_URL} non trovata: nodi image saltati.`);
      return;
    }
    const rng = mulberry32(opts.seed ^ 0x51ED270B);
    const count = opts.spaceImageNodes;
    for (let base = 0; base < count; base += SPACE_IMAGE_NODE_BATCH) {
      const n = Math.min(SPACE_IMAGE_NODE_BATCH, count - base);
      const bitmaps = await Promise.all(Array.from({ length: n }, (_, k) =>
        createImageBitmap(blob, { resizeWidth: SPACE_IMAGE_SIZES[(base + k) % SPACE_IMAGE_SIZES.length] })
      ));
      for (let k = 0; k < n; k++) {
        const i = base + k;
        const board = boards[i % boards.length];
        const cols = Math.max(1, Math.ceil(Math.sqrt(count / boards.length)));
        const cell = Math.min(board.w, board.h) / Math.max(2, cols + 1);
        const col = Math.floor(i / boards.length) % cols;
        const row = Math.floor(Math.floor(i / boards.length) / cols);
        // mezzo passo di offset: si intercalano coi nodi text senza coprirli
        const x = board.x + cell * (col + 0.5) + (rng() - 0.5) * cell * 0.28;
        const y = board.y + cell * (row + 0.5) + (rng() - 0.5) * cell * 0.28;
        nodes.createImageAtWorld(x, y, SPACE_IMAGE_NODE_W, bitmaps[k], `${TEXTS[i % TEXTS.length]} image ${i + 1}`, false);
      }
      this._setStatus(`Generated ${Math.min(base + n, count)}/${count} Spaces image nodes...`);
      this.renderMetrics(true);
      await nextFrame();
    }
    nodes.sync(this.app.camera, true);
  }

  _emptyBoard(board) {
    const app = this.app;
    for (const layer of board.mgr.layers) {
      if (layer.store) {
        layer.store.destroy(app._disposeTex);
        app._allStores.delete(layer.store);
      } else {
        freeBlockBitmap(layer);
      }
    }
    board.mgr.layers.length = 0;
    board.mgr.activeId = 0;
    board.mgr.bump();
  }

  /** @param {import('./boards.js').Board} board @param {number} boardIndex @param {ReturnType<StressTestPanel['_options']>} opts */
  _fillBoard(board, boardIndex, opts) {
    const app = this.app;
    const rng = mulberry32(opts.seed + boardIndex * 9973);
    for (let i = 0; i < opts.rasterLayers; i++) {
      const layer = makeRasterLayer(i < opts.paintedLayers ? `Paint ${i + 1}` : `Empty ${i + 1}`, app.heap);
      layer.opacity = 0.72 + rng() * 0.28;
      if (i % 5 === 4) layer.mode = BLEND_MODES[(boardIndex + i) % BLEND_MODES.length];
      app._allStores.add(layer.store);
      if (i < opts.paintedLayers) this._paintLayer(layer.store, board, boardIndex, i, opts, rng);
      board.mgr.insert(layer);
    }
    for (let i = 0; i < opts.textLayers; i++) {
      const style = defaultTextStyle();
      const font = TEXT_FONTS[(boardIndex + i) % TEXT_FONTS.length];
      style.font = font.family;
      style.weight = font.weight;
      style.stroke = i % 2 ? 3 : 0;
      style.strokeColor = '#ffffff';
      style.shadowDist = i % 3 === 0 ? 18 : 0;
      style.shadowBlur = i % 3 === 1 ? 10 : 0;
      style.block = i % 4 === 0;
      const col = PALETTE[(boardIndex * 3 + i) % PALETTE.length];
      const x = board.x + board.w * (0.25 + (i % 3) * 0.25);
      const y = board.y + board.h * (0.22 + (Math.floor(i / 3) % 3) * 0.24);
      const item = makeTextItem(x, y, `#${col.map((v) => v.toString(16).padStart(2, '0')).join('')}`, Math.round(board.w * (0.055 + rng() * 0.055)));
      item.text = `${TEXTS[(boardIndex + i) % TEXTS.length]} ${boardIndex + 1}.${i + 1}`;
      const layer = makeTextLayer(`Text ${i + 1}`, item, style);
      layer.opacity = 0.86 + rng() * 0.14;
      touchText(layer);
      board.mgr.insert(layer);
    }
  }

  /** @param {import('./store.js').ChunkStore} store @param {import('./boards.js').Board} board */
  _paintLayer(store, board, boardIndex, layerIndex, opts, rng) {
    const cols = board.w / CHUNK;
    const rows = board.h / CHUNK;
    const slots = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) slots.push([x, y]);
    }
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = slots[i];
      slots[i] = slots[j];
      slots[j] = t;
    }
    const n = Math.min(opts.chunksPerLayer, slots.length);
    for (let i = 0; i < n; i++) {
      const [lx, ly] = slots[i];
      const cx = (board.x >> 8) + lx;
      const cy = (board.y >> 8) + ly;
      const chunk = store.getOrCreate(cx, cy);
      paintStrokeInChunk(chunk.data, rng, opts.marksPerChunk, boardIndex + layerIndex + i);
      chunk.touched = true;
      store.markDirty(chunk);
    }
  }

  fitAll() {
    const bounds = this._sceneBounds();
    if (!bounds) return;
    const { x0, y0, x1, y1 } = bounds;
    const cam = this.app.camera;
    cam.x = (x0 + x1) / 2;
    cam.y = (y0 + y1) / 2;
    cam.zoom = clamp(Math.min(cam.w / Math.max(1, x1 - x0), cam.h / Math.max(1, y1 - y0)) * 0.82, 0.02, 4);
    cam.changed = true;
  }

  _sceneBounds() {
    const app = this.app;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of app.boards.boards) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    const nodes = app.ui?.spaceNodes?.nodes || [];
    for (const node of nodes) {
      x0 = Math.min(x0, node.x - node.w / 2);
      y0 = Math.min(y0, node.y - node.h / 2);
      x1 = Math.max(x1, node.x + node.w / 2);
      y1 = Math.max(y1, node.y + node.h / 2);
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }

  toggleSweep() {
    if (this._sweep) this.stopSweep();
    else this.startSweep();
  }

  startSweep() {
    const boards = this.app.boards.boards;
    if (boards.length < 2) return;
    this._sweep = { start: performance.now(), duration: SWEEP_DURATION_MS, bounds: this._sceneBounds() };
    this.sweepBtn.textContent = 'Stop Sweep';
    this._setStatus('Camera pan + zoom sweep running...');
  }

  stopSweep() {
    this._sweep = null;
    if (this.sweepBtn) this.sweepBtn.textContent = 'Sweep 10s';
  }

  /** @param {number} now */
  _advanceSweep(now) {
    if (!this._sweep) return;
    const boards = this.app.boards.boards;
    if (boards.length < 2) return this.stopSweep();
    const p = (now - this._sweep.start) / this._sweep.duration;
    if (p >= 1) {
      this.stopSweep();
      this._setStatus('Camera sweep complete.');
      return;
    }
    const scaled = p * (boards.length - 1);
    const i = Math.min(boards.length - 2, Math.floor(scaled));
    const f = scaled - i;
    const a = boards[i], b = boards[i + 1];
    const smooth = smoothstep(f);
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const cam = this.app.camera;
    const bounds = this._sweep.bounds || this._sceneBounds();
    const boardZoom = clamp(Math.min(cam.w / BOARD_SIZE, cam.h / BOARD_SIZE) * 0.72, 0.04, cam.maxZoom || 4);
    const detailZoom = clamp(boardZoom * SWEEP_DETAIL_ZOOM_MULT, boardZoom, cam.maxZoom || 4);
    const overviewZoom = bounds
      ? clamp(Math.min(cam.w / Math.max(1, bounds.x1 - bounds.x0), cam.h / Math.max(1, bounds.y1 - bounds.y0)) * 0.82, 0.02, boardZoom)
      : boardZoom;
    const zoomT = this._sweepZoomT(p);
    const zoom = zoomT < 0.5
      ? lerpLog(overviewZoom, boardZoom, zoomT * 2)
      : lerpLog(boardZoom, detailZoom, (zoomT - 0.5) * 2);
    const overviewWeight = clamp((boardZoom - zoom) / Math.max(0.0001, boardZoom - overviewZoom), 0, 1);
    const pathX = lerp(ax, bx, smooth);
    const pathY = lerp(ay, by, smooth);
    const sceneX = bounds ? (bounds.x0 + bounds.x1) / 2 : pathX;
    const sceneY = bounds ? (bounds.y0 + bounds.y1) / 2 : pathY;
    cam.x = lerp(pathX, sceneX, overviewWeight);
    cam.y = lerp(pathY, sceneY, overviewWeight);
    cam.zoom = zoom;
    cam.changed = true;
  }

  /** @param {number} p */
  _sweepZoomT(p) {
    const keys = [0, 0.5, 1, 0.55, 0, 0.5, 1, 0.55, 0];
    const scaled = clamp(p, 0, 1) * (keys.length - 1);
    const i = Math.min(keys.length - 2, Math.floor(scaled));
    const f = smoothstep(scaled - i);
    return lerp(keys[i], keys[i + 1], f);
  }

  /** @param {{frameMs:number,inputMs:number,rasterMs:number,presentMs:number,rasterPx:number,uploads:number,textBakes:number,textures:number}} frame */
  sampleFrame(frame) {
    const now = performance.now();
    if (this._lastFrameT) frame.gapMs = now - this._lastFrameT;
    this._lastFrameT = now;
    this.samples.push({ t: now, ...frame });
    while (this.samples.length && now - this.samples[0].t > SAMPLE_WINDOW_MS) this.samples.shift();
    this._advanceSweep(now);
    if (this.panel.classList.contains('open') && now - this._lastPaintT >= PANEL_REFRESH_MS) {
      this.renderMetrics();
      this._lastPaintT = now;
    }
  }

  /** @param {boolean} [force] */
  renderMetrics(force = false) {
    const now = performance.now();
    if (!force && now - this._lastPaintT < PANEL_REFRESH_MS) return;
    const app = this.app;
    const s = this.samples;
    const gaps = s.map((x) => x.gapMs || 0).filter(Boolean);
    const frames = s.map((x) => x.frameMs);
    const raster = s.map((x) => x.rasterMs);
    const present = s.map((x) => x.presentMs);
    const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const fps = gaps.length ? 1000 / avg(gaps) : 0;
    const stats = this._projectStats();
    const mem = /** @type {any} */ (performance).memory;
    this._sampleUaMemory(now);
    this.metrics.fps.textContent = fps ? fps.toFixed(1) : '-';
    this.metrics.frame.textContent = fmtMs(avg(frames));
    this.metrics.p95.textContent = fmtMs(medianLike(frames, 0.95));
    this.metrics.raster.textContent = `${fmtMs(avg(raster))} · ${Math.round(avg(s.map((x) => x.rasterPx || 0))).toLocaleString()} px`;
    this.metrics.present.textContent = fmtMs(avg(present));
    this.metrics.uploads.textContent = `${Math.round(avg(s.map((x) => x.uploads || 0)))} / frame`;
    this.metrics.doc.textContent = `${fmtBytes(stats.cpuLive)} live · ${fmtBytes(stats.cpuPool)} pool`;
    this.metrics.heap.textContent = mem ? `${fmtBytes(mem.usedJSHeapSize)} / ${fmtBytes(mem.jsHeapSizeLimit)}` : 'not exposed';
    this.metrics.wasm.textContent = app.heap ? fmtBytes(app.heap.memory.buffer.byteLength) : 'JS engine';
    this.metrics.gpu.textContent = `${fmtBytes(stats.gpuEstimate)} · chunks ${app.renderer.texCount} · proxies ${stats.proxy.proxyTextures}`;
    this.metrics.boardMode.textContent = `visible ${stats.proxy.visibleBoards} · live ${stats.proxy.liveBoards} · proxy ${stats.proxy.proxiedBoards}`;
    this.metrics.proxy.textContent = `${stats.proxy.readyProxies} ready · ${stats.proxy.loadingProxies} building · ${fmtBytes(stats.proxy.proxyBytes)}`;
    this.metrics.layerMode.textContent = `live ${stats.proxy.liveLayers} · skipped ${stats.proxy.proxiedLayers}`;
    this.metrics.counts.textContent = `${stats.boards} boards · ${stats.layers} layers · ${stats.chunks} chunks`;
    this.metrics.spaces.textContent = `${stats.spaceNodes.total} nodes · ${stats.spaceNodes.dom} DOM · ${stats.spaceNodes.full} full · ${stats.spaceNodes.proxy} proxy · edit ${stats.spaceNodes.editing} · sel ${stats.spaceNodes.selected}` +
      (stats.spaceNodes.images ? ` · img ${stats.spaceNodes.images} (${fmtBytes(stats.spaceNodes.imgBytes || 0)}, hq ${stats.spaceNodes.imgFull || 0})` : '');
    this.metrics.renderer.textContent = `${app.renderer.kind}${this._rendererName()}`;
    this.metrics.device.textContent = `${navigator.hardwareConcurrency || '?'} cores · ${navigator.deviceMemory || '?'} GB hint`;
    this.metrics.ua.textContent = this._uaMemoryBytes ? fmtBytes(this._uaMemoryBytes) : 'not exposed';
  }

  _projectStats() {
    const app = this.app;
    let layers = 0, chunks = 0, cpuLive = 0, cpuPool = 0, textBytes = 0;
    for (const b of app.boards.boards) {
      layers += b.mgr.layers.length;
      for (const l of b.mgr.layers) {
        if (l.store) {
          chunks += l.store.map.size;
        } else if (l.blockCanvas) {
          textBytes += (l.blockCanvas.width || 0) * (l.blockCanvas.height || 0) * 4;
        }
      }
    }
    for (const st of app._allStores) {
      cpuLive += st.map.size * CHUNK_BYTES;
      cpuPool += st._pool ? st._pool.length * CHUNK_BYTES : 0;
    }
    if (app.textQuads && app.textQuads._map) {
      for (const e of app.textQuads._map.values()) {
        if (e.canvas) textBytes += e.canvas.width * e.canvas.height * 4;
      }
    }
    let proxyBytes = 0;
    if (app.proxy && app.proxy._map) {
      for (const e of app.proxy._map.values()) if (e.tex) proxyBytes += 1024 * 1024 * 4;
    }
    const proxy = app.proxy && typeof app.proxy.stats === 'function'
      ? app.proxy.stats(app.boards, app.camera, app.boards.activeId)
      : {
        visibleBoards: 0, liveBoards: 0, proxiedBoards: 0,
        liveLayers: layers, proxiedLayers: 0,
        readyProxies: 0, loadingProxies: 0, proxyTextures: 0,
        proxyBytes,
      };
    const chunkGpu = app.renderer.gl ? app.renderer.texCount * CHUNK_BYTES : 0;
    const spaceNodes = app.ui?.spaceNodes?.stats?.() || { total: 0, dom: 0, full: 0, proxy: 0, editing: 0, selected: 0, images: 0, imgBytes: 0, imgFull: 0 };
    return {
      boards: app.boards.boards.length,
      layers,
      chunks,
      cpuLive,
      cpuPool,
      gpuEstimate: chunkGpu + proxyBytes + textBytes,
      proxy,
      spaceNodes,
    };
  }

  _rendererName() {
    if (this._gpuName) return ` · ${this._gpuName}`;
    const gl = this.app.renderer.gl;
    if (!gl) return '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this._gpuName = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch {
      this._gpuName = '';
    }
    return this._gpuName ? ` · ${this._gpuName}` : '';
  }

  /** @param {number} now */
  _sampleUaMemory(now) {
    const perf = /** @type {any} */ (performance);
    if (typeof perf.measureUserAgentSpecificMemory !== 'function') return;
    if (now - this._uaMemoryT < 10000) return;
    this._uaMemoryT = now;
    perf.measureUserAgentSpecificMemory()
      .then((r) => { this._uaMemoryBytes = r.bytes || 0; })
      .catch(() => { this._uaMemoryBytes = 0; });
  }

  /** @param {string} text */
  _setStatus(text) {
    if (this.status) this.status.textContent = text;
  }
}
