// PROXY DEI BOARD, variante WebGPU — stessa macchina a stati della
// BoardProxyCache GL (board_proxy.js: contentKey, covering/warm/loading,
// budget e transizioni IDENTICI — quel file è lo spec del comportamento),
// con la build fatta in render pass WebGPU dentro la texture 1024² del
// proxy, riusando le pipeline di parità del renderer: over premultiplied,
// figli dei gruppi con DST_ALPHA, screen/add fixed-function, modi shader
// con backdrop copiato, testo via canvas CPU + copyExternalImageToTexture.
// Ogni update() produce AL PIÙ un command encoder (mip del warm-up + pass
// della build) sottomesso prima del present dello stesso frame: stessa
// coda del renderer, ordine garantito.
//
// Trappole pagate qui:
// - i chunk si campionano a scala 0.5 con un sampler a LOD BLOCCATO su 0
//   (lodMaxClamp: 0): bilinear sul livello 0 = media 2×2 esatta, come il
//   MIN_FILTER LINEAR senza mip del build GL. Il sampler di default del
//   renderer ha mipmapFilter 'nearest' e a scala 0.5 salterebbe al livello
//   1, che per i chunk appena caricati è stantio.
// - le texture transitorie del build (chunk di board coperti) si liberano
//   DOPO il submit: destroy() prima invaliderebbe l'intero command buffer.
// - un solo livello testo per tick: copyExternalImageToTexture è un'op di
//   coda e esegue PRIMA dei pass dell'encoder — due upload nello stesso
//   tick si sovrascriverebbero prima del primo draw.

import { CHUNK } from './store.js';
import { drawTextDocument, ensureFont, touchText } from './text_layer.js';
import {
  PROXY_SIZE, BUILD_BUDGET, WARM_BUDGET, TEXT_COST, contentKey, hasSvgLayer,
} from './board_proxy.js';
import { SHADER_MODE_IDX } from './renderer_wgpu.js';

/** @typedef {import('./renderer_wgpu.js').WgpuRenderer} WgpuRenderer */
/** @typedef {import('./planes.js').Planes} Planes */
/** @typedef {import('./boards.js').BoardManager} BoardManager */
/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./board_proxy.js').ProxyQuad} ProxyQuad */
/** @typedef {import('./board_proxy.js').ProxyFrame} ProxyFrame */

const PROXY_MIPS = 11;   // 1024 -> 1
const UNI_SLOTS = 64;    // fette uniform da 256B per tick (draw ≤ budget+1)
// Il tick (warm + build) deve stare sotto questo tempo anche su mobile: sul
// profilo ultra Android era il build stesso — upload da 256KB/chunk più i
// pass — a rubare i frame di pan/zoom/idle, non il present dei chunk vivi.
const TICK_TARGET_MS = 3;
// un chunk da RICARICARE (writeTexture 256KB) pesa come UPLOAD_COST draw di
// una texture già in VRAM
const UPLOAD_COST = 3;

/**
 * @typedef {Object} Entry
 * @property {any} tex GPUTexture 1024² con catena mip
 * @property {boolean} ready almeno una build completata (disegnabile)
 * @property {number} key contenuto dell'ultima build completata
 * @property {boolean} covering i layer del board sono nascosti dietro il quad
 * @property {number} warmDone chunk già ricaricati nel warm-up corrente
 */

export class WgpuBoardProxyCache {
  constructor() {
    /** @type {Map<number, Entry>} boardId -> proxy */
    this._map = new Map();
    /** @type {any} device dell'ultima update (cambiato = risorse da rifare) */
    this._dev = null;
    /** @type {{boardId: number, key: number, li: number, ci: number, chunks: Chunk[]|null, grpEnd: number, grpBase: number}|null} */
    this._build = null;
    /** @type {any} scratch 1024² dei gruppi di ritaglio */
    this._grpTex = null;
    /** @type {any} backdrop 1024² dei modi shader */
    this._bdTex = null;
    /** @type {any} sampler a LOD 0: bilinear sul livello 0 (media 2×2 esatta) */
    this._samp = null;
    /** @type {any} buffer uniform del build (fette da 256B, dedicato) */
    this._uniBuf = null;
    this._uniArr = new ArrayBuffer(UNI_SLOTS * 256);
    this._uniF32 = new Float32Array(this._uniArr);
    this._uniU32 = new Uint32Array(this._uniArr);
    /** @type {any} encoder pigro del tick corrente (warm + build) */
    this._enc = null;
    /** @type {Chunk[]} texture transitorie della build, liberate POST-submit */
    this._transient = [];
    // frame correnti, riusati (zero allocazioni a regime)
    /** @type {ProxyFrame} */
    this._out = { quads: [], skip: new Set(), loading: new Map(), serial: 0 };
    /** @type {ProxyQuad[]} pool dei quad */
    this._qp = [];
    this._seen = new Set();
    this._warmLeft = 0;
    this._wantMips = false;
    this._serial = 0;   // build completate: entra nella chiave screen-cache
    // budget adattivo moltiplicativo (stesso pattern del raster): scala
    // 0.12..1 su BUILD_BUDGET e WARM_BUDGET, guidata dai ms misurati dei
    // tick che hanno lavorato davvero
    this._budgetScale = 1;
    this._work = 0;     // unità di lavoro del tick corrente (draw+upload)
    this._rectTmp = { x0: 0, y0: 0, x1: 0, y1: 0 };
    // raster del documento testo nel build: canvas scratch + texture riusati
    /** @type {HTMLCanvasElement|null} */
    this._txtCanvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this._txtCtx = null;
    /** @type {any} */
    this._txtTex = null;
  }

  // Da chiamare una volta a frame PRIMA del render dei piani (stesso
  // contratto della variante GL). Ritorna quad da disegnare e layer da
  // saltare; fa anche un passo di build/warm-up e sottomette il suo encoder.
  /**
   * @param {WgpuRenderer} renderer
   * @param {BoardManager} boards
   * @param {number} activeBoardId
   * @param {Camera} camera
   * @param {boolean} allowBuild false durante un tratto: tutta la banda al pennello
   * @param {Planes|null} [planes] per svuotare le cache 2D dei board coperti
   * @returns {ProxyFrame}
   */
  update(renderer, boards, activeBoardId, camera, allowBuild, planes = null) {
    const t0 = performance.now();
    this._work = 0;
    const out = this._out;
    out.quads.length = 0;
    out.skip.clear();
    out.loading.clear();
    out.serial = this._serial;
    if (!renderer.ok || !renderer.device) return out;
    const dev = renderer.device;
    if (dev !== this._dev) {
      // device nuovo (primo giro o perso/ricreato): via tutto
      for (const e of this._map.values()) { if (e.tex) e.tex.destroy(); }
      this._map.clear();
      this._build = null;
      this._grpTex = null;
      this._bdTex = null;
      this._txtTex = null;
      this._uniBuf = null;
      this._samp = dev.createSampler({
        magFilter: 'linear', minFilter: 'linear', lodMaxClamp: 0,
      });
      this._dev = dev;
    }

    this._warmLeft = Math.max(6, Math.round(WARM_BUDGET * this._budgetScale));
    this._wantMips = camera.zoom < 1;
    this._seen.clear();
    /** @type {{board: Board, key: number}|null} */
    let visibleCandidate = null;
    /** @type {{board: Board, key: number}|null} */
    let fallbackCandidate = null;
    const vr = camera.visibleRect(this._rectTmp);
    /** @param {Board} b */
    const visible = (b) => b.x <= vr.x1 && b.y <= vr.y1 &&
      b.x + b.w >= vr.x0 && b.y + b.h >= vr.y0;

    // Il board ATTIVO per primo, col warm a precedenza (vedi variante GL:
    // è il "caricamento" dopo il click su un board coperto)
    const act = boards.byId(activeBoardId);
    const actE = act ? this._map.get(act.id) : undefined;
    if (act && actE && actE.covering) {
      if (hasSvgLayer(act)) {
        actE.covering = false;
      } else {
        const missing = this._warm(renderer, act, actE, camera);
        if (missing === 0) {
          actE.covering = false;
        } else {
          for (const l of act.mgr.layers) out.skip.add(l.id);
          if (actE.ready) this._pushQuad(out, act, actE);
          out.loading.set(act.id, actE.warmDone / (actE.warmDone + missing));
        }
      }
    }

    for (const b of boards.boards) {
      this._seen.add(b.id);
      let e = this._map.get(b.id);
      if (b.id === activeBoardId) continue; // gestito sopra
      const eligible = b.mgr.layers.length > 0 && !hasSvgLayer(b);
      if (!eligible) {
        if (e) e.covering = false;
        continue;
      }
      const key = contentKey(b);
      if (!e) {
        e = { tex: this._newTex(dev), ready: false, key: 0, covering: false, warmDone: 0 };
        this._map.set(b.id, e);
      }
      if (!e.ready || e.key !== key) {
        const c = { board: b, key };
        if (visible(b) && visibleCandidate === null) visibleCandidate = c;
        else if (fallbackCandidate === null) fallbackCandidate = c;
      }
      if (!e.ready || e.key !== key) {
        // UX prima del risparmio: finché il proxy corrente non è pronto,
        // l'artboard resta live. Il quad bianco "loading" faceva sparire i
        // canvas su mobile e rendeva il documento invendibile.
        if (e.covering) {
          e.covering = false;
          e.warmDone = 0;
          this._serial++;
        }
        out.loading.set(b.id, 0);
        continue;
      }
      if (!e.covering) {
        e.covering = true;
        e.warmDone = 0;
        this._dropChunkTex(renderer, planes, b);
      }
      for (const l of b.mgr.layers) out.skip.add(l.id);
      this._pushQuad(out, b, e);
    }

    // board spariti (clearAll): via texture e entry
    for (const [id, e] of this._map) {
      if (!this._seen.has(id)) {
        if (e.tex) e.tex.destroy();
        this._map.delete(id);
        if (this._build && this._build.boardId === id) this._build = null;
      }
    }

    if (allowBuild) this._buildTick(renderer, boards, visibleCandidate || fallbackCandidate);

    // un solo submit per tick; le texture transitorie muoiono DOPO
    if (this._enc) {
      dev.queue.submit([this._enc.finish()]);
      this._enc = null;
    }
    if (this._transient.length > 0) {
      for (const c of this._transient) renderer.disposeChunkTex(c);
      this._transient.length = 0;
    }
    // adattamento del budget: solo sui tick che hanno lavorato (gli altri
    // non dicono niente sul costo); sforo → si stringe, margine → riallarga
    if (this._work > 0) {
      const ms = performance.now() - t0;
      if (ms > TICK_TARGET_MS) {
        this._budgetScale = Math.max(0.12, this._budgetScale * 0.85);
      } else if (ms < TICK_TARGET_MS * 0.5) {
        this._budgetScale = Math.min(1, this._budgetScale * 1.15);
      }
    }
    out.serial = this._serial;
    return out;
  }

  needsFrame() {
    return !!(this._build || this._out.loading.size > 0);
  }

  /**
   * Diagnostica (stessa forma della variante GL).
   * @param {BoardManager} boards
   * @param {Camera} camera
   * @param {number} activeBoardId
   */
  stats(boards, camera, activeBoardId) {
    const r = camera.visibleRect({ x0: 0, y0: 0, x1: 0, y1: 0 });
    let visibleBoards = 0, liveBoards = 0, proxiedBoards = 0;
    let liveLayers = 0, proxiedLayers = 0, readyProxies = 0, loadingProxies = 0;
    for (const b of boards.boards) {
      const inView = b.x <= r.x1 && b.y <= r.y1 &&
        b.x + b.w >= r.x0 && b.y + b.h >= r.y0;
      if (inView) visibleBoards++;
      const e = this._map.get(b.id);
      const proxied = b.id !== activeBoardId && e && e.covering;
      if (proxied) {
        proxiedLayers += b.mgr.layers.length;
        if (e.ready && e.key === contentKey(b)) readyProxies++;
        else loadingProxies++;
        if (inView) proxiedBoards++;
      } else {
        liveLayers += b.mgr.layers.length;
        if (inView) liveBoards++;
      }
    }
    let proxyTextures = 0;
    for (const e of this._map.values()) if (e.tex) proxyTextures++;
    return {
      visibleBoards,
      liveBoards,
      proxiedBoards,
      liveLayers,
      proxiedLayers,
      readyProxies,
      loadingProxies,
      proxyTextures,
      // la catena mip pesa ~1/3 in più del livello 0
      proxyBytes: Math.round(proxyTextures * PROXY_SIZE * PROXY_SIZE * 4 * 4 / 3),
      buildingBoardId: this._build ? this._build.boardId : 0,
      buildScale: +this._budgetScale.toFixed(3),
    };
  }

  // Il board attivo è ancora coperto dal quad (texture in ricarica)?
  // App.startStroke lo usa per non far partire tratti "alla cieca".
  /** @param {number} boardId */
  isLoading(boardId) {
    const e = this._map.get(boardId);
    return e !== undefined && e.covering;
  }

  /** @param {ProxyFrame} out @param {Board} b @param {Entry} e */
  _pushQuad(out, b, e) {
    const i = out.quads.length;
    let q = this._qp[i];
    if (!q) q = this._qp[i] = { x: 0, y: 0, w: 0, h: 0, tex: e.tex };
    q.x = b.x; q.y = b.y; q.w = b.w; q.h = b.h; q.tex = e.tex;
    out.quads.push(q);
  }

  /** @param {any} dev */
  _newTex(dev) {
    return dev.createTexture({
      size: [PROXY_SIZE, PROXY_SIZE], format: 'rgba8unorm',
      mipLevelCount: PROXY_MIPS,
      // COPY_SRC: backdrop dei modi shader (proxy -> _bdTex)
      usage: /* TEXTURE_BINDING|RENDER_ATTACHMENT|COPY_SRC */ 0x4 | 0x10 | 0x1,
    });
  }

  /** @param {WgpuRenderer} renderer */
  _encoder(renderer) {
    if (!this._enc) this._enc = renderer.device.createCommandEncoder();
    return this._enc;
  }

  // Il quad sta per coprire il board: le texture dei suoi chunk non servono
  // più (rinasceranno on-demand al rientro, a budget via _warm). Le cache
  // c2d dei piani 2D del pool le svuota il renderer che le possiede.
  /** @param {WgpuRenderer} renderer @param {Planes|null} planes @param {Board} b */
  _dropChunkTex(renderer, planes, b) {
    for (const l of b.mgr.layers) {
      if (!l.store) continue;
      const r2d = planes ? planes.poolRendererFor(l.id) : null;
      l.store.forEachChunkAll((/** @type {Chunk} */ c) => {
        renderer.disposeChunkTex(c);
        if (r2d) r2d.disposeChunkTex(c);
      });
    }
  }

  // Ricarica a budget le texture dei chunk visibili del board; ritorna
  // quanti ne mancano ancora (0 = si può scoprire). Sotto zoom 1 rigenera
  // anche le mip qui: il costo sta nei frame di caricamento, non in un
  // hitch unico al primo frame scoperto.
  /** @param {WgpuRenderer} renderer @param {Board} b @param {Entry} e @param {Camera} camera */
  _warm(renderer, b, e, camera) {
    const r = camera.visibleRect(this._rectTmp);
    const cx0 = Math.floor(Math.max(r.x0, b.x) / CHUNK);
    const cy0 = Math.floor(Math.max(r.y0, b.y) / CHUNK);
    const cx1 = Math.floor(Math.min(r.x1, b.x + b.w - 1) / CHUNK);
    const cy1 = Math.floor(Math.min(r.y1, b.y + b.h - 1) / CHUNK);
    let missing = 0;
    for (const l of b.mgr.layers) {
      if (!l.visible || l.opacity <= 0 || !l.store) continue;
      for (const c of l.store.map.values()) {
        if (c.cx < cx0 || c.cx > cx1 || c.cy < cy0 || c.cy > cy1) continue;
        if (renderer.texOf(c) && !c.texDirty) continue;
        if (this._warmLeft > 0) {
          this._warmLeft--;
          this._work += UPLOAD_COST + 1;
          renderer._uploadNow(c);
          if (this._wantMips) {
            renderer.encodeMips(this._encoder(renderer), renderer.texOf(c));
            c.mips = true;
          }
          e.warmDone++;
        } else {
          missing++;
        }
      }
    }
    return missing;
  }

  // Un passo della build: composita fino a BUILD_BUDGET chunk-layer nella
  // texture del proxy (ordine pila dal basso, stesso blending premultiplied
  // dello schermo). Multi-frame: la texture conserva il parziale (loadOp
  // 'load'). Il tick è UNA sequenza di render pass nell'encoder condiviso,
  // spezzata solo dalle copie di backdrop e dai cambi di bersaglio.
  /**
   * @param {WgpuRenderer} renderer @param {BoardManager} boards
   * @param {{board: Board, key: number}|null} candidate
   */
  _buildTick(renderer, boards, candidate) {
    let bld = this._build;
    // la build in corso vale ancora? (board vivo, contenuto non cambiato)
    if (bld) {
      const b = boards.byId(bld.boardId);
      if (!b || contentKey(b) !== bld.key || !this._map.has(bld.boardId)) {
        this._build = bld = null;
      }
    }
    if (!bld && candidate) {
      bld = this._build = {
        boardId: candidate.board.id, key: candidate.key,
        li: 0, ci: 0, chunks: null, grpEnd: -1, grpBase: -1,
      };
    }
    if (!bld) return;
    const b = /** @type {Board} */ (boards.byId(bld.boardId));
    const e = /** @type {Entry} */ (this._map.get(bld.boardId));
    const dev = renderer.device;

    if (!this._grpTex) {
      this._grpTex = dev.createTexture({
        size: [PROXY_SIZE, PROXY_SIZE], format: 'rgba8unorm',
        usage: /* TEXTURE_BINDING|RENDER_ATTACHMENT */ 0x4 | 0x10,
      });
    }
    if (!this._uniBuf) {
      this._uniBuf = dev.createBuffer({
        size: UNI_SLOTS * 256, usage: /* UNIFORM|COPY_DST */ 0x40 | 0x8,
      });
    }
    const enc = this._encoder(renderer);
    const sx = PROXY_SIZE / b.w, sy = PROXY_SIZE / b.h;

    // pass corrente del tick: si riapre al cambio di bersaglio (proxy ↔
    // scratch del gruppo) e dopo ogni copia di backdrop
    /** @type {any} */ let pass = null;
    /** @type {any} */ let curTarget = null;
    let drawIdx = 0;
    const endPass = () => { if (pass) { pass.end(); pass = null; curTarget = null; } };
    const passOn = (/** @type {any} */ target, clear = false) => {
      if (pass && curTarget === target && !clear) return;
      endPass();
      pass = enc.beginRenderPass({
        colorAttachments: [{
          view: renderer._viewsOf(target).level[0],
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: clear ? 'clear' : 'load', storeOp: 'store',
        }],
      });
      curTarget = target;
    };
    // un draw nel pass corrente: quad allineato in px del proxy, uniform
    // alla fetta drawIdx, bind group usa-e-getta (≤ ~50, solo nei tick di
    // build — non è il path caldo del present)
    const f = this._uniF32, u32 = this._uniU32;
    const draw = (/** @type {any} */ pipe, /** @type {any} */ tex,
      /** @type {number} */ x, /** @type {number} */ y,
      /** @type {number} */ w, /** @type {number} */ h,
      /** @type {number} */ alpha, blendFn = 0,
      /** @type {number[]|null} */ sciss = null, /** @type {any} */ back = null) => {
      const o = drawIdx * 64;
      f[o] = x; f[o + 1] = y;
      f[o + 2] = w; f[o + 3] = 0;
      f[o + 4] = 0; f[o + 5] = h;
      f[o + 6] = PROXY_SIZE; f[o + 7] = PROXY_SIZE;
      f[o + 8] = alpha; f[o + 9] = 1;
      u32[o + 10] = 0;
      u32[o + 11] = blendFn;
      const bind = dev.createBindGroup({
        layout: renderer._bgl,
        entries: [
          { binding: 0, resource: this._samp },
          { binding: 1, resource: renderer._viewsOf(tex).full },
          { binding: 2, resource: renderer._viewsOf(renderer._white).full },
          { binding: 3, resource: { buffer: this._uniBuf, size: 64 } },
          { binding: 4, resource: renderer._viewsOf(back || renderer._white).full },
        ],
      });
      pass.setPipeline(pipe);
      if (sciss) pass.setScissorRect(sciss[0], sciss[1], sciss[2], sciss[3]);
      pass.setBindGroup(0, bind, [drawIdx * 256]);
      pass.draw(6);
      if (sciss) pass.setScissorRect(0, 0, PROXY_SIZE, PROXY_SIZE);
      drawIdx++;
    };
    const ensureBd = () => {
      if (!this._bdTex) {
        this._bdTex = dev.createTexture({
          size: [PROXY_SIZE, PROXY_SIZE], format: 'rgba8unorm',
          usage: /* TEXTURE_BINDING|COPY_DST */ 0x4 | 0x2,
        });
      }
    };

    // prima volta su questa build: la texture parte azzerata
    if (bld.li === 0 && bld.ci === 0 && bld.chunks === null && bld.grpEnd < 0) {
      passOn(e.tex, true);
    }

    const budget0 = Math.max(TEXT_COST, Math.round(BUILD_BUDGET * this._budgetScale));
    let budget = budget0;
    let txtUsed = false;
    while (budget > 0 && drawIdx < UNI_SLOTS - 1) {
      // gruppo finito: lo scratch si composita nel proxy come UN quad,
      // col metodo di fusione della BASE (come il blit del gruppo a schermo)
      if (bld.grpEnd >= 0 && bld.li >= bld.grpEnd) {
        const bmode = b.mgr.layers[bld.grpBase].mode || 'normal';
        if (bmode in SHADER_MODE_IDX) {
          ensureBd();
          endPass();
          enc.copyTextureToTexture({ texture: e.tex }, { texture: this._bdTex },
            [PROXY_SIZE, PROXY_SIZE]);
          passOn(e.tex);
          draw(renderer._pipeBlendR8, this._grpTex, 0, 0, PROXY_SIZE, PROXY_SIZE,
            1, SHADER_MODE_IDX[bmode], null, this._bdTex);
          budget -= 8;
        } else {
          passOn(e.tex);
          const pipe = bmode === 'screen' ? renderer._pipeScreenR8
            : bmode === 'add' ? renderer._pipeAddR8 : renderer._pipelineGrp;
          draw(pipe, this._grpTex, 0, 0, PROXY_SIZE, PROXY_SIZE, 1);
          budget -= 4;
        }
        bld.grpEnd = -1;
        bld.grpBase = -1;
        continue;
      }
      if (bld.li >= b.mgr.layers.length) {
        // finita: mip del proxy (minificazione pulita sotto zoom 0.5) e via
        endPass();
        renderer.encodeMips(enc, e.tex);
        e.ready = true;
        e.key = bld.key;
        this._build = null;
        this._serial++;   // la screen-cache del renderer se ne accorge
        break;
      }
      const layer = b.mgr.layers[bld.li];
      if (!layer.visible || layer.opacity <= 0) { bld.li++; bld.chunks = null; continue; }
      // figlio di un gruppo la cui base è stata saltata: gruppo invisibile
      if (bld.grpEnd < 0 && layer.clip && layer.clipBase) { bld.li++; bld.chunks = null; continue; }
      if (layer.kind === 'text') {
        // un solo testo per tick (vedi trappola in testa) e mai col tick
        // quasi esaurito: parte intero al prossimo frame
        if (budget < TEXT_COST || txtUsed) break;
        passOn(e.tex); // il testo non può stare dentro un gruppo
        this._drawBuildText(renderer, b, layer, draw);
        txtUsed = true;
        budget -= TEXT_COST;
        bld.li++; bld.chunks = null;
        continue;
      }
      // base di un gruppo di ritaglio? da qui a grpEnd si compone nello
      // scratch (base = blending normale, figli = DST_ALPHA), poi un quad
      if (bld.grpEnd < 0) {
        const ls = b.mgr.layers;
        let gEnd = bld.li + 1;
        while (gEnd < ls.length && ls[gEnd].clip && ls[gEnd].clipBase === layer) gEnd++;
        if (gEnd > bld.li + 1) {
          bld.grpEnd = gEnd;
          bld.grpBase = bld.li;
          passOn(this._grpTex, true);
        }
      }
      // metodo di fusione: solo top-level (nei gruppi i figli restano
      // normal e il modo della base si applica al quad del gruppo)
      const mode = bld.grpEnd < 0 && layer.mode ? layer.mode : 'normal';
      if (bld.chunks === null) {
        bld.chunks = [...layer.store.map.values()];
        bld.ci = 0;
      }
      if (bld.ci >= bld.chunks.length) { bld.li++; bld.chunks = null; continue; }
      const c = bld.chunks[bld.ci++];
      if (!layer.store.map.has(c.key)) continue; // rilasciato nel frattempo
      const created = !renderer.texOf(c) || c.texDirty;
      if (created) {
        renderer._uploadNow(c);
        budget -= UPLOAD_COST; // il writeTexture da 256KB È il costo vero
      }
      const ctex = renderer.texOf(c);
      const x = (c.cx * CHUNK - b.x) * sx, y = (c.cy * CHUNK - b.y) * sy;
      const w = CHUNK * sx, h = CHUNK * sy;
      const inGroup = bld.grpEnd >= 0;
      if (SHADER_MODE_IDX[mode] !== undefined) {
        // modo shader: copia dal proxy il rect del chunk e ricompone con la
        // formula W3C — il backdrop resta valido tra i tick perché nessun
        // altro disegna sul proxy finché il livello non è finito
        const bx0 = Math.max(0, Math.floor(x)), by0 = Math.max(0, Math.floor(y));
        const bx1 = Math.min(PROXY_SIZE, Math.ceil(x + w));
        const by1 = Math.min(PROXY_SIZE, Math.ceil(y + h));
        if (bx1 > bx0 && by1 > by0) {
          ensureBd();
          endPass();
          enc.copyTextureToTexture(
            { texture: e.tex, origin: [bx0, by0] },
            { texture: this._bdTex, origin: [bx0, by0] },
            [bx1 - bx0, by1 - by0]);
          passOn(e.tex);
          draw(renderer._pipeBlendR8, ctex, x, y, w, h, layer.opacity,
            SHADER_MODE_IDX[mode], [bx0, by0, bx1 - bx0, by1 - by0], this._bdTex);
        }
        budget -= 2;
      } else {
        passOn(inGroup ? this._grpTex : e.tex);
        const child = inGroup && bld.li > bld.grpBase;
        const pipe = child ? renderer._pipelineGrpClip
          : mode === 'screen' ? renderer._pipeScreenR8
          : mode === 'add' ? renderer._pipeAddR8 : renderer._pipelineGrp;
        draw(pipe, ctex, x, y, w, h, layer.opacity);
        budget--;
      }
      // texture creata solo per il build di un board coperto: via appena il
      // tick è sottomesso (la transitoria resta ≤ budget, mai l'intero board)
      if (created && e.covering) this._transient.push(c);
    }
    endPass();
    this._work += budget0 - Math.min(budget0, Math.max(0, budget));
    // gli uniform delle fette usate atterrano in coda PRIMA del submit
    // dell'encoder (le op di coda eseguono in ordine di emissione)
    if (drawIdx > 0) {
      dev.queue.writeBuffer(this._uniBuf, 0, this._uniArr, 0, drawIdx * 256);
    }
  }

  // Un livello testo dentro la build: il documento si rasterizza a scala
  // proxy nel canvas scratch (stessa resa dell'export, coordinate
  // board-locali: ciò che sborda cade fuori dal canvas, il clip è gratis) e
  // si composita come UN quad alla sua posizione nella pila.
  /** @param {WgpuRenderer} renderer @param {Board} b
   * @param {import('./layers.js').Layer} layer @param {Function} draw */
  _drawBuildText(renderer, b, layer, draw) {
    const dev = renderer.device;
    let cnv = this._txtCanvas;
    if (!cnv) {
      cnv = this._txtCanvas = document.createElement('canvas');
      cnv.width = PROXY_SIZE;
      cnv.height = PROXY_SIZE;
      this._txtCtx = cnv.getContext('2d');
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (this._txtCtx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PROXY_SIZE, PROXY_SIZE);
    ctx.setTransform(PROXY_SIZE / b.w, 0, 0, PROXY_SIZE / b.h, 0, 0);
    drawTextDocument(ctx, layer.item, layer.style, b.x, b.y, 1,
      PROXY_SIZE / b.w, PROXY_SIZE / b.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // font non ancora atterrato: si cuoce il fallback e si invalida la
    // chiave quando arriva quello vero (stesso pattern della variante GL)
    const st = layer.style;
    if (!document.fonts.check(`${st.weight} 16px "${st.font}"`)) {
      ensureFont(st.font, st.weight).then(() => touchText(layer));
    }
    if (!this._txtTex) {
      this._txtTex = dev.createTexture({
        size: [PROXY_SIZE, PROXY_SIZE], format: 'rgba8unorm',
        // COPY_DST+RENDER_ATTACHMENT: richiesti da copyExternalImageToTexture
        usage: 0x4 | 0x2 | 0x10,
      });
    }
    // il canvas è straight-alpha: premoltiplicato all'upload, come i chunk
    dev.queue.copyExternalImageToTexture(
      { source: cnv }, { texture: this._txtTex, premultipliedAlpha: true },
      [PROXY_SIZE, PROXY_SIZE]);
    draw(renderer._pipelineGrp, this._txtTex, 0, 0, PROXY_SIZE, PROXY_SIZE,
      layer.opacity);
  }
}
