// PROFILO DEL TRATTO — registra, frame per frame, dove vanno i ms mentre si
// disegna e a fine tratto (pen-up + catch-up + commit) stampa in console un
// report testuale copiabile, nello stesso spirito del tasto "copia" dell'HUD.
// Scompone il raster in generazione stamp / texture+mip / composito, traccia
// la coda (descrittori arretrati e catch-up dopo il pen-up) e gli eventi
// one-shot (replay della punta, flush sincroni): il verdetto finale dice in
// chiaro qual è il collo di bottiglia.
// Console: __strokeProf(false) spegne, __copyStrokeReport() copia l'ultimo.

const SLOW_MS = 18;        // frame oltre questa soglia contano come lag
const MAX_FRAMES = 1 << 15;

// colonne per frame (ring lineare, cresce raddoppiando)
const STRIDE = 16;
const C_FT = 0, C_INPUT = 1, C_RASTER = 2, C_TEX = 3, C_STAMP = 4,
  C_COMMIT = 5, C_UPLOAD = 6, C_DRAW = 7, C_EVICT = 8, C_QUEUE = 9,
  C_DABS = 10, C_PX = 11, C_BUDGET = 12, C_GEN = 13, C_FILLS = 14, C_BAKES = 15;

const PHASES = /** @type {const} */ ([
  ['input', C_INPUT], ['raster', C_RASTER], ['commit', C_COMMIT],
  ['upload GPU', C_UPLOAD], ['draw', C_DRAW], ['evict', C_EVICT],
]);

class StrokeProfiler {
  constructor() {
    this.enabled = true;
    this.active = false;
    this._buf = new Float32Array(512 * STRIDE);
    this._cap = 512;
    this._n = 0;
    // Le fasi del frame k vengono accoppiate al dt misurato al frame k+1
    // (il dt rAF->rAF arriva sempre un giro dopo il lavoro che lo causa):
    // il campione resta in sospeso finché non si conosce il suo frame time.
    this._pend = new Float32Array(STRIDE);
    this._hasPend = false;
    this._pendAt = 0;
    this._strokeN = 0;
    this._t0 = 0;
    this._penUpAt = -1;
    this._catchupMs = -1;
    /** @type {string[]} */
    this._events = [];
    this._info = '';
    this.lastReport = '';
  }

  // info: righe di contesto (pennello, texture/mip, motore) già formattate.
  /** @param {string} info */
  begin(info) {
    if (!this.enabled) return;
    this.active = true;
    this._n = 0;
    this._hasPend = false;
    this._strokeN++;
    this._t0 = performance.now();
    this._penUpAt = -1;
    this._catchupMs = -1;
    this._events.length = 0;
    this._info = info;
  }

  penUp() {
    if (this.active) this._penUpAt = performance.now();
  }

  // Evento one-shot fuori dal ritmo dei frame (replay punta, flush sincrono).
  /** @param {string} name @param {number} ms */
  event(name, ms) {
    if (this.active) this._events.push(`${name} ${ms.toFixed(1)} ms`);
  }

  // Un campione per frame. tex/stamp/gen/fills/bakes sono DELTA sull'intero
  // frame (coprono anche i run del raster dentro gli handler di input, come
  // il replay della punta al pen-up).
  /**
   * @param {number} ft frame totale (rAF->rAF)
   * @param {number} input @param {number} raster @param {number} tex
   * @param {number} stamp @param {number} commit @param {number} upload
   * @param {number} draw @param {number} evict @param {number} queue
   * @param {number} dabs @param {number} px @param {number} budget
   * @param {number} gen stamp generati @param {number} fills tile riempiti
   * @param {number} bakes maschere texture baked
   */
  frame(ft, input, raster, tex, stamp, commit, upload, draw, evict,
    queue, dabs, px, budget, gen, fills, bakes) {
    if (!this.active) return;
    if (this._penUpAt >= 0 && this._catchupMs < 0 && queue === 0) {
      this._catchupMs = performance.now() - this._penUpAt;
    }
    if (this._hasPend) this._commitPend(ft); // il dt appena misurato è del campione precedente
    const p = this._pend;
    p[C_FT] = 0; p[C_INPUT] = input; p[C_RASTER] = raster;
    p[C_TEX] = tex; p[C_STAMP] = stamp; p[C_COMMIT] = commit;
    p[C_UPLOAD] = upload; p[C_DRAW] = draw; p[C_EVICT] = evict;
    p[C_QUEUE] = queue; p[C_DABS] = dabs; p[C_PX] = px;
    p[C_BUDGET] = budget; p[C_GEN] = gen; p[C_FILLS] = fills;
    p[C_BAKES] = bakes;
    this._hasPend = true;
    this._pendAt = performance.now();
  }

  /** @param {number} ft */
  _commitPend(ft) {
    this._hasPend = false;
    if (this._n >= MAX_FRAMES) return; // tratto chilometrico: aggregati fermi qui
    if (this._n === this._cap) {
      const nb = new Float32Array(this._cap * 2 * STRIDE);
      nb.set(this._buf);
      this._buf = nb; this._cap *= 2;
    }
    this._buf.set(this._pend, this._n * STRIDE);
    this._buf[this._n * STRIDE + C_FT] = ft;
    this._n++;
  }

  // Tratto annullato (multi-touch, ecc.): si scarta senza report.
  cancel() { this.active = false; this._hasPend = false; }

  /** @param {string} [note] */
  finish(note) {
    if (!this.active) return;
    this.active = false;
    if (this._hasPend) {
      // l'ultimo campione non vedrà mai il dt successivo: si stima col tempo
      // trascorso o, se maggiore, con la somma delle fasi misurate
      const p = this._pend;
      const work = p[C_INPUT] + p[C_RASTER] + p[C_COMMIT] + p[C_UPLOAD] + p[C_DRAW] + p[C_EVICT];
      this._commitPend(Math.max(performance.now() - this._pendAt, work));
    }
    if (this._n === 0) return;
    this.lastReport = this._report(note);
    /** @type {any} */ (window).__strokeReport = this.lastReport;
    console.log(this.lastReport);
  }

  /** @param {string|undefined} note */
  _report(note) {
    const b = this._buf, n = this._n;
    const durMs = performance.now() - this._t0;

    // aggregati per colonna
    const sum = new Float64Array(STRIDE), max = new Float64Array(STRIDE);
    let slow = 0, queueBusy = 0, budgetMin = Infinity, budgetMax = 0;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      for (let c = 0; c < STRIDE; c++) {
        const v = b[o + c];
        sum[c] += v;
        if (v > max[c]) max[c] = v;
      }
      if (b[o + C_FT] > SLOW_MS) slow++;
      if (b[o + C_QUEUE] > 0) queueBusy++;
      const bud = b[o + C_BUDGET];
      if (bud < budgetMin) budgetMin = bud;
      if (bud > budgetMax) budgetMax = bud;
    }
    // "altro" = tempo del frame fuori da ogni fase misurata (GC, compositor,
    // preview del browser); calcolato per frame per non sommare gli sfori
    let otherSum = 0, otherMax = 0;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const rest = Math.max(0, b[o + C_FT] - (b[o + C_INPUT] + b[o + C_RASTER] +
        b[o + C_COMMIT] + b[o + C_UPLOAD] + b[o + C_DRAW] + b[o + C_EVICT]));
      otherSum += rest;
      if (rest > otherMax) otherMax = rest;
    }

    const L = [];
    L.push(`═══ PROFILO TRATTO #${this._strokeN} — ${durMs.toFixed(0)} ms, ${n} frame${note ? ` (${note})` : ''} ═══`);
    L.push(this._info);
    L.push(`frame: media ${(sum[C_FT] / n).toFixed(2)} ms (${(1000 * n / sum[C_FT]).toFixed(0)} fps) · max ${max[C_FT].toFixed(1)} ms · ${slow}/${n} sopra ${SLOW_MS} ms`);
    L.push('');
    L.push('fase                  tot ms   media     max');
    /** @type {(name: string, tot: number, mx: number, extra?: string) => void} */
    const row = (name, tot, mx, extra) => {
      L.push(`${name.padEnd(20)}${tot.toFixed(1).padStart(8)}${(tot / n).toFixed(2).padStart(8)}${(mx < 0 ? '—' : mx.toFixed(1)).padStart(8)}${extra ? '   ' + extra : ''}`);
    };
    row('input', sum[C_INPUT], max[C_INPUT]);
    row('raster', sum[C_RASTER], max[C_RASTER]);
    // tex e stamp sono misurati sull'intero frame (coprono anche i run nel
    // pen-up dentro input): il composito si ricava per differenza, clampato
    const composite = Math.max(0, sum[C_RASTER] - sum[C_TEX] - sum[C_STAMP]);
    row('  · stamp gen', sum[C_STAMP], max[C_STAMP], `(${sum[C_GEN]} stamp nuovi)`);
    row('  · texture/mip', sum[C_TEX], max[C_TEX], `(${sum[C_FILLS]} tile fill, ${sum[C_BAKES]} bake)`);
    row('  · composito ~', composite, -1);
    row('commit', sum[C_COMMIT], max[C_COMMIT]);
    row('upload GPU', sum[C_UPLOAD], max[C_UPLOAD]);
    row('draw', sum[C_DRAW], max[C_DRAW]);
    row('evict', sum[C_EVICT], max[C_EVICT]);
    row('altro (GC/browser)', otherSum, otherMax);
    L.push('');
    L.push(`coda    max ${max[C_QUEUE]} descrittori · arretrata in ${queueBusy}/${n} frame` +
      (this._catchupMs >= 0 ? ` · catch-up dopo il pen-up ${this._catchupMs.toFixed(0)} ms` : ''));
    L.push(`raster  ${sum[C_DABS]} dab/segmenti · ${(sum[C_PX] / 1e6).toFixed(1)} Mpx toccati · budget ${(budgetMin / 1e6).toFixed(2)}→${(budgetMax / 1e6).toFixed(2)} Mpx/frame`);
    if (this._events.length) L.push(`eventi  ${this._events.join(' · ')}`);

    // i 5 frame peggiori, con la scomposizione
    /** @type {number[]} */
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    idx.sort((a, c) => b[c * STRIDE + C_FT] - b[a * STRIDE + C_FT]);
    const top = idx.slice(0, Math.min(5, n));
    L.push('');
    L.push('frame peggiori (ms): tot | input raster(stamp+tex) commit upload draw evict | altro | coda');
    for (const i of top) {
      const o = i * STRIDE;
      const rest = Math.max(0, b[o + C_FT] - (b[o + C_INPUT] + b[o + C_RASTER] +
        b[o + C_COMMIT] + b[o + C_UPLOAD] + b[o + C_DRAW] + b[o + C_EVICT]));
      L.push(`  ${b[o + C_FT].toFixed(1).padStart(7)} | ${b[o + C_INPUT].toFixed(1).padStart(5)} ` +
        `${b[o + C_RASTER].toFixed(1).padStart(5)}(${b[o + C_STAMP].toFixed(1)}+${b[o + C_TEX].toFixed(1)}) ` +
        `${b[o + C_COMMIT].toFixed(1).padStart(5)} ${b[o + C_UPLOAD].toFixed(1).padStart(5)} ` +
        `${b[o + C_DRAW].toFixed(1).padStart(4)} ${b[o + C_EVICT].toFixed(1).padStart(4)} | ` +
        `${rest.toFixed(1).padStart(5)} | ${b[o + C_QUEUE]}`);
    }

    L.push('');
    L.push(`VERDETTO: ${this._verdict(sum, n, slow, otherSum)}`);
    L.push('(testo anche in window.__strokeReport — __copyStrokeReport() lo copia negli appunti, __strokeProf(false) spegne il profiler)');
    return L.join('\n');
  }

  // Attribuzione: per ogni frame lento vince la fase dominante; il raster
  // viene poi spaccato nelle sue parti per dire SE è la texture/mip, la
  // generazione stamp o il composito puro.
  /**
   * @param {Float64Array} sum @param {number} n @param {number} slow
   * @param {number} otherSum
   */
  _verdict(sum, n, slow, otherSum) {
    const b = this._buf;
    const lag = [];
    if (this._catchupMs > 150) {
      lag.push(`il tratto resta INDIETRO rispetto alla penna: la coda si svuota solo ${this._catchupMs.toFixed(0)} ms dopo il pen-up (il raster non tiene il passo del gesto)`);
    }
    if (slow === 0) {
      lag.push(lag.length ? 'i frame però sono fluidi (nessuno sopra soglia)' :
        `nessun frame sopra ${SLOW_MS} ms: nessun lag misurato in questo tratto`);
      return lag.join('; ') + '.';
    }
    // fase dominante dei soli frame lenti, pesata in ms ("altro" incluso):
    // un picco singolo da 200 ms conta più di tanti frame appena sopra soglia
    const counts = new Float64Array(PHASES.length + 1);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const ft = b[o + C_FT];
      if (ft <= SLOW_MS) continue;
      let top = -1, topV = -1, used = 0;
      for (let p = 0; p < PHASES.length; p++) {
        const v = b[o + PHASES[p][1]];
        used += v;
        if (v > topV) { topV = v; top = p; }
      }
      if (ft - used > topV) top = PHASES.length; // "altro"
      counts[top] += ft;
    }
    let main = 0;
    for (let p = 1; p < counts.length; p++) if (counts[p] > counts[main]) main = p;
    const mainName = main === PHASES.length ? 'ALTRO (GC/compositor/browser, tempo fuori dalle fasi misurate)' : PHASES[main][0].toUpperCase();
    let detail = '';
    if (main === 1) { // raster: spacca in stamp/tex/composito
      const r = Math.max(sum[C_RASTER], sum[C_TEX] + sum[C_STAMP], 0.001);
      const texPct = 100 * sum[C_TEX] / r;
      const stampPct = 100 * sum[C_STAMP] / r;
      const parts = [];
      if (texPct >= 1) parts.push(`${texPct.toFixed(0)}% texture/mip (tile fill + bake)`);
      if (stampPct >= 1) parts.push(`${stampPct.toFixed(0)}% generazione stamp`);
      parts.push(`${Math.max(0, 100 - texPct - stampPct).toFixed(0)}% composito pixel`);
      detail = ` — dentro il raster: ${parts.join(', ')}`;
    } else if (main === 0 && this._events.length) {
      detail = ` — attenzione: i lavori al pen-up (${this._events.join(', ')}) contano nella fase input`;
    }
    lag.push(`${slow}/${n} frame lenti, fase dominante ${mainName}${detail}`);
    return lag.join('; ') + '.';
  }
}

export const strokeProfiler = new StrokeProfiler();

/** @type {any} */ (window).__strokeProf = (/** @type {boolean} */ v) => {
  strokeProfiler.enabled = v === undefined ? !strokeProfiler.enabled : !!v;
  console.log(`profiler tratto: ${strokeProfiler.enabled ? 'ON' : 'OFF'}`);
  return strokeProfiler.enabled;
};
/** @type {any} */ (window).__copyStrokeReport = () => {
  if (!strokeProfiler.lastReport) { console.log('nessun report: disegna un tratto prima'); return; }
  navigator.clipboard.writeText(strokeProfiler.lastReport)
    .then(() => console.log('report copiato negli appunti'))
    .catch(() => console.log('appunti negati: seleziona e copia il testo del report'));
};
