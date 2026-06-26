/**
 * Shared DOM builder for panel range rows.
 *
 * The options intentionally expose the few differences between panels:
 * some render from the input's transient value, others from the model after
 * setting it, and some panels include stepper buttons.
 *
 * @typedef {Object} RangeRowOptions
 * @property {string} label
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {() => number} get
 * @property {(v: number) => void} set
 * @property {(v: number) => string} fmt
 * @property {boolean} [log]
 * @property {(v: number) => number} [snap]
 * @property {(cur: number, dir: number) => number} [stepFn]
 * @property {boolean} [steppers]
 * @property {boolean} [clampOnSet]
 * @property {boolean} [formatFromInput]
 * @property {boolean} [syncLogClamp]
 * @property {boolean} [initialSync]
 * @property {() => boolean} [beforeInput]
 * @property {boolean} [roundOnInput]
 * @property {(() => boolean)} [dep]
 * @property {(() => void)[]|null} [depRefresh]
 * @property {boolean} [refreshOnSnapChange]
 * @property {() => void} [onChanged]
 */

/**
 * @param {RangeRowOptions} opts
 */
export function createRangeRow(opts) {
  const {
    label, min, max, step, get, set, fmt,
    log = false,
    snap = null,
    stepFn = null,
    steppers = false,
    clampOnSet = false,
    formatFromInput = false,
    syncLogClamp = false,
    initialSync = true,
    beforeInput = () => true,
    roundOnInput = true,
    dep = null,
    depRefresh = null,
    refreshOnSnapChange = true,
    onChanged = () => {},
  } = opts;

  const row = document.createElement('div');
  row.className = 'p-row';
  if (dep) {
    const apply = () => row.classList.toggle('p-off', !dep());
    if (depRefresh) depRefresh.push(apply);
    apply();
  }

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
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
  }

  /** @param {number} v */
  const clamp = (v) => v < min ? min : v > max ? max : v;
  /** @param {number} v */
  const inputValue = (v) => log ? Math.log(syncLogClamp ? clamp(v) : v) : v;
  /** @param {number} v */
  const writeInput = (v) => { input.value = String(inputValue(v)); };
  const readInput = () => {
    let v = log ? Math.exp(parseFloat(input.value)) : parseFloat(input.value);
    if (snap) v = snap(v);
    return v;
  };
  const inputDisplayValue = () => {
    const v = readInput();
    return roundOnInput && step >= 1 ? Math.round(v) : v;
  };
  const modelDisplayValue = () => get();
  const refresh = () => {
    val.textContent = fmt(formatFromInput ? inputDisplayValue() : modelDisplayValue());
  };
  /** @param {number} [v] */
  const sync = (v = get()) => {
    writeInput(v);
    refresh();
  };

  input.addEventListener('input', () => {
    if (!beforeInput()) return;
    let v = readInput();
    if (roundOnInput && step >= 1) v = Math.round(v);
    set(clampOnSet ? clamp(v) : v);
    refresh();
    onChanged();
  });

  if (snap) {
    input.addEventListener('change', () => {
      writeInput(get());
      if (refreshOnSnapChange) refresh();
    });
  }

  if (steppers) {
    /** @param {number} dir */
    const stepBy = (dir) => {
      let v;
      if (stepFn) {
        v = stepFn(get(), dir);
      } else if (log) {
        const cur = get();
        const raw = dir > 0 ? cur * 1.1 : cur / 1.1;
        v = dir > 0 ? Math.max(cur + step, raw) : Math.min(cur - step, raw);
      } else {
        v = get() + dir * step;
      }
      v = step >= 1 ? Math.round(v) : Math.round(v / step) * step;
      v = clamp(v);
      set(v);
      writeInput(v);
      refresh();
      onChanged();
    };
    const minus = document.createElement('button');
    minus.className = 'p-step';
    minus.textContent = '−';
    minus.addEventListener('click', () => stepBy(-1));
    const plus = document.createElement('button');
    plus.className = 'p-step';
    plus.textContent = '+';
    plus.addEventListener('click', () => stepBy(1));

    const slider = document.createElement('div');
    slider.className = 'p-slider';
    slider.append(minus, input, plus);
    row.append(head, slider);
  } else {
    row.append(head, input);
  }

  if (initialSync) sync();
  return { row, input, refresh, sync };
}
