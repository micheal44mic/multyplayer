// PUPPET WARP (Altera marionetta, alla Photoshop) — il livello raster viene
// TRIANGOLATO sulla sola zona con alpha (più l'Espansione) e deformato con
// puntine: l'algoritmo è l'As-Rigid-As-Possible di Igarashi (SIGGRAPH 2005,
// lo stesso alla base del Puppet Warp vero) nella forma locale/globale —
// passo locale: per ogni vertice la rotazione (o similitudine, secondo la
// Modalità) che meglio porta l'intorno a riposo su quello deformato; passo
// globale: posizioni dai minimi quadrati (Laplaciano cotangente, gradiente
// coniugato warm-start). Le puntine sono vincoli DURI sui vertici.
// Pipeline della mesh: alpha → maschera binaria (OR: nessun pixel perso)
// → espansione/contrazione via EDT → contorni marching squares ricampionati
// → punti interni a reticolo esagonale jitterato → Delaunay (Bowyer-Watson)
// → filtro dei triangoli col baricentro fuori maschera.
// Filosofia identica a Sposta/Warp: durante il gesto NESSUN pixel si tocca
// (anteprima a triangoli GPU/bake 2D); al ✓ si ricampiona UNA volta sola
// dai pixel originali (puppetStore, stesso rasterizer top-left di warpStore:
// undo tile-diff, in sessione collaborativa diventa patch di pixel gratis).

import { CHUNK, CHUNK_SHIFT, CHUNK_BYTES, chunkKey } from './store.js';

/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./store.js').Chunk} Chunk */

/**
 * @typedef {Object} PuppetMesh
 * @property {Float32Array} pos0 vertici a riposo (px mondo, coppie x,y)
 * @property {Uint32Array} tris indici dei triangoli (terne)
 * @property {Uint32Array} edges spigoli unici (coppie) per l'overlay della rete
 * @property {number} spacing passo medio della rete (px sorgente)
 */

// lato massimo della maschera di lavoro (contorni e reticolo)
const MASK_MAX = 512;
// vertici bersaglio per Densità (alla Photoshop: Meno/Normale/Più punti)
const TARGET_VERTS = { less: 600, normal: 1400, more: 3000 };

// Hash deterministico → [0,1): jitter dei punti senza Math.random (stessa
// mesh a ogni rebuild, niente cocircolarità del reticolo nel Delaunay).
/** @param {number} i */
function rnd(i) {
  let h = Math.imul(i | 0, 0x9E3779B9);
  h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B);
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---- EDT al quadrato (Felzenszwalb-Huttenlocher, 2 passi 1D) --------------

/** @param {Float64Array} f @param {number} n @param {Float64Array} d @param {Int32Array} v @param {Float64Array} z */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Distanza² di ogni cella dal seme più vicino.
 * @param {Uint8Array} grid @param {number} w @param {number} h
 * @param {boolean} fromOnes true = semi dove grid≠0, false = dove grid=0
 * @returns {Float64Array}
 */
export function edtSq(grid, w, h, fromOnes) {
  const INF = 1e12;
  const g = new Float64Array(w * h);
  for (let i = 0; i < g.length; i++) {
    g[i] = (grid[i] !== 0) === fromOnes ? 0 : INF;
  }
  const nMax = Math.max(w, h);
  const f = new Float64Array(nMax), d = new Float64Array(nMax);
  const v = new Int32Array(nMax), z = new Float64Array(nMax + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = g[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[row + x] = d[x];
  }
  return g;
}

// ---- contorni (marching squares) ------------------------------------------

// Segmenti diretti col PIENO a sinistra del verso di percorrenza: ogni punto
// medio di lato è partenza di al più un segmento, la concatenazione è una
// semplice mappa punto→segmento e ogni catena è un anello chiuso.
/**
 * @param {Uint8Array} inside @param {number} w @param {number} h
 * @returns {Float64Array[]} anelli (coppie x,y in coordinate maschera)
 */
export function traceContours(inside, w, h) {
  /** @type {Map<number, number>} chiave del punto di partenza → indice segmento */
  const start = new Map();
  /** @type {number[]} x0,y0,x1,y1 (coordinate ×2: interi) */
  const segs = [];
  /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
  const add = (ax, ay, bx, by) => {
    start.set(ax << 12 | ay, segs.length >> 2); // indice SEGMENTO, non offset piatto
    segs.push(ax, ay, bx, by);
  };
  for (let y = 0; y < h - 1; y++) {
    const r0 = y * w, r1 = r0 + w;
    for (let x = 0; x < w - 1; x++) {
      const c = (inside[r0 + x] ? 1 : 0) | (inside[r0 + x + 1] ? 2 : 0) |
        (inside[r1 + x + 1] ? 4 : 0) | (inside[r1 + x] ? 8 : 0);
      if (c === 0 || c === 15) continue;
      // punti medi dei lati della cella, ×2 per restare su interi
      const tx = x * 2 + 1, ty = y * 2;        // top
      const rx = x * 2 + 2, ry = y * 2 + 1;    // right
      const bx = x * 2 + 1, by = y * 2 + 2;    // bottom
      const lx = x * 2, ly = y * 2 + 1;        // left
      switch (c) {
        case 1: add(lx, ly, tx, ty); break;
        case 2: add(tx, ty, rx, ry); break;
        case 3: add(lx, ly, rx, ry); break;
        case 4: add(rx, ry, bx, by); break;
        case 5: add(lx, ly, tx, ty); add(rx, ry, bx, by); break;
        case 6: add(tx, ty, bx, by); break;
        case 7: add(lx, ly, bx, by); break;
        case 8: add(bx, by, lx, ly); break;
        case 9: add(bx, by, tx, ty); break;
        case 10: add(tx, ty, rx, ry); add(bx, by, lx, ly); break;
        case 11: add(bx, by, rx, ry); break;
        case 12: add(rx, ry, lx, ly); break;
        case 13: add(rx, ry, tx, ty); break;
        case 14: add(tx, ty, lx, ly); break;
      }
    }
  }
  const used = new Uint8Array(segs.length / 4);
  /** @type {Float64Array[]} */
  const loops = [];
  for (let s0 = 0; s0 < used.length; s0++) {
    if (used[s0]) continue;
    /** @type {number[]} */
    const pts = [];
    let s = s0, guard = used.length + 4;
    while (s >= 0 && !used[s] && guard-- > 0) {
      used[s] = 1;
      const o = s * 4;
      pts.push(segs[o] / 2, segs[o + 1] / 2);
      const nx = start.get(segs[o + 2] << 12 | segs[o + 3]);
      s = nx === undefined ? -1 : nx;
    }
    if (pts.length >= 6) loops.push(Float64Array.from(pts));
  }
  return loops;
}

// Ricampiona un anello a passo ~sp (minimo 3 punti: anche i frammenti
// piccoli restano nella mesh — un'isola fuori mesh sparirebbe al commit).
/** @param {Float64Array} loop @param {number} sp @param {number[]} outX @param {number[]} outY */
export function resampleLoop(loop, sp, outX, outY) {
  const n = loop.length / 2;
  let per = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    per += Math.hypot(loop[j * 2] - loop[i * 2], loop[j * 2 + 1] - loop[i * 2 + 1]);
  }
  if (per < 1) return;
  const m = Math.max(3, Math.round(per / sp));
  const step = per / m;
  let acc = 0, want = 0, placed = 0;
  for (let i = 0; i < n && placed < m; i++) {
    const j = (i + 1) % n;
    const ax = loop[i * 2], ay = loop[i * 2 + 1];
    const dx = loop[j * 2] - ax, dy = loop[j * 2 + 1] - ay;
    const len = Math.hypot(dx, dy);
    while (want <= acc + len && placed < m) {
      const t = len > 0 ? (want - acc) / len : 0;
      // jitter minuscolo: rompe le cocircolarità della griglia marching
      const k = (outX.length * 31 + placed) | 0;
      outX.push(ax + dx * t + (rnd(k) - 0.5) * 0.25);
      outY.push(ay + dy * t + (rnd(k + 0x68bc) - 0.5) * 0.25);
      placed++;
      want += step;
    }
    acc += len;
  }
}

// ---- Delaunay (Bowyer-Watson incrementale) ---------------------------------

/**
 * Triangola i punti e tiene i soli triangoli col baricentro dentro la
 * maschera (così la mesh segue il contorno, buchi compresi).
 * @param {number[]} px @param {number[]} py
 * @param {Uint8Array} inside @param {number} w @param {number} h
 * @returns {number[]} terne di indici
 */
export function delaunay(px, py, inside, w, h) {
  const n = px.length;
  // super-triangolo che contiene tutta la maschera
  const ccx0 = w / 2, ccy0 = h / 2, R = Math.max(w, h) * 4;
  const X = Float64Array.from(px.concat([ccx0 - 2 * R, ccx0 + 2 * R, ccx0]));
  const Y = Float64Array.from(py.concat([ccy0 + R, ccy0 + R, ccy0 - 2 * R]));
  /** @type {number[]} */ const ta = [];
  /** @type {number[]} */ const tb = [];
  /** @type {number[]} */ const tc = [];
  /** @type {number[]} */ const ux = [];
  /** @type {number[]} */ const uy = [];
  /** @type {number[]} */ const r2 = [];
  /** @type {number[]} */ const alive = [];
  /** @param {number} a @param {number} b @param {number} c */
  const push = (a, b, c) => {
    const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return; // degenere: fuori dalla soup
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const px0 = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const py0 = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    ta.push(a); tb.push(b); tc.push(c);
    ux.push(px0); uy.push(py0);
    r2.push((ax - px0) * (ax - px0) + (ay - py0) * (ay - py0));
    alive.push(1);
  };
  push(n, n + 1, n + 2);
  /** @type {Map<number, number>} lato (chiave non orientata) → verso del primo */
  const poly = new Map();
  for (let p = 0; p < n; p++) {
    const pxx = X[p], pyy = Y[p];
    poly.clear();
    for (let t = 0; t < ta.length; t++) {
      if (!alive[t]) continue;
      const dx = pxx - ux[t], dy = pyy - uy[t];
      if (dx * dx + dy * dy - r2[t] > 1e-9) continue;
      alive[t] = 0;
      // i lati visti due volte sono interni alla cavità e si elidono;
      // i superstiti formano il poligono da riventagliare sul punto
      const A = ta[t], B = tb[t], C = tc[t];
      for (let k = 0; k < 3; k++) {
        const u0 = k === 0 ? A : k === 1 ? B : C;
        const v0 = k === 0 ? B : k === 1 ? C : A;
        const ku = u0 < v0 ? u0 * 65536 + v0 : v0 * 65536 + u0;
        if (poly.has(ku)) poly.delete(ku);
        else poly.set(ku, u0 * 65536 + v0);
      }
    }
    for (const dir of poly.values()) {
      push((dir / 65536) | 0, dir % 65536, p);
    }
  }
  /** @type {number[]} */
  const out = [];
  for (let t = 0; t < ta.length; t++) {
    if (!alive[t]) continue;
    const a = ta[t], b = tb[t], c = tc[t];
    if (a >= n || b >= n || c >= n) continue; // tocca il super-triangolo
    const gx = Math.round((X[a] + X[b] + X[c]) / 3);
    const gy = Math.round((Y[a] + Y[b] + Y[c]) / 3);
    if (gx < 0 || gy < 0 || gx >= w || gy >= h || !inside[gy * w + gx]) continue;
    out.push(a, b, c);
  }
  return out;
}

// ---- costruzione della mesh -------------------------------------------------

/**
 * Triangola il contenuto dello store: maschera dall'alpha (OR per pixel:
 * niente feature perse), Espansione via EDT, contorni + reticolo esagonale,
 * Delaunay filtrato. null se non c'è abbastanza contenuto.
 * @param {ChunkStore} store
 * @param {{x: number, y: number, w: number, h: number}} bbox bbox contenuto (mondo)
 * @param {number} expansion px sorgente (negativa = contrae, alla Photoshop)
 * @param {'less'|'normal'|'more'} density
 * @returns {PuppetMesh|null}
 */
export function buildPuppetMesh(store, bbox, expansion, density) {
  if (store.map.size === 0 || bbox.w <= 0 || bbox.h <= 0) return null;
  const maxDim = Math.max(bbox.w, bbox.h);
  const scale = Math.min(1, MASK_MAX / maxDim);
  const pad = Math.max(2, Math.ceil(Math.max(0, expansion) * scale) + 2);
  const w = Math.ceil(bbox.w * scale) + pad * 2;
  const h = Math.ceil(bbox.h * scale) + pad * 2;
  const mask = new Uint8Array(w * h);
  // qualunque pixel con alpha accende il suo px maschera (OR: le linee
  // sottili sopravvivono anche con la maschera sottocampionata)
  for (const c of store.map.values()) {
    const ox = c.cx * CHUNK, oy = c.cy * CHUNK, data = c.data;
    for (let row = 0; row < CHUNK; row++) {
      const wy = oy + row;
      if (wy < bbox.y || wy >= bbox.y + bbox.h) continue;
      const mrow = (Math.floor((wy - bbox.y) * scale) + pad) * w + pad;
      const base = (row << CHUNK_SHIFT) * 4 + 3;
      for (let col = 0; col < CHUNK; col++) {
        if (data[base + col * 4] === 0) continue;
        const wx = ox + col;
        if (wx < bbox.x || wx >= bbox.x + bbox.w) continue;
        mask[mrow + Math.floor((wx - bbox.x) * scale)] = 1;
      }
    }
  }
  // Espansione (default Photoshop 2 px): dilata/erode via EDT; in
  // dilatazione almeno 1 px maschera, così il bordo respira sempre un po'
  const e = expansion * scale;
  let inside = mask;
  if (expansion > 0) {
    const r = Math.max(1, e), d = edtSq(mask, w, h, true);
    inside = new Uint8Array(w * h);
    for (let i = 0; i < inside.length; i++) inside[i] = d[i] <= r * r ? 1 : 0;
  } else if (expansion < 0) {
    const d = edtSq(mask, w, h, false);
    inside = new Uint8Array(w * h);
    for (let i = 0; i < inside.length; i++) inside[i] = mask[i] !== 0 && d[i] > e * e ? 1 : 0;
  }
  let area = 0;
  for (let i = 0; i < inside.length; i++) area += inside[i];
  if (area < 4) return null;
  // passo del reticolo esagonale dal bersaglio di vertici della Densità
  const target = TARGET_VERTS[density] || TARGET_VERTS.normal;
  const sp = Math.max(2.5, Math.sqrt(area / target / 0.866));
  // punti di bordo dai contorni ricampionati
  const loops = traceContours(inside, w, h);
  if (loops.length === 0) return null;
  /** @type {number[]} */ const px = [];
  /** @type {number[]} */ const py = [];
  for (const loop of loops) resampleLoop(loop, sp, px, py);
  if (px.length < 3) return null;
  // punti interni: reticolo esagonale jitterato, lontano dal contorno
  const dIn = edtSq(inside, w, h, false);
  const rIn2 = (sp * 0.68) * (sp * 0.68);
  const rowH = sp * 0.866;
  for (let r = 0, y = rowH * 0.5; y < h; y += rowH, r++) {
    const off = (r & 1) ? sp * 0.5 : 0;
    for (let x = off; x < w; x += sp) {
      const k = (r * 7919 + Math.round(x / sp)) | 0;
      const jx = x + (rnd(k) - 0.5) * sp * 0.36;
      const jy = y + (rnd(k + 0x21eb) - 0.5) * sp * 0.36;
      const mx = Math.round(jx), my = Math.round(jy);
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      const mi = my * w + mx;
      if (!inside[mi] || dIn[mi] < rIn2) continue;
      px.push(jx); py.push(jy);
    }
  }
  if (px.length > 60000) return null; // oltre gli indici a 16 bit: mai coi target
  const soup = delaunay(px, py, inside, w, h);
  if (soup.length === 0) return null;
  // compattazione: restano solo i vertici usati dai triangoli tenuti
  const remap = new Int32Array(px.length).fill(-1);
  let nv = 0;
  for (const v of soup) if (remap[v] < 0) remap[v] = nv++;
  const pos0 = new Float32Array(nv * 2);
  for (let i = 0; i < px.length; i++) {
    const m = remap[i];
    if (m < 0) continue;
    pos0[m * 2] = bbox.x + (px[i] - pad + 0.5) / scale;
    pos0[m * 2 + 1] = bbox.y + (py[i] - pad + 0.5) / scale;
  }
  const tris = new Uint32Array(soup.length);
  for (let i = 0; i < soup.length; i++) tris[i] = remap[soup[i]];
  // spigoli unici per l'overlay della rete
  /** @type {Set<number>} */
  const eset = new Set();
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k], b = tris[t + (k + 1) % 3];
      eset.add(a < b ? a * 65536 + b : b * 65536 + a);
    }
  }
  const edges = new Uint32Array(eset.size * 2);
  let q = 0;
  for (const key of eset) {
    edges[q++] = (key / 65536) | 0;
    edges[q++] = key % 65536;
  }
  return { pos0, tris, edges, spacing: sp / scale };
}

// ---- hit test ---------------------------------------------------------------

/**
 * Vertice ancorabile sotto il punto: il triangolo deformato che lo contiene
 * decide, e si prende il suo angolo più vicino. -1 se fuori dalla mesh.
 * @param {Float32Array} def @param {Uint32Array} tris @param {number} x @param {number} y
 */
export function puppetHit(def, tris, x, y) {
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ax = def[a * 2], ay = def[a * 2 + 1];
    const bx = def[b * 2], by = def[b * 2 + 1];
    const cx = def[c * 2], cy = def[c * 2 + 1];
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx)) continue;
    if (y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
    const e0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const e1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const e2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) {
      const d0 = (x - ax) * (x - ax) + (y - ay) * (y - ay);
      const d1 = (x - bx) * (x - bx) + (y - by) * (y - by);
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      return d0 <= d1 ? (d0 <= d2 ? a : c) : (d1 <= d2 ? b : c);
    }
  }
  return -1;
}

/** Vertice più vicino a un punto (riaggancio delle puntine al rebuild).
 * @param {Float32Array} pos @param {number} x @param {number} y */
export function nearestPuppetVertex(pos, x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pos.length; i += 2) {
    const dx = pos[i] - x, dy = pos[i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i >> 1; }
  }
  return best;
}

// ---- solver As-Rigid-As-Possible --------------------------------------------

export class PuppetSolver {
  /** @param {Float32Array} pos0 @param {Uint32Array} tris */
  constructor(pos0, tris) {
    const n = this.n = pos0.length >> 1;
    this.pos0 = pos0;
    // pesi cotangenti per spigolo: ½(cot α + cot β), clampati (i triangoli
    // sottili al bordo darebbero pesi negativi/enormi)
    /** @type {Map<number, number>} */
    const wmap = new Map();
    /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
    const cot = (ax, ay, bx, by) => {
      const cross = Math.abs(ax * by - ay * bx);
      const v = (ax * bx + ay * by) / Math.max(cross, 1e-9);
      return Math.min(Math.max(v, 0), 50);
    };
    for (let t = 0; t < tris.length; t += 3) {
      const i = tris[t], j = tris[t + 1], k = tris[t + 2];
      const xi = pos0[i * 2], yi = pos0[i * 2 + 1];
      const xj = pos0[j * 2], yj = pos0[j * 2 + 1];
      const xk = pos0[k * 2], yk = pos0[k * 2 + 1];
      const ck = 0.5 * cot(xi - xk, yi - yk, xj - xk, yj - yk);
      const ci = 0.5 * cot(xj - xi, yj - yi, xk - xi, yk - yi);
      const cj = 0.5 * cot(xi - xj, yi - yj, xk - xj, yk - yj);
      const acc = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ w0) => {
        const kk = a < b ? a * 65536 + b : b * 65536 + a;
        wmap.set(kk, (wmap.get(kk) || 0) + w0);
      };
      acc(i, j, ck);
      acc(j, k, ci);
      acc(k, i, cj);
    }
    // CSR simmetrico
    const deg = new Int32Array(n);
    for (const k of wmap.keys()) {
      deg[(k / 65536) | 0]++;
      deg[k % 65536]++;
    }
    const off = this.off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
    const nbr = this.nbr = new Int32Array(off[n]);
    const wgt = this.wgt = new Float64Array(off[n]);
    const cur = Int32Array.from(off.subarray(0, n));
    for (const [k, w0] of wmap) {
      const a = (k / 65536) | 0, b = k % 65536;
      const w = Math.max(w0, 1e-3);
      nbr[cur[a]] = b; wgt[cur[a]++] = w;
      nbr[cur[b]] = a; wgt[cur[b]++] = w;
    }
    const diag = this.diag = new Float64Array(n);
    const wp2 = this.wp2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let d = 0, s = 0;
      for (let o = off[i]; o < off[i + 1]; o++) {
        const j = nbr[o], w0 = wgt[o];
        d += w0;
        const ex = pos0[i * 2] - pos0[j * 2], ey = pos0[i * 2 + 1] - pos0[j * 2 + 1];
        s += w0 * (ex * ex + ey * ey);
      }
      diag[i] = Math.max(d, 1e-9);
      wp2[i] = Math.max(s, 1e-9);
    }
    // rotazione per vertice (a,b) = R [[a,-b],[b,a]], scala inclusa nei modi morbidi
    this.ra = new Float64Array(n).fill(1);
    this.rb = new Float64Array(n);
    // vincoli: puntine (posizioni dure) e rotazioni forzate (NaN = libera)
    this.pinned = new Uint8Array(n);
    this.rotF = new Float64Array(n).fill(NaN);
    // scratch del gradiente coniugato (x,y interallacciati)
    this.b = new Float64Array(n * 2);
    this.r = new Float64Array(n * 2);
    this.p = new Float64Array(n * 2);
    this.ap = new Float64Array(n * 2);
    this.z = new Float64Array(n * 2);
  }

  // Struttura dei vincoli: quali vertici sono puntine, quali rotazioni sono
  // forzate (puntina "Fisso"/Alt+drag: l'angolo si impone anche al primo
  // anello, così la presa è netta come in Photoshop).
  /** @param {{v: number, fixed: boolean, rot: number}[]} pins */
  setPins(pins) {
    this.pinned.fill(0);
    this.rotF.fill(NaN);
    for (const p of pins) this.pinned[p.v] = 1;
    for (const p of pins) {
      if (!p.fixed) continue;
      this.rotF[p.v] = p.rot;
      for (let o = this.off[p.v]; o < this.off[p.v + 1]; o++) this.rotF[this.nbr[o]] = p.rot;
    }
  }

  /** Angolo emergente attorno a un vertice (lettura per la puntina Auto). @param {number} v */
  angleAt(v) { return Math.atan2(this.rb[v], this.ra[v]); }

  /**
   * iters passi locale/globale. I bersagli delle puntine si leggono live.
   * @param {Float32Array} def posizioni deformate (in place)
   * @param {{v: number, tx: number, ty: number}[]} pins
   * @param {'rigid'|'normal'|'distort'} mode
   * @param {number} iters
   */
  step(def, pins, mode, iters) {
    for (const p of pins) {
      def[p.v * 2] = p.tx;
      def[p.v * 2 + 1] = p.ty;
    }
    for (let it = 0; it < iters; it++) {
      this._local(def, mode);
      this._global(def);
    }
  }

  // Passo locale: per ogni vertice la rotazione (Rigida), la rotazione con
  // metà scala (Normale) o la similitudine piena (Distorci) che meglio porta
  // l'intorno a riposo su quello corrente — la Modalità di Photoshop è
  // esattamente l'elasticità di questo fit.
  /** @param {Float32Array} def @param {'rigid'|'normal'|'distort'} mode */
  _local(def, mode) {
    const { n, pos0, off, nbr, wgt, ra, rb, wp2, rotF } = this;
    for (let i = 0; i < n; i++) {
      const rf = rotF[i];
      if (rf === rf) { // rotazione forzata dalla puntina
        ra[i] = Math.cos(rf);
        rb[i] = Math.sin(rf);
        continue;
      }
      let m00 = 0, m01 = 0, m10 = 0, m11 = 0;
      const pix = pos0[i * 2], piy = pos0[i * 2 + 1];
      const xix = def[i * 2], xiy = def[i * 2 + 1];
      for (let o = off[i]; o < off[i + 1]; o++) {
        const j = nbr[o], w0 = wgt[o];
        const px = pix - pos0[j * 2], py = piy - pos0[j * 2 + 1];
        const xx = xix - def[j * 2], xy = xiy - def[j * 2 + 1];
        m00 += w0 * px * xx; m01 += w0 * px * xy;
        m10 += w0 * py * xx; m11 += w0 * py * xy;
      }
      const A = m00 + m11, B = m01 - m10;
      const nrm = Math.hypot(A, B);
      if (nrm < 1e-12) { ra[i] = 1; rb[i] = 0; continue; }
      let s = 1;
      if (mode !== 'rigid') {
        const fit = nrm / wp2[i];
        s = mode === 'distort' ? fit : Math.sqrt(fit);
        s = Math.min(Math.max(s, 0.05), 20);
      }
      ra[i] = A / nrm * s;
      rb[i] = B / nrm * s;
    }
  }

  // Passo globale: L·x = b sui liberi (Laplaciano cotangente, vincoli duri
  // spostati al termine noto), gradiente coniugato precondizionato Jacobi
  // con warm start dalle posizioni correnti — a regime poche iterazioni.
  /** @param {Float32Array} def */
  _global(def) {
    const { n, pos0, off, nbr, wgt, ra, rb, pinned, diag, b, r, p, ap, z } = this;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) { b[i * 2] = 0; b[i * 2 + 1] = 0; continue; }
      let bx = 0, by = 0;
      const pix = pos0[i * 2], piy = pos0[i * 2 + 1];
      for (let o = off[i]; o < off[i + 1]; o++) {
        const j = nbr[o], w0 = wgt[o];
        const px = pix - pos0[j * 2], py = piy - pos0[j * 2 + 1];
        const a2 = (ra[i] + ra[j]) * 0.5, b2 = (rb[i] + rb[j]) * 0.5;
        bx += w0 * (a2 * px - b2 * py);
        by += w0 * (b2 * px + a2 * py);
        if (pinned[j]) { // il vincolo passa al termine noto
          bx += w0 * def[j * 2];
          by += w0 * def[j * 2 + 1];
        }
      }
      b[i * 2] = bx;
      b[i * 2 + 1] = by;
    }
    /** @param {Float64Array|Float32Array} src @param {Float64Array} dst */
    const matvec = (src, dst) => {
      for (let i = 0; i < n; i++) {
        if (pinned[i]) { dst[i * 2] = 0; dst[i * 2 + 1] = 0; continue; }
        let ax = diag[i] * src[i * 2], ay = diag[i] * src[i * 2 + 1];
        for (let o = off[i]; o < off[i + 1]; o++) {
          const j = nbr[o];
          if (pinned[j]) continue;
          ax -= wgt[o] * src[j * 2];
          ay -= wgt[o] * src[j * 2 + 1];
        }
        dst[i * 2] = ax;
        dst[i * 2 + 1] = ay;
      }
    };
    matvec(def, ap);
    let rz = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        r[i * 2] = 0; r[i * 2 + 1] = 0;
        z[i * 2] = 0; z[i * 2 + 1] = 0;
        p[i * 2] = 0; p[i * 2 + 1] = 0;
        continue;
      }
      const rx = b[i * 2] - ap[i * 2], ry = b[i * 2 + 1] - ap[i * 2 + 1];
      r[i * 2] = rx; r[i * 2 + 1] = ry;
      const zx = rx / diag[i], zy = ry / diag[i];
      z[i * 2] = zx; z[i * 2 + 1] = zy;
      p[i * 2] = zx; p[i * 2 + 1] = zy;
      rz += rx * zx + ry * zy;
      b2 += b[i * 2] * b[i * 2] + b[i * 2 + 1] * b[i * 2 + 1];
    }
    const tol = Math.max(b2, 1e-9) * 1e-10;
    for (let it = 0; it < 40 && rz > tol; it++) {
      matvec(p, ap);
      let pap = 0;
      for (let k = 0; k < n * 2; k++) pap += p[k] * ap[k];
      if (pap <= 1e-30) break;
      const alpha = rz / pap;
      let rzN = 0;
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        def[i * 2] += alpha * p[i * 2];
        def[i * 2 + 1] += alpha * p[i * 2 + 1];
        r[i * 2] -= alpha * ap[i * 2];
        r[i * 2 + 1] -= alpha * ap[i * 2 + 1];
        const zx = r[i * 2] / diag[i], zy = r[i * 2 + 1] / diag[i];
        z[i * 2] = zx; z[i * 2 + 1] = zy;
        rzN += r[i * 2] * zx + r[i * 2 + 1] * zy;
      }
      const beta = rzN / rz;
      rz = rzN;
      for (let k = 0; k < n * 2; k++) p[k] = z[k] + beta * p[k];
    }
  }
}

// ---- ordine di disegno (pieghe + Profondità puntina) -----------------------

/**
 * Triangoli dal meno al più "sopra": prima la profondità media delle puntine
 * (Profondità puntina di Photoshop, propagata ai vertici), poi lo
 * spostamento dal riposo (la parte trascinata vince nelle pieghe, come il
 * warpFoldOrder). Condiviso da anteprima GL, bake 2D e commit.
 * @param {Float32Array} pos0 @param {Float32Array} def @param {Uint32Array} tris
 * @param {Float32Array} vdep profondità per vertice
 * @param {Uint32Array} [out]
 * @returns {Uint32Array}
 */
export function puppetTriOrder(pos0, def, tris, vdep, out) {
  const T = (tris.length / 3) | 0;
  const key = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    let disp = 0;
    let dx = def[a * 2] - pos0[a * 2], dy = def[a * 2 + 1] - pos0[a * 2 + 1];
    disp = dx * dx + dy * dy;
    dx = def[b * 2] - pos0[b * 2]; dy = def[b * 2 + 1] - pos0[b * 2 + 1];
    if (dx * dx + dy * dy > disp) disp = dx * dx + dy * dy;
    dx = def[c * 2] - pos0[c * 2]; dy = def[c * 2 + 1] - pos0[c * 2 + 1];
    if (dx * dx + dy * dy > disp) disp = dx * dx + dy * dy;
    key[t] = (vdep[a] + vdep[b] + vdep[c]) / 3 * 1e9 + Math.min(disp, 0.999e9);
  }
  if (!out || out.length !== T) out = new Uint32Array(T);
  for (let t = 0; t < T; t++) out[t] = t;
  return out.sort((x, y) => key[x] - key[y]);
}

// ---- commit -----------------------------------------------------------------

/**
 * Commit del puppet warp: ricampiona i pixel dello store sulla mesh
 * deformata. Stesso rasterizer di warpStore — mapping affine per triangolo,
 * bilineare su premultiplied, riempimento top-left (ogni pixel UNA volta,
 * niente cuciture), compositing over nelle pieghe nell'ordine dato.
 * LOSSY: undo tile-diff, capture PRIMA della mutazione (stesso contratto).
 * I pixel fuori dalla mesh (Espansione negativa) si perdono, come in
 * Photoshop.
 * @param {ChunkStore} store
 * @param {Float32Array} pos0 vertici a riposo (mondo)
 * @param {Float32Array} def vertici deformati (mondo)
 * @param {Uint32Array} tris
 * @param {Uint32Array} order triangoli dal meno al più "sopra"
 * @param {{x: number, y: number, w: number, h: number}} srcBox hull chunk-aligned
 * @param {{x0: number, y0: number, x1: number, y1: number}} clip
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray|null) => void} capture
 * @param {(c: Chunk) => void} disposeTex
 */
export function puppetStore(store, pos0, def, tris, order, srcBox, clip, capture, disposeTex) {
  if (store.map.size === 0 || tris.length === 0) return;
  // snapshot contiguo del sorgente: letto tutto PRIMA di ogni mutazione
  const sw = srcBox.w, sh = srcBox.h;
  const src = new Uint8ClampedArray(sw * sh * 4);
  for (const ch of store.map.values()) {
    const ox = ch.cx * CHUNK - srcBox.x, oy = ch.cy * CHUNK - srcBox.y;
    if (ox < 0 || oy < 0 || ox + CHUNK > sw || oy + CHUNK > sh) continue; // fuori hull: vuoto per costruzione
    for (let row = 0; row < CHUNK; row++) {
      src.set(ch.data.subarray(row * CHUNK * 4, (row + 1) * CHUNK * 4), ((oy + row) * sw + ox) * 4);
    }
  }

  // bbox destinazione: estremi della mesh deformata, ∩ clip
  let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
  for (let k = 0; k < def.length; k += 2) {
    const X = def[k], Y = def[k + 1];
    if (X < dx0) dx0 = X; if (X > dx1) dx1 = X;
    if (Y < dy0) dy0 = Y; if (Y > dy1) dy1 = Y;
  }
  dx0 = Math.max(Math.floor(dx0) - 1, clip.x0);
  dy0 = Math.max(Math.floor(dy0) - 1, clip.y0);
  dx1 = Math.min(Math.ceil(dx1) + 1, clip.x1);
  dy1 = Math.min(Math.ceil(dy1) + 1, clip.y1);

  // cattura: tutti i chunk esistenti (saranno svuotati) + la fascia destinazione
  /** @type {Set<number>} */
  const seen = new Set();
  for (const ch of store.map.values()) {
    seen.add(ch.key);
    capture(ch.key, ch.cx, ch.cy, ch.data);
  }
  if (dx0 <= dx1 && dy0 <= dy1) {
    for (let cy = dy0 >> CHUNK_SHIFT; cy <= dy1 >> CHUNK_SHIFT; cy++) {
      for (let cx = dx0 >> CHUNK_SHIFT; cx <= dx1 >> CHUNK_SHIFT; cx++) {
        const key = chunkKey(cx, cy);
        if (!seen.has(key)) { seen.add(key); capture(key, cx, cy, null); }
      }
    }
  }
  // via tutto il sorgente: il contenuto rinasce ricampionato
  for (const key of [...store.map.keys()]) store.remove(key, disposeTex);
  if (dx0 > dx1 || dy0 > dy1) return; // tutto fuori dal canvas

  const dw = dx1 - dx0 + 1, dh = dy1 - dy0 + 1;
  const dst = new Uint8ClampedArray(dw * dh * 4);

  // Un triangolo: vertici destinazione (px mondo) + sorgente (px snapshot).
  // Identico al tri() di warpStore (top-left, bilineare, over nelle pieghe).
  /**
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {number} x2 @param {number} y2
   * @param {number} u0t @param {number} v0t @param {number} u1t @param {number} v1t
   * @param {number} u2t @param {number} v2t
   */
  const tri = (x0, y0, x1, y1, x2, y2, u0t, v0t, u1t, v1t, u2t, v2t) => {
    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area === 0) return;
    if (area < 0) {
      let t;
      t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t;
      t = u1t; u1t = u2t; u2t = t; t = v1t; v1t = v2t; v2t = t;
      area = -area;
    }
    const ia = 1 / area;
    const au = ((u1t - u0t) * (y2 - y0) - (u2t - u0t) * (y1 - y0)) * ia;
    const bu = ((u2t - u0t) * (x1 - x0) - (u1t - u0t) * (x2 - x0)) * ia;
    const cu = u0t - au * x0 - bu * y0 - 0.5;
    const av = ((v1t - v0t) * (y2 - y0) - (v2t - v0t) * (y1 - y0)) * ia;
    const bv = ((v2t - v0t) * (x1 - x0) - (v1t - v0t) * (x2 - x0)) * ia;
    const cv = v0t - av * x0 - bv * y0 - 0.5;
    const XA = Math.max(dx0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
    const XB = Math.min(dx1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const YA = Math.max(dy0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
    const YB = Math.min(dy1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    if (XA > XB || YA > YB) return;
    const d0x = x1 - x0, d0y = y1 - y0;
    const d1x = x2 - x1, d1y = y2 - y1;
    const d2x = x0 - x2, d2y = y0 - y2;
    const ok0 = d0y < 0 || (d0y === 0 && d0x > 0);
    const ok1 = d1y < 0 || (d1y === 0 && d1x > 0);
    const ok2 = d2y < 0 || (d2y === 0 && d2x > 0);
    let e0r = d0x * (YA + 0.5 - y0) - d0y * (XA + 0.5 - x0);
    let e1r = d1x * (YA + 0.5 - y1) - d1y * (XA + 0.5 - x1);
    let e2r = d2x * (YA + 0.5 - y2) - d2y * (XA + 0.5 - x2);
    let sur = au * (XA + 0.5) + bu * (YA + 0.5) + cu;
    let svr = av * (XA + 0.5) + bv * (YA + 0.5) + cv;
    for (let Y = YA; Y <= YB; Y++) {
      let e0 = e0r, e1 = e1r, e2 = e2r, sxf = sur, syf = svr;
      let o = ((Y - dy0) * dw + (XA - dx0)) * 4;
      for (let X = XA; X <= XB; X++, o += 4, e0 -= d0y, e1 -= d1y, e2 -= d2y, sxf += au, syf += av) {
        if (e0 < 0 || (e0 === 0 && !ok0)) continue;
        if (e1 < 0 || (e1 === 0 && !ok1)) continue;
        if (e2 < 0 || (e2 === 0 && !ok2)) continue;
        const fx = Math.floor(sxf), fy = Math.floor(syf);
        if (fx < -1 || fy < -1 || fx >= sw || fy >= sh) continue;
        const wx = sxf - fx, wy = syf - fy;
        const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy);
        const w01 = (1 - wx) * wy, w11 = wx * wy;
        let r = 0, g = 0, bl = 0, al = 0;
        const in00 = fx >= 0 && fy >= 0, in10 = fx + 1 < sw && fy >= 0;
        const in01 = fx >= 0 && fy + 1 < sh, in11 = fx + 1 < sw && fy + 1 < sh;
        if (in00 && w00 > 0) {
          const t = (fy * sw + fx) * 4;
          r += src[t] * w00; g += src[t + 1] * w00; bl += src[t + 2] * w00; al += src[t + 3] * w00;
        }
        if (in10 && w10 > 0) {
          const t = (fy * sw + fx + 1) * 4;
          r += src[t] * w10; g += src[t + 1] * w10; bl += src[t + 2] * w10; al += src[t + 3] * w10;
        }
        if (in01 && w01 > 0) {
          const t = ((fy + 1) * sw + fx) * 4;
          r += src[t] * w01; g += src[t + 1] * w01; bl += src[t + 2] * w01; al += src[t + 3] * w01;
        }
        if (in11 && w11 > 0) {
          const t = ((fy + 1) * sw + fx + 1) * 4;
          r += src[t] * w11; g += src[t + 1] * w11; bl += src[t + 2] * w11; al += src[t + 3] * w11;
        }
        if (al < 0.5) continue;
        const oa = dst[o + 3];
        if (oa === 0) {
          dst[o] = r; dst[o + 1] = g; dst[o + 2] = bl; dst[o + 3] = al;
        } else {
          const k = 1 - al / 255;
          dst[o] = r + dst[o] * k;
          dst[o + 1] = g + dst[o + 1] * k;
          dst[o + 2] = bl + dst[o + 2] * k;
          dst[o + 3] = al + oa * k;
        }
      }
      e0r += d0x; e1r += d1x; e2r += d2x; sur += bu; svr += bv;
    }
  };

  for (let q = 0; q < order.length; q++) {
    const t = order[q] * 3;
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    tri(def[a * 2], def[a * 2 + 1], def[b * 2], def[b * 2 + 1], def[c * 2], def[c * 2 + 1],
      pos0[a * 2] - srcBox.x, pos0[a * 2 + 1] - srcBox.y,
      pos0[b * 2] - srcBox.x, pos0[b * 2 + 1] - srcBox.y,
      pos0[c * 2] - srcBox.x, pos0[c * 2 + 1] - srcBox.y);
  }

  // scrittura per chunk: solo le destinazioni con contenuto rinascono
  const scratch = new Uint8ClampedArray(CHUNK_BYTES);
  for (let cy = dy0 >> CHUNK_SHIFT; cy <= dy1 >> CHUNK_SHIFT; cy++) {
    for (let cx = dx0 >> CHUNK_SHIFT; cx <= dx1 >> CHUNK_SHIFT; cx++) {
      const x0 = Math.max(cx * CHUNK, dx0), x1 = Math.min(cx * CHUNK + CHUNK - 1, dx1);
      const y0 = Math.max(cy * CHUNK, dy0), y1 = Math.min(cy * CHUNK + CHUNK - 1, dy1);
      scratch.fill(0);
      const nb = (x1 - x0 + 1) * 4;
      for (let wy = y0; wy <= y1; wy++) {
        const so = ((wy - dy0) * dw + (x0 - dx0)) * 4;
        const dofs = ((wy - cy * CHUNK) * CHUNK + (x0 - cx * CHUNK)) * 4;
        scratch.set(dst.subarray(so, so + nb), dofs);
      }
      let any = false;
      for (let o = 3; o < scratch.length; o += 4) {
        if (scratch[o] !== 0) { any = true; break; }
      }
      if (!any) continue;
      const chunk = store.getOrCreate(cx, cy);
      chunk.data.set(scratch);
      chunk.touched = true;
      store.markDirty(chunk);
    }
  }
}
