// Pannello Testo — laterale destro, non modale: edita lo stile del livello
// testo SELEZIONATO vedendo il risultato live. Il bottone Testo in toolbar
// crea ogni volta un NUOVO livello testo sopra quello attivo.

import { TEXT_FONTS, ensureFont, defaultTextStyle, makeTextItem } from './text_layer.js';
import { makeTextLayer } from './layers.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */

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

  // Livello testo in editing: quello attivo, se è un testo.
  /** @returns {Layer|null} */
  get layer() {
    const l = this.app.layerMgr.active;
    return l && l.kind === 'text' ? l : null;
  }

  // Bottone Testo: nuovo livello testo centrato nella vista corrente,
  // largo ~80% dello schermo a qualunque zoom (M1M4.COM ≈ 5.7 em).
  placeAtView() {
    const app = this.app;
    if (!app.layerMgr.canAdd) { alert('Massimo numero di livelli raggiunto.'); return; }
    const cam = app.camera;
    const fill = /** @type {HTMLInputElement} */ (document.getElementById('color')).value;
    const size = Math.max(8, (cam.w / cam.zoom) * 0.8 / 5.7);
    const item = makeTextItem(cam.x, cam.y, fill, size);
    const layer = makeTextLayer('Testo', item, defaultTextStyle());
    app.addLayer(layer);
    ensureFont(layer.style.font, layer.style.weight);
    this.open(true);
  }

  /** @param {boolean} v */
  open(v) {
    if (v && !this.layer) return; // niente livello testo selezionato
    this.panel.classList.toggle('open', v);
    if (!v) return;
    this.app.ui.layersUI.open(false); // un pannello alla volta sul lato destro
    for (const f of this._sync) f();
    if (!this._fontsKicked) {
      // pre-carica tutta la lista in background: il cambio font è istantaneo
      this._fontsKicked = true;
      for (const f of TEXT_FONTS) ensureFont(f.family, f.weight);
    }
  }

  // Lo stile è cambiato: SVG da risincronizzare + miniatura del pannello.
  _dirty() {
    const l = this.layer;
    if (!l) return;
    l.styleDirty = true;
    l.thumbDirty = true;
    this.app.ui.layersUI.scheduleThumbs();
  }

  _build() {
    const body = document.getElementById('tp-body');
    /** @type {(fn: (st: import('./text_layer.js').TextStyle) => void) => void} */
    const withStyle = (fn) => {
      const l = this.layer;
      if (!l) return;
      fn(l.style);
      this._dirty();
    };
    /** @type {<T>(fn: (st: import('./text_layer.js').TextStyle) => T, fallback: T) => T} */
    const readStyle = (fn, fallback) => {
      const l = this.layer;
      return l ? fn(l.style) : fallback;
    };

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
    sel.addEventListener('change', () => {
      const def = TEXT_FONTS.find((f) => f.family === sel.value);
      if (!def) return;
      withStyle((st) => { st.font = def.family; st.weight = def.weight; });
      ensureFont(def.family, def.weight);
    });
    this._sync.push(() => { sel.value = readStyle((st) => st.font, 'Orbitron'); });
    body.appendChild(sel);

    body.appendChild(this._section('Bordo'));
    body.appendChild(this._slider('Spessore', 0, 24, 0.5,
      () => readStyle((st) => st.stroke, 0),
      (v) => withStyle((st) => { st.stroke = v; }),
      (v) => v.toFixed(1) + ' px'));
    body.appendChild(this._color('Colore bordo',
      () => readStyle((st) => st.strokeColor, '#ffffff'),
      (v) => withStyle((st) => { st.strokeColor = v; })));

    body.appendChild(this._section('Ombra'));
    body.appendChild(this._slider('Sfocatura', 0, 80, 1,
      () => readStyle((st) => st.shadowBlur, 0),
      (v) => withStyle((st) => { st.shadowBlur = v; }),
      (v) => v + ' px'));
    body.appendChild(this._slider('Distanza', 0, 80, 1,
      () => readStyle((st) => st.shadowDist, 0),
      (v) => withStyle((st) => { st.shadowDist = v; }),
      (v) => v + ' px'));
    body.appendChild(this._color('Colore ombra',
      () => readStyle((st) => st.shadowColor, '#000000'),
      (v) => withStyle((st) => { st.shadowColor = v; })));
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
