// Portafoglio token per le generazioni AI degli Spaces. Persistito in
// localStorage. Cambio: 1 T = 1 centesimo di dollaro (100 T = 1 $).
// I prezzi per generazione in GEN_PRICING sono il costo API Google +30%
// arrotondato per eccesso (margine reale 30-60%) — ritoccare qui.

const KEY = 'fable-paint.tokens';
const START_BALANCE = 990;

/**
 * Prezzo in token per UNA immagine, per modello e qualità.
 * Costi API di riferimento (ai.google.dev/pricing, da ricontrollare):
 * Nano Banana ~$0.039 · Nano Banana 2 ~$0.06 (stima) · Pro 1K/2K $0.134 · Pro 4K $0.24.
 * @type {Record<string, Record<string, number>>}
 */
export const GEN_PRICING = {
  'gemini-2.5-flash-image': { '1K': 6 },
  'gemini-3.1-flash-image': { '1K': 9 },
  'gemini-3-pro-image': { '1K': 18, '2K': 22, '4K': 32 },
};

/**
 * @param {string} model
 * @param {string} [quality]
 * @param {number} [variants]
 * @returns {number} costo totale in token
 */
export function genCost(model, quality = '1K', variants = 1) {
  const table = GEN_PRICING[model] || GEN_PRICING['gemini-3-pro-image'];
  const per = table[quality] || table['1K'] || 18;
  return per * Math.max(1, Math.floor(variants) || 1);
}

class TokenWallet {
  constructor() {
    /** @type {Array<(balance:number, delta:number) => void>} */
    this._subs = [];
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
    const v = raw === null ? NaN : Number(raw);
    this._balance = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : START_BALANCE;
  }

  get balance() { return this._balance; }

  /** @param {number} n @returns {boolean} false se il saldo non basta */
  spend(n) {
    if (n > this._balance) return false;
    this._set(this._balance - n, -n);
    return true;
  }

  /** @param {number} n */
  refund(n) {
    this._set(this._balance + n, n);
  }

  /** @param {number} v @param {number} delta */
  _set(v, delta) {
    this._balance = Math.max(0, Math.floor(v));
    try { localStorage.setItem(KEY, String(this._balance)); } catch { /* storage unavailable */ }
    for (const fn of this._subs) fn(this._balance, delta);
  }

  /** @param {(balance:number, delta:number) => void} fn */
  onChange(fn) {
    this._subs.push(fn);
  }
}

export const wallet = new TokenWallet();
