// TIER DI CAPACITÀ DEL DISPOSITIVO — niente branch rigidi per OS.
// Si classifica con ciò che il browser DICHIARA o si MISURA: memoria
// (navigator.deviceMemory, tappata a 8 dalla spec), core, DPR, refresh
// reale via rAF. L'OS resta solo dove è un vincolo FISICO, non cosmetico:
// - mobile (pointer coarse/touch): i browser mobile uccidono la tab a
//   soglie di memoria molto più basse del desktop (LMK/jetsam) → un tier
//   'high' mobile scala a 'mid' a prescindere dalla marca;
// - iOS: Safari non dichiara la memoria e ha il reclamo più aggressivo →
//   chi consuma il tier lo tappa esplicitamente (vedi perf_debug).

/** @typedef {'high'|'mid'|'low'} DeviceTier */

/**
 * Fotografia dei segnali + tier derivato. `unclamped` è il tier prima
 * della stretta mobile: utile nei report per capire il margine reale.
 */
export function deviceCaps() {
  const ua = navigator.userAgent || '';
  const iphone = /iPhone|iPod/i.test(ua);
  const ipad = /iPad/i.test(ua) ||
    (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const ios = iphone || ipad;
  const coarse = typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches;
  const mobile = coarse || ios || /Android/i.test(ua);
  // Safari non espone deviceMemory: il fallback conta poco su iOS perché
  // il tetto piattaforma vince comunque
  const memGB = /** @type {any} */ (navigator).deviceMemory || (mobile ? 4 : 8);
  const cores = navigator.hardwareConcurrency || 4;
  const dpr = window.devicePixelRatio || 1;
  // override manuale per test/supporto: localStorage 'fable-paint.tier' =
  // high|mid|low forza il tier (utile per provare la modalità perf-lite
  // su desktop o escluderla su un telefono potente)
  let forced = '';
  try { forced = localStorage.getItem('fable-paint.tier') || ''; } catch { /* storage negato */ }
  if (forced === 'high' || forced === 'mid' || forced === 'low') {
    return { tier: /** @type {DeviceTier} */ (forced), unclamped: /** @type {DeviceTier} */ (forced),
      memGB, cores, dpr, mobile, ios, iphone, ipad, forced: true };
  }
  // la memoria comanda (il collo dei progetti grandi è RAM/VRAM), i core
  // correggono verso il basso quando la CPU è davvero povera
  /** @type {DeviceTier} */
  let tier = memGB >= 7 ? 'high' : memGB >= 5 ? 'mid' : 'low';
  if (cores <= 3 && tier !== 'low') tier = tier === 'high' ? 'mid' : 'low';
  const unclamped = tier;
  if (mobile && tier === 'high') tier = 'mid';
  return { tier, unclamped, memGB, cores, dpr, mobile, ios, iphone, ipad, forced: false };
}

/**
 * Refresh reale del display misurato con rAF (mediana dei delta, robusta
 * ai frame persi). Serve nei report per leggere i p95 nel contesto giusto:
 * 16.7ms è UN frame a 60Hz ma DUE a 120Hz. ~frames/hz secondi di attesa.
 * @param {number} [frames]
 * @returns {Promise<number>} Hz arrotondati (0 se non misurabile)
 */
export async function measureRefreshHz(frames = 24) {
  if (typeof requestAnimationFrame !== 'function') return 0;
  /** @type {number[]} */
  const deltas = [];
  let prev = await new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < frames; i++) {
    const t = await new Promise((r) => requestAnimationFrame(r));
    deltas.push(t - prev);
    prev = t;
  }
  deltas.sort((a, b) => a - b);
  const med = deltas[deltas.length >> 1] || 0;
  if (med <= 0.5) return 0;
  return Math.round(1000 / med);
}
