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

## PROSSIMI PASSI (in ordine)

1. **Parità di feature del renderer** per togliere il flag: quad testo/svg
   (copyExternalImageToTexture dai canvas cotti), blend modes (screen/add
   fixed-function come GL, gli altri col backdrop per bbox), clip group
   (base+figli in texture di gruppo), sessioni Trasforma/Effetti (quad da
   canvas), proxy zoom-out o equivalente, mip/downscale per zoom<1
   (v0 usa solo linear: minificazione sgranata).
2. **Misure dal campo**: pannello perf (riga GPU tratto) su desktop a mano
   e telefoni via HTTPS LAN (proxy scratchpad su 8443 → 8002, cert 30gg;
   navigator.gpu/SAB SOLO in contesto sicuro; sul telefono aprire UNA volta
   ?renderer=wgpu — da lì il flag persiste). I numeri del preview in
   background sono gonfiati dalla pompa (land max 199ms non è reale).
3. **Fase 2.3 — layer GPU-residenti**: commit come compute sul device
   (texture di layer possedute dalla GPU), undo 2-tier (riferimento: editor
   cbos), export/fill/selezioni via mapAsync. Poi sfumino/liquify sullo
   stesso stato (fase 3).

## NOTE DELLA REVIEW 03/07 (hardening, non urgenti)

- Budget interi capsule v2: sicuri fino a r≈1300px (qx²+qy² < 2^32; ulim²
  regge fino a r≈2047px; DR·65536 < 2^31 chiede Δr ≤ 1023px per tratta).
  SIZE_MAX=2000 → r=1000: ~30% di margine. Se mai una dinamica/jitter può
  superare r~1300, JS (f64 esatto) DIVERGE da wasm/WGSL (wrap): clampare il
  raggio in capsuleIntParams o alzare lo split.
- renderer_wgpu: createBindGroup per draw per frame + ArrayBuffer uniform
  ricreato — churn da sistemare con la parità feature (cache per texture).
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
