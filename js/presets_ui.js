// Popup dei preset pennello — ancorato sotto il bottone Pennello in toolbar.
// Si apre al SECONDO tocco del bottone (il primo seleziona lo strumento,
// come nelle app di disegno). Ogni card mostra l'anteprima del tratto VERO
// del preset (stessa pipeline del canvas, seed fisso): renderizzate una
// volta sola alla prima apertura, con un unico motore di preview ri-puntato
// di card in card.

import { BRUSH_PRESETS, applyPreset, presetConfig } from './brush_presets.js';
import { BrushPreview } from './brush_preview.js';

/** @typedef {import('./ui.js').UI} UI */

export class PresetsUI {
  /** @param {UI} ui */
  constructor(ui) {
    this.ui = ui;
    this.panel = document.getElementById('presetspopup');
    this._built = false;
    this._rendered = false;
    this._activeName = '';
    /** @type {{preset: import('./brush_presets.js').BrushPreset, card: HTMLElement, canvas: HTMLCanvasElement}[]} */
    this._cards = [];
    /** @type {BrushPreview|null} */
    this._pv = null;

    // tocco fuori dal popup: chiude (il bottone Pennello fa già il toggle)
    window.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      const t = /** @type {Node} */ (e.target);
      if (this.panel.contains(t)) return;
      if (document.getElementById('tool-brush').contains(t)) return;
      this.open(false);
    });
    window.addEventListener('resize', () => { if (this.isOpen) this._place(); });
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  toggle() { this.open(!this.isOpen); }

  /** @param {boolean} v */
  open(v) {
    if (v && !this._built) this._build();
    this.panel.classList.toggle('open', v);
    if (!v) return;
    this._place();
    if (!this._rendered) {
      this._rendered = true;
      // dopo il layout: le card hanno bisogno delle dimensioni CSS reali
      requestAnimationFrame(() => this._renderThumbs());
    }
  }

  // Ancoraggio sotto il bottone Pennello, dentro i bordi dello schermo.
  _place() {
    const r = document.getElementById('tool-brush').getBoundingClientRect();
    const w = this.panel.offsetWidth || 336;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    this.panel.style.left = left + 'px';
    this.panel.style.top = (r.bottom + 10) + 'px';
  }

  _build() {
    this._built = true;
    const head = document.createElement('div');
    head.className = 'bp-head';
    head.textContent = 'Pennelli';
    const grid = document.createElement('div');
    grid.className = 'bp-grid';
    for (const preset of BRUSH_PRESETS) {
      const card = document.createElement('button');
      card.className = 'bp-card';
      card.type = 'button';
      const canvas = document.createElement('canvas');
      canvas.className = 'bp-thumb';
      const name = document.createElement('div');
      name.className = 'bp-name';
      name.textContent = preset.name;
      card.append(canvas, name);
      card.addEventListener('click', () => this._pick(preset));
      grid.appendChild(card);
      this._cards.push({ preset, card, canvas });
    }
    this.panel.append(head, grid);
  }

  /** @param {import('./brush_presets.js').BrushPreset} preset */
  _pick(preset) {
    applyPreset(preset);
    this._activeName = preset.name;
    for (const c of this._cards) c.card.classList.toggle('active', c.preset.name === preset.name);
    this.ui.notifyBrushChanged();
    this.open(false);
  }

  _renderThumbs() {
    if (this._cards.length === 0) return;
    if (!this._pv) this._pv = new BrushPreview(this._cards[0].canvas);
    const pv = this._pv;
    for (const c of this._cards) {
      pv.canvas = c.canvas;
      pv.ctx = /** @type {CanvasRenderingContext2D} */ (c.canvas.getContext('2d'));
      pv._checker = null; // il pattern scacchiera è legato al contesto precedente
      pv.render(presetConfig(c.preset));
    }
  }
}
