// Brush library popup with categories, previews and rewarded-ad locks.

import { brush } from './brush.js';
import { clamp } from './util.js';
import { BRUSH_CATEGORIES, BRUSH_PRESETS, applyPreset, presetConfig } from './brush_presets.js';
import { BrushPreview } from './brush_preview.js';

/** @typedef {import('./ui.js').UI} UI */
/** @typedef {import('./brush_presets.js').BrushPreset} BrushPreset */

const UNLOCK_KEY = 'fable.rewardedBrushUnlocks.v1';
const SIZE_MAX = 2000;
const SIZE_SLIDER_MAX = 240;
const ALL_CATEGORY = {
  id: 'all',
  label: 'All',
  icon: '<svg viewBox="0 0 24 24"><path d="M5 19V9"/><path d="M12 19V5"/><path d="M19 19V12"/><path d="M3.5 19h17"/></svg>',
};

export class PresetsUI {
  /** @param {UI} ui */
  constructor(ui) {
    this.ui = ui;
    this.panel = document.getElementById('presetspopup');
    this._built = false;
    this._renderedKey = '';
    this._activeCat = BRUSH_CATEGORIES[0]?.id || 'all';
    this._activeId = '';
    /** @type {{preset: BrushPreset, row: HTMLElement, canvas: HTMLCanvasElement}[]} */
    this._cards = [];
    /** @type {Set<string>} */
    this._unlocked = readUnlocks();
    /** @type {BrushPreview|null} */
    this._pv = null;
    this._adRunning = false;

    /** @type {HTMLElement|null} */
    this._catEl = null;
    /** @type {HTMLElement|null} */
    this._listEl = null;
    /** @type {HTMLElement|null} */
    this._titleEl = null;
    /** @type {HTMLElement|null} */
    this._countEl = null;
    /** @type {HTMLElement|null} */
    this._statusEl = null;
    /** @type {HTMLInputElement|null} */
    this._sizeRange = null;
    /** @type {HTMLElement|null} */
    this._sizeValue = null;
    /** @type {HTMLInputElement|null} */
    this._opacityRange = null;
    /** @type {HTMLElement|null} */
    this._opacityValue = null;
    /** @type {HTMLElement|null} */
    this._adOverlay = null;
    /** @type {HTMLElement|null} */
    this._adTitle = null;
    /** @type {HTMLElement|null} */
    this._adStatus = null;
    /** @type {HTMLElement|null} */
    this._adMeter = null;

    window.addEventListener('pointerdown', (e) => {
      if (!this.isOpen || this._adRunning) return;
      const t = /** @type {Node} */ (e.target);
      if (this.panel.contains(t)) return;
      if (document.getElementById('tool-brush').contains(t)) return;
      this.open(false);
    });
    window.addEventListener('keydown', (e) => {
      if (!this._adRunning) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('resize', () => { if (this.isOpen) this._place(); });
  }

  get isOpen() { return this.panel.classList.contains('open'); }

  toggle() { this.open(!this.isOpen); }

  /** @param {boolean} v */
  open(v) {
    if (v && !this._built) this._build();
    this.panel.classList.toggle('open', v);
    if (!v) return;

    this.ui.toggleStudio(false);
    this.ui.toggleBlurPopup(false);
    this.ui.layersUI.open(false);
    this.ui.textUI.open(false);
    if (this.ui.mockups) this.ui.mockups.open(false);
    if (this.ui.app.fxTools) for (const tool of this.ui.app.fxTools) tool.openPanel(false);

    this._place();
    this._renderCats();
    this._renderList();
    this._syncControls();
  }

  _place() {
    const btn = document.getElementById('tool-brush');
    const r = btn.getBoundingClientRect();
    const w = this.panel.offsetWidth || 860;
    const h = this.panel.offsetHeight || 650;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right + 12;
    let top = Math.max(8, Math.min(r.top - 20, vh - h - 8));

    if (vw <= 720 || w > vw - 24) {
      left = 8;
      top = Math.max(8, Math.min(12, vh - h - 8));
    } else if (left + w > vw - 8) {
      left = r.left + r.width / 2 - w / 2;
      top = r.bottom + 10;
    }
    if (top + h > vh - 8) top = vh - h - 8;
    this.panel.style.left = Math.max(8, Math.min(left, vw - w - 8)) + 'px';
    this.panel.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
  }

  _build() {
    this._built = true;
    this.panel.textContent = '';

    const head = document.createElement('div');
    head.className = 'bp-head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'bp-titlewrap';
    this._titleEl = document.createElement('span');
    this._titleEl.className = 'bp-title';
    this._countEl = document.createElement('span');
    this._countEl.className = 'bp-count';
    titleWrap.append(this._titleEl, this._countEl);
    const close = document.createElement('button');
    close.className = 'tb-btn bp-close';
    close.type = 'button';
    close.title = 'Close';
    close.textContent = '✕';
    close.addEventListener('click', () => this.open(false));
    head.append(titleWrap, close);

    const shell = document.createElement('div');
    shell.className = 'bp-shell';
    this._catEl = document.createElement('nav');
    this._catEl.className = 'bp-cats';
    this._catEl.setAttribute('aria-label', 'Brush categories');
    const main = document.createElement('main');
    main.className = 'bp-main';
    this._listEl = document.createElement('div');
    this._listEl.className = 'bp-list';
    main.appendChild(this._listEl);
    shell.append(this._catEl, main);

    const foot = document.createElement('div');
    foot.className = 'bp-foot';
    foot.append(this._buildControl('Thickness', 'px', true), this._buildControl('Opacity', '%', false));
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'bp-status';
    foot.appendChild(this._statusEl);

    this.panel.append(head, shell, foot);
    this._buildAdOverlay();
  }

  /**
   * @param {string} label
   * @param {string} unit
   * @param {boolean} sizeControl
   */
  _buildControl(label, unit, sizeControl) {
    const wrap = document.createElement('div');
    wrap.className = 'bp-control';
    const head = document.createElement('div');
    head.className = 'bp-control-head';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const value = document.createElement('span');
    value.className = 'bp-control-value';
    head.append(labelEl, value);

    const body = document.createElement('div');
    body.className = 'bp-control-body';
    const minus = document.createElement('button');
    minus.className = 'bp-step';
    minus.type = 'button';
    minus.title = `Decrease ${label}`;
    minus.textContent = '-';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = sizeControl ? '1' : '1';
    range.max = sizeControl ? String(SIZE_SLIDER_MAX) : '100';
    range.step = '1';
    range.setAttribute('aria-label', label);
    const plus = document.createElement('button');
    plus.className = 'bp-step';
    plus.type = 'button';
    plus.title = `Increase ${label}`;
    plus.textContent = '+';
    body.append(minus, range, plus);
    wrap.append(head, body);

    const apply = (next) => {
      if (sizeControl) {
        brush.size = clamp(Math.round(next), 1, SIZE_MAX);
      } else {
        brush.opacity = clamp(Math.round(next) / 100, 0.01, 1);
      }
      this._syncControls();
      this.ui.notifyBrushChanged();
      this._refreshActiveThumb();
    };
    range.addEventListener('input', () => apply(Number(range.value)));
    minus.addEventListener('click', () => {
      const cur = sizeControl ? brush.size : brush.opacity * 100;
      apply(cur + (sizeControl ? -1 : -5));
    });
    plus.addEventListener('click', () => {
      const cur = sizeControl ? brush.size : brush.opacity * 100;
      apply(cur + (sizeControl ? 1 : 5));
    });

    if (sizeControl) {
      this._sizeRange = range;
      this._sizeValue = value;
    } else {
      this._opacityRange = range;
      this._opacityValue = value;
    }
    value.dataset.unit = unit;
    return wrap;
  }

  _buildAdOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'bp-ad-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Rewarded ad');

    const card = document.createElement('div');
    card.className = 'bp-ad-card';
    const lock = document.createElement('div');
    lock.className = 'bp-ad-lock';
    lock.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><span>Ad</span>';
    this._adTitle = document.createElement('div');
    this._adTitle.className = 'bp-ad-title';
    this._adStatus = document.createElement('div');
    this._adStatus.className = 'bp-ad-status';
    const meterTrack = document.createElement('div');
    meterTrack.className = 'bp-ad-meter';
    this._adMeter = document.createElement('div');
    meterTrack.appendChild(this._adMeter);
    card.append(lock, this._adTitle, this._adStatus, meterTrack);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this._adOverlay = overlay;
  }

  _renderCats() {
    if (!this._catEl) return;
    this._catEl.textContent = '';
    const cats = [ALL_CATEGORY, ...BRUSH_CATEGORIES];
    for (const cat of cats) {
      const count = cat.id === 'all' ? BRUSH_PRESETS.length
        : BRUSH_CATEGORIES.find((c) => c.id === cat.id)?.items.length || 0;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-cat';
      btn.classList.toggle('active', cat.id === this._activeCat);
      btn.setAttribute('aria-pressed', String(cat.id === this._activeCat));
      btn.addEventListener('click', () => this._selectCat(cat.id));

      const icon = document.createElement('span');
      icon.className = 'bp-cat-icon';
      icon.innerHTML = cat.icon;
      const label = document.createElement('span');
      label.className = 'bp-cat-label';
      label.textContent = cat.label;
      const badge = document.createElement('span');
      badge.className = 'bp-cat-count';
      badge.textContent = String(count);
      btn.append(icon, label, badge);
      this._catEl.appendChild(btn);
    }
  }

  /** @param {string} id */
  _selectCat(id) {
    if (this._activeCat === id) return;
    this._activeCat = id;
    this._renderCats();
    this._renderList();
  }

  _renderList() {
    if (!this._listEl || !this._titleEl || !this._countEl) return;
    const items = this._items();
    const cat = this._activeCat === 'all'
      ? { label: 'All brushes' }
      : BRUSH_CATEGORIES.find((c) => c.id === this._activeCat) || BRUSH_CATEGORIES[0];
    this._titleEl.textContent = cat.label;
    this._countEl.textContent = `${items.length} brushes`;
    this._listEl.textContent = '';
    this._cards = [];

    for (const preset of items) {
      const locked = this._isLocked(preset);
      const cfg = presetConfig(preset);
      const row = document.createElement('div');
      row.className = 'bp-row';
      row.classList.toggle('active', preset.id === this._activeId);
      row.classList.toggle('locked', locked);
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', preset.name);
      row.addEventListener('click', () => this._pick(preset, false));
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this._pick(preset, false);
      });

      const preview = document.createElement('div');
      preview.className = 'bp-preview';
      const canvas = document.createElement('canvas');
      canvas.className = 'bp-thumb';
      const name = document.createElement('div');
      name.className = 'bp-name';
      name.textContent = preset.name;
      preview.append(canvas, name);

      const size = document.createElement('div');
      size.className = 'bp-size';
      size.textContent = (preset.id === this._activeId ? brush.size : cfg.size).toFixed(1);

      const adCell = document.createElement('div');
      adCell.className = 'bp-adcell';
      if (locked) {
        const ad = document.createElement('button');
        ad.className = 'bp-lock';
        ad.type = 'button';
        ad.title = 'Unlock with rewarded ad';
        ad.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><span>Ad</span>';
        ad.addEventListener('click', (e) => {
          e.stopPropagation();
          this._pick(preset, false);
        });
        adCell.appendChild(ad);
      }

      const add = document.createElement('button');
      add.className = 'bp-round';
      add.type = 'button';
      add.title = 'Edit in Brush Studio';
      add.textContent = '+';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        this._pick(preset, false, true);
      });

      const next = document.createElement('button');
      next.className = 'bp-round';
      next.type = 'button';
      next.title = 'Apply and edit in Brush Studio';
      next.textContent = '>';
      next.addEventListener('click', (e) => {
        e.stopPropagation();
        this._pick(preset, true, true);
      });

      row.append(preview, size, adCell, add, next);
      this._listEl.appendChild(row);
      this._cards.push({ preset, row, canvas });
    }

    this._renderedKey = '';
    requestAnimationFrame(() => this._renderThumbs());
  }

  /** @returns {BrushPreset[]} */
  _items() {
    if (this._activeCat === 'all') return BRUSH_PRESETS;
    return BRUSH_CATEGORIES.find((cat) => cat.id === this._activeCat)?.items || BRUSH_PRESETS;
  }

  /** @param {BrushPreset} preset */
  _isLocked(preset) {
    return !!preset.premium && !this._unlocked.has(preset.id);
  }

  /**
   * @param {BrushPreset} preset
   * @param {boolean} closeAfter
   * @param {boolean} [openStudio]
   */
  async _pick(preset, closeAfter, openStudio = false) {
    if (this._isLocked(preset)) {
      await this._unlockWithAd(preset, closeAfter, openStudio);
      return;
    }
    applyPreset(preset);
    this._activeId = preset.id;
    this._syncRows();
    this._syncControls();
    this.ui.notifyBrushChanged();
    this._refreshActiveThumb();
    if (this._statusEl) this._statusEl.textContent = `${preset.name} selected`;
    if (openStudio) {
      this.ui.toggleStudio(true);
      return;
    }
    if (closeAfter) this.open(false);
  }

  _syncRows() {
    for (const c of this._cards) {
      c.row.classList.toggle('active', c.preset.id === this._activeId);
      c.row.classList.toggle('locked', this._isLocked(c.preset));
      const size = c.row.querySelector('.bp-size');
      if (size) size.textContent = (c.preset.id === this._activeId ? brush.size : presetConfig(c.preset).size).toFixed(1);
      const adCell = c.row.querySelector('.bp-adcell');
      if (adCell && !this._isLocked(c.preset)) adCell.textContent = '';
    }
  }

  _syncControls() {
    if (this._sizeRange && this._sizeValue) {
      const shown = clamp(Math.round(brush.size), 1, SIZE_SLIDER_MAX);
      this._sizeRange.value = String(shown);
      this._sizeValue.textContent = `${brush.size.toFixed(1)}px`;
    }
    if (this._opacityRange && this._opacityValue) {
      const pct = Math.round(brush.opacity * 100);
      this._opacityRange.value = String(clamp(pct, 1, 100));
      this._opacityValue.textContent = `${pct}%`;
    }
  }

  _renderThumbs() {
    if (this._cards.length === 0) return;
    const key = this._activeCat + ':' + this._cards.map((c) => c.preset.id).join('|');
    if (key === this._renderedKey) return;
    this._renderedKey = key;
    if (!this._pv) this._pv = new BrushPreview(this._cards[0].canvas);
    const pv = this._pv;
    for (const c of this._cards) {
      pv.canvas = c.canvas;
      pv.ctx = /** @type {CanvasRenderingContext2D} */ (c.canvas.getContext('2d'));
      pv._checker = null;
      pv.render(presetConfig(c.preset));
    }
  }

  _refreshActiveThumb() {
    const card = this._cards.find((c) => c.preset.id === this._activeId);
    if (!card) return;
    if (!this._pv) this._pv = new BrushPreview(card.canvas);
    this._pv.canvas = card.canvas;
    this._pv.ctx = /** @type {CanvasRenderingContext2D} */ (card.canvas.getContext('2d'));
    this._pv._checker = null;
    this._pv.render({ ...brush, color: { r: 18, g: 18, b: 22 }, tool: 'brush' });
    const size = card.row.querySelector('.bp-size');
    if (size) size.textContent = brush.size.toFixed(1);
  }

  /**
   * @param {BrushPreset} preset
   * @param {boolean} closeAfter
   * @param {boolean} [openStudio]
   */
  async _unlockWithAd(preset, closeAfter, openStudio = false) {
    if (this._adRunning) return;
    this._adRunning = true;
    try {
      await this._showRewardedAd(preset);
      this._unlocked.add(preset.id);
      saveUnlocks(this._unlocked);
      this._renderList();
      await this._pick(preset, closeAfter, openStudio);
    } catch (err) {
      if (this._statusEl) this._statusEl.textContent = err instanceof Error ? err.message : 'Ad not completed';
    } finally {
      this._adRunning = false;
      if (this._adOverlay) this._adOverlay.hidden = true;
    }
  }

  /** @param {BrushPreset} preset */
  async _showRewardedAd(preset) {
    if (!this._adOverlay || !this._adTitle || !this._adStatus || !this._adMeter) return;
    this._adTitle.textContent = `Unlock ${preset.name}`;
    this._adStatus.textContent = 'Rewarded ad';
    this._adMeter.style.transform = 'scaleX(0)';
    this._adOverlay.hidden = false;

    const sdk = /** @type {any} */ (window).FableRewardedAds;
    if (sdk && typeof sdk.showRewarded === 'function') {
      this._adStatus.textContent = 'Playing fullscreen rewarded ad...';
      const ok = await sdk.showRewarded({
        placement: 'premium_brush_unlock',
        brushId: preset.id,
        categoryId: preset.categoryId,
      });
      if (ok === false) throw new Error('Ad not completed');
      this._adMeter.style.transform = 'scaleX(1)';
      this._adStatus.textContent = 'Reward granted';
      await delay(450);
      return;
    }

    await this._fallbackRewardCountdown();
    this._adStatus.textContent = 'Reward granted';
    await delay(450);
  }

  _fallbackRewardCountdown() {
    return new Promise((resolve) => {
      if (!this._adStatus || !this._adMeter) {
        resolve();
        return;
      }
      const total = 5;
      const started = performance.now();
      const tick = () => {
        const elapsed = (performance.now() - started) / 1000;
        const t = clamp(elapsed / total, 0, 1);
        const left = Math.ceil(Math.max(0, total - elapsed));
        if (this._adStatus) this._adStatus.textContent = `Ad completes in ${left}s`;
        if (this._adMeter) this._adMeter.style.transform = `scaleX(${t})`;
        if (t >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}

function readUnlocks() {
  try {
    const raw = localStorage.getItem(UNLOCK_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** @param {Set<string>} ids */
function saveUnlocks(ids) {
  try {
    localStorage.setItem(UNLOCK_KEY, JSON.stringify([...ids]));
  } catch {
    // Best effort: if storage is unavailable, the session unlock still works.
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
