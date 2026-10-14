import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Registry } from './registry.js';
import { VIEWER_FILES } from './static-files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only these files are ever served to browsers.
const STATIC = VIEWER_FILES;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const ID_RE = /^\d{9}$/;
const SECRET_RE = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, base64
const MAX_CONNECTS_PER_MINUTE = 30;
const MAX_VIEWER_BINARY = 64 * 1024;

/**
 * Bifrost connection server.
 *
 * A host registers with (id, secret). A viewer asks to connect to an id; the server pairs
 * the two sockets and relays everything between them. Authentication and consent happen
 * end to end between host and viewer, the server never learns a password.
 *
 * Messages originating from the server carry an `srv` key. Any forwarded message that
 * contains such a key is dropped, so a peer cannot impersonate the server.
 */
export function createBifrostServer({
  port = 7780,
  host = '0.0.0.0',
  dataDir = null,
  trustProxy = false,
  tls = null,
  log = () => {},
} = {}) {
  const registry = new Registry(dataDir);
  const hosts = new Map(); // id -> { ws, viewer: WebSocket|null }
  const attempts = new Map(); // ip -> { count, resetAt }

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    const entry = req.method === 'GET' ? STATIC.get(url.pathname) : undefined;
    if (!entry) {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
      return;
    }
    fs.readFile(path.join(ROOT, entry[0]), (err, body) => {
      if (err) {
        res.writeHead(500, SECURITY_HEADERS).end('Error');
        return;
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': entry[1] }).end(body);
    });
  };

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = clientIp(req, trustProxy);
      wss.emit('connection', ws);
    });
  });

  const sendSrv = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ srv: msg.srv, ...msg }));
  };

  function unpair(hostEntry, reason) {
    const viewer = hostEntry.viewer;
    if (!viewer) return;
    hostEntry.viewer = null;
    viewer.pair = null;
    sendSrv(viewer, { srv: 'ended', reason });
    sendSrv(hostEntry.ws, { srv: 'peer-left' });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.role = null;
    ws.pair = null;

    ws.on('message', (data, isBinary) => {
      if (ws.role === null) {
        if (isBinary) return ws.close(1008, 'hello required');
        return onHello(ws, data);
      }
      if (ws.role === 'viewer') return onViewerMessage(ws, data, isBinary);
      return onHostMessage(ws, data, isBinary);
    });

    ws.on('close', () => {
      if (ws.role === 'host' && ws.hostId) {
        const entry = hosts.get(ws.hostId);
        if (entry && entry.ws === ws) {
          unpair(entry, 'host-offline');
          hosts.delete(ws.hostId);
        }
      } else if (ws.role === 'viewer' && ws.pair) {
        const entry = hosts.get(ws.pair);
        if (entry && entry.viewer === ws) unpair(entry, 'viewer-left');
      }
    });
    ws.on('error', () => {});
  });

  function onHello(ws, data) {
    const msg = parse(data);
    if (msg?.t === 'host') {
      if (!ID_RE.test(msg.id ?? '') || !SECRET_RE.test(msg.secret ?? '')) {
        sendSrv(ws, { srv: 'error', code: 'bad_hello' });
        return ws.close(1008, 'bad hello');
      }
      if (registry.claim(msg.id, msg.secret) !== 'ok') {
        sendSrv(ws, { srv: 'error', code: 'id_taken' });
        return ws.close(1008, 'id taken');
      }
      const previous = hosts.get(msg.id);
      if (previous) {
        unpair(previous, 'host-replaced');
        previous.ws.close(1000, 'replaced');
      }
      ws.role = 'host';
      ws.hostId = msg.id;
      hosts.set(msg.id, { ws, viewer: null });
      sendSrv(ws, { srv: 'registered', id: msg.id });
      log(`host online ${msg.id}`);
    } else if (msg?.t === 'viewer') {
      ws.role = 'viewer';
      sendSrv(ws, { srv: 'ready' });
    } else {
      ws.close(1008, 'bad hello');
    }
  }

  function onViewerMessage(ws, data, isBinary) {
    if (isBinary) {
      // Encrypted input events: opaque to the server, small by construction.
      const entry = ws.pair ? hosts.get(ws.pair) : undefined;
      if (entry && entry.viewer === ws && data.length <= MAX_VIEWER_BINARY && entry.ws.readyState === entry.ws.OPEN) {
        entry.ws.send(data, { binary: true });
      }
      return;
    }
    const msg = parse(data);
    if (!msg || typeof msg.t !== 'string' || 'srv' in msg) return;

    if (!ws.pair) {
      if (msg.t !== 'connect') return;
      if (!allowAttempt(attempts, ws.ip)) return sendSrv(ws, { srv: 'error', code: 'rate_limited' });
      const id = String(msg.id ?? '').replace(/\s+/g, '');
      const entry = ID_RE.test(id) ? hosts.get(id) : undefined;
      if (!entry) return sendSrv(ws, { srv: 'error', code: 'offline' });
      if (entry.viewer) return sendSrv(ws, { srv: 'error', code: 'busy' });
      entry.viewer = ws;
      ws.pair = id;
      sendSrv(entry.ws, { srv: 'peer', ip: ws.ip });
      sendSrv(ws, { srv: 'paired' });
      return;
    }
    const entry = hosts.get(ws.pair);
    if (!entry || entry.viewer !== ws) return;
    if (msg.t === 'leave') return unpair(entry, 'viewer-left');
    if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(data, { binary: false });
  }

  function onHostMessage(ws, data, isBinary) {
    const entry = hosts.get(ws.hostId);
    if (!entry || entry.ws !== ws || !entry.viewer) return;
    if (isBinary) {
      if (entry.viewer.readyState === entry.viewer.OPEN) entry.viewer.send(data, { binary: true });
      return;
    }
    const msg = parse(data);
    if (!msg || typeof msg.t !== 'string' || 'srv' in msg) return;
    if (msg.t === 'leave') return unpair(entry, 'host-ended');
    if (entry.viewer.readyState === entry.viewer.OPEN) entry.viewer.send(data, { binary: false });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [ip, a] of attempts) if (a.resetAt < now) attempts.delete(ip);
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address().port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        registry.flush();
        for (const ws of wss.clients) ws.terminate();
        server.close(() => resolve());
      }),
  };
}

function parse(data) {
  try {
    const msg = JSON.parse(data.toString('utf8'));
    return msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
  } catch {
    return null;
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim().slice(0, 64);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function allowAttempt(attempts, ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.resetAt < now) {
    a = { count: 0, resetAt: now + 60_000 };
    attempts.set(ip, a);
  }
  a.count += 1;
  return a.count <= MAX_CONNECTS_PER_MINUTE;
}
