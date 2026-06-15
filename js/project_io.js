import { Board, bumpBoardIds } from './boards.js';
import { makeRasterLayer, makeTextLayer, bumpLayerIds, BLEND_MODES } from './layers.js';
import { CHUNK_BYTES } from './store.js';
import { freeBlockBitmap, touchText } from './text_layer.js';
import { track } from './telemetry.js';

const APP_KIND = 'fable-paint-project';
const FILE_VERSION = 1;
const DB_NAME = 'fable-paint-projects';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_META = 'meta';
const CURRENT_KEY = 'fable-paint.currentProject';

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable.'));
  });
  return dbPromise;
}

/** @param {IDBTransaction} tx */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

/** @param {Uint8Array|Uint8ClampedArray} bytes */
function bytesToBase64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

/** @param {string} b64 */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {any} x */
function plainClone(x) {
  return JSON.parse(JSON.stringify(x ?? null));
}

/** @param {string} name */
function safeName(name) {
  const v = String(name || '').trim();
  return v || 'Untitled';
}

/** @param {string} name */
function safeFilename(name) {
  return safeName(name).replace(/[\\/:*?"<>|]/g, '_');
}

function newProjectId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

/** @param {import('./store.js').Chunk} c */
function chunkBlank(c) {
  const u = new Uint32Array(c.data.buffer, c.data.byteOffset, c.data.length >> 2);
  for (let i = 0; i < u.length; i++) if (u[i] !== 0) return false;
  return true;
}

/** @param {import('./layers.js').Layer} layer */
function snapshotLayer(layer) {
  /** @type {any} */
  const out = {
    id: layer.id,
    kind: layer.kind,
    name: layer.name,
    visible: layer.visible !== false,
    opacity: Number.isFinite(layer.opacity) ? layer.opacity : 1,
    reference: !!layer.reference,
  };
  if (layer.kind === 'raster') {
    out.mode = BLEND_MODES.includes(layer.mode) ? layer.mode : 'normal';
    out.clip = !!layer.clip;
    out.chunks = [];
    for (const c of layer.store.map.values()) {
      if (chunkBlank(c)) continue;
      out.chunks.push({ cx: c.cx, cy: c.cy, data: bytesToBase64(c.data) });
    }
  } else {
    out.item = plainClone(layer.item);
    out.style = plainClone(layer.style);
    out.ver = layer.ver || 0;
  }
  return out;
}

/** @param {import('./main.js').App} app @param {string} name */
export function makeProjectSnapshot(app, name) {
  const now = new Date().toISOString();
  const snapshot = {
    kind: APP_KIND,
    version: FILE_VERSION,
    name: safeName(name),
    savedAt: now,
    activeBoardId: app.boards.activeId,
    camera: {
      x: app.camera.x,
      y: app.camera.y,
      zoom: app.camera.zoom,
    },
    boards: app.boards.boards.map((b) => ({
      id: b.id,
      name: b.name,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      activeLayerId: b.mgr.activeId,
      layers: b.mgr.layers.map(snapshotLayer),
    })),
  };
  return snapshot;
}

/** @param {any} snapshot */
export function projectStats(snapshot) {
  let layers = 0, chunks = 0;
  for (const b of snapshot.boards || []) {
    layers += (b.layers || []).length;
    for (const l of b.layers || []) chunks += (l.chunks || []).length;
  }
  return {
    boards: (snapshot.boards || []).length,
    layers,
    chunks,
    rawBytes: chunks * CHUNK_BYTES,
  };
}

/** @param {any} snapshot */
function normalizeSnapshot(snapshot) {
  const s = snapshot && snapshot.snapshot ? snapshot.snapshot : snapshot;
  if (!s || s.kind !== APP_KIND || !Array.isArray(s.boards)) {
    throw new Error('Questo non e un progetto Fable Paint.');
  }
  if (s.version !== FILE_VERSION) {
    throw new Error('Versione progetto non supportata.');
  }
  s.name = safeName(s.name);
  return s;
}

/** @param {import('./main.js').App} app */
function disposeCurrentDocument(app) {
  app.commitJob = null;
  app.pendingCommit = false;
  app.cancelStroke();
  app.selection.clear();
  if (app.transform) app.transform.cancel();
  if (app.fx) app.fx.escape();
  if (app.layerStyle) app.layerStyle.escape();
  if (app.fillUI) app.fillUI.dismiss();
  if (app.collab && app.collab.role) app.collab.leave();
  for (const b of app.boards.boards) {
    for (const l of b.mgr.layers) {
      if (l.store) {
        l.store.destroy((c) => app.renderer.disposeChunkTex(c));
        app._allStores.delete(l.store);
      } else {
        freeBlockBitmap(l);
      }
    }
    b.mgr.layers.length = 0;
  }
  app.boards.boards.length = 0;
  app.boards.activeId = 0;
}

/** @param {import('./main.js').App} app @param {any} snapshot */
export function applyProjectSnapshot(app, snapshot) {
  const s = normalizeSnapshot(snapshot);
  disposeCurrentDocument(app);

  let maxBoardId = 0;
  let maxLayerId = 0;
  for (const sb of s.boards) {
    const b = new Board(safeName(sb.name), Number(sb.x) || 0, Number(sb.y) || 0,
      Math.max(1, Number(sb.w) || 2048), Math.max(1, Number(sb.h) || 2048));
    b.id = Math.max(1, Number(sb.id) || b.id);
    maxBoardId = Math.max(maxBoardId, b.id);
    b.mgr.layers.length = 0;

    for (const sl of sb.layers || []) {
      /** @type {import('./layers.js').Layer|null} */
      let layer = null;
      if (sl.kind === 'text') {
        layer = makeTextLayer(safeName(sl.name), plainClone(sl.item || {}), plainClone(sl.style || {}));
        layer.ver = Number(sl.ver) || 0;
        touchText(layer);
      } else {
        layer = makeRasterLayer(safeName(sl.name), app.heap);
        app._allStores.add(layer.store);
        for (const sc of sl.chunks || []) {
          const cx = Number(sc.cx) || 0;
          const cy = Number(sc.cy) || 0;
          const data = base64ToBytes(String(sc.data || ''));
          if (data.length !== CHUNK_BYTES) continue;
          const c = layer.store.getOrCreate(cx, cy);
          c.data.set(data);
          c.touched = true;
          layer.store.markDirty(c);
        }
        layer.mode = BLEND_MODES.includes(sl.mode) ? sl.mode : 'normal';
        layer.clip = !!sl.clip;
      }
      layer.id = Math.max(1, Number(sl.id) || layer.id);
      maxLayerId = Math.max(maxLayerId, layer.id);
      layer.name = safeName(sl.name);
      layer.visible = sl.visible !== false;
      layer.opacity = Math.max(0, Math.min(1, Number(sl.opacity ?? 1)));
      layer.reference = !!sl.reference;
      if (layer.store) layer.store.name = 'layer' + layer.id;
      layer.thumbDirty = true;
      b.mgr.insert(layer);
    }

    if (b.mgr.layers.length === 0) {
      const first = makeRasterLayer('Layer 1', app.heap);
      app._allStores.add(first.store);
      b.mgr.insert(first);
      maxLayerId = Math.max(maxLayerId, first.id);
    }
    const activeLayer = b.mgr.byId(Number(sb.activeLayerId));
    b.mgr.activeId = activeLayer ? activeLayer.id : b.mgr.layers[b.mgr.layers.length - 1].id;
    b.mgr.bump();
    app.boards.boards.push(b);
  }

  if (app.boards.boards.length === 0) {
    const b = new Board('Canvas 1', 0, 0, 2048, 2048);
    const first = makeRasterLayer('Layer 1', app.heap);
    app._allStores.add(first.store);
    b.mgr.insert(first);
    app.boards.boards.push(b);
    maxBoardId = Math.max(maxBoardId, b.id);
    maxLayerId = Math.max(maxLayerId, first.id);
  }

  const active = app.boards.byId(Number(s.activeBoardId)) || app.boards.boards[0];
  app.boards.activeId = active.id;
  bumpBoardIds(maxBoardId + 1);
  bumpLayerIds(maxLayerId + 1);

  if (s.camera && Number.isFinite(s.camera.x) && Number.isFinite(s.camera.y) && Number.isFinite(s.camera.zoom)) {
    app.camera.x = s.camera.x;
    app.camera.y = s.camera.y;
    app.camera.zoom = s.camera.zoom;
    app.camera.changed = true;
  } else {
    app.fitBoard(active);
  }
  app.undoMgr.clear();
  app.boards.bump();
  app.planes.invalidate();
  app.ui.layersUI.open(false);
  app.ui.textUI.open(false);
  app.ui.layersUI.sync(true);
  app.ui.layersUI.scheduleThumbs();
}

/** @param {any} snapshot */
export function downloadProjectSnapshot(snapshot) {
  const s = normalizeSnapshot(snapshot);
  const blob = new Blob([JSON.stringify(s)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFilename(s.name)}.fablepaint`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** @param {File} file */
export async function readProjectFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const s = normalizeSnapshot(parsed);
  if (!s.name || s.name === 'Untitled') {
    s.name = safeName(file.name.replace(/\.fablepaint$/i, '').replace(/\.json$/i, ''));
  }
  return s;
}

/** @param {any} snapshot @param {string} fallbackId @param {number} createdAt */
function makeMeta(snapshot, fallbackId, createdAt) {
  const stats = projectStats(snapshot);
  const updatedAt = Date.now();
  return {
    id: fallbackId,
    name: safeName(snapshot.name),
    createdAt,
    updatedAt,
    savedAt: snapshot.savedAt || new Date(updatedAt).toISOString(),
    ...stats,
  };
}

async function putProject(id, snapshot, createdAt = Date.now()) {
  const db = await openDb();
  const meta = makeMeta(snapshot, id, createdAt);
  const tx = db.transaction([STORE_PROJECTS, STORE_META], 'readwrite');
  tx.objectStore(STORE_PROJECTS).put({ id, snapshot });
  tx.objectStore(STORE_META).put(meta);
  await txDone(tx);
  return meta;
}

async function getProjectRecord(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_PROJECTS, 'readonly').objectStore(STORE_PROJECTS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('Lettura progetto fallita.'));
  });
}

async function getProjectMeta(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error('Lettura metadati progetto fallita.'));
  });
}

async function listProjectMeta() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    /** @type {any[]} */
    const out = [];
    const req = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        out.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(out);
        return;
      }
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error || new Error('Lettura progetti fallita.'));
  });
}

async function deleteProject(id) {
  const db = await openDb();
  const tx = db.transaction([STORE_PROJECTS, STORE_META], 'readwrite');
  tx.objectStore(STORE_PROJECTS).delete(id);
  tx.objectStore(STORE_META).delete(id);
  await txDone(tx);
}

/** @param {number} bytes */
function fmtBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** @param {number} t */
function fmtDate(t) {
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(t));
}

/** @param {any} meta */
function fmtProjectMeta(meta) {
  const layerLabel = meta.layers === 1 ? 'livello' : 'livelli';
  return `${fmtDate(meta.updatedAt)} · ${meta.boards} canvas · ${meta.layers} ${layerLabel} · ${fmtBytes(meta.rawBytes)}`;
}

/** @param {import('./main.js').App} app */
function appBusy(app) {
  return !!(app.strokeLive || app.pendingCommit || app.commitJob || app.imageImporting ||
    app.transform?.pending || app.transform?.dragging ||
    app.fx?.pending || app.layerStyle?.pending || app.fillUI?.pending);
}

export class ProjectHub {
  /** @param {import('./main.js').App} app */
  constructor(app) {
    this.app = app;
    this.home = document.getElementById('home');
    this.listEl = document.getElementById('home-project-list');
    this.emptyEl = document.getElementById('home-empty');
    this.nameInput = /** @type {HTMLInputElement} */ (document.getElementById('home-project-name'));
    this.statusEl = document.getElementById('home-status');
    this.fileInput = /** @type {HTMLInputElement} */ (document.getElementById('project-file'));
    this.lastProjectId = localStorage.getItem(CURRENT_KEY) || '';
    this.currentId = newProjectId();
    this.currentName = 'Untitled';
    this.createdAt = Date.now();
    this._saving = false;
    this._metas = [];

    this._bind();
    this.open(true);
    this.refreshList();
  }

  _bind() {
    document.getElementById('btn-home').addEventListener('click', () => this.open(true));
    document.getElementById('home-close').addEventListener('click', () => this.open(false));
    document.getElementById('home-new').addEventListener('click', () => this.newProject());
    document.getElementById('home-import').addEventListener('click', () => this.fileInput.click());
    document.getElementById('home-save').addEventListener('click', () => this.saveNow(true));
    document.getElementById('home-export').addEventListener('click', () => this.exportCurrent());
    this.fileInput.addEventListener('change', async () => {
      const f = this.fileInput.files && this.fileInput.files[0];
      this.fileInput.value = '';
      if (f) await this.importFile(f);
    });
    this.nameInput.addEventListener('change', () => {
      this.currentName = safeName(this.nameInput.value);
      this.nameInput.value = this.currentName;
    });
    this.home.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      this.home.classList.add('dragging');
    });
    this.home.addEventListener('dragleave', () => this.home.classList.remove('dragging'));
    this.home.addEventListener('drop', async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      this.home.classList.remove('dragging');
      await this.importFile(e.dataTransfer.files[0]);
    });
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') {
        e.preventDefault();
        this.saveNow(true);
      } else if ((e.ctrlKey || e.metaKey) && k === 'o') {
        e.preventDefault();
        this.fileInput.click();
      } else if (k === 'escape' && this.isOpen) {
        this.open(false);
      }
    });
  }

  get isOpen() { return this.home.classList.contains('open'); }

  /** @param {boolean} v */
  open(v) {
    this.home.classList.toggle('open', v);
    document.body.classList.toggle('home-open', v);
    if (v) {
      this.nameInput.value = this.currentName;
      this.refreshList();
    }
  }

  setStatus(text) {
    this.statusEl.textContent = text || '';
  }

  async refreshList() {
    try {
      this._metas = await listProjectMeta();
      this._renderList();
    } catch (err) {
      console.error(err);
      this.setStatus('Cache locale non disponibile.');
    }
  }

  _renderList() {
    this.listEl.textContent = '';
    const lastId = localStorage.getItem(CURRENT_KEY);
    const lastMeta = this._metas.find((m) => m.id === lastId);
    const cont = /** @type {HTMLButtonElement} */ (document.getElementById('home-continue'));
    cont.disabled = !lastMeta;
    cont.textContent = lastMeta ? `Continua: ${lastMeta.name}` : 'Continua';
    cont.onclick = () => { if (lastMeta) this.loadProject(lastMeta.id); };

    this.emptyEl.hidden = this._metas.length > 0;
    for (const meta of this._metas) {
      const row = document.createElement('article');
      row.className = 'project-card';
      row.tabIndex = 0;
      row.addEventListener('click', () => this.loadProject(meta.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.loadProject(meta.id);
      });

      const thumb = document.createElement('div');
      thumb.className = 'project-thumb';
      thumb.innerHTML = `<span>${meta.boards}</span><small>${meta.layers}</small>`;

      const body = document.createElement('div');
      body.className = 'project-card-body';
      const title = document.createElement('strong');
      title.textContent = meta.name;
      const info = document.createElement('span');
      info.textContent = fmtProjectMeta(meta);
      body.append(title, info);

      const actions = document.createElement('div');
      actions.className = 'project-card-actions';
      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.title = 'Esporta progetto';
      exportBtn.textContent = 'Esporta';
      exportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.exportStored(meta.id);
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.title = 'Elimina dalla cartella lavori';
      delBtn.textContent = 'Elimina';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.deleteStored(meta.id);
      });
      actions.append(exportBtn, delBtn);
      row.append(thumb, body, actions);
      this.listEl.appendChild(row);
    }
  }

  async newProject() {
    if (appBusy(this.app)) { this.setStatus('Completa prima l’operazione in corso.'); return; }
    this.currentId = newProjectId();
    this.currentName = safeName(this.nameInput.value || 'Untitled');
    this.createdAt = Date.now();
    const blank = {
      kind: APP_KIND,
      version: FILE_VERSION,
      name: this.currentName,
      activeBoardId: 1,
      boards: [],
    };
    applyProjectSnapshot(this.app, {
      ...blank,
      boards: [{
        id: 1, name: 'Canvas 1', x: 0, y: 0, w: 2048, h: 2048,
        activeLayerId: 1,
        layers: [{ id: 1, kind: 'raster', name: 'Layer 1', visible: true, opacity: 1, chunks: [] }],
      }],
    });
    this.setStatus('Nuovo lavoro aperto. Premi Salva per metterlo nella cartella lavori.');
    track('project_new');
    this.open(false);
  }

  async loadProject(id) {
    if (appBusy(this.app)) { this.setStatus('Completa prima l’operazione in corso.'); return; }
    try {
      const rec = await getProjectRecord(id);
      if (!rec) throw new Error('Progetto non trovato.');
      applyProjectSnapshot(this.app, rec.snapshot);
      const meta = await getProjectMeta(id);
      this.currentId = id;
      this.currentName = safeName(rec.snapshot.name || meta?.name);
      this.createdAt = meta?.createdAt || Date.now();
      localStorage.setItem(CURRENT_KEY, id);
      this.setStatus(`Aperto: ${this.currentName}`);
      track('project_open', projectStats(rec.snapshot));
      this.open(false);
    } catch (err) {
      console.error(err);
      track('project_open_failed', { message: err instanceof Error ? err.message : String(err) });
      this.setStatus(err instanceof Error ? err.message : 'Apertura fallita.');
    }
  }

  async importFile(file) {
    if (appBusy(this.app)) { this.setStatus('Completa prima l’operazione in corso.'); return; }
    try {
      const snapshot = await readProjectFile(file);
      applyProjectSnapshot(this.app, snapshot);
      this.currentId = newProjectId();
      this.currentName = safeName(snapshot.name);
      this.createdAt = Date.now();
      this.setStatus(`Importato: ${this.currentName}. Premi Salva per metterlo nella cartella lavori.`);
      track('project_import_success', projectStats(snapshot));
      this.open(false);
    } catch (err) {
      console.error(err);
      track('project_import_failed', { message: err instanceof Error ? err.message : String(err) });
      this.setStatus(err instanceof Error ? err.message : 'Import progetto fallito.');
    }
  }

  async exportCurrent() {
    try {
      const snapshot = makeProjectSnapshot(this.app, this.currentName);
      downloadProjectSnapshot(snapshot);
      this.setStatus('File progetto esportato.');
      track('project_export_success', projectStats(snapshot));
    } catch (err) {
      console.error(err);
      track('project_export_failed', { message: err instanceof Error ? err.message : String(err) });
      this.setStatus('Export progetto fallito.');
    }
  }

  async exportStored(id) {
    try {
      const rec = await getProjectRecord(id);
      if (!rec) throw new Error('Progetto non trovato.');
      downloadProjectSnapshot(rec.snapshot);
      track('stored_project_export_success', projectStats(rec.snapshot));
    } catch (err) {
      console.error(err);
      track('stored_project_export_failed', { message: err instanceof Error ? err.message : String(err) });
      this.setStatus(err instanceof Error ? err.message : 'Export progetto fallito.');
    }
  }

  async deleteStored(id) {
    const meta = this._metas.find((m) => m.id === id);
    if (!confirm(`Eliminare "${meta?.name || 'progetto'}" dalla cartella lavori?`)) return;
    await deleteProject(id);
    if (localStorage.getItem(CURRENT_KEY) === id) localStorage.removeItem(CURRENT_KEY);
    await this.refreshList();
    track('stored_project_delete');
  }

  async saveNow(manual = false) {
    if (this._saving || appBusy(this.app)) {
      if (manual) this.setStatus('Salvataggio appena possibile.');
      return;
    }
    this._saving = true;
    try {
      this.currentName = safeName(this.nameInput.value || this.currentName);
      const snapshot = makeProjectSnapshot(this.app, this.currentName);
      const meta = await putProject(this.currentId, snapshot, this.createdAt);
      this.createdAt = meta.createdAt;
      localStorage.setItem(CURRENT_KEY, this.currentId);
      await this.refreshList();
      this.setStatus(`Salvato nella cartella lavori · ${fmtDate(meta.updatedAt)}`);
      track('project_save_success', { manual, ...projectStats(snapshot) });
    } catch (err) {
      console.error(err);
      track('project_save_failed', { manual, message: err instanceof Error ? err.message : String(err) });
      this.setStatus(err instanceof Error ? err.message : 'Salvataggio nella cartella lavori fallito.');
    } finally {
      this._saving = false;
    }
  }
}
