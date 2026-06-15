const DEFAULT_FEEDBACK_URL = 'https://github.com/micheal44mic/multyplayer/issues/new';

const sessionId = (() => {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // Fall through to a non-cryptographic session id.
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
})();

let installed = false;
let configLoadPromise = null;

export function loadRuntimeConfig() {
  if (typeof document === 'undefined') return Promise.resolve();
  if (configLoadPromise) return configLoadPromise;

  configLoadPromise = new Promise((resolve) => {
    const src = new URL('config.js', document.baseURI).href;
    if (Array.from(document.scripts).some((script) => script.src === src)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });

  return configLoadPromise;
}

function config() {
  return {
    release: '',
    telemetryEndpoint: '',
    feedbackUrl: DEFAULT_FEEDBACK_URL,
    ...((/** @type {any} */ (window).FABLE_CONFIG) || {}),
  };
}

/** @param {unknown} value */
function cleanValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 12).map(cleanValue);
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 20)) {
      out[k.slice(0, 48)] = cleanValue(v);
    }
    return out;
  }
  return String(value).slice(0, 240);
}

/** @param {string} name @param {Record<string, unknown>} [props] */
export function track(name, props = {}) {
  const cfg = config();
  if (!cfg.telemetryEndpoint) return;

  const payload = {
    name: String(name).slice(0, 80),
    props: cleanValue(props),
    release: cfg.release || '',
    sessionId,
    path: location.pathname,
    viewport: `${innerWidth}x${innerHeight}`,
    userAgent: navigator.userAgent.slice(0, 160),
    ts: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(cfg.telemetryEndpoint, blob)) return;
    }
  } catch {
    // Fall back to fetch below.
  }

  fetch(cfg.telemetryEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'omit',
    mode: 'cors',
  }).catch(() => {});
}

/** @param {unknown} reason */
function reasonMessage(reason) {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    return String((/** @type {{message?: unknown}} */ (reason)).message || '');
  }
  return String(reason || '');
}

export function installTelemetry() {
  if (installed) return;
  installed = true;
  track('app_open');
  window.addEventListener('error', (event) => {
    track('runtime_error', {
      message: event.message,
      source: event.filename ? event.filename.split('/').pop() : '',
      line: event.lineno || 0,
      column: event.colno || 0,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    track('unhandled_rejection', { message: reasonMessage(event.reason) });
  });
}

/** @param {string} [source] */
export function feedbackUrl(source = 'app') {
  const cfg = config();
  const url = new URL(cfg.feedbackUrl || DEFAULT_FEEDBACK_URL, location.href);
  if (url.hostname === 'github.com' && url.pathname.endsWith('/issues/new')) {
    url.searchParams.set('title', 'Feedback: ');
    url.searchParams.set('body', [
      'What happened?',
      '',
      'Steps to reproduce:',
      '1. ',
      '',
      `Source: ${source}`,
      `Release: ${cfg.release || 'dev'}`,
    ].join('\n'));
  }
  return url.href;
}

export function wireFeedbackLinks() {
  for (const link of document.querySelectorAll('[data-feedback-link]')) {
    if (!(link instanceof HTMLAnchorElement)) continue;
    const source = link.getAttribute('data-feedback-source') || link.id || 'app';
    link.href = feedbackUrl(source);
    link.addEventListener('click', () => track('feedback_opened', { source }));
  }
}
