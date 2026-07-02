/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{
 *   payload: any,
 *   onStart: () => void,
 *   onGranted: () => void,
 *   delayMs: number,
 * }} options
 * @returns {Promise<boolean>} true when an installed rewarded-ad SDK handled the flow.
 */
export async function runRewardedSdk(options) {
  const sdk = /** @type {any} */ (window).FableRewardedAds;
  if (!sdk || typeof sdk.showRewarded !== 'function') return false;

  options.onStart();
  const ok = await sdk.showRewarded(options.payload);
  if (ok === false) throw new Error('Ad not completed');
  options.onGranted();
  await delay(options.delayMs);
  return true;
}

/**
 * @param {{
 *   seconds: number,
 *   onComplete: () => void,
 *   onTick: (state: {progress: number, remaining: number}) => void,
 * }} options
 */
export function runRafCountdown(options) {
  return new Promise((resolve) => {
    if (options.seconds <= 0) {
      options.onComplete();
      resolve();
      return;
    }

    const started = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - started) / 1000;
      const progress = elapsed < 0 ? 0 : elapsed > options.seconds ? 1 : elapsed / options.seconds;
      const remaining = Math.ceil(Math.max(0, options.seconds - elapsed));
      options.onTick({ progress, remaining });
      if (progress >= 1) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * @param {{
 *   durationMs: number,
 *   intervalMs: number,
 *   completeDelayMs: number,
 *   onTick: (state: {pct: number, remaining: number}) => void,
 *   onClear?: () => void,
 *   onComplete: () => void,
 * }} options
 * @returns {number}
 */
export function startIntervalCountdown(options) {
  const startedAt = Date.now();
  let timer = 0;
  const tick = () => {
    const elapsed = Math.min(options.durationMs, Date.now() - startedAt);
    const remaining = Math.max(0, Math.ceil((options.durationMs - elapsed) / 1000));
    const pct = Math.round((elapsed / options.durationMs) * 100);
    options.onTick({ pct, remaining });
    if (remaining === 0 && timer) {
      window.clearInterval(timer);
      timer = 0;
      if (options.onClear) options.onClear();
      window.setTimeout(options.onComplete, options.completeDelayMs);
    }
  };

  tick();
  timer = window.setInterval(tick, options.intervalMs);
  return timer;
}
