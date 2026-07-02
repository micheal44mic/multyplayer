/** @typedef {import('./main.js').App} App */

import { MOCKUP_ASSETS } from './mockup_assets.js';
import { startIntervalCountdown } from './rewarded_ad.js';

const AD_WATCH_SECONDS = 0;

/** @typedef {'hood'|'jacketHood'|'collar'|'pocket'|'bodyHoodie'|'pufferJacket'|'bodyTee'|'accessory'} MockupKind */
/**
 * @typedef {Object} MockupItem
 * @property {string} id
 * @property {MockupKind} kind
 * @property {number} variant
 * @property {'front'|'back'} view
 * @property {string} name
 * @property {string} size
 * @property {string=} src
 * @property {string=} fileName
 */

const ASSETS = /** @type {Record<string, MockupItem[]>} */ (MOCKUP_ASSETS);

/** @type {Record<string, string>} */
const CATEGORY_ICONS = {
  hood: '<svg viewBox="0 0 24 24"><path d="M6 18c.4-6.8 2.7-11 6-11s5.6 4.2 6 11"/><path d="M7 16c2 1.3 8 1.3 10 0"/><path d="M12 7v10"/></svg>',
  jacketHood: '<svg viewBox="0 0 24 24"><path d="M7 19c.2-4.2 1.7-7.8 5-7.8s4.8 3.6 5 7.8"/><path d="M8 17c2 1.2 6 1.2 8 0"/><path d="M6 19H4l1-5 3-2"/><path d="M18 12l3 2 1 5h-2"/></svg>',
  collar: '<svg viewBox="0 0 24 24"><path d="M5 8c2.8 2.2 4.8 3.3 7 3.3S16.2 10.2 19 8"/><path d="M6 8v8c2.3 1.2 4.2 1.8 6 1.8s3.7-.6 6-1.8V8"/><path d="M9 11v5"/><path d="M15 11v5"/></svg>',
  pocket: '<svg viewBox="0 0 24 24"><path d="M6.5 7.5h11l-1.1 11h-8.8z"/><path d="M8 9.5c2.5 2 5.5 2 8 0"/><path d="M9.5 7.5V5.8h5v1.7"/></svg>',
  bodyHoodie: '<svg viewBox="0 0 24 24"><path d="M8.2 5.2 5 7.7l-2 6.2 3.5 1.4 1-2.7V21h9v-8.4l1 2.7 3.5-1.4-2-6.2-3.2-2.5"/><path d="M9 5.4c.4 1.5 1.4 2.3 3 2.3s2.6-.8 3-2.3"/><path d="M9 16h6"/></svg>',
  pufferJacket: '<svg viewBox="0 0 24 24"><path d="M8.5 4.5 5.5 6.2l-2 6 3.2 1.3 1-2.5V20h8.6v-9l1 2.5 3.2-1.3-2-6-3-1.7"/><path d="M9 5c.6 1 1.6 1.5 3 1.5s2.4-.5 3-1.5"/><path d="M8 10h8"/><path d="M8 13.5h8"/><path d="M8 17h8"/></svg>',
  bodyTee: '<svg viewBox="0 0 24 24"><path d="M9 4.5 5.5 6.4 3 12.6l3.7 1.5 1.3-3.1V20h8v-9l1.3 3.1 3.7-1.5-2.5-6.2L15 4.5"/><path d="M9 4.5c.6 1.2 1.6 1.8 3 1.8s2.4-.6 3-1.8"/></svg>',
  accessory: '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/><path d="M9 7V5h6v2"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>',
};

/** @type {{id: string, label: string, items: MockupItem[]}[]} */
const CATEGORIES = [
  { id: 'bodyTee', label: 'Tee', items: ASSETS.bodyTee },
  { id: 'bodyHoodie', label: 'Body hoodie', items: ASSETS.bodyHoodie },
  { id: 'pufferJacket', label: 'Puffer jacket', items: ASSETS.pufferJacket },
  { id: 'hood', label: 'Hood', items: ASSETS.hood },
  { id: 'jacketHood', label: 'Jacket hood', items: ASSETS.jacketHood },
  { id: 'collar', label: 'Collar', items: ASSETS.collar },
  { id: 'pocket', label: 'Pocket', items: ASSETS.pocket },
  { id: 'accessory', label: 'Accessories', items: ASSETS.accessory },
];

export class MockupUI {
  /**
   * @param {App} app
   * @param {import('./ui.js').UI} ui
   */
  constructor(app, ui) {
    this.app = app;
    this.ui = ui;
    this.panel = document.getElementById('mockuppanel');
    this.backdrop = document.getElementById('mockup-backdrop');
    this.catEl = document.getElementById('mu-cats');
    this.gridEl = document.getElementById('mu-grid');
    this.titleEl = document.getElementById('mu-title');
    this.countEl = document.getElementById('mu-count');
    this.statusEl = document.getElementById('mu-status');
    this.searchEl = /** @type {HTMLInputElement} */ (document.getElementById('mu-search'));
    this.activeCat = CATEGORIES[0].id;
    this.selectedId = '';
    this.importing = false;
    this.adGate = this._createAdGate();
    /** @type {((ok: boolean) => void)|null} */
    this._adResolve = null;
    this._adTimer = null;
    this._adPhase = 'idle';

    document.getElementById('mu-close').addEventListener('click', () => this.open(false));
    this.backdrop.addEventListener('click', () => {
      if (this._isAdGateOpen()) this._dismissAdGate();
      else this.open(false);
    });
    this.searchEl.addEventListener('input', () => this._renderGrid());
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return;
      e.preventDefault();
      if (this._isAdGateOpen()) this._dismissAdGate();
      else this.open(false);
    });

    this._renderCats();
    this._renderGrid();
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  toggle() { this.open(!this.isOpen); }

  /** @param {boolean} v */
  open(v) {
    if (!v && this._adPhase === 'playing') {
      this.adGate.status.textContent = 'Ad is playing. Import unlocks when it ends.';
      return;
    }
    if (!v) this._finishAdGate(false);
    this.panel.classList.toggle('open', v);
    this.backdrop.hidden = !v;
    document.getElementById('btn-mockup').classList.toggle('active', v);
    if (!v) return;

    this.ui.toggleStudio(false);
    this.ui.toggleBlurPopup(false);
    this.ui.presetsUI.open(false);
    this.ui.layersUI.open(false);
    this.ui.textUI.open(false);
    this.ui.svgUI.open(false);
    if (this.app.fxTools) for (const t of this.app.fxTools) t.openPanel(false);
    this._renderGrid();
  }

  /** @param {string} id */
  _selectCat(id) {
    if (this.activeCat === id) return;
    this.activeCat = id;
    this.searchEl.value = '';
    this._renderCats();
    this._renderGrid();
  }

  _renderCats() {
    this.catEl.textContent = '';
    for (const cat of CATEGORIES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mu-cat';
      btn.classList.toggle('active', cat.id === this.activeCat);
      btn.setAttribute('aria-pressed', String(cat.id === this.activeCat));
      btn.addEventListener('click', () => this._selectCat(cat.id));

      const icon = document.createElement('span');
      icon.className = 'mu-cat-icon';
      icon.innerHTML = CATEGORY_ICONS[cat.id];

      const label = document.createElement('span');
      label.className = 'mu-cat-label';
      label.textContent = cat.label;

      const count = document.createElement('span');
      count.className = 'mu-cat-count';
      count.textContent = String(cat.items.length);

      btn.append(icon, label, count);
      this.catEl.appendChild(btn);
    }
  }

  _renderGrid() {
    const cat = this._activeCategory();
    const query = this.searchEl.value.trim().toLowerCase();
    const items = query
      ? cat.items.filter((item) => item.name.toLowerCase().includes(query))
      : cat.items;

    this.titleEl.textContent = cat.label;
    this.countEl.textContent = `${items.length} mockup`;
    this.gridEl.textContent = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mu-empty';
      empty.textContent = 'No mockups';
      this.gridEl.appendChild(empty);
      return;
    }

    for (const item of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mu-card';
      card.classList.toggle('selected', item.id === this.selectedId);
      card.title = item.name;
      card.addEventListener('click', () => this._choose(item));

      const thumbWrap = document.createElement('span');
      thumbWrap.className = 'mu-thumb-wrap';
      thumbWrap.appendChild(renderMockupThumb(item));

      const adBadge = document.createElement('span');
      adBadge.className = 'mu-ad-badge';
      adBadge.textContent = 'AD';
      thumbWrap.appendChild(adBadge);

      const name = document.createElement('span');
      name.className = 'mu-name';
      name.textContent = item.name;

      card.append(thumbWrap, name);
      this.gridEl.appendChild(card);
    }
  }

  /** @param {MockupItem} item */
  async _choose(item) {
    if (this.importing) return;
    this.importing = true;
    this.statusEl.textContent = `Ad required for ${item.name}`;
    try {
      const watched = await this._requireAdWatch(item);
      if (!watched) {
        this.statusEl.textContent = `Ad required to import ${item.name}`;
        return;
      }

      this.statusEl.textContent = `Importing ${item.name}...`;
      const file = await fileFromItem(item);
      const ok = await this.app.importImageLayer(file);
      if (ok) {
        this.selectedId = item.id;
        this.statusEl.textContent = `${item.name} added`;
        this._renderGrid();
        this.open(false);
      }
    } catch (err) {
      console.error('[mockup]', err);
      this.statusEl.textContent = `Could not import ${item.name}`;
    } finally {
      this.importing = false;
    }
  }

  _activeCategory() {
    return CATEGORIES.find((cat) => cat.id === this.activeCat) || CATEGORIES[0];
  }

  _createAdGate() {
    const gate = document.createElement('div');
    gate.className = 'mu-ad-gate';
    gate.hidden = true;
    gate.innerHTML = `
      <div class="mu-ad-dialog" role="dialog" aria-modal="true" aria-label="Advertisement">
        <div class="mu-ad-top">
          <span class="mu-ad-kicker">Sponsored</span>
          <strong>Watch ad to import</strong>
          <small data-ad-name></small>
        </div>
        <div class="mu-ad-screen" aria-hidden="true">
          <span>AD</span>
          <small>Sponsored content</small>
        </div>
        <div class="mu-ad-meter" aria-hidden="true"><span data-ad-progress></span></div>
        <div class="mu-ad-status" data-ad-status></div>
        <div class="mu-ad-actions">
          <button type="button" class="mu-ad-cancel">Not now</button>
          <button type="button" class="mu-ad-continue">Watch ad</button>
        </div>
      </div>
    `;
    this.panel.appendChild(gate);
    const cancel = /** @type {HTMLButtonElement} */ (gate.querySelector('.mu-ad-cancel'));
    const cont = /** @type {HTMLButtonElement} */ (gate.querySelector('.mu-ad-continue'));
    cancel.addEventListener('click', () => this._finishAdGate(false));
    cont.addEventListener('click', () => {
      if (this._adPhase === 'prompt') this._startAdGatePlayback();
    });
    return {
      el: gate,
      name: /** @type {HTMLElement} */ (gate.querySelector('[data-ad-name]')),
      status: /** @type {HTMLElement} */ (gate.querySelector('[data-ad-status]')),
      progress: /** @type {HTMLElement} */ (gate.querySelector('[data-ad-progress]')),
      cancel,
      cont,
    };
  }

  /** @param {MockupItem} item */
  _requireAdWatch(item) {
    this._finishAdGate(false);
    this._adPhase = 'prompt';
    this.adGate.name.textContent = item.name;
    this.adGate.el.hidden = false;
    this.adGate.el.classList.remove('playing');
    this.adGate.cancel.hidden = false;
    this.adGate.cont.disabled = false;
    this.adGate.cont.textContent = 'Watch ad';
    this.adGate.progress.style.width = '0%';
    this.adGate.status.textContent = 'Opt in to watch a rewarded ad and import this mockup.';

    return new Promise((resolve) => {
      this._adResolve = resolve;
    });
  }

  _startAdGatePlayback() {
    if (this._adPhase !== 'prompt') return;
    this._adPhase = 'playing';
    this.adGate.el.classList.add('playing');
    this.adGate.cancel.hidden = true;
    this.adGate.cont.disabled = true;
    this.adGate.cont.textContent = 'Playing...';
    this.adGate.progress.style.width = '0%';
    const duration = AD_WATCH_SECONDS * 1000;

    if (duration <= 0) {
      this.adGate.progress.style.width = '100%';
      this.adGate.status.textContent = 'Ad complete. Importing...';
      this._finishAdGate(true);
      return;
    }

    this._adTimer = startIntervalCountdown({
      durationMs: duration,
      intervalMs: 200,
      completeDelayMs: 350,
      onClear: () => { this._adTimer = null; },
      onComplete: () => this._finishAdGate(true),
      onTick: ({ pct, remaining }) => {
        this.adGate.progress.style.width = `${pct}%`;
        this.adGate.status.textContent = remaining
          ? `Ad playing. Import unlocks in ${remaining}s`
          : 'Ad complete. Importing...';
      },
    });
  }

  _isAdGateOpen() {
    return !this.adGate.el.hidden;
  }

  _dismissAdGate() {
    if (this._adPhase === 'playing') {
      this.adGate.status.textContent = 'Ad is playing. Import unlocks when it ends.';
      return;
    }
    this._finishAdGate(false);
  }

  /** @param {boolean} ok */
  _finishAdGate(ok) {
    if (!this.adGate) return;
    if (!ok && this._adPhase === 'playing') return;
    if (this._adTimer) {
      window.clearInterval(this._adTimer);
      this._adTimer = null;
    }
    this.adGate.el.hidden = true;
    this.adGate.el.classList.remove('playing');
    this.adGate.cancel.hidden = false;
    this.adGate.cont.disabled = false;
    this.adGate.cont.textContent = 'Watch ad';
    this._adPhase = 'idle';
    const resolve = this._adResolve;
    this._adResolve = null;
    if (resolve) resolve(ok);
  }
}

/** @param {MockupItem} item */
async function fileFromItem(item) {
  if (item.src) return fileFromAssetItem(item);

  const canvas = renderMockupCanvas(item, true);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!(blob instanceof Blob)) throw new Error('Mockup render failed.');
  const name = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.png';
  if (typeof File === 'function') return new File([blob], name, { type: 'image/png' });
  /** @type {Blob & {name?: string}} */
  const fallback = blob;
  fallback.name = name;
  return /** @type {File} */ (fallback);
}

/** @param {MockupItem} item */
async function fileFromAssetItem(item) {
  const response = await fetch(item.src);
  if (!response.ok) throw new Error(`Mockup asset missing: ${item.src}`);
  const blob = await response.blob();
  const name = item.fileName || item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.png';
  const type = blob.type || 'image/png';
  if (typeof File === 'function') return new File([blob], name, { type });
  /** @type {Blob & {name?: string}} */
  const fallback = blob;
  fallback.name = name;
  return /** @type {File} */ (fallback);
}

/** @param {MockupItem} item */
function renderMockupThumb(item) {
  if (!item.src) return renderMockupCanvas(item, false);

  const img = document.createElement('img');
  img.className = 'mu-thumb';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = item.src;
  return img;
}

/**
 * @param {MockupItem} item
 * @param {boolean} exportMode
 */
function renderMockupCanvas(item, exportMode) {
  const canvas = document.createElement('canvas');
  canvas.className = 'mu-thumb';
  canvas.width = exportMode ? 1120 : 280;
  canvas.height = exportMode ? 840 : 210;
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / 280;
  ctx.save();
  ctx.scale(scale, scale);
  drawMockup(ctx, item, exportMode);
  ctx.restore();
  return canvas;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {MockupItem} item
 * @param {boolean} exportMode
 */
function drawMockup(ctx, item, exportMode) {
  ctx.clearRect(0, 0, 280, 210);
  if (!exportMode) {
    roundedRect(ctx, 0.5, 0.5, 279, 209, 8);
    ctx.fillStyle = '#fbfbfa';
    ctx.fill();
  }

  ctx.save();
  ctx.translate(0, 3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (item.kind === 'hood') drawHood(ctx, item);
  else if (item.kind === 'collar') drawCollar(ctx, item);
  else if (item.kind === 'bodyHoodie') drawBodyHoodie(ctx, item);
  else drawBodyTee(ctx, item);
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {MockupItem} item */
function drawHood(ctx, item) {
  const v = item.variant % 8;
  const front = item.view === 'front';
  setupGarment(ctx);
  if (front) {
    path(ctx, () => {
      ctx.moveTo(78, 65);
      ctx.bezierCurveTo(95, 35, 124, 26, 140, 32);
      ctx.bezierCurveTo(156, 26, 185, 35, 202, 65);
      ctx.bezierCurveTo(197, 115, 174, 158, 140, 166);
      ctx.bezierCurveTo(106, 158, 83, 115, 78, 65);
    }, true);
    seam(ctx, 140, 36, 140, 162);
    seam(ctx, 111, 62, 122, 150);
    seam(ctx, 169, 62, 158, 150);
    drawArc(ctx, 101, 61, 179, 61, 140, 88);
    if (v % 3 === 0) drawZip(ctx, 140, 83, 165);
    if (v % 3 === 1) {
      seam(ctx, 127, 84, 118, 154);
      seam(ctx, 153, 84, 162, 154);
    }
  } else if (v % 4 === 0) {
    path(ctx, () => {
      ctx.moveTo(58, 111);
      ctx.bezierCurveTo(74, 73, 104, 56, 140, 56);
      ctx.bezierCurveTo(176, 56, 206, 73, 222, 111);
      ctx.bezierCurveTo(204, 134, 76, 134, 58, 111);
    }, true);
    seam(ctx, 76, 108, 204, 108);
  } else if (v % 4 === 1) {
    path(ctx, () => {
      ctx.moveTo(84, 67);
      ctx.bezierCurveTo(111, 39, 169, 39, 196, 67);
      ctx.lineTo(218, 117);
      ctx.bezierCurveTo(191, 138, 89, 138, 62, 117);
      ctx.closePath();
    }, true);
    drawArc(ctx, 91, 67, 189, 67, 140, 91);
    seam(ctx, 118, 63, 122, 130);
    seam(ctx, 162, 63, 158, 130);
  } else if (v % 4 === 2) {
    path(ctx, () => {
      ctx.moveTo(67, 132);
      ctx.bezierCurveTo(70, 69, 101, 38, 140, 38);
      ctx.bezierCurveTo(179, 38, 210, 69, 213, 132);
      ctx.bezierCurveTo(174, 150, 106, 150, 67, 132);
    }, true);
    seam(ctx, 140, 45, 140, 139);
    seam(ctx, 104, 72, 115, 137);
    seam(ctx, 176, 72, 165, 137);
  } else {
    path(ctx, () => {
      ctx.moveTo(62, 95);
      ctx.bezierCurveTo(88, 72, 107, 65, 140, 65);
      ctx.bezierCurveTo(173, 65, 192, 72, 218, 95);
      ctx.lineTo(198, 140);
      ctx.bezierCurveTo(160, 123, 120, 123, 82, 140);
      ctx.closePath();
    }, true);
    seam(ctx, 86, 110, 194, 110);
    drawArc(ctx, 88, 96, 192, 96, 140, 82);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {MockupItem} item */
function drawCollar(ctx, item) {
  const v = item.variant % 6;
  setupGarment(ctx);
  if (v === 0) {
    roundedRect(ctx, 52, 86, 176, 44, 14);
    ctx.fill();
    ctx.stroke();
    for (let x = 70; x <= 210; x += 14) seam(ctx, x, 90, x + 4, 126);
    drawArc(ctx, 77, 91, 203, 91, 140, 121);
  } else if (v === 1) {
    path(ctx, () => {
      ctx.moveTo(69, 64);
      ctx.bezierCurveTo(96, 88, 120, 101, 140, 101);
      ctx.bezierCurveTo(160, 101, 184, 88, 211, 64);
      ctx.lineTo(222, 120);
      ctx.bezierCurveTo(187, 148, 93, 148, 58, 120);
      ctx.closePath();
    }, true);
    seam(ctx, 140, 100, 140, 145);
    drawZip(ctx, 140, 101, 145);
  } else if (v === 2) {
    path(ctx, () => {
      ctx.moveTo(70, 77);
      ctx.lineTo(120, 112);
      ctx.lineTo(140, 91);
      ctx.lineTo(160, 112);
      ctx.lineTo(210, 77);
      ctx.lineTo(218, 123);
      ctx.bezierCurveTo(179, 141, 101, 141, 62, 123);
      ctx.closePath();
    }, true);
    seam(ctx, 120, 112, 105, 136);
    seam(ctx, 160, 112, 175, 136);
  } else if (v === 3) {
    roundedRect(ctx, 88, 52, 104, 110, 28);
    ctx.fill();
    ctx.stroke();
    drawArc(ctx, 94, 62, 186, 62, 140, 86);
    drawArc(ctx, 96, 130, 184, 130, 140, 150);
    for (let x = 105; x <= 175; x += 14) seam(ctx, x, 59, x, 153);
  } else if (v === 4) {
    path(ctx, () => {
      ctx.moveTo(76, 72);
      ctx.bezierCurveTo(101, 91, 121, 102, 140, 102);
      ctx.bezierCurveTo(159, 102, 179, 91, 204, 72);
      ctx.lineTo(198, 139);
      ctx.bezierCurveTo(168, 128, 112, 128, 82, 139);
      ctx.closePath();
    }, true);
    seam(ctx, 94, 92, 186, 92);
    seam(ctx, 104, 118, 176, 118);
  } else {
    path(ctx, () => {
      ctx.moveTo(59, 112);
      ctx.bezierCurveTo(82, 82, 115, 70, 140, 70);
      ctx.bezierCurveTo(165, 70, 198, 82, 221, 112);
      ctx.lineTo(205, 136);
      ctx.bezierCurveTo(170, 122, 110, 122, 75, 136);
      ctx.closePath();
    }, true);
    drawArc(ctx, 88, 111, 192, 111, 140, 84);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {MockupItem} item */
function drawBodyHoodie(ctx, item) {
  const front = item.view === 'front';
  const v = item.variant % 6;
  setupGarment(ctx);
  path(ctx, () => {
    ctx.moveTo(101, 46);
    ctx.lineTo(72, 62);
    ctx.lineTo(42, 139);
    ctx.lineTo(76, 153);
    ctx.lineTo(88, 120);
    ctx.lineTo(88, 184);
    ctx.lineTo(192, 184);
    ctx.lineTo(192, 120);
    ctx.lineTo(204, 153);
    ctx.lineTo(238, 139);
    ctx.lineTo(208, 62);
    ctx.lineTo(179, 46);
    ctx.bezierCurveTo(170, 67, 110, 67, 101, 46);
    ctx.closePath();
  }, true);
  drawRib(ctx, 90, 172, 100, 12);
  drawRib(ctx, 52, 135, 26, 10);
  drawRib(ctx, 202, 135, 26, 10);
  if (front) {
    drawHoodOpening(ctx);
    if (v % 2 === 0) drawZip(ctx, 140, 69, 178);
    path(ctx, () => {
      ctx.moveTo(106, 132);
      ctx.bezierCurveTo(123, 121, 157, 121, 174, 132);
      ctx.lineTo(166, 159);
      ctx.lineTo(114, 159);
      ctx.closePath();
    }, false);
    seam(ctx, 114, 146, 166, 146);
  } else {
    path(ctx, () => {
      ctx.moveTo(98, 59);
      ctx.bezierCurveTo(115, 34, 165, 34, 182, 59);
      ctx.bezierCurveTo(172, 79, 108, 79, 98, 59);
    }, false);
    seam(ctx, 101, 106, 179, 106);
    seam(ctx, 140, 70, 140, 179);
  }
}

/** @param {CanvasRenderingContext2D} ctx @param {MockupItem} item */
function drawBodyTee(ctx, item) {
  const front = item.view === 'front';
  const v = item.variant % 5;
  setupGarment(ctx);
  path(ctx, () => {
    ctx.moveTo(101, 44);
    ctx.lineTo(64, 62);
    ctx.lineTo(39, 124);
    ctx.lineTo(76, 139);
    ctx.lineTo(89, 105);
    ctx.lineTo(88, 184);
    ctx.lineTo(192, 184);
    ctx.lineTo(191, 105);
    ctx.lineTo(204, 139);
    ctx.lineTo(241, 124);
    ctx.lineTo(216, 62);
    ctx.lineTo(179, 44);
    ctx.bezierCurveTo(169, 61, 111, 61, 101, 44);
    ctx.closePath();
  }, true);
  if (v === 1) {
    ctx.setLineDash([3, 4]);
    seam(ctx, 99, 44, 89, 184);
    seam(ctx, 181, 44, 191, 184);
    ctx.setLineDash([]);
  }
  if (v === 2) drawRib(ctx, 89, 170, 102, 13);
  if (front) drawArc(ctx, 109, 49, 171, 49, 140, 72);
  else {
    drawArc(ctx, 108, 48, 172, 48, 140, 61);
    seam(ctx, 91, 91, 189, 91);
  }
  seam(ctx, 74, 65, 92, 107);
  seam(ctx, 206, 65, 188, 107);
}

/** @param {CanvasRenderingContext2D} ctx */
function setupGarment(ctx) {
  ctx.fillStyle = '#bfc0bf';
  ctx.strokeStyle = '#303034';
  ctx.lineWidth = 2.2;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {() => void} build
 * @param {boolean} fill
 */
function path(ctx, build, fill) {
  ctx.beginPath();
  build();
  if (fill) ctx.fill();
  ctx.stroke();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function seam(ctx, x0, y0, x1, y1) {
  ctx.save();
  ctx.strokeStyle = '#7f8080';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y0 @param {number} y1 */
function drawZip(ctx, x, y0, y1) {
  ctx.save();
  ctx.strokeStyle = '#27272a';
  ctx.lineWidth = 2;
  seam(ctx, x, y0, x, y1);
  for (let y = y0 + 4; y < y1; y += 6) {
    ctx.beginPath();
    ctx.moveTo(x - 4, y);
    ctx.lineTo(x + 4, y + 2);
    ctx.stroke();
  }
  roundedRect(ctx, x - 4, y0 - 10, 8, 11, 3);
  ctx.fillStyle = '#8a8b8c';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx */
function drawHoodOpening(ctx) {
  ctx.save();
  ctx.strokeStyle = '#303034';
  ctx.lineWidth = 2;
  path(ctx, () => {
    ctx.moveTo(103, 58);
    ctx.bezierCurveTo(116, 78, 164, 78, 177, 58);
    ctx.bezierCurveTo(166, 42, 114, 42, 103, 58);
  }, false);
  seam(ctx, 118, 66, 110, 92);
  seam(ctx, 162, 66, 170, 92);
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h */
function drawRib(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = '#aeb0af';
  ctx.strokeStyle = '#303034';
  ctx.lineWidth = 1.4;
  roundedRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#858686';
  for (let i = x + 8; i < x + w; i += 9) seam(ctx, i, y + 2, i, y + h - 2);
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} cx @param {number} cy */
function drawArc(ctx, x0, y0, x1, y1, cx, cy) {
  ctx.save();
  ctx.strokeStyle = '#68696a';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.stroke();
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
