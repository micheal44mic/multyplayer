// Pannello Testo — laterale destro, non modale: si regola lo stile vedendo
// il risultato live sul canvas. Stesse classi di riga del Brush Studio.

import { TEXT_FONTS, ensureFont } from './text_layer.js';

/** @typedef {import('./main.js').App} App */

export class TextUI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('textpanel');
    this._fontsKicked = false;
    /** @type {(() => void)[]} */
    this._sync = [];
    this._build();
    document.getElementById('tp-close').addEventListener('click', () => this.open(false));
  }

  get layer() { return this.app.textLayer; }

  // Click sul bottone Testo: il testo appare centrato nella vista corrente,
  // largo ~80% dello schermo a qualunque zoom (M1M4.COM ≈ 5.7 em di larghezza).
  placeAtView() {
    const cam = this.app.camera;
    const fill = /** @type {HTMLInputElement} */ (document.getElementById('color')).value;
    const size = Math.max(8, (cam.w / cam.zoom) * 0.8 / 5.7);
    this.layer.place(cam.x, cam.y, fill, size);
    this.open(true);
  }

  /** @param {boolean} v */
  open(v) {
    this.panel.classList.toggle('open', v);
    if (!v) return;
    for (const f of this._sync) f();
    if (!this._fontsKicked) {
      // pre-carica tutta la lista in background: il cambio font è istantaneo
      this._fontsKicked = true;
      for (const f of TEXT_FONTS) ensureFont(f.family, f.weight);
    }
  }

  _build() {
    const body = document.getElementById('tp-body');
    const st = this.layer.style; // identità stabile: mai sostituito
    const dirty = () => { this.layer.styleDirty = true; };

    body.appendChild(this._section('Font'));
    const sel = document.createElement('select');
    sel.className = 'tp-select';
    for (const f of TEXT_FONTS) {
      const o = document.createElement('option');
      o.value = f.family;
      o.textContent = f.family;
      o.style.fontFamily = `"${f.family}", sans-serif`;
      sel.appendChild(o);
    }
    sel.value = st.font;
    sel.addEventListener('change', () => this.layer.setFont(sel.value));
    this._sync.push(() => { sel.value = st.font; });
    body.appendChild(sel);

    body.appendChild(this._section('Bordo'));
    body.appendChild(this._slider('Spessore', 0, 24, 0.5,
      () => st.stroke, (v) => { st.stroke = v; dirty(); }, (v) => v.toFixed(1) + ' px'));
    body.appendChild(this._color('Colore bordo',
      () => st.strokeColor, (v) => { st.strokeColor = v; dirty(); }));

    body.appendChild(this._section('Ombra'));
    body.appendChild(this._slider('Sfocatura', 0, 80, 1,
      () => st.shadowBlur, (v) => { st.shadowBlur = v; dirty(); }, (v) => v + ' px'));
    body.appendChild(this._slider('Distanza', 0, 80, 1,
      () => st.shadowDist, (v) => { st.shadowDist = v; dirty(); }, (v) => v + ' px'));
    body.appendChild(this._color('Colore ombra',
      () => st.shadowColor, (v) => { st.shadowColor = v; dirty(); }));
  }

  /** @param {string} title */
  _section(title) {
    const h = document.createElement('div');
    h.className = 'p-section';
    h.textContent = title;
    return h;
  }

  /**
   * @param {string} label @param {number} min @param {number} max @param {number} step
   * @param {() => number} get @param {(v: number) => void} set @param {(v: number) => string} fmt
   */
  _slider(label, min, max, step, get, set, fmt) {
    const row = document.createElement('div');
    row.className = 'p-row';
    const head = document.createElement('div');
    head.className = 'p-row-head';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('span');
    val.className = 'p-val';
    head.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    const refresh = () => {
      input.value = String(get());
      val.textContent = fmt(get());
    };
    input.addEventListener('input', () => {
      set(parseFloat(input.value));
      val.textContent = fmt(get());
    });
    this._sync.push(refresh);
    refresh();
    row.append(head, input);
    return row;
  }

  /**
   * @param {string} label @param {() => string} get @param {(v: string) => void} set
   */
  _color(label, get, set) {
    const row = document.createElement('label');
    row.className = 'tp-colorrow';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = get();
    input.addEventListener('input', () => set(input.value));
    this._sync.push(() => { input.value = get(); });
    row.append(span, input);
    return row;
  }
}
