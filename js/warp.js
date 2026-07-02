// WARP TRASFORMAZIONE (alla Photoshop) — il contenuto si piega su una
// patch di Bézier tensor-product di grado N (basi di Bernstein), come il
// warp di Photoshop e dell'editor cbos: griglia N×N a schermo, (N+1)²
// punti di controllo. La superficie PASSA solo per i 4 angoli; i punti di
// bordo sono le maniglie delle curve di contorno e gli interni agiscono da
// magneti con influenza morbida e globale — è la sensazione PS autentica
// (grado 3 = la bicubica classica; griglia 4×4/5×5 = grado 4/5, più
// controllo locale). Il cambio densità ELEVA il grado in salita (esatto:
// l'immagine non si muove) e riduce ai minimi quadrati in discesa.
// I punti vivono NORMALIZZATI alla bbox del contenuto (a riposo
// x = colonna/N, y = riga/N: il reticolo uniforme È l'identità per Bézier)
// e la composizione con la sessione è mondo = Affine ∘ Warp(bbox): il warp
// piega nello spazio del contenuto, sposta/ruota/scala si applicano sopra.
// Filosofia identica a Sposta/Trasforma: durante il gesto NESSUN pixel si
// tocca — l'anteprima è una mesh GPU (renderer_gl) o un bake su canvas
// (renderer_2d) della STESSA texture piatta della sessione; al ✓ si
// ricampiona UNA volta sola dai pixel originali (warpStore, qui sotto).
// warpGridWorld è l'UNICO valutatore della superficie: anteprime e commit
// campionano la stessa matematica, cambiano solo densità e dominio.

import { CHUNK, CHUNK_SHIFT, CHUNK_BYTES, chunkKey } from './store.js';

/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./store.js').Chunk} Chunk */

// Sfumatura del bordo: il dominio della mesh esce di 2 px sorgente oltre la
// bbox del contenuto, così il bilineare spegne l'alpha sul bordo invece di
// tagliarlo a metà pixel (stesso bordo morbido del quad affine).
export const WARP_PAD = 2;

// Sotto questa distanza (unità bbox 0..1) la griglia conta come "a riposo":
// niente mesh in anteprima, niente warp al commit.
const IDENT_EPS = 1e-4;

/**
 * Griglia di ancore a riposo per N×N celle: (N+1)² punti, riga per riga,
 * in unità bbox (0..1 su entrambi gli assi).
 * @param {number} n @returns {Float32Array}
 */
export function makeLattice(n) {
  const np = n + 1;
  const pts = new Float32Array(np * np * 2);
  let o = 0;
  for (let i = 0; i < np; i++) {
    for (let j = 0; j < np; j++) {
      pts[o++] = j / n;
      pts[o++] = i / n;
    }
  }
  return pts;
}

/** Tutte le ancore (quasi) a riposo? @param {Float32Array} pts @param {number} n */
export function latticeIdentity(pts, n) {
  const np = n + 1;
  let o = 0;
  for (let i = 0; i < np; i++) {
    for (let j = 0; j < np; j++, o += 2) {
      if (Math.abs(pts[o] - j / n) > IDENT_EPS) return false;
      if (Math.abs(pts[o + 1] - i / n) > IDENT_EPS) return false;
    }
  }
  return true;
}

// Coefficienti binomiali fino al grado massimo della griglia (5×5).
const BINOM = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1], [1, 5, 10, 10, 5, 1]];

// Basi di Bernstein di grado n in t: out[o..o+n] = C(n,k)·t^k·(1-t)^(n-k).
// Polinomi: fuori da [0,1] è l'estrapolazione del dominio esteso WARP_PAD.
/** @param {number} n @param {number} t @param {Float64Array} out @param {number} o */
function bernstein(n, t, out, o) {
  const bn = BINOM[n], s = 1 - t;
  let tp = 1;
  for (let k = 0; k <= n; k++) {
    out[o + k] = bn[k] * tp;
    tp *= t;
  }
  let sp = 1;
  for (let k = n; k >= 0; k--) {
    out[o + k] *= sp;
    sp *= s;
  }
}

/**
 * Campiona la superficie su una griglia regolare (segsX+1)×(segsY+1) del
 * dominio [u0..u1]×[v0..v1] (unità bbox; oltre 0..1 = estrapolazione) e
 * porta i punti in MONDO: bbox → warp → affine m. Ritorna le coppie (x,y)
 * riga per riga (v esterno). segs = 0 su un asse = linea singola a u0/v0.
 * Valutazione separabile: per riga si collassano le righe di controllo con
 * la base in v, poi ogni colonna è un prodotto scalare con la base in u.
 * @param {Float32Array} pts @param {number} n
 * @param {{x: number, y: number, w: number, h: number}} bbox bbox contenuto in mondo
 * @param {number[]} m affine mondo [a,b,c,d,e,f]
 * @param {number} u0 @param {number} u1 @param {number} v0 @param {number} v1
 * @param {number} segsX @param {number} segsY
 * @param {Float32Array} [out] riusato se abbastanza grande
 * @returns {Float32Array}
 */
export function warpGridWorld(pts, n, bbox, m, u0, u1, v0, v1, segsX, segsY, out) {
  const np = n + 1, cols = segsX + 1, rows = segsY + 1;
  if (!out || out.length < cols * rows * 2) out = new Float32Array(cols * rows * 2);
  // basi lungo u precalcolate per colonna
  const bu = new Float64Array(cols * np);
  for (let j = 0; j < cols; j++) {
    bernstein(n, segsX === 0 ? u0 : u0 + (u1 - u0) * j / segsX, bu, j * np);
  }
  const bv = new Float64Array(np);
  const rowPts = new Float64Array(np * 2); // righe di controllo collassate in v
  const ma = m[0], mb = m[1], mc = m[2], md = m[3], me = m[4], mf = m[5];
  let o = 0;
  for (let i = 0; i < rows; i++) {
    bernstein(n, segsY === 0 ? v0 : v0 + (v1 - v0) * i / segsY, bv, 0);
    for (let c = 0; c < np; c++) {
      let px = 0, py = 0;
      for (let r = 0; r < np; r++) {
        const w = bv[r], s = (r * np + c) * 2;
        px += w * pts[s];
        py += w * pts[s + 1];
      }
      rowPts[c * 2] = px;
      rowPts[c * 2 + 1] = py;
    }
    for (let j = 0; j < cols; j++) {
      const wo = j * np;
      let px = 0, py = 0;
      for (let c = 0; c < np; c++) {
        const w = bu[wo + c];
        px += w * rowPts[c * 2];
        py += w * rowPts[c * 2 + 1];
      }
      const wx = bbox.x + px * bbox.w, wy = bbox.y + py * bbox.h;
      out[o++] = ma * wx + mc * wy + me;
      out[o++] = mb * wx + md * wy + mf;
    }
  }
  return out;
}

// ---- cambio di densità della griglia ---------------------------------------

// Matrice di elevazione del grado da m a n (n ≥ m): composizione dei passi
// singoli Q_k = k/(d+1)·P_{k-1} + (1−k/(d+1))·P_k — ESATTA: la superficie
// elevata è identica, cambia solo il numero di punti di controllo.
/** @param {number} m @param {number} n @returns {number[][]} (n+1)×(m+1) */
function elevMatrix(m, n) {
  /** @type {number[][]} */
  let E = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === j ? 1 : 0)));
  for (let d = m; d < n; d++) {
    /** @type {number[][]} */
    const S = Array.from({ length: d + 2 }, (_, k) => {
      const row = new Array(d + 1).fill(0);
      const a = k / (d + 1);
      if (k > 0) row[k - 1] += a;
      if (k <= d) row[k] += 1 - a;
      return row;
    });
    // E = S·E
    E = S.map((srow) => {
      const out = new Array(m + 1).fill(0);
      for (let c = 0; c <= d; c++) {
        const w = srow[c];
        if (w === 0) continue;
        for (let j = 0; j <= m; j++) out[j] += w * E[c][j];
      }
      return out;
    });
  }
  return E;
}

// Risolve A·x = b in place (A quadrata piccola, eliminazione con pivot).
/** @param {number[][]} A @param {number[]} b @returns {number[]} */
function solve(A, b) {
  const n = A.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = b[r];
    for (let c = r + 1; c < n; c++) acc -= A[r][c] * x[c];
    x[r] = acc / (A[r][r] || 1e-12);
  }
  return x;
}

// Applica una matrice (righe×colonne) lungo un ASSE del reticolo di punti.
/** @param {Float32Array} pts @param {number} rows @param {number} cols
 *  @param {number[][]} M @param {boolean} alongRows true = trasforma ogni riga
 *  @returns {{pts: Float32Array, rows: number, cols: number}} */
function applyAxis(pts, rows, cols, M, alongRows) {
  const outN = M.length;
  const oRows = alongRows ? rows : outN, oCols = alongRows ? outN : cols;
  const out = new Float32Array(oRows * oCols * 2);
  for (let i = 0; i < oRows; i++) {
    for (let j = 0; j < oCols; j++) {
      const row = alongRows ? M[j] : M[i];
      let px = 0, py = 0;
      for (let k = 0; k < row.length; k++) {
        const w = row[k];
        if (w === 0) continue;
        const s = alongRows ? (i * cols + k) * 2 : (k * cols + j) * 2;
        px += w * pts[s];
        py += w * pts[s + 1];
      }
      const d = (i * oCols + j) * 2;
      out[d] = px;
      out[d + 1] = py;
    }
  }
  return { pts: out, rows: oRows, cols: oCols };
}

/**
 * Cambia densità della griglia preservando la piega (alla Photoshop):
 * in SALITA elevazione del grado (esatta: l'immagine non si muove di un
 * pixel), in DISCESA proiezione ai minimi quadrati sulla base più povera,
 * con i 4 angoli riagganciati esattamente.
 * @param {Float32Array} pts @param {number} n grado corrente @param {number} m grado nuovo
 * @returns {Float32Array}
 */
export function resampleLattice(pts, n, m) {
  if (m === n) return pts.slice();
  const np = n + 1, mp = m + 1;
  /** @type {number[][]} */
  let M;
  if (m > n) {
    M = elevMatrix(n, m);
  } else {
    // riduzione LS: pinv(E) = (EᵀE)⁻¹Eᵀ con E elevazione da m a n
    const E = elevMatrix(m, n);
    /** @type {number[][]} */
    const G = Array.from({ length: mp }, (_, i) =>
      Array.from({ length: mp }, (_, j) => {
        let acc = 0;
        for (let k = 0; k < np; k++) acc += E[k][i] * E[k][j];
        return acc;
      }));
    // M = G⁻¹·Eᵀ (mp×np), costruita colonna per colonna risolvendo G·x = E[c]
    M = Array.from({ length: mp }, () => new Array(np).fill(0));
    for (let c = 0; c < np; c++) {
      const A = G.map((row) => row.slice());
      const b = new Array(mp);
      for (let i = 0; i < mp; i++) b[i] = E[c][i];
      const x = solve(A, b);
      for (let i = 0; i < mp; i++) M[i][c] = x[i];
    }
  }
  let lat = { pts, rows: np, cols: np };
  lat = applyAxis(lat.pts, lat.rows, lat.cols, M, true);
  lat = applyAxis(lat.pts, lat.rows, lat.cols, M, false);
  const out = lat.pts;
  if (m < n) {
    // gli angoli sono superficie esatta: si riagganciano dopo la proiezione
    const src = [[0, 0], [0, n], [n, 0], [n, n]];
    const dst = [[0, 0], [0, m], [m, 0], [m, m]];
    for (let k = 0; k < 4; k++) {
      const s = (src[k][0] * np + src[k][1]) * 2, d = (dst[k][0] * mp + dst[k][1]) * 2;
      out[d] = pts[s];
      out[d + 1] = pts[s + 1];
    }
  }
  return out;
}

/**
 * (u,v) del punto della superficie più vicino a un punto MONDO — il grab
 * del drag-superficie (alla cbos/Photoshop: si afferra l'immagine ovunque).
 * Ricerca a griglia 24×24 + un raffinamento locale.
 * @param {Float32Array} pts @param {number} n
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @param {number[]} m affine mondo @param {number} x @param {number} y
 * @returns {{u: number, v: number}}
 */
export function warpUvAt(pts, n, bbox, m, x, y) {
  const STEPS = 24;
  /** @type {Float32Array|undefined} */
  let grid;
  let bu = 0.5, bv = 0.5, best = Infinity;
  let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
  for (let pass = 0; pass < 2; pass++) {
    grid = warpGridWorld(pts, n, bbox, m, u0, u1, v0, v1, STEPS, STEPS, grid);
    for (let i = 0; i <= STEPS; i++) {
      for (let j = 0; j <= STEPS; j++) {
        const o = (i * (STEPS + 1) + j) * 2;
        const dx = grid[o] - x, dy = grid[o + 1] - y;
        const d = dx * dx + dy * dy;
        if (d < best) {
          best = d;
          bu = u0 + (u1 - u0) * j / STEPS;
          bv = v0 + (v1 - v0) * i / STEPS;
        }
      }
    }
    // secondo passaggio: zoom sull'intorno del migliore (clamp a [0,1])
    const ru = (u1 - u0) / STEPS * 2, rv = (v1 - v0) / STEPS * 2;
    u0 = Math.max(0, bu - ru); u1 = Math.min(1, bu + ru);
    v0 = Math.max(0, bv - rv); v1 = Math.min(1, bv + rv);
  }
  return { u: bu, v: bv };
}

/**
 * Pesi di spinta del drag-superficie, con caduta LOCALE (alla Photoshop):
 * il punto afferrato segue esattamente il dito, i punti di controllo
 * vicini si muovono molto e l'effetto si perde verso l'esterno — falloff
 * Wyvill (1−d²)³ sulla distanza a riposo nella griglia, raggio ~2 celle
 * (griglia più fitta = ritocco più locale), rinormalizzato perché la
 * superficie in (u,v) si muova ESATTAMENTE di Δ: Σ Bᵢ·wᵢ = 1.
 * @param {number} n @param {number} u @param {number} v
 * @returns {Float64Array} (n+1)² pesi, riga per riga
 */
export function warpPushWeights(n, u, v) {
  const np = n + 1;
  const buArr = new Float64Array(np), bvArr = new Float64Array(np);
  bernstein(n, u, buArr, 0);
  bernstein(n, v, bvArr, 0);
  const w = new Float64Array(np * np);
  const R = 2 / n;
  let dot = 0;
  for (let i = 0; i < np; i++) {
    for (let j = 0; j < np; j++) {
      const du = j / n - u, dv = i / n - v;
      const d2 = (du * du + dv * dv) / (R * R);
      const f = d2 >= 1 ? 0 : (1 - d2) ** 3;
      w[i * np + j] = f;
      dot += bvArr[i] * buArr[j] * f;
    }
  }
  // l'afferrato deve seguire il dito: se la base in (u,v) non vede i punti
  // dentro il raggio (non succede: la massa di Bernstein sta lì) si rinuncia
  const inv = dot > 1e-6 ? 1 / dot : 0;
  for (let k = 0; k < w.length; k++) w[k] *= inv;
  return w;
}

/**
 * Ordine di disegno delle celle nelle PIEGHE: chi è più spostato dal riposo
 * si disegna DOPO e quindi sta SOPRA — la parte che l'utente sta
 * trascinando vince sulla parte ferma (senza ordinamento vincerebbe sempre
 * la cella in basso a destra, ordine row-major). Condiviso da mesh GL,
 * bake 2D e commit: la piega si vede uguale ovunque. G è la griglia di
 * warpGridWorld con gli STESSI parametri di dominio.
 * @param {Float32Array} G nodi mondo (cols×rows×2)
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @param {number[]} m affine mondo
 * @param {number} u0 @param {number} u1 @param {number} v0 @param {number} v1
 * @param {number} segsX @param {number} segsY
 * @returns {Uint32Array} indici cella (i·segsX+j) dal meno al più spostato
 */
export function warpFoldOrder(G, bbox, m, u0, u1, v0, v1, segsX, segsY) {
  const cols = segsX + 1, rows = segsY + 1;
  const ma = m[0], mb = m[1], mc = m[2], md = m[3], me = m[4], mf = m[5];
  // spostamento² di ogni nodo dalla sua posizione a riposo (solo affine)
  const disp = new Float64Array(cols * rows);
  let k = 0;
  for (let i = 0; i < rows; i++) {
    const v = segsY === 0 ? v0 : v0 + (v1 - v0) * i / segsY;
    const wy = bbox.y + v * bbox.h;
    for (let j = 0; j < cols; j++, k++) {
      const u = segsX === 0 ? u0 : u0 + (u1 - u0) * j / segsX;
      const wx = bbox.x + u * bbox.w;
      const rx = ma * wx + mc * wy + me, ry = mb * wx + md * wy + mf;
      const dx = G[k * 2] - rx, dy = G[k * 2 + 1] - ry;
      disp[k] = dx * dx + dy * dy;
    }
  }
  const cells = segsX * segsY;
  const key = new Float64Array(cells);
  for (let i = 0; i < segsY; i++) {
    for (let j = 0; j < segsX; j++) {
      const a = i * cols + j;
      let d = disp[a];
      if (disp[a + 1] > d) d = disp[a + 1];
      if (disp[a + cols] > d) d = disp[a + cols];
      if (disp[a + cols + 1] > d) d = disp[a + cols + 1];
      key[i * segsX + j] = d;
    }
  }
  const order = new Uint32Array(cells);
  for (let c = 0; c < cells; c++) order[c] = c;
  return order.sort((a, b) => key[a] - key[b]);
}

// ---- trasformazione prospettica (alla Photoshop/cbos) ----------------------
// Quad a 4 angoli liberi = OMOGRAFIA (mappa proiettiva del piano), la
// "Perspective distortion" dell'editor cbos. Gli angoli vivono in unità
// bbox come le ancore warp (a riposo (0,0),(1,0),(1,1),(0,1) = identità) e
// la composizione è la stessa: mondo = Affine ∘ H(bbox). A differenza del
// warp l'omografia manda RETTE in RETTE: l'anteprima GL è il quad esatto
// con la divisione prospettica nel fragment shader (niente mesh) e il
// commit è un mapping INVERSO per pixel (l'omografia si inverte in forma
// chiusa: esatto, niente triangoli). Il quad resta CONVESSO per costruzione
// (una prospettiva di rettangolo lo è sempre; oltre, l'orizzonte entrerebbe
// nel quad e l'omografia degenera): la UI rifiuta i drag che lo rompono,
// quindi niente pieghe né ordine di disegno.

/** Angoli a riposo (TL,TR,BR,BL) in unità bbox. @returns {Float32Array} */
export function makePerspQuad() {
  return new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
}

/** Tutti gli angoli (quasi) a riposo? @param {Float32Array} q */
export function perspIdentity(q) {
  const R = [0, 0, 1, 0, 1, 1, 0, 1];
  for (let k = 0; k < 8; k++) {
    if (Math.abs(q[k] - R[k]) > IDENT_EPS) return false;
  }
  return true;
}

/**
 * Quad strettamente convesso nell'ordine TL,TR,BR,BL (y in giù)?
 * Cross di ogni coppia di lati consecutivi > soglia (a riposo vale 1).
 * @param {Float32Array} q
 */
export function perspConvex(q) {
  for (let k = 0; k < 4; k++) {
    const i = k * 2, j = ((k + 1) % 4) * 2, l = ((k + 2) % 4) * 2;
    const ax = q[j] - q[i], ay = q[j + 1] - q[i + 1];
    const bx = q[l] - q[j], by = q[l + 1] - q[j + 1];
    if (ax * by - ay * bx <= 1e-3) return false;
  }
  return true;
}

// Omografia unit→quad (Heckbert, come la computeDestToSourceUvHomography
// del cbos ma in avanti): F = [a b c; d e f; g h 1] riga per riga, con
// (x,y) = ((a·u+b·v+c)/w, (d·u+e·v+f)/w), w = g·u+h·v+1 e
// (0,0)→q0, (1,0)→q1, (1,1)→q2, (0,1)→q3. null se degenere.
/** @param {Float32Array} q @returns {Float64Array|null} */
function perspUnitToQuad(q) {
  const x0 = q[0], y0 = q[1], x1 = q[2], y1 = q[3];
  const x2 = q[4], y2 = q[5], x3 = q[6], y3 = q[7];
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const EPS = 1e-9;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < EPS && Math.abs(sy) < EPS) {
    // parallelogramma: la mappa è affine
    a = x1 - x0; b = x3 - x0; c = x0;
    d = y1 - y0; e = y3 - y0; f = y0;
    g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < EPS) return null;
    g = (sx * dy2 - sy * dx2) / det;
    h = (dx1 * sy - dy1 * sx) / det;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return Float64Array.of(a, b, c, d, e, f, g, h, 1);
}

// Adjugata 3×3 riga per riga: inversa a meno di scala — per una omografia
// (definita a meno di scala) È l'inversa.
/** @param {Float64Array} M @returns {Float64Array} */
function adjugate(M) {
  return Float64Array.of(
    M[4] * M[8] - M[5] * M[7], M[2] * M[7] - M[1] * M[8], M[1] * M[5] - M[2] * M[4],
    M[5] * M[6] - M[3] * M[8], M[0] * M[8] - M[2] * M[6], M[2] * M[3] - M[0] * M[5],
    M[3] * M[7] - M[4] * M[6], M[1] * M[6] - M[0] * M[7], M[0] * M[4] - M[1] * M[3]);
}

/**
 * Campiona l'omografia su una griglia regolare (segsX+1)×(segsY+1) del
 * dominio [u0..u1]×[v0..v1] (unità bbox; oltre 0..1 = il bordo esteso) e
 * porta i punti in MONDO: bbox → H → affine m. Stesso contratto di
 * warpGridWorld (segs = 0 su un asse = linea singola a u0/v0).
 * @param {Float32Array} q angoli (TL,TR,BR,BL) in unità bbox
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @param {number[]} m affine mondo [a,b,c,d,e,f]
 * @param {number} u0 @param {number} u1 @param {number} v0 @param {number} v1
 * @param {number} segsX @param {number} segsY
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function perspGridWorld(q, bbox, m, u0, u1, v0, v1, segsX, segsY, out) {
  const cols = segsX + 1, rows = segsY + 1;
  if (!out || out.length < cols * rows * 2) out = new Float32Array(cols * rows * 2);
  // degenere (la UI lo impedisce): identità, il quad resta dov'è
  const F = perspUnitToQuad(q) || Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const ma = m[0], mb = m[1], mc = m[2], md = m[3], me = m[4], mf = m[5];
  let o = 0;
  for (let i = 0; i < rows; i++) {
    const v = segsY === 0 ? v0 : v0 + (v1 - v0) * i / segsY;
    for (let j = 0; j < cols; j++) {
      const u = segsX === 0 ? u0 : u0 + (u1 - u0) * j / segsX;
      const iw = 1 / (F[6] * u + F[7] * v + F[8]);
      const px = (F[0] * u + F[1] * v + F[2]) * iw;
      const py = (F[3] * u + F[4] * v + F[5]) * iw;
      const wx = bbox.x + px * bbox.w, wy = bbox.y + py * bbox.h;
      out[o++] = ma * wx + mc * wy + me;
      out[o++] = mb * wx + md * wy + mf;
    }
  }
  return out;
}

/**
 * Matrice (riga per riga) del mapping INVERSO mondo → sorgente:
 * (sx,sy) = (N·(x,y,1)).xy / .z, con sorgente = (bbox + H⁻¹(u,v)·bbox − origine)/scala.
 * Per il fragment shader GL origine/scala = hull della texture (escono UV);
 * per il commit origine = srcBox e scala 1 (escono px dello snapshot).
 * Normalizzata con w > 0 dentro il quad (l'adjugata è a meno di scala).
 * null se omografia o affine sono degeneri.
 * @param {Float32Array} q angoli (TL,TR,BR,BL) in unità bbox
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @param {number[]} m affine mondo [a,b,c,d,e,f]
 * @param {number} ox @param {number} oy origine del bersaglio (px mondo)
 * @param {number} sw @param {number} sh scala del bersaglio
 * @returns {Float64Array|null}
 */
export function perspWorldToSrc(q, bbox, m, ox, oy, sw, sh) {
  const F = perspUnitToQuad(q);
  if (!F) return null;
  const A = adjugate(F); // quad (unità bbox) → unit square
  // mondo → unità bbox: inversa dell'affine m composta con bbox⁻¹
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det;
  const w0 = ia / bbox.w, w1 = ic / bbox.w;
  const w2 = (-(ia * m[4] + ic * m[5]) - bbox.x) / bbox.w;
  const w3 = ib / bbox.h, w4 = id / bbox.h;
  const w5 = (-(ib * m[4] + id * m[5]) - bbox.y) / bbox.h;
  // N = A · W (W affine: terza riga 0 0 1) → mondo → (u,v) omogeneo
  const N = Float64Array.of(
    A[0] * w0 + A[1] * w3, A[0] * w1 + A[1] * w4, A[0] * w2 + A[1] * w5 + A[2],
    A[3] * w0 + A[4] * w3, A[3] * w1 + A[4] * w4, A[3] * w2 + A[4] * w5 + A[5],
    A[6] * w0 + A[7] * w3, A[6] * w1 + A[7] * w4, A[6] * w2 + A[7] * w5 + A[8]);
  // bersaglio: src = (bbox.x + u·bbox.w − ox)/sw, ripiegato nelle prime due righe
  const kx = bbox.w / sw, cx = (bbox.x - ox) / sw;
  const ky = bbox.h / sh, cy = (bbox.y - oy) / sh;
  const M = Float64Array.of(
    kx * N[0] + cx * N[6], kx * N[1] + cx * N[7], kx * N[2] + cx * N[8],
    ky * N[3] + cy * N[6], ky * N[4] + cy * N[7], ky * N[5] + cy * N[8],
    N[6], N[7], N[8]);
  // segno: w positivo al centro del quad (punto interno per convessità)
  const cu = (q[0] + q[2] + q[4] + q[6]) / 4, cv = (q[1] + q[3] + q[5] + q[7]) / 4;
  const wcx = bbox.x + cu * bbox.w, wcy = bbox.y + cv * bbox.h;
  const X = m[0] * wcx + m[2] * wcy + m[4], Y = m[1] * wcx + m[3] * wcy + m[5];
  const wc = M[6] * X + M[7] * Y + M[8];
  if (Math.abs(wc) < 1e-12) return null;
  if (wc < 0) {
    for (let k = 0; k < 9; k++) M[k] = -M[k];
  }
  return M;
}

/**
 * Sfumatura per lato: WARP_PAD px oltre la bbox, ma mai oltre l'hull della
 * texture (lì CLAMP/clip non avrebbero il trasparente da campionare).
 * Condivisa da anteprima GL, bake 2D e commit: stesso bordo ovunque.
 * @param {number} bx @param {number} by @param {number} bw @param {number} bh bbox contenuto
 * @param {number} hx @param {number} hy @param {number} hw @param {number} hh hull texture
 * @returns {{l: number, r: number, t: number, b: number}}
 */
export function warpPads(bx, by, bw, bh, hx, hy, hw, hh) {
  return {
    l: Math.min(WARP_PAD, bx - hx),
    t: Math.min(WARP_PAD, by - hy),
    r: Math.min(WARP_PAD, hx + hw - (bx + bw)),
    b: Math.min(WARP_PAD, hy + hh - (by + bh)),
  };
}

/**
 * Commit del warp: ricampiona TUTTI i pixel dello store con
 * mondo = m ∘ Warp(bbox), clippando al rettangolo inclusivo del board.
 * Mapping FORWARD a mesh di triangoli (celle ~6 px sorgente: l'errore di
 * curvatura resta sotto il pixel): dentro ogni triangolo il mapping
 * destinazione→sorgente è affine — bilineare su premultiplied (lo spazio
 * corretto per filtrare, come transformStore), riempimento con regola
 * top-left (ogni pixel coperto UNA volta: niente cuciture né doppi blend
 * tra triangoli adiacenti), compositing over dove le pieghe si accavallano.
 * LOSSY: l'undo è il tile-diff — capture(key, cx, cy, beforeOrNull) per OGNI
 * chunk che cambia, PRIMA della mutazione (stesso contratto di
 * transformStore). srcBox: hull chunk-aligned del contenuto, bbox: bbox
 * pixel-exact del contenuto (il dominio della griglia di ancore).
 * @param {ChunkStore} store
 * @param {Float32Array} pts ancore in unità bbox @param {number} n celle per lato
 * @param {number[]} m affine mondo [a,b,c,d,e,f]
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @param {{x: number, y: number, w: number, h: number}} srcBox
 * @param {{x0: number, y0: number, x1: number, y1: number}} clip
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray|null) => void} capture
 * @param {(c: Chunk) => void} disposeTex
 */
export function warpStore(store, pts, n, m, bbox, srcBox, clip, capture, disposeTex) {
  if (store.map.size === 0) return;
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

  // griglia forward sul dominio esteso (bordo morbido, vedi warpPads)
  const pads = warpPads(bbox.x, bbox.y, bbox.w, bbox.h, srcBox.x, srcBox.y, srcBox.w, srcBox.h);
  const ew = bbox.w + pads.l + pads.r, eh = bbox.h + pads.t + pads.b;
  const segsX = Math.min(384, Math.max(n * 8, Math.ceil(ew / 6), 2));
  const segsY = Math.min(384, Math.max(n * 8, Math.ceil(eh / 6), 2));
  const G = warpGridWorld(pts, n, bbox, m,
    -pads.l / bbox.w, 1 + pads.r / bbox.w, -pads.t / bbox.h, 1 + pads.b / bbox.h,
    segsX, segsY);
  // coordinate sorgente dei nodi (spazio snapshot): lineari per costruzione
  const su = new Float64Array(segsX + 1), sv = new Float64Array(segsY + 1);
  for (let j = 0; j <= segsX; j++) su[j] = bbox.x - pads.l + ew * j / segsX - srcBox.x;
  for (let i = 0; i <= segsY; i++) sv[i] = bbox.y - pads.t + eh * i / segsY - srcBox.y;

  // bbox destinazione: estremi dei nodi trasformati, ∩ clip
  let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
  for (let k = 0; k < (segsX + 1) * (segsY + 1) * 2; k += 2) {
    const X = G[k], Y = G[k + 1];
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
      // le pieghe ribaltano le celle: orientamento normalizzato scambiando
      // due vertici (la regola dei bordi resta coerente dentro la piega)
      let t;
      t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t;
      t = u1t; u1t = u2t; u2t = t; t = v1t; v1t = v2t; v2t = t;
      area = -area;
    }
    // mapping affine destinazione→sorgente; il -0.5 dei centri sorgente è
    // già nel termine noto (campioni ai centri, come transformStore)
    const ia = 1 / area;
    const au = ((u1t - u0t) * (y2 - y0) - (u2t - u0t) * (y1 - y0)) * ia;
    const bu = ((u2t - u0t) * (x1 - x0) - (u1t - u0t) * (x2 - x0)) * ia;
    const cu = u0t - au * x0 - bu * y0 - 0.5;
    const av = ((v1t - v0t) * (y2 - y0) - (v2t - v0t) * (y1 - y0)) * ia;
    const bv = ((v2t - v0t) * (x1 - x0) - (v1t - v0t) * (x2 - x0)) * ia;
    const cv = v0t - av * x0 - bv * y0 - 0.5;
    // pixel i cui CENTRI (X+0.5) cadono nel triangolo
    const XA = Math.max(dx0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
    const XB = Math.min(dx1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const YA = Math.max(dy0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
    const YB = Math.min(dy1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    if (XA > XB || YA > YB) return;
    // edge function per lato; sul bordo esatto decide la direzione del lato
    // (regola complementare: il lato condiviso da due triangoli è percorso
    // in versi opposti, quindi il pixel appartiene a UNO solo)
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
        if (al < 0.5) continue; // arrotonderebbe a 0: il pixel resta vuoto
        const oa = dst[o + 3];
        if (oa === 0) {
          dst[o] = r; dst[o + 1] = g; dst[o + 2] = bl; dst[o + 3] = al;
        } else {
          // piega: il triangolo disegnato dopo sta sopra (over premultiplied)
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

  // celle dal meno al più spostato: nelle pieghe la parte trascinata sta sopra
  const order = warpFoldOrder(G, bbox, m,
    -pads.l / bbox.w, 1 + pads.r / bbox.w, -pads.t / bbox.h, 1 + pads.b / bbox.h,
    segsX, segsY);
  const cols = segsX + 1;
  for (const cell of order) {
    const i = (cell / segsX) | 0, j = cell % segsX;
    const a = (i * cols + j) * 2, b = a + 2, c = a + cols * 2, d = c + 2;
    // diagonale 00→11 condivisa in versi opposti dai due triangoli
    tri(G[a], G[a + 1], G[b], G[b + 1], G[d], G[d + 1],
      su[j], sv[i], su[j + 1], sv[i], su[j + 1], sv[i + 1]);
    tri(G[a], G[a + 1], G[d], G[d + 1], G[c], G[c + 1],
      su[j], sv[i], su[j + 1], sv[i + 1], su[j], sv[i + 1]);
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

/**
 * Commit della prospettiva: ricampiona TUTTI i pixel dello store con
 * mondo = m ∘ H(bbox), clippando al rettangolo inclusivo del board.
 * Mapping INVERSO esatto per pixel: destinazione → sorgente con divisione
 * prospettica (perspWorldToSrc), bilineare su premultiplied — lo stesso
 * campionamento di warpStore/transformStore, ma senza triangoli: il quad è
 * convesso per costruzione, ogni pixel è coperto al più una volta.
 * LOSSY: undo tile-diff, stesso contratto di warpStore.
 * @param {ChunkStore} store
 * @param {Float32Array} q angoli in unità bbox (TL,TR,BR,BL)
 * @param {number[]} m affine mondo [a,b,c,d,e,f]
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @param {{x: number, y: number, w: number, h: number}} srcBox
 * @param {{x0: number, y0: number, x1: number, y1: number}} clip
 * @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray|null) => void} capture
 * @param {(c: Chunk) => void} disposeTex
 */
export function perspStore(store, q, m, bbox, srcBox, clip, capture, disposeTex) {
  if (store.map.size === 0) return;
  const N = perspWorldToSrc(q, bbox, m, srcBox.x, srcBox.y, 1, 1);
  if (!N) return; // degenere (la UI lo impedisce): niente commit
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

  // bbox destinazione: l'omografia manda rette in rette, bastano i 4 angoli
  // del dominio esteso (bordo morbido, vedi warpPads), ∩ clip
  const pads = warpPads(bbox.x, bbox.y, bbox.w, bbox.h, srcBox.x, srcBox.y, srcBox.w, srcBox.h);
  const C = perspGridWorld(q, bbox, m,
    -pads.l / bbox.w, 1 + pads.r / bbox.w, -pads.t / bbox.h, 1 + pads.b / bbox.h, 1, 1);
  let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
  for (let k = 0; k < 8; k += 2) {
    const X = C[k], Y = C[k + 1];
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
  // copertura: coordinate sorgente dentro il dominio esteso (px snapshot)
  const ex0 = bbox.x - pads.l - srcBox.x, ex1 = bbox.x + bbox.w + pads.r - srcBox.x;
  const ey0 = bbox.y - pads.t - srcBox.y, ey1 = bbox.y + bbox.h + pads.b - srcBox.y;
  for (let Y = dy0; Y <= dy1; Y++) {
    const yc = Y + 0.5;
    // numeratori e denominatore affini in X: si incrementano per pixel
    let nx = N[0] * (dx0 + 0.5) + N[1] * yc + N[2];
    let ny = N[3] * (dx0 + 0.5) + N[4] * yc + N[5];
    let nw = N[6] * (dx0 + 0.5) + N[7] * yc + N[8];
    let o = (Y - dy0) * dw * 4;
    for (let X = dx0; X <= dx1; X++, o += 4, nx += N[0], ny += N[3], nw += N[6]) {
      if (nw < 1e-9) continue; // oltre l'orizzonte
      const iw = 1 / nw;
      const sx = nx * iw, sy = ny * iw;
      if (sx < ex0 || sx > ex1 || sy < ey0 || sy > ey1) continue;
      // campioni ai centri sorgente, come warpStore
      const sxf = sx - 0.5, syf = sy - 0.5;
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
      if (al < 0.5) continue; // arrotonderebbe a 0: il pixel resta vuoto
      dst[o] = r; dst[o + 1] = g; dst[o + 2] = bl; dst[o + 3] = al;
    }
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
