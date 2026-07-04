import { brush } from './brush.js';
import { BLEND_MODES, makeRasterLayer, makeTextLayer } from './layers.js';
import { CHUNK, CHUNK_BYTES } from './store.js';
import { defaultTextStyle, makeTextItem, TEXT_FONTS, touchText } from './text_layer.js';
import { defaultGrainTexture } from './texture.js';

const MAX_LOGS = 30000;
const SLOW_FRAME_MS = 10;
const BAD_FRAME_MS = 16.7;
const PRINT_COOLDOWN_MS = 250;
const DOCK_REFRESH_MS = 500;
const UA_MEMORY_REFRESH_MS = 10000;
const MB = 1024 * 1024;
const AUTO_PRELOAD_MAX_MS = 60000;
const AUTO_PRELOAD_STABLE_FRAMES = 8;
const AUTO_LAYER_PREFIX = 'Auto Test - ';
const FIELD_PHASES = [
  {
    id: 'ready',
    label: 'Preparati',
    ms: 2500,
    hint: 'Posizionati sul canvas e prepara un pennello grande.',
  },
  {
    id: 'stroke',
    label: 'Tratto',
    ms: 8500,
    hint: 'Disegna un tratto lungo e veloce, meglio con size grande.',
  },
  {
    id: 'panzoom',
    label: 'Pan/zoom',
    ms: 8500,
    hint: 'Fai pinch, wheel o pan tra le board, anche zoom-out estremo.',
  },
  {
    id: 'idle',
    label: 'Fermo',
    ms: 4500,
    hint: 'Lascia tutto fermo: qui vediamo screen-cache e code residue.',
  },
];
const AUTO_FIELD_PHASES = [
  {
    id: 'autoSetup',
    label: 'Auto setup',
    ms: 1200,
    hint: 'Scena stress: multi-board, multi-layer, testo e chunk gia sporchi.',
  },
  {
    id: 'autoStroke',
    label: 'Texture stroke',
    ms: 8200,
    hint: 'Tratto veloce con grana, taper 0/0 e tanti punti ravvicinati.',
  },
  {
    id: 'autoPanzoom',
    label: 'Auto pan/zoom',
    ms: 11000,
    hint: 'Sweep aggressivo tra canvas, overview estrema e zoom di dettaglio.',
  },
  {
    id: 'autoIdle',
    label: 'Auto fermo',
    ms: 4200,
    hint: 'Camera ferma: misura cache, code residue e commit finale.',
  },
];
const AUTO_PALETTE = [
  [28, 88, 224], [241, 72, 96], [26, 176, 132], [248, 186, 44],
  [152, 91, 231], [245, 111, 47], [24, 24, 28], [255, 255, 255],
];

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

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerpLog(a, b, t) {
  if (a <= 0 || b <= 0) return lerp(a, b, t);
  return Math.exp(lerp(Math.log(a), Math.log(b), t));
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function packPremul(r, g, b, a = 255) {
  const k = a / 255;
  const pr = Math.round(r * k);
  const pg = Math.round(g * k);
  const pb = Math.round(b * k);
  return (a << 24) | (pb << 16) | (pg << 8) | pr;
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
    this._fieldRun = null;
    this._fieldReportText = '';
    this._autoStarting = false;
    this._autoStartToken = 0;
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

    const field = document.createElement('button');
    field.type = 'button';
    field.id = 'perf-debug-field';
    field.textContent = 'Field';
    field.title = 'Run a guided 24s field capture for PC, mobile and iPad';

    const auto = document.createElement('button');
    auto.type = 'button';
    auto.id = 'perf-debug-auto';
    auto.textContent = 'Auto';
    auto.title = 'Create an automated stress scene, draw, pan and zoom, then copy a report';

    controls.append(start, copy, sum, field, auto);

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
      ['gpustroke', 'GPU tratto'],
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
    this.fieldBtn = field;
    this.autoBtn = auto;

    start.addEventListener('click', () => {
      if (this.active) this.stop();
      else this.start();
    });
    copy.addEventListener('click', () => this.copy());
    sum.addEventListener('click', () => this.copySummary());
    field.addEventListener('click', () => this.toggleFieldTest());
    auto.addEventListener('click', () => this.toggleAutoFieldTest());
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

  toggleFieldTest() {
    if (this._fieldRun) this._finishFieldTest(true);
    else this.startFieldTest();
  }

  toggleAutoFieldTest() {
    if (this._fieldRun || this._autoStarting) this._finishFieldTest(true);
    else void this.startAutoFieldTest();
  }

  _resetFieldReportUi() {
    this._fieldReportText = '';
    if (this.fieldCopyBtn) {
      this.fieldCopyBtn.disabled = true;
      this.fieldCopyBtn.textContent = 'Copy Report';
    }
    if (this.fieldOutput) {
      this.fieldOutput.hidden = true;
      this.fieldOutput.value = '';
    }
  }

  startFieldTest() {
    this._ensureFieldPanel();
    this._resetFieldReportUi();
    if (document.getElementById('home')?.classList.contains('open')) {
      this._setFieldMessage(
        'Apri il canvas',
        'Premi Continua o apri un progetto, poi rilancia Field. Il test deve registrare disegno e pan/zoom reali.',
        '',
      );
      console.log('[field-test] blocked: home is open');
      return;
    }
    if (this.active) this.stop();
    this.start();
    const startedAt = performance.now();
    let t = 0;
    const phases = FIELD_PHASES.map((p) => {
      const out = { ...p, fromMs: t, toMs: t + p.ms };
      t += p.ms;
      return out;
    });
    this._fieldRun = {
      startedAt,
      totalMs: t,
      phases,
      phaseId: '',
      timer: 0,
      cancelled: false,
      mode: 'manual',
      automation: null,
    };
    if (this.fieldBtn) {
      this.fieldBtn.textContent = 'Stop';
      this.fieldBtn.classList.add('active');
    }
    this._event('field_start', {
      renderer: this.app.renderer.kind,
      webgpu: !!navigator.gpu,
      secureContext: !!window.isSecureContext,
      mode: 'manual',
      phases: phases.map((p) => ({ id: p.id, label: p.label, fromMs: p.fromMs, toMs: p.toMs })),
    });
    console.log('[field-test] start', {
      renderer: this.app.renderer.kind,
      webgpu: !!navigator.gpu,
      secureContext: !!window.isSecureContext,
      durationMs: t,
    });
    this._fieldTick();
  }

  async startAutoFieldTest() {
    if (this._autoStarting) return;
    this._ensureFieldPanel();
    this._resetFieldReportUi();
    if (document.getElementById('home')?.classList.contains('open')) {
      this._setFieldMessage(
        'Apri il canvas',
        'Premi Continua o apri un progetto, poi rilancia Auto. Il test deve creare scena, disegno e pan/zoom reali.',
        '',
      );
      console.log('[field-test] auto blocked: home is open');
      return;
    }
    if (this.active) this.stop();
    this._autoStarting = true;
    const token = ++this._autoStartToken;
    if (this.autoBtn) {
      this.autoBtn.textContent = 'Setup';
      this.autoBtn.classList.add('active');
    }
    this._setFieldMessage(
      'Auto setup',
      'Creo board/layer di prova e preparo un pennello base. Il documento corrente verra arricchito con elementi Auto Test.',
      '',
    );
    await nextFrame();
    let automation;
    try {
      automation = this._prepareAutoFieldScene();
      await this._preloadAutoFieldScene(automation, token);
      if (!this._autoStarting || token !== this._autoStartToken) {
        this._restoreAutoFieldState(automation);
        return;
      }
    } catch (err) {
      this._autoStarting = false;
      if (this.autoBtn) {
        this.autoBtn.textContent = 'Auto';
        this.autoBtn.classList.remove('active');
      }
      this._restoreAutoFieldState(automation);
      this._setFieldMessage('Auto fallito', err?.message || String(err), '');
      console.warn('[field-test] auto setup failed', err);
      return;
    }
    this._autoStarting = false;
    this.start();
    const startedAt = performance.now();
    let t = 0;
    const phases = AUTO_FIELD_PHASES.map((p) => {
      const out = { ...p, fromMs: t, toMs: t + p.ms };
      t += p.ms;
      return out;
    });
    this._fieldRun = {
      startedAt,
      totalMs: t,
      phases,
      phaseId: '',
      timer: 0,
      cancelled: false,
      mode: 'auto',
      automation,
    };
    if (this.autoBtn) {
      this.autoBtn.textContent = 'Stop';
      this.autoBtn.classList.add('active');
    }
    this._event('field_start', {
      renderer: this.app.renderer.kind,
      webgpu: !!navigator.gpu,
      secureContext: !!window.isSecureContext,
      mode: 'auto',
      automation: this._autoFieldReport(automation),
      phases: phases.map((p) => ({ id: p.id, label: p.label, fromMs: p.fromMs, toMs: p.toMs })),
    });
    console.log('[field-test] auto start', {
      renderer: this.app.renderer.kind,
      webgpu: !!navigator.gpu,
      secureContext: !!window.isSecureContext,
      durationMs: t,
      automation: this._autoFieldReport(automation),
    });
    this._fieldTick();
  }

  async _preloadAutoFieldScene(automation, token) {
    const app = this.app;
    const startedAt = performance.now();
    const expectedProxies = Math.max(0, (automation?.boards?.length || 1) - 1);
    const prevForceProxyBuild = app._forceProxyBuild;
    let frames = 0;
    let stable = 0;
    let last = null;
    app._forceProxyBuild = true;
    try {
      while (performance.now() - startedAt < AUTO_PRELOAD_MAX_MS) {
        if (!this._autoStarting || token !== this._autoStartToken) break;
        app.requestFrame();
        await nextFrame();
        frames++;
        const diag = this._diagnostics(null);
        const proxy = diag.proxy || {};
        const proxyBusy = (proxy.loadingProxies || 0) > 0 ||
          (proxy.buildingBoardId || 0) !== 0 ||
          !!app.proxy?.needsFrame?.();
        const bakeBusy = (app.textQuads?.bakedThisFrame || 0) > 0 ||
          (app.svgQuads?.bakedThisFrame || 0) > 0 ||
          !!app.svgQuads?.needsFrame?.();
        const uploadBusy = (app.renderer?.uploadsThisFrame || 0) > 0;
        const readyEnough = (proxy.readyProxies || 0) >= expectedProxies;
        last = {
          frames,
          elapsedMs: round(performance.now() - startedAt),
          expectedProxies,
          readyProxies: proxy.readyProxies || 0,
          loadingProxies: proxy.loadingProxies || 0,
          buildingBoardId: proxy.buildingBoardId || 0,
          buildScale: proxy.buildScale || 0,
          rendererTextures: diag.rendererTextures || 0,
          uploads: app.renderer?.uploadsThisFrame || 0,
          textBakes: app.textQuads?.bakedThisFrame || 0,
          svgBakes: app.svgQuads?.bakedThisFrame || 0,
        };
        if (!proxyBusy && !bakeBusy && !uploadBusy && readyEnough) stable++;
        else stable = 0;
        if (frames % 20 === 0 || stable > 0) {
          this._setFieldMessage(
            'Auto preload',
            `Carico canvas/layer/proxy prima della misura: proxy ${last.readyProxies}/${expectedProxies}, ` +
              `loading ${last.loadingProxies}, stable ${stable}/${AUTO_PRELOAD_STABLE_FRAMES}.`,
            '',
          );
        }
        if (stable >= AUTO_PRELOAD_STABLE_FRAMES) break;
      }
    } finally {
      app._forceProxyBuild = prevForceProxyBuild;
    }
    if (automation?.stats) {
      automation.stats.preload = {
        ...(last || {
          frames,
          elapsedMs: round(performance.now() - startedAt),
          expectedProxies,
          readyProxies: 0,
          loadingProxies: 0,
          buildingBoardId: 0,
          buildScale: 0,
          rendererTextures: 0,
          uploads: 0,
          textBakes: 0,
          svgBakes: 0,
        }),
        stableFrames: stable,
        complete: stable >= AUTO_PRELOAD_STABLE_FRAMES,
      };
    }
  }

  _fieldTick() {
    const run = this._fieldRun;
    if (!run) return;
    const elapsed = performance.now() - run.startedAt;
    const phase = run.phases.find((p) => elapsed >= p.fromMs && elapsed < p.toMs) ||
      run.phases[run.phases.length - 1];
    if (run.automation) this._advanceAutoField(run, elapsed, phase);
    if (phase.id !== run.phaseId) {
      run.phaseId = phase.id;
      this._event('field_phase', {
        phase: phase.id,
        label: phase.label,
        hint: phase.hint,
        fromMs: phase.fromMs,
        toMs: phase.toMs,
      });
      console.log(`[field-test] phase: ${phase.label}`, phase.hint);
    }
    const left = Math.max(0, run.totalMs - elapsed);
    const warn = this.app.renderer.kind === 'WebGPU'
      ? ''
      : 'Renderer non WebGPU: per il test WebGPU apri una volta con ?renderer=wgpu.';
    this._setFieldMessage(
      `${phase.label} · ${Math.ceil(left / 1000)}s`,
      warn ? `${phase.hint}\n${warn}` : phase.hint,
      '',
    );
    if (elapsed >= run.totalMs) {
      this._finishFieldTest(false);
      return;
    }
    run.timer = window.setTimeout(() => this._fieldTick(), run.automation ? 16 : 250);
  }

  /** @param {boolean} cancelled */
  _finishFieldTest(cancelled) {
    if (this._autoStarting) {
      this._autoStarting = false;
      this._autoStartToken++;
      if (this.autoBtn) {
        this.autoBtn.textContent = 'Auto';
        this.autoBtn.classList.remove('active');
      }
    }
    const run = this._fieldRun;
    if (!run) return;
    window.clearTimeout(run.timer);
    if (run.automation) this._finishAutoField(run.automation, cancelled);
    run.cancelled = cancelled;
    this._event(cancelled ? 'field_cancel' : 'field_end', {
      elapsedMs: round(performance.now() - run.startedAt),
      mode: run.mode || 'manual',
    });
    const report = this._buildFieldReport(run);
    this._fieldReportText = JSON.stringify(report, null, 1);
    console.log(cancelled ? '[field-test] cancelled report' : '[field-test] report', report);
    this.stop();
    this._fieldRun = null;
    if (this.fieldBtn) {
      this.fieldBtn.textContent = 'Field';
      this.fieldBtn.classList.remove('active');
    }
    if (this.autoBtn) {
      this.autoBtn.textContent = 'Auto';
      this.autoBtn.classList.remove('active');
    }
    if (this.fieldCopyBtn) this.fieldCopyBtn.disabled = false;
    this._setFieldMessage(
      cancelled ? 'Report parziale pronto' : 'Report pronto',
      'Premi Copy Report e incollalo qui. Il report e stato stampato anche in console.',
      this._fieldReportText,
    );
    this._syncDock(true);
  }

  _ensureFieldPanel() {
    if (this.fieldPanel) {
      this.fieldPanel.hidden = false;
      return;
    }
    const panel = document.createElement('div');
    panel.id = 'field-debug-panel';
    panel.setAttribute('aria-live', 'polite');

    const title = document.createElement('div');
    title.className = 'field-debug-title';
    title.textContent = 'Field test';

    const body = document.createElement('div');
    body.className = 'field-debug-body';

    const out = document.createElement('textarea');
    out.className = 'field-debug-output';
    out.readOnly = true;
    out.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'field-debug-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy Report';
    copy.disabled = true;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    actions.append(copy, close);

    panel.append(title, body, out, actions);
    document.body.appendChild(panel);
    this.fieldPanel = panel;
    this.fieldTitle = title;
    this.fieldBody = body;
    this.fieldOutput = out;
    this.fieldCopyBtn = copy;
    copy.addEventListener('click', () => this.copyFieldReport());
    close.addEventListener('click', () => {
      if (this._fieldRun) this._finishFieldTest(true);
      else panel.hidden = true;
    });
  }

  /** @param {string} title @param {string} body @param {string} output */
  _setFieldMessage(title, body, output) {
    if (!this.fieldPanel) this._ensureFieldPanel();
    if (this.fieldTitle) this.fieldTitle.textContent = title;
    if (this.fieldBody) this.fieldBody.textContent = body;
    if (this.fieldOutput) {
      this.fieldOutput.hidden = !output;
      this.fieldOutput.value = output || '';
    }
  }

  async copyFieldReport() {
    if (!this._fieldReportText) return;
    try {
      await navigator.clipboard.writeText(this._fieldReportText);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = this._fieldReportText;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (this.fieldCopyBtn) {
      this.fieldCopyBtn.textContent = 'Copied';
      setTimeout(() => {
        if (this.fieldCopyBtn) this.fieldCopyBtn.textContent = 'Copy Report';
      }, 900);
    }
    console.log('[field-test] copied report');
  }

  _autoFieldOptions() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const ua = navigator.userAgent || '';
    const mem = navigator.deviceMemory || 8;
    const iphone = /iPhone|iPod/i.test(ua);
    const ipad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    const android = /Android/i.test(ua);
    const ios = iphone || ipad;
    const mobile = coarse || /Android|iPhone|iPad|iPod/i.test(ua);
    const capped = mem > 0 && mem <= 4;
    let stress = '';
    try { stress = (new URLSearchParams(location.search).get('stress') || '').toLowerCase(); } catch { /* ignore */ }
    const forceUltra = stress === 'ultra';
    let profile = 'ultra-16c-1p2g-v1';
    let boardTarget = 16;
    let rasterLayers = 8;
    let paintedLayers = 5;
    let textLayers = mobile || capped ? 2 : 3;
    if (iphone) {
      profile = 'iphone-safe-6c-0p28g-v1';
      boardTarget = 6;
      rasterLayers = 5;
      paintedLayers = 3;
      textLayers = 1;
    } else if (ipad) {
      profile = 'ipad-safe-8c-0p38g-v1';
      boardTarget = 8;
      rasterLayers = 5;
      paintedLayers = 3;
      textLayers = 1;
    } else if (android && !forceUltra) {
      profile = capped ? 'android-safe-8c-0p38g-v2' : 'android-heavy-10c-0p64g-v2';
      boardTarget = capped ? 8 : 10;
      rasterLayers = capped ? 5 : 6;
      paintedLayers = capped ? 3 : 4;
      textLayers = capped ? 1 : 2;
    }
    const chunksPerLayer = 64;
    const targetPixelBytes = boardTarget * paintedLayers * chunksPerLayer * CHUNK_BYTES;
    return {
      seed: 0xFABA11,
      profile,
      deviceClass: ios ? 'ios' : android ? 'android' : mobile ? 'mobile' : 'desktop',
      boardTarget,
      rasterLayers,
      paintedLayers,
      textLayers,
      // 2048x2048 board = 8x8 chunks. Desktop keeps the full 16c/1.25GiB
      // target; Android defaults to a heavy but preloadable profile. Use
      // ?stress=ultra to force the original 16-board limit test on non-iOS.
      chunksPerLayer,
      marksPerChunk: ios ? 6 : mobile || capped ? 8 : 10,
      brushSize: iphone ? 180 : mobile || capped ? 240 : 320,
      strokeSamplesPerTick: ios ? 2 : mobile || capped ? 3 : 4,
      targetPixelBytes,
      strokeZoomFit: 0.88,
      textureScale: 0.42,
      textureDepth: 0.96,
      textureContrast: 2.2,
      textureFloor: 0.08,
      textureAngle: 27,
    };
  }

  _prepareAutoFieldScene() {
    const app = this.app;
    const cleanup = this._cleanupAutoFieldArtifacts();
    const opts = this._autoFieldOptions();
    const createdBoardIds = [];
    const stats = {
      opts,
      boardsBefore: app.boards.boards.length,
      cleanup,
      boardsUsed: 0,
      boardsAdded: 0,
      rasterLayersAdded: 0,
      textLayersAdded: 0,
      chunksPainted: 0,
      marksPainted: 0,
      strokePoints: 0,
      strokeStarted: false,
      strokeEnded: false,
      cameraSweeps: 0,
      brushSize: opts.brushSize,
      textured: true,
      taperStart: 0,
      taperEnd: 0,
      strokeSamplesPerTick: opts.strokeSamplesPerTick,
      targetPixelBytes: opts.targetPixelBytes,
      estimatedPaintBytes: 0,
      startedStrokeMode: '',
    };
    while (app.boards.boards.length < opts.boardTarget && app.boards.canAdd) {
      const board = app.addBoard();
      if (!board) break;
      createdBoardIds.push(board.id);
      stats.boardsAdded++;
    }
    const boards = app.boards.boards.slice(0, Math.max(1, Math.min(opts.boardTarget, app.boards.boards.length)));
    stats.boardsUsed = boards.length;
    const rng = mulberry32(opts.seed + boards.length * 17);
    for (let i = 0; i < boards.length; i++) {
      this._seedAutoBoard(boards[i], i, opts, rng, stats);
    }
    const strokeBoard = boards[0] || app.boards.active;
    if (!strokeBoard) throw new Error('Nessuna board disponibile per Auto Field.');
    const strokeLayer = makeRasterLayer('Auto Test - live stroke', app.heap);
    strokeLayer.opacity = 0.94;
    strokeBoard.mgr.insert(strokeLayer);
    app._allStores.add(strokeLayer.store);
    stats.rasterLayersAdded++;
    app.selectBoard(strokeBoard.id);
    strokeBoard.mgr.selectOnly(strokeLayer.id);
    const brushSnapshot = this._saveBrushState();
    const selectionSnapshot = this._saveSelectionState();
    app.selection?.clear();
    this._configureAutoBrush(opts);
    const bounds = this._autoSceneBounds(boards);
    app.fitBoard(strokeBoard);
    app.planes.invalidate();
    app.ui?.layersUI?.sync(true);
    app.ui?.layersUI?.scheduleThumbs();
    app.ui?.syncSliders?.();
    app.requestFrame();
    return {
      stats,
      opts,
      boards,
      strokeBoardId: strokeBoard.id,
      strokeLayerId: strokeLayer.id,
      createdBoardIds,
      strokeActive: false,
      strokeDone: false,
      strokeP: 0,
      strokeLast: null,
      sweepBounds: bounds,
      brushSnapshot,
      selectionSnapshot,
      restored: false,
    };
  }

  _seedAutoBoard(board, boardIndex, opts, rng, stats) {
    const app = this.app;
    for (let i = 0; i < opts.rasterLayers && board.mgr.canAdd; i++) {
      const layer = makeRasterLayer(`Auto Test - paint ${i + 1}`, app.heap);
      layer.opacity = 0.68 + rng() * 0.28;
      if (i % 3 === 2) layer.mode = BLEND_MODES[(boardIndex + i) % BLEND_MODES.length];
      board.mgr.insert(layer);
      app._allStores.add(layer.store);
      stats.rasterLayersAdded++;
      if (i < opts.paintedLayers) this._paintAutoLayer(layer.store, board, boardIndex, i, opts, rng, stats);
    }
    for (let i = 0; i < opts.textLayers && board.mgr.canAdd; i++) {
      const font = TEXT_FONTS[(boardIndex + i) % TEXT_FONTS.length];
      const style = defaultTextStyle();
      style.font = font.family;
      style.weight = font.weight;
      style.stroke = i % 2 ? 3 : 0;
      style.strokeColor = '#ffffff';
      style.shadowDist = i % 2 ? 0 : 18;
      style.shadowBlur = i % 2 ? 12 : 0;
      style.block = i % 3 === 0;
      const col = AUTO_PALETTE[(boardIndex * 2 + i) % AUTO_PALETTE.length];
      const item = makeTextItem(
        board.x + board.w * (0.28 + 0.24 * i),
        board.y + board.h * (0.24 + 0.28 * (i % 2)),
        `#${col.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
        Math.round(board.w * (0.07 + rng() * 0.04)),
      );
      item.text = `AUTO ${boardIndex + 1}.${i + 1}`;
      const layer = makeTextLayer(`Auto Test - text ${i + 1}`, item, style);
      layer.opacity = 0.86 + rng() * 0.12;
      touchText(layer);
      board.mgr.insert(layer);
      stats.textLayersAdded++;
    }
  }

  _paintAutoLayer(store, board, boardIndex, layerIndex, opts, rng, stats) {
    const cols = Math.max(1, Math.floor(board.w / CHUNK));
    const rows = Math.max(1, Math.floor(board.h / CHUNK));
    const slots = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) slots.push([x, y]);
    }
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = slots[i];
      slots[i] = slots[j];
      slots[j] = tmp;
    }
    const n = Math.min(opts.chunksPerLayer, slots.length);
    for (let i = 0; i < n; i++) {
      const [lx, ly] = slots[i];
      const cx = (board.x >> 8) + lx;
      const cy = (board.y >> 8) + ly;
      const chunk = store.getOrCreate(cx, cy);
      this._paintAutoChunk(chunk.data, boardIndex, layerIndex, i, opts.marksPerChunk, rng);
      chunk.touched = true;
      store.markDirty(chunk);
      stats.chunksPainted++;
      stats.marksPainted += opts.marksPerChunk;
      stats.estimatedPaintBytes = stats.chunksPainted * CHUNK_BYTES;
    }
  }

  _paintAutoChunk(data, boardIndex, layerIndex, chunkIndex, marks, rng) {
    const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    for (let m = 0; m < marks; m++) {
      const col = AUTO_PALETTE[(boardIndex * 5 + layerIndex * 3 + chunkIndex + m) % AUTO_PALETTE.length];
      const alpha = 72 + Math.floor(rng() * 150);
      const color = packPremul(col[0], col[1], col[2], alpha);
      const x0 = Math.floor(rng() * 220);
      const y0 = Math.floor(rng() * 220);
      const w = 18 + Math.floor(rng() * 72);
      const h = 12 + Math.floor(rng() * 82);
      const x1 = Math.min(CHUNK, x0 + w);
      const y1 = Math.min(CHUNK, y0 + h);
      for (let y = y0; y < y1; y++) {
        let o = y * CHUNK + x0;
        for (let x = x0; x < x1; x++, o++) {
          if (((x + y + m * 13) & 7) !== 0) u32[o] = color;
        }
      }
    }
  }

  _saveBrushState() {
    const out = {};
    for (const key of Object.keys(brush)) {
      const value = brush[key];
      out[key] = key === 'color' && value ? { ...value } : value;
    }
    return out;
  }

  _configureAutoBrush(opts) {
    this.app.ui?.setTool?.('brush');
    brush.tool = 'brush';
    brush.size = opts.brushSize;
    brush.opacity = 0.96;
    brush.hardness = 0.62;
    brush.smoothing = 0.02;
    brush.pressureSize = 0;
    brush.spacing = 0.025;
    brush.roundness = 1;
    brush.angle = 0;
    brush.rotation = 0;
    brush.shape = null;
    brush.shapeInvert = false;
    brush.scatter = false;
    brush.aquaEnabled = false;
    brush.aquaColorMix = 0;
    brush.texture = defaultGrainTexture();
    brush.textureOn = true;
    brush.textureScale = opts.textureScale;
    brush.textureAngle = opts.textureAngle;
    brush.textureDepth = opts.textureDepth;
    brush.textureFloor = opts.textureFloor;
    brush.textureContrast = opts.textureContrast;
    brush.textureInvert = false;
    brush.textureMoving = false;
    brush.textureUseColor = true;
    brush.buildup = false;
    brush.taperStart = 0;
    brush.taperEnd = 0;
    brush.color = { r: 22, g: 82, b: 232 };
    this.app.ui?.syncSliders?.();
  }

  _restoreBrushState(snapshot) {
    if (!snapshot) return;
    for (const key of Object.keys(snapshot)) {
      brush[key] = key === 'color' && snapshot[key] ? { ...snapshot[key] } : snapshot[key];
    }
    this.app.ui?.setTool?.(brush.tool);
    this.app.ui?.syncSliders?.();
  }

  _saveSelectionState() {
    const s = this.app.selection;
    if (!s) return null;
    return {
      mask: s.mask,
      boardId: s.boardId,
      bx: s.bx,
      by: s.by,
      bw: s.bw,
      bh: s.bh,
      bounds: s.bounds ? { ...s.bounds } : null,
      count: s.count,
      tolerance: s.tolerance,
      kind: s.kind,
      operation: s.operation,
      pick: s._pick ? { ...s._pick } : null,
      pickCanReselect: !!s._pickCanReselect,
    };
  }

  _restoreSelectionState(snapshot) {
    const s = this.app.selection;
    if (!s || !snapshot) return;
    s.mask = snapshot.mask;
    s.boardId = snapshot.boardId;
    s.bx = snapshot.bx;
    s.by = snapshot.by;
    s.bw = snapshot.bw;
    s.bh = snapshot.bh;
    s.bounds = snapshot.bounds;
    s.count = snapshot.count;
    s.tolerance = snapshot.tolerance;
    s.kind = snapshot.kind;
    s.operation = snapshot.operation;
    if (snapshot.pick) s._pick = { ...snapshot.pick };
    s._pickCanReselect = snapshot.pickCanReselect;
    s.ver++;
    this.app.ui?.syncSelectOptions?.();
  }

  _autoSceneBounds(boards) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boards) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }

  _advanceAutoField(run, elapsed, phase) {
    const auto = run.automation;
    if (!auto) return;
    if (phase.id === 'autoStroke') this._advanceAutoStroke(run, auto, elapsed, phase);
    else if (auto.strokeActive) this._endAutoStroke(auto, performance.now());
    if (phase.id === 'autoPanzoom') this._advanceAutoCamera(auto, elapsed, phase);
    if (phase.id === 'autoIdle' && !auto.idleFramed) {
      auto.idleFramed = true;
      this.app.requestFrame();
    }
  }

  _advanceAutoStroke(run, auto, elapsed, phase) {
    const board = this.app.boards.byId(auto.strokeBoardId);
    if (!board) return;
    const targetP = clamp((elapsed - phase.fromMs) / Math.max(1, phase.toMs - phase.fromMs), 0, 1);
    const samples = Math.max(1, auto.opts?.strokeSamplesPerTick || 1);
    const prevP = auto.strokeP || 0;
    const duration = Math.max(1, phase.toMs - phase.fromMs);
    for (let i = 1; i <= samples; i++) {
      const p = lerp(prevP, targetP, i / samples);
      if (p <= prevP && auto.strokeActive) continue;
      const pt = this._autoStrokePoint(board, p);
      const t = run.startedAt + phase.fromMs + p * duration;
      if (!auto.strokeActive && !auto.strokeDone) {
        this.app.selectBoard(board.id);
        board.mgr.selectOnly(auto.strokeLayerId);
        this.app.selection?.clear();
        this.app.camera.zoom = clamp(
          Math.min(this.app.camera.w / board.w, this.app.camera.h / board.h) * (auto.opts?.strokeZoomFit || 0.88),
          0.02,
          this.app.camera.maxZoom || 4,
        );
        this.app.camera.x = board.x + board.w / 2;
        this.app.camera.y = board.y + board.h / 2;
        this.app.camera.changed = true;
        this.app.startStroke(pt.x, pt.y, pt.pressure, t, true);
        auto.strokeActive = !!this.app.strokeLive;
        auto.stats.strokeStarted = auto.strokeActive;
        auto.stats.startedStrokeMode = this.app.rasterMode || '';
      } else if (auto.strokeActive && this.app.strokeLive) {
        this.app.engine.move(pt.x, pt.y, pt.pressure, t);
        this.app.ink.strokePoint(pt.x, pt.y, pt.pressure, t);
        this.app.collab?.strokePoint?.(pt.x, pt.y, pt.pressure, t);
      }
      auto.strokeLast = { x: pt.x, y: pt.y, pressure: pt.pressure, t };
      auto.stats.strokePoints++;
    }
    auto.strokeP = targetP;
    if (auto.strokeActive) {
      this.app.camera.x = board.x + board.w / 2;
      this.app.camera.y = board.y + board.h / 2;
      this.app.camera.changed = true;
    }
    this.app.requestFrame();
  }

  _autoStrokePoint(board, p) {
    const waveA = Math.sin(p * Math.PI * 12);
    const waveB = Math.sin(p * Math.PI * 31 + 0.7);
    const waveC = Math.sin(p * Math.PI * 5 + 1.6);
    const x = board.x + board.w * clamp(0.08 + 0.84 * p + 0.045 * waveC, 0.04, 0.96);
    const y = board.y + board.h * clamp(0.5 + 0.32 * waveA + 0.095 * waveB, 0.08, 0.92);
    const pressure = clamp(0.78 + Math.sin(p * Math.PI * 18) * 0.18 + waveB * 0.05, 0.38, 1);
    return { x, y, pressure };
  }

  _endAutoStroke(auto, t = performance.now()) {
    if (!auto.strokeActive || auto.strokeDone) return;
    const last = auto.strokeLast;
    if (last && this.app.strokeLive) {
      this.app.engine.end(last.x, last.y, last.pressure, t);
      this.app.ink.strokeEnd();
      if (this.app.engine.snapMode) this.app._syncSnapStroke();
      else if (this.app.engine.endPassNeeded) this.app._endPass();
      this.app.pendingCommit = true;
      this.app.collab?.strokeEnd?.(last.x, last.y, last.pressure, t);
    }
    auto.strokeActive = false;
    auto.strokeDone = true;
    auto.stats.strokeEnded = true;
    auto.stats.endedStrokeMode = this.app.rasterMode || '';
    this.app.requestFrame();
  }

  _advanceAutoCamera(auto, elapsed, phase) {
    const boards = auto.boards;
    if (!boards || boards.length === 0) return;
    const p = clamp((elapsed - phase.fromMs) / Math.max(1, phase.toMs - phase.fromMs), 0, 1);
    const scaled = p * Math.max(1, boards.length - 1);
    const i = Math.min(boards.length - 1, Math.floor(scaled));
    const j = Math.min(boards.length - 1, i + 1);
    const f = smoothstep(scaled - i);
    const a = boards[i], b = boards[j];
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const bounds = auto.sweepBounds;
    const cam = this.app.camera;
    const boardZoom = clamp(Math.min(cam.w / a.w, cam.h / a.h) * 0.8, 0.04, cam.maxZoom || 4);
    const overviewZoom = bounds
      ? clamp(Math.min(cam.w / Math.max(1, bounds.x1 - bounds.x0), cam.h / Math.max(1, bounds.y1 - bounds.y0)) * 0.84, 0.02, boardZoom)
      : boardZoom;
    const detailZoom = clamp(boardZoom * 2.4, boardZoom, cam.maxZoom || 4);
    const wave = (1 - Math.cos(p * Math.PI * 2)) * 0.5;
    const zoom = wave < 0.5
      ? lerpLog(overviewZoom, boardZoom, wave * 2)
      : lerpLog(boardZoom, detailZoom, (wave - 0.5) * 2);
    const overviewWeight = clamp((boardZoom - zoom) / Math.max(0.0001, boardZoom - overviewZoom), 0, 1);
    const sceneX = bounds ? (bounds.x0 + bounds.x1) / 2 : lerp(ax, bx, f);
    const sceneY = bounds ? (bounds.y0 + bounds.y1) / 2 : lerp(ay, by, f);
    cam.x = lerp(lerp(ax, bx, f), sceneX, overviewWeight);
    cam.y = lerp(lerp(ay, by, f), sceneY, overviewWeight);
    cam.zoom = zoom;
    cam.changed = true;
    auto.stats.cameraSweeps++;
    this.app.requestFrame();
  }

  _finishAutoField(auto, cancelled) {
    if (!auto || auto.restored) return;
    if (auto.strokeActive) {
      if (cancelled) this.app.cancelStroke?.();
      else this._endAutoStroke(auto, performance.now());
    }
    this._restoreAutoFieldState(auto);
  }

  _restoreAutoFieldState(auto) {
    if (!auto || auto.restored) return;
    auto.restored = true;
    this._restoreBrushState(auto.brushSnapshot);
    this._restoreSelectionState(auto.selectionSnapshot);
    auto.stats.cleanupAfter = this._cleanupAutoFieldArtifacts(auto.createdBoardIds);
  }

  _cleanupAutoFieldArtifacts(createdBoardIds = null) {
    const app = this.app;
    const removeBoards = createdBoardIds ? new Set(createdBoardIds) : null;
    const out = { boardsRemoved: 0, layersRemoved: 0, chunksRemoved: 0 };
    let changed = false;
    for (let bi = app.boards.boards.length - 1; bi >= 0; bi--) {
      const board = app.boards.boards[bi];
      if (removeBoards && removeBoards.has(board.id)) {
        for (const layer of board.mgr.layers) {
          if (layer.store) out.chunksRemoved += layer.store.map?.size || 0;
          app._destroyOwnedLayer?.(layer);
          out.layersRemoved++;
        }
        board.mgr.layers.length = 0;
        app.boards.boards.splice(bi, 1);
        out.boardsRemoved++;
        changed = true;
        continue;
      }
      for (const layer of [...board.mgr.layers]) {
        if (!String(layer.name || '').startsWith(AUTO_LAYER_PREFIX)) continue;
        const detached = board.mgr.detach(layer.id);
        const owned = detached?.layer || layer;
        if (owned.store) out.chunksRemoved += owned.store.map?.size || 0;
        app._destroyOwnedLayer?.(owned);
        out.layersRemoved++;
        changed = true;
      }
      if (board.mgr.layers.length === 0) {
        const first = makeRasterLayer('Layer 1', app.heap);
        board.mgr.insert(first);
        app._allStores.add(first.store);
        changed = true;
      }
    }
    if (app.boards.boards.length === 0) {
      const board = app.boards.add('Canvas 1');
      const first = makeRasterLayer('Layer 1', app.heap);
      board.mgr.insert(first);
      app._allStores.add(first.store);
      changed = true;
    }
    if (!app.boards.byId(app.boards.activeId)) {
      app.boards.activeId = app.boards.boards[0]?.id || 0;
      changed = true;
    }
    if (changed) {
      app.boards.bump();
      app.planes.invalidate();
      app.ui?.layersUI?.sync(true);
      app.ui?.layersUI?.scheduleThumbs();
      app.requestFrame();
    }
    return out;
  }

  _autoFieldReport(auto) {
    if (!auto) return null;
    return {
      opts: auto.opts,
      stats: auto.stats,
      strokeBoardId: auto.strokeBoardId,
      strokeLayerId: auto.strokeLayerId,
      restored: !!auto.restored,
    };
  }

  /** @param {{startedAt:number,totalMs:number,phases:any[],cancelled:boolean,mode?:string,automation?:any}} run */
  _buildFieldReport(run) {
    const frames = this.logs.filter((x) => x.type === 'frame');
    const phaseStats = {};
    for (const p of run.phases) {
      phaseStats[p.id] = this._phaseStats(frames.filter((f) => f.tMs >= p.fromMs && f.tMs < p.toMs));
    }
    const topSlowFrames = frames.slice()
      .sort((a, b) => (b.frameMs || 0) - (a.frameMs || 0))
      .slice(0, 8)
      .map((f) => ({
        phase: this._phaseIdAt(f.tMs, run.phases),
        tMs: f.tMs,
        fps: f.fps,
        frameMs: f.frameMs,
        likely: f.likely,
        planesMs: f.planesMs,
        presentMs: f.presentMs,
        rasterMs: f.rasterMs,
        proxyMs: f.proxyMs,
        textQuadMs: f.textQuadMs,
        gpuBacklog: f.gpuBacklog,
        gpuLandMs: f.gpuLandMs,
        screenCacheHit: f.screenCacheHit,
        liveVisibleChunks: f.liveVisibleChunks,
      }));
    return {
      type: 'fable-paint-field-test',
      version: 7,
      mode: run.mode || 'manual',
      cancelled: run.cancelled,
      createdAt: nowIso(),
      elapsedMs: round(performance.now() - run.startedAt),
      environment: {
        url: location.href,
        userAgent: navigator.userAgent,
        renderer: this.app.renderer.kind,
        rendererOk: this.app.renderer.ok !== false,
        webgpu: !!navigator.gpu,
        secureContext: !!window.isSecureContext,
        coi: typeof crossOriginIsolated !== 'undefined' ? !!crossOriginIsolated : 'api-assente',
        sab: typeof SharedArrayBuffer !== 'undefined',
        gpuStroke: !!this.app.gpuStroke,
        gpuStrokeUsable: !!this.app.gpuStroke?.usable,
        gpuStrokeDirect: !!this.app.gpuStroke?.direct,
        cores: navigator.hardwareConcurrency || 0,
        deviceMemoryGB: navigator.deviceMemory || 0,
      },
      snapshot: this._snapshot(),
      summary: this._summary(),
      automation: run.automation ? this._autoFieldReport(run.automation) : null,
      phases: run.phases.map((p) => ({ id: p.id, label: p.label, fromMs: p.fromMs, toMs: p.toMs })),
      phaseStats,
      topSlowFrames,
    };
  }

  /** @param {Record<string, any>[]} frames */
  _phaseStats(frames) {
    const avg = (key, list = frames) => list.length
      ? list.reduce((s, x) => s + (Number(x[key]) || 0), 0) / list.length
      : 0;
    const vals = (key) => frames.map((x) => Number(x[key]) || 0);
    const buckets = {};
    for (const f of frames) if (f.slow) buckets[f.likely] = (buckets[f.likely] || 0) + 1;
    return {
      frames: frames.length,
      avgFps: round(avg('fps'), 1),
      avgFrameMs: round(avg('frameMs')),
      p95FrameMs: round(percentile(vals('frameMs'), 0.95)),
      maxFrameMs: round(Math.max(0, ...vals('frameMs'))),
      slowFrames: frames.filter((x) => x.slow).length,
      badFrames: frames.filter((x) => x.bad).length,
      avgPlanesMs: round(avg('planesMs')),
      avgRasterMs: round(avg('rasterMs')),
      avgPresentMs: round(avg('presentMs')),
      avgProxyMs: round(avg('proxyMs')),
      avgTextQuadMs: round(avg('textQuadMs')),
      gpuFrames: frames.filter((x) => x.gpuRaster).length,
      avgGpuBacklog: round(avg('gpuBacklog', frames.filter((x) => x.gpuRaster)), 1),
      maxGpuLandMs: round(Math.max(0, ...vals('gpuLandMs'))),
      gpuReadMB: round(frames.reduce((s, x) => s + (Number(x.gpuReadBytes) || 0), 0) / MB, 2),
      workerFrames: frames.filter((x) => x.workerRaster).length,
      screenCacheHits: frames.filter((x) => x.screenCacheHit).length,
      maxLongTaskMs: round(Math.max(0, ...vals('longTaskMaxMs'))),
      slowBuckets: buckets,
    };
  }

  /** @param {number} tMs @param {any[]} phases */
  _phaseIdAt(tMs, phases) {
    const p = phases.find((x) => tMs >= x.fromMs && tMs < x.toMs);
    return p ? p.id : 'done';
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
      presentMs: round(frame.presentMs),
      rasterPx: Math.round(frame.rasterPx || 0),
      queue: frame.queueCount || 0,
      commitChunksLeft: frame.commitChunksLeft || 0,
      workerRaster: !!frame.workerRaster,
      workerBacklog: Math.round(frame.workerBacklog || 0),
      workerFlushMs: round(frame.workerFlushMs || 0),
      gpuRaster: !!frame.gpuRaster,
      gpuBacklog: Math.round(frame.gpuBacklog || 0),
      gpuLandMs: round(frame.gpuLandMs || 0),
      gpuReadBytes: frame.gpuReadBytes || 0,
      gpuBatches: frame.gpuBatches || 0,
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
    const hasGpuRenderer = hasGl || renderer.kind === 'WebGPU';
    const canvasBackbufferBytes = (app.canvas?.width || 0) * (app.canvas?.height || 0) * 4;
    const gpuChunkBytes = hasGpuRenderer ? (renderer.texCount || 0) * CHUNK_BYTES : 0;
    const gpuProxyBytes = hasGpuRenderer ? (proxy.proxyBytes || 0) : 0;
    const gpuTextBytes = hasGl ? textQuadBytes : 0;
    const gpuScratchBytes = hasGpuRenderer ? this._rendererScratchBytes(renderer) : 0;
    const gpuEstimateBytes = hasGpuRenderer
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
      avgPresentMs: round(avg('presentMs')),
      avgEvictMs: round(avg('evictMs')),
      workerFrames: frames.filter((x) => x.workerRaster).length,
      avgWorkerBacklog: round(avg('workerBacklog', frames.filter((x) => x.workerRaster)), 1),
      maxWorkerBacklog: frames.reduce((m, x) => Math.max(m, x.workerBacklog || 0), 0),
      maxWorkerFlushMs: round(frames.reduce((m, x) => Math.max(m, x.workerFlushMs || 0), 0)),
      totWorkerFlushMs: round(frames.reduce((s, x) => s + (x.workerFlushMs || 0), 0)),
      // fps DURANTE i tratti worker: la domanda vera (resta fluido mentre disegni?)
      avgFpsWorker: round(avg('fps', frames.filter((x) => x.workerRaster)), 1),
      avgFrameMsWorker: round(avg('frameMs', frames.filter((x) => x.workerRaster))),
      // ponte GPU: stessi indicatori per i tratti in modalità gpu
      gpuFrames: frames.filter((x) => x.gpuRaster).length,
      avgGpuBacklog: round(avg('gpuBacklog', frames.filter((x) => x.gpuRaster)), 1),
      maxGpuLandMs: round(frames.reduce((m, x) => Math.max(m, x.gpuLandMs || 0), 0)),
      avgFpsGpu: round(avg('fps', frames.filter((x) => x.gpuRaster)), 1),
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
    // ponte GPU del tratto: come per il worker, contano solo i frame gpu
    const gFrames = frames.filter((x) => x.gpuRaster);
    if (!this.app.gpuStroke) {
      this.metrics.gpustroke.textContent = 'off (niente WebGPU)';
    } else if (!gFrames.length) {
      this.metrics.gpustroke.textContent = frames.length ? 'idle (nessun tratto gpu)' : '-';
    } else {
      const gAvg = gFrames.reduce((s, x) => s + (x.gpuBacklog || 0), 0) / gFrames.length;
      const gMax = gFrames.reduce((m, x) => Math.max(m, x.gpuBacklog || 0), 0);
      const landMax = gFrames.reduce((m, x) => Math.max(m, x.gpuLandMs || 0), 0);
      const last = gFrames[gFrames.length - 1];
      this.metrics.gpustroke.textContent =
        `backlog ${Math.round(gAvg)} avg · ${gMax} max · land max ${fmtMs(landMax)} · ` +
        `${fmtBytes(last.gpuReadBytes || 0)} in ${last.gpuBatches || 0} batch`;
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
    const cw = renderer.canvas?.width || this.app.canvas?.width || 0;
    const ch = renderer.canvas?.height || this.app.canvas?.height || 0;
    if (renderer._screenCacheTex || renderer._scTex) {
      bytes += (renderer._screenCacheW || renderer._scTex?.width || cw) *
        (renderer._screenCacheH || renderer._scTex?.height || ch) * 4;
    }
    if (renderer._grpTex) {
      bytes += (renderer._grpW || renderer._grpTex.width || cw) *
        (renderer._grpH || renderer._grpTex.height || ch) * 4;
    }
    if (renderer._bdTex) {
      bytes += (renderer._bdW || renderer._bdTex.width || cw) *
        (renderer._bdH || renderer._bdTex.height || ch) * 4;
    }
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
      if (this.app.renderer.kind === 'WebGPU') {
        info.renderer = 'WebGPU';
        info.maxTextureSize = this.app.renderer.device?.limits?.maxTextureDimension2D || 0;
      }
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
