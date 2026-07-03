# Raster parallelo su worker + SharedArrayBuffer — design v1

Obiettivo: la rasterizzazione LIVE dei tratti pennello/gomma esce dal main
thread (Web Worker), l'output resta **bit-exact** col path attuale, lo spacing
e ogni comportamento non cambiano. Gate per-tratto con fallback totale.

## Divisione dei ruoli

- **Main = autorità sulla STRUTTURA.** Decide quali chunk esistono e quale
  slot SAB usa ciascuno, simulando la geometria di creazione dei dab/capsule
  (stessa matematica del Rasterizer, `stampParams` condivisa da brush.js).
  Lo store specchio (`SabStrokeStore`) è un `ChunkStore` vero coi dati nei
  slot SAB: il renderer ci fa gli upload, commit/endPass lo leggono.
- **Worker = solo PIXEL.** Riceve i descrittori (già espansi da specchio e
  pattern: la DabQueue resta sul main, unico imbuto) coi binding key→slot
  decisi dal main, esegue lo STESSO `Rasterizer` JS (heap wasm assente:
  maschere JS, contratto bit-exact JS==WASM già provato dai test) e scrive
  nei slot. Incrementa `ctl[DRAINED]` (Atomics) di N a fine batch.

## Protocollo (postMessage, FIFO = unica fonte di ordinamento)

- `init {ctl, slots, touched, nSlots}` — SAB: ctl Int32Array (0=drained),
  slots nSlots×CHUNK_BYTES, touched nSlots u8.
- `asset {id, kind:'tex'|'shape', obj}` — texture/shape una volta per id.
- `begin {gen, snap, clip, sel}` — snap serializzato (niente rng/sampleStore;
  tex/shape per id; LUT clonate). Reset implicito dei binding.
- `entries {gen, n, buf, creations:[key,slot,...]}` — un batch per frame.
- `reset {gen}` — fine/annullo: il worker dimentica binding e snap.

Nessun messaggio strutturale worker→main: solo `drained`, `touched[slot]`
e i pixel nel SAB. Il main marca dirty (upload) i rect dei batch con
`idx <= drained` — mai upload di pixel non ancora scritti; la visibilità è
garantita dall'edge seq-cst di `Atomics.load/add`.

## Slot pool (main-only)

`allocView` in `getOrCreate` dello specchio; il rilascio è DIFFERITO: gli
slot liberati finiscono in `pendingZero` e vengono azzerati+riciclati solo
quando `drained == sent` (worker fermo) — mai zero/riuso sotto scritture in
volo (l'unico rilascio pre-flush è il cancel). SAB dimensionato sul board
più grande (slot = chunk del board + margine), ricreato a inizio tratto se
serve più capienza (worker idle per costruzione).

## Punti di sincronizzazione (spin su Atomics.load, mai Atomics.wait sul main)

- **endPass (punta del taper, stesso frame del pen-up)**: send resto coda →
  `flushSync` → poi la logica attuale gira SUL MAIN col Rasterizer secondario
  (`rasterSab`, heap=null) contro lo store specchio. Bit-exact col live.
- **commit**: gate asincrono `pendingCommit && bridge.idle` (niente spin);
  `commitChunk` con heap=null (i chunk stroke non sono memoria wasm);
  `touched` copiato dai flag SAB prima della selezione dei chunk.
- **_flushPendingStroke / _syncSnapStroke / cancel**: flush o reset; lo snap
  ridisegna TUTTO sul path main (l'output del worker viene buttato comunque).

## Gate per-tratto (fallback = path attuale, zero delta)

worker se: bridge pronto ∧ `crossOriginIsolated` ∧ SAB ∧ tratto locale
(la replay collab resta sincrona sul main: `_applyStroke` usa `a.raster`)
∧ niente aqua (campiona il layer documento, che vive sul main).

`App.strokeStore` è scambiato per-tratto (main ↔ specchio) e ripristinato a
fine commit/annullo; `App.curRaster` è il Rasterizer autorevole del tratto
(snap per live opacity/commit). L'istanza `this.raster` resta INTOCCATA e
sempre legata allo store main: la collab non vede differenze.

## Invarianti da non rompere

1. La simulazione di creazione (raster_shared) DEVE creare un soprainsieme
   esatto dei chunk del raster: `stampParams` è l'unica fonte della taglia
   stamp (bucket compresi) — test differenziale `js/raster_worker_test.mjs`.
2. Il worker non tocca mai la struttura: getOrCreate senza binding = bug
   (console.error + buffer staccato per non corrompere).
3. drained conta ENTRY (non batch); incrementato SEMPRE, anche su errore.
4. COOP/COEP obbligatori per SAB: serve.mjs, vite dev, vercel.json. Con
   `require-corp` ogni risorsa cross-origin da <img>/<script> deve avere
   CORP; WebSocket (PeerJS) non sono toccati.
