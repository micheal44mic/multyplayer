// Worker undo: comprime i tile-diff fuori dal path del dito.
// ArrayBuffer transferable in entrambe le direzioni; deflate-raw nativo
// (CompressionStream) con fallback "raw" se non disponibile.

/** @typedef {{key: number, buf: ArrayBuffer, rawSize?: number}} WireBuf */
/** @typedef {{id: number, op: 'compress'|'decompress', buffers: WireBuf[]}} WireMsg */

// Il progetto è type-checkato con la lib DOM (self = Window): qui siamo in un
// DedicatedWorkerGlobalScope, quindi si ritipizza il global con la firma worker.
const ctx = /** @type {{onmessage: ((e: MessageEvent) => void)|null, postMessage: (msg: any, transfer?: Transferable[]) => void}} */ (
  /** @type {unknown} */ (self));

const hasCS = typeof CompressionStream !== 'undefined';

/** @param {ArrayBuffer} buf @returns {Promise<ArrayBuffer>} */
async function deflate(buf) {
  const cs = new CompressionStream('deflate-raw');
  const blob = new Blob([buf]);
  return await new Response(blob.stream().pipeThrough(cs)).arrayBuffer();
}

/** @param {ArrayBuffer} buf @param {number} rawSize @returns {Promise<ArrayBuffer>} */
async function inflate(buf, rawSize) {
  const ds = new DecompressionStream('deflate-raw');
  const blob = new Blob([buf]);
  const out = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
  if (out.byteLength !== rawSize) throw new Error('inflate size mismatch');
  return out;
}

ctx.onmessage = async (/** @type {MessageEvent} */ e) => {
  const msg = /** @type {WireMsg} */ (e.data);
  try {
    if (msg.op === 'compress') {
      if (!hasCS) {
        // niente CompressionStream: rimanda i buffer raw com'erano
        ctx.postMessage({ id: msg.id, op: 'compress', ok: true, raw: true, buffers: msg.buffers },
          msg.buffers.map(b => b.buf));
        return;
      }
      /** @type {WireBuf[]} */
      const out = [];
      for (const item of msg.buffers) {
        const z = await deflate(item.buf);
        out.push({ key: item.key, buf: z, rawSize: item.buf.byteLength });
      }
      ctx.postMessage({ id: msg.id, op: 'compress', ok: true, raw: false, buffers: out },
        out.map(b => b.buf));
    } else if (msg.op === 'decompress') {
      /** @type {WireBuf[]} */
      const out = [];
      for (const item of msg.buffers) {
        const raw = await inflate(item.buf, item.rawSize ?? 0);
        out.push({ key: item.key, buf: raw });
      }
      ctx.postMessage({ id: msg.id, op: 'decompress', ok: true, buffers: out },
        out.map(b => b.buf));
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, op: msg.op, ok: false, error: String(err) });
  }
};
