// UI DELLA COLLABORAZIONE — bottone in toolbar (iniettato accanto a Esporta),
// pannello Collabora (crea/unisciti, lista utenti, TURN opzionale), toast e
// overlay di sincronizzazione. Solo DOM: la logica vive in collab.js.

/** @typedef {import('./collab.js').Collab} Collab */

const NAME_KEY = 'fable-paint.collab-name';
const TURN_KEY = 'fable-paint.turn';

const ICON_USERS =
  '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
  '<circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
  '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

export class CollabUI {
  /** @param {Collab} collab */
  constructor(collab) {
    this.collab = collab;
    /** @type {''|'busy'|'live'} */
    this._state = '';
    this._toastTimer = 0;

    // bottone in toolbar, prima di Esporta
    const btn = document.createElement('button');
    btn.id = 'btn-collab';
    btn.className = 'tb-btn';
    btn.title = 'Collaborate: draw with others in real time';
    btn.innerHTML = ICON_USERS;
    const exportBtn = document.getElementById('btn-export');
    if (exportBtn && exportBtn.parentElement) exportBtn.parentElement.insertBefore(btn, exportBtn);
    else document.getElementById('toolbar')?.appendChild(btn);
    this.btn = btn;
    btn.addEventListener('click', () => this.toggle());

    // pannello
    const panel = document.createElement('section');
    panel.id = 'collabpanel';
    panel.setAttribute('aria-label', 'Collaborate');
    panel.innerHTML = `
      <div id="cb-head"><span>Collaborate</span>
        <button id="cb-close" class="tb-btn" title="Close">✕</button></div>
      <div id="cb-body">
        <div id="cb-idle">
          <label class="cb-field">Your name
            <input id="cb-name" maxlength="20" placeholder="e.g. Michi"></label>
          <button id="cb-host" class="cb-primary">Create Session</button>
          <div class="cb-or">— or —</div>
          <div class="cb-join-row">
            <input id="cb-code" maxlength="8" placeholder="CODE"
              autocapitalize="characters" autocomplete="off" spellcheck="false">
            <button id="cb-join">Join</button>
          </div>
          <p class="cb-hint">The session creator hosts the canvas: others join
            with the code and receive a synchronized copy. Direct browser-to-browser
            connection (WebRTC), no drawing server.</p>
          <details id="cb-adv"><summary>Difficult Networks (optional TURN)</summary>
            <textarea id="cb-turn" rows="3" spellcheck="false"
              placeholder='{"urls":"turn:host:3478","username":"u","credential":"c"}'></textarea>
            <p class="cb-hint">If peers cannot see each other (classic WiFi↔4G:
              incompatible NATs), paste TURN server credentials here
              (for example Metered Open Relay or Cloudflare, which have free tiers).
              Include TCP/443 entries too: they pass almost everywhere.</p>
            <button id="cb-icetest">Test STUN/TURN from this network</button>
            <div id="cb-icetest-out" class="cb-hint"></div>
          </details>
          <div id="cb-status"></div>
        </div>
        <div id="cb-live" hidden>
          <div id="cb-code-row" hidden>
            <span class="cb-hint">Session code</span>
            <b id="cb-code-big"></b>
            <button id="cb-copy" class="tb-btn" title="Copy the code">Copy</button>
          </div>
          <div id="cb-users"></div>
          <p class="cb-hint" id="cb-live-hint"></p>
          <button id="cb-leave">Leave Session</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;

    // toast + overlay sync
    const toast = document.createElement('div');
    toast.id = 'cb-toast';
    toast.hidden = true;
    document.body.appendChild(toast);
    this.toastEl = toast;

    const standby = document.createElement('div');
    standby.id = 'cb-standby';
    standby.hidden = true;
    document.body.appendChild(standby);
    this.standbyEl = standby;

    const overlay = document.createElement('div');
    overlay.id = 'cb-sync';
    overlay.hidden = true;
    overlay.innerHTML = '<div class="cb-card"><div class="cb-spin"></div><span id="cb-sync-msg"></span></div>';
    document.body.appendChild(overlay);
    this.overlay = overlay;

    // riferimenti + eventi
    const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (panel.querySelector('#' + id));
    this.nameInput = /** @type {HTMLInputElement} */ ($('cb-name'));
    this.codeInput = /** @type {HTMLInputElement} */ ($('cb-code'));
    this.turnInput = /** @type {HTMLTextAreaElement} */ ($('cb-turn'));
    this.statusEl = $('cb-status');
    this.idleEl = $('cb-idle');
    this.liveEl = $('cb-live');
    this.codeRow = $('cb-code-row');
    this.codeBig = $('cb-code-big');
    this.usersEl = $('cb-users');
    this.liveHint = $('cb-live-hint');
    this.hostBtn = /** @type {HTMLButtonElement} */ ($('cb-host'));
    this.joinBtn = /** @type {HTMLButtonElement} */ ($('cb-join'));

    try {
      this.nameInput.value = localStorage.getItem(NAME_KEY) || '';
      this.turnInput.value = localStorage.getItem(TURN_KEY) || '';
    } catch { /* storage negato */ }

    $('cb-close').addEventListener('click', () => this.close());
    this.nameInput.addEventListener('change', () => {
      try { localStorage.setItem(NAME_KEY, this.nameInput.value); } catch { /* */ }
    });
    this.turnInput.addEventListener('change', () => {
      try { localStorage.setItem(TURN_KEY, this.turnInput.value.trim()); } catch { /* */ }
    });
    this.hostBtn.addEventListener('click', () => {
      this.collab.host(this._name());
    });
    this.joinBtn.addEventListener('click', () => this._join());
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._join();
    });
    const iceBtn = /** @type {HTMLButtonElement} */ ($('cb-icetest'));
    const iceOut = $('cb-icetest-out');
    iceBtn.addEventListener('click', async () => {
      // la textarea può non aver ancora emesso 'change': persisti ora
      try { localStorage.setItem(TURN_KEY, this.turnInput.value.trim()); } catch { /* */ }
      iceBtn.disabled = true;
      iceOut.textContent = 'Gathering candidates...';
      try {
        const r = await this.collab.testIce();
        const stun = r.srflx ? '✓ STUN OK (srflx)' : '✗ STUN unreachable (UDP blocked?)';
        const turn = !r.turnConfigured ? '— TURN not configured'
          : r.relay ? '✓ TURN OK (relay)' : '✗ TURN is not responding (credentials/address?)';
        let verdict;
        if (r.srflx && (!r.turnConfigured)) {
          verdict = 'P2P is possible from your network; without TURN, WiFi↔4G may still fail.';
        } else if (r.srflx && r.relay) {
          verdict = 'You are covered: P2P when possible, relay when needed.';
        } else if (!r.srflx && r.relay) {
          verdict = 'STUN is blocked, but TURN responds: connections will use the relay.';
        } else if (!r.srflx) {
          verdict = 'This network blocks UDP: you need TURN over TCP/443.';
        } else {
          verdict = 'Check the pasted TURN credentials.';
        }
        iceOut.innerHTML = `${stun}<br>${turn}<br><b>${verdict}</b>`;
      } catch (err) {
        iceOut.textContent = 'Test failed: ' + (err instanceof Error ? err.message : err);
      } finally {
        iceBtn.disabled = false;
      }
    });

    $('cb-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.collab.code);
        this.toast('Code copied.');
      } catch {
        this.toast('Manual copy: ' + this.collab.code);
      }
    });
    $('cb-leave').addEventListener('click', () => {
      if (this.collab.role === 'host' && this.collab.users.size > 1 &&
        !confirm('You are the host: leaving will end the session for everyone. Continue?')) return;
      this.collab.leave();
    });

    this.setIdle();
  }

  _name() {
    const n = this.nameInput.value.trim();
    return n || 'User';
  }

  _join() {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length < 4) { this.toast('Enter the session code.'); return; }
    if (!confirm('Joining will REPLACE the open document with the host canvas. Continue?')) return;
    this.collab.join(this._name(), code);
  }

  // ---- stati ----

  get isOpen() { return this.panel.classList.contains('open'); }
  toggle() { this.panel.classList.toggle('open'); }
  close() { this.panel.classList.remove('open'); }

  /** @param {string} msg */
  setBusy(msg) {
    this._state = 'busy';
    this.statusEl.textContent = msg;
    this.hostBtn.disabled = true;
    this.joinBtn.disabled = true;
  }

  /** @param {string} msg */
  fail(msg) {
    this.setIdle();
    this.toast(msg);
  }

  setLive() {
    this._state = 'live';
    this.idleEl.hidden = true;
    this.liveEl.hidden = false;
    const isHost = this.collab.role === 'host';
    this.codeRow.hidden = !isHost;
    if (isHost) this.codeBig.textContent = this.collab.code;
    this.liveHint.textContent = isHost
      ? 'Share the code: anyone who joins receives your canvas. All tools are active; Undo/Redo are SHARED (they act on the most recent change by anyone).'
      : 'You are connected to the host canvas. All tools are active; Undo/Redo are SHARED (they act on the most recent change by anyone).';
    this.btn.classList.add('on');
    this.renderUsers();
    if (!this.isOpen) this.panel.classList.add('open');
  }

  setIdle() {
    this._state = '';
    this.idleEl.hidden = false;
    this.liveEl.hidden = true;
    this.statusEl.textContent = '';
    this.hostBtn.disabled = false;
    this.joinBtn.disabled = false;
    this.btn.classList.remove('on');
  }

  renderUsers() {
    if (this._state !== 'live') return;
    const me = this.collab.uid;
    let html = '';
    for (const [uid, u] of this.collab.users) {
      // badge di rete: stato della MIA connessione verso quel peer (l'host
      // lo vede per ogni guest, il guest solo verso l'host)
      const net = uid !== me ? this.collab._net.get(uid) : null;
      html += `<div class="cb-user"><span class="cb-dot" style="background:${u.color}"></span>` +
        `<span class="cb-uname">${escapeHtml(u.name)}</span>` +
        `${uid === 0 ? '<span class="cb-tag">host</span>' : ''}` +
        `${uid === me ? '<span class="cb-tag">you</span>' : ''}` +
        `${net ? `<span class="cb-net cb-net-${net.cls}">${escapeHtml(net.label)}</span>` : ''}</div>`;
    }
    this.usersEl.innerHTML = html;
  }

  /** @param {boolean} show @param {string} [msg] */
  syncOverlay(show, msg) {
    this.overlay.hidden = !show;
    if (msg) {
      const el = this.overlay.querySelector('#cb-sync-msg');
      if (el) el.textContent = msg;
    }
  }

  /** @param {boolean} show @param {string} [msg] */
  standby(show, msg) {
    this.standbyEl.hidden = !show;
    if (msg) this.standbyEl.textContent = msg;
  }

  /** @param {string} msg */
  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = /** @type {any} */ (setTimeout(() => {
      this.toastEl.classList.remove('show');
      this.toastEl.hidden = true;
    }, 2800));
  }
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}
