import { assets } from './assets.js';
import { analyticsMarkup, analyticsPrivacy } from './analytics.js';
import { discovery, pageMetadata } from './discovery.js';
import { pageLocale } from './page-html.js';
import { messageDescriptor } from './messages.js';
import { assertFrontend } from '../scripts/frontend-artifact.js';
import { createServer } from 'node:http';
import { createHash, createHmac, createPublicKey, randomBytes, randomInt, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from './store.js';
import { loadConfig } from './config.js';
import { createShares } from './shares.js';
import { connectionQuotas, sourceKey, TokenBuckets } from './availability.js';
import { validDeviceName } from '../src/shared/device-name.js';

const publicDir = fileURLToPath(new URL('../dist/public/', import.meta.url));
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
  const name = validDeviceName(value);
  requireThat(name, 'INVALID_NAME', '设备名称应为 1–24 个字符');
  return name;
}

export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = new Store(config.dbPath);
  const sockets = new Set();
  const pagesByDevice = new Map();
  const activeByPair = new Map();
  const activeCounts = new Map();
  const dirtyDevices = new Set();
  let publishTimer;
  let closing = false;
  const sessions = new Map();
  const codes = new Map();
  const requests = new Map();
  const transfers = new Map();
  const limits = new Map();
  const now = overrides.now || Date.now;
  const buckets = new TokenBuckets(now);
  const quotas = connectionQuotas(config, requireThat);
  const shares = createShares({ config, now, requireThat, rate, rateStart, send, transfers, registerTransfer, finish, iceServers, cleanName, deviceName: (id) => store.device(id).name });

  function limited(wait) {
    const error = new ClientError('RATE_LIMIT', '操作太频繁，请稍后再试');
    error.retryAfterMs = Math.max(1, Math.ceil(wait));
    return error;
  }

  function operation(ws, name, perMinute, burst, ipRate, ipBurst) {
    const wait = buckets.take([
      { key: `${name}:device:${ws.deviceId}`, perMinute, burst },
      { key: `${name}:ip:${ws.source}`, perMinute: ipRate, burst: ipBurst }
    ]);
    if (wait) {
      throw limited(wait);
    }
  }

  function rateStart(ws) {
    requireThat(ws.deviceId, 'UNAUTHORIZED', '请先验证设备身份');
    operation(ws, 'start', config.transferRate, config.transferBurst, config.transferIpRate, config.transferIpBurst);
  }

  function rate(key, limit, windowMs = 60000, cooldown = windowMs) {
    const time = now();
    let entry = limits.get(key);
    if (!entry || (time >= entry.until && time >= entry.blockedUntil)) {
      entry = { count: 0, until: time + windowMs, blockedUntil: 0 };
      limits.set(key, entry);
    }
    if (time < entry.blockedUntil) {
      throw limited(entry.blockedUntil - time);
    }
    entry.count += 1;
    if (entry.count > limit) {
      entry.blockedUntil = time + cooldown;
      throw limited(cooldown);
    }
  }

  function retire(ws, code, reason) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.close(code, reason);
    const timer = setTimeout(() => ws.terminate(), 2000);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
  }

  function frame(ws, data) {
    if (ws?.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > config.maxBufferedBytes) {
        retire(ws, 1013, 'Slow consumer');
        return;
      }
      ws.send(JSON.stringify(data));
    }
  }

  function send(ws, type, data) {
    frame(ws, { type, data });
  }

  function deviceSockets(id) {
    return [...(pagesByDevice.get(id) || [])].filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  function reception(ws) {
    const pages = deviceSockets(ws.deviceId);
    return { here: pages[0] === ws, pages: pages.length };
  }

  function emitDevice(id, type, data) {
    for (const ws of deviceSockets(id)) {
      send(ws, type, data);
    }
  }

  function validPair(a, b) {
    return Boolean(store.relationship(a, b));
  }

  function pairKey(a, b) {
    return JSON.stringify([a, b].sort());
  }

  function activeBetween(a, b) {
    return activeByPair.get(pairKey(a, b)) || new Set();
  }

  function registerTransfer(t) {
    requireThat((activeCounts.get(t.from) || 0) < config.maxActive && (activeCounts.get(t.to) || 0) < config.maxActive, 'BUSY', '传输任务较多，请稍后再试');
    transfers.set(t.id, t);
    activeCounts.set(t.from, (activeCounts.get(t.from) || 0) + 1);
    activeCounts.set(t.to, (activeCounts.get(t.to) || 0) + 1);
    if (!t.shareId) {
      const key = pairKey(t.from, t.to);
      const active = activeByPair.get(key) || new Set();
      active.add(t);
      activeByPair.set(key, active);
    }
  }

  function peers(id) {
    return store.peers(id).map((p) => ({ ...p, online: deviceSockets(p.id).length > 0, busy: activeBetween(id, p.id).size }));
  }

  function flushPublish() {
    publishTimer = undefined;
    const ids = [...dirtyDevices];
    dirtyDevices.clear();
    for (const id of ids) {
      const pages = deviceSockets(id);
      if (pages.length) {
        const data = { peers: peers(id), name: store.device(id).name };
        for (const ws of pages) {
          send(ws, 'peers', { ...data, reception: { here: ws === pages[0], pages: pages.length } });
        }
      }
    }
  }

  function publish(...ids) {
    if (closing) {
      return;
    }
    for (const id of ids) {
      if (pagesByDevice.has(id)) {
        dirtyDevices.add(id);
      }
    }
    if (dirtyDevices.size && !publishTimer) {
      publishTimer = setTimeout(flushPublish, config.publishInterval);
      publishTimer.unref();
    }
  }

  function publishPresence(id) {
    publish(id, ...store.peers(id).map((peer) => peer.id));
  }

  function iceServers(id, allowRelay = true) {
    const result = config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
    if (allowRelay && config.turnUrls.length) {
      const username = config.turnAuthMode === 'static' ? config.turnUsername : `${Math.floor(now() / 1000) + config.turnCredentialTtlSeconds}:${id.slice(0, 16)}`;
      const credential = config.turnAuthMode === 'static' ? config.turnPassword : createHmac('sha1', config.turnSecret).update(username).digest('base64');
      result.push({ urls: config.turnUrls, username, credential });
    }
    return result;
  }

  function finish(t, status, reason = '') {
    if (terminal.has(t.status)) {
      return;
    }
    t.status = status;
    t.reason = reason;
    t.updated = now();
    for (const id of [t.from, t.to]) {
      const count = activeCounts.get(id) - 1;
      if (count) {
        activeCounts.set(id, count);
      } else {
        activeCounts.delete(id);
      }
    }
    if (!t.shareId) {
      const key = pairKey(t.from, t.to);
      const active = activeByPair.get(key);
      active.delete(t);
      if (!active.size) {
        activeByPair.delete(key);
      }
    }
    send(t.sender, 'transfer.state', { id: t.id, status, reason, ...messageDescriptor(reason, 'reason') });
    send(t.receiver, 'transfer.state', { id: t.id, status, reason, ...messageDescriptor(reason, 'reason') });
    if (t.shareId) {
      shares.finished(t);
    } else {
      publish(t.from, t.to);
    }
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
    requireThat(t.shareId ? shares.authorized(t) : validPair(t.from, t.to), 'NOT_PAIRED', '传输授权已失效');
    return t;
  }

  function handle(ws, type, data = {}) {
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 'INVALID', '请求格式错误');
    if (type === 'guest.open' || type.startsWith('share.')) {
      return shares.handle(ws, type, data);
    }
    if (type === 'auth.begin') {
      requireThat(!ws.deviceId && !ws.guestId, 'INVALID', '已经验证身份');
      rate(`auth:${ws.source}`, config.authLimit ?? 30);
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
      requireThat(!ws.deviceId && !ws.guestId, 'INVALID', '已经验证身份');
      const c = ws.challenge;
      ws.challenge = null;
      requireThat(c && c.expires > now(), 'AUTH_FAILED', '身份验证失败，请重试');
      requireThat(typeof data.signature === 'string' && data.signature.length < 200 && verify('sha256', Buffer.from(c.challenge), { key: c.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(data.signature, 'base64')), 'AUTH_FAILED', '身份验证失败，请重试');
      const device = store.register(c.fingerprint, c.publicKey, c.name, now());
      ws.quota.device(device.id);
      ws.deviceId = device.id;
      const pages = pagesByDevice.get(device.id) || new Set();
      pages.add(ws);
      pagesByDevice.set(device.id, pages);
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
        shares.resume(old, ws);
        resumed = true;
      }
      for (const peer of store.peers(device.id)) {
        if (deviceSockets(peer.id).length) {
          store.pair(device.id, peer.id, now());
        }
      }
      publishPresence(device.id);
      return { device: { id: device.id, name: device.name }, sessionId: ws.sessionId, resumed, peers: peers(device.id), reception: reception(ws), config: { maxFileBytes: config.maxFileBytes, maxRelayFileBytes: config.maxFileBytes, maxTextBytes: config.maxTextBytes, forceRelay: config.forceRelay, hasTurn: config.turnUrls.length > 0 }, tasks: [...transfers.values()].filter((t) => t.sender === ws || t.receiver === ws).map((t) => ({ id: t.id, status: t.status })) };
    }

    requireThat(ws.deviceId || (ws.guestId && ['transfer.accept', 'signal', 'transfer.progress', 'transfer.end'].includes(type)), 'UNAUTHORIZED', '请先验证设备身份');
    switch (type) {
      case 'peers.list':
        return { peers: peers(ws.deviceId) };
      case 'device.rename': {
        operation(ws, 'rename', config.renameRate, config.renameBurst, config.renameIpRate, config.renameIpBurst);
        const name = cleanName(data.name);
        if (store.device(ws.deviceId).name !== name) {
          store.rename(ws.deviceId, name);
          publishPresence(ws.deviceId);
        }
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
        publish(r.owner, r.from);
        return {};
      }
      case 'pair.forget': {
        requireThat(typeof data.peerId === 'string' && store.relationship(ws.deviceId, data.peerId), 'NOT_FOUND', '配对关系不存在');
        // All mutation handlers are synchronous on one process: check + revoke cannot
        // interleave with transfer.start, including requests from another browser tab.
        requireThat(activeBetween(ws.deviceId, data.peerId).size === 0, 'BUSY', '传输结束后可忘记配对');
        store.removePair(ws.deviceId, data.peerId);
        emitDevice(ws.deviceId, 'pair.forgotten', { peerId: data.peerId });
        emitDevice(data.peerId, 'pair.forgotten', { peerId: ws.deviceId });
        publish(ws.deviceId, data.peerId);
        return {};
      }
      case 'transfer.start': {
        rateStart(ws);
        requireThat(typeof data.peerId === 'string' && validPair(ws.deviceId, data.peerId), 'NOT_PAIRED', '尚未配对或已忘记配对，请重新连接');
        const receiver = deviceSockets(data.peerId)[0];
        requireThat(receiver, 'OFFLINE', '接收设备不在线');
        const m = data.metadata;
        requireThat(m && ['text', 'file', 'image'].includes(m.kind) && Number.isSafeInteger(m.size) && m.size >= 0 && (m.kind !== 'text' || m.size <= config.maxTextBytes), 'SIZE_LIMIT', '内容大小无效或文字超出限制');
        requireThat(typeof m.name === 'string' && m.name.length <= 255 && typeof m.mime === 'string' && m.mime.length <= 100, 'INVALID', '文件信息无效');
        const id = randomId();
        const policy = { directOnly: m.size > config.maxFileBytes, maxRelayFileBytes: config.maxFileBytes, forceRelay: config.forceRelay };
        const t = { id, ...policy, from: ws.deviceId, to: data.peerId, sender: ws, receiver, status: 'waiting', created: now(), updated: now() };
        registerTransfer(t);
        send(receiver, 'transfer.offer', { id, ...policy, peerId: t.from, peerName: store.device(t.from).name, metadata: { kind: m.kind, size: m.size, name: m.name, mime: m.mime }, iceServers: iceServers(t.to, !policy.directOnly) });
        publish(t.from, t.to);
        return { id, ...policy, iceServers: iceServers(t.from, !policy.directOnly) };
      }
      case 'transfer.accept': {
        const t = task(ws, data.id);
        requireThat(t.receiver === ws && t.status === 'waiting', 'FORBIDDEN', '不能接受此传输');
        t.status = 'transferring';
        t.updated = now();
        if (!t.shareId) {
          store.pair(t.from, t.to, now());
        }
        send(t.sender, 'transfer.accepted', { id: t.id });
        return {};
      }
      case 'signal': {
        const t = task(ws, data.id);
        requireThat(t.status === 'transferring', 'INVALID', '接收端尚未准备好');
        let s = data.signal;
        requireThat(s && typeof s === 'object' && JSON.stringify(s).length < 50000, 'INVALID', '协商信息无效');
        if (s.description) {
          requireThat(s.description.type === (t.sender === ws ? 'offer' : 'answer') && typeof s.description.sdp === 'string', 'INVALID', '协商信息无效');
        } else {
          requireThat(s.candidate && typeof s.candidate.candidate === 'string' && s.candidate.candidate.length < 4096, 'INVALID', '协商信息无效');
        }
        if (t.directOnly) {
          if (s.description) {
            s = { ...s, description: { ...s.description, sdp: s.description.sdp.split(/\r?\n/).filter((line) => !/^a=candidate:.*\btyp relay\b/.test(line)).join('\r\n') } };
          } else if (/\btyp relay\b/.test(s.candidate.candidate)) {
            return {};
          }
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
          if (!t.shareId) {
            store.pair(t.from, t.to, now());
          }
        }
        const reason = t.directOnly && data.reasonCode === 'RELAY_SIZE_LIMIT' ? `无法建立 P2P 直连，服务器中转单个文件不能超过 ${config.maxFileBytes / 1048576} MB；请更换网络后重试` : '传输失败，请重试';
        finish(t, data.status, data.status === 'failed' ? reason : '');
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
    if (path === '/analytics-privacy' && config.analyticsEnabled) {
      res.setHeader('X-Robots-Tag', 'noindex, follow');
      res.setHeader('Content-Language', pageLocale(req.url, config, req.headers['accept-language']));
      res.setHeader('Vary', 'Accept-Language');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : analyticsPrivacy(config, req.url, req.headers['accept-language']));
      return;
    }
    if (path === '/analytics.js' && !config.analyticsEnabled) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (path === '/api/client-config') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : JSON.stringify({ defaultLocale: config.defaultLocale, supportedLocales: ['zh-CN', 'en'], cliDownloadUrl: config.cliDownloadUrl || null }));
      return;
    }
    if (discovery(path, req, res, config)) {
      return;
    }
    // Explicit allowlist: never expose the SQLite database, env file or source tree.
    const files = assets;
    const pages = { '/': '/index.html', '/transfer': '/transfer.html', '/transfer/': '/transfer.html', '/s': '/share.html', '/s/': '/share.html' };
    const file = Object.hasOwn(pages, path) ? pages[path] : path;
    if (!files.has(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const content = await readFile(resolve(publicDir, `.${file}`));
      if (['/index.html', '/transfer.html', '/share.html'].includes(file)) {
        res.setHeader('Content-Language', pageLocale(req.url, config, req.headers['accept-language']));
        res.setHeader('Vary', 'Accept-Language');
      }
      if (['/transfer.html', '/share.html'].includes(file)) {
        res.setHeader('X-Robots-Tag', file === '/share.html' ? 'noindex, nofollow' : 'noindex, follow');
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] || 'text/plain; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : analyticsMarkup(pageMetadata(content, file, config, req.url, req.headers['accept-language']), file, config));
    } catch {
      res.writeHead(500).end('Service unavailable');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      requireThat(req.headers.origin === config.origin && req.url === '/ws', 'FORBIDDEN', 'Origin rejected');
      const source = sourceKey(config.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress);
      requireThat(source, 'FORBIDDEN', 'Origin rejected');
      rate(`connect:${source}`, config.connectLimit ?? 60);
      const quota = quotas.reserve(source, socket);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.source = source;
        ws.quota = quota;
        wss.emit('connection', ws);
      });
    } catch (error) {
      const status = error.code === 'RATE_LIMIT' ? '429 Too Many Requests' : error.code === 'BUSY' ? '503 Service Unavailable' : '403 Forbidden';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nRetry-After: 5\r\n\r\n`, () => socket.destroy());
    }
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.openedAt = now();
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (buckets.take([{ key: `messages:${ws.source}`, perMinute: config.messageRate, burst: config.messageBurst }])) {
        retire(ws, 1008, 'Message rate exceeded');
        return;
      }
      let message;
      try {
        requireThat(!isBinary, 'INVALID', '这里只接受控制消息');
        message = JSON.parse(raw.toString());
        requireThat(typeof message.id === 'string' && message.id.length <= 80 && typeof message.type === 'string', 'INVALID', '请求格式错误');
        rate(`messages:${ws.source}`, config.messageRate);
        const data = handle(ws, message.type, message.data);
        frame(ws, { replyTo: message.id, ok: true, data });
      } catch (error) {
        frame(ws, { replyTo: message?.id, ok: false, error: { code: error instanceof ClientError ? error.code : 'INVALID', message: error instanceof ClientError ? error.message : '请求无法处理', ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}), ...messageDescriptor(error instanceof ClientError ? error.message : '请求无法处理') } });
        if (error.code === 'BUSY' && !ws.deviceId && !ws.guestId) {
          retire(ws, 1013, 'Connection quota reached');
        }
      }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      ws.closedAt = now();
      if (ws.deviceId) {
        const pages = pagesByDevice.get(ws.deviceId);
        pages.delete(ws);
        if (!pages.size) {
          pagesByDevice.delete(ws.deviceId);
        }
      }
      if (closing) {
        return;
      }
      shares.disconnected(ws);
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
      if (ws.deviceId) {
        if (deviceSockets(ws.deviceId).length) {
          publish(ws.deviceId);
        } else {
          publishPresence(ws.deviceId);
        }
      }
    });
  });

  function sweep() {
    shares.sweep();
    buckets.sweep();
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
      if (disconnected || now() - t.updated > config.idleTimeout || !(t.shareId ? shares.authorized(t) : validPair(t.from, t.to))) {
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
      if (!ws.deviceId && !ws.guestId && now() - ws.openedAt > config.challengeTtl) {
        retire(ws, 1008, 'Authentication timeout');
      }
      if (ws.guestId) {
        if (shares.retains(ws)) {
          ws.guestIdleSince = now();
        } else if (now() - ws.guestIdleSince > config.guestIdleTimeout) {
          retire(ws, 1000, 'Guest session idle');
        }
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 15000);
  maintenance.unref();
  heartbeat.unref();

  return {
    server, store, config, sweep,
    listen: () => new Promise((resolveListen) => server.listen(config.port, config.host, () => resolveListen(server.address()))),
    close: async () => {
      closing = true;
      clearInterval(maintenance);
      clearInterval(heartbeat);
      clearTimeout(publishTimer);
      dirtyDevices.clear();
      for (const ws of sockets) {
        ws.terminate();
      }
      await Promise.all([
        new Promise((done) => wss.close(done)),
        new Promise((done) => server.close(done))
      ]);
      store.close();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await assertFrontend();
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
