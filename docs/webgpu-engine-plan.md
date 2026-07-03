# Motore pennello su WebGPU — audit di partenza e piano (03/07/2026)

Obiettivo dichiarato dall'utente: risultato "assurdo" — tratto real-time a
qualunque size/texture, 120Hz, anche su telefoni economici. Va bene cambiare
l'architettura dell'app. Questo doc è l'handoff per la sessione che implementa.

## Stato attuale (già misurato sul campo, non rifare l'audit)

- Branch di DEPLOY: `codex/raster-worker-vercel-headers` (produzione
  fable-paint.vercel.app, header COOP/COEP attivi, PR #1 draft).
  Contiene: raster worker+SAB (tratti locali su Web Worker, bit-exact,
  endpass asincrono con swap di slot, commit via scratch wasm), stack
  sfumino ottimizzato PORTATO (blur GPU+wasm+catch-up, test:blur in npm test),
  pannello perf con riga Worker e bottone Sum.
- ALTRO branch `codex/space-node-resize-cache`: altra sessione attiva —
  liquify GPU, multi-selezione (TransformFrameSet), suo port del worker.
  NON toccare senza coordinarsi.
- Misure (Sum) su Android 150€/Mali-G57 e iPhone 15 Pro Max: paint 60-72fps
  col worker, freeze pen-up eliminato (≤50ms), commit 28ms. Collo residuo:
  backlog del worker (~600 avg nei picchi) = la scia insegue il dito coi
  pennelli giganti — il limite è il singolo core CPU.

## Perché WebGPU risolve e cosa NON si deve perdere

1. **Determinismo = matematica intera.** Tutto il motore attuale è integer
   8-bit (div255 `((x+128)+((x+128)>>8))>>8`, LUT, tie-break wash `>=` per
   dab / `>` per capsule, falloff smoothstep con banda AA min 1px, bucket
   raggio 9% — vedi brush.js/raster.js/wasm lib.rs, in lockstep col test
   differenziale). In WGSL con op INTERE il risultato è bit-exact tra
   dispositivi → il replay deterministico della collab SOPRAVVIVE. Niente
   float nel path dei pixel. Questo è il vincolo n.1: ogni kernel WGSL va
   sigillato da un test differenziale contro il motore JS (riferimento),
   stile wasm/test.mjs e js/raster_worker_test.mjs.
2. **La pipeline dati è già giusta**: documento = chunk sparsi 256×256 RGBA
   premultiplied (store.js), tratto = descrittori Float32 stride 10
   (T_DAB/T_SEG, stroke.js) con specchio/pattern già espansi nella DabQueue.
   I descrittori diventano l'input dei dispatch compute; i chunk diventano
   texture/storage buffer GPU-residenti per il TRATTO (fase 1) e poi per i
   layer (fase 2).
3. **Punti di sincronizzazione noti** (già mappati per il worker, stessa
   semantica): endpass della punta (engine.endPassRect/replay, clip per
   chunk), commit sul layer (commitChunk op255/eraser), selezione (mask
   post-run), snap draw-and-hold (ributta tutto), collab _applyStroke
   (sincrono, può restare su un path CPU), undo tile-diff al commit.

## Architettura target (fase per fase, ogni fase shippabile)

- **Fase 0 — ink overlay + predizione** (indipendente da WebGPU, fa da
  subito la differenza percepita): l'ultimo segmento disegnato come
  geometria provvisoria con lo spessore del pennello + 1-2 frame di
  predizione; il raster vero lo sostituisce. Tocca solo il present.
- **Fase 1 — stroke buffer su WebGPU**: i dab/capsule del tratto VIVO
  diventano dispatch compute su storage texture (interi, stessa matematica);
  il documento resta CPU; commit = copyBufferToBuffer + mapAsync (mai
  readback sincrono). Gate: `navigator.gpu` presente → WebGPU, altrimenti
  worker attuale (che resta il fallback migliore possibile). Stessa
  struttura per-tratto già usata dal bridge (gate per-stroke, aqua/collab
  su CPU).
- **Fase 2 — layer GPU-residenti**: compositing della pila direttamente da
  storage/texture GPU (via i texSubImage2D per frame), undo a 2 tier
  (riferimento: editor cbos Desktop — history GPU 2-tier, resource manager
  con owner types, governor upload — vedi memoria editor-cbos-riferimento).
  Salvataggio/export/fill/selezioni leggono via mapAsync.
- **Fase 3 — sfumino/liquify sullo stesso stato GPU** (oggi hanno path GL
  separati con readback al commit: convergono senza copy-out).

## Trappole note da non ripagare

- WGSL: niente f32 nel path pixel; attenti a workgroup size vs occupancy
  Mali/Apple; storage texture R32Uint per RGBA8 packed è il pattern.
- Safari 26 ha WebGPU ma con limiti device: feature-detect a runtime, MAI
  UA sniffing; il fallback worker è già maturo.
- La collab replay (`collab._applyStroke`) è sincrona: o resta CPU (ok, è
  in idle) o serve await esplicito — NON bloccare il main con onSubmittedWorkDone.
- Il preview tool duplica i console log ~6× e NON cattura i log dei worker.
- tsc del branch deploy ha rumore preesistente (ai_fill/collab/fill_ui/
  renderer_gl TS7053): non è regressione.
- Test nel preview: visibilityState va forzato + rAF pompato via
  MessageChannel; tratti sintetici SINCRONI (setInterval perde i move).

## Primi passi per la nuova sessione

1. Leggere questo doc + docs/raster-worker-design.md + memoria progetto.
2. Fase 0 (ink overlay) per il quick win percepito.
3. Prototipo Fase 1: UN kernel WGSL (dab wash tondo) + test differenziale
   Node (WebGPU in Node via wgpu? no: test nel browser/preview con harness
   dedicato, o dawn-node se disponibile) contro raster.js — il contratto
   bit-exact PRIMA di tutto il resto.
4. Budget/architettura submission: un command buffer per frame, dispatch
   per dab batchati, ring di staging buffer per il commit.
