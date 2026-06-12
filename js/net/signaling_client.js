export class SignalingClient {
  /** @param {string} url @param {(msg: any) => void} onMessage */
  constructor(url, onMessage) {
    this.url = url;
    this.onMessage = onMessage;
    /** @type {WebSocket|null} */
    this.ws = null;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const fail = () => reject(new Error('Signaling non raggiungibile.'));
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', fail, { once: true });
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        this.onMessage(msg);
      });
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
      });
    });
  }

  /** @param {any} msg */
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
