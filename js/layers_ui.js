// Pannello Livelli — lato destro (bottom sheet su mobile), riga in alto =
// livello in cima. Selezione del livello attivo, occhio, opacità del
// selezionato, drag & drop dalla maniglia, doppio click per rinominare,
// nuovo/duplica/elimina. Miniature rigenerate con debounce, mai nel frame.

import { CHUNK } from './store.js';
import { makeRasterLayer, makeTextLayer, refreshClipBases, MAX_LAYERS } from './layers.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */

const THUMB = 44;

export class LayersUI {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    this.panel = document.getElementById('layerspanel');
    this.listEl = document.getElementById('ly-list');
    this.opacityRow = document.getElementById('ly-opacity');
    this.opacityInput = /** @type {HTMLInputElement} */ (document.getElementById('ly-opacity-range'));
    this.opacityVal = document.getElementById('ly-opacity-val');
    this.modeRow = document.getElementById('ly-mode');
    this.modeSel = /** @type {HTMLSelectElement} */ (document.getElementById('ly-mode-sel'));
    this.importBtn = /** @type {HTMLButtonElement} */ (document.getElementById('ly-import'));
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;
    this.panel.appendChild(this.fileInput);
    this._epoch = 0;
    /** @type {Map<number, HTMLCanvasElement>} layerId -> canvas miniatura */
    this._thumbs = new Map();
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._thumbTimer = null;

    document.getElementById('ly-close').addEventListener('click', () => this.open(false));
    document.getElementById('ly-add').addEventListener('click', () => this._addRaster());
    this.importBtn.addEventListener('click', () => this._pickImage());
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = '';
      if (f) this.app.importImageLayer(f);
    });
    document.getElementById('ly-dup').addEventListener('click', () => this._duplicate());
    document.getElementById('ly-del').addEventListener('click', () => this._delete());
    this.opacityInput.addEventListener('input', () => {
      const l = this.app.layerMgr.active;
      if (!l) return;
      l.opacity = parseFloat(this.opacityInput.value) / 100;
      this.opacityVal.textContent = Math.round(l.opacity * 100) + '%';
      if (l.kind === 'text') l.styleDirty = true;
      this.app.planes.invalidate();
    });
    this.modeSel.addEventListener('change', () => {
      const l = this.app.layerMgr.active;
      if (!l || l.kind !== 'raster') return;
      this.app.setModeUndoable(l.id,
        /** @type {import('./layers.js').BlendMode} */ (this.modeSel.value));
    });
  }

  /** @param {boolean} v */
  open(v) {
    this.panel.classList.toggle('open', v);
    if (!v) return;
    this.app.ui.textUI.open(false); // un pannello alla volta sul lato destro
    if (this.app.fxTools) for (const t of this.app.fxTools) t.openPanel(false);
    this.sync(true);
    this.scheduleThumbs();
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  toggle() { this.open(!this.isOpen); }

  /** @param {boolean} v */
  setImportBusy(v) {
    this.importBtn.disabled = v;
  }

  // Chiamata dal frame loop: ricostruisce la lista solo se la struttura è
  // cambiata da quando l'abbiamo vista l'ultima volta (epoch).
  /** @param {boolean} [force] */
  sync(force) {
    const mgr = this.app.layerMgr;
    if (!force && this._epoch === mgr.epoch) return;
    this._epoch = mgr.epoch;
    if (!this.isOpen) return;
    this._rebuildList();
  }

  _rebuildList() {
    const mgr = this.app.layerMgr;
    // base effettiva delle maschere di ritaglio: decide rientro e freccia
    // (il frame loop la ricalcola comunque prima del render)
    refreshClipBases(mgr.layers);
    this.listEl.textContent = '';
    // dall'alto verso il basso: l'ultima della lista è la prima riga
    for (let i = mgr.layers.length - 1; i >= 0; i--) {
      this.listEl.appendChild(this._buildRow(mgr.layers[i]));
    }
    this._refreshSelection();
  }

  _refreshSelection() {
    const mgr = this.app.layerMgr;
    for (const el of this.listEl.children) {
      const row = /** @type {HTMLElement} */ (el);
      row.classList.toggle('selected', Number(row.dataset.id) === mgr.activeId);
    }
    const act = mgr.active;
    this.opacityRow.classList.toggle('p-off', !act);
    if (act) {
      this.opacityInput.value = String(Math.round(act.opacity * 100));
      this.opacityVal.textContent = Math.round(act.opacity * 100) + '%';
    }
    // metodo di fusione: solo livelli raster (il testo è un piano SVG)
    this.modeRow.classList.toggle('p-off', !act || act.kind !== 'raster');
    this.modeSel.value = act && act.kind === 'raster' ? (act.mode || 'normal') : 'normal';
  }

  /** @param {Layer} layer */
  _buildRow(layer) {
    const row = document.createElement('div');
    row.className = 'ly-row';
    row.dataset.id = String(layer.id);

    // maschera di ritaglio EFFETTIVA (flag + base valida): riga rientrata
    // a destra con la freccia a sinistra che indica la base sotto, alla
    // Procreate. Il flag senza base valida (livello in fondo, testo sotto)
    // resta sul bottone ma non rientra: il render lo ignora allo stesso modo.
    if (layer.clip && layer.clipBase) {
      row.classList.add('clipped');
      const arrow = document.createElement('span');
      arrow.className = 'ly-cliparrow';
      arrow.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M11 3h2v13.2l4.6-4.6L19 13l-7 7-7-7 1.4-1.4 4.6 4.6z"/></svg>';
      arrow.title = 'Clipped to the layer below';
      row.appendChild(arrow);
    }

    const handle = document.createElement('span');
    handle.className = 'ly-handle';
    handle.textContent = '≡';
    handle.title = 'Drag to reorder';
    this._bindDrag(handle, row);

    let thumb = this._thumbs.get(layer.id);
    if (!thumb) {
      thumb = document.createElement('canvas');
      thumb.width = THUMB; thumb.height = THUMB;
      thumb.className = 'ly-thumb';
      this._thumbs.set(layer.id, thumb);
      layer.thumbDirty = true;
    }

    const name = document.createElement('span');
    name.className = 'ly-name';
    name.textContent = layer.name;
    name.addEventListener('dblclick', () => {
      const v = prompt('Layer name:', layer.name);
      if (v && v.trim()) { layer.name = v.trim(); name.textContent = layer.name; }
    });

    const btns = document.createElement('span');
    btns.className = 'ly-btns';
    if (layer.kind === 'text') {
      const edit = document.createElement('button');
      edit.className = 'ly-mini';
      edit.textContent = 'Aa';
      edit.title = 'Text style';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.layerMgr.activeId = layer.id;
        this._refreshSelection();
        this.app.ui.textUI.open(true);
      });
      btns.appendChild(edit);
    }
    // maschera di ritaglio alla Procreate: visibile solo dove il livello
    // sotto ha alpha (solo raster; il render la ignora se la base non vale)
    if (layer.kind === 'raster') {
      const clip = document.createElement('button');
      clip.className = 'ly-mini ly-clip' + (layer.clip ? ' on' : '');
      clip.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2zM5 19h14v2H5z"/></svg>';
      clip.title = 'Clipping mask (uses the layer below)';
      clip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.toggleClipUndoable(layer.id);
      });
      btns.appendChild(clip);
    }
    // riferimento del flood fill alla Procreate: il fill misura i bordi
    // su questo livello anche riempiendone un altro (uno solo per board)
    const ref = document.createElement('button');
    ref.className = 'ly-mini ly-ref' + (layer.reference ? ' on' : '');
    ref.textContent = '◎';
    ref.title = 'Fill reference (ColorDrop)';
    ref.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.layerMgr.toggleReference(layer.id);
      this._rebuildList(); // anche l'eventuale riga smarcata si aggiorna
    });
    btns.appendChild(ref);
    const eye = document.createElement('button');
    eye.className = 'ly-mini' + (layer.visible ? '' : ' off');
    eye.textContent = layer.visible ? '👁' : '–';
    eye.title = 'Show/hide';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      eye.textContent = layer.visible ? '👁' : '–';
      eye.classList.toggle('off', !layer.visible);
      if (layer.kind === 'text') layer.styleDirty = true;
      this.app.planes.invalidate();
    });
    btns.appendChild(eye);

    // frecce su/giù: riordino a un click (il drag resta sulla maniglia)
    const updown = document.createElement('span');
    updown.className = 'ly-updown';
    const mgr = this.app.layerMgr;
    /** @param {boolean} up */
    const mkArrow = (up) => {
      const b = document.createElement('button');
      b.className = 'ly-arrow';
      b.title = up ? 'Move up' : 'Move down';
      b.innerHTML = up
        ? '<svg viewBox="0 0 24 24"><path d="M12 7 4.5 14.5 6 16l6-6 6 6 1.5-1.5z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 17l7.5-7.5L18 8l-6 6-6-6-1.5 1.5z"/></svg>';
      const idx = () => mgr.indexOf(layer.id);
      b.disabled = up ? idx() === mgr.layers.length - 1 : idx() === 0;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = idx();
        if (i < 0) return;
        const to = up ? i + 1 : i - 1;
        if (to < 0 || to >= mgr.layers.length) return;
        this.app.moveLayerUndoable(i, to);
      });
      return b;
    };
    updown.append(mkArrow(true), mkArrow(false));

    row.append(handle, thumb, name, btns, updown);
    row.addEventListener('click', () => {
      const mgr = this.app.layerMgr;
      if (mgr.activeId === layer.id) return;
      mgr.activeId = layer.id;
      this._refreshSelection();
      if (layer.kind !== 'text') this.app.ui.textUI.open(false);
    });
    return row;
  }

  // ---- drag & drop ----
  /** @param {HTMLElement} handle @param {HTMLElement} row */
  _bindDrag(handle, row) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rows = Array.from(this.listEl.children);
      if (rows.length < 2) return;
      const fromDisp = rows.indexOf(row);
      const rowH = row.offsetHeight + 6; // 6 = gap della lista
      const startY = e.clientY;
      let target = fromDisp;
      handle.setPointerCapture(e.pointerId);
      row.classList.add('dragging');

      /** @param {PointerEvent} ev */
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        target = Math.max(0, Math.min(rows.length - 1, Math.round(fromDisp + dy / rowH)));
        for (let i = 0; i < rows.length; i++) {
          const r = /** @type {HTMLElement} */ (rows[i]);
          if (r === row) continue;
          // le righe scansano per fare spazio alla posizione di rilascio
          let shift = 0;
          if (fromDisp < target && i > fromDisp && i <= target) shift = -rowH;
          else if (fromDisp > target && i >= target && i < fromDisp) shift = rowH;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        }
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        row.classList.remove('dragging');
        for (const r of rows) /** @type {HTMLElement} */ (r).style.transform = '';
        if (target !== fromDisp) {
          const n = this.app.layerMgr.layers.length;
          // riga 0 = livello in cima: display -> indice modello
          this.app.moveLayerUndoable(n - 1 - fromDisp, n - 1 - target);
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  // ---- azioni ----
  _addRaster() {
    const app = this.app;
    if (!app.layerMgr.canAdd) { alert(`Maximum ${MAX_LAYERS} layers.`); return; }
    app.addLayer(makeRasterLayer('', app.heap));
  }

  _pickImage() {
    const app = this.app;
    if (app.imageImporting) return;
    if (!app.layerMgr.canAdd) { alert(`Maximum ${MAX_LAYERS} layers.`); return; }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  _duplicate() {
    const app = this.app;
    const src = app.layerMgr.active;
    if (!src) return;
    if (!app.layerMgr.canAdd) { alert(`Maximum ${MAX_LAYERS} layers.`); return; }
    /** @type {Layer} */
    let copy;
    if (src.kind === 'raster') {
      copy = makeRasterLayer(src.name + ' copy', app.heap);
      for (const c of src.store.map.values()) {
        const dst = copy.store.getOrCreate(c.cx, c.cy);
        dst.data.set(c.data);
        dst.touched = c.touched;
        copy.store.markDirty(dst);
      }
    } else {
      // structuredClone: la gabbia distort è annidata, lo spread la
      // condividerebbe fra originale e copia
      copy = makeTextLayer(src.name + ' copy', { ...src.item }, structuredClone(src.style));
    }
    copy.visible = src.visible;
    copy.opacity = src.opacity;
    if (src.kind === 'raster') copy.clip = src.clip; // il duplicato resta ritagliato
    if (src.kind === 'raster') copy.mode = src.mode; // ... e con lo stesso metodo
    app.addLayer(copy);
  }

  _delete() {
    const app = this.app;
    if (app.layerMgr.layers.length <= 1) { alert('At least one layer is required.'); return; }
    const act = app.layerMgr.active;
    if (act) app.deleteLayer(act.id);
  }

  // ---- miniature ----
  scheduleThumbs() {
    if (this._thumbTimer) return;
    this._thumbTimer = setTimeout(() => {
      this._thumbTimer = null;
      this._renderThumbs();
    }, 300);
  }

  _renderThumbs() {
    if (!this.isOpen) return;
    for (const layer of this.app.layerMgr.layers) {
      if (!layer.thumbDirty) continue;
      const cnv = this._thumbs.get(layer.id);
      if (!cnv) continue;
      layer.thumbDirty = false;
      this._drawThumb(layer, cnv);
    }
    // ripulisce le miniature dei livelli morti (su QUALUNQUE canvas: il
    // pannello mostra solo il canvas attivo, ma le miniature degli altri
    // restano vive per quando si torna lì)
    for (const [id] of this._thumbs) {
      if (!this.app.boards.layerById(id)) this._thumbs.delete(id);
    }
  }

  /** @param {Layer} layer @param {HTMLCanvasElement} cnv */
  _drawThumb(layer, cnv) {
    const ctx = cnv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, THUMB, THUMB);

    if (layer.kind === 'text') {
      ctx.fillStyle = layer.item.fill;
      ctx.font = `${layer.style.weight} 11px "${layer.style.font}", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(layer.item.text.slice(0, 6), THUMB / 2, THUMB / 2);
      return;
    }

    // bbox dei chunk toccati (campionata se il documento è enorme)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const c of layer.store.map.values()) {
      if (!c.touched) continue;
      any = true;
      if (c.cx < x0) x0 = c.cx;
      if (c.cy < y0) y0 = c.cy;
      if (c.cx > x1) x1 = c.cx;
      if (c.cy > y1) y1 = c.cy;
    }
    if (!any) return;
    const w = (x1 - x0 + 1) * CHUNK, h = (y1 - y0 + 1) * CHUNK;
    const s = Math.min(THUMB / w, THUMB / h);
    const ox = (THUMB - w * s) / 2, oy = (THUMB - h * s) / 2;
    const tmp = document.createElement('canvas');
    tmp.width = CHUNK; tmp.height = CHUNK;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(CHUNK, CHUNK);
    let drawn = 0;
    for (const c of layer.store.map.values()) {
      if (!c.touched) continue;
      if (drawn++ > 128) break; // documenti enormi: miniatura parziale
      const src = c.data, dst = img.data;
      for (let o = 0; o < src.length; o += 4) {
        const a = src[o + 3];
        if (a === 0) { dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0; continue; }
        const inv = 255 / a;
        dst[o] = Math.min(255, src[o] * inv);
        dst[o + 1] = Math.min(255, src[o + 1] * inv);
        dst[o + 2] = Math.min(255, src[o + 2] * inv);
        dst[o + 3] = a;
      }
      tctx.putImageData(img, 0, 0);
      ctx.drawImage(tmp, ox + (c.cx - x0) * CHUNK * s, oy + (c.cy - y0) * CHUNK * s,
        CHUNK * s, CHUNK * s);
    }
  }
}
