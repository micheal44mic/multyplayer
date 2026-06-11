// PROXY DEI BOARD — cache di presentazione per lo zoom-out.
// Sotto PROXY_ZOOM ogni board non attivo (e solo-raster) si disegna come UN
// quad con una texture piatta 1024²: il composito dei suoi livelli, fatto in
// GPU dentro un framebuffer con lo stesso shader dei chunk. Risultato a
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

/** @typedef {import('./renderer_gl.js').GLRenderer} GLRenderer */
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

/**
 * Chiave del contenuto di un board: struttura della pila + flag dei layer +
 * versione dei pixel di ogni store. Se non cambia, il proxy resta valido.
 * @param {Board} b
 */
function contentKey(b) {
  let k = (b.mgr.epoch + b.w * 3 + b.h * 7) | 0;
  for (const l of b.mgr.layers) {
    k = (Math.imul(k, 31) + (l.visible ? 1 : 0) +
      ((l.opacity * 255) | 0) * 3 + (l.store ? l.store.ver * 7 : 0)) | 0;
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
    // build incrementale: un board per volta, BUILD_BUDGET chunk-layer a frame
    /** @type {{boardId: number, key: number, li: number, ci: number, chunks: Chunk[]|null}|null} */
    this._build = null;
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
  }

  // Da chiamare una volta a frame PRIMA del render dei piani. Ritorna i quad
  // da disegnare e i layer da saltare; fa anche un passo di build/warm-up.
  /**
   * @param {GLRenderer} renderer
   * @param {BoardManager} boards
   * @param {number} activeBoardId
   * @param {Camera} camera
   * @param {boolean} allowBuild false durante un tratto: tutta la banda al pennello
   * @returns {ProxyFrame}
   */
  update(renderer, boards, activeBoardId, camera, allowBuild) {
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
      // i board con testo restano sempre sul path per-chunk (la pila
      // contiene piani non raster: il flatten ne romperebbe l'ordine)
      const eligible = b.mgr.layers.length > 0 &&
        b.mgr.layers.every((l) => l.kind === 'raster');
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
            this._dropChunkTex(renderer, b);
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
      for (const c of l.store.map.values()) {
        if (!c.tex || c.texDirty) return false;
      }
    }
    return true;
  }

  // Il quad sta per coprire il board: le texture dei suoi chunk non servono
  // più (rinasceranno on-demand al rientro, a budget via _warm).
  /** @param {GLRenderer} renderer @param {Board} b */
  _dropChunkTex(renderer, b) {
    for (const l of b.mgr.layers) {
      l.store.forEachChunkAll((c) => renderer.disposeChunkTex(c));
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
      if (!l.visible || l.opacity <= 0) continue;
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
      bld = this._build = { boardId: candidate.board.id, key: candidate.key, li: 0, ci: 0, chunks: null };
    }
    if (!bld) return;
    const b = boards.byId(bld.boardId);
    const e = this._map.get(bld.boardId);
    const gl = renderer.gl;

    if (!this._fbo) this._fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, e.tex, 0);
    gl.viewport(0, 0, PROXY_SIZE, PROXY_SIZE);
    if (bld.li === 0 && bld.ci === 0 && bld.chunks === null) {
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

    let budget = BUILD_BUDGET;
    while (budget > 0) {
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
      gl.uniform2f(renderer.uOrigin, c.cx * CHUNK, c.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // texture creata solo per il build di un board coperto: via subito
      // (la transitoria resta ≤ budget per frame, mai l'intero board)
      if (created && e.covering) renderer.disposeChunkTex(c);
      budget--;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get gpuBytes() {
    // proxy 1024² RGBA + ~1/3 di mipmap
    return Math.round(this._map.size * PROXY_SIZE * PROXY_SIZE * 4 * 1.34);
  }
}
