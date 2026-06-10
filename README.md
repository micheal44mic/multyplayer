# Fable Paint — canvas infinito

Web app di disegno con canvas infinito, ispirata a Magma ma single-player.
Architettura: input passivo su ring buffer → frame loop unico → pipeline
matematica (descrittori, non pixel) → rasterizer a due vie con budget per
frame → pixel store CPU sparso (chunk 256×256 RGBA premultiplied) → GPU come
proiettore (WebGL, upload dei soli tile sporchi, pan/zoom in vertex shader).

## Avvio

Serve un server statico (i moduli ES non girano da `file://`):

```
npx serve .          # oppure: python -m http.server 8000
```

e apri `http://localhost:3000` (o la porta indicata).

## Comandi

| Azione | Desktop | Mobile |
|---|---|---|
| Disegna | trascina (mouse/penna) | un dito |
| Pan | spazio+trascina, tasto centrale/destro, strumento Mano (H) | due dita |
| Zoom | rotella | pinch a due dita |
| Annulla / Ripristina | Ctrl+Z / Ctrl+Y | pulsanti toolbar |
| Dimensione pennello | `[` e `]` | slider |
| Pennello / Gomma / Mano | B / E / H | pulsanti toolbar |
| Pannello pennello | P | pulsante ⚙ |
| Console prestazioni | `` ` `` | pulsante console |
| Reimposta vista | 0 | pulsante vista |

## Pennello

Dimensione, opacità, morbidezza, stabilizzazione, spaziatura 0,1%–300%,
rotondità, angolo, scatter, jitter (posizione, spessore, opacità, spaziatura,
angolo, luminosità, saturazione), pressione→dimensione/opacità.

**Accumula opacità** (buildup): ON = l'opacità di ogni stamp si somma dentro
il tratto; OFF (wash) = il tratto resta a opacità uniforme anche dove si
auto-incrocia. In wash i dab vengono accumulati in uno stroke buffer con
max(alpha) e compositati sul layer una sola volta al pointer-up.

## Note architetturali

- **Via continua**: con spacing < 5%, niente jitter e dab tondo, l'unione dei
  dab è geometricamente una catena di capsule: lavoro ∝ area coperta, non al
  numero di stamp (un flick da 5000 stamp diventa ~450k pixel).
- **Budget raster adattivo**: max N Mpx toccati per frame (target ~6 ms);
  l'eccedenza resta in coda e il tratto rincorre il dito (catch-up).
- **Buildup a spacing basso**: lo spacing di rasterizzazione è clampato al 3%
  e l'alpha per dab compensata con 1−(1−a)^k — stessa copertura accumulata,
  fino a 30× meno lavoro.
- **Undo tile-diff**: i chunk "prima" vengono compressi (deflate) in un worker,
  fuori dal path del dito. Cap: 64 step / 256 MB equivalenti.
- **Context loss WebGL**: il documento vive in CPU; le texture si ricreano.
- **Fallback Canvas2D** dietro la stessa interfaccia del renderer.

## Struttura

```
js/main.js         frame loop unico (input→sample→raster→upload→present)
js/input.js        pointer events coalesced → ring buffer; gesture touch
js/stroke.js       smoother, sampler con spacing, dynamics → descrittori
js/brush.js        impostazioni + StampCache (maschere AA per bucket, LRU)
js/raster.js       capsule + stamp, budget, commit dello stroke buffer
js/store.js        chunk store sparso 256² premultiplied + dirty tracking
js/renderer_gl.js  WebGL: texture per chunk, griglia procedurale
js/renderer_2d.js  fallback Canvas2D
js/undo.js+worker  undo tile-diff con compressione in worker
js/hud.js          console prestazioni (fps, timing, budget, memoria)
js/ui.js           pannello pennello, toolbar, export PNG
```
