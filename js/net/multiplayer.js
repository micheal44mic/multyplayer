import { SignalingClient } from './signaling_client.js';
import { MP_PROTOCOL, getClientId, makeOpId, validDocOp } from './protocol.js';
import { SIGNALING_URL } from './multiplayer_config.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export class MultiplayerManager {
  /** @param {import('../main.js').App} app */
  constructor(app) {
    this.app = app;
    this.userId = getClientId();
    this.mode = 'offline';
    this.roomId = '';
    this.seq = 0;
    this.history = [];
    this.pendingLocal = new Set();
    this.outbox = [];
    this.remoteQueue = [];
    this.remoteCursors = new Map();
    /** @type {Map<string, {pc: RTCPeerConnection, dc: RTCDataChannel|null}>} */
    this.peers = new Map();
    /** @type {SignalingClient|null} */
    this.signaling = null;
    this.hostId = '';
    this._closing = false;
    this._lastCursorSent = 0;
    this._cursorWorld = { x: 0, y: 0 };
    this.ui = {};
  }

  get active() { return this.mode === 'host' || this.mode === 'guest' || this.mode === 'connecting'; }
  get connected() { return this.mode === 'host' || this.mode === 'guest'; }
  get isHost() { return this.mode === 'host'; }
  get isGuest() { return this.mode === 'guest'; }
  get openPeerCount() {
    let n = 0;
    for (const p of this.peers.values()) if (p.dc && p.dc.readyState === 'open') n++;
    return n;
  }
  get dataReady() { return this.isHost || this.openPeerCount > 0; }

  attachUi() {
    const toolbar = document.getElementById('toolbar');
    const spacer = toolbar && toolbar.querySelector('.tb-spacer');
    if (!toolbar || !spacer) return;

    const group = document.createElement('div');
    group.id = 'multiplayer';
    group.className = 'tb-group mp-group';

    const status = document.createElement('span');
    status.className = 'mp-status';
    status.textContent = 'Offline';

    const host = document.createElement('button');
    host.className = 'tb-btn mp-btn';
    host.type = 'button';
    host.title = 'Crea stanza host';
    host.textContent = 'Host';
    host.addEventListener('click', () => this.createRoom().catch((err) => this._fail(err)));

    const code = document.createElement('input');
    code.className = 'mp-code';
    code.type = 'text';
    code.placeholder = 'Codice';
    code.maxLength = 8;
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    code.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const roomId = code.value.trim();
      if (roomId) this.joinRoom(roomId).catch((err) => this._fail(err));
    });

    const join = document.createElement('button');
    join.className = 'tb-btn mp-btn';
    join.type = 'button';
    join.title = 'Entra in una stanza';
    join.textContent = 'Entra';
    join.addEventListener('click', () => {
      const roomId = code.value.trim();
      if (roomId) this.joinRoom(roomId).catch((err) => this._fail(err));
      else code.focus();
    });

    const leave = document.createElement('button');
    leave.className = 'tb-btn mp-btn danger';
    leave.type = 'button';
    leave.title = 'Chiudi o lascia la stanza';
    leave.textContent = 'Esci';
    leave.addEventListener('click', () => this.close());

    group.append(status, host, code, join, leave);
    spacer.before(group);

    const cursorLayer = document.createElement('div');
    cursorLayer.id = 'mp-cursors';
    cursorLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cursorLayer);

    this.ui = { group, status, host, code, join, leave, cursorLayer };
    this._syncUi();
  }

  async createRoom() {
    if (this.active) this.close();
    this._ensureWebRtcAvailable();
    this.close(false);
    this.mode = 'connecting';
    this.history = [];
    this.seq = 0;
    this._syncUi('Creo stanza...');
    await this._connectSignaling();
    this.signaling.send({ type: 'create', clientId: this.userId });
  }

  /** @param {string} roomId */
  async joinRoom(roomId) {
    if (this.active) this.close();
    this._ensureWebRtcAvailable();
    this.close(false);
    this.mode = 'connecting';
    this.roomId = roomId.trim().toUpperCase();
    this._syncUi('Entro...');
    await this._connectSignaling();
    this.signaling.send({ type: 'join', roomId: this.roomId, clientId: this.userId });
  }

  /** @param {boolean} [notify] */
  close(notify = true) {
    if (this._closing) return;
    this._closing = true;
    if (notify && this.signaling && this.roomId) {
      this.signaling.send({ type: this.isHost ? 'close-room' : 'leave', roomId: this.roomId, clientId: this.userId });
    }
    if (this.isHost) this._broadcast({ type: 'room_closed', reason: 'host-left' });
    for (const peer of this.peers.values()) {
      try { peer.dc && peer.dc.close(); } catch { /* noop */ }
      try { peer.pc.close(); } catch { /* noop */ }
    }
    this.peers.clear();
    this.pendingLocal.clear();
    this.outbox.length = 0;
    this.remoteQueue.length = 0;
    this._clearRemoteCursors();
    this.mode = 'offline';
    this.roomId = '';
    this.hostId = '';
    this._closing = false;
    this._syncUi();
  }

  /** @param {any} err */
  _fail(err) {
    console.error(err);
    alert(err instanceof Error ? err.message : 'Errore multiplayer.');
    this.close(false);
  }

  async _connectSignaling() {
    if (!this.signaling) {
      this.signaling = new SignalingClient(defaultSignalingUrl(), (msg) => this._onSignaling(msg));
    }
    await this.signaling.connect();
  }

  _ensureWebRtcAvailable() {
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
    if (!window.isSecureContext && !local) {
      throw new Error('WebRTC richiede HTTPS, oppure localhost durante i test.');
    }
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC non disponibile in questo browser.');
    }
  }

  /** @param {any} msg */
  _onSignaling(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') return;
    if (msg.type === 'error') {
      this._fail(new Error(msg.message || 'Errore signaling.'));
      return;
    }
    if (msg.type === 'room-created') {
      if (msg.clientId) this.userId = msg.clientId;
      this.mode = 'host';
      this.roomId = msg.roomId;
      this._syncUi();
      return;
    }
    if (msg.type === 'joined') {
      if (msg.clientId) this.userId = msg.clientId;
      this.mode = 'guest';
      this.roomId = msg.roomId;
      this.hostId = msg.hostId;
      this._syncUi();
      return;
    }
    if (msg.type === 'peer-joined' && this.isHost) {
      this._hostCreatePeer(msg.peerId).catch((err) => this._fail(err));
      this._syncUi();
      return;
    }
    if (msg.type === 'peer-left') {
      this._removePeer(msg.peerId);
      this._syncUi();
      return;
    }
    if (msg.type === 'room-closed') {
      const wasGuest = this.isGuest || this.mode === 'connecting';
      this.close(false);
      if (wasGuest) alert('La stanza e stata chiusa dall host.');
      return;
    }
    if (msg.type === 'signal') {
      this._onRtcSignal(msg.from, msg.data).catch((err) => this._fail(err));
    }
  }

  /** @param {string} peerId */
  async _hostCreatePeer(peerId) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC non disponibile: apri l app da localhost o HTTPS.');
    }
    const pc = this._makePeer(peerId);
    const dc = pc.createDataChannel('fable-paint', { ordered: true });
    this._bindDataChannel(peerId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._relay(peerId, { description: pc.localDescription });
  }

  /** @param {string} peerId @param {any} data */
  async _onRtcSignal(peerId, data) {
    if (!data) return;
    let entry = this.peers.get(peerId);
    if (!entry) {
      if (!this.isGuest) return;
      const pc = this._makePeer(peerId);
      pc.addEventListener('datachannel', (event) => this._bindDataChannel(peerId, event.channel));
      entry = this.peers.get(peerId);
    }
    const pc = entry.pc;
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._relay(peerId, { description: pc.localDescription });
      }
    }
    if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (err) { console.warn(err); }
    }
  }

  /** @param {string} peerId */
  _makePeer(peerId) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC non disponibile: apri l app da localhost o HTTPS.');
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, dc: null };
    this.peers.set(peerId, entry);
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) this._relay(peerId, { candidate: event.candidate });
    });
    pc.addEventListener('connectionstatechange', () => {
      const bad = pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed';
      if (!bad) return;
      if (this.isGuest) {
        this.close(false);
        alert('Connessione con l host persa. La stanza e chiusa.');
      } else {
        this._removePeer(peerId);
      }
      this._syncUi();
    });
    return pc;
  }

  /** @param {string} peerId @param {RTCDataChannel} dc */
  _bindDataChannel(peerId, dc) {
    const entry = this.peers.get(peerId);
    if (entry) entry.dc = dc;
    dc.addEventListener('open', () => {
      if (this.isHost) {
        this._sendToPeer(peerId, {
          type: 'hello',
          protocol: MP_PROTOCOL,
          roomId: this.roomId,
          seq: this.seq,
          snapshot: this.app.serializeSnapshot(),
        });
      } else {
        this._flushOutbox();
      }
      this._syncUi();
    });
    dc.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      this._onData(peerId, msg);
    });
    dc.addEventListener('close', () => {
      if (this._closing) return;
      if (this.isGuest) {
        this.close(false);
        alert('L host ha chiuso la stanza.');
      } else {
        this._removePeer(peerId);
      }
      this._syncUi();
    });
  }

  /** @param {string} peerId @param {any} msg */
  _onData(peerId, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'room_closed') {
      this.close(false);
      alert('L host ha chiuso la stanza.');
      return;
    }
    if (msg.type === 'hello' && this.isGuest) {
      if (msg.protocol !== MP_PROTOCOL) {
        alert('Versione multiplayer non compatibile.');
        this.close(false);
        return;
      }
      if (msg.snapshot) this.app.restoreSnapshot(msg.snapshot);
      this.seq = Number.isFinite(msg.seq) ? msg.seq : this.seq;
      this._flushOutbox();
      this._syncUi();
      return;
    }
    if (msg.type === 'client_op' && this.isHost) {
      if (!validDocOp(msg.op)) return;
      this._commitHostOp(msg.op, false);
      return;
    }
    if (msg.type === 'cursor') {
      this._setRemoteCursor(peerId, msg);
      if (this.isHost) this._broadcast({ ...msg, type: 'cursor' }, peerId);
      return;
    }
    if (msg.type === 'doc_op') {
      if (!validDocOp(msg.op)) return;
      this.seq = Math.max(this.seq, msg.seq || 0);
      if (msg.op.opId && this.pendingLocal.has(msg.op.opId)) {
        this.pendingLocal.delete(msg.op.opId);
        return;
      }
      this._enqueueRemote(msg.seq || 0, msg.op);
    }
  }

  /** @param {string} peerId @param {any} data */
  _relay(peerId, data) {
    if (!this.signaling || !this.roomId) return;
    this.signaling.send({ type: 'signal', roomId: this.roomId, to: peerId, data, clientId: this.userId });
  }

  /** @param {any} op */
  publishLocalOp(op) {
    if (!this.connected || !validDocOp(op)) return;
    if (!op.opId) op.opId = makeOpId(this.userId);
    op.userId = this.userId;
    if (this.isHost) {
      this._commitHostOp(op, true);
    } else {
      this.pendingLocal.add(op.opId);
      const msg = { type: 'client_op', op };
      if (!this._sendToHost(msg)) this.outbox.push(msg);
      this._syncUi();
    }
  }

  /** @param {any} op @param {boolean} alreadyApplied */
  _commitHostOp(op, alreadyApplied) {
    const seq = ++this.seq;
    const entry = { seq, op };
    this.history.push(entry);
    if (this.history.length > 1000) this.history.shift();
    if (!alreadyApplied) this._enqueueRemote(seq, op);
    this._broadcast({ type: 'doc_op', seq, op });
  }

  /** @param {number} seq @param {any} op */
  _enqueueRemote(seq, op) {
    this.remoteQueue.push({ seq, op });
    this.remoteQueue.sort((a, b) => a.seq - b.seq);
  }

  drainRemoteOps() {
    if (!this.remoteQueue.length || !this.app.canApplyRemoteOps()) return;
    const next = this.remoteQueue.shift();
    this.app.applyRemoteOp(next.op);
  }

  /** @param {import('../camera.js').Camera} camera @param {import('../input.js').InputManager} input */
  syncCursor(camera, input) {
    this._sendCursor(camera, input);
    this._renderRemoteCursors(camera);
  }

  /** @param {import('../camera.js').Camera} camera @param {import('../input.js').InputManager} input */
  _sendCursor(camera, input) {
    if (!this.connected || this.openPeerCount === 0) return;
    const now = performance.now();
    if (now - this._lastCursorSent < 45) return;
    this._lastCursorSent = now;
    const h = input.hover;
    const visible = !!(h.visible || input.isDrawing);
    camera.screenToWorld(h.x, h.y, this._cursorWorld);
    const msg = {
      type: 'cursor',
      peerId: this.userId,
      role: this.isHost ? 'host' : 'guest',
      name: this.isHost ? 'Host' : 'Guest',
      x: this._cursorWorld.x,
      y: this._cursorWorld.y,
      visible,
    };
    if (this.isHost) this._broadcast(msg);
    else if (!this._sendToHost(msg)) this.outbox.push(msg);
  }

  /** @param {string} peerId @param {any} msg */
  _setRemoteCursor(peerId, msg) {
    const id = String(msg.peerId || peerId);
    if (!id || id === this.userId) return;
    let cur = this.remoteCursors.get(id);
    if (!cur) {
      cur = {
        id,
        x: 0,
        y: 0,
        visible: false,
        role: 'guest',
        name: 'Guest',
        lastSeen: 0,
        el: this._createCursorEl(),
      };
      this.remoteCursors.set(id, cur);
      if (this.ui.cursorLayer) this.ui.cursorLayer.appendChild(cur.el);
    }
    cur.x = Number.isFinite(msg.x) ? msg.x : cur.x;
    cur.y = Number.isFinite(msg.y) ? msg.y : cur.y;
    cur.visible = msg.visible !== false;
    cur.role = msg.role === 'host' ? 'host' : 'guest';
    cur.name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim().slice(0, 24) : (cur.role === 'host' ? 'Host' : 'Guest');
    cur.lastSeen = performance.now();
    const color = cur.role === 'host' ? '#ff9f1c' : '#3b82f6';
    cur.el.style.color = color;
    cur.el.style.setProperty('--mp-color', color);
    const label = cur.el.querySelector('.mp-cursor-name');
    if (label) label.textContent = cur.name;
  }

  _createCursorEl() {
    const el = document.createElement('div');
    el.className = 'mp-cursor';
    el.innerHTML = `
      <div class="mp-cursor-name"></div>
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-mouse-pointer2-icon lucide-mouse-pointer-2"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>`;
    return el;
  }

  /** @param {import('../camera.js').Camera} camera */
  _renderRemoteCursors(camera) {
    const now = performance.now();
    for (const cur of this.remoteCursors.values()) {
      const stale = now - cur.lastSeen > 2500;
      cur.el.hidden = stale || !cur.visible;
      if (cur.el.hidden) continue;
      const p = camera.worldToScreen(cur.x, cur.y, { x: 0, y: 0 });
      cur.el.style.transform = `translate(${p.x - 4}px, ${p.y - 4}px)`;
    }
  }

  _clearRemoteCursors() {
    for (const cur of this.remoteCursors.values()) cur.el.remove();
    this.remoteCursors.clear();
  }

  /** @param {any} msg @param {string} [exceptPeerId] */
  _broadcast(msg, exceptPeerId = '') {
    for (const [peerId] of this.peers) {
      if (peerId === exceptPeerId) continue;
      this._sendToPeer(peerId, msg);
    }
  }

  /** @param {any} msg */
  _sendToHost(msg) {
    if (!this.hostId) return false;
    return this._sendToPeer(this.hostId, msg);
  }

  /** @param {string} peerId @param {any} msg */
  _sendToPeer(peerId, msg) {
    const entry = this.peers.get(peerId);
    const dc = entry && entry.dc;
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(msg));
    return true;
  }

  _flushOutbox() {
    if (!this.outbox.length) return;
    const pending = this.outbox.splice(0);
    for (const msg of pending) {
      if (!this._sendToHost(msg)) this.outbox.push(msg);
    }
  }

  /** @param {string} peerId */
  _removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try { entry.dc && entry.dc.close(); } catch { /* noop */ }
    try { entry.pc.close(); } catch { /* noop */ }
    this.peers.delete(peerId);
    const cur = this.remoteCursors.get(peerId);
    if (cur) {
      cur.el.remove();
      this.remoteCursors.delete(peerId);
    }
  }

  /** @param {string} [fallback] */
  _syncUi(fallback) {
    const { status, host, code, join, leave } = this.ui;
    if (!status) return;
    const peers = this.peers.size;
    const open = this.openPeerCount;
    if (fallback) status.textContent = fallback;
    else if (this.mode === 'host') status.textContent = `Host ${this.roomId}${peers ? ` · ${open}/${peers}` : ''}`;
    else if (this.mode === 'guest') status.textContent = open ? `Connesso ${this.roomId}` : `Collego ${this.roomId}`;
    else status.textContent = 'Offline';
    status.title = this._statusTitle();
    host.disabled = this.active;
    code.disabled = this.active;
    join.disabled = this.active;
    leave.disabled = !this.active;
  }

  _statusTitle() {
    if (this.mode === 'host') return `Host ${this.roomId}. Canali aperti: ${this.openPeerCount}/${this.peers.size}.`;
    if (this.mode === 'guest') return this.openPeerCount > 0
      ? `Connesso all host della stanza ${this.roomId}.`
      : `Entrato nel signaling della stanza ${this.roomId}, in attesa del canale WebRTC.`;
    return 'Multiplayer offline.';
  }
}

function defaultSignalingUrl() {
  const params = new URLSearchParams(location.search);
  const explicit = params.get('signal');
  if (explicit) return explicit;
  if (SIGNALING_URL) return SIGNALING_URL;
  if (location.protocol === 'file:') return 'ws://localhost:8787/signaling';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/signaling`;
}
