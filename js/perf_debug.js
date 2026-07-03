import { CHUNK, CHUNK_BYTES } from './store.js';

const MAX_LOGS = 30000;
const SLOW_FRAME_MS = 10;
const BAD_FRAME_MS = 16.7;
const PRINT_COOLDOWN_MS = 250;
const DOCK_REFRESH_MS = 500;
const UA_MEMORY_REFRESH_MS = 10000;
const MB = 1024 * 1024;

function round(v, d = 2) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** d;
  return Math.round(v * m) / m;
}

function bytes(v) {
  return Math.round(Number(v) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

function fmtBytes(v) {
  const n = Number(v) || 0;
  if (n <= 0) return '0 MB';
  if (n >= 1024 * MB) return `${round(n / (1024 * MB), 2)} GB`;
  return `${round(n / MB, 1)} MB`;
}

function fmtMs(v) {
  return `${round(v, v >= 10 ? 1 : 2)} ms`;
}

export class PerfDebugConsole {
  /** @param {import('./main.js').App} app */
  constructor(app) {
    this.app = app;
    this.active = false;
    this.logs = [];
    this.seq = 0;
    this.startedAt = 0;
    this._lastFrameT = 0;
    this._lastPrintT = 0;
    this._lastDockSyncT = 0;
    this._lastModeKey = '';
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._longTaskCount = 0;
    this._longTaskMs = 0;
    this._longTaskMaxMs = 0;
    this._uiStateKey = '';
    this._uiStatePending = false;
    this._uaMemoryBytes = 0;
    this._uaMemoryT = 0;
    this._gpuInfo = null;
    this._installDock();
    this._installLongTaskObserver();
    this._installUiStateObserver();
    /** @type {any} */ (window).__perfDebug = this;
  }

  _installDock() {
    const dock = document.createElement('div');
    dock.id = 'perf-debug-dock';
    dock.setAttribute('aria-label', 'Performance debug logger');

    const controls = document.createElement('div');
    controls.className = 'perf-debug-controls';

    const start = document.createElement('button');
    start.type = 'button';
    start.id = 'perf-debug-start';
    start.textContent = 'Start';
    start.title = 'Start performance debug logging';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.id = 'perf-debug-copy';
    copy.textContent = 'Copy';
    copy.title = 'Copy chronological debug log';
    copy.disabled = true;

    // riassunto compatto: poche righe incollabili in chat (il log intero a
    // 60fps sono megabyte e si tronca)
    const sum = document.createElement('button');
    sum.type = 'button';
    sum.id = 'perf-debug-sum';
    sum.textContent = 'Sum';
    sum.title = 'Copy compact summary (snapshot + aggregates)';
    sum.disabled = true;

    controls.append(start, copy, sum);

    const metrics = document.createElement('div');
    metrics.id = 'perf-debug-metrics';
    metrics.setAttribute('aria-live', 'polite');
    /** @type {Record<string, HTMLElement>} */
    this.metrics = {};
    for (const [key, label] of [
      ['fps', 'FPS'],
      ['frame', 'Frame'],
      ['outside', 'Outside'],
      ['longtask', 'Long'],
      ['jsheap', 'JS heap'],
      ['browser', 'Browser'],
      ['wasm', 'WASM'],
      ['cpu', 'CPU px'],
      ['worker', 'Worker'],
      ['gpu', 'GPU est'],
      ['canvas', 'Canvas'],
      ['renderer', 'Renderer'],
      ['device', 'Device'],
    ]) {
      const row = document.createElement('div');
      row.className = 'perf-debug-row';
      const k = document.createElement('span');
      k.className = 'perf-debug-key';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'perf-debug-value';
      v.textContent = '-';
      row.append(k, v);
      metrics.appendChild(row);
      this.metrics[key] = v;
    }

    dock.append(controls, metrics);
    document.body.appendChild(dock);
    this.dock = dock;
    this.startBtn = start;
    this.copyBtn = copy;
    this.sumBtn = sum;

    start.addEventListener('click', () => {
      if (this.active) this.stop();
      else this.start();
    });
    copy.addEventListener('click', () => this.copy());
    sum.addEventListener('click', () => this.copySummary());
    this._syncDock();
  }

  start() {
    this.logs.length = 0;
    this.seq = 0;
    this.startedAt = performance.now();
    this._lastFrameT = 0;
    this._lastPrintT = 0;
    this._lastDockSyncT = 0;
    this._lastModeKey = '';
    this._longTaskCount = 0;
    this._longTaskMs = 0;
    this._longTaskMaxMs = 0;
    this._uaMemoryT = 0;
    this._uiStateKey = this._uiStateKeyNow();
    this.active = true;
    this._event('session_start', this._snapshot());
    console.log('[perf-debug] started');
    this._syncDock(true);
  }

  stop() {
    if (!this.active) return;
    this._event('session_stop', this._summary());
    this.active = false;
    console.log('[perf-debug] stopped', this._summary());
    this._syncDock(true);
  }

  async copy() {
    if (!this.logs.length) return;
    if (this.active) this._event('copy_while_running', this._summary());
    else this._event('copy', this._summary());
    const text = this.logs.map((x) => JSON.stringify(x)).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.copyBtn.textContent = 'Copied';
      setTimeout(() => this._syncDock(), 900);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.copyBtn.textContent = 'Copied';
      setTimeout(() => this._syncDock(), 900);
    }
    console.log('[perf-debug] copied records', this.logs.length);
  }

  // Riassunto compatto: snapshot ambiente + aggregati della sessione.
  // Poche centinaia di byte: pensato per essere incollato in una chat.
  async copySummary() {
    if (!this.logs.length) return;
    const text = JSON.stringify({ snapshot: this._snapshot(), summary: this._summary() }, null, 1);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (this.sumBtn) {
      this.sumBtn.textContent = 'Copied';
      setTimeout(() => this._syncDock(true), 900);
    }
    console.log('[perf-debug] copied summary');
  }

  /** @param {Record<string, any>} frame */
  sampleFrame(frame) {
    if (!this.active) return;
    const t = performance.now();
    const dt = this._lastFrameT ? t - this._lastFrameT : 0;
    this._lastFrameT = t;
    const diag = this._diagnostics(frame.proxies || null);
    const proxy = frame.proxyStats || diag.proxy;
    const longTaskCount = this._longTaskCount;
    const longTaskMs = this._longTaskMs;
    const longTaskMaxMs = this._longTaskMaxMs;
    this._longTaskCount = 0;
    this._longTaskMs = 0;
    this._longTaskMaxMs = 0;
    const entry = {
      type: 'frame',
      seq: ++this.seq,
      tMs: round(t - this.startedAt),
      iso: nowIso(),
      fps: dt > 0 ? round(1000 / dt, 1) : 0,
      dtMs: round(dt),
      frameMs: round(frame.frameMs),
      outsideMs: round(Math.max(0, dt - (frame.frameMs || 0))),
      longTaskCount,
      longTaskMs: round(longTaskMs),
      longTaskMaxMs: round(longTaskMaxMs),
      inputMs: round(frame.inputMs),
      rasterMs: round(frame.rasterMs),
      prepMs: round(frame.prepMs),
      proxyMs: round(frame.proxyMs),
      textQuadMs: round(frame.textQuadMs),
      transformMs: round(frame.transformMs),
      planesMs: round(frame.planesMs),
      overlayMs: round(frame.overlayMs),
      evictMs: round(frame.evictMs),
      uiMs: round(frame.uiMs),
      rasterPx: Math.round(frame.rasterPx || 0),
      queue: frame.queueCount || 0,
      commitChunksLeft: frame.commitChunksLeft || 0,
      workerRaster: !!frame.workerRaster,
      workerBacklog: Math.round(frame.workerBacklog || 0),
      workerFlushMs: round(frame.workerFlushMs || 0),
      screenCacheHit: !!frame.screenCacheHit,
      textBakes: frame.textBakes || 0,
      textBakeMs: round(frame.textBakeMs),
      textBakeMPx: round((frame.textBakePixels || 0) / 1e6, 3),
      renderer: diag.renderer,
      zoom: round(diag.zoom, 4),
      dpr: diag.dpr,
      activeBoard: diag.activeBoard,
      boards: diag.boards,
      layers: diag.layers,
      rasterLayers: diag.rasterLayers,
      textLayers: diag.textLayers,
      chunks: diag.chunks,
      liveVisibleChunks: diag.liveVisibleChunks,
      liveScreenMPx: round(diag.liveScreenPx / 1e6, 3),
      skippedChunks: diag.skippedChunks,
      proxyVisible: proxy.visibleBoards,
      proxyLiveBoards: proxy.liveBoards,
      proxyBoards: proxy.proxiedBoards,
      proxyReady: proxy.readyProxies,
      proxyLoading: proxy.loadingProxies,
      proxyTextures: proxy.proxyTextures,
      proxyBytes: bytes(proxy.proxyBytes),
      buildingBoardId: proxy.buildingBoardId || 0,
      textQuadBytes: bytes(diag.textQuadBytes),
      textQuadDirty: diag.textQuadDirty,
      rendererTextures: diag.rendererTextures,
      heapBytes: bytes(diag.heapBytes),
      jsHeapBytes: bytes(diag.jsHeapBytes),
      jsHeapTotalBytes: bytes(diag.jsHeapTotalBytes),
      jsHeapLimitBytes: bytes(diag.jsHeapLimitBytes),
      uaMemoryBytes: bytes(this._uaMemoryBytes),
      deviceMemoryGB: diag.deviceMemoryGB,
      cpuPixelLiveBytes: bytes(diag.cpuPixelLiveBytes),
      cpuPixelPoolBytes: bytes(diag.cpuPixelPoolBytes),
      textCanvasBytes: bytes(diag.textCanvasBytes),
      canvasBackbufferBytes: bytes(diag.canvasBackbufferBytes),
      gpuChunkBytes: bytes(diag.gpuChunkBytes),
      gpuProxyBytes: bytes(diag.gpuProxyBytes),
      gpuTextBytes: bytes(diag.gpuTextBytes),
      gpuScratchBytes: bytes(diag.gpuScratchBytes),
      gpuEstimateBytes: bytes(diag.gpuEstimateBytes),
      gpuRenderer: diag.gpuRenderer,
      visibility: document.visibilityState,
      androidLite: document.body.classList.contains('android-perf-mode'),
      slow: frame.frameMs >= SLOW_FRAME_MS,
      bad: frame.frameMs >= BAD_FRAME_MS,
      likely: this._classify(frame, diag, proxy),
    };
    this._push(entry);
    this._maybeEvent(entry, proxy);
    if (entry.slow && t - this._lastPrintT >= PRINT_COOLDOWN_MS) {
      this._lastPrintT = t;
      console.debug('[perf-debug] slow frame', {
        tMs: entry.tMs,
        fps: entry.fps,
        frameMs: entry.frameMs,
        likely: entry.likely,
        phases: {
          proxy: entry.proxyMs,
          text: entry.textQuadMs,
          planes: entry.planesMs,
          evict: entry.evictMs,
          ui: entry.uiMs,
        },
        liveVisibleChunks: entry.liveVisibleChunks,
        liveScreenMPx: entry.liveScreenMPx,
        proxyLiveBoards: entry.proxyLiveBoards,
        proxyBoards: entry.proxyBoards,
        textBakes: entry.textBakes,
        screenCacheHit: entry.screenCacheHit,
      });
    }
    this._sampleUaMemory(t);
    this._syncDock();
  }

  /** @param {string} type @param {Record<string, any>} data */
  _event(type, data = {}) {
    this._push({
      type,
      seq: ++this.seq,
      tMs: this.startedAt ? round(performance.now() - this.startedAt) : 0,
      iso: nowIso(),
      ...data,
    });
  }

  /** @param {Record<string, any>} entry */
  _push(entry) {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  _installLongTaskObserver() {
    try {
      if (typeof PerformanceObserver === 'undefined') return;
      this._longTaskObserver = new PerformanceObserver((list) => {
        if (!this.active) return;
        for (const e of list.getEntries()) {
          this._longTaskCount++;
          this._longTaskMs += e.duration || 0;
          this._longTaskMaxMs = Math.max(this._longTaskMaxMs, e.duration || 0);
        }
      });
      this._longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      this._longTaskObserver = null;
    }
  }

  _installUiStateObserver() {
    try {
      this._uiObserver = new MutationObserver(() => {
        if (!this.active || this._uiStatePending) return;
        this._uiStatePending = true;
        requestAnimationFrame(() => {
          this._uiStatePending = false;
          this._maybeLogUiState();
        });
      });
      this._uiObserver.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden'],
      });
    } catch {
      this._uiObserver = null;
    }
  }

  _uiStateKeyNow() {
    const ids = [
      'home', 'presetspopup', 'blurpopup', 'liquifypopup', 'mockuppanel',
      'studio', 'layerspanel', 'textpanel', 'stresspanel', 'fxpanel',
      'lspanel', 'collabpanel', 'fill-banner', 'fill-pill', 'fill-tol',
      'cb-toast', 'cb-standby',
    ];
    const parts = [`body:${document.body.className}`];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      parts.push(`${id}:${el.className}:${el.hidden ? 1 : 0}`);
    }
    return parts.join('|');
  }

  _maybeLogUiState() {
    const key = this._uiStateKeyNow();
    if (key === this._uiStateKey) return;
    this._uiStateKey = key;
    this._event('ui_state', {
      bodyClass: document.body.className,
      openPanels: [
        'home', 'presetspopup', 'blurpopup', 'liquifypopup', 'mockuppanel',
        'studio', 'layerspanel', 'textpanel', 'stresspanel', 'fxpanel',
        'lspanel', 'collabpanel',
      ].filter((id) => document.getElementById(id)?.classList.contains('open')),
    });
  }

  /** @param {Record<string, any>} entry @param {Record<string, any>} proxy */
  _maybeEvent(entry, proxy) {
    const zoomBand = entry.zoom < 0.5 ? '<0.5' :
      entry.zoom < 1 ? '0.5-1' :
        entry.zoom < 2 ? '1-2' :
          entry.zoom < 4 ? '2-4' : '>=4';
    const modeKey = [
      zoomBand,
      entry.activeBoard,
      proxy.liveBoards,
      proxy.proxiedBoards,
      proxy.loadingProxies,
      entry.textBakes,
      entry.screenCacheHit ? 1 : 0,
    ].join('|');
    if (modeKey === this._lastModeKey) return;
    this._lastModeKey = modeKey;
    this._event('mode_change', {
      zoom: entry.zoom,
      zoomBand,
      activeBoard: entry.activeBoard,
      proxyLiveBoards: proxy.liveBoards,
      proxyBoards: proxy.proxiedBoards,
      proxyLoading: proxy.loadingProxies,
      textBakes: entry.textBakes,
      screenCacheHit: entry.screenCacheHit,
      liveVisibleChunks: entry.liveVisibleChunks,
      liveScreenMPx: entry.liveScreenMPx,
    });
  }

  /** @param {Record<string, any>} frame @param {Record<string, any>} diag @param {Record<string, any>} proxy */
  _classify(frame, diag, proxy) {
    if (frame.screenCacheHit) return 'screen-cache-hit';
    const phases = [
      ['planes', frame.planesMs || 0],
      ['textQuads', frame.textQuadMs || 0],
      ['proxy', frame.proxyMs || 0],
      ['evict', frame.evictMs || 0],
      ['raster', frame.rasterMs || 0],
      ['ui', frame.uiMs || 0],
      ['overlay', frame.overlayMs || 0],
    ].sort((a, b) => b[1] - a[1]);
    const top = phases[0][0];
    if ((frame.textBakes || 0) > 0 && (frame.textQuadMs || 0) >= 2) return 'text-bake-after-zoom';
    if (proxy.loadingProxies > 0 || (frame.proxyMs || 0) >= 2.5) return 'proxy-build-or-warmup';
    if (top === 'planes' && diag.liveVisibleChunks > 120) return 'live-chunk-render';
    if (top === 'planes' && diag.liveScreenPx > 8_000_000) return 'fill-rate-overdraw';
    if (top === 'evict') return 'texture-eviction';
    if (top === 'raster') return 'brush-raster';
    return top;
  }

  /** @param {import('./board_proxy.js').ProxyFrame|null} proxies */
  _diagnostics(proxies) {
    const app = this.app;
    const camera = app.camera;
    const r = camera.visibleRect(this._rect);
    const skip = proxies ? proxies.skip : null;
    let layers = 0, rasterLayers = 0, textLayers = 0, chunks = 0;
    let liveVisibleChunks = 0, skippedChunks = 0, liveScreenPx = 0;
    let textCanvasBytes = 0;
    for (const b of app.boards.boards) {
      for (const l of b.mgr.layers) {
        layers++;
        if (l.kind === 'text') textLayers++;
        if (l.blockCanvas) textCanvasBytes += l.blockCanvas.width * l.blockCanvas.height * 4;
        if (!l.store) continue;
        rasterLayers++;
        chunks += l.store.map.size;
        const skipped = skip !== null && skip.has(l.id);
        for (const c of l.store.map.values()) {
          const x0 = c.cx * CHUNK, y0 = c.cy * CHUNK;
          const x1 = x0 + CHUNK, y1 = y0 + CHUNK;
          if (x1 < r.x0 || y1 < r.y0 || x0 > r.x1 || y0 > r.y1) continue;
          if (skipped) {
            skippedChunks++;
            continue;
          }
          liveVisibleChunks++;
          const wx0 = Math.max(x0, r.x0);
          const wy0 = Math.max(y0, r.y0);
          const wx1 = Math.min(x1, r.x1);
          const wy1 = Math.min(y1, r.y1);
          liveScreenPx += Math.max(0, wx1 - wx0) * Math.max(0, wy1 - wy0) *
            camera.zoom * camera.zoom;
        }
      }
    }
    let textQuadBytes = 0, textQuadDirty = 0;
    if (app.textQuads && app.textQuads._map) {
      for (const e of app.textQuads._map.values()) {
        if (e.canvas) textQuadBytes += e.canvas.width * e.canvas.height * 4;
        if (e.texDirty) textQuadDirty++;
      }
    }
    textCanvasBytes += textQuadBytes;
    let cpuPixelLiveBytes = 0, cpuPixelPoolBytes = 0;
    if (app._allStores) {
      for (const st of app._allStores) {
        cpuPixelLiveBytes += (st.map?.size || 0) * CHUNK_BYTES;
        cpuPixelPoolBytes += (st._pool?.length || 0) * CHUNK_BYTES;
      }
    }
    const proxy = app.proxy && typeof app.proxy.stats === 'function'
      ? app.proxy.stats(app.boards, camera, app.boards.activeId)
      : {
        visibleBoards: 0, liveBoards: 0, proxiedBoards: 0,
        liveLayers: layers, proxiedLayers: 0,
        readyProxies: 0, loadingProxies: 0, proxyTextures: 0,
        proxyBytes: 0, buildingBoardId: 0,
      };
    const mem = /** @type {any} */ (performance).memory;
    const renderer = app.renderer || {};
    const hasGl = !!renderer.gl;
    const canvasBackbufferBytes = (app.canvas?.width || 0) * (app.canvas?.height || 0) * 4;
    const gpuChunkBytes = hasGl ? (renderer.texCount || 0) * CHUNK_BYTES : 0;
    const gpuProxyBytes = hasGl ? (proxy.proxyBytes || 0) : 0;
    const gpuTextBytes = hasGl ? textQuadBytes : 0;
    const gpuScratchBytes = hasGl ? this._rendererScratchBytes(renderer) : 0;
    const gpuEstimateBytes = hasGl
      ? canvasBackbufferBytes + gpuChunkBytes + gpuProxyBytes + gpuTextBytes + gpuScratchBytes
      : 0;
    const gpuInfo = this._rendererInfo();
    return {
      renderer: app.renderer.kind,
      rendererTextures: app.renderer.texCount || 0,
      zoom: camera.zoom,
      dpr: camera.dpr,
      activeBoard: app.boards.activeId,
      boards: app.boards.boards.length,
      layers,
      rasterLayers,
      textLayers,
      chunks,
      liveVisibleChunks,
      skippedChunks,
      liveScreenPx,
      textQuadBytes,
      textQuadDirty,
      proxy,
      heapBytes: app.heap ? app.heap.memory.buffer.byteLength : 0,
      jsHeapBytes: mem ? mem.usedJSHeapSize || 0 : 0,
      jsHeapTotalBytes: mem ? mem.totalJSHeapSize || 0 : 0,
      jsHeapLimitBytes: mem ? mem.jsHeapSizeLimit || 0 : 0,
      deviceMemoryGB: navigator.deviceMemory || 0,
      cpuPixelLiveBytes,
      cpuPixelPoolBytes,
      textCanvasBytes,
      canvasBackbufferBytes,
      gpuChunkBytes,
      gpuProxyBytes,
      gpuTextBytes,
      gpuScratchBytes,
      gpuEstimateBytes,
      gpuRenderer: gpuInfo.renderer || '',
      gpuVendor: gpuInfo.vendor || '',
      gpuMaxTextureSize: gpuInfo.maxTextureSize || 0,
    };
  }

  _snapshot() {
    const diag = this._diagnostics(null);
    return {
      url: location.href,
      userAgent: navigator.userAgent,
      renderer: diag.renderer,
      dpr: diag.dpr,
      zoom: round(diag.zoom, 4),
      boards: diag.boards,
      layers: diag.layers,
      chunks: diag.chunks,
      heapBytes: bytes(diag.heapBytes),
      jsHeapBytes: bytes(diag.jsHeapBytes),
      jsHeapLimitBytes: bytes(diag.jsHeapLimitBytes),
      deviceMemoryGB: diag.deviceMemoryGB,
      cpuPixelLiveBytes: bytes(diag.cpuPixelLiveBytes),
      cpuPixelPoolBytes: bytes(diag.cpuPixelPoolBytes),
      textCanvasBytes: bytes(diag.textCanvasBytes),
      canvasBackbufferBytes: bytes(diag.canvasBackbufferBytes),
      gpuEstimateBytes: bytes(diag.gpuEstimateBytes),
      gpuRenderer: diag.gpuRenderer,
      gpuVendor: diag.gpuVendor,
      gpuMaxTextureSize: diag.gpuMaxTextureSize,
      androidLite: document.body.classList.contains('android-perf-mode'),
      bodyClass: document.body.className,
      // raster worker: se false, i tratti girano sul main (manca SAB o
      // COOP/COEP, o il worker è morto) e il backlog resterà 0 per definizione
      workerAvailable: !!this.app.rasterSab && !!this.app.rasterBridge?.usable,
      workerReason: this.app.rasterBridge?.reason || '',
      coi: typeof crossOriginIsolated !== 'undefined' ? !!crossOriginIsolated : 'api-assente',
      sab: typeof SharedArrayBuffer !== 'undefined',
      cores: navigator.hardwareConcurrency || 0,
    };
  }

  _summary() {
    const frames = this.logs.filter((x) => x.type === 'frame');
    const slow = frames.filter((x) => x.slow);
    const avg = (key, list = frames) => list.length
      ? list.reduce((s, x) => s + (Number(x[key]) || 0), 0) / list.length
      : 0;
    const maxBy = (key) => frames.reduce((best, x) =>
      (Number(x[key]) || 0) > (Number(best?.[key]) || 0) ? x : best, null);
    const buckets = {};
    for (const f of slow) buckets[f.likely] = (buckets[f.likely] || 0) + 1;
    return {
      frames: frames.length,
      slowFrames: slow.length,
      avgFps: round(avg('fps'), 1),
      avgFrameMs: round(avg('frameMs')),
      avgOutsideMs: round(avg('outsideMs')),
      avgLongTaskMs: round(avg('longTaskMs')),
      avgPlanesMs: round(avg('planesMs')),
      avgTextQuadMs: round(avg('textQuadMs')),
      avgProxyMs: round(avg('proxyMs')),
      avgEvictMs: round(avg('evictMs')),
      workerFrames: frames.filter((x) => x.workerRaster).length,
      avgWorkerBacklog: round(avg('workerBacklog', frames.filter((x) => x.workerRaster)), 1),
      maxWorkerBacklog: frames.reduce((m, x) => Math.max(m, x.workerBacklog || 0), 0),
      maxWorkerFlushMs: round(frames.reduce((m, x) => Math.max(m, x.workerFlushMs || 0), 0)),
      totWorkerFlushMs: round(frames.reduce((s, x) => s + (x.workerFlushMs || 0), 0)),
      // fps DURANTE i tratti worker: la domanda vera (resta fluido mentre disegni?)
      avgFpsWorker: round(avg('fps', frames.filter((x) => x.workerRaster)), 1),
      avgFrameMsWorker: round(avg('frameMs', frames.filter((x) => x.workerRaster))),
      lastMemory: this._memorySummary(frames[frames.length - 1] || null),
      maxFrame: maxBy('frameMs'),
      slowBuckets: buckets,
    };
  }

  /** @param {boolean} [force] */
  _syncDock(force = false) {
    if (!this.startBtn || !this.copyBtn || !this.dock) return;
    const t = performance.now();
    if (!force && t - this._lastDockSyncT < DOCK_REFRESH_MS) return;
    this._lastDockSyncT = t;
    this.startBtn.textContent = this.active ? 'Stop' : 'Start';
    this.startBtn.classList.toggle('active', this.active);
    this.copyBtn.disabled = this.logs.length === 0;
    if (this.copyBtn.textContent !== 'Copied') this.copyBtn.textContent = 'Copy';
    if (this.sumBtn) {
      this.sumBtn.disabled = this.logs.length === 0;
      if (this.sumBtn.textContent !== 'Copied') this.sumBtn.textContent = 'Sum';
    }
    this._renderDockMetrics();
    this.dock.title = this.active
      ? `Perf debug running: ${this.logs.length} records`
      : `Perf debug idle: ${this.logs.length} records`;
  }

  _renderDockMetrics() {
    if (!this.metrics) return;
    const frames = this.logs.filter((x) => x.type === 'frame').slice(-120);
    const last = frames[frames.length - 1] || null;
    const avg = (key) => frames.length
      ? frames.reduce((s, x) => s + (Number(x[key]) || 0), 0) / frames.length
      : 0;
    const max = (key) => frames.reduce((m, x) => Math.max(m, Number(x[key]) || 0), 0);
    const diag = last || this._snapshot();
    const jsHeap = Number(diag.jsHeapBytes) || 0;
    const jsLimit = Number(diag.jsHeapLimitBytes) || 0;
    const browser = Number(diag.uaMemoryBytes) || this._uaMemoryBytes || 0;
    const cpuLive = Number(diag.cpuPixelLiveBytes) || 0;
    const cpuPool = Number(diag.cpuPixelPoolBytes) || 0;
    const gpu = Number(diag.gpuEstimateBytes) || 0;
    const canvas = Number(diag.canvasBackbufferBytes) || 0;
    const rendererName = diag.gpuRenderer ? ` · ${this._shortGpuName(diag.gpuRenderer)}` : '';
    this.metrics.fps.textContent = frames.length ? `${round(avg('fps'), 1)} avg` : '-';
    this.metrics.frame.textContent = frames.length
      ? `${fmtMs(avg('frameMs'))} · max ${fmtMs(max('frameMs'))}`
      : '-';
    this.metrics.outside.textContent = frames.length ? `${fmtMs(avg('outsideMs'))} avg` : '-';
    this.metrics.longtask.textContent = frames.length
      ? `${fmtMs(avg('longTaskMs'))} · max ${fmtMs(max('longTaskMaxMs'))}`
      : '-';
    this.metrics.jsheap.textContent = jsHeap
      ? `${fmtBytes(jsHeap)}${jsLimit ? ` / ${fmtBytes(jsLimit)}` : ''}`
      : 'not exposed';
    this.metrics.browser.textContent = browser ? fmtBytes(browser) : 'not exposed';
    this.metrics.wasm.textContent = diag.heapBytes ? fmtBytes(diag.heapBytes) : 'JS engine';
    this.metrics.cpu.textContent = `${fmtBytes(cpuLive)} live · ${fmtBytes(cpuPool)} pool`;
    // Worker raster: SOLO i frame col tratto in modalità worker contano per
    // l'arretrato (fuori dal tratto è sempre 0 e diluirebbe la media)
    const wFrames = frames.filter((x) => x.workerRaster);
    if (!this.app.rasterSab) {
      this.metrics.worker.textContent = 'off (niente SAB/COOP+COEP)';
    } else if (!wFrames.length) {
      this.metrics.worker.textContent = frames.length ? 'idle (nessun tratto worker)' : '-';
    } else {
      const bAvg = wFrames.reduce((s, x) => s + (x.workerBacklog || 0), 0) / wFrames.length;
      const bMax = wFrames.reduce((m, x) => Math.max(m, x.workerBacklog || 0), 0);
      const fMax = max('workerFlushMs');
      this.metrics.worker.textContent =
        `backlog ${Math.round(bAvg)} avg · ${bMax} max · flush max ${fmtMs(fMax)}`;
    }
    this.metrics.gpu.textContent = gpu
      ? `${fmtBytes(gpu)} est · tex ${diag.rendererTextures || 0}`
      : 'not exposed';
    this.metrics.canvas.textContent = `${fmtBytes(canvas)} backbuffer`;
    this.metrics.renderer.textContent = `${diag.renderer || this.app.renderer.kind}${rendererName}`;
    this.metrics.device.textContent =
      `${navigator.hardwareConcurrency || '?'} cores · ${navigator.deviceMemory || '?'} GB hint`;
  }

  /** @param {any} renderer */
  _rendererScratchBytes(renderer) {
    let bytes = 0;
    if (renderer._screenCacheTex) bytes += (renderer._screenCacheW || 0) * (renderer._screenCacheH || 0) * 4;
    if (renderer._grpTex) bytes += (renderer._grpW || 0) * (renderer._grpH || 0) * 4;
    if (renderer._bdTex) bytes += (renderer._bdW || 0) * (renderer._bdH || 0) * 4;
    const tf = this.app._lastTransformFrame;
    if (renderer._tfTex && tf) bytes += (tf.w || 0) * (tf.h || 0) * 4;
    const fx = this.app._lastFxFrame;
    if (fx) {
      if (renderer._fxSrc) bytes += (fx.w || 0) * (fx.h || 0) * 4;
      if (renderer._fxPing) bytes += (fx.w || 0) * (fx.h || 0) * 4;
      if (renderer._fxOut) bytes += (fx.w || 0) * (fx.h || 0) * 4;
    }
    return bytes;
  }

  _rendererInfo() {
    if (this._gpuInfo) return this._gpuInfo;
    const gl = this.app.renderer.gl;
    const info = { vendor: '', renderer: '', maxTextureSize: 0 };
    if (!gl) {
      this._gpuInfo = info;
      return info;
    }
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      info.vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      info.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    } catch {
      // Some privacy modes block the unmasked renderer string.
    }
    this._gpuInfo = info;
    return info;
  }

  /** @param {number} now */
  _sampleUaMemory(now) {
    const perf = /** @type {any} */ (performance);
    if (typeof perf.measureUserAgentSpecificMemory !== 'function') return;
    if (now - this._uaMemoryT < UA_MEMORY_REFRESH_MS) return;
    this._uaMemoryT = now;
    perf.measureUserAgentSpecificMemory()
      .then((r) => { this._uaMemoryBytes = r.bytes || 0; this._syncDock(true); })
      .catch(() => { this._uaMemoryBytes = 0; });
  }

  /** @param {Record<string, any>|null} f */
  _memorySummary(f) {
    if (!f) return null;
    return {
      jsHeap: fmtBytes(f.jsHeapBytes),
      browser: f.uaMemoryBytes ? fmtBytes(f.uaMemoryBytes) : 'not exposed',
      wasm: f.heapBytes ? fmtBytes(f.heapBytes) : 'JS engine',
      cpuPixels: `${fmtBytes(f.cpuPixelLiveBytes)} live + ${fmtBytes(f.cpuPixelPoolBytes)} pool`,
      gpuEstimate: f.gpuEstimateBytes ? fmtBytes(f.gpuEstimateBytes) : 'not exposed',
      canvasBackbuffer: fmtBytes(f.canvasBackbufferBytes),
      deviceMemory: f.deviceMemoryGB ? `${f.deviceMemoryGB} GB hint` : 'not exposed',
    };
  }

  /** @param {string} name */
  _shortGpuName(name) {
    return String(name)
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\bANGLE\b|\bOpenGL\b|\bES\b|\bDirect3D\d*\b|\bVulkan\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 42);
  }
}
