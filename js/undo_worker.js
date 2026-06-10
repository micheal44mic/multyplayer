// Worker undo: comprime i tile-diff fuori dal path del dito.
// ArrayBuffer transferable in entrambe le direzioni; deflate-raw nativo
// (CompressionStream) con fallback "raw" se non disponibile.

const hasCS = typeof CompressionStream !== 'undefined';

async function deflate(buf) {
  const cs = new CompressionStream('deflate-raw');
  const blob = new Blob([buf]);
  return await new Response(blob.stream().pipeThrough(cs)).arrayBuffer();
}

async function inflate(buf, rawSize) {
  const ds = new DecompressionStream('deflate-raw');
  const blob = new Blob([buf]);
  const out = await new Response(blob.stream().pipeThrough(ds)).arrayBuffer();
  if (out.byteLength !== rawSize) throw new Error('inflate size mismatch');
  return out;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.op === 'compress') {
      if (!hasCS) {
        // niente CompressionStream: rimanda i buffer raw com'erano
        self.postMessage({ id: msg.id, op: 'compress', ok: true, raw: true, buffers: msg.buffers },
          msg.buffers.map(b => b.buf));
        return;
      }
      const out = [];
      for (const item of msg.buffers) {
        const z = await deflate(item.buf);
        out.push({ key: item.key, buf: z, rawSize: item.buf.byteLength });
      }
      self.postMessage({ id: msg.id, op: 'compress', ok: true, raw: false, buffers: out },
        out.map(b => b.buf));
    } else if (msg.op === 'decompress') {
      const out = [];
      for (const item of msg.buffers) {
        const raw = await inflate(item.buf, item.rawSize);
        out.push({ key: item.key, buf: raw });
      }
      self.postMessage({ id: msg.id, op: 'decompress', ok: true, buffers: out },
        out.map(b => b.buf));
    }
  } catch (err) {
    self.postMessage({ id: msg.id, op: msg.op, ok: false, error: String(err) });
  }
};
