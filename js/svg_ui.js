import {
  listSvgPaints, setSvgPaintColor, setSvgPaintOpacity,
} from './svg_layer.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */

/** @param {number} v */
function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
}

/** @param {string} hex */
function cleanHex(hex) {
  const h = String(hex || '').trim();
  return /^#[0-9a-f]{6}$/i.test(h) ? h.toUpperCase() : '#000000';
}

/** @param {Layer|null} layer */
function svgLayerSig(layer) {
  if (!layer || !layer.svgItem) return '';
  return `${layer.id}|${layer.ver || 0}|${layer.svgItem.content.length}`;
}

const COLLAPSED_COLOR_COUNT = 4;

export class SvgUI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('svgpanel');
    this.body = document.getElementById('svg-body');
    this.opacityInput = /** @type {HTMLInputElement} */ (document.getElementById('svg-opacity-range'));
    this.opacityVal = document.getElementById('svg-opacity-val');
    this.listEl = document.getElementById('svg-colors');
    this.moreBtn = /** @type {HTMLButtonElement} */ (document.getElementById('svg-colors-more'));
    this.emptyEl = document.getElementById('svg-empty');
    this.rasterBtn = /** @type {HTMLButtonElement} */ (document.getElementById('svg-rasterize'));
    this._sig = '';
    /** @type {import('./svg_layer.js').SvgItem|null} */
    this._before = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._rebuildTimer = null;
    this._colorsExpanded = false;
    this._colorLayerId = 0;
    this._rasterizing = false;
    document.getElementById('svg-close').addEventListener('click', () => this.open(false));
    this.moreBtn.addEventListener('click', () => {
      this._colorsExpanded = !this._colorsExpanded;
      this.sync(true);
    });
    this.rasterBtn.addEventListener('click', async () => {
      const l = this.layer;
      if (!l || this._rasterizing) return;
      this._rasterizing = true;
      this.rasterBtn.disabled = true;
      const oldText = this.rasterBtn.textContent;
      this.rasterBtn.textContent = 'Rasterizing...';
      try {
        if (await this.app.rasterizeSvgLayer(l.id)) this.open(false);
      } finally {
        this._rasterizing = false;
        this.rasterBtn.disabled = false;
        this.rasterBtn.textContent = oldText;
      }
    });
    this.opacityInput.addEventListener('input', () => {
      const l = this.layer;
      if (!l) return;
      l.opacity = clamp01(parseFloat(this.opacityInput.value) / 100);
      this.opacityVal.textContent = Math.round(l.opacity * 100) + '%';
      this.app.planes.invalidate();
      this.app.ui.layersUI.sync(true);
    });
  }

  /** @returns {Layer|null} */
  get layer() {
    const l = this.app.layerMgr.active;
    return l && l.kind === 'svg' ? l : null;
  }

  /** @param {boolean} v */
  open(v) {
    if (v && !this.layer) return;
    this.panel.classList.toggle('open', v);
    if (!v) {
      this._before = null;
      this._colorsExpanded = false;
      if (this._rebuildTimer) {
        clearTimeout(this._rebuildTimer);
        this._rebuildTimer = null;
      }
      return;
    }
    this.app.ui.layersUI.open(false);
    this.app.ui.textUI.open(false);
    if (this.app.fxTools) for (const t of this.app.fxTools) t.openPanel(false);
    this.sync(true);
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  /** @param {boolean} [force] */
  sync(force = false) {
    if (!this.isOpen) return;
    const l = this.layer;
    if (!l || !l.svgItem) {
      this.open(false);
      return;
    }
    this.opacityInput.value = String(Math.round(l.opacity * 100));
    this.opacityVal.textContent = Math.round(l.opacity * 100) + '%';
    if (l.id !== this._colorLayerId) {
      this._colorLayerId = l.id;
      this._colorsExpanded = false;
    }
    const sig = svgLayerSig(l);
    if (this._before) {
      this._sig = sig;
      return;
    }
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this._buildColors(l);
  }

  _beginEdit() {
    const l = this.layer;
    if (!l || this._before) return;
    this._before = structuredClone(l.svgItem);
  }

  _commitEdit() {
    const l = this.layer;
    const before = this._before;
    this._before = null;
    if (!l || !before || !l.svgItem) return;
    if (JSON.stringify(before) === JSON.stringify(l.svgItem)) return;
    const board = this.app.boards.boardOfLayer(l.id);
    this.app.undoMgr.pushStruct(/** @type {any} */ ({
      op: 'svgitem', layerId: l.id, boardId: board ? board.id : this.app.boards.activeId,
      si0: before, si1: structuredClone(l.svgItem),
    }));
    this._scheduleRebuild();
  }

  _dirty() {
    const l = this.layer;
    if (!l) return;
    this.app.planes.invalidate();
    this.app.ui.layersUI.scheduleThumbs();
    this._sig = svgLayerSig(l);
  }

  _scheduleRebuild() {
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      if (!this.isOpen || this._before) return;
      this.sync(true);
    }, 120);
  }

  /** @param {Layer} layer */
  _buildColors(layer) {
    this.listEl.textContent = '';
    const paints = listSvgPaints(layer.svgItem);
    this.emptyEl.hidden = paints.length > 0;
    const shown = this._colorsExpanded ? paints : paints.slice(0, COLLAPSED_COLOR_COUNT);
    this.moreBtn.hidden = paints.length <= COLLAPSED_COLOR_COUNT;
    this.moreBtn.textContent = this._colorsExpanded ? 'Show fewer colors' : 'Show all colors';
    this.moreBtn.setAttribute('aria-expanded', String(this._colorsExpanded));
    for (const paint of shown) {
      this.listEl.appendChild(this._colorRow(paint));
    }
  }

  /** @param {import('./svg_layer.js').SvgPaint} paint */
  _colorRow(paint) {
    const row = document.createElement('div');
    row.className = 'svg-color-row';
    row.dataset.key = paint.key;
    row.dataset.hex = paint.hex;
    row.dataset.opacity = String(paint.opacity);

    const color = document.createElement('input');
    color.type = 'color';
    color.className = 'svg-color-input';
    color.value = paint.hex;
    color.title = 'Color';

    const name = document.createElement('span');
    name.className = 'svg-color-name';
    name.textContent = paint.hex.slice(1);
    name.title = `${paint.count} occurrence${paint.count === 1 ? '' : 's'}`;

    const op = document.createElement('input');
    op.type = 'number';
    op.className = 'svg-color-opacity';
    op.min = '0';
    op.max = '100';
    op.step = '1';
    op.value = String(Math.round(paint.opacity * 100));
    op.title = 'Opacity';

    const pct = document.createElement('span');
    pct.className = 'svg-pct';
    pct.textContent = '%';

    const arm = () => this._beginEdit();
    color.addEventListener('pointerdown', arm);
    color.addEventListener('focus', arm);
    color.addEventListener('input', () => {
      const l = this.layer;
      if (!l) return;
      const oldKey = row.dataset.key || paint.key;
      const nextHex = cleanHex(color.value);
      if (!setSvgPaintColor(l, oldKey, nextHex)) return;
      row.dataset.hex = nextHex;
      name.textContent = nextHex.slice(1);
      this._dirty();
    });
    color.addEventListener('change', () => this._commitEdit());

    op.addEventListener('pointerdown', arm);
    op.addEventListener('focus', arm);
    op.addEventListener('input', () => {
      const l = this.layer;
      if (!l) return;
      const oldKey = row.dataset.key || paint.key;
      const alpha = clamp01(parseFloat(op.value) / 100);
      if (!setSvgPaintOpacity(l, oldKey, alpha)) return;
      row.dataset.opacity = String(alpha);
      this._dirty();
    });
    op.addEventListener('change', () => {
      op.value = String(Math.round(clamp01(parseFloat(op.value) / 100) * 100));
      this._commitEdit();
    });

    row.append(color, name, op, pct);
    return row;
  }
}
