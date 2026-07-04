# Motore pennello su WebGPU — piano e STATO (aggiornato 04/07/2026 notte)

Obiettivo dell'utente: risultato "assurdo" — tratto real-time a qualunque
size/texture, 120Hz, anche su telefoni economici. Vincolo n.1: matematica
INTERA bit-exact tra CPU/GPU/vendor, così il replay deterministico della
collab sopravvive. Decisione utente: NIENTE gate a soglia, "deve funzionare
e punto" — GPU ovunque ci sia WebGPU, fallback worker/main dove non c'è.

## COSA È FATTO E VERIFICATO (questa è la base, non rifarla)

- **Fase 0 — ink overlay** (js/ink_overlay.js): punta raw+predizione ~14ms
  sopra i piani, copre stabilizzatore e descrittori in volo (coda main,
  worker via bridge.inkRing/tickDrained, gpu via gli stessi campi del
  WgpuStrokeBridge). Coda post pen-up che copre il backlog. Gate: solo
  tratto locale pennello (no gomma/aqua/selezione/snap/collab). Fix mobile:
  NIENTE hint desynchronized (nero opaco su Chrome Android).
- **Kernel sigillati bit-exact su 3 vendor** (NVIDIA, Apple/iPhone, Mali/
  Android — ALL PASS dal campo via HTTPS LAN): dab wash/buildup
  (js/wgpu_dab.js, maschere CPU + interi) e CAPSULE v2 a interi
  (js/capsule_int.js = LO SPEC: fixed 1/32px, tratte ≤128px, t/D/u
  arrotondati esatti, LUT smoothstep 1025×32768; js/wgpu_capsule.js kernel).
  Pagina test: webgpu_test.html (due suite, motore==spec==WGSL 0-diff).
- **Capsule v2 ATTERRATA nel motore vero** in lockstep: raster.js
  (_capsule/_capsuleTex coi record quantizzati + bound di riga intero),
  wasm lib.rs (export NUOVI capsule_int/capsule_tex_int, LUT nel heap via
  set_falloff_lut scritta da WasmHeap), worker (gate aggiornato), wasm/
  test.mjs (riferimento = modulo spec). npm test TUTTO verde. Confronto
  visivo capsule_compare.html: maxΔ 33 solo banda AA del duro, invisibile.
  Perf CPU: 0.97-1.03× sul pennello default, 1.2× sui giganti (che migrano
  su GPU comunque). ⚠ COLLAB A VERSIONI MISTE col deploy vecchio (v1
  float) DIVERGE sulle capsule: deployare prima di sessioni miste.
- **Fase 1 — stroke buffer WebGPU** (js/wgpu_stroke.js, WgpuStrokeBridge):
  il tratto vivo rasterizza su GPU col contratto del raster worker (main =
  autorità struttura, store specchio CPU dove atterrano i readback via
  mapAsync, sent/tickDrained/inkRing per l'overlay). Kernel unificato
  dab+capsule in-thread (ordine/tie preservati). Arena slot 256KB growable,
  atlas maschere, uniform per chunk a offset dinamici (bind group layout
  ESPLICITO: 'auto' non abilita i dynamic offsets). Endpass = replay INTERO
  da zero (chunk scoperti azzerati a fine atterraggio). Flush sincrono
  impossibile su GPU → _runQueueSync ributta il tratto sul CPU (stessi
  byte). Gate per-tratto: gpu→worker→main; !aqua !tex !selezione; ?gpu=off.
  Commit: heap=null anche per 'gpu' in _beginCommit (i chunk CPU hanno
  ptr=0: col heap wasm si compositavano ZERI dall'indirizzo 0 — il bug
  "il tratto scompare al pen-up", FIXATO e dimostrato con la firma dei
  chunk: commit/undo/redo esatti).
  Fix v1 anti-scatti: buffer persistenti + pool staging {busy} + readback a
  BANDA DI RIGHE con dirty rect per chunk e regola FULL-READ post-endpass
  (slot fresco su chunk CPU preesistente → prima rilettura intera) +
  markDirty preciso. Riga 'GPU tratto' nel pannello perf (backlog, land ms,
  MB riletti; summary gpuFrames/avgGpuBacklog/maxGpuLandMs/avgFpsGpu).
- **Fase 2.1 — present WebGPU v0** (js/renderer_wgpu.js, DIETRO FLAG
  ?renderer=wgpu o localStorage 'fable-paint.renderer'='wgpu' — la home
  RISCRIVE la query URL): bottom renderer WebGPU col contratto di
  renderer_2d (uploadDirty specchia il GL: store.dirty + rect parziale via
  writeTexture, markDirty NON setta texDirty), quad per chunk, blend OVER
  premultiplied, pass combinato paint/gomma nel fragment (= commitChunk).
  Init: WgpuRenderer.preinit() awaitata in fondo a main.js PRIMA di new App.
  v0 NON copre (warn once): clip group figli, blend mode≠normal, sessioni
  Trasforma/Effetti, quad testo/svg, proxy zoom-out (null sotto wgpu).
  VERIFICATO live: tratto gpu presentato da WebGPU, hasGl=false.

- **Fase 2.2 — readback morto nel loop (FATTA 03/07 sera)**: device UNICO
  per l'app (js/wgpu_device.js, singleton + notifiche lost; renderer e
  ponte lo condividono), modalità DIRECT del ponte (bridge.direct, accesa
  in main.js quando il present è WebGPU): tick = solo dispatch, il renderer
  copia gli slot dell'arena nelle texture dei chunk vivi con
  copyBufferToTexture PRIMA del pass (stessa coda → il present mostra il
  dispatch dello STESSO frame, zero ritardo strutturale), il readback CPU
  vive SOLO al commit (requestLand: una lettura intera degli slot quando la
  coda è drenata e il commit aspetta; touched calcolato lì, NIENTE
  markDirty — le texture mostrano già quei byte). Overlay: copre fino a
  presentDrained (contatore al submit) via overlayDrained; backlog perf
  idem. VERIFICATO nel preview: pipeline vera pointer→engine→GPU→commit
  BIT-EXACT col Rasterizer CPU sugli stessi descrittori (0 byte diff, 8
  chunk, firme identiche), 0 byte riletti durante il live (era ~2MB/tratto
  già su questo tratto corto), un solo land al commit (8×256KB, ~7ms),
  undo/redo round-trip esatto (ATTENZIONE: capture asincrona su worker — un
  undo() subito dopo il commit trova lo stack ancora vuoto, aspettare).
  FIX della review nello stesso giro: atlas maschere ora cresce CON COPIA
  (la v1 azzerava mappa+buffer: i record già in coda e le maschere dei tick
  precedenti puntavano a offset invalidati → dab corrotti oltre 4MB di
  maschere per tratto, es. pennelloni con angle jitter); device LOST gestito
  (ponte→usable=false e l'App ributta il tratto sul CPU via _gpuReplayOnCpu
  — prima il commit aspettava per sempre; renderer→warn, senza recovery
  v0); ?renderer=wgpu ora SI PERSISTE in localStorage (?renderer=gl
  spegne) — sul telefono non c'è console e la home riscrive la query.

- **Parità renderer, prima tranche (FATTA 03/07 sera, tutto verificato al
  pixel nel preview)**: (a) MIPMAP in minificazione — pipeline blit WGSL
  (media 2×2 per livello, = generateMipmap GL), texture chunk con catena
  completa (9 livelli, +RENDER_ATTACHMENT), rigenerata pigramente per i
  chunk cambiati quando zoom<1, sampler trilinear; i chunk vivi in direct
  rigenerano dopo la copia arena; view cache _viewsOf (full+per livello).
  (b) QUAD TESTO/SVG — quadFor dalla cache condivisa, upload
  copyExternalImageToTexture premultiplied (dest vuole COPY_DST+
  RENDER_ATTACHMENT), mip NPOT proprie generate all'upload, scissor al
  board (setScissorRect per draw, ripristino), LINEAR sempre; sweep delle
  cache patchata per destroy() delle GPUTexture. (c) GRUPPI DI RITAGLIO —
  il frame diventa SEGMENTI di render pass (canvas load/clear ↔ gruppo):
  base+figli in texture canvas-size (figli con blend dst-alpha/
  one-minus-src-alpha = colore sostituito, forma della base), blit 1:1
  NEAREST alla posizione in pila, col modo della base applicato al blit.
  (d) BLEND MODE — screen/add come pipeline fixed-function esatte sul
  premultiplied; i 6 modi shader (multiply/overlay/softlight/darken/
  lighten/difference) con copyTextureToTexture canvas→backdrop (solo bbox
  dei chunk visibili) e formula W3C in fsBlend (textureLoad, blending
  SPENTO, srcPx riusa i mode 0-3: tratto/gomma live inclusi gratis).
  Verifica: testo a zoom 1 e 0.3 (pixel presenti), clip group a 3 punti
  campione (dentro=colore figlio, sbordo=trasparente, base=rossa), gli 8
  modi con valori attesi ESATTI (multiply 78/59/39, overlay 188/118/78,
  softlight 191/111/86, screen 222/191/211, add clampato…). TRAPPOLA
  PAGATA: GPUTextureUsage ≠ GPUBufferUsage — COPY_SRC texture = 0x1 (0x4 è
  TEXTURE_BINDING): il configure del canvas col flag sbagliato invalidava
  il command buffer INTERO (canvas nero) solo nei frame col backdrop.

- **Parità renderer, seconda tranche (FATTA 03/07 notte, verificata al
  pixel)**: (a) SESSIONI Sposta/Trasforma ed Effetti — i BAKE sono quelli
  del renderer 2D riusati per composizione (istanza interna
  Canvas2DRenderer: _ensureTransformCanvas/_ensureWarpCanvas/
  _ensurePerspCanvas/_ensurePuppetCanvas/_ensureFxCanvas con le loro firme
  di cache); l'affine è UN quad col vertex generalizzato p0+c.x·ex+c.y·ey
  (U.rect→p0/ex/ey: i rect sono il caso assi allineati), warp/persp/
  marionetta = bake CPU a triangoli disegnato come rect mondo (identico
  all'anteprima 2D; il commit resta esatto via warpStore), effetti = quad
  del bake CPU; scissor al clip di sessione, texture per slot tf/warp/fx
  ricaricate solo a firma nuova, tutto liberato a sessione chiusa. smudge/
  liquify GPU non partono sotto wgpu (gate su smudgeBegin del renderer) →
  warn se mai arrivassero. Verifica: identità = pixel al posto originale,
  traslazione+scala 0.5 = pixel alla nuova posizione e vecchia vuota,
  gauss sigma 10 = centro pieno e bordo interno ad alpha 163. (b)
  SCREEN-CACHE — stessa chiave e gating del GL (camera+pila+store.ver+
  serial dei quad; mai con tratti/sessioni/bake); hit = UNA
  copyTextureToTexture cache→canvas (usage canvas +COPY_DST), cattura in
  coda all'encoder del frame. Verificata: miss→HIT pixel identici→miss al
  cambio contenuto→HIT. screenCacheHitThisFrame esposto per il pannello.

- **Perf present + PROXY ZOOM-OUT WEBGPU (FATTI 04/07 pomeriggio)**:
  (a) CACHE DEI BIND GROUP nel present — prima UN createBindGroup per draw
  per frame (5120 col profilo ultra): ora riusati tra draw e frame (chiave
  texture-livello → tratto×sampler, _bgEpoch invalida quando _uniBuf cresce
  o _bdTex rinasce — i bind group CATTURANO quelle risorse alla creazione),
  mirror CPU degli uniform riusato, bind del blit mip cacheati per
  texture+livello. (b) MIP A LIVELLI LIMITATI durante il tratto: a zoom<1 i
  chunk vivi rigenerano solo ceil(log2(1/s))+2 livelli invece della catena
  intera (8 blit/chunk/frame); vale per gpu-direct E fallback worker (= il
  pennello texture misurato su Android); la catena piena si rifà da sola al
  commit (upload → mips=false). (c) PROXY DEI BOARD WEBGPU
  (js/board_proxy_wgpu.js, WgpuBoardProxyCache): stessa macchina a stati
  del proxy GL (board_proxy.js È lo spec — contentKey/budget/hasSvgLayer
  ora esportati), build in render pass WebGPU nella texture 1024² (catena
  mip 11 livelli) con le pipeline di parità + varianti rgba8 di
  screen/add/fsBlend, UN encoder per tick sottomesso prima del present
  (stessa coda). main.js sceglie la cache dal renderer, startStroke gate
  esteso, quad disegnati per primi nel primo segmento con sampler
  trilinear. VERIFICATO nel preview (6 board × 4 layer con testo):
  liveVisibleChunks 288→48 (solo il board attivo), texCount 288→48, 5
  proxy pronti, warm-up al click, TRATTO GPU-DIRECT OK con proxy attivi,
  rebuild su cambio blend mode di un board coperto con serial nuovo nella
  chiave screen-cache (senza, presenterebbe la cache stantia per sempre),
  0 errori di validazione. TRAPPOLE PAGATE QUI: il build campiona i chunk
  a 0.5 con sampler a LOD BLOCCATO (lodMaxClamp:0 = bilinear sul livello 0,
  media 2×2 esatta — il default con mipmapFilter nearest salta al livello 1
  stantio); le texture transitorie del build si distruggono DOPO il submit
  (destroy prima = command buffer invalidato); UN SOLO testo per tick
  (copyExternalImageToTexture è op di coda: esegue PRIMA dei pass, due
  upload si sovrascriverebbero).

## MISURE DAL CAMPO 04/07 (Field/Auto)

- Aggiunto harness nel pannello perf: **Field** manuale e **Auto** sintetico
  con report JSON (`fable-paint-field-test`). Auto v5 distingue i profili:
  desktop/Android = `ultra-16c-1p2g-v1` (16 canvas, 5 layer pieni/canvas,
  5120 chunk, ~1.25 GiB pixel live); iOS = `ios-limit-12c-0p75g-v1`
  (12 canvas, 4 layer pieni/canvas, ~0.75 GiB pixel live) perché il profilo
  1.25 GiB chiude/crasha la tab su iPhone prima del report.
- **Desktop Chrome + Cloudflare HTTPS + WebGPU/SAB ok**, ultra 16c/1.25GiB:
  pennello texture/taper 0/0 passa in worker (texture esclude gpuStroke), non
  in GPU; stroke non è il collo principale. Il collasso è pan/zoom/overview:
  `liveVisibleChunks=5120`, `presentMs/planesMs` fino a ~1.17s,
  slow bucket `live-chunk-render`. Memoria: ~1.27GiB WASM/pixel e ~1.31GiB
  stima GPU.
- **Android Chrome + Cloudflare HTTPS + WebGPU/SAB ok**, ultra 16c/1.25GiB:
  completa ma inutilizzabile: stroke texture a fit già ~30fps con p95 ~43ms
  e max ~150ms; pan/zoom ha frame multi-secondo (fino a ~5-6s). Anche qui il
  problema dominante è `planes/present` con centinaia/migliaia di chunk vivi,
  non il raster del pennello (`rasterMs` medio basso).
- **iPhone/Safari**: via HTTP LAN il report era WebGL2 (`secureContext=false`,
  `webgpu=false`), quindi non valido per WebGPU. Via HTTPS Cloudflare il
  profilo 16c/1.25GiB crasha direttamente; usare il profilo iOS v5 per
  trovare il limite reale senza perdere il report.
- Conclusione: obiettivo "0 lag" NON raggiunto sui progetti grandi. Il
  collo di bottiglia urgente non è solo il pennello: sotto WebGPU manca un
  proxy/flatten/LOD per non presentare migliaia di texture chunk vive.

## RITEST 04/07 SERA + SCHEDULING MOBILE DEL PROXY

- Ritest campo dopo proxy+cache+mip: iPhone profilo iOS PASSA; Android
  ultra senza più frame multi-secondo e stroke texture buono, MA
  pan/zoom/idle ancora lenti per PROXY-BUILD/WARM-UP (upload 256KB/chunk ×
  48 per tick), non più per live-chunk-render.
- Fix (FATTI 04/07 sera, verificati nel preview): (a) BUDGET ADATTIVO del
  tick proxy (moltiplicativo 0.85/1.15 sul TICK_TARGET_MS=3, scala
  0.12..1 su BUILD_BUDGET e WARM_BUDGET, floor 8/6 — adattato SOLO sui
  tick che hanno lavorato; buildScale esposto in stats); (b) UPLOAD
  PESATI: un chunk da ricaricare costa 4 (writeTexture 256KB È il costo),
  uno in VRAM 1; (c) PAUSA BUILD DURANTE PAN/ZOOM (main.js: firma camera
  x/y/zoom, 150ms di coda dopo l'ultimo movimento → allowBuild=false; il
  warm-up del board attivo continua — blocca il disegno, non il gesto).
  Verifica: rebuild ferma con camera in moto continuo (serial fermo,
  loading segnalato), riparte e completa a camera ferma, 0 errori.

## REGOLA PRODOTTO 04/07 NOTTE: MAI CANVAS BIANCHI (proxy-live) + TIER

- Ritest dopo scheduling: Android heavy 10c/0.64GiB → preload 9/9 ~10.3s,
  p95 stroke 5.87ms, pan/zoom 3.7ms, idle pulito; desktop ultra 16c →
  15/15 ~9.1s, p95 1.83/1.84ms. MA il covering immediato mostrava board
  bianchi finché il proxy non era pronto → REGOLA PRODOTTO: l'ottimizzazione
  deve essere invisibile, mai board bianchi o spariti.
- **Proxy-live (committato in d40579d, entrambe le varianti GL+wgpu)**: un
  board si copre SOLO quando il suo proxy è ready E allineato alla
  contentKey; se il contenuto di un board coperto cambia si SCOPRE subito
  (torna live, serial bump per la screen-cache) e si ricopre a rebuild
  finita. Budget build col floor a TEXT_COST (un tick adattivo sotto 16
  bloccava per sempre i board con testo). _forceProxyBuild per il preload
  dell'harness (ignora pausa pan/zoom e boost).
- ⚠ SPIGOLO NOTO da misurare in collab: un'edit remota su un board COPERTO
  lo scopre → il present ricarica TUTTI i suoi chunk visibili in un frame
  (upload non budgetizzato, ~48MB su un 2048² pieno). Con edit continue
  (utente remoto che disegna lì) si può oscillare copri/scopri. Se morde:
  transizione via warm a budget dietro il quad stantio, o isteresi sul
  ricoprire.
- **TIER DI DISPOSITIVO GENERALIZZATO (04/07 notte, js/device_tier.js)**:
  niente branch rigidi per OS nell'harness — deviceCaps() classifica
  high/mid/low da memoria (comanda), core (correggono), pointer coarse
  (high mobile → mid: LMK/jetsam è un vincolo fisico, vale per qualunque
  marca), DPR e refresh REALE misurato con rAF a inizio Auto (mediana dei
  delta — nel report: 16.7ms = 1 frame a 60Hz ma 2 a 120). Taglie ancorate
  ai profili validati: high=16c/1.25GiB, mid=10c/0.64GiB, low=8c/0.38GiB;
  tetto iOS esplicito (iphone 6c/0.28, ipad 8c/0.38) anche sotto
  ?stress=ultra (che forza high altrove). Profili v3: tier-high/-mid/-low/
  -ios-*; nel report anche tier, tierUnclamped e caps{memGB,cores,dpr,
  mobile,displayHz}. Verificato nel preview: mem 4/6/8GB → low/mid/high,
  8GB+coarse → mid con unclamped high, pannello → tier-high-16c-1p2g-v3.

## RUNTIME TIER INTEGRATION (FATTA 04/07 notte)

- Le euristiche di PRESTAZIONE di main.js non sono più "è Android" ma
  perf-lite = tier mid/low da device_tier.js (App.caps/perfTier/perfLite):
  DPR cap (LITE_DPR_MAX=2 — ora vale anche su iPhone e desktop deboli,
  prima solo Android; iPhone a dpr 2 invece di 3 = backbuffer -55%, da
  giudicare a occhio), UI sync a intervalli (UI_SYNC_IDLE/ACTIVE_MS),
  interaction boost (_markInteraction via onActivity dell'input → pausa
  build proxy + UI sync fitto per 900ms), classe CSS body.perf-lite
  (badge "perf <tier>" + niente #cursor custom), report perfLite (era
  androidLite). La PIATTAFORMA resta solo nei workaround per bug:
  ANDROID_FORCE_CANVAS2D (kill-switch driver), niente desynchronized su
  Chrome Android (ink overlay), tetto iOS dell'harness.
- Override manuale del tier per test/supporto: localStorage
  'fable-paint.tier' = high|mid|low (deviceCaps lo onora, caps.forced).
- Verificato nel preview: desktop=high senza lite/badge; forzato mid →
  classe+badge "perf mid", tratto ok, UI sync schedulato, boost armato
  dall'attività input reale; 0 errori console; main.js ai 12 tsc noti.

## PROSSIMI PASSI (in ordine)

1. **Giro Auto v3 sul campo coi profili tier** (nomi nuovi = baseline
   nuove): confermare che i numeri del 04/07 sera reggono e che il tier
   classifica giusto sui tuoi device (guardare tier/tierUnclamped/caps nel
   report; sul telefono si può forzare con localStorage fable-paint.tier).
   Giudicare A OCCHIO l'iPhone a dpr 2. Poi giudizio visivo complessivo e
   via il flag ?renderer=wgpu.
2. **Collab su board coperti**: misurare lo spigolo scopri/ricopri (vedi
   sopra) prima di dichiarare il proxy finito.
2. **Tier memoria/dispositivo** per l'harness: cap del profilo generato su
   iOS/mobile (report targetPixelBytes/estimatedPaintBytes già esposti).
3. **Pennello texture su GPU** (P1, dopo che il present regge): il gate del
   ponte esclude snap.tex — lo spec bit-exact esiste già (capsule_tex_int
   JS+wasm), va portato in WGSL con l'atlas per hash. Poi selezione
   (maschera come texture read-only); aqua per ULTIMO (campiona il
   documento sotto il tratto, che vive sul main: divergenza facile).
4. **Fase 2.3 — layer GPU-residenti**: commit come compute sul device
   (texture di layer possedute dalla GPU), undo 2-tier (riferimento: editor
   cbos), export/fill/selezioni via mapAsync. Poi sfumino/liquify sullo
   stesso stato (fase 3). Qui il flatten del board diventa quasi gratis.

## NOTE DELLA REVIEW 03/07 (hardening, non urgenti)

- Budget interi capsule v2: sicuri fino a r≈1300px (qx²+qy² < 2^32; ulim²
  regge fino a r≈2047px; DR·65536 < 2^31 chiede Δr ≤ 1023px per tratta).
  SIZE_MAX=2000 → r=1000: ~30% di margine. Se mai una dinamica/jitter può
  superare r~1300, JS (f64 esatto) DIVERGE da wasm/WGSL (wrap): clampare il
  raggio in capsuleIntParams o alzare lo split.
- ~~renderer_wgpu: createBindGroup per draw per frame + ArrayBuffer uniform
  ricreato~~ — FATTO 04/07 (cache con epoch, vedi sopra).
- Il path sendEntries→record del ponte non ha test permanente (kernel e
  spec sì): la verifica è il confronto firme nel preview.

## TRAPPOLE PAGATE (non ripagarle)

- MAI backtick nei commenti WGSL dentro template literal JS (chiude la
  stringa: l'export diventa boolean, lo shader compila "undefined").
- writeBuffer: multipli di 4 byte (LUT 2050→pad, maschere→coda paddata).
- Bind group con dynamic offsets: layout ESPLICITO obbligatorio.
- Canvas WebGPU (e GL): leggibile SOLO nello stesso task del frame; lo
  screenshot del preview porta il tab in primo piano e APRE LA HOME.
- Il preview pompa rAF via MessageChannel (visibilityState forzato), i
  console log sono duplicati ~6× e quelli dei worker NON si vedono.
- serve.mjs ignora la porta del preview tool: launch.json passa argv 8002.
- L'autosave ripristina i tratti dei run precedenti: verifiche a pixel su
  righe fisse ingannano — usare firme dei chunk (window.__app TEMPORANEO).
- tsc: rumore preesistente noto (ai_fill/collab/fill_ui/main 12/perf_debug/
  planes 3) — confrontare i CONTEGGI con HEAD, non azzerare.

## COME SI PROVA

- Deploy/produzione: branch codex/raster-worker-vercel-headers (Vercel
  builda con Vite; i sorgenti raw /js/*.js in prod danno 404, guardare
  assets/app-*.js). NIENTE commit senza ok dell'utente.
- Locale: npx serve o `node serve.mjs 8002`; telefoni:
  https://192.168.0.16:8443 (proxy HTTPS nello scratchpad della sessione
  precedente — se spento, rigenerare: cert New-SelfSignedCertificate con
  SAN {text}DNS=localhost&IPAddress=... + proxy node su 8443→8002).
- Flag: ?renderer=wgpu / localStorage; ?gpu=off (ponte tratto); ?engine=js.
- Test: npm test (wasm+blur+puppet+stroke+worker), webgpu_test.html,
  capsule_compare.html.
