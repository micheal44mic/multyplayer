// TEST PUNTA INIZIALE AUTORITATIVA (node js/stroke_taper_test.mjs).
// Con taperStart < 1 l'attacco stampato live NON deve cambiare al pen-up:
// qui si rasterizza il tratto live (ChunkStore+Rasterizer, il path CPU
// dell'app), si fotografano i byte, si esegue il pass finale ESATTAMENTE
// come fa main._endPass (drop dei chunk di endPassRect + replay clippato)
// e si pretende diff ZERO su tutta la regione a monte della punta finale —
// attacco incluso, anche quando i chunk svuotati CONTENGONO l'attacco
// (tratto corto in un solo chunk: il caso che prima passava da _full).
// La punta di fine invece DEVE cambiare (è il suo pass): si pretende > 0.
// Sui tratti corti il cono di fine si sovrappone a quello d'attacco: lo
// MOLTIPLICA senza alterarlo (pizzica a goccia) e resta sempre visibile.

import assert from 'node:assert/strict';
import { brush as baseBrush, StampCache } from './brush.js';
import { ChunkStore, CHUNK, CHUNK_SHIFT, chunkKey } from './store.js';
import { Rasterizer } from './raster.js';
import { DabQueue, StrokeEngine } from './stroke.js';

/** @param {Partial<import('./brush.js').Brush>} over @returns {import('./brush.js').Brush} */
function testBrush(over = {}) {
  return /** @type {import('./brush.js').Brush} */ ({
    ...baseBrush,
    color: { ...baseBrush.color },
    texture: null,
    shape: null,
    tool: 'brush',
    size: 24,
    spacing: 0.12,
    smoothing: 0,
    roundness: 1,
    scatter: false,
    jitterPos: 0,
    jitterSize: 0,
    jitterOpacity: 0,
    jitterSpacing: 0,
    jitterAngle: 0,
    jitterBright: 0,
    jitterSat: 0,
    buildup: false,
    textureOn: false,
    textureMoving: false,
    taperStart: 0,
    taperEnd: 0,
    ...over,
  });
}

/** @param {ChunkStore} store */
function snapshot(store) {
  /** @type {Map<number, {cx: number, cy: number, data: Uint8ClampedArray}>} */
  const m = new Map();
  for (const [k, c] of store.map) m.set(k, { cx: c.cx, cy: c.cy, data: c.data.slice() });
  return m;
}

// Conta i pixel diversi tra due fotografie, separandoli al confine protX
// (coordinate documento: i tratti del test sono orizzontali sinistra->destra,
// la distanza lungo il tratto è la x). Chunk assente = trasparente.
/**
 * @param {ReturnType<typeof snapshot>} before @param {ReturnType<typeof snapshot>} after
 * @param {number} protX
 */
function diffRegions(before, after, protX) {
  let prot = 0, tail = 0;
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const k of keys) {
    const a = before.get(k), b = after.get(k);
    const cx = a ? a.cx : /** @type {NonNullable<typeof b>} */ (b).cx;
    const ax = cx * CHUNK;
    const da = a ? a.data : null, db = b ? b.data : null;
    for (let y = 0; y < CHUNK; y++) {
      for (let x = 0; x < CHUNK; x++) {
        const o = (y * CHUNK + x) * 4;
        let diff = false;
        for (let ch = 0; ch < 4; ch++) {
          const va = da ? da[o + ch] : 0, vb = db ? db[o + ch] : 0;
          if (va !== vb) { diff = true; break; }
        }
        if (!diff) continue;
        if (ax + x <= protX) prot++; else tail++;
      }
    }
  }
  return { prot, tail };
}

/**
 * Tratto orizzontale a fasi {n, dx, dt} con la pipeline dell'app:
 * live -> end() -> (endPassRect + drop + replay clippato) se richiesto.
 * @param {string} name
 * @param {Partial<import('./brush.js').Brush>} over
 * @param {{n: number, dx: number, dt: number}[]} phases
 * @param {{endPass: boolean, fullAttack?: boolean, endVisible?: boolean}} exp
 *   fullAttack: i coni non si sovrappongono, la regione protetta deve
 *   coprire TUTTO il cono d'attacco. endVisible: tratto corto, la punta
 *   finale deve comunque esserci (lb una frazione sostanziosa del tratto).
 */
function runCase(name, over, phases, exp) {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush(over);
  const store = new ChunkStore('taper-test', null);
  const raster = new Rasterizer(store, new StampCache(), null);
  const clip = { x0: 0, y0: 0, x1: 2047, y1: 2047 };
  const X0 = 30, Y = 100;

  e.begin(X0, Y, 1, 0, b, 123, 1);
  raster.beginStroke(/** @type {any} */ (e.snap), clip, null, null);
  let x = X0, t = 0;
  for (const ph of phases) {
    for (let i = 0; i < ph.n; i++) { x += ph.dx; t += ph.dt; e.move(x, Y, 1, t); }
  }
  raster.run(q, Infinity);
  e.end(x, Y, 1, t + phases[phases.length - 1].dt);
  raster.run(q, Infinity); // catch-up live, come _runQueueSync prima del drop
  const before = snapshot(store);
  assert.ok(before.size > 0, `${name}: il live ha rasterizzato qualcosa`);

  // la punta d'inizio live è autoritativa: mai accorciata dai tetti
  if (b.taperStart < 1) assert.equal(e._laX, e._la, `${name}: laX deve restare la live`);
  else assert.equal(e._laX, 0, `${name}: taperStart spento -> nessun budget d'attacco`);
  assert.equal(e.endPassNeeded, exp.endPass,
    `${name}: endPassNeeded atteso ${exp.endPass}`);
  if (!exp.endPass) {
    console.log('ok ', `${name} (D=${e._D.toFixed(0)} la=${e._la.toFixed(0)} lb=${e._lbX.toFixed(1)} nessun pass: live == commit)`);
    return;
  }

  const rect = e.endPassRect();
  assert.ok(rect, `${name}: endPassRect mai null col registro pieno (niente drop totale)`);
  const clipSet = new Set();
  const cx0 = rect.x0 >> CHUNK_SHIFT, cy0 = rect.y0 >> CHUNK_SHIFT;
  const cx1 = rect.x1 >> CHUNK_SHIFT, cy1 = rect.y1 >> CHUNK_SHIFT;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const key = chunkKey(cx, cy);
      clipSet.add(key);
      store.remove(key, null);
    }
  }
  raster.beginStroke(/** @type {any} */ (e.snap), clip, null, null);
  raster.clip = clipSet;
  e.replay();
  raster.run(q, Infinity);
  raster.clip = null;
  const after = snapshot(store);

  // confine protetto: tutto a monte della punta finale meno la portata
  // massima di un dab ricampionato (raggio + offset jitter + bordo AA)
  const s = /** @type {NonNullable<typeof e.snap>} */ (e.snap);
  const reach = s.baseR * 1.5 + s.jPos * s.diam * 2 + 6;
  const protX = X0 + (e._D - e._lbX) - reach;
  const protLen = protX - X0;
  assert.ok(protLen > 0, `${name}: regione protetta non vuota (${protLen.toFixed(1)}px)`);
  if (exp.fullAttack && b.taperStart < 1) {
    assert.ok(e._la + e._lbX + reach <= e._D,
      `${name}: caso senza sovrapposizione dei coni (la=${e._la.toFixed(1)} lb=${e._lbX.toFixed(1)} D=${e._D.toFixed(1)})`);
    assert.ok(protLen >= e._la,
      `${name}: la regione protetta copre TUTTO il cono d'attacco (${protLen.toFixed(1)} >= ${e._la.toFixed(1)})`);
  }
  if (exp.endVisible) {
    assert.ok(e._lbX >= e._D * 0.3,
      `${name}: punta finale visibile anche sul tratto corto (lb=${e._lbX.toFixed(1)} D=${e._D.toFixed(1)})`);
  }
  const { prot, tail } = diffRegions(before, after, protX);
  assert.equal(prot, 0, `${name}: 0 pixel diversi su attacco+corpo (trovati ${prot})`);
  assert.ok(tail > 0, `${name}: la punta finale deve cambiare (il pass ha lavorato)`);
  console.log('ok ', `${name} (D=${e._D.toFixed(0)} la=${e._la.toFixed(0)} lb=${e._lbX.toFixed(1)} prot=${protLen.toFixed(0)}px tailΔ=${tail})`);
}

// A. tratto lungo, attacco posato: il pass della punta finale non tocca
// l'attacco (guardia di regressione sul percorso normale, via discreta)
runCase('lungo discreto', { taperStart: 0, taperEnd: 0 },
  [{ n: 25, dx: 4, dt: 16 }, { n: 25, dx: 8, dt: 16 }, { n: 6, dx: 1.5, dt: 40 }],
  { endPass: true, fullAttack: true });

// B. tratto corto con attacco veloce, tutto in UN chunk: prima del fix
// la=_la veniva accorciata dai tetti -> _full -> replay intero -> attacco
// cambiato al pen-up. Ora i chunk svuotati contengono l'attacco e il replay
// del corpo deve riprodurlo byte per byte.
runCase('corto ex-full discreto', { taperStart: 0, taperEnd: 0 },
  [{ n: 10, dx: 5, dt: 8 }, { n: 30, dx: 5, dt: 16 }, { n: 6, dx: 1, dt: 40 }],
  { endPass: true, fullAttack: true });

// C. stesso caso in via CONTINUA (catena di capsule)
runCase('corto ex-full continuo', { taperStart: 0, taperEnd: 0, spacing: 0.04 },
  [{ n: 10, dx: 5, dt: 8 }, { n: 30, dx: 5, dt: 16 }, { n: 6, dx: 1, dt: 40 }],
  { endPass: true, fullAttack: true });

// D. jitter attivi: il replay del corpo deve restare allineato allo stream
// del seed (burn di jitterSpacing) — attacco identico anche col caso
runCase('jitter allineati', {
  taperStart: 0, taperEnd: 0,
  jitterSpacing: 0.6, jitterSize: 0.4, jitterOpacity: 0.3, jitterPos: 0.15,
}, [{ n: 25, dx: 4, dt: 16 }, { n: 20, dx: 6, dt: 16 }, { n: 6, dx: 1.5, dt: 40 }],
  { endPass: true, fullAttack: true });

// E. buildup: la compensazione alpha (aPow dalla catena delle posizioni)
// deve riprodursi identica nel replay del corpo
runCase('buildup', { taperStart: 0, taperEnd: 0, buildup: true, opacity: 0.4 },
  [{ n: 25, dx: 4, dt: 16 }, { n: 25, dx: 8, dt: 16 }, { n: 6, dx: 1.5, dt: 40 }],
  { endPass: true, fullAttack: true });

// F. taperStart spento: la punta di fine ha tutto il budget, il corpo
// replayato resta comunque identico al live
runCase('solo taper di fine', { taperStart: 1, taperEnd: 0 },
  [{ n: 25, dx: 4, dt: 16 }, { n: 25, dx: 8, dt: 16 }, { n: 6, dx: 1.5, dt: 40 }],
  { endPass: true });

// G. frustata corta: il cono d'attacco live copre (quasi) tutto il tratto.
// La punta di fine NON sparisce: prende il suo tetto (65% del tratto) e
// pizzica il profilo live a goccia — l'attacco a monte resta byte-identico
// (prima del fix: _full -> redraw intero con attacco accorciato; prima di
// questo secondo giro: lb=0 e fine mozza).
runCase('frustata corta: goccia', { taperStart: 0, taperEnd: 0 },
  [{ n: 12, dx: 9, dt: 8 }],
  { endPass: true, endVisible: true });

// H. stessa frustata in via continua
runCase('frustata corta continua: goccia', { taperStart: 0, taperEnd: 0, spacing: 0.04 },
  [{ n: 12, dx: 9, dt: 8 }],
  { endPass: true, endVisible: true });

console.log('ok  stroke taper: punta iniziale autoritativa');
