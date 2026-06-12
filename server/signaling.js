import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const MAX_GUESTS = 5;

/** @type {Map<string, {id: string, host: Client, guests: Map<string, Client>}>} */
const rooms = new Map();
/** @type {WeakMap<WebSocket, Client>} */
const clients = new WeakMap();

/**
 * @typedef {Object} Client
 * @property {WebSocket} ws
 * @property {string} id
 * @property {string} roomId
 * @property {'host'|'guest'|''} role
 */

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(root, '.' + pathname);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const noStore = ext === '.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'content-type': mime.get(ext) || 'application/octet-stream',
      'cache-control': noStore ? 'no-store' : 'public, max-age=60',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/signaling') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  /** @type {Client} */
  const client = { ws, id: randomId(), roomId: '', role: '' };
  clients.set(ws, client);
  send(ws, { type: 'ready' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    handle(client, msg);
  });
  ws.on('close', () => leave(client, 'disconnected'));
});

/** @param {Client} client @param {any} msg */
function handle(client, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.clientId && typeof msg.clientId === 'string') client.id = String(msg.clientId).slice(0, 80);

  if (msg.type === 'create') {
    leave(client, 'switch-room');
    const roomId = uniqueRoomId();
    const room = { id: roomId, host: client, guests: new Map() };
    client.roomId = roomId;
    client.role = 'host';
    rooms.set(roomId, room);
    send(client.ws, { type: 'room-created', roomId, clientId: client.id });
    return;
  }

  if (msg.type === 'join') {
    leave(client, 'switch-room');
    const roomId = String(msg.roomId || '').trim().toUpperCase();
    const room = rooms.get(roomId);
    if (!room) return send(client.ws, { type: 'error', code: 'room-not-found', message: 'Stanza non trovata.' });
    if (room.guests.size >= MAX_GUESTS) {
      return send(client.ws, { type: 'error', code: 'room-full', message: 'Stanza piena.' });
    }
    while (client.id === room.host.id || room.guests.has(client.id)) client.id = randomId();
    client.roomId = roomId;
    client.role = 'guest';
    room.guests.set(client.id, client);
    send(client.ws, { type: 'joined', roomId, clientId: client.id, hostId: room.host.id });
    send(room.host.ws, { type: 'peer-joined', roomId, peerId: client.id });
    return;
  }

  if (msg.type === 'signal') {
    const room = rooms.get(client.roomId);
    if (!room || msg.roomId !== client.roomId) return;
    const to = String(msg.to || '');
    const target = to === room.host.id ? room.host : room.guests.get(to);
    if (!target) return;
    send(target.ws, { type: 'signal', roomId: client.roomId, from: client.id, data: msg.data });
    return;
  }

  if (msg.type === 'leave') {
    leave(client, 'left');
    return;
  }

  if (msg.type === 'close-room' && client.role === 'host') {
    closeRoom(client.roomId, 'host-closed');
  }
}

/** @param {Client} client @param {string} reason */
function leave(client, reason) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = '';
    client.role = '';
    return;
  }
  if (client.role === 'host') {
    closeRoom(client.roomId, reason === 'switch-room' ? 'host-switched-room' : 'host-left');
    return;
  }
  room.guests.delete(client.id);
  send(room.host.ws, { type: 'peer-left', roomId: room.id, peerId: client.id, reason });
  client.roomId = '';
  client.role = '';
}

/** @param {string} roomId @param {string} reason */
function closeRoom(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const guest of room.guests.values()) {
    send(guest.ws, { type: 'room-closed', roomId, reason });
    guest.roomId = '';
    guest.role = '';
  }
  send(room.host.ws, { type: 'room-closed', roomId, reason });
  room.host.roomId = '';
  room.host.role = '';
  rooms.delete(roomId);
}

/** @param {WebSocket} ws @param {any} msg */
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function uniqueRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let out = '';
    for (let i = 0; i < 5; i++) out += alphabet[(Math.random() * alphabet.length) | 0];
    if (!rooms.has(out)) return out;
  }
}

server.listen(port, () => {
  console.log(`Fable Paint dev server: http://localhost:${port}`);
  console.log(`Signaling WebSocket: ws://localhost:${port}/signaling`);
});
