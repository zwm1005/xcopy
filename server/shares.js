import { messageDescriptor } from './messages.js';
import { MAX_FILES_PER_SEND } from '../src/shared/transfer-limits.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';

const randomId = () => randomBytes(32).toString('base64url');
const closed = new Set(['completed', 'cancelled', 'expired', 'unavailable', 'stopped']);
const claimEnded = new Set(['completed', 'cancelled', 'expired', 'unavailable']);
const taskEnded = new Set(['completed', 'failed', 'cancelled']);
const MAX_ACTIVE_SHARES = 2000;
const MAX_SHARE_HISTORY = 2000;
const SHARE_HISTORY_TTL = 3600000;

// 分享和领取会话分别授权；文件内容仅保留在发送、接收页面。
export function createShares({ config, now, requireThat, rate, rateStart, rateList, send, transfers, registerTransfer, finish, cleanName, deviceName }) {
  const shares = new Map();
  const endedShares = new Map();
  const tokens = new Map();
  const guests = new Map();
  const senders = new Map();
  const cursorKey = randomBytes(32);
  let sequence = 0;
  const online = (ws) => ws?.readyState === WebSocket.OPEN;
  const limits = { maxShareFiles: MAX_FILES_PER_SEND, maxShareBytes: null, shareProtocol: 2 };
  const concurrency = config.shareConcurrency ?? 3;
  const queueLimit = config.shareQueueLimit ?? 20;
  const historyLimit = 50;
  const live = (s) => [...s.claims.values()].filter((c) => !claimEnded.has(c.state));
  const ownClaim = (s, ws) => [...s.claims.values()].find((c) => c.receiver === ws) || (ws?.claimReceipt?.shareId === s.id ? ws.claimReceipt : null);
  const fileSnapshot = (s, c) => s.files.map((metadata, index) => ({ ...metadata, index, completed: Boolean(c?.files[index].completed) }));

  function senderIndex(ws) {
    let index = senders.get(ws);
    if (!index) {
      index = { scope: randomId(), items: new Map(), requests: new Map() };
      senders.set(ws, index);
    }
    return index;
  }

  function encodeCursor(value) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', cursorKey).update(payload).digest('base64url')}`;
  }

  function decodeCursor(value, scope) {
    try {
      requireThat(typeof value === 'string' && value.length <= 512, 'INVALID', '请求格式错误');
      const [payload, signature, extra] = value.split('.');
      const expected = createHmac('sha256', cursorKey).update(payload).digest();
      const actual = Buffer.from(signature || '', 'base64url');
      requireThat(!extra && actual.length === expected.length && timingSafeEqual(actual, expected), 'INVALID', '请求格式错误');
      const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString());
      requireThat(cursor.scope === scope && Number.isSafeInteger(cursor.before) && cursor.before > 0
        && Number.isSafeInteger(cursor.ceiling) && cursor.ceiling > 0 && cursor.before <= cursor.ceiling, 'INVALID', '请求格式错误');
      return cursor;
    } catch {
      requireThat(false, 'INVALID', '请求格式错误');
    }
  }

  function list(ws, data) {
    rateList(ws);
    const index = senderIndex(ws);
    const pageSize = data.limit ?? 20;
    requireThat(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 50, 'INVALID', '请求格式错误');
    if (data.requestId !== undefined) {
      requireThat(typeof data.requestId === 'string' && data.requestId.length > 0 && data.requestId.length <= 64
        && data.cursor === undefined && data.limit === undefined, 'INVALID', '请求格式错误');
      const s = index.requests.get(data.requestId);
      if (s) {
        check(s);
      }
      return { shares: s ? [snapshot(s, ws)] : [], ...limits, nextCursor: null, hasMore: false };
    }
    const cursor = data.cursor === undefined ? { before: sequence + 1, ceiling: sequence, scope: index.scope } : decodeCursor(data.cursor, index.scope);
    // One live share per sending page: it is necessarily the newest entry.
    const entries = [...index.items.values()].filter((s) => s.sequence <= cursor.ceiling && s.sequence < cursor.before).sort((a, b) => b.sequence - a.sequence);
    const result = { shares: [], ...limits, nextCursor: null, hasMore: false };
    let bytes = 1024; // Envelope and bounded cursor headroom.
    let last;
    for (const s of entries) {
      if (result.shares.length >= pageSize) {
        break;
      }
      check(s);
      const value = snapshot(s, ws);
      const size = Buffer.byteLength(JSON.stringify(value)) + 1;
      requireThat(size <= 512 * 1024 - 1024, 'SIZE_LIMIT', '请求格式错误');
      if (bytes + size > 512 * 1024) {
        break;
      }
      result.shares.push(value);
      bytes += size;
      last = s.sequence;
    }
    result.hasMore = result.shares.length < entries.length;
    if (result.hasMore) {
      result.nextCursor = encodeCursor({ ...cursor, before: last });
    }
    return result;
  }

  function claimSnapshot(s, c) {
    const waiting = live(s).filter((entry) => entry.state === 'queued');
    return { id: c.id, state: c.state, recipientName: c.recipientName, acceptedAt: c.acceptedAt, deadline: c.deadline,
      position: c.state === 'queued' ? waiting.indexOf(c) + 1 : 0, attempt: c.attempt || 0,
      files: c.files.map((f, index) => ({ index, completed: f.completed })), reason: c.reason || '', ...messageDescriptor(c.reason || '', 'reason') };
  }

  function snapshot(s, ws) {
    const mine = ownClaim(s, ws);
    const owner = s.sender === ws;
    const single = s.mode === 'single' ? [...s.claims.values()][0] : null;
    const c = mine || (owner ? single : null);
    const active = live(s);
    return {
      id: s.id, mode: s.mode, status: s.status, expires: s.expires, accepting: s.accepting,
      senderOnline: online(s.sender), senderName: s.senderName, mine: Boolean(mine), totalBytes: s.totalBytes,
      ...(c ? { recipientName: c.recipientName } : {}), files: fileSnapshot(s, c),
      ...(mine ? { myClaim: claimSnapshot(s, mine) } : {}),
      ...(owner ? {
        token: s.token, requestId: s.requestId,
        claims: [...s.claims.values()].map((entry) => claimSnapshot(s, entry)),
        counts: { completed: s.completed, failed: s.failed, active: active.filter((entry) => entry.state === 'transferring').length,
          queued: active.filter((entry) => entry.state === 'queued').length, retryable: active.filter((entry) => entry.state === 'retryable').length },
        historyLimit
      } : {})
    };
  }

  function publish(s) {
    send(s.sender, 'share.state', snapshot(s, s.sender));
    for (const ws of s.watchers) {
      send(ws, 'share.state', snapshot(s, ws));
    }
  }

  function prune(s) {
    const history = [...s.claims.values()].filter((c) => claimEnded.has(c.state));
    for (const c of history.slice(0, Math.max(0, history.length - historyLimit))) {
      // 一个访客页面只保留自己最近一次领取回执；不无限累积分享的历史会话。
      if (c.receiver?.lastClaim === c.id) {
        c.receiver.claimReceipt = { ...c, shareId: s.id, receiver: undefined };
      }
      s.claims.delete(c.id);
    }
  }

  function closeClaim(s, c, state, reason = '') {
    if (claimEnded.has(c.state)) {
      return;
    }
    c.state = state;
    c.reason = reason;
    c.receiver?.guestClaims?.delete(s.id);
    if (state === 'completed') {
      s.completed += 1;
    } else {
      s.failed += 1;
    }
    for (const t of transfers.values()) {
      if (t.shareId === s.id && t.claimId === c.id && !taskEnded.has(t.status)) {
        finish(t, 'cancelled', reason || '本次领取已结束');
      }
    }
    // 先发送最后状态，再移除完成者的实时订阅；本地已接收文件仍可保存。
    send(c.receiver, 'share.state', snapshot(s, c.receiver));
    if (s.mode === 'multiple') {
      s.watchers.delete(c.receiver);
    }
    prune(s);
  }

  function removeShare(s) {
    shares.delete(s.id);
    endedShares.delete(s.id);
    tokens.delete(s.token);
    const index = senders.get(s.sender);
    index?.items.delete(s.id);
    if (s.requestId) {
      index?.requests.delete(s.requestId);
    }
  }

  function markEnded(s, status) {
    s.status = status;
    s.endedAt = now();
    // History is bounded independently of active capacity and ordered by ending time.
    endedShares.set(s.id, s);
    while (endedShares.size > MAX_SHARE_HISTORY) {
      removeShare(endedShares.values().next().value);
    }
  }

  function end(s, status) {
    if (closed.has(s.status)) {
      return;
    }
    s.accepting = false;
    markEnded(s, status);
    for (const c of live(s)) {
      closeClaim(s, c, status === 'unavailable' ? 'unavailable' : status === 'expired' ? 'expired' : 'cancelled', status === 'cancelled' ? '发送方已结束分享' : '分享已失效');
    }
    publish(s);
  }

  function schedule(s) {
    if (closed.has(s.status)) {
      return;
    }
    let changed = false;
    let slots = (s.mode === 'single' ? 1 : concurrency) - live(s).filter((c) => c.state === 'transferring').length;
    for (const c of live(s)) {
      if (slots <= 0) {
        break;
      }
      if (c.state === 'queued' && online(s.sender) && online(c.receiver)) {
        c.state = 'transferring';
        changed = true;
        slots -= 1;
        send(s.sender, 'share.claimed', { id: s.id, claimId: c.id });
      }
    }
    if (!s.accepting && !live(s).length) {
      markEnded(s, s.closeReason || (s.mode === 'single' ? 'completed' : 'stopped'));
      changed = true;
    }
    return changed;
  }

  function check(s) {
    if (closed.has(s.status)) {
      return;
    }
    if (!online(s.sender) && now() - s.sender.closedAt >= config.reconnectGrace) {
      end(s, 'unavailable');
      return;
    }
    let changed = false;
    if (s.accepting && now() >= s.expires) {
      s.accepting = false;
      s.closeReason = 'expired';
      s.status = 'draining';
      changed = true;
    }
    for (const c of live(s)) {
      const expired = now() >= c.deadline;
      const offline = !online(c.receiver) && now() - c.receiver.closedAt >= config.reconnectGrace;
      if (expired || offline) {
        if (s.mode === 'single') {
          end(s, expired ? 'expired' : 'unavailable');
          return;
        }
        closeClaim(s, c, expired ? 'expired' : 'unavailable', expired ? '本次领取已超时' : '领取页面已离线');
        changed = true;
      }
    }
    if (changed) {
      schedule(s);
      publish(s);
    }
  }

  function owned(ws, id) {
    const s = shares.get(id);
    requireThat(s && s.sender === ws, 'NOT_FOUND', '分享不存在或不属于当前页面');
    check(s);
    return s;
  }

  function inspect(ws, token) {
    requireThat(ws.guestId, 'UNAUTHORIZED', '请打开分享领取页面');
    rate(`share:inspect:${ws.source}`, 120);
    const s = tokens.get(token);
    requireThat(s, 'SHARE_NOT_FOUND', '分享已失效或不存在，请联系发送方重新分享');
    requireThat(s.mode !== 'multiple' || ws.shareProtocol === 2, 'UPDATE_REQUIRED', '请刷新页面后使用多人领取');
    check(s);
    if (ws.shareView) {
      shares.get(ws.shareView)?.watchers.delete(ws);
    }
    if (schedule(s)) {
      publish(s);
    }
    const mine = ownClaim(s, ws);
    if (!closed.has(s.status) && (!mine || !claimEnded.has(mine.state))) {
      requireThat(s.watchers.size < (config.shareWatcherLimit ?? 200) || s.watchers.has(ws), 'BUSY', '当前访问较多，请稍后重试');
      ws.shareView = s.id;
      s.watchers.add(ws);
    }
    return s;
  }

  function resume(old, ws) {
    const index = senders.get(old);
    if (index) {
      senders.delete(old);
      senders.set(ws, index);
    }
    ws.lastClaim = old.lastClaim;
    ws.claimReceipt = old.claimReceipt;
    ws.guestClaims = old.guestClaims;
    for (const s of shares.values()) {
      if (s.sender === old) {
        s.sender = ws;
      }
      for (const c of s.claims.values()) {
        if (c.receiver === old) {
          c.receiver = ws;
        }
      }
      if (s.watchers.delete(old)) {
        s.watchers.add(ws);
        ws.shareView = s.id;
      }
    }
    for (const t of transfers.values()) {
      if (t.sender === old) {
        t.sender = ws;
      }
      if (t.receiver === old) {
        t.receiver = ws;
      }
    }
    // Transfers may finish while the sender's signaling connection is offline.
    // Resume its queue after rebinding tasks, independently of paginated reads.
    for (const s of index?.items.values() || []) {
      check(s);
      if (schedule(s)) {
        publish(s);
      }
    }
  }

  function handle(ws, type, data) {
    if (type === 'guest.open') {
      requireThat(!ws.deviceId && !ws.guestId && !ws.challenge, 'INVALID', '已经建立会话');
      rate(`guest:${ws.source}`, 60);
      let old = guests.get(data.resumeSession);
      if (old && (online(old) || now() - old.closedAt >= config.reconnectGrace)) {
        old = null;
      }
      const name = data.name === undefined ? `Device-${randomBytes(2).toString('hex').toUpperCase()}` : cleanName(data.name);
      ws.quota.guest();
      ws.guestIdleSince = now();
      ws.guestPreviewUntil = now() + config.guestPreviewTimeout;
      ws.guestClaims = new Set();
      ws.guestName = old?.guestName || name;
      ws.shareProtocol = data.shareProtocol;
      ws.guestId = randomId();
      ws.sessionId = randomId();
      guests.set(ws.sessionId, ws);
      if (old) {
        resume(old, ws);
        guests.delete(old.sessionId);
      }
      return {
        device: { id: ws.guestId, name: ws.guestName }, sessionId: ws.sessionId, resumed: Boolean(old), peers: [],
        config: { maxFileBytes: config.maxFileBytes, maxRelayFileBytes: config.maxFileBytes, maxTextBytes: config.maxTextBytes, ...limits },
        tasks: [...transfers.values()].filter((t) => t.receiver === ws).map((t) => ({ id: t.id, status: t.status }))
      };
    }
    if (type === 'share.create') {
      requireThat(ws.deviceId, 'UNAUTHORIZED', '请先验证设备身份');
      rate(`share:create:${ws.deviceId}`, 20);
      rate('share:create:global', 200);
      requireThat(data.requestId === undefined || (typeof data.requestId === 'string' && data.requestId.length > 0 && data.requestId.length <= 64), 'INVALID', '创建请求无效');
      const index = senderIndex(ws);
      const previous = data.requestId && index.requests.get(data.requestId);
      if (previous) {
        check(previous);
        return snapshot(previous, ws);
      }
      const mode = data.mode ?? 'single';
      requireThat(['single', 'multiple'].includes(mode), 'INVALID', '请选择领取方式');
      requireThat(mode !== 'multiple' || data.shareProtocol === 2, 'UPDATE_REQUIRED', '请刷新发送页面后创建多人分享');
      requireThat(shares.size - endedShares.size < MAX_ACTIVE_SHARES, 'BUSY', '当前访问较多，请稍后重试');
      requireThat(![...index.items.values()].some((s) => !closed.has(s.status)), 'BUSY', '请先结束当前分享，再创建新的分享');
      requireThat([10, 30, 60].includes(data.minutes), 'INVALID', '请选择有效期');
      requireThat(Array.isArray(data.files) && data.files.length > 0 && data.files.length <= limits.maxShareFiles, 'SIZE_LIMIT', `一次分享支持 1–${MAX_FILES_PER_SEND} 个文件`);
      let totalBytes = 0;
      const files = data.files.map((m) => {
        requireThat(m && Number.isSafeInteger(m.size) && m.size >= 0, 'SIZE_LIMIT', '文件大小无效');
        requireThat(typeof m.name === 'string' && m.name.trim().length > 0 && m.name.length <= 255 && typeof m.mime === 'string' && m.mime.length <= 100, 'INVALID', '文件信息无效');
        totalBytes += m.size;
        return { kind: 'file', name: m.name, size: m.size, mime: m.mime };
      });
      requireThat(Number.isSafeInteger(totalBytes), 'SIZE_LIMIT', '文件总大小无效');
      const s = { id: randomId(), token: randomId(), sequence: ++sequence, requestId: data.requestId || null, mode, sender: ws, senderName: deviceName(ws.deviceId), files, totalBytes,
        claims: new Map(), completed: 0, failed: 0, accepting: true, status: 'ready', expires: now() + data.minutes * 60000, watchers: new Set() };
      shares.set(s.id, s);
      tokens.set(s.token, s);
      index.items.set(s.id, s);
      if (s.requestId) {
        index.requests.set(s.requestId, s);
      }
      return snapshot(s, ws);
    }
    if (type === 'share.inspect') {
      return snapshot(inspect(ws, data.token), ws);
    }
    if (type === 'share.claim') {
      const s = inspect(ws, data.token);
      const previous = ownClaim(s, ws);
      if (previous && s.mode === 'multiple') {
        return snapshot(s, ws);
      }
      requireThat(!closed.has(s.status), 'SHARE_CLOSED', '分享已失效，请联系发送方重新分享');
      requireThat(s.mode !== 'single' || !s.claims.size || previous, 'SHARE_CLAIMED', '本次分享已由其他接收页面领取');
      if (previous) {
        return snapshot(s, ws);
      }
      requireThat(s.accepting, 'SHARE_CLOSED', '分享已停止新的领取');
      requireThat(online(s.sender), 'OFFLINE', '等待发送方恢复连接');
      requireThat(live(s).length < concurrency + queueLimit, 'BUSY', '当前领取较多，请稍后重试');
      requireThat([...shares.values()].reduce((count, entry) => count + live(entry).length, 0) < (config.shareGlobalClaims ?? 256), 'BUSY', '当前领取较多，请稍后重试');
      const recipientName = data.name === undefined ? ws.guestName : cleanName(data.name);
      const c = { id: randomId(), receiver: ws, recipientName, state: 'queued', acceptedAt: now(), deadline: now() + 3600000,
        files: s.files.map(() => ({ completed: false, taskId: null })) };
      ws.guestName = recipientName;
      ws.lastClaim = c.id;
      ws.guestClaims.add(s.id);
      ws.claimReceipt = null;
      s.claims.set(c.id, c);
      if (s.mode === 'single') {
        s.accepting = false;
        s.status = 'claimed';
      }
      schedule(s);
      publish(s);
      return snapshot(s, ws);
    }
    if (['share.retry', 'share.claim.cancel'].includes(type)) {
      const s = shares.get(data.id);
      const c = s && ownClaim(s, ws);
      requireThat(c && (!data.claimId || data.claimId === c.id) && s.claims.has(c.id), 'NOT_FOUND', '领取会话不存在');
      check(s);
      requireThat(!closed.has(s.status) && !claimEnded.has(c.state) && online(s.sender), 'SHARE_CLOSED', '分享不可重试，请联系发送方重新分享');
      if (type === 'share.claim.cancel') {
        closeClaim(s, c, 'cancelled', '接收方已取消本次领取');
        if (s.mode === 'single') {
          end(s, 'cancelled');
        }
      } else {
        rate(`share:retry:${c.id}`, 10);
        c.resetting = true;
        for (const t of transfers.values()) {
          if (t.shareId === s.id && t.claimId === c.id && !taskEnded.has(t.status)) {
            finish(t, 'failed', '接收方重新连接');
          }
        }
        c.resetting = false;
        c.state = 'queued';
        c.attempt = (c.attempt || 0) + 1;
        c.reason = '';
        send(s.sender, 'share.retry', { id: s.id, claimId: c.id });
      }
      schedule(s);
      publish(s);
      return snapshot(s, ws);
    }
    if (type === 'share.cancel' || type === 'share.stop') {
      const s = owned(ws, data.id);
      if (type === 'share.cancel') {
        end(s, 'cancelled');
      } else {
        requireThat(s.mode === 'multiple', 'INVALID', '一次领取请使用取消分享');
        if (!closed.has(s.status)) {
          s.accepting = false;
          s.closeReason = 'stopped';
          s.status = 'draining';
          schedule(s);
          publish(s);
        }
      }
      return snapshot(s, ws);
    }
    if (type === 'share.list') {
      requireThat(ws.deviceId, 'UNAUTHORIZED', '请先验证设备身份');
      return list(ws, data);
    }
    if (type === 'share.file.start') {
      rateStart(ws);
      const s = owned(ws, data.id);
      const c = data.claimId ? s.claims.get(data.claimId) : s.mode === 'single' ? [...s.claims.values()][0] : null;
      requireThat(c && !closed.has(s.status) && !claimEnded.has(c.state) && online(c.receiver), 'SHARE_CLOSED', '领取页面已离线或本次领取已结束');
      requireThat(Number.isInteger(data.index) && data.index >= 0 && data.index < s.files.length, 'INVALID', '文件序号无效');
      const f = c.files[data.index];
      requireThat(!f.completed && (!f.taskId || taskEnded.has(transfers.get(f.taskId)?.status) || !transfers.has(f.taskId)), 'BUSY', '文件已接收或正在传输');
      requireThat(c.state === 'transferring', 'BUSY', '本次领取正在排队或等待重试');
      const id = randomId();
      const policy = { directOnly: s.files[data.index].size > config.maxFileBytes, maxRelayFileBytes: config.maxFileBytes, forceRelay: config.forceRelay };
      const t = { id, ...policy, shareId: s.id, claimId: c.id, shareIndex: data.index, from: ws.deviceId, to: c.receiver.guestId, sender: ws, receiver: c.receiver, status: 'waiting', created: now(), updated: now() };
      const ice = registerTransfer(t);
      f.taskId = id;
      send(c.receiver, 'transfer.offer', { id, ...policy, peerId: t.from, peerName: s.senderName, metadata: { ...s.files[data.index], shareId: s.id, claimId: c.id, shareIndex: data.index }, iceServers: ice[1] });
      return { id, ...policy, iceServers: ice[0] };
    }
    requireThat(false, 'INVALID', '不支持的分享请求');
  }

  return {
    handle, resume, limits,
    retains(ws) {
      if (ws.guestClaims?.size) {
        return true;
      }
      if (config.guestPreviewEnabled) {
        return false;
      }
      const s = shares.get(ws.shareView);
      return Boolean(s && !closed.has(s.status) && s.accepting && now() < s.expires && s.watchers.has(ws));
    },
    authorized(t) {
      const s = shares.get(t.shareId);
      if (s) {
        check(s);
      }
      const c = s?.claims.get(t.claimId);
      return Boolean(s && c && !closed.has(s.status) && !claimEnded.has(c.state) && s.sender === t.sender && c.receiver === t.receiver);
    },
    finished(t) {
      const s = shares.get(t.shareId);
      const c = s?.claims.get(t.claimId);
      if (!s || !c || closed.has(s.status) || claimEnded.has(c.state) || c.resetting) {
        return;
      }
      if (t.status === 'completed') {
        c.files[t.shareIndex].completed = true;
        if (c.files.every((f) => f.completed)) {
          closeClaim(s, c, 'completed');
          if (s.mode === 'single') {
            end(s, 'completed');
          }
        }
      } else {
        c.reason = t.reason || '部分文件未完成，可重试';
      }
      // 允许同一领取中其余文件继续；仅在这一轮任务全部结束后释放会话槽位。
      const pending = c.files.some((f) => !f.completed && (!f.taskId || !taskEnded.has(transfers.get(f.taskId)?.status)));
      if (!claimEnded.has(c.state) && !pending && c.files.some((f) => !f.completed)) {
        c.state = 'retryable';
      }
      schedule(s);
      publish(s);
    },
    disconnected(ws) {
      for (const s of shares.values()) {
        s.watchers.delete(ws);
        if (s.sender === ws || ownClaim(s, ws)) {
          publish(s);
        }
      }
    },
    sweep() {
      for (const s of shares.values()) {
        check(s);
        for (const c of s.claims.values()) {
          if (claimEnded.has(c.state) && c.receiver && !online(c.receiver) && now() - c.receiver.closedAt >= config.reconnectGrace) {
            c.receiver = null;
          }
        }
        if (closed.has(s.status) && now() - s.endedAt > SHARE_HISTORY_TTL) {
          removeShare(s);
        }
      }
      for (const [id, ws] of guests) {
        if (!online(ws) && now() - ws.closedAt >= config.reconnectGrace) {
          guests.delete(id);
        }
      }
      for (const [ws, index] of senders) {
        if (!index.items.size && !online(ws)) {
          senders.delete(ws);
        }
      }
    }
  };
}
