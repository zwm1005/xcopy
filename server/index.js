import { createServer } from 'node:http';
import { createHash, createHmac, createPublicKey, randomBytes, randomInt, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from './store.js';
import { loadConfig } from './config.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const randomId = () => randomBytes(32).toString('base64url');
const terminal = new Set(['completed', 'failed', 'cancelled']);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireThat(ok, code, message) {
  if (!ok) {
    throw new ClientError(code, message);
  }
}

function cleanName(value) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 24, 'INVALID_NAME', '设备名称应为 1–24 个字符');
  return value.trim();
}

export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = new Store(config.dbPath);
  const sockets = new Set();
  const sessions = new Map();
  const codes = new Map();
  const requests = new Map();
  const transfers = new Map();
  const limits = new Map();
  const now = overrides.now || Date.now;

  function rate(key, limit, windowMs = 60000, cooldown = windowMs) {
    const time = now();
    let entry = limits.get(key);
    if (!entry || (time >= entry.until && time >= entry.blockedUntil)) {
      entry = { count: 0, until: time + windowMs, blockedUntil: 0 };
      limits.set(key, entry);
    }
    requireThat(time >= entry.blockedUntil, 'RATE_LIMIT', '操作太频繁，请稍后再试');
    entry.count += 1;
    if (entry.count > limit) {
      entry.blockedUntil = time + cooldown;
      throw new ClientError('RATE_LIMIT', '操作太频繁，请稍后再试');
    }
  }

  function send(ws, type, data) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  function deviceSockets(id) {
    return [...sockets].filter((ws) => ws.deviceId === id && ws.readyState === WebSocket.OPEN);
  }

  function emitDevice(id, type, data) {
    for (const ws of deviceSockets(id)) {
      send(ws, type, data);
    }
  }

  function validPair(a, b) {
    return Boolean(store.relationship(a, b));
  }

  function activeBetween(a, b) {
    return [...transfers.values()].filter((t) => !terminal.has(t.status) && ((t.from === a && t.to === b) || (t.from === b && t.to === a)));
  }

  function peers(id) {
    return store.peers(id).map((p) => ({ ...p, online: deviceSockets(p.id).length > 0, busy: activeBetween(id, p.id).length }));
  }

  function publish() {
    for (const ws of sockets) {
      if (ws.deviceId) {
        send(ws, 'peers', { peers: peers(ws.deviceId), name: store.device(ws.deviceId).name });
      }
    }
  }

  function iceServers(id) {
    const result = config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
    if (config.turnUrls.length) {
      const username = `${Math.floor(now() / 1000) + 3600}:${id.slice(0, 16)}`;
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      result.push({ urls: config.turnUrls, username, credential });
    }
    return result;
  }

  function finish(t, status, reason = '') {
    if (terminal.has(t.status)) {
      return;
    }
    t.status = status;
    t.updated = now();
    send(t.sender, 'transfer.state', { id: t.id, status, reason });
    send(t.receiver, 'transfer.state', { id: t.id, status, reason });
    publish();
  }

  function endRequest(id, status) {
    const request = requests.get(id);
    if (request) {
      emitDevice(request.owner, 'pair.result', { id, status });
      send(request.requester, 'pair.result', { id, status });
      requests.delete(id);
    }
  }

  function invalidateCode(code, status = 'expired') {
    const entry = codes.get(code);
    codes.delete(code);
    if (entry) {
      emitDevice(entry.owner, 'pair.codeExpired', { code });
    }
    for (const [id, request] of requests) {
      if (request.code === code) {
        endRequest(id, status);
      }
    }
  }

  function task(ws, id) {
    const t = transfers.get(id);
    requireThat(t && (t.sender === ws || t.receiver === ws), 'NOT_FOUND', '传输不存在或不属于当前页面');
    requireThat(!terminal.has(t.status), 'TRANSFER_ENDED', '传输已结束');
    requireThat(validPair(t.from, t.to), 'NOT_PAIRED', '配对已失效，请重新连接');
    return t;
  }

  function handle(ws, type, data = {}) {
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 'INVALID', '请求格式错误');
    if (type === 'auth.begin') {
      requireThat(!ws.deviceId, 'INVALID', '已经验证身份');
      rate(`auth:${ws.source}`, 30);
      rate('auth:global', 300);
      requireThat(typeof data.publicKey === 'string' && data.publicKey.length < 256, 'INVALID_KEY', '设备公钥无效');
      let key;
      let canonical;
      try {
        key = createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), format: 'der', type: 'spki' });
        requireThat(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1', 'INVALID_KEY', '设备公钥无效');
        canonical = key.export({ type: 'spki', format: 'der' });
      } catch {
        throw new ClientError('INVALID_KEY', '设备公钥无效');
      }
      const fingerprint = createHash('sha256').update(canonical).digest('hex');
      const challenge = `suichuan:auth:v1:${fingerprint}:${randomId()}`;
      ws.challenge = { fingerprint, key, publicKey: canonical.toString('base64'), challenge, expires: now() + config.challengeTtl, name: cleanName(data.name) };
      return { challenge, fingerprint };
    }
    if (type === 'auth.finish') {
      requireThat(!ws.deviceId, 'INVALID', '已经验证身份');
      const c = ws.challenge;
      ws.challenge = null;
      requireThat(c && c.expires > now(), 'AUTH_FAILED', '身份验证失败，请重试');
      requireThat(typeof data.signature === 'string' && data.signature.length < 200 && verify('sha256', Buffer.from(c.challenge), { key: c.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(data.signature, 'base64')), 'AUTH_FAILED', '身份验证失败，请重试');
      const device = store.register(c.fingerprint, c.publicKey, c.name, now());
      ws.deviceId = device.id;
      ws.sessionId = randomId();
      sessions.set(ws.sessionId, ws);
      let resumed = false;
      const old = sessions.get(data.resumeSession);
      if (old && old !== ws && old.deviceId === ws.deviceId && old.readyState !== WebSocket.OPEN && now() - old.closedAt < config.reconnectGrace) {
        for (const t of transfers.values()) {
          if (t.sender === old) {
            t.sender = ws;
          }
          if (t.receiver === old) {
            t.receiver = ws;
          }
        }
        sessions.delete(old.sessionId);
        resumed = true;
      }
      for (const peer of store.peers(device.id)) {
        if (deviceSockets(peer.id).length) {
          store.pair(device.id, peer.id, now());
        }
      }
      publish();
      return { device: { id: device.id, name: device.name }, sessionId: ws.sessionId, resumed, peers: peers(device.id), config: { maxFileBytes: config.maxFileBytes, maxTextBytes: config.maxTextBytes, forceRelay: config.forceRelay, hasTurn: config.turnUrls.length > 0 }, tasks: [...transfers.values()].filter((t) => t.sender === ws || t.receiver === ws).map((t) => ({ id: t.id, status: t.status })) };
    }

    requireThat(ws.deviceId, 'UNAUTHORIZED', '请先验证设备身份');
    switch (type) {
      case 'peers.list':
        return { peers: peers(ws.deviceId) };
      case 'device.rename': {
        store.rename(ws.deviceId, cleanName(data.name));
        publish();
        return {};
      }
      case 'pair.code': {
        rate(`code:${ws.deviceId}`, 10);
        rate('code:global', 200);
        for (const [code, entry] of codes) {
          if (entry.owner === ws.deviceId) {
            invalidateCode(code);
          }
        }
        let code;
        do {
          code = String(randomInt(100000000)).padStart(8, '0');
        } while (codes.has(code));
        const expires = now() + config.codeTtl;
        codes.set(code, { owner: ws.deviceId, expires });
        return { code, expires };
      }
      case 'pair.join': {
        rate(`join:${ws.source}`, config.joinLimit, 60000, 300000);
        rate('join:global', config.joinGlobalLimit);
        const entry = codes.get(data.code);
        requireThat(entry && entry.expires > now() && entry.owner !== ws.deviceId && deviceSockets(entry.owner).length, 'INVALID_CODE', '连接码无效或已过期');
        requireThat(!validPair(entry.owner, ws.deviceId), 'ALREADY_PAIRED', '已与这台设备配对');
        requireThat(![...requests.values()].some((r) => r.from === ws.deviceId), 'PENDING', '已有连接请求正在等待确认');
        const id = randomId();
        requests.set(id, { code: data.code, owner: entry.owner, from: ws.deviceId, requester: ws, expires: entry.expires });
        emitDevice(entry.owner, 'pair.request', { id, name: store.device(ws.deviceId).name, fingerprint: ws.deviceId, expires: entry.expires });
        return { id, expires: entry.expires };
      }
      case 'pair.cancel': {
        const r = requests.get(data.id);
        requireThat(r?.from === ws.deviceId, 'NOT_FOUND', '连接请求已结束');
        endRequest(data.id, 'cancelled');
        return {};
      }
      case 'pair.respond': {
        const r = requests.get(data.id);
        requireThat(r && r.owner === ws.deviceId && r.expires > now() && codes.has(r.code) && r.requester.readyState === WebSocket.OPEN, 'NOT_FOUND', '连接请求已结束');
        requireThat(typeof data.allow === 'boolean', 'INVALID', '请求格式错误');
        if (!data.allow) {
          endRequest(data.id, 'denied');
          return {};
        }
        store.pair(r.owner, r.from, now());
        endRequest(data.id, 'paired');
        invalidateCode(r.code);
        publish();
        return {};
      }
      case 'pair.forget': {
        requireThat(typeof data.peerId === 'string' && store.relationship(ws.deviceId, data.peerId), 'NOT_FOUND', '配对关系不存在');
        // All mutation handlers are synchronous on one process: check + revoke cannot
        // interleave with transfer.start, including requests from another browser tab.
        requireThat(activeBetween(ws.deviceId, data.peerId).length === 0, 'BUSY', '传输结束后可忘记配对');
        store.removePair(ws.deviceId, data.peerId);
        emitDevice(ws.deviceId, 'pair.forgotten', { peerId: data.peerId });
        emitDevice(data.peerId, 'pair.forgotten', { peerId: ws.deviceId });
        publish();
        return {};
      }
      case 'transfer.start': {
        requireThat(typeof data.peerId === 'string' && validPair(ws.deviceId, data.peerId), 'NOT_PAIRED', '尚未配对或已忘记配对，请重新连接');
        const receiver = deviceSockets(data.peerId)[0];
        requireThat(receiver, 'OFFLINE', '接收设备不在线');
        const active = [...transfers.values()].filter((t) => !terminal.has(t.status));
        requireThat(active.filter((t) => t.from === ws.deviceId || t.to === ws.deviceId).length < config.maxActive && active.filter((t) => t.from === data.peerId || t.to === data.peerId).length < config.maxActive, 'BUSY', '传输任务较多，请稍后再试');
        const m = data.metadata;
        requireThat(m && ['text', 'file', 'image'].includes(m.kind) && Number.isSafeInteger(m.size) && m.size >= 0 && m.size <= (m.kind === 'text' ? config.maxTextBytes : config.maxFileBytes), 'SIZE_LIMIT', '内容超出大小限制');
        requireThat(typeof m.name === 'string' && m.name.length <= 255 && typeof m.mime === 'string' && m.mime.length <= 100, 'INVALID', '文件信息无效');
        const id = randomId();
        const t = { id, from: ws.deviceId, to: data.peerId, sender: ws, receiver, status: 'waiting', created: now(), updated: now() };
        transfers.set(id, t);
        send(receiver, 'transfer.offer', { id, peerId: t.from, peerName: store.device(t.from).name, metadata: { kind: m.kind, size: m.size, name: m.name, mime: m.mime }, iceServers: iceServers(t.to), forceRelay: config.forceRelay });
        publish();
        return { id, iceServers: iceServers(t.from), forceRelay: config.forceRelay };
      }
      case 'transfer.accept': {
        const t = task(ws, data.id);
        requireThat(t.receiver === ws && t.status === 'waiting', 'FORBIDDEN', '不能接受此传输');
        t.status = 'transferring';
        t.updated = now();
        store.pair(t.from, t.to, now());
        send(t.sender, 'transfer.accepted', { id: t.id });
        return {};
      }
      case 'signal': {
        const t = task(ws, data.id);
        requireThat(t.status === 'transferring', 'INVALID', '接收端尚未准备好');
        const s = data.signal;
        requireThat(s && typeof s === 'object' && JSON.stringify(s).length < 50000, 'INVALID', '协商信息无效');
        if (s.description) {
          requireThat(s.description.type === (t.sender === ws ? 'offer' : 'answer') && typeof s.description.sdp === 'string', 'INVALID', '协商信息无效');
        } else {
          requireThat(s.candidate && typeof s.candidate.candidate === 'string' && s.candidate.candidate.length < 4096, 'INVALID', '协商信息无效');
        }
        send(t.sender === ws ? t.receiver : t.sender, 'signal', { id: t.id, signal: s });
        t.updated = now();
        return {};
      }
      case 'transfer.progress': {
        const t = task(ws, data.id);
        t.updated = now();
        return {};
      }
      case 'transfer.end': {
        const t = task(ws, data.id);
        requireThat(['completed', 'failed', 'cancelled'].includes(data.status), 'INVALID', '传输状态无效');
        if (data.status === 'completed') {
          requireThat(t.receiver === ws && t.status === 'transferring', 'FORBIDDEN', '仅接收端可确认送达');
          store.pair(t.from, t.to, now());
        }
        finish(t, data.status, data.status === 'failed' ? '传输失败，请重试' : '');
        return {};
      }
      default:
        throw new ClientError('INVALID', '不支持的请求');
    }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    if (config.origin.startsWith('https:')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let path;
    try {
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) {
        res.writeHead(400).end('Bad request');
        return;
      }
      path = new URL(req.url, config.origin).pathname;
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    // Explicit allowlist: never expose the SQLite database, env file or source tree.
    const files = new Set(['/index.html', '/transfer.html', '/home.js', '/home.css', '/app.js', '/identity.js', '/connection.js', '/transfer.js', '/styles.css', '/icon.svg']);
    const pages = { '/': '/index.html', '/transfer': '/transfer.html', '/transfer/': '/transfer.html' };
    const file = Object.hasOwn(pages, path) ? pages[path] : path;
    if (!files.has(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const content = await readFile(resolve(publicDir, `.${file}`));
      res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] }).end(req.method === 'HEAD' ? undefined : content);
    } catch {
      res.writeHead(500).end('Service unavailable');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      requireThat(req.headers.origin === config.origin && req.url === '/ws', 'FORBIDDEN', 'Origin rejected');
      const source = config.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
      rate(`connect:${source}`, 60);
      requireThat(sockets.size < 1000, 'BUSY', 'Too many connections');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.source = source;
        wss.emit('connection', ws);
      });
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.openedAt = now();
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      let message;
      try {
        requireThat(!isBinary, 'INVALID', '这里只接受控制消息');
        rate(`messages:${ws.source}`, 3000);
        message = JSON.parse(raw.toString());
        requireThat(typeof message.id === 'string' && message.id.length <= 80 && typeof message.type === 'string', 'INVALID', '请求格式错误');
        const data = handle(ws, message.type, message.data);
        ws.send(JSON.stringify({ replyTo: message.id, ok: true, data }));
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ replyTo: message?.id, ok: false, error: { code: error instanceof ClientError ? error.code : 'INVALID', message: error instanceof ClientError ? error.message : '请求无法处理' } }));
        }
      }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      ws.closedAt = now();
      for (const [id, r] of requests) {
        if (r.requester === ws || (r.owner === ws.deviceId && !deviceSockets(ws.deviceId).length)) {
          endRequest(id, 'cancelled');
        }
      }
      if (ws.deviceId && !deviceSockets(ws.deviceId).length) {
        for (const [code, c] of codes) {
          if (c.owner === ws.deviceId) {
            invalidateCode(code);
          }
        }
      }
      publish();
    });
  });

  function sweep() {
    for (const [code, c] of codes) {
      if (c.expires <= now()) {
        invalidateCode(code);
      }
    }
    for (const [id, t] of transfers) {
      if (terminal.has(t.status)) {
        if (now() - t.updated > config.reconnectGrace * 2) {
          transfers.delete(id);
        }
        continue;
      }
      const disconnected = [t.sender, t.receiver].some((ws) => ws.readyState !== WebSocket.OPEN && now() - ws.closedAt > config.reconnectGrace);
      if (disconnected || now() - t.updated > config.idleTimeout || !validPair(t.from, t.to)) {
        finish(t, 'failed', '连接中断或超时，请重新发送');
      }
    }
    for (const [id, ws] of sessions) {
      if (ws.closedAt && now() - ws.closedAt > config.reconnectGrace * 2) {
        sessions.delete(id);
      }
    }
    for (const [key, value] of limits) {
      if (now() > Math.max(value.until, value.blockedUntil)) {
        limits.delete(key);
      }
    }
    for (const ws of sockets) {
      if (!ws.deviceId && now() - ws.openedAt > config.challengeTtl) {
        ws.close(1008, 'Authentication timeout');
      }
    }
  }
  const maintenance = setInterval(sweep, 1000);
  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    publish();
  }, 15000);
  maintenance.unref();
  heartbeat.unref();

  return {
    server, store, config, sweep,
    listen: () => new Promise((resolveListen) => server.listen(config.port, config.host, () => resolveListen(server.address()))),
    close: () => new Promise((resolveClose) => {
      clearInterval(maintenance);
      clearInterval(heartbeat);
      for (const ws of sockets) {
        ws.terminate();
      }
      wss.close();
      server.close(() => { store.close(); resolveClose(); });
    })
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  await app.listen();
  console.log(`随传已启动：${app.config.origin}`);
  if (!app.config.turnUrls.length) {
    console.log('未配置 TURN：当前可测试直连，跨网部署请配置自建 TURN。');
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await app.close(); process.exit(0); });
  }
}
