// COLLABORAZIONE — sessione di disegno condivisa via WebRTC (PeerJS), gratis:
// niente server applicativo, solo il broker pubblico PeerJS per il signaling
// e STUN per il NAT traversal (TURN opzionale per le reti difficili, 4G↔4G).
//
// Modello: HOST-AUTORITÀ A STELLA. Chi crea la sessione ospita il documento;
// i guest si collegano all'host, che ordina e ritrasmette tutto. Niente CRDT:
// l'ordine dell'host È la risoluzione dei conflitti.
//
// I TRATTI viaggiano come COMANDI, non come pixel: snapshot del pennello +
// seed + speedScale + il flusso degli eventi di input (move/tick/end con i
// timestamp originali). StrokeEngine è deterministico da quegli ingressi e il
// core raster è bit-exact (wasm/js): il replay remoto produce pixel identici.
// Mentre il tratto è in corso gli stessi punti alimentano una SCIA di
// anteprima (presence.js); al pen-up il tratto entra nella coda di
// applicazione e passa per la VERA pipeline (engine→raster→commit→undo)
// appena è libera — un solo imbuto, come per lo specchio.
//
// Texture e shape del pennello sono asset content-addressed (hash FNV dei
// byte di livello 0): si trasferiscono UNA volta per connessione, le catene
// mip si ricostruiscono in locale (makeBrushTexture/makeBrushShape, identiche
// ovunque). Lo snapshot di adesione trasferisce i chunk RAW premultiplied
// compressi (deflate): bit-exact, un PNG round-trip non lo sarebbe.
//
// Le trasformazioni viaggiano live come preview leggera con lock spettatore;
// il commit resta bit-exact (comando quando deterministico, patch pixel
// quando c'è ricampionamento), così la preview non decide la convergenza.

import { brush } from './brush.js';
import { Board, bumpBoardIds, BOARD_SIZE } from './boards.js';
import { makeRasterLayer, makeTextLayer, duplicateLayer, bumpLayerIds } from './layers.js';
import { makeBrushTexture } from './texture.js';
import { makeBrushShape } from './shape.js';
import { CHUNK_BYTES, chunkKey, isChunkBlank } from './store.js';
import { freeBlockBitmap, touchText } from './text_layer.js';
import { CollabPresence } from './presence.js';
import { CollabUI } from './collab_ui.js';
import { track } from './telemetry.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */

const PROTO_VER = 1;
const PEER_NS = 'fable-paint-v1-';
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // niente 0/O/1/I
const USER_COLORS = ['#4d7cfe', '#ff5d5d', '#35c46a', '#ffb340',
  '#c77dff', '#2fd4c3', '#ff7ab8', '#b8c24d'];
const SNAP_PIECE = 128 * 1024;     // pezzi piccoli: più stabili sui data channel mobili
const DC_BUFFER_CAP = 1_000_000;   // backpressure: pausa oltre questi byte in coda
const PRESENCE_MS = 60;            // cadenza invio cursore
const WATCH_MS = 150;              // cadenza diff delle proprietà dei livelli
const PUMP_BUDGET_MS = 14;         // tempo per frame dedicato all'apply remoto

// Campi del pennello fotografati per il replay remoto (tutto ciò che
// StrokeEngine.begin e il rasterizer leggono, oltre a color/texture/shape).
const BRUSH_FIELDS = ['size', 'opacity', 'hardness', 'smoothing', 'spacing',
  'roundness', 'angle', 'rotation', 'shapeInvert', 'scatter', 'particleSize',
  'particleDensity', 'particleDeviation', 'jitterPos', 'jitterSize',
  'jitterOpacity', 'jitterSpacing', 'jitterAngle', 'jitterBright', 'jitterSat',
  'buildup', 'taperStart', 'taperEnd', 'textureOn', 'textureScale',
  'textureAngle', 'textureDepth', 'textureFloor', 'textureContrast', 'textureInvert',
  'textureMoving', 'textureUseColor', 'blurSize', 'blurStrength', 'blurOpacity',
  'blurSoftness', 'tool'];

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {Uint8Array} u8 @param {number} [h] */
function fnv(u8, h = 0x811c9dc5) {
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @type {WeakMap<object, number>} */
const hashCache = new WeakMap();
/** Hash content-addressed di texture ({mips,rgbMips}) o shape ({mips}). @param {any} a */
function assetHash(a) {
  let h = hashCache.get(a);
  if (h === undefined) {
    h = fnv(Uint8Array.of(a.w & 255, (a.w >> 8) & 255, a.h & 255, (a.h >> 8) & 255));
    h = fnv(a.mips[0], h);
    if (a.rgbMips) h = fnv(a.rgbMips[0], h);
    hashCache.set(a, h);
  }
  return h;
}

/** BinaryPack può restituire ArrayBuffer al posto dei typed array. @param {any} x */
function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (x && x.buffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
  return new Uint8Array(0);
}

/** @param {any} x */
function toF32(x) {
  if (x instanceof Float32Array) return x;
  if (x instanceof ArrayBuffer) return new Float32Array(x);
  if (x && x.buffer) return new Float32Array(x.buffer, x.byteOffset || 0, x.byteLength / 4);
  return new Float32Array(x || []);
}

/** @param {any} x */
function toU16(x) {
  if (x instanceof Uint16Array) return x;
  if (x instanceof ArrayBuffer) return new Uint16Array(x);
  if (x && x.buffer) return new Uint16Array(x.buffer, x.byteOffset || 0, x.byteLength / 2);
  return new Uint16Array(x || []);
}

/** @param {any} x */
function toU32(x) {
  if (x instanceof Uint32Array) return x;
  if (x instanceof ArrayBuffer) return new Uint32Array(x);
  if (x && x.buffer) return new Uint32Array(x.buffer, x.byteOffset || 0, x.byteLength / 4);
  return new Uint32Array(x || []);
}

const CAN_Z = typeof CompressionStream !== 'undefined';
/** @param {Uint8Array} u8 @returns {Promise<Uint8Array>} */
async function deflateBytes(u8) {
  const st = new Blob([/** @type {BlobPart} */ (u8)]).stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
/** @param {Uint8Array} u8 @returns {Promise<Uint8Array>} */
async function inflateBytes(u8) {
  const st = new Blob([/** @type {BlobPart} */ (u8)]).stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(st).arrayBuffer());
}

// Impacchetta lo stato CORRENTE dei chunk indicati: [i32 cx, i32 cy, dati]*.
// Un chunk assente resta a zero (16KB di zeri spariscono nel deflate): per
// il ricevente "tutto zero" e "assente" sono la stessa cosa.
/** @param {import('./store.js').ChunkStore} store @param {{cx: number, cy: number}[]} list */
function packCurrent(store, list) {
  const raw = new Uint8Array(list.length * (8 + CHUNK_BYTES));
  const dv = new DataView(raw.buffer);
  let off = 0;
  for (const c of list) {
    dv.setInt32(off, c.cx, true);
    dv.setInt32(off + 4, c.cy, true);
    const cur = store.get(c.cx, c.cy);
    if (cur) raw.set(cur.data, off + 8);
    off += 8 + CHUNK_BYTES;
  }
  return raw;
}

/** @param {import('./store.js').ChunkStore} store @returns {{cx: number, cy: number}[]} */
function nonBlankChunkList(store) {
  const list = [];
  for (const c of store.map.values()) if (!isChunkBlank(c)) list.push({ cx: c.cx, cy: c.cy });
  return list;
}

function makeCode() {
  const v = new Uint8Array(6);
  crypto.getRandomValues(v);
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ABC[v[i] % CODE_ABC.length];
  return s;
}

/** @type {any} */
let PeerCtor = null;
async function loadPeerJs() {
  if (PeerCtor) return PeerCtor;
  if (!(/** @type {any} */ (window).Peer)) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('PeerJS is unreachable: an internet connection is required.'));
      document.head.appendChild(s);
    });
  }
  PeerCtor = /** @type {any} */ (window).Peer;
  return PeerCtor;
}

function iceConfig() {
  /** @type {any[]} */
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  try {
    const turn = JSON.parse(localStorage.getItem('fable-paint.turn') || 'null');
    if (Array.isArray(turn)) servers.push(...turn);
    else if (turn && turn.urls) servers.push(turn);
  } catch { /* JSON invalido: si va di solo STUN */ }
  return { iceServers: servers };
}

export class Collab {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    // config TURN portata dal LINK (#turn=<JSON urlencoded>): per passare le
    // credenziali a un telefono senza digitarle — si salva e sparisce
    // dall'URL. Va letta PRIMA di costruire la UI (che mostra il campo).
    try {
      const m = /[#&]turn=([^&]+)/.exec(location.hash);
      if (m) {
        const json = decodeURIComponent(m[1]);
        JSON.parse(json); // valida: hash rotto = ignorato
        localStorage.setItem('fable-paint.turn', json);
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch { /* hash invalido o storage negato */ }
    this.presence = new CollabPresence();
    this.ui = new CollabUI(this);

    /** @type {any} */ this.peer = null;
    /** @type {''|'host'|'guest'} */ this.role = '';
    this.code = '';
    this.uid = 0;
    this.myName = '';
    this.syncing = false;      // guest: snapshot in arrivo/applicazione
    // si TRASMETTE solo a sessione stabilita (host: subito; guest: dopo lo
    // snapshot). Prima di allora ogni invio finirebbe su una DataConnection
    // non ancora aperta: PeerJS non lancia, logga ed emette 'error' — che il
    // guest leggerebbe come "connessione fallita" abortendo il join.
    this._ready = false;

    // host: connessioni vive {conn, uid, name, color, state, seen, hold}
    /** @type {any[]} */ this._conns = [];
    this._nextSlot = 1;
    // guest: l'unica connessione verso l'host
    /** @type {any} */ this._host = null;

    // roster {uid -> {name, color}} (host incluso)
    /** @type {Map<number, {name: string, color: string}>} */
    this.users = new Map();

    // coda FIFO di applicazione (tratti finiti, op, job snapshot dell'host):
    // si svuota nel frame loop quando la pipeline locale è libera
    /** @type {any[]} */ this._jobs = [];
    // un job asincrono (undo/redo: decompressione nel worker) in volo:
    // blocca pump e nuovi tratti finché non è atterrato
    this._busy = false;

    // undo collaborativo PER-UTENTE: ogni op annullabile ha un cid 'uid:n';
    // il tuo Ctrl+Z annulla la TUA ultima op ovunque sia nella storia
    this._opN = 0;
    /** @type {string|null} */ this._pendingCid = null; // cid del commit locale in corso
    /** @type {Set<string>} */ this._pendingUndoCids = new Set(); // già in coda
    /** @type {Set<string>} */ this._pendingRedoCids = new Set();

    // tratto locale in uscita: buffer eventi svuotato una volta a frame
    /** @type {{sid: number, ev: number[]}|null} */ this._out = null;
    this._sid = 0;

    // tratti remoti in corso (uid -> meta+eventi accumulati)
    /** @type {Map<number, any>} */ this._rs = new Map();

    // asset pennello: hash -> {k, obj} ricostruiti; raw per il relay host
    /** @type {Map<number, any>} */ this._assets = new Map();
    /** @type {Map<number, any>} */ this._assetRaw = new Map();
    /** @type {Set<number>} */ this._sentToHost = new Set();

    // snapshot in ricezione (guest)
    /** @type {any} */ this._snMeta = null;
    /** @type {Map<number, Uint8Array[]>} */ this._snParts = new Map();

    // diff-watcher delle proprietà dei livelli
    /** @type {Map<number, string>} */ this._shadow = new Map();
    // ...e del CONTENUTO dei livelli testo (item+style come firma JSON: la UI
    // del testo e il gizmo distort mutano inline da decine di punti)
    /** @type {Map<number, string>} */ this._tshadow = new Map();
    this._watchT = 0;

    // stato di rete per connessione (uid -> {label, cls}), letto dal pannello
    /** @type {Map<number, {label: string, cls: string}>} */
    this._net = new Map();
    this._netT = 0;

    // trasferimenti grossi (patch di pixel di effetti/fill, import immagine):
    // pezzi 'pp' accumulati per mittente+id; l'op che li referenzia arriva
    // DOPO sullo stesso canale ordinato, quindi quando l'op entra in coda i
    // pezzi ci sono già — niente attese né stalli
    /** @type {Map<string, Uint8Array[]>} */
    this._parts = new Map();
    this._blobN = 0;
    // mentre un big-send è in volo, le trasmissioni proprie si accodano in
    // ordine: la convergenza vive sull'ordine PER-MITTENTE (la patch deve
    // arrivare prima del tratto/undo successivo dello stesso autore).
    /** @type {any[]|null} */
    this._outHold = null;
    this._bigChain = Promise.resolve();
    this._muteAddOnce = false; // l'attach interno di importImageLayer non broadcasta ladd
    this._muteTform = false;   // pushStruct 'textform' da apply remoto: no ribroadcast
    this._skipNextAutoPixelPatch = false;
    this._remoteTfActive = false;
    this._remoteTfUid = -1;
    this._remoteTf = null;
    this._remoteTfKey = '';
    this._remoteTfRenderId = 0;
    this._remoteTfSeq = 0;
    this._localTfLive = false;

    // presenza in uscita
    this._prT = 0;
    this._prX = -1e9; this._prY = -1e9; this._prD = false;
    this._ptrX = -1; this._ptrY = -1; this._ptrSeen = false;
    const onPtr = (/** @type {PointerEvent} */ e) => {
      this._ptrX = e.clientX; this._ptrY = e.clientY; this._ptrSeen = true;
    };
    app.planesEl.addEventListener('pointermove', onPtr, { passive: true });
    app.planesEl.addEventListener('pointerdown', onPtr, { passive: true });

    // patch reversibili (lockdown + hook di replica struttura)
    /** @type {Array<[any, string, any]>} */ this._patches = [];
    this._mute = false;
    this._tmpW = { x: 0, y: 0 };
  }

  get active() { return this.role !== ''; }

  /** Un undo/redo remoto è in applicazione: l'App non deve far partire tratti. */
  get applying() { return this._busy; }

  get remoteTransformActive() { return this._remoteTfActive; }

  get canSendPixelPatch() { return this._ready; }

  suppressNextAutoPixelPatch() {
    this._skipNextAutoPixelPatch = true;
  }

  /**
   * Pubblica il risultato corrente di alcuni chunk come patch bit-exact.
   * Usato dai tool che non sono replay deterministici, come il pennello blur.
   * @param {number} layerId
   * @param {{cx: number, cy: number}[]} chunks
   */
  sendPixelPatch(layerId, chunks) {
    if (!this._ready || !chunks.length) return;
    const layer = this.app.boards.layerById(layerId);
    if (!layer || !layer.store) return;
    const ncid = this._nextCid();
    this._tagNewEntry(ncid);
    const raw = packCurrent(layer.store, chunks);
    this._sendBig({ k: 'pix', l: layerId, cid: ncid }, raw);
  }

  /** @param {any} frame */
  transformLive(frame) {
    if (!this._ready || this._remoteTfActive) return;
    this._localTfLive = true;
    this._broadcast({ t: 'tf', u: this.uid, k: 'u', f: frame }, null);
  }

  transformDone() {
    if (!this._ready || !this._localTfLive) return;
    this._localTfLive = false;
    this._broadcast({ t: 'tf', u: this.uid, k: 'x' }, null);
  }

  /** @returns {import('./renderer_gl.js').TransformFrame|null} */
  transformFrame() {
    if (!this._remoteTfActive || !this._remoteTf) return null;
    const f = this._remoteTf;
    const layer = this.app.boards.layerById(f.layerId);
    if (!layer || !layer.store) return null;
    return {
      id: f.id, layerId: f.layerId, store: layer.store,
      x: f.x, y: f.y, w: f.w, h: f.h,
      m: f.m,
      warp: f.warp,
      persp: f.persp,
      puppet: f.puppet,
      clip: f.clip,
    };
  }

  /** @param {number} uid @param {number} [layerId] */
  _clearRemoteTransform(uid = this._remoteTfUid, layerId = 0) {
    if (!this._remoteTfActive || uid !== this._remoteTfUid) return;
    if (layerId && this._remoteTf && this._remoteTf.layerId !== layerId) return;
    this._remoteTfActive = false;
    this._remoteTfUid = -1;
    this._remoteTf = null;
    this._remoteTfKey = '';
    this._remoteTfRenderId = 0;
    this.ui.standby(false);
    this.app.planes.invalidate();
  }

  /** @param {number} uid @param {any} m */
  _onRemoteTransform(uid, m) {
    if (m.k === 'x' || m.k === 'c') {
      this._clearRemoteTransform(uid);
      return;
    }
    if (m.k !== 'u') return;
    if (this._remoteTfActive && this._remoteTfUid !== uid) return;
    // Se l'utente locale stava aprendo una trasformazione, la lascia andare:
    // il lock remoto vince per evitare due preview sullo stesso imbuto.
    if (this.app.transform.active) this.app.transform.cancel();
    const key = m.f ? `${uid}:${m.f.id}:${m.f.layerId}:${m.f.x}:${m.f.y}:${m.f.w}:${m.f.h}` : `${uid}:empty`;
    if (!this._remoteTfActive || this._remoteTfUid !== uid || this._remoteTfKey !== key) {
      this._remoteTfKey = key;
      this._remoteTfRenderId = 9_000_000_000 + ++this._remoteTfSeq;
    }
    this._remoteTfActive = true;
    this._remoteTfUid = uid;
    this._remoteTf = m.f ? this._hydrateTransformFrame(m.f, this._remoteTfRenderId) : null;
    const who = this.users.get(uid);
    this.ui.standby(true, `${who ? who.name : 'Another user'} is transforming...`);
    this.app.planes.invalidate();
  }

  /** @param {any} f @param {number} renderId */
  _hydrateTransformFrame(f, renderId) {
    const puppet = f.puppet ? {
      pos: toF32(f.puppet.pos),
      uv: toF32(f.puppet.uv),
      idx: toU16(f.puppet.idx),
      pos0: toF32(f.puppet.pos0),
      tris: toU32(f.puppet.tris),
      order: toU32(f.puppet.order),
      ver: f.puppet.ver,
      meshVer: f.puppet.meshVer,
    } : null;
    return {
      id: renderId,
      layerId: f.layerId,
      x: f.x, y: f.y, w: f.w, h: f.h,
      m: Array.isArray(f.m) ? f.m.slice() : Array.from(f.m || [1, 0, 0, 1, 0, 0]),
      clip: f.clip,
      warp: f.warp ? {
        pts: toF32(f.warp.pts), n: f.warp.n, ver: f.warp.ver,
        bx: f.warp.bx, by: f.warp.by, bw: f.warp.bw, bh: f.warp.bh,
      } : null,
      persp: f.persp ? {
        q: toF32(f.persp.q), ver: f.persp.ver,
        bx: f.persp.bx, by: f.persp.by, bw: f.persp.bw, bh: f.persp.bh,
      } : null,
      puppet,
    };
  }

  // ---- ciclo di vita della sessione ----

  /** @param {string} name */
  async host(name) {
    if (this.role) return;
    this.myName = name;
    this.ui.setBusy('Creating session...');
    try {
      const Peer = await loadPeerJs();
      // due tentativi: il codice potrebbe (rarissimo) essere già in uso
      for (let attempt = 0; ; attempt++) {
        const code = makeCode();
        try {
          this.peer = await this._openPeer(Peer, PEER_NS + code);
          this.code = code;
          break;
        } catch (err) {
          if (attempt >= 1) throw err;
        }
      }
    } catch (err) {
      this.ui.fail(err instanceof Error ? err.message : 'Connection failed.');
      track('collab_host_failed', { message: err instanceof Error ? err.message : String(err) });
      this._teardownPeer();
      return;
    }
    this.role = 'host';
    this.uid = 0;
    this.users.clear();
    this.users.set(0, { name: this.myName, color: USER_COLORS[0] });
    this.peer.on('connection', (/** @type {any} */ conn) => this._onGuest(conn));
    this.peer.on('error', (/** @type {any} */ e) => this._onPeerError(e));
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch { /* già chiuso */ } });
    this._begin();
    this._ready = true;
    this.ui.setLive();
    track('collab_host_started');
  }

  /** @param {string} name @param {string} code */
  async join(name, code) {
    if (this.role) return;
    this.myName = name;
    code = code.trim().toUpperCase();
    if (code.length < 4) { this.ui.toast('Invalid code.'); return; }
    this.ui.setBusy('Connecting...');
    try {
      const Peer = await loadPeerJs();
      this.peer = await this._openPeer(Peer, undefined);
    } catch (err) {
      this.ui.fail(err instanceof Error ? err.message : 'Connection failed.');
      track('collab_join_failed', { stage: 'peer_open', message: err instanceof Error ? err.message : String(err) });
      this._teardownPeer();
      return;
    }
    this.role = 'guest';
    this.code = code;
    this.peer.on('error', (/** @type {any} */ e) => this._onPeerError(e));
    const conn = this.peer.connect(PEER_NS + code, { reliable: true });
    this._host = conn;
    let opened = false;
    conn.on('open', () => {
      opened = true;
      conn.send({ t: 'hi', ver: PROTO_VER, n: this.myName });
      this.ui.setBusy('Waiting for canvas...');
      track('collab_join_connected');
    });
    conn.on('data', (/** @type {any} */ m) => this._onData(conn, m));
    conn.on('close', () => this._sessionDead('Session ended by the host.'));
    conn.on('error', () => {
      if (!opened) this._diagnoseFail(conn).then((msg) => this._sessionDead(msg));
    });
    setTimeout(() => {
      if (this.role === 'guest' && !opened) {
        this._diagnoseFail(conn).then((msg) => this._sessionDead(msg));
      }
    }, 15000);
  }

  // La connessione al peer non è arrivata: invece del generico "fallita",
  // si legge dalle stats ICE il PERCHÉ — la stessa diagnosi che si farebbe
  // a mano su chrome://webrtc-internals.
  /** @param {any} conn @returns {Promise<string>} */
  async _diagnoseFail(conn) {
    const turnCfg = iceConfig().iceServers.some((s) => String(s.urls).includes('turn'));
    const pc = conn && conn.peerConnection;
    if (!pc) {
      return 'No response from the broker: check the code and make sure both users are online.';
    }
    let srflx = false, relay = false, anyCand = false;
    try {
      const stats = await pc.getStats();
      stats.forEach((/** @type {any} */ s) => {
        if (s.type !== 'local-candidate') return;
        anyCand = true;
        if (s.candidateType === 'srflx') srflx = true;
        if (s.candidateType === 'relay') relay = true;
      });
    } catch { /* stats non disponibili: messaggio generico */ }
    if (anyCand && !srflx && !relay) {
      return 'Connection failed: your network appears to block STUN/UDP. ' +
        'Configure TURN over TCP/443 (Collaborate panel → Difficult Networks).';
    }
    if (srflx && !turnCfg) {
      return 'Connection failed: incompatible NATs (classic WiFi↔4G). ' +
        'A TURN server is required: Collaborate panel → Difficult Networks.';
    }
    if (srflx && turnCfg && !relay) {
      return 'Connection failed: the configured TURN server is not responding (credentials or address). ' +
        'Check it with "Test STUN/TURN" in the panel.';
    }
    return 'No response: check the code, or configure TURN (panel → Difficult Networks).';
  }

  // Test ICE standalone (senza peer): che candidati ottiene QUESTA rete con
  // gli iceServers correnti? srflx = STUN ok, relay = TURN ok. È il Trickle
  // ICE ufficiale, in casa.
  /** @returns {Promise<{host: boolean, srflx: boolean, relay: boolean, turnConfigured: boolean}>} */
  async testIce(timeoutMs = 8000) {
    const cfg = iceConfig();
    const turnConfigured = cfg.iceServers.some((s) => String(s.urls).includes('turn'));
    const pc = new RTCPeerConnection(cfg);
    pc.createDataChannel('probe');
    const found = { host: false, srflx: false, relay: false };
    const done = new Promise((resolve) => {
      const to = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (e) => {
        if (!e.candidate) { clearTimeout(to); resolve(undefined); return; }
        const t = e.candidate.type ||
          (/ typ (\w+)/.exec(e.candidate.candidate || '') || [])[1];
        if (t === 'host') found.host = true;
        else if (t === 'srflx') found.srflx = true;
        else if (t === 'relay') found.relay = true;
        // tutto trovato: inutile aspettare la fine della raccolta
        if (found.srflx && (!turnConfigured || found.relay)) { clearTimeout(to); resolve(undefined); }
      };
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await done;
    } finally {
      pc.close();
    }
    return { ...found, turnConfigured };
  }

  leave() {
    if (!this.role) return;
    const msg = { t: 'bye' };
    if (this.role === 'host') {
      for (const g of this._conns) {
        if (g.conn.open) { try { g.conn.send(msg); } catch { /* già chiusa */ } }
      }
    } else if (this._host && this._host.open) {
      try { this._host.send(msg); } catch { /* già chiusa */ }
    }
    this._sessionDead('');
  }

  /** @param {any} Peer @param {string|undefined} id */
  _openPeer(Peer, id) {
    return new Promise((resolve, reject) => {
      const p = new Peer(id, { config: iceConfig(), debug: 1 });
      let done = false;
      p.on('open', () => { if (!done) { done = true; resolve(p); } });
      p.on('error', (/** @type {any} */ e) => {
        if (!done) {
          done = true;
          try { p.destroy(); } catch { /* best effort */ }
          reject(new Error(e && e.type === 'unavailable-id'
            ? 'code already in use' : 'PeerJS broker is unreachable.'));
        }
      });
      setTimeout(() => { if (!done) { done = true; try { p.destroy(); } catch { /* */ } reject(new Error('Broker connection timed out.')); } }, 12000);
    });
  }

  // Attiva la sessione lato locale: lockdown, watcher, presenza.
  _begin() {
    const a = this.app;
    a._flushPendingStroke();
    for (const t of a.fxTools) if (t.pending) t.cancel();
    // undo per-utente: il redo diventa selettivo per autore; le entry
    // preesistenti perdono ogni cid (non sono replicabili: gli altri peer
    // non le hanno) e il redo pendente si svuota
    a.undoMgr.selectiveRedo = true;
    a.undoMgr.dropRedoAll();
    for (const e of a.undoMgr.undoStack) delete e.cid;
    this._opN = 0;
    this._pendingCid = null;
    this._skipNextAutoPixelPatch = false;
    this._remoteTfActive = false;
    this._remoteTfUid = -1;
    this._remoteTf = null;
    this._remoteTfKey = '';
    this._remoteTfRenderId = 0;
    this._localTfLive = false;
    this._pendingUndoCids.clear();
    this._pendingRedoCids.clear();
    this._applyPatches();
    a.ui.updateUndoButtons(a.undoMgr); // i bottoni passano alla logica per-utente
    document.body.classList.add('collab-on');
    this._shadow.clear();
    this._tshadow.clear();
    for (const b of a.boards.boards) {
      for (const l of b.mgr.layers) {
        this._shadow.set(l.id, this._sig(l));
        if (l.kind === 'text') this._tshadow.set(l.id, this._tsig(l));
      }
    }
    this._jobs.length = 0;
    this._rs.clear();
    this._assets.clear();
    this._assetRaw.clear();
    this._sentToHost.clear();
  }

  /** @param {string} msg vuoto = uscita volontaria, senza toast */
  _sessionDead(msg) {
    if (!this.role && !this.peer) return;
    this.role = '';
    this._teardownPeer();
    this._conns = [];
    this._host = null;
    this._nextSlot = 1;
    this.users.clear();
    this._jobs.length = 0;
    this._rs.clear();
    this._out = null;
    this.syncing = false;
    this._ready = false;
    this._snMeta = null;
    this._snParts.clear();
    this.presence.clear();
    this._net.clear();
    this._parts.clear();
    this._tshadow.clear();
    this._outHold = null;
    this.app.undoMgr.selectiveRedo = false;
    this._pendingCid = null;
    this._skipNextAutoPixelPatch = false;
    this._remoteTfActive = false;
    this._remoteTfUid = -1;
    this._remoteTf = null;
    this._remoteTfKey = '';
    this._remoteTfRenderId = 0;
    this._localTfLive = false;
    this._pendingUndoCids.clear();
    this._pendingRedoCids.clear();
    this._removePatches();
    this.app.ui.updateUndoButtons(this.app.undoMgr); // bottoni alla logica normale
    document.body.classList.remove('collab-on');
    this.ui.setIdle();
    this.ui.syncOverlay(false);
    this.ui.standby(false);
    this.app.planes.invalidate();
    if (msg) this.ui.toast(msg);
  }

  _teardownPeer() {
    if (this.peer) { try { this.peer.destroy(); } catch { /* best effort */ } }
    this.peer = null;
  }

  /** @param {any} e */
  _onPeerError(e) {
    const t = e && e.type;
    if (t === 'peer-unavailable') this._sessionDead('Session not found: wrong code or host offline.');
    else if (this.role === 'guest') this._sessionDead('Network error: session closed.');
    else if (this.role === 'host') this.ui.toast('Network warning: ' + (t || 'error'));
  }

  // ---- host: gestione guest ----

  /** @param {any} conn */
  _onGuest(conn) {
    conn.on('data', (/** @type {any} */ m) => this._onData(conn, m));
    conn.on('close', () => this._dropGuest(conn));
    conn.on('error', () => this._dropGuest(conn));
  }

  /** @param {any} conn */
  _dropGuest(conn) {
    const i = this._conns.findIndex((g) => g.conn === conn);
    if (i < 0) return;
    const g = this._conns[i];
    this._conns.splice(i, 1);
    this.users.delete(g.uid);
    this._rs.delete(g.uid);
    this._net.delete(g.uid);
    this._clearRemoteTransform(g.uid);
    for (const key of this._parts.keys()) {
      if (key.startsWith(g.uid + ':')) this._parts.delete(key);
    }
    this.presence.remove(g.uid);
    this._broadcast({ t: 'ul', u: g.uid }, null);
    this.ui.renderUsers();
  }

  // Invia a tutti i guest (host) o all'host (guest). skip: conn da saltare.
  // Mai inviare su una conn non aperta: PeerJS logga + emette 'error'.
  // Con un big-send in volo (_outHold) il messaggio si accoda: l'ordine
  // per-mittente è il contratto su cui i peer convergono.
  /** @param {any} msg @param {any} skip */
  _broadcast(msg, skip) {
    if (this._outHold) { this._outHold.push(['b', msg, skip]); return; }
    this._sendNow(msg, skip);
  }

  /** @param {any} msg @param {any} skip */
  _sendNow(msg, skip) {
    if (this.role === 'host') {
      for (const g of this._conns) {
        if (g.conn === skip || g.state === 'wait') continue;
        if (g.hold) g.hold.push(msg);
        else if (g.conn.open) { try { g.conn.send(msg); } catch { /* drop: la close arriverà */ } }
      }
    } else if (this._host && this._host.open) {
      try { this._host.send(msg); } catch { /* drop */ }
    }
  }

  /** @param {any} o @param {any} [skip] @param {number} [uid] */
  _sendOp(o, skip = null, uid = this.uid) {
    this._broadcast({ t: 'op', u: uid, o }, skip);
  }

  // ---- trasferimenti grossi (patch pixel, import) ----

  // Comprimi e spedisci a pezzi, poi l'op che li referenzia (o.pid). Le op
  // grosse dello stesso mittente si serializzano nella stessa coda dei
  // messaggi normali: undo/redo non possono scavalcare la patch a cui si
  // riferiscono.
  /** @param {any} o @param {Uint8Array} raw */
  _sendBig(o, raw) {
    if (this._outHold) {
      this._outHold.push(['g', o, raw]);
      return;
    }
    this._outHold = [];
    this._bigChain = this._bigChain
      .then(() => this._runBigQueue(o, raw))
      .catch((err) => console.error('[collab] sendBig', err));
  }

  /** @param {any} o @param {Uint8Array} raw */
  async _runBigQueue(o, raw) {
    try {
      try {
        await this._sendBigPayload(o, raw);
      } catch (err) {
        console.error('[collab] sendBig payload', err);
      }
      const held = this._outHold;
      while (this.role && held && held.length) {
        const it = held.shift();
        if (it[0] === 'b') {
          this._sendNow(it[1], it[2]);
        } else if (it[0] === 's') {
          this._sendStrokeMsgNow(it[1]);
        } else if (it[0] === 'g') {
          try {
            await this._sendBigPayload(it[1], it[2]);
          } catch (err) {
            console.error('[collab] sendBig queued', err);
          }
        }
      }
    } finally {
      this._outHold = null;
    }
  }

  /** @param {any} o @param {Uint8Array} raw */
  async _sendBigPayload(o, raw) {
    if (!this.role || !this._ready) return;
    const buf = CAN_Z ? await deflateBytes(raw) : raw;
    if (!this.role || !this._ready) return;
    const id = ++this._blobN;
    const parts = Math.ceil(buf.length / SNAP_PIECE);
    for (let off = 0; off < buf.length; off += SNAP_PIECE) {
      const i = Math.floor(off / SNAP_PIECE);
      const piece = new Uint8Array(buf.subarray(off, Math.min(buf.length, off + SNAP_PIECE)));
      await this._waitBuffers();
      if (!this.role || !this._ready) return; // sessione morta/resync a meta' invio
      this._sendNow({
        t: 'pp', id, i, n: parts, last: i === parts - 1,
        buf: piece, u: this.uid,
      }, null);
    }
    o.pid = id;
    o.z = CAN_Z ? 1 : 0;
    o.parts = parts;
    o.raw = raw.length;
    o.hash = fnv(raw);
    this._sendNow({ t: 'op', u: this.uid, o }, null);
  }

  // Backpressure: aspetta che i dataChannel vivi abbiano spazio in coda.
  async _waitBuffers() {
    for (;;) {
      let busy = false;
      const dcs = this.role === 'host'
        ? this._conns.filter((g) => g.state !== 'wait' && !g.hold).map((g) => g.conn.dataChannel)
        : (this._host ? [this._host.dataChannel] : []);
      for (const dc of dcs) {
        if (dc && dc.bufferedAmount > DC_BUFFER_CAP) { busy = true; break; }
      }
      if (!busy) return;
      await sleep(50);
    }
  }

  /**
   * Pezzi accumulati di (mittente, id), consumati una volta.
   * @param {number} uid @param {number} pid @param {number} [expected]
   */
  _takeParts(uid, pid, expected) {
    if (expected === 0) return new Uint8Array(0);
    const key = uid + ':' + pid;
    const arr = this._parts.get(key);
    if (!arr || arr.length === 0) return null;
    const n = Number.isInteger(expected) && expected !== undefined ? expected : arr.length;
    if (arr.length < n) {
      this._parts.delete(key);
      return null;
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!arr[i]) {
        this._parts.delete(key);
        return null;
      }
      total += arr[i].length;
    }
    const joined = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < n; i++) { joined.set(arr[i], off); off += arr[i].length; }
    this._parts.delete(key);
    return joined;
  }

  // ---- dispatch messaggi ----

  /** @param {any} conn @param {any} m */
  _onData(conn, m) {
    if (!m || typeof m.t !== 'string' || !this.role) return;
    const host = this.role === 'host';
    /** @type {any} */
    const g = host ? this._conns.find((x) => x.conn === conn) : null;

    switch (m.t) {
      case 'hi': {
        if (!host) return;
        if (m.ver !== PROTO_VER) {
          try { conn.send({ t: 'err', m: 'Versione app diversa: aggiorna entrambe.' }); } catch { /* */ }
          setTimeout(() => conn.close(), 200);
          return;
        }
        const slot = this._nextSlot++;
        const color = USER_COLORS[slot % USER_COLORS.length];
        const name = String(m.n || 'Ospite').slice(0, 20);
        const guest = {
          conn, uid: slot, name, color, state: 'wait', seen: new Set(),
          hold: /** @type {any[]|null} */ (null),
        };
        this._conns.push(guest);
        this.users.set(slot, { name, color });
        this.presence.ensureUser(slot, name, color);
        const users = [...this.users.entries()].map(([u, x]) => ({ u, n: x.name, c: x.color }));
        try {
          conn.send({
            t: 'wel', u: slot, users,
            lb: slot * 1_000_000, bb: slot * 100_000,
          });
        } catch { /* la close arriverà */ }
        // lo snapshot parte dal frame loop quando la pipeline è libera: il
        // taglio è netto rispetto a tratti e op in coda
        this._jobs.push({ kind: 'snap', guest });
        this.ui.renderUsers();
        return;
      }
      case 'err':
        this._sessionDead(String(m.m || 'Rejected by the host.'));
        return;
      case 'wel': {
        if (host) return;
        this.uid = m.u;
        bumpLayerIds(m.lb);
        bumpBoardIds(m.bb);
        this.users.clear();
        for (const u of m.users) {
          this.users.set(u.u, { name: u.n, color: u.c });
          if (u.u !== this.uid) this.presence.ensureUser(u.u, u.n, u.c);
        }
        this._begin();
        this.syncing = true;
        this.ui.syncOverlay(true, 'Receiving canvas...');
        return;
      }
      case 'uj': {
        if (host) return;
        this.users.set(m.u.u, { name: m.u.n, color: m.u.c });
        if (m.u.u !== this.uid) this.presence.ensureUser(m.u.u, m.u.n, m.u.c);
        this.ui.renderUsers();
        return;
      }
      case 'ul': {
        if (host) return;
        this.users.delete(m.u);
        this._rs.delete(m.u);
        this.presence.remove(m.u);
        this.ui.renderUsers();
        return;
      }
      case 'bye': {
        if (host) { if (g) this._dropGuest(conn); }
        else this._sessionDead('The host closed the session.');
        return;
      }

      case 'sn0':
        if (host) return;
        this._ready = false;
        this.syncing = true;
        this._jobs.length = 0;
        this._parts.clear();
        this._rs.clear();
        this._snMeta = m.doc;
        this._snParts.clear();
        this.ui.syncOverlay(true, 'Receiving canvas...');
        return;
      case 'sn1': {
        if (host) return;
        let parts = this._snParts.get(m.l);
        if (!parts) { parts = []; this._snParts.set(m.l, parts); }
        parts.push(toU8(m.buf));
        return;
      }
      case 'sn2':
        if (host) return;
        this._applySnapshot().catch((err) => {
          console.error('[collab] snapshot', err);
          this._sessionDead('Synchronization failed.');
        });
        return;
      case 'rdy':
        if (host && g && g.state !== 'live') {
          g.state = 'live';
          this._broadcast({ t: 'uj', u: { u: g.uid, n: g.name, c: g.color } }, conn);
        }
        return;

      case 'pr': {
        // l'host accetta solo da guest già 'live' (post-snapshot)
        const uid = host ? (g && g.state === 'live' ? g.uid : -1) : m.u;
        if (uid < 0 || uid === this.uid) return;
        this.presence.cursor(uid, m.x, m.y, !!m.d);
        if (host) this._broadcast({ t: 'pr', u: uid, x: m.x, y: m.y, d: m.d }, conn);
        return;
      }

      case 'pp': {
        // pezzo di un trasferimento grosso: accumulato per mittente+id e
        // consumato dall'op che lo referenzia (stesso canale = ordine certo)
        const uid = host ? (g && g.state === 'live' ? g.uid : -1) : m.u;
        if (uid < 0 || uid === this.uid) return;
        if (host) this._broadcast({
          t: 'pp', id: m.id, i: m.i, n: m.n, last: m.last,
          buf: m.buf, u: uid,
        }, conn);
        const key = uid + ':' + m.id;
        let arr = this._parts.get(key);
        if (!arr) { arr = []; this._parts.set(key, arr); }
        const part = toU8(m.buf);
        if (Number.isInteger(m.i) && m.i >= 0) arr[m.i] = part;
        else arr.push(part);
        return;
      }

      case 'rsq':
        if (host && g && g.conn.open) {
          this.ui.toast(`${g.name} requested a canvas re-sync.`);
          this._jobs.push({ kind: 'snap', guest: g });
        }
        return;

      case 'sb': case 'sp': case 'se': case 'sx': {
        const uid = host ? (g && g.state === 'live' ? g.uid : -1) : m.u;
        if (uid < 0 || uid === this.uid) return;
        if (host) this._relayStroke(m, conn, g);
        this._onRemoteStroke(uid, m);
        return;
      }

      case 'op': {
        const uid = host ? (g && g.state === 'live' ? g.uid : -1) : m.u;
        if (uid < 0 || uid === this.uid) return;
        if (host) this._sendOp(m.o, conn, uid);
        this._jobs.push({ kind: 'op', uid, o: m.o });
        return;
      }

      case 'tf': {
        const uid = host ? (g && g.state === 'live' ? g.uid : -1) : m.u;
        if (uid < 0 || uid === this.uid) return;
        if (m.k === 'u' && (this._localTfLive ||
          (this._remoteTfActive && this._remoteTfUid !== uid))) return;
        if (host) this._broadcast({ t: 'tf', u: uid, k: m.k, f: m.f }, conn);
        this._onRemoteTransform(uid, m);
        return;
      }
    }
  }

  // Host: ritrasmette i messaggi di tratto agli altri guest, ricompletando
  // gli asset per chi non li ha ancora visti (i late joiner non hanno visto
  // i primi invii).
  /** @param {any} m @param {any} fromConn @param {any} fromGuest */
  _relayStroke(m, fromConn, fromGuest) {
    if (m.t === 'sb' && m.as) {
      for (const raw of m.as) {
        this._assetRaw.set(raw.a, raw);
        if (fromGuest) fromGuest.seen.add(raw.a);
      }
    }
    if (m.t !== 'sb') {
      this._broadcast({ ...m, u: fromGuest ? fromGuest.uid : 0 }, fromConn);
      return;
    }
    const uid = fromGuest ? fromGuest.uid : 0;
    const need = [];
    if (m.br.tx) need.push(m.br.tx);
    if (m.br.sh) need.push(m.br.sh);
    for (const gst of this._conns) {
      if (gst.conn === fromConn || gst.state === 'wait') continue;
      /** @type {any} */
      const out = { ...m, u: uid };
      const missing = need.filter((h) => !gst.seen.has(h) && this._assetRaw.has(h));
      if (missing.length) {
        out.as = missing.map((h) => this._assetRaw.get(h));
        for (const h of missing) gst.seen.add(h);
      } else {
        delete out.as;
      }
      if (gst.hold) gst.hold.push(out);
      else if (gst.conn.open) { try { gst.conn.send(out); } catch { /* drop */ } }
    }
  }

  // ---- tratti remoti: accumulo + scia ----

  /** @param {number} uid @param {any} m */
  _onRemoteStroke(uid, m) {
    const meta = this.users.get(uid);
    switch (m.t) {
      case 'sb': {
        const old = this._rs.get(uid);
        if (old) this.presence.trailEnd(uid, old.sid); // se/sx perso: si riparte
        if (m.as) {
          for (const raw of m.as) this._unpackAsset(raw);
        }
        this._rs.set(uid, {
          sid: m.sid, b: m.b, l: m.l, mx: m.mx, sc: m.sc, seed: m.seed,
          br: m.br, x: m.x, y: m.y, p: m.p, tm: m.tm, ev: [],
        });
        const c = m.br.f.tool === 'eraser'
          ? '#9aa0ab' : `rgb(${m.br.c[0]},${m.br.c[1]},${m.br.c[2]})`;
        this.presence.trailBegin(uid, m.sid, {
          color: c, size: m.br.f.size, eraser: m.br.f.tool === 'eraser',
          opacity: m.br.f.buildup ? 1 : m.br.f.opacity,
        }, m.x, m.y);
        if (meta) this.presence.cursor(uid, m.x, m.y, true);
        return;
      }
      case 'sp': {
        const rs = this._rs.get(uid);
        if (!rs || rs.sid !== m.sid) return;
        const ev = m.ev;
        for (let i = 0; i < ev.length; i += 5) {
          rs.ev.push(ev[i], ev[i + 1], ev[i + 2], ev[i + 3], ev[i + 4]);
          if (ev[i] === 0) this.presence.trailPoint(uid, ev[i + 1], ev[i + 2]);
        }
        const last = ev.length - 5;
        if (last >= 0 && ev[last] === 0 && meta) {
          this.presence.cursor(uid, ev[last + 1], ev[last + 2], true);
        }
        return;
      }
      case 'se': {
        const rs = this._rs.get(uid);
        if (!rs || rs.sid !== m.sid) return;
        this._rs.delete(uid);
        this.presence.trailPoint(uid, m.x, m.y);
        this._jobs.push({
          kind: 'stroke', uid, ...rs,
          ex: m.x, ey: m.y, ep: m.p, etm: m.tm, cid: m.cid,
        });
        if (meta) this.presence.cursor(uid, m.x, m.y, false);
        return;
      }
      case 'sx': {
        const rs = this._rs.get(uid);
        if (rs && rs.sid === m.sid) {
          this._rs.delete(uid);
          this.presence.trailEnd(uid, m.sid);
        }
        return;
      }
    }
  }

  /** @param {any} raw */
  _unpackAsset(raw) {
    if (this._assets.has(raw.a)) return;
    try {
      if (raw.k === 't') {
        this._assets.set(raw.a, {
          k: 't',
          obj: makeBrushTexture(String(raw.n || 'texture'), raw.w, raw.h, toU8(raw.l), toU8(raw.r)),
        });
      } else {
        this._assets.set(raw.a, {
          k: 's',
          obj: makeBrushShape(String(raw.n || 'shape'), raw.w, raw.h, toU8(raw.p)),
        });
      }
      // anche il ricevente li conosce: se li userà a sua volta, l'host li ha già
      this._sentToHost.add(raw.a);
      this._assetRaw.set(raw.a, raw);
    } catch (err) {
      console.error('[collab] asset', err);
    }
  }

  // ---- tratto locale in uscita (hook chiamati da App) ----

  /** @param {import('./boards.js').Board} board @param {number} layerId @param {number} x @param {number} y @param {number} p @param {number} t */
  strokeBegin(board, layerId, x, y, p, t) {
    // prima dello snapshot il guest disegna ancora sul SUO vecchio documento:
    // trasmettere quei tratti sporcherebbe il canvas dell'host
    if (!this._ready) return;
    // tratto MASCHERATO dalla selezione: la maschera è locale, i comandi
    // divergerebbero — niente sb/sp/se (_out resta null), al commit il wrap
    // di captureEnd lo replica da sé come patch di pixel
    if (this.app._strokeSel) return;
    const snap = this.app.engine.snap;
    if (!snap) return;
    this._sid++;
    this._out = { sid: this._sid, ev: [] };
    /** @type {any} */
    const f = {};
    for (const k of BRUSH_FIELDS) f[k] = /** @type {any} */ (brush)[k];
    /** @type {any} */
    const br = { f, c: [brush.color.r, brush.color.g, brush.color.b], tx: 0, sh: 0 };
    /** @type {any[]} */
    const assets = [];
    if (brush.texture && brush.textureOn) {
      br.tx = assetHash(brush.texture);
      this._maybePackAsset(br.tx, 't', brush.texture, assets);
    } else {
      f.textureOn = false;
    }
    if (brush.shape) {
      br.sh = assetHash(brush.shape);
      this._maybePackAsset(br.sh, 's', brush.shape, assets);
    }
    /** @type {any} */
    const msg = {
      t: 'sb', sid: this._sid, b: board.id, l: layerId,
      mx: this.app.queue.mirrorX, sc: snap.speedScale, seed: snap.seed,
      pt: this.app.queue.patternTile ? { ...this.app.queue.patternTile } : null,
      br, x, y, p, tm: t,
    };
    if (assets.length) msg.as = assets;
    this._sendStrokeMsg(msg);
  }

  /** @param {number} h @param {'t'|'s'} kind @param {any} obj @param {any[]} out */
  _maybePackAsset(h, kind, obj, out) {
    if (!this._assetRaw.has(h)) {
      this._assetRaw.set(h, kind === 't'
        ? { a: h, k: 't', n: obj.name, w: obj.w, h: obj.h, l: obj.mips[0], r: obj.rgbMips[0] }
        : { a: h, k: 's', n: obj.name, w: obj.w, h: obj.h, p: obj.mips[0] });
    }
    if (this.role === 'guest') {
      // verso l'host basta una volta: da lì in poi ricompleta lui per gli altri
      if (this._sentToHost.has(h)) return;
      this._sentToHost.add(h);
      out.push(this._assetRaw.get(h));
    }
    // host: niente da fare qui — _sendStrokeMsg filtra per-connessione con seen
  }

  // Invio del 'sb': l'host filtra gli asset per connessione, il guest manda
  // tutto all'host (che ricompleta per gli altri).
  /** @param {any} msg */
  _sendStrokeMsg(msg) {
    if (this._outHold) { this._outHold.push(['s', msg]); return; }
    this._sendStrokeMsgNow(msg);
  }

  /** @param {any} msg */
  _sendStrokeMsgNow(msg) {
    if (this.role === 'guest') {
      this._sendNow(msg, null);
      return;
    }
    for (const g of this._conns) {
      if (g.state === 'wait') continue;
      /** @type {any} */
      const out = { ...msg, u: 0 };
      const need = [];
      if (msg.br.tx && !g.seen.has(msg.br.tx) && this._assetRaw.has(msg.br.tx)) need.push(msg.br.tx);
      if (msg.br.sh && !g.seen.has(msg.br.sh) && this._assetRaw.has(msg.br.sh)) need.push(msg.br.sh);
      if (need.length) {
        out.as = need.map((h) => this._assetRaw.get(h));
        for (const h of need) g.seen.add(h);
      } else {
        delete out.as;
      }
      if (g.hold) g.hold.push(out);
      else if (g.conn.open) { try { g.conn.send(out); } catch { /* drop */ } }
    }
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  strokePoint(x, y, p, t) {
    if (this._out) this._out.ev.push(0, x, y, p, t);
  }

  /** Il tick di frame ha chiuso la finestra di velocità: va replicato. @param {number} t */
  strokeTick(t) {
    if (this._out) this._out.ev.push(1, 0, 0, 0, t);
  }

  /** @param {number} x @param {number} y @param {number} p @param {number} t */
  strokeEnd(x, y, p, t) {
    if (!this._out) return;
    this._flushOut();
    // cid dell'op: il commit locale è differito (spalmato sui frame), il tag
    // dell'entry avviene nel wrap di captureEnd quando l'entry esiste davvero
    const cid = this._nextCid();
    this._pendingCid = cid;
    this._broadcast({ t: 'se', sid: this._out.sid, x, y, p, tm: t, cid, u: 0 }, null);
    this._out = null;
  }

  strokeCancel() {
    if (!this._out) return;
    this._broadcast({ t: 'sx', sid: this._out.sid, u: 0 }, null);
    this._out = null;
  }

  _flushOut() {
    if (!this._out || this._out.ev.length === 0) return;
    this._broadcast({ t: 'sp', sid: this._out.sid, ev: this._out.ev, u: 0 }, null);
    this._out.ev = [];
  }

  // ---- frame loop ----

  /** Chiamato una volta a frame da App._frame (prima del present). */
  frame() {
    if (!this.role) return;
    const now = performance.now();
    if (!this.syncing) this._pump(now);
    if (this._ready) {
      this._flushOut();
      this._presenceOut(now);
      this._watch(now);
    }
    this._netTick(now);
    this.presence.frame(this.app.camera);
  }

  // ---- stato di rete (badge nel pannello) ----

  // Ogni ~2s legge dalle stats WebRTC la coppia di candidati selezionata di
  // ogni connessione: diretta / LAN / relay TURN. È la risposta alla domanda
  // "sto pagando il relay o siamo P2P?" senza aprire webrtc-internals.
  /** @param {number} now */
  _netTick(now) {
    if (now - this._netT < 2000) return;
    this._netT = now;
    const conns = this.role === 'host'
      ? this._conns.map((g) => ({ uid: g.uid, conn: g.conn }))
      : (this._host ? [{ uid: 0, conn: this._host }] : []);
    for (const { uid, conn } of conns) {
      const pc = conn.peerConnection;
      if (!pc) continue;
      const st = pc.iceConnectionState;
      if (st === 'failed') { this._setNet(uid, 'failed', 'bad'); continue; }
      if (st === 'disconnected') { this._setNet(uid, 'unstable', 'bad'); continue; }
      if (st === 'new' || st === 'checking') { this._setNet(uid, 'negoziazione…', 'mid'); continue; }
      this._pairInfo(pc).then((info) => {
        if (info) this._setNet(uid, info.label, info.cls);
      }).catch(() => { /* stats non disponibili */ });
    }
  }

  /** @param {RTCPeerConnection} pc @returns {Promise<{label: string, cls: string}|null>} */
  async _pairInfo(pc) {
    const stats = await pc.getStats();
    /** @type {string|null} */ let selId = null;
    /** @type {any[]} */ const pairs = [];
    /** @type {Map<string, any>} */ const cands = new Map();
    stats.forEach((/** @type {any} */ s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) selId = s.selectedCandidatePairId;
      else if (s.type === 'candidate-pair') pairs.push(s);
      else if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands.set(s.id, s);
    });
    let pair = selId ? pairs.find((p) => p.id === selId) : null;
    if (!pair) pair = pairs.find((p) => p.state === 'succeeded' && (p.nominated || p.selected));
    if (!pair) pair = pairs.find((p) => p.state === 'succeeded');
    if (!pair) return null;
    const l = cands.get(pair.localCandidateId);
    const r = cands.get(pair.remoteCandidateId);
    const lt = l && l.candidateType, rt = r && r.candidateType;
    if (lt === 'relay' || rt === 'relay') return { label: 'relay TURN', cls: 'relay' };
    if (lt === 'host' && rt === 'host') return { label: 'direct (LAN)', cls: 'direct' };
    return { label: 'direct P2P', cls: 'direct' };
  }

  /** @param {number} uid @param {string} label @param {string} cls */
  _setNet(uid, label, cls) {
    const cur = this._net.get(uid);
    if (cur && cur.label === label) return;
    this._net.set(uid, { label, cls });
    this.ui.renderUsers();
  }

  // Applica i job remoti quando la pipeline locale è LIBERA: la stessa
  // macchina del tratto locale (engine/queue/raster/commit) viene prestata
  // al replay, un job alla volta. Gli undo/redo sono ASINCRONI (worker di
  // decompressione): mentre uno è in volo (_busy) la pompa si ferma e l'App
  // non fa partire tratti (gate in startStroke).
  /** @param {number} now */
  _pump(now) {
    const a = this.app;
    if (this._busy || this._jobs.length === 0) return;
    if (a.strokeLive || a.pendingCommit || a.commitJob || a.engine.active ||
      a.queue.count > 0 || a.imageImporting) return;
    if (a.transform.pending || a.transform.dragging || a.fx.pending ||
      a.layerStyle.pending || a.fillUI.pending) return;
    const t0 = now;
    while (this._jobs.length && performance.now() - t0 < PUMP_BUDGET_MS) {
      const job = this._jobs.shift();
      try {
        /** @type {any} */
        let r = null;
        if (job.kind === 'stroke') this._applyStroke(job);
        else if (job.kind === 'op') r = this._applyOp(job.o, job.uid);
        else if (job.kind === 'snap') { this._startSnapshot(job.guest); }
        if (r && typeof r.then === 'function') {
          this._busy = true;
          r.catch((/** @type {any} */ err) => console.error('[collab] undo/redo', err))
            .finally(() => {
              this._busy = false;
              a.ui.updateUndoButtons(a.undoMgr);
            });
          break;
        }
      } catch (err) {
        console.error('[collab] apply', err);
      }
      // un tratto lascia la pipeline pulita; se non fosse così, stop
      if (a.strokeLive || a.commitJob) break;
    }
  }

  // ---- replay di un tratto remoto (pixel-exact) ----

  /** @param {any} s */
  _applyStroke(s) {
    const a = this.app;
    const board = a.boards.byId(s.b);
    const layer = a.boards.layerById(s.l);
    const done = () => this.presence.trailEnd(s.uid, s.sid);
    // niente check di visibilità: è stato sincronizzato che converge, e chi
    // ha disegnato l'ha validata al suo pen-down — scartare qui divergerebbe
    if (!board || !layer || layer.kind !== 'raster' || !layer.store) { done(); return; }
    const rb = this._brushFor(s.br);
    if (!rb) { done(); return; }

    a._strokeLayerId = s.l;
    a._strokeClip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    a._strokeSel = null;
    a.queue.mirrorX = (s.mx === null || s.mx === undefined) ? null : s.mx;
    a.queue.patternTile = s.pt && s.pt.w > 0 && s.pt.h > 0
      ? { x: s.pt.x ?? board.x, y: s.pt.y ?? board.y, w: s.pt.w, h: s.pt.h }
      : null;
    a.engine.begin(s.x, s.y, s.p, s.tm, rb, s.seed, s.sc);
    a.raster.beginStroke(a.engine.snap, a._strokeClip, null);
    a.strokeLive = true;
    a.pendingCommit = false;

    const ev = s.ev;
    for (let i = 0; i < ev.length; i += 5) {
      if (ev[i] === 0) a.engine.move(ev[i + 1], ev[i + 2], ev[i + 3], ev[i + 4]);
      else a.engine.tick(ev[i + 4]);
    }
    a.engine.end(s.ex, s.ey, s.ep, s.etm);
    if (a.engine.snapMode) a._syncSnapStroke();
    if (a.queue.count > 0) a.raster.run(a.queue, Infinity);
    if (!a.engine.snapMode && a.engine.endPassNeeded) a._endPass();
    this._pendingCid = s.cid || null; // il wrap di captureEnd tagga l'entry
    a._beginCommit();
    if (a.commitJob) a._runCommit(Infinity);
    this._pendingCid = null;
    done();
  }

  // Ricostruisce un oggetto-pennello dal descrittore remoto (null se manca
  // un asset: il tratto si scarta invece di divergere).
  /** @param {any} d */
  _brushFor(d) {
    /** @type {any} */
    const rb = {};
    for (const k of BRUSH_FIELDS) rb[k] = d.f[k];
    rb.color = { r: d.c[0], g: d.c[1], b: d.c[2] };
    rb.texture = null;
    rb.shape = null;
    if (d.tx) {
      const ent = this._assets.get(d.tx);
      if (!ent || ent.k !== 't') { console.warn('[collab] texture mancante', d.tx); return null; }
      rb.texture = ent.obj;
    }
    if (d.sh) {
      const ent = this._assets.get(d.sh);
      if (!ent || ent.k !== 's') { console.warn('[collab] shape mancante', d.sh); return null; }
      rb.shape = ent.obj;
    }
    return rb;
  }

  // ---- op di struttura e di pixel ----

  /** @param {any} o @param {number} [uid] mittente (serve alle op coi pezzi) */
  _applyOp(o, uid) {
    const a = this.app;
    switch (o.k) {
      case 'pix': return this._applyPixels(o, uid ?? -1);
      case 'limg': return this._applyImage(o, uid ?? -1);

      // traslazione intera di un livello: stesso shift deterministico, entry
      // 'move' simmetrica (lost identici per costruzione: store identici)
      case 'tmove': {
        const board = a.boards.boardOfLayer(o.l);
        if (!board) return;
        const wrap = !!o.wr;
        const lost = a._undoHost().translateLayer(o.l, o.dx, o.dy, wrap);
        if (!lost) return;
        this._pendingCid = o.cid || null; // il wrap di pushMove tagga (no echo)
        a.undoMgr.pushMove(/** @type {any} */ (
          { layerId: o.l, dx: o.dx, dy: o.dy, boardId: board.id, chunks: lost, wrap }));
        this._pendingCid = null;
        a.planes.invalidate();
        a.ui.layersUI.scheduleThumbs();
        this._clearRemoteTransform(uid ?? -1, o.l);
        return;
      }

      // spostamento/scala di un livello testo: si applicano i valori finali
      case 'tform': {
        const board = a.boards.boardOfLayer(o.l);
        const layer = board && board.mgr.byId(o.l);
        if (!board || !layer || layer.kind !== 'text' || !layer.item) return;
        const x0 = layer.item.x, y0 = layer.item.y, s0 = layer.item.size;
        if (!a._undoHost().setTextForm(o.l, o.x, o.y, o.s)) return;
        this._muteTform = true;
        a.undoMgr.pushStruct(/** @type {any} */ ({
          op: 'textform', layerId: o.l, boardId: board.id,
          x0, y0, s0, x1: o.x, y1: o.y, s1: o.s,
        }));
        this._muteTform = false;
        if (o.cid) this._tagNewEntry(o.cid);
        this._tshadow.set(o.l, this._tsig(layer)); // niente eco tset dal watcher
        a.planes.invalidate();
        a.ui.layersUI.scheduleThumbs();
        this._clearRemoteTransform(uid ?? -1, o.l);
        return;
      }

      // testo rasterizzato (op 'trast'): il rendering font è per-piattaforma,
      // quindi arrivano i PIXEL dell'autore; lo scambio in lista è simmetrico
      // (entry 'replace' che possiede il livello testo, undo cross-peer)
      case 'trast': return this._applyTextRaster(o, uid ?? -1);
      case 'ladd': {
        const board = a.boards.byId(o.b);
        if (!board || !board.mgr.canAdd) return;
        const prevAct = board.mgr.activeId;
        const layer = o.kind === 'text'
          ? makeTextLayer(o.nm, o.item, o.style)
          : makeRasterLayer(o.nm, a.heap);
        layer.id = o.id;
        const index = board.mgr.insert(layer, o.ix);
        if (prevAct) board.mgr.activeId = prevAct; // l'attivo resta del viewer
        if (layer.store) a._allStores.add(layer.store);
        a.undoMgr.pushStruct(/** @type {any} */ ({ op: 'attach', layerId: layer.id, index, boardId: board.id }));
        if (o.cid) this._tagNewEntry(o.cid);
        this._shadow.set(layer.id, this._sig(layer));
        if (layer.kind === 'text') this._tshadow.set(layer.id, this._tsig(layer));
        a.planes.invalidate();
        a.ui.layersUI.sync();
        a.ui.layersUI.scheduleThumbs();
        return;
      }

      // contenuto di un livello testo cambiato (pannello Testo, distort):
      // stato completo item+style, ultimo-scrittore-vince
      case 'tset': {
        const board = a.boards.boardOfLayer(o.id);
        const layer = board && board.mgr.byId(o.id);
        if (!board || !layer || layer.kind !== 'text') return;
        layer.item = o.item;
        layer.style = o.style;
        layer.styleDirty = true;
        touchText(layer);
        layer.thumbDirty = true;
        this._tshadow.set(o.id, this._tsig(layer)); // shadow PRIMA: niente eco
        board.mgr.bump();
        a.planes.invalidate();
        a.ui.layersUI.scheduleThumbs();
        return;
      }

      // azzera il documento (op 'clear'): come clearAll ma con gli id del
      // nuovo board/livello FORZATI a quelli dell'autore
      case 'clear': {
        a.commitJob = null;
        a.cancelStroke();
        a.selection.clear();
        for (const b of a.boards.boards) {
          for (const l of b.mgr.layers) {
            if (l.store) {
              l.store.destroy((/** @type {any} */ c) => a.renderer.disposeChunkTex(c));
              a._allStores.delete(l.store);
            } else {
              freeBlockBitmap(l);
            }
          }
          b.mgr.layers.length = 0;
        }
        a.boards.boards.length = 0;
        const board = new Board(o.bnm || 'Canvas 1', 0, 0, BOARD_SIZE, BOARD_SIZE);
        board.id = o.b;
        const first = makeRasterLayer('Layer 1', a.heap);
        first.id = o.l;
        board.mgr.insert(first);
        a._allStores.add(first.store);
        a.boards.boards.push(board);
        a.boards.activeId = board.id;
        a.boards.bump();
        a.undoMgr.clear();
        this._shadow.clear();
        this._tshadow.clear();
        this._shadow.set(first.id, this._sig(first));
        a.planes.invalidate();
        a.ui.layersUI.sync(true);
        a.ui.layersUI.scheduleThumbs();
        return;
      }
      case 'ldup': {
        const board = a.boards.boardOfLayer(o.src);
        const src = board && board.mgr.byId(o.src);
        if (!board || !src || !board.mgr.canAdd) return;
        const copy = duplicateLayer(src, o.nm, a.heap);
        copy.id = o.id;
        if (copy.store) a._allStores.add(copy.store);
        const prevAct = board.mgr.activeId;
        const index = board.mgr.insert(copy, board.mgr.indexOf(src.id) + 1);
        if (prevAct) board.mgr.activeId = prevAct;
        a.undoMgr.pushStruct(/** @type {any} */ ({ op: 'attach', layerId: copy.id, index, boardId: board.id }));
        if (o.cid) this._tagNewEntry(o.cid);
        this._shadow.set(copy.id, this._sig(copy));
        a.planes.invalidate();
        a.ui.layersUI.sync();
        a.ui.layersUI.scheduleThumbs();
        return;
      }
      case 'ldel': {
        const board = a.boards.boardOfLayer(o.id);
        if (!board || board.mgr.layers.length <= 1) return;
        const d = board.mgr.detach(o.id);
        if (!d) return;
        if (d.layer.store) {
          d.layer.store.forEachChunkAll((/** @type {any} */ c) => {
            a.renderer.disposeChunkTex(c);
            c.c2d = null;
            c.texDirty = true;
            c.c2dDirty = true;
          });
        }
        a.undoMgr.pushStruct(/** @type {any} */ ({ op: 'detach', layer: d.layer, index: d.index, boardId: board.id }));
        if (o.cid) this._tagNewEntry(o.cid);
        this._shadow.delete(o.id);
        a.planes.invalidate();
        a.ui.layersUI.sync();
        return;
      }
      case 'lmove': {
        const board = a.boards.byId(o.b);
        if (!board) return;
        board.mgr.move(o.f, o.t);
        a.undoMgr.pushStruct(/** @type {any} */ ({ op: 'move', from: o.f, to: o.t, boardId: board.id }));
        if (o.cid) this._tagNewEntry(o.cid);
        a.planes.invalidate();
        a.ui.layersUI.sync();
        return;
      }
      case 'lset': {
        const board = a.boards.boardOfLayer(o.id);
        const l = board && board.mgr.byId(o.id);
        if (!board || !l) return;
        const v = o.v;
        l.visible = !!v.vis;
        l.opacity = v.op;
        l.name = v.nm;
        if (v.ref) {
          for (const x of board.mgr.layers) x.reference = false;
          l.reference = true;
        } else {
          l.reference = false;
        }
        if (l.kind === 'raster') {
          l.clip = !!v.cl;
          l.mode = v.md;
        }
        l.thumbDirty = true;
        board.mgr.bump();
        a.planes.invalidate();
        this._shadow.set(l.id, this._sig(l));
        a.ui.layersUI.sync();
        a.ui.layersUI.scheduleThumbs();
        return;
      }
      case 'badd': {
        if (!a.boards.canAdd) return;
        const board = new Board(o.nm, o.x, o.y, o.w, o.h);
        board.id = o.id;
        const first = makeRasterLayer('Layer 1', a.heap);
        first.id = o.fl;
        board.mgr.insert(first);
        a._allStores.add(first.store);
        a.boards.boards.push(board);
        a.boards.bump();
        this._shadow.set(first.id, this._sig(first));
        a.ui.layersUI.sync();
        a.ui.layersUI.scheduleThumbs();
        return;
      }

      // undo/redo mirati per cid: lo scambio è deterministico (round-trip
      // perfetto anche fuori ordine), quindi i peer convergono. Entry non
      // trovata = no-op (op locale dell'altro, o entry già evaporata).
      case 'undo':
      case 'redo': {
        this._pendingUndoCids.delete(o.cid);
        this._pendingRedoCids.delete(o.cid);
        const p = o.k === 'undo'
          ? a.undoMgr.undoCid(o.cid, a._undoHost())
          : a.undoMgr.redoCid(o.cid, a._undoHost());
        return p.then((/** @type {boolean} */ ok) => {
          if (ok) this._afterUndoRedo();
        });
      }
    }
  }

  /** @param {string} reason */
  _requestResync(reason) {
    console.warn('[collab] resync:', reason);
    if (this.role === 'guest') {
      if (this.syncing) return;
      this.syncing = true;
      this._ready = false;
      this._jobs.length = 0;
      this._parts.clear();
      this._rs.clear();
      this.ui.syncOverlay(true, 'Re-syncing canvas...');
      this._sendNow({ t: 'rsq', m: reason, u: this.uid }, null);
      return;
    }
    if (this.role === 'host') {
      this.ui.toast('Canvas re-sync started.');
      for (const g of this._conns) {
        if (g.conn.open) this._jobs.push({ kind: 'snap', guest: g });
      }
    }
  }

  /**
   * @param {any} o @param {number} uid @param {string} label
   * @returns {Promise<Uint8Array|null>}
   */
  async _decodeBigPayload(o, uid, label) {
    const joined = this._takeParts(uid, o.pid, o.parts);
    if (!joined) {
      this._requestResync(`Missing ${label} data.`);
      return null;
    }
    /** @type {Uint8Array} */
    let raw;
    try {
      raw = o.z ? await inflateBytes(joined) : joined;
    } catch (err) {
      console.error('[collab] big payload inflate', err);
      this._requestResync(`Corrupt ${label} data.`);
      return null;
    }
    if (typeof o.raw === 'number' && raw.length !== o.raw) {
      this._requestResync(`Incomplete ${label} data.`);
      return null;
    }
    if (typeof o.hash === 'number' && fnv(raw) !== (o.hash >>> 0)) {
      this._requestResync(`Checksum mismatch in ${label} data.`);
      return null;
    }
    return raw;
  }

  /** @param {Uint8Array} raw @param {string} label */
  _validChunkPayload(raw, label) {
    if (raw.length % (8 + CHUNK_BYTES) === 0) return true;
    this._requestResync(`Malformed ${label} data.`);
    return false;
  }

  // Patch di pixel (commit di effetti/stile/fill remoto): scrive i chunk
  // ricevuti sul livello, con undo tile-diff taggato come sull'autore — i
  // byte sono identici per costruzione, l'undo cross-peer torna gratis.
  /** @param {any} o @param {number} uid */
  async _applyPixels(o, uid) {
    const a = this.app;
    const raw = await this._decodeBigPayload(o, uid, 'pixel patch');
    if (!raw || !this._validChunkPayload(raw, 'pixel patch')) return;
    const layer = a.boards.layerById(o.l);
    if (!layer || layer.kind !== 'raster' || !layer.store) return;
    const store = layer.store;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = Math.floor(raw.length / (8 + CHUNK_BYTES));
    /** @type {(c: any) => void} */
    const dispose = (c) => a.renderer.disposeChunkTex(c);
    a.undoMgr.captureBegin(o.l);
    for (let i = 0; i < n; i++) {
      const off = i * (8 + CHUNK_BYTES);
      const cx = dv.getInt32(off, true);
      const cy = dv.getInt32(off + 4, true);
      const block = raw.subarray(off + 8, off + 8 + CHUNK_BYTES);
      // blocco tutto-zero = il mittente ha svuotato/rimosso quel chunk
      // (es. l'area sorgente di una trasformazione): si RIMUOVE come fa lui,
      // niente chunk-zombie pieni di zeri sui riceventi
      const u = new Uint32Array(block.buffer, block.byteOffset, CHUNK_BYTES >> 2);
      let zero = true;
      for (let j = 0; j < u.length; j++) if (u[j] !== 0) { zero = false; break; }
      const key = chunkKey(cx, cy);
      const prev = store.getByKey(key);
      if (zero && !prev) continue; // assente e resta assente
      a.undoMgr.captureChunk(key, cx, cy, prev ? prev.data : null);
      if (zero) {
        store.remove(key, dispose);
      } else {
        const c = store.getOrCreate(cx, cy);
        c.data.set(block);
        c.touched = true;
        store.markDirty(c);
      }
    }
    this._pendingCid = o.cid || null; // il wrap di captureEnd tagga (no echo)
    a.undoMgr.captureEnd();
    this._pendingCid = null;
    layer.thumbDirty = true;
    a.planes.invalidate();
    a.ui.layersUI.scheduleThumbs();
    this._clearRemoteTransform(uid, o.l);
  }

  // Import immagine remoto: nuovo livello con id forzato + pixel ricevuti.
  // UNA sola entry 'attach' (come sull'autore): l'undo stacca il livello
  // coi suoi pixel, simmetrico ovunque.
  /** @param {any} o @param {number} uid */
  async _applyImage(o, uid) {
    const a = this.app;
    const raw = await this._decodeBigPayload(o, uid, 'image layer');
    if (!raw || !this._validChunkPayload(raw, 'image layer')) return;
    const board = a.boards.byId(o.b);
    if (!board || !board.mgr.canAdd) return;
    const layer = makeRasterLayer(o.nm, a.heap);
    layer.id = o.id;
    // PRIMA del travaso: un alloc può far crescere la memoria wasm e onGrow
    // rigenera le viste solo degli store registrati
    a._allStores.add(layer.store);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = Math.floor(raw.length / (8 + CHUNK_BYTES));
    for (let i = 0; i < n; i++) {
      const off = i * (8 + CHUNK_BYTES);
      const c = layer.store.getOrCreate(dv.getInt32(off, true), dv.getInt32(off + 4, true));
      c.data.set(raw.subarray(off + 8, off + 8 + CHUNK_BYTES));
      c.touched = true;
      layer.store.markDirty(c);
    }
    const prevAct = board.mgr.activeId;
    const index = board.mgr.insert(layer, o.ix);
    if (prevAct) board.mgr.activeId = prevAct;
    a.undoMgr.pushStruct(/** @type {any} */ ({ op: 'attach', layerId: layer.id, index, boardId: board.id }));
    if (o.cid) this._tagNewEntry(o.cid);
    this._shadow.set(layer.id, this._sig(layer));
    a.planes.invalidate();
    a.ui.layersUI.sync();
    a.ui.layersUI.scheduleThumbs();
  }

  // Testo rasterizzato remoto: nuovo raster con id forzato + pixel ricevuti,
  // scambiato in lista col testo come fa rasterizeTextLayer (stessa entry
  // 'replace' che possiede il livello testo: undo simmetrico ovunque).
  /** @param {any} o @param {number} uid */
  async _applyTextRaster(o, uid) {
    const a = this.app;
    const raw = await this._decodeBigPayload(o, uid, 'text raster');
    if (!raw || !this._validChunkPayload(raw, 'text raster')) return;
    const board = a.boards.byId(o.b);
    const text = board && board.mgr.byId(o.tl);
    if (!board || !text || text.kind !== 'text') return;
    const raster = makeRasterLayer(o.nm, a.heap);
    raster.id = o.id;
    raster.visible = text.visible;
    raster.opacity = text.opacity;
    a._allStores.add(raster.store);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = Math.floor(raw.length / (8 + CHUNK_BYTES));
    for (let i = 0; i < n; i++) {
      const off = i * (8 + CHUNK_BYTES);
      const c = raster.store.getOrCreate(dv.getInt32(off, true), dv.getInt32(off + 4, true));
      c.data.set(raw.subarray(off + 8, off + 8 + CHUNK_BYTES));
      c.touched = true;
      raster.store.markDirty(c);
    }
    const prevAct = board.mgr.activeId;
    const d = board.mgr.detach(o.tl);
    if (!d) return;
    board.mgr.insert(raster, d.index);
    if (prevAct && prevAct !== o.tl) board.mgr.activeId = prevAct;
    freeBlockBitmap(text);
    a.undoMgr.pushStruct(/** @type {any} */ (
      { op: 'replace', layer: text, layerId: raster.id, boardId: board.id }));
    if (o.cid) this._tagNewEntry(o.cid);
    this._tshadow.delete(o.tl);
    this._shadow.delete(o.tl);
    this._shadow.set(raster.id, this._sig(raster));
    a.planes.invalidate();
    a.ui.layersUI.sync();
    a.ui.layersUI.scheduleThumbs();
  }

  // ---- undo/redo CONDIVISI ----
  // Una sola storia per tutti: Ctrl+Z annulla l'ULTIMA modifica sul canvas,
  // di chiunque sia (come in single-user — scelta utente: meno sorprese).
  // Resta tutto MIRATO per cid: chi preme sceglie l'entry, i peer annullano
  // QUELLA — anche se i loro stack hanno interleave diversi, fanno la stessa
  // cosa. E in sessione il redo non viene MAI invalidato automaticamente
  // (si consuma solo ripristinando): un drop-implicito applicato in ordini
  // diversi sui peer creerebbe redo fantasma su uno e non sull'altro.

  _nextCid() { return this.uid + ':' + (++this._opN); }

  /** Tagga l'entry appena pushata (il redo NON si tocca: vedi sopra). @param {string} cid */
  _tagNewEntry(cid) {
    this.app.undoMgr.tagTop(cid);
  }

  // Ultima entry taggata dello stack (di chiunque), saltando quelle già in
  // coda di applicazione. Le entry senza cid (storia pre-sessione) non si
  // toccano: gli altri peer non le hanno.
  /** @param {any[]} stack @param {Set<string>} skip */
  _lastAnyCid(stack, skip) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i].cid;
      if (c && !skip.has(c)) return c;
    }
    return null;
  }

  // Ctrl+Z in sessione: annulla l'ultima op della storia condivisa. Passa
  // dalla stessa coda FIFO dei job remoti e viene broadcastato come op
  // mirata; se due utenti premono insieme sulla stessa entry, il secondo
  // scambio trova l'entry già di là e fa no-op — su tutti i peer.
  undoOwn() {
    if (!this._ready) return;
    const a = this.app;
    const cid = this._lastAnyCid(a.undoMgr.undoStack, this._pendingUndoCids);
    if (!cid) { this.ui.toast('Nothing to undo.'); return; }
    this._pendingUndoCids.add(cid);
    this._jobs.push({ kind: 'op', uid: this.uid, o: { k: 'undo', cid } });
    this._sendOp({ k: 'undo', cid });
    a.ui.updateUndoButtons(a.undoMgr);
  }

  redoOwn() {
    if (!this._ready) return;
    const a = this.app;
    const cid = this._lastAnyCid(a.undoMgr.redoStack, this._pendingRedoCids);
    if (!cid) { this.ui.toast('Nothing to redo.'); return; }
    this._pendingRedoCids.add(cid);
    this._jobs.push({ kind: 'op', uid: this.uid, o: { k: 'redo', cid } });
    this._sendOp({ k: 'redo', cid });
    a.ui.updateUndoButtons(a.undoMgr);
  }

  // Dopo uno scambio undo/redo: stessi risvegli di App.undo (la sessione
  // Sposta rifotografa, piani e pannello si risincronizzano). NIENTE refresh
  // della shadow: se l'undo flippa clip/mode sul peer dell'autore, il
  // diff-watcher DEVE vederlo e broadcastare lset (è la rete di convergenza
  // per le entry locali-solo).
  _afterUndoRedo() {
    const a = this.app;
    a.transform.rebind();
    a.planes.invalidate();
    a.ui.layersUI.sync();
    a.ui.layersUI.scheduleThumbs();
  }

  // ---- snapshot (host -> guest) ----

  // Job di pump: fotografa il documento IN SINCRONO (pipeline libera, taglio
  // netto: tutto ciò che viene broadcastato da qui in poi finisce nella coda
  // hold del guest e arriva DOPO lo snapshot), poi comprime e invia in
  // background con backpressure.
  /** @param {any} guest */
  _startSnapshot(guest) {
    if (!this._conns.includes(guest)) return; // già sconnesso
    const a = this.app;
    guest.hold = [];
    guest.state = 'sync';

    /** @type {any[]} */
    const boardsMeta = [];
    /** @type {{id: number, raw: Uint8Array}[]} */
    const pix = [];
    for (const b of a.boards.boards) {
      /** @type {any[]} */
      const layers = [];
      for (const l of b.mgr.layers) {
        /** @type {any} */
        const lm = {
          id: l.id, kind: l.kind, nm: l.name, vis: l.visible, op: l.opacity,
          ref: !!l.reference,
        };
        if (l.kind === 'raster') {
          lm.cl = !!l.clip;
          lm.md = l.mode || 'normal';
          const chunks = nonBlankChunkList(l.store);
          if (chunks.length) {
            const raw = packCurrent(l.store, chunks);
            pix.push({ id: l.id, raw });
            lm.px = chunks.length;
          }
        } else {
          lm.item = structuredClone(l.item);
          lm.style = structuredClone(l.style);
        }
        layers.push(lm);
      }
      boardsMeta.push({
        id: b.id, nm: b.name, x: b.x, y: b.y, w: b.w, h: b.h,
        act: b.mgr.activeId, layers,
      });
    }
    const meta = { boards: boardsMeta, act: a.boards.activeId, z: CAN_Z ? 1 : 0 };
    if (!guest.conn.open) return;
    try { guest.conn.send({ t: 'sn0', doc: meta }); } catch { return; }

    (async () => {
      try {
        for (const lay of pix) {
          const buf = CAN_Z ? await deflateBytes(lay.raw) : lay.raw;
          for (let off = 0; off < buf.length; off += SNAP_PIECE) {
            const piece = buf.subarray(off, Math.min(buf.length, off + SNAP_PIECE));
            const dc = guest.conn.dataChannel;
            while (dc && dc.bufferedAmount > DC_BUFFER_CAP) await sleep(50);
            if (!guest.conn.open) throw new Error('connection closed during snapshot');
            guest.conn.send({
              t: 'sn1', l: lay.id,
              last: off + SNAP_PIECE >= buf.length,
              buf: new Uint8Array(piece), // copia: subarray condividerebbe il buffer
            });
          }
        }
        if (!guest.conn.open) throw new Error('connection closed during snapshot');
        guest.conn.send({ t: 'sn2' });
        const hold = guest.hold;
        guest.hold = null;
        if (hold) for (const msg of hold) { if (guest.conn.open) guest.conn.send(msg); }
      } catch (err) {
        console.error('[collab] invio snapshot', err);
        try { guest.conn.close(); } catch { /* */ }
      }
    })();
  }

  // Guest: sostituisce il documento locale con quello dell'host (bit-exact).
  async _applySnapshot() {
    const a = this.app;
    const meta = this._snMeta;
    if (!meta) return;
    this.ui.syncOverlay(true, 'Costruzione del documento…');

    // decompressione PRIMA del teardown: se fallisce, il doc locale resta
    /** @type {Map<number, Uint8Array>} */
    const pixByLayer = new Map();
    for (const [lid, parts] of this._snParts) {
      let total = 0;
      for (const p of parts) total += p.length;
      const joined = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { joined.set(p, off); off += p.length; }
      pixByLayer.set(lid, meta.z ? await inflateBytes(joined) : joined);
    }
    this._snMeta = null;
    this._snParts.clear();

    // teardown del documento corrente (come clearAll, senza il board iniziale)
    a.commitJob = null;
    a.cancelStroke();
    a.selection.clear();
    for (const b of a.boards.boards) {
      for (const l of b.mgr.layers) {
        if (l.store) {
          l.store.destroy((/** @type {any} */ c) => a.renderer.disposeChunkTex(c));
          a._allStores.delete(l.store);
        } else {
          freeBlockBitmap(l);
        }
      }
      b.mgr.layers.length = 0;
    }
    a.boards.boards.length = 0;
    a.undoMgr.clear();
    this._shadow.clear();

    for (const bm of meta.boards) {
      const board = new Board(bm.nm, bm.x, bm.y, bm.w, bm.h);
      board.id = bm.id;
      a.boards.boards.push(board);
      for (const lm of bm.layers) {
        /** @type {Layer} */
        let layer;
        if (lm.kind === 'raster') {
          layer = makeRasterLayer(lm.nm, a.heap);
          layer.id = lm.id;
          layer.clip = !!lm.cl;
          layer.mode = lm.md;
          a._allStores.add(layer.store);
          const raw = pixByLayer.get(lm.id);
          if (raw) {
            const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
            const n = Math.floor(raw.length / (8 + CHUNK_BYTES));
            for (let i = 0; i < n; i++) {
              const off = i * (8 + CHUNK_BYTES);
              const cx = dv.getInt32(off, true);
              const cy = dv.getInt32(off + 4, true);
              const c = layer.store.getOrCreate(cx, cy);
              c.data.set(raw.subarray(off + 8, off + 8 + CHUNK_BYTES));
              c.touched = true;
              layer.store.markDirty(c);
            }
          }
        } else {
          layer = makeTextLayer(lm.nm, lm.item, lm.style);
          layer.id = lm.id;
        }
        layer.name = lm.nm;
        layer.visible = !!lm.vis;
        layer.opacity = lm.op;
        layer.reference = !!lm.ref;
        board.mgr.layers.push(layer);
        this._shadow.set(layer.id, this._sig(layer));
      }
      board.mgr.activeId = bm.act && board.mgr.byId(bm.act)
        ? bm.act : (board.mgr.layers.length ? board.mgr.layers[board.mgr.layers.length - 1].id : 0);
      board.mgr.bump();
    }
    a.boards.activeId = meta.act && a.boards.byId(meta.act)
      ? meta.act : (a.boards.boards.length ? a.boards.boards[0].id : 0);
    a.boards.bump();
    a.planes.invalidate();
    a.ui.layersUI.sync(true);
    a.ui.layersUI.scheduleThumbs();
    a.fitActiveBoard();

    this.syncing = false;
    this._ready = true;
    this.ui.syncOverlay(false);
    this.ui.setLive();
    this._broadcast({ t: 'rdy' }, null);
    this.ui.toast('You are in the session: happy drawing!');
  }

  // ---- presenza in uscita ----

  /** @param {number} now */
  _presenceOut(now) {
    if (this.syncing || !this._ptrSeen) return;
    if (now - this._prT < PRESENCE_MS) return;
    const cam = this.app.camera;
    const w = cam.screenToWorld(this._ptrX, this._ptrY, this._tmpW);
    const drawing = this.app.input.isDrawing;
    const moved = Math.abs(w.x - this._prX) + Math.abs(w.y - this._prY) > 0.25 / cam.zoom;
    if (!moved && drawing === this._prD) return;
    this._prT = now;
    this._prX = w.x; this._prY = w.y; this._prD = drawing;
    this._broadcast({ t: 'pr', u: this.uid, x: w.x, y: w.y, d: drawing }, null);
  }

  // ---- diff-watcher delle proprietà dei livelli ----
  // Visibilità/opacità/nome/riferimento/clip/metodo vengono mutati inline da
  // più punti della UI: invece di agganciarli tutti, si confronta una firma
  // per livello a cadenza fissa. Le applicazioni remote aggiornano la shadow
  // PRIMA, quindi non rimbalzano.

  /** @param {Layer} l */
  _sig(l) {
    return `${l.visible ? 1 : 0}|${l.opacity}|${l.name}|${l.reference ? 1 : 0}|` +
      `${l.clip ? 1 : 0}|${l.mode || 'normal'}`;
  }

  /** Firma del contenuto di un livello testo. @param {Layer} l */
  _tsig(l) {
    return JSON.stringify(l.item) + '|' + JSON.stringify(l.style);
  }

  /** @param {number} now */
  _watch(now) {
    if (this.syncing || now - this._watchT < WATCH_MS) return;
    this._watchT = now;
    const seen = new Set();
    for (const b of this.app.boards.boards) {
      for (const l of b.mgr.layers) {
        seen.add(l.id);
        const sig = this._sig(l);
        const old = this._shadow.get(l.id);
        if (old === undefined) {
          this._shadow.set(l.id, sig); // nato da un'op già replicata
        } else if (old !== sig) {
          this._shadow.set(l.id, sig);
          this._sendOp({
            k: 'lset', id: l.id, v: {
              vis: l.visible, op: l.opacity, nm: l.name,
              ref: !!l.reference, cl: !!l.clip, md: l.mode || 'normal',
            },
          });
        }
        // contenuto dei livelli testo (pannello Testo, warp, distort)
        if (l.kind === 'text') {
          const tsig = this._tsig(l);
          const told = this._tshadow.get(l.id);
          if (told === undefined) {
            this._tshadow.set(l.id, tsig);
          } else if (told !== tsig) {
            this._tshadow.set(l.id, tsig);
            this._sendOp({
              k: 'tset', id: l.id,
              item: structuredClone(l.item), style: structuredClone(l.style),
            });
          }
        }
      }
    }
    for (const id of this._shadow.keys()) {
      if (!seen.has(id)) this._shadow.delete(id);
    }
    for (const id of this._tshadow.keys()) {
      if (!seen.has(id)) this._tshadow.delete(id);
    }
  }

  // ---- patch: replica struttura + lockdown ----

  _applyPatches() {
    const a = this.app;
    const P = this._patches;
    /** @type {(obj: any, key: string, fn: any) => void} */
    const swap = (obj, key, fn) => { P.push([obj, key, obj[key]]); obj[key] = fn; };
    const self = this;
    const locked = () => {
      if (!self._remoteTfActive) return false;
      self.ui.toast('Transform in progress: wait for ✓ or cancel it.');
      return true;
    };

    // entry a tile-diff: il tag (cid) avviene quando l'entry esiste davvero —
    // captureEnd può scartare (zero chunk) e il cid resta semplicemente
    // orfano: l'undo mirato che lo cerca fa no-op, su tutti i peer.
    // Con _pendingCid VUOTO l'entry è un'op locale NON guidata da comandi
    // (effetti GPU, stile livello, ColorDrop): la GPU di ogni dispositivo fa
    // pixel leggermente diversi, quindi si replica il RISULTATO — i chunk
    // toccati (li elenca l'entry stessa) spediti come patch bit-exact.
    const origCapEnd = a.undoMgr.captureEnd.bind(a.undoMgr);
    swap(a.undoMgr, 'captureEnd', function () {
      const n0 = a.undoMgr.undoStack.length;
      origCapEnd();
      const cid = self._pendingCid;
      self._pendingCid = null;
      const skipAutoPixelPatch = self._skipNextAutoPixelPatch;
      self._skipNextAutoPixelPatch = false;
      if (a.undoMgr.undoStack.length === n0) return; // entry scartata
      if (cid) { self._tagNewEntry(cid); return; }
      if (skipAutoPixelPatch) return;
      if (!self._ready) return;
      const e = /** @type {any} */ (a.undoMgr.undoStack[a.undoMgr.undoStack.length - 1]);
      if (e.kind !== 'stroke' || !e.layerId || !e.chunks.length) return;
      const layer = a.boards.layerById(e.layerId);
      if (!layer || !layer.store) return;
      const ncid = self._nextCid();
      self._tagNewEntry(ncid);
      // fotografia SINCRONA del risultato (la compressione poi è async)
      const raw = packCurrent(layer.store, e.chunks);
      self._sendBig({ k: 'pix', l: e.layerId, cid: ncid }, raw);
    });

    // traslazione intera di un livello (tool Sposta, path pushMove):
    // translateStore è CPU deterministico -> viaggia come COMANDO (dx/dy),
    // niente pixel. _pendingCid = apply remoto (solo tag, no echo).
    const origPushMove = a.undoMgr.pushMove.bind(a.undoMgr);
    swap(a.undoMgr, 'pushMove', /** @param {any} e */ function (e) {
      origPushMove(e);
      const cid = self._pendingCid;
      self._pendingCid = null;
      if (cid) { self._tagNewEntry(cid); return; }
      if (!self._ready) return;
      const ncid = self._nextCid();
      self._tagNewEntry(ncid);
      self._sendOp({ k: 'tmove', l: e.layerId, dx: e.dx, dy: e.dy, wr: !!e.wrap, cid: ncid });
    });

    // spostamento/scala di un livello TESTO (entry struct 'textform'): i
    // valori FINALI assoluti sono il comando. _muteTform marca l'apply
    // remoto (qui niente _pendingCid: il path testo di confirm() non flusha
    // il commit di stroke pendente, il cid del tratto non va rubato).
    const origPushStruct = a.undoMgr.pushStruct.bind(a.undoMgr);
    swap(a.undoMgr, 'pushStruct', /** @param {any} e */ function (e) {
      origPushStruct(e);
      if (e.op !== 'textform' || self._muteTform || !self._ready) return;
      const ncid = self._nextCid();
      self._tagNewEntry(ncid);
      const tl = a.boards.layerById(e.layerId);
      if (tl) self._tshadow.set(e.layerId, self._tsig(tl)); // niente doppio tset
      self._sendOp({ k: 'tform', l: e.layerId, x: e.x1, y: e.y1, s: e.s1, cid: ncid });
    });

    const origAdd = a.addLayer.bind(a);
    swap(a, 'addLayer', /** @param {Layer} layer @param {any} [board] */ function (layer, board = a.boards.active) {
      if (locked()) return false;
      const ok = origAdd(layer, board);
      if (ok && self._muteAddOnce) {
        // attach interno di importImageLayer: i pixel viaggiano con 'limg'
        self._muteAddOnce = false;
        return ok;
      }
      if (ok && !self._mute) {
        const cid = self._nextCid();
        self._tagNewEntry(cid);
        self._shadow.set(layer.id, self._sig(layer));
        /** @type {any} */
        const o = { k: 'ladd', b: board.id, id: layer.id, nm: layer.name, ix: board.mgr.indexOf(layer.id), cid };
        if (layer.kind === 'text') {
          o.kind = 'text';
          o.item = structuredClone(layer.item);
          o.style = structuredClone(layer.style);
          self._tshadow.set(layer.id, self._tsig(layer));
        }
        self._sendOp(o);
      }
      return ok;
    });

    // import immagine: il decode/resize NON è deterministico tra browser —
    // si replica il risultato (struttura + pixel del nuovo livello)
    const origImport = a.importImageLayer.bind(a);
    swap(a, 'importImageLayer', /** @param {File} file */ async function (file) {
      if (locked()) return false;
      self._muteAddOnce = true;
      let ok = false;
      try {
        ok = await origImport(file);
      } finally {
        self._muteAddOnce = false;
      }
      if (!ok) return ok;
      const layer = a.layerMgr.active; // l'attach l'ha resa attiva
      const board = layer && a.boards.boardOfLayer(layer.id);
      if (!layer || !layer.store || !board) return ok;
      const cid = self._nextCid();
      self._tagNewEntry(cid); // l'entry 'attach' dell'import
      self._shadow.set(layer.id, self._sig(layer));
      const raw = packCurrent(layer.store, nonBlankChunkList(layer.store));
      self._sendBig({
        k: 'limg', b: board.id, id: layer.id, nm: layer.name,
        ix: board.mgr.indexOf(layer.id), cid,
      }, raw);
      return ok;
    });

    const origDel = a.deleteLayer.bind(a);
    swap(a, 'deleteLayer', /** @param {number} id */ function (id) {
      if (locked()) return;
      const board = a.boards.boardOfLayer(id);
      origDel(id);
      if (board && !board.mgr.byId(id)) {
        const cid = self._nextCid();
        self._tagNewEntry(cid);
        self._shadow.delete(id);
        self._sendOp({ k: 'ldel', id, cid });
      }
    });

    const origMove = a.moveLayerUndoable.bind(a);
    swap(a, 'moveLayerUndoable', /** @param {number} f @param {number} t */ function (f, t) {
      if (locked()) return;
      if (f === t) return;
      origMove(f, t);
      const cid = self._nextCid();
      self._tagNewEntry(cid);
      self._sendOp({ k: 'lmove', b: a.boards.activeId, f, t, cid });
    });

    // clip e mode: entry SOLO locali (lo stato viaggia col diff-watcher);
    // il cid serve al proprio Ctrl+Z, sugli altri peer l'undo fa no-op e la
    // convergenza la garantisce il watcher che rivede la proprietà flippata
    const origClipT = a.toggleClipUndoable.bind(a);
    swap(a, 'toggleClipUndoable', /** @param {number} id */ function (id) {
      if (locked()) return;
      const n0 = a.undoMgr.undoStack.length;
      origClipT(id);
      if (a.undoMgr.undoStack.length > n0) self._tagNewEntry(self._nextCid());
    });
    const origModeU = a.setModeUndoable.bind(a);
    swap(a, 'setModeUndoable', /** @param {number} id @param {any} m */ function (id, m) {
      if (locked()) return;
      const n0 = a.undoMgr.undoStack.length;
      origModeU(id, m);
      if (a.undoMgr.undoStack.length > n0) self._tagNewEntry(self._nextCid());
    });

    const origBoard = a.addBoard.bind(a);
    swap(a, 'addBoard', function () {
      if (locked()) return null;
      const b = origBoard();
      if (b) {
        self._sendOp({ k: 'badd', id: b.id, nm: b.name, x: b.x, y: b.y, w: b.w, h: b.h, fl: b.mgr.layers[0].id });
      }
      return b;
    });

    const lui = /** @type {any} */ (a.ui.layersUI);
    const origDup = lui._duplicate.bind(lui);
    swap(lui, '_duplicate', function () {
      if (locked()) return;
      const src = a.layerMgr.active;
      if (!src) return;
      a._flushPendingStroke(); // la copia deve fotografare i pixel finiti
      self._mute = true;
      origDup();
      self._mute = false;
      const copy = a.layerMgr.active;
      if (copy && copy !== src) {
        self._shadow.set(copy.id, self._sig(copy));
        self._sendOp({ k: 'ldup', src: src.id, id: copy.id, nm: copy.name });
      }
    });

    // undo/redo per-utente: Ctrl+Z e bottoni passano da qui
    swap(a, 'undo', function () { if (!locked()) self.undoOwn(); });
    swap(a, 'redo', function () { if (!locked()) self.redoOwn(); });
    // ...e i bottoni riflettono "c'è QUALCOSA nella storia condivisa"
    swap(a.ui, 'updateUndoButtons', function () {
      const um = a.undoMgr;
      const can = !um.busy && !self._busy && self._ready && !self._remoteTfActive;
      /** @type {HTMLButtonElement} */ (document.getElementById('btn-undo')).disabled =
        !(can && self._lastAnyCid(um.undoStack, self._pendingUndoCids));
      /** @type {HTMLButtonElement} */ (document.getElementById('btn-redo')).disabled =
        !(can && self._lastAnyCid(um.redoStack, self._pendingRedoCids));
    });

    // rasterizza testo: il rendering font è per-piattaforma -> si spediscono
    // i PIXEL del risultato insieme allo scambio di struttura
    const origRast = a.rasterizeTextLayer.bind(a);
    swap(a, 'rasterizeTextLayer', /** @param {number} id */ function (id) {
      if (locked()) return false;
      const board = a.boards.boardOfLayer(id);
      const ok = origRast(id);
      if (!ok || !board) return ok;
      const raster = board.mgr.active; // lo scambio l'ha resa attiva
      if (!raster || !raster.store) return ok;
      const cid = self._nextCid();
      self._tagNewEntry(cid); // l'entry 'replace'
      self._tshadow.delete(id);
      self._shadow.delete(id);
      self._shadow.set(raster.id, self._sig(raster));
      const raw = packCurrent(raster.store, nonBlankChunkList(raster.store));
      self._sendBig({
        k: 'trast', b: board.id, tl: id, id: raster.id, nm: raster.name,
        cid,
      }, raw);
      return ok;
    });

    // cancella tutto: comando con gli id del nuovo board/livello forzati
    const origClear = a.clearAll.bind(a);
    swap(a, 'clearAll', function () {
      if (locked()) return;
      origClear();
      const board = a.boards.active;
      const first = board && board.mgr.layers[0];
      if (!board || !first) return;
      self._shadow.clear();
      self._tshadow.clear();
      self._shadow.set(first.id, self._sig(first));
      self._sendOp({ k: 'clear', b: board.id, bnm: board.name, l: first.id });
    });

    // tutto il resto dell'app è ormai collaborativo: resta spento via CSS
    // solo lo stress test (creerebbe board/livelli fuori protocollo)
  }

  _removePatches() {
    for (let i = this._patches.length - 1; i >= 0; i--) {
      const [obj, key, orig] = this._patches[i];
      obj[key] = orig;
    }
    this._patches.length = 0;
  }
}
