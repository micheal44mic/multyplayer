/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */

export class VectorizeUI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.layerId = 0;
    this.busy = false;

    this.backdrop = document.createElement('div');
    this.backdrop.id = 'vectorize-backdrop';
    this.backdrop.hidden = true;

    const panel = document.createElement('section');
    panel.id = 'vectorize-dialog';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Vectorize');
    panel.innerHTML = `
      <div id="vz-head">
        <span>Vectorize</span>
        <button id="vz-close" class="tb-btn" type="button" title="Close">✕</button>
      </div>
      <div id="vz-body">
        <div class="p-row">
          <div class="p-row-head"><span>Layer</span><span id="vz-layer" class="p-val"></span></div>
        </div>
        <div class="p-row">
          <div class="p-row-head"><span>Mode</span></div>
          <select id="vz-mode">
            <option value="color">Color</option>
            <option value="bw">Black ink</option>
          </select>
        </div>
        <div id="vz-colors-row" class="p-row">
          <div class="p-row-head"><span>Colors</span></div>
          <select id="vz-colors">
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="8" selected>8</option>
            <option value="16">16</option>
            <option value="32">32</option>
          </select>
        </div>
        <progress id="vz-progress" max="100" value="0" hidden></progress>
        <div id="vz-status" class="p-hint"></div>
        <div id="vz-actions">
          <button id="vz-cancel" class="vz-btn" type="button">Cancel</button>
          <button id="vz-run" class="vz-btn primary" type="button">Vectorize</button>
        </div>
      </div>`;
    this.backdrop.appendChild(panel);
    document.body.appendChild(this.backdrop);

    this.layerEl = panel.querySelector('#vz-layer');
    this.modeSel = /** @type {HTMLSelectElement} */ (panel.querySelector('#vz-mode'));
    this.colorsRow = /** @type {HTMLElement} */ (panel.querySelector('#vz-colors-row'));
    this.colorsSel = /** @type {HTMLSelectElement} */ (panel.querySelector('#vz-colors'));
    this.progress = /** @type {HTMLProgressElement} */ (panel.querySelector('#vz-progress'));
    this.statusEl = panel.querySelector('#vz-status');
    this.runBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('#vz-run'));
    this.cancelBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('#vz-cancel'));
    this.closeBtn = /** @type {HTMLButtonElement} */ (panel.querySelector('#vz-close'));

    this.modeSel.addEventListener('change', () => this._syncMode());
    this.runBtn.addEventListener('click', () => this._run());
    this.cancelBtn.addEventListener('click', () => this.close());
    this.closeBtn.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
  }

  get isOpen() { return !this.backdrop.hidden; }

  /** @param {Layer} layer */
  open(layer) {
    if (!layer || layer.kind !== 'raster') return;
    this.layerId = layer.id;
    this.busy = false;
    this.layerEl.textContent = layer.name || 'Layer';
    this.modeSel.value = 'color';
    this.colorsSel.value = '8';
    this.progress.hidden = true;
    this.progress.value = 0;
    this.statusEl.textContent = '';
    this._setBusy(false);
    this._syncMode();
    this.backdrop.hidden = false;
    requestAnimationFrame(() => this.runBtn.focus());
  }

  close() {
    if (this.busy) return;
    this.backdrop.hidden = true;
    this.layerId = 0;
  }

  _syncMode() {
    this.colorsRow.hidden = this.modeSel.value === 'bw';
  }

  /** @param {boolean} v */
  _setBusy(v) {
    this.busy = v;
    this.runBtn.disabled = v;
    this.cancelBtn.disabled = v;
    this.closeBtn.disabled = v;
    this.modeSel.disabled = v;
    this.colorsSel.disabled = v;
    this.runBtn.textContent = v ? 'Vectorizing...' : 'Vectorize';
  }

  async _run() {
    if (this.busy || !this.layerId) return;
    this._setBusy(true);
    this.progress.hidden = false;
    this.progress.value = 0;
    this.statusEl.textContent = 'Preparing...';
    const options = {
      mode: /** @type {'bw'|'color'} */ (this.modeSel.value),
      colors: parseInt(this.colorsSel.value, 10) || 8,
    };
    try {
      const ok = await this.app.vectorizeRasterLayer(this.layerId, options, (progress) => {
        this.progress.value = progress;
        this.statusEl.textContent = progress >= 100 ? 'Finishing...' : `${Math.round(progress)}%`;
      });
      if (ok) {
        this._setBusy(false);
        this.backdrop.hidden = true;
      } else {
        this._setBusy(false);
      }
    } catch (err) {
      console.error(err);
      this.statusEl.textContent = err instanceof Error ? err.message : 'Vectorize failed.';
      this._setBusy(false);
    }
  }
}
