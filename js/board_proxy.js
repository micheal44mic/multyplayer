// PROXY DEI BOARD — cache di presentazione per lo zoom-out.
// Sotto PROXY_ZOOM ogni board non attivo si disegna come UN quad con una
// texture piatta 1024²: il composito dei suoi livelli (testo compreso,
// rasterizzato alla sua posizione nella pila), fatto in GPU dentro un
// framebuffer con lo stesso shader dei chunk. Risultato a
// vista panoramica: draw call da O(chunk × layer) a O(board), VRAM residente
// da centinaia di MB a ~5 MB per board, e niente upload massivo al primo
// zoom-out (il crash da memoria su mobile). La CPU resta la verità: il proxy
// è solo presentazione e si ricostruisce — a budget, un board per volta —
// quando cambiano struttura (epoch), visibilità/opacità o pixel (store.ver).
//
// Transizioni:
// - zoom-out con board "caldo" (texture dei chunk già in GPU): si continua a
//   disegnare per-chunk finché il proxy non è pronto, poi switch e le
//   texture dei chunk si liberano — nessun frame bianco.
// - zoom-out con board "freddo" (dopo un load/stress): disegnarlo per-chunk
//   vorrebbe dire l'upload-valanga che si vuole evitare → board bianco per
//   qualche decimo di secondo finché il proxy non è costruito.
// - zoom-in: il quad resta a coprire finché i chunk visibili non sono stati
//   ricaricati (WARM_BUDGET a frame), poi si torna al path per-chunk nitido.

import { CHUNK } from './store.js';
import { drawTextDocument, ensureFont, touchText } from './text_layer.js';
import { blendIndex } from './layers.js';
import { SHADER_MODES } from './renderer_gl.js';

/** @typedef {import('./renderer_gl.js').GLRenderer} GLRenderer */
/** @typedef {import('./planes.js').Planes} Planes */
/** @typedef {import('./boards.js').BoardManager} BoardManager */
/** @typedef {import('./boards.js').Board} Board */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {{x: number, y: number, w: number, h: number, tex: WebGLTexture}} ProxyQuad */
/** loading: boardId -> avanzamento 0..1 del warm-up (per l'etichetta del board) */
/** @typedef {{quads: ProxyQuad[], skip: Set<number>, loading: Map<number, number>}} ProxyFrame */

// Sotto questo zoom i board passano al proxy. 1024² da un board 2048² è una
// riduzione esatta 2:1: a zoom 0.5 il campionamento LINEAR del build è la
// media 2×2 perfetta, e a schermo il quad è 1:1 o meno — mai sgranato.
export const PROXY_ZOOM = 0.5;
const PROXY_SIZE = 1024;
const BUILD_BUDGET = 48;   // chunk-layer compositati nel framebuffer per frame
const WARM_BUDGET = 32;    // upload di rientro (zoom-in) per frame
// un livello testo nel build (raster del documento + upload 1024² + quad)
// pesa come questo numero di chunk-layer
const TEXT_COST = 16;

/**
 * Chiave del contenuto di un board: struttura della pila + flag dei layer +
 * versione dei pixel di ogni store (raster) o del documento (testo, l.ver
 * bumpato da touchText). Se non cambia, il proxy resta valido.
 * @param {Board} b
 */
function contentKey(b) {
  let k = (b.mgr.epoch + b.w * 3 + b.h * 7) | 0;
  for (const l of b.mgr.layers) {
    k = (Math.imul(k, 31) + (l.visible ? 1 : 0) + (l.clip ? 13 : 0) +
      ((l.opacity * 255) | 0) * 3 + blendIndex(l) * 17 +
      (l.store ? l.store.ver * 7 : ((l.ver | 0) * 7 + 3))) | 0;
  }
  return k;
}

/**
 * @typedef {Object} Entry
 * @property {WebGLTexture} tex
 * @property {boolean} ready almeno una build completata (la texture è disegnabile)
 * @property {number} key contenuto dell'ultima build completata
 * @property {boolean} covering i layer del board sono nascosti dietro il quad
 * @property {number} warmDone chunk già ricaricati nel warm-up corrente
 */

export class BoardProxyCache {
  constructor() {
    /** @type {Map<number, Entry>} boardId -> proxy */
    this._map = new Map();
    /** @type {WebGLRenderingContext|null} */
    this._gl = null;
    this._gen = -1;
    /** @type {WebGLFramebuffer|null} */
    this._fbo = null;
    // build incrementale: un board per volta, BUILD_BUDGET chunk-layer a
    // frame. grpEnd/grpBase: gruppo di ritaglio in corso (-1 = nessuno),
    // composto nello scratch _grpTex e poi quadrato nel proxy.
    /** @type {{boardId: number, key: number, li: number, ci: number, chunks: Chunk[]|null, grpEnd: number, grpBase: number}|null} */
    this._build = null;
    /** @type {WebGLTexture|null} scratch 1024² dei gruppi di ritaglio */
    this._grpTex = null;
    /** @type {WebGLTexture|null} backdrop 1024² dei modi di fusione shader */
    this._bdTex = null;
    this._mat = new Float32Array(9);
    // frame correnti, riusati (zero allocazioni a regime)
    /** @type {ProxyFrame} */
    this._out = { quads: [], skip: new Set(), loading: new Map() };
    /** @type {ProxyQuad[]} pool dei quad */
    this._qp = [];
    this._seen = new Set();
    this._warmLeft = 0;
    this._wantMips = false;
    this._rectTmp = { x0: 0, y0: 0, x1: 0, y1: 0 };
    // raster del documento testo nel build: canvas scratch + texture riusati
    /** @type {HTMLCanvasElement|null} */
    this._txtCanvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this._txtCtx = null;
    /** @type {WebGLTexture|null} */
    this._txtTex = null;
  }

  // Da chiamare una volta a frame PRIMA del render dei piani. Ritorna i quad
  // da disegnare e i layer da saltare; fa anche un passo di build/warm-up.
  /**
   * @param {GLRenderer} renderer
   * @param {BoardManager} boards
   * @param {number} activeBoardId
   * @param {Camera} camera
   * @param {boolean} allowBuild false durante un tratto: tutta la banda al pennello
   * @param {Planes|null} [planes] per svuotare le cache 2D dei board coperti
   * @returns {ProxyFrame}
   */
  update(renderer, boards, activeBoardId, camera, allowBuild, planes = null) {
    const out = this._out;
    out.quads.length = 0;
    out.skip.clear();
    out.loading.clear();
    if (!renderer.gl || renderer.contextLost) return out;
    // contesto nuovo (perso/ricreato): le vecchie risorse non esistono più
    if (renderer.gl !== this._gl || renderer.ctxGen !== this._gen) {
      this._map.clear();
      this._fbo = null;
      this._build = null;
      this._txtTex = null;
      this._grpTex = null;
      this._bdTex = null;
      this._gl = renderer.gl;
      this._gen = renderer.ctxGen;
    }

    const wantProxy = camera.zoom <= PROXY_ZOOM;
    this._warmLeft = WARM_BUDGET;
    this._wantMips = camera.zoom < 1;
    this._seen.clear();
    /** @type {{board: Board, key: number}|null} */
    let candidate = null;

    // Il board ATTIVO per primo, col warm a precedenza: se è ancora coperto
    // (appena selezionato da un click mentre era un proxy) si ricaricano le
    // sue texture a budget e il quad copre finché non è pronto — è il
    // "caricamento" che l'utente vede dopo il click; il pennello è bloccato
    // da App.startStroke finché isLoading è vero.
    const act = boards.byId(activeBoardId);
    const actE = act ? this._map.get(act.id) : undefined;
    if (act && actE && actE.covering) {
      const missing = this._warm(renderer, act, actE, camera);
      if (missing === 0) {
        actE.covering = false;
      } else {
        for (const l of act.mgr.layers) out.skip.add(l.id);
        if (actE.ready) this._pushQuad(out, act, actE);
        out.loading.set(act.id, actE.warmDone / (actE.warmDone + missing));
      }
    }

    for (const b of boards.boards) {
      this._seen.add(b.id);
      let e = this._map.get(b.id);
      if (b.id === activeBoardId) continue; // gestito sopra
      // anche i board con testo: la build cuoce il documento DENTRO il
      // framebuffer alla sua posizione nella pila (ordine preservato), e i
      // piani SVG dei board coperti vengono nascosti via skip
      const eligible = b.mgr.layers.length > 0;
      if (!eligible) {
        if (e) e.covering = false;
        continue;
      }
      const key = contentKey(b);
      if (wantProxy) {
        if (!e) {
          e = { tex: this._newTex(renderer.gl), ready: false, key: 0, covering: false, warmDone: 0 };
          this._map.set(b.id, e);
        }
        if ((!e.ready || e.key !== key) && candidate === null) candidate = { board: b, key };
        // copre se il quad è disegnabile, oppure se il board è freddo (il
        // per-chunk a tutto-visibile sarebbe l'upload-valanga: meglio bianco
        // per qualche frame). Un board caldo resta live finché il proxy
        // non è pronto: zero frame bianchi nel caso comune.
        if (e.ready || !this._isWarm(b)) {
          if (!e.covering) {
            e.covering = true;
            e.warmDone = 0;
            this._dropChunkTex(renderer, planes, b);
          }
          for (const l of b.mgr.layers) out.skip.add(l.id);
          if (e.ready) this._pushQuad(out, b, e);
        }
      } else if (e && e.covering) {
        // rientro: il quad copre finché i chunk visibili non sono caldi
        const missing = this._warm(renderer, b, e, camera);
        if (!e.ready || missing === 0) {
          e.covering = false;
        } else {
          for (const l of b.mgr.layers) out.skip.add(l.id);
          this._pushQuad(out, b, e);
          out.loading.set(b.id, e.warmDone / (e.warmDone + missing));
        }
      }
    }

    // board spariti (clearAll): via texture e entry
    for (const [id, e] of this._map) {
      if (!this._seen.has(id)) {
        renderer.gl.deleteTexture(e.tex);
        this._map.delete(id);
        if (this._build && this._build.boardId === id) this._build = null;
      }
    }

    if (allowBuild) this._buildTick(renderer, boards, candidate);
    return out;
  }

  /** @param {ProxyFrame} out @param {Board} b @param {Entry} e */
  _pushQuad(out, b, e) {
    const i = out.quads.length;
    let q = this._qp[i];
    if (!q) q = this._qp[i] = { x: 0, y: 0, w: 0, h: 0, tex: e.tex };
    q.x = b.x; q.y = b.y; q.w = b.w; q.h = b.h; q.tex = e.tex;
    out.quads.push(q);
  }

  /** @param {WebGLRenderingContext} gl */
  _newTex(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PROXY_SIZE, PROXY_SIZE, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  // Tutte le texture chunk del board in GPU e aggiornate? (Decide se il
  // passaggio al proxy può restare "live" senza upload-valanga.)
  /** @param {Board} b */
  _isWarm(b) {
    for (const l of b.mgr.layers) {
      if (!l.store) continue; // testo: niente chunk
      for (const c of l.store.map.values()) {
        if (!c.tex || c.texDirty) return false;
      }
    }
    return true;
  }

  // Il quad sta per coprire il board: le texture dei suoi chunk non servono
  // più (rinasceranno on-demand al rientro, a budget via _warm). I livelli
  // dei gruppi sopra un testo vivono nei renderer 2D del pool: la loro cache
  // (chunk.c2d) la svuota il renderer che la possiede, o resterebbe orfana.
  /** @param {GLRenderer} renderer @param {Planes|null} planes @param {Board} b */
  _dropChunkTex(renderer, planes, b) {
    for (const l of b.mgr.layers) {
      if (!l.store) continue;
      const r2d = planes ? planes.poolRendererFor(l.id) : null;
      l.store.forEachChunkAll((c) => {
        renderer.disposeChunkTex(c);
        if (r2d) r2d.disposeChunkTex(c);
      });
    }
  }

  // Ricarica a budget le texture dei chunk visibili del board; ritorna
  // quanti ne mancano ancora (0 = si può scoprire). Sotto zoom 1 genera
  // anche le mipmap qui: il costo sta nei frame di caricamento (col quad a
  // coprire), non in un hitch unico al primo frame scoperto.
  /** @param {GLRenderer} renderer @param {Board} b @param {Entry} e @param {Camera} camera */
  _warm(renderer, b, e, camera) {
    const gl = renderer.gl;
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
        if (c.tex && !c.texDirty) continue;
        if (this._warmLeft > 0) {
          this._warmLeft--;
          renderer._uploadNow(c); // lascia la texture bound su TEXTURE0
          if (this._wantMips) {
            gl.generateMipmap(gl.TEXTURE_2D);
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

  // Il board attivo è ancora coperto dal quad (texture in ricarica)?
  // App.startStroke lo usa per non far partire tratti "alla cieca".
  /** @param {number} boardId */
  isLoading(boardId) {
    const e = this._map.get(boardId);
    return e !== undefined && e.covering;
  }

  // Un passo della build: composita fino a BUILD_BUDGET chunk-layer nel
  // framebuffer del proxy (ordine pila dal basso, stesso blending premoltiplicato
  // dello schermo). Multi-frame: il framebuffer conserva il parziale.
  /**
   * @param {GLRenderer} renderer @param {BoardManager} boards
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
    const b = boards.byId(bld.boardId);
    const e = this._map.get(bld.boardId);
    const gl = renderer.gl;

    if (!this._fbo) this._fbo = gl.createFramebuffer();
    // scratch dei gruppi di ritaglio (stessa scala del proxy, riusato)
    if (!this._grpTex) this._grpTex = this._newTex(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    // il tick riprende dove aveva lasciato: dentro un gruppo si disegna
    // nello scratch, fuori nel proxy
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
      bld.grpEnd >= 0 ? this._grpTex : e.tex, 0);
    gl.viewport(0, 0, PROXY_SIZE, PROXY_SIZE);
    if (bld.li === 0 && bld.ci === 0 && bld.chunks === null && bld.grpEnd < 0) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // stesso programma dei chunk, matrice mondo->clip del framebuffer
    // (Y POSITIVA: la riga 0 della texture deve essere il bordo alto del
    // board, così il quad si campiona con le stesse UV dei chunk)
    gl.useProgram(renderer.progChunk);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quad);
    const aPos = gl.getAttribLocation(renderer.progChunk, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const m = this._mat;
    m[0] = 2 / b.w; m[1] = 0; m[2] = 0;
    m[3] = 0; m[4] = 2 / b.h; m[5] = 0;
    m[6] = -1 - 2 * b.x / b.w; m[7] = -1 - 2 * b.y / b.h; m[8] = 1;
    gl.uniformMatrix3fv(renderer.uMat, false, m);
    gl.uniform2f(renderer.uSize, CHUNK, CHUNK);
    gl.uniform1i(renderer.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    // blending corrente: i FIGLI dei gruppi di ritaglio si cuociono con
    // DST_ALPHA (l'alpha resta quella della base, il colore la sostituisce
    // — stessa semantica di gruppo del render a schermo); screen/add usano
    // il loro blendFunc esatto (vedi _setModeBlend nel renderer)
    /** @type {'over'|'child'|'screen'|'add'} */
    let curBlend = 'over';
    /** @param {'over'|'child'|'screen'|'add'} kind */
    const setBlend = (kind) => {
      if (kind === curBlend) return;
      if (kind === 'child') gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      else if (kind === 'screen') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      else if (kind === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      curBlend = kind;
    };

    let budget = BUILD_BUDGET;
    while (budget > 0) {
      // gruppo finito: lo scratch si composita nel proxy come UN quad,
      // col metodo di fusione della BASE (come il blit del gruppo a schermo)
      if (bld.grpEnd >= 0 && bld.li >= bld.grpEnd) {
        setBlend('over');
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, e.tex, 0);
        const bmode = b.mgr.layers[bld.grpBase].mode || 'normal';
        if (SHADER_MODES.has(bmode)) {
          this._blendGroupQuad(renderer, b, bmode);
          budget -= 8;
        } else {
          if (bmode === 'screen' || bmode === 'add') setBlend(bmode);
          gl.uniform1f(renderer.uAlpha, 1);
          gl.uniform2f(renderer.uSize, b.w, b.h);
          gl.uniform2f(renderer.uOrigin, b.x, b.y);
          gl.bindTexture(gl.TEXTURE_2D, this._grpTex);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.uniform2f(renderer.uSize, CHUNK, CHUNK);
          if (bmode === 'screen' || bmode === 'add') setBlend('over');
          budget -= 4;
        }
        bld.grpEnd = -1;
        bld.grpBase = -1;
        continue;
      }
      if (bld.li >= b.mgr.layers.length) {
        // finita: mipmap del proxy (minificazione pulita sotto zoom 0.5)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.generateMipmap(gl.TEXTURE_2D); // 1024 è POT: ok anche su WebGL1
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        e.ready = true;
        e.key = bld.key;
        this._build = null;
        return;
      }
      const layer = b.mgr.layers[bld.li];
      if (!layer.visible || layer.opacity <= 0) { bld.li++; bld.chunks = null; continue; }
      // figlio di un gruppo la cui base è stata saltata (nascosta/opacità 0):
      // l'intero gruppo è invisibile, come a schermo
      if (bld.grpEnd < 0 && layer.clip && layer.clipBase) { bld.li++; bld.chunks = null; continue; }
      if (layer.kind === 'text') {
        // tick quasi esaurito: il testo parte intero al prossimo frame
        // (il testo non può stare dentro un gruppo: spezza le catene)
        if (budget < TEXT_COST) break;
        this._drawBuildText(renderer, b, layer);
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
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, this._grpTex, 0);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
      // metodo di fusione: solo top-level (nei gruppi i figli restano
      // normal e il modo della base si applica al quad del gruppo)
      const mode = bld.grpEnd < 0 && layer.mode ? layer.mode : 'normal';
      setBlend(bld.grpEnd >= 0 && bld.li > bld.grpBase ? 'child'
        : mode === 'screen' || mode === 'add' ? mode : 'over');
      if (bld.chunks === null) {
        bld.chunks = [...layer.store.map.values()];
        bld.ci = 0;
        gl.uniform1f(renderer.uAlpha, layer.opacity);
      }
      if (bld.ci >= bld.chunks.length) { bld.li++; bld.chunks = null; continue; }
      const c = bld.chunks[bld.ci++];
      if (!layer.store.map.has(c.key)) continue; // rilasciato nel frattempo
      const created = !c.tex || c.texDirty;
      if (created) renderer._uploadNow(c); // bind incluso
      else gl.bindTexture(gl.TEXTURE_2D, c.tex);
      if (c.mipOn) {
        // niente mip nel build: a scala 0.5 LINEAR è già la media 2×2 esatta
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        c.mipOn = false;
      }
      if (SHADER_MODES.has(mode)) {
        // modo shader: copia dal proxy il rect del chunk e ricompone con
        // la formula W3C — il backdrop resta valido tra i tick perché
        // nessun altro disegna sul proxy finché il livello non è finito
        this._blendChunk(renderer, b, layer, c, mode);
        budget -= 2;
      } else {
        gl.uniform2f(renderer.uOrigin, c.cx * CHUNK, c.cy * CHUNK);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        budget--;
      }
      // texture creata solo per il build di un board coperto: via subito
      // (la transitoria resta ≤ budget per frame, mai l'intero board)
      if (created && e.covering) renderer.disposeChunkTex(c);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Un livello testo dentro la build: il documento si rasterizza a scala
  // proxy nel canvas scratch (stessa resa dell'export, coordinate
  // board-locali: ciò che sborda dal board cade fuori dal canvas, il clip è
  // gratis) e si composita come UN quad alla sua posizione nella pila.
  // Va chiamato col framebuffer/programma/blend del build già attivi.
  /** @param {GLRenderer} renderer @param {Board} b @param {import('./layers.js').Layer} layer */
  _drawBuildText(renderer, b, layer) {
    const gl = renderer.gl;
    let cnv = this._txtCanvas;
    if (!cnv) {
      cnv = this._txtCanvas = document.createElement('canvas');
      cnv.width = PROXY_SIZE;
      cnv.height = PROXY_SIZE;
      this._txtCtx = cnv.getContext('2d');
    }
    const ctx = this._txtCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PROXY_SIZE, PROXY_SIZE);
    ctx.setTransform(PROXY_SIZE / b.w, 0, 0, PROXY_SIZE / b.h, 0, 0);
    drawTextDocument(ctx, layer.item, layer.style, b.x, b.y, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // font non ancora atterrato: si cuoce il fallback e si invalida la
    // chiave quando arriva quello vero (stesso pattern di syncTextSvg)
    const st = layer.style;
    if (!document.fonts.check(`${st.weight} 16px "${st.font}"`)) {
      ensureFont(st.font, st.weight).then(() => touchText(layer));
    }

    if (!this._txtTex) {
      this._txtTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._txtTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._txtTex);
    }
    // i chunk caricano array già premoltiplicati (flag globale false); il
    // canvas invece arriva straight-alpha e va premoltiplicato all'upload
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cnv);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1f(renderer.uAlpha, layer.opacity);
    gl.uniform2f(renderer.uSize, b.w, b.h);
    gl.uniform2f(renderer.uOrigin, b.x, b.y);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.uniform2f(renderer.uSize, CHUNK, CHUNK); // stato per i chunk dopo
  }

  // Stato comune dei pass di fusione del bake: programma del modo +
  // attributi + uniform (matrice del bake, backdrop = unità 2, niente
  // tratto). Il chiamante disegna e poi chiama _endBlend.
  /** @param {GLRenderer} renderer @param {string} mode @param {number} layerA */
  _beginBlend(renderer, mode, layerA) {
    const gl = renderer.gl;
    if (!this._bdTex) this._bdTex = this._newTex(gl);
    const prog = renderer._modeProg(mode), u = renderer._modeUni[mode];
    gl.useProgram(prog);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(u.uMat, false, this._mat);
    gl.uniform2f(u.uBackSize, PROXY_SIZE, PROXY_SIZE);
    gl.uniform1f(u.uAlpha, 0);
    gl.uniform1f(u.uLayerA, layerA);
    gl.uniform1f(u.uEraser, 0);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uMask, 1);
    gl.uniform1i(u.uBack, 2);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, renderer.dummyTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND);
    return u;
  }

  // Ripristina programma/attributi/blend del build (progChunk).
  /** @param {GLRenderer} renderer */
  _endBlend(renderer) {
    const gl = renderer.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.useProgram(renderer.progChunk);
    const aPos = gl.getAttribLocation(renderer.progChunk, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  // UN chunk di un livello con modo shader: copia dal proxy il rect del
  // chunk nel backdrop e ricompone con la formula W3C (blending spento,
  // scissor sul rect copiato). Il chunk è già legato sull'unità 0.
  /** @param {GLRenderer} renderer @param {Board} b @param {import('./layers.js').Layer} layer @param {Chunk} c @param {string} mode */
  _blendChunk(renderer, b, layer, c, mode) {
    const gl = renderer.gl;
    const sx = PROXY_SIZE / b.w, sy = PROXY_SIZE / b.h;
    const x0 = Math.max(0, Math.floor((c.cx * CHUNK - b.x) * sx));
    const y0 = Math.max(0, Math.floor((c.cy * CHUNK - b.y) * sy));
    const x1 = Math.min(PROXY_SIZE, Math.ceil(((c.cx + 1) * CHUNK - b.x) * sx));
    const y1 = Math.min(PROXY_SIZE, Math.ceil(((c.cy + 1) * CHUNK - b.y) * sy));
    if (x1 <= x0 || y1 <= y0) return;
    const u = this._beginBlend(renderer, mode, layer.opacity);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._bdTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x0, y0, x1 - x0, y1 - y0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.uniform2f(u.uSize, CHUNK, CHUNK);
    gl.uniform2f(u.uOrigin, c.cx * CHUNK, c.cy * CHUNK);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._endBlend(renderer);
  }

  // Quad del gruppo di ritaglio con modo shader della base: copia l'intero
  // proxy nel backdrop e ricompone lo scratch (opacità della base già
  // dentro) con la formula W3C.
  /** @param {GLRenderer} renderer @param {Board} b @param {string} mode */
  _blendGroupQuad(renderer, b, mode) {
    const gl = renderer.gl;
    const u = this._beginBlend(renderer, mode, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._bdTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, PROXY_SIZE, PROXY_SIZE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._grpTex);
    gl.uniform2f(u.uSize, b.w, b.h);
    gl.uniform2f(u.uOrigin, b.x, b.y);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._endBlend(renderer);
  }
}
