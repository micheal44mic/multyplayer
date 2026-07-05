// Static development server reachable from phones on the LAN.
// Usage: node serve.mjs [port]   (default 8000, listens on 0.0.0.0)
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGeminiFillRequest, handleGeminiGenerateRequest } from './server/gemini_fill.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/api/ai/fill') {
      await handleGeminiFillRequest(req, res);
      return;
    }
    if (pathname === '/api/ai/generate') {
      await handleGeminiGenerateRequest(req, res);
      return;
    }

    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const info = await stat(filePath);
    if (info.isDirectory()) { res.writeHead(301, { Location: urlPath + '/' }).end(); return; }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // crossOriginIsolated: senza questi lo SharedArrayBuffer (raster
      // worker) non esiste e il bridge resta spento. Ogni risorsa deve
      // essere same-origin o con CORP; i WebSocket (PeerJS) non sono toccati.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + req.url);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server at http://localhost:${PORT} and http://0.0.0.0:${PORT} (root: ${ROOT})`);
});
