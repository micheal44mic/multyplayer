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
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 }; // visibleRect riusato
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

  // Bottone Testo: nuovo livello testo centrato nel CANVAS attivo (quello
  // dove si è disegnato/toccato l'ultima volta), con corpo proporzionale al
  // canvas (M1M4.COM ≈ 5.7 em sull'80% della larghezza): a qualunque zoom il
  // testo nasce della stessa taglia relativa al suo canvas. Se il centro del
  // canvas è fuori vista, la camera lo inquadra: il testo appena creato si
  // vede sempre.
  placeAtView() {
    const app = this.app;
    if (!app.layerMgr.canAdd) { alert('Massimo numero di livelli raggiunto.'); return; }
    const board = app.boards.active;
    const cx = board.x + board.w / 2, cy = board.y + board.h / 2;
    const fill = /** @type {HTMLInputElement} */ (document.getElementById('color')).value;
    const size = Math.max(8, board.w * 0.8 / 5.7);
    const item = makeTextItem(cx, cy, fill, size);
    const layer = makeTextLayer('Testo', item, defaultTextStyle());
    app.addLayer(layer);
    const r = app.camera.visibleRect(this._rect);
    if (cx < r.x0 || cx > r.x1 || cy < r.y0 || cy > r.y1) app.fitBoard(board);
    ensureFont(layer.style.font, layer.style.weight);
    this.open(true);
    // si può riscrivere subito: focus dopo il sync di open (che rimette
    // il testo del livello nel campo) e fuori dall'evento che ci ha chiamato
    requestAnimationFrame(() => {
      this._textInput.focus();
      this._textInput.select();
    });
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
    /** @type {(fn: (it: import('./text_layer.js').TextItem) => void) => void} */
    const withItem = (fn) => {
      const l = this.layer;
      if (!l) return;
      fn(l.item);
      this._dirty();
    };
    /** @type {<T>(fn: (it: import('./text_layer.js').TextItem) => T, fallback: T) => T} */
    const readItem = (fn, fallback) => {
      const l = this.layer;
      return l ? fn(l.item) : fallback;
    };

    body.appendChild(this._section('Testo'));
    const txt = document.createElement('input');
    txt.type = 'text';
    txt.className = 'tp-text';
    txt.placeholder = 'Scrivi qualcosa…';
    txt.autocomplete = 'off';
    txt.spellcheck = false;
    // ogni tasto = un setAttribute al frame dopo (via styleDirty): l'SVG è
    // vettoriale, il browser ridipinge solo quel piano — nessun raster
    txt.addEventListener('input', () => withItem((it) => { it.text = txt.value; }));
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') txt.blur();
    });
    this._sync.push(() => { txt.value = readItem((it) => it.text, ''); });
    body.appendChild(txt);
    this._textInput = txt;

    body.appendChild(this._slider('Dimensione', 4, 2000, 1,
      () => readItem((it) => it.size, 70),
      (v) => withItem((it) => { it.size = v; }),
      (v) => Math.round(v) + ' px', true));

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
    body.appendChild(this._toggle('Blocco 3D',
      'estrusione solida invece dell\'ombra morbida',
      () => readStyle((st) => st.block, false),
      (v) => withStyle((st) => {
        st.block = v;
        // acceso con distanza 0 non si vedrebbe: parte da un blocco visibile
        if (v && st.shadowDist === 0) st.shadowDist = 12;
      })));
    body.appendChild(this._slider('Sfocatura', 0, 80, 1,
      () => readStyle((st) => st.shadowBlur, 0),
      (v) => withStyle((st) => { st.shadowBlur = v; }),
      (v) => v + ' px'));
    body.appendChild(this._slider('Distanza', 0, 80, 1,
      () => readStyle((st) => st.shadowDist, 0),
      (v) => withStyle((st) => { st.shadowDist = v; }),
      (v) => v + ' px'));
    body.appendChild(this._slider('Angolo', 0, 360, 1,
      () => readStyle((st) => st.shadowAngle ?? 45, 45),
      (v) => withStyle((st) => { st.shadowAngle = v; }),
      (v) => Math.round(v) + '°'));
    body.appendChild(this._slider('Opacità', 5, 100, 1,
      () => readStyle((st) => (st.shadowOpacity ?? 0.65) * 100, 65),
      (v) => withStyle((st) => { st.shadowOpacity = v / 100; }),
      (v) => Math.round(v) + '%'));
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
   * log: lo slider lavora in scala logaritmica (range enormi tipo il corpo
   * del font), il valore del modello resta in unità vere.
   * @param {string} label @param {number} min @param {number} max @param {number} step
   * @param {() => number} get @param {(v: number) => void} set @param {(v: number) => string} fmt
   * @param {boolean} [log]
   */
  _slider(label, min, max, step, get, set, fmt, log) {
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
    if (log) {
      input.min = String(Math.log(min));
      input.max = String(Math.log(max));
      input.step = String((Math.log(max) - Math.log(min)) / 500);
    } else {
      input.min = String(min); input.max = String(max); input.step = String(step);
    }
    const refresh = () => {
      const v = get();
      input.value = String(log ? Math.log(Math.max(min, Math.min(max, v))) : v);
      val.textContent = fmt(v);
    };
    input.addEventListener('input', () => {
      let v = log ? Math.exp(parseFloat(input.value)) : parseFloat(input.value);
      if (step >= 1) v = Math.round(v);
      set(v);
      val.textContent = fmt(get());
    });
    this._sync.push(refresh);
    refresh();
    row.append(head, input);
    return row;
  }

  /**
   * @param {string} label @param {string} hint
   * @param {() => boolean} get @param {(v: boolean) => void} set
   */
  _toggle(label, hint, get, set) {
    const lab = document.createElement('label');
    lab.className = 'p-toggle';
    const span = document.createElement('span');
    span.textContent = label;
    const h = document.createElement('span');
    h.className = 'p-hint';
    h.textContent = hint;
    span.appendChild(h);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => {
      set(input.checked);
      // il set può toccare altri valori (es. la distanza): riallinea il pannello
      for (const f of this._sync) f();
    });
    this._sync.push(() => { input.checked = get(); });
    const knob = document.createElement('span');
    knob.className = 'knob';
    lab.append(span, input, knob);
    return lab;
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
