import { sha256 } from './vendor/noble-hashes/sha2.js';

const ended = new Set(['completed', 'failed', 'cancelled']);
const chunkSize = 16384;
const blockSize = 1024 * 1024;
const safeImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Transfers extends EventTarget {
  constructor(connection) {
    super();
    this.connection = connection;
    this.items = [];
    this.groups = [];
    this.peers = [];
    this.queue = [];
    this.running = new Set();
    this.byId = new Map();
    this.pendingEnds = new Map();
    connection.addEventListener('transfer.offer', (e) => this.receive(e.detail));
    connection.addEventListener('transfer.accepted', (e) => {
      const item = this.byId.get(e.detail.id);
      if (item) {
        this.beginOffer(item).catch((error) => this.fail(item, error.message, error.code));
      }
    });
    connection.addEventListener('signal', (e) => {
      const item = this.byId.get(e.detail.id);
      if (item && !ended.has(item.status)) {
        item.signalQueue = (item.signalQueue || Promise.resolve()).then(() => this.signal(item, e.detail.signal)).catch((error) => this.fail(item, error.message, error.code));
      }
    });
    connection.addEventListener('transfer.state', (e) => {
      const item = this.byId.get(e.detail.id);
      if (item && !ended.has(item.status)) {
        if (e.detail.status === 'completed' && item.incoming && !item.verified) {
          this.fail(item, '内容未完成校验');
          return;
        }
        this.finishLocal(item, e.detail.status, e.detail.reason);
      }
    });
    connection.addEventListener('ready', (e) => {
      const { resumed, tasks } = e.detail;
      this.updatePeers(e.detail.peers);
      for (const item of this.items) {
        if (ended.has(item.status) || item.status === 'queued') {
          continue;
        }
        const remote = tasks.find((t) => t.id === item.id);
        if (!resumed || !remote) {
          this.fail(item, '连接已重置，请重新发送');
        } else if (ended.has(remote.status)) {
          this.finishLocal(item, remote.status);
        }
      }
      for (const [id, result] of this.pendingEnds) {
        if (resumed && tasks.some((t) => t.id === id && !ended.has(t.status))) {
          this.endRemote(id, result.status, result.reasonCode);
        } else {
          this.pendingEnds.delete(id);
        }
      }
      this.schedulePump();
    });
    connection.addEventListener('peers', (e) => this.updatePeers(e.detail.peers));
    this.maintenance = setInterval(() => {
      for (const item of this.items) {
        if (!ended.has(item.status) && item.status !== 'queued') {
          if (Date.now() - item.activity > 45000) {
            const blocked = item.directOnly && !item.route;
            this.fail(item, blocked ? this.relayError(item).message : '连接或传输超时，请重新发送', blocked ? 'RELAY_SIZE_LIMIT' : undefined);
          } else if (item.id && item.bytes !== item.lastPulseBytes && connection.ready) {
            item.lastPulseBytes = item.bytes;
            connection.rpc('transfer.progress', { id: item.id }).catch(() => {});
          }
        }
      }
    }, 5000);
  }

  changed(force = false) {
    this.schedulePump();
    if (force || !this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null;
        this.dispatchEvent(new Event('change'));
      }, force ? 0 : 100);
    }
  }

  newItem(data) {
    const item = { localId: crypto.randomUUID(), status: 'waiting', bytes: 0, activity: Date.now(), route: '', chunks: [], candidates: [], ...data };
    this.items.unshift(item);
    this.changed(true);
    return item;
  }

  async send(peer, source) {
    return this.sendBatch([peer], [source])[0];
  }

  queuedItem(peer, source, extra = {}) {
    const blob = source.kind === 'text' ? new Blob([source.text], { type: 'text/plain' }) : source.file;
    return { localId: crypto.randomUUID(), status: 'queued', bytes: 0, activity: Date.now(), route: '', chunks: [], candidates: [], incoming: false, peerId: peer.id, peerName: peer.name, kind: source.kind, name: source.kind === 'text' ? '文字' : blob.name, size: blob.size, mime: blob.type, source, blob, ...extra };
  }

  sendBatch(peers, sources, { group = false } = {}) {
    const recipients = [...new Map(peers.filter((peer) => peer.online !== false && peer.id !== this.connection.device?.id).map((peer) => [peer.id, { id: peer.id, name: peer.name }])).values()];
    if (!recipients.length || !sources.length) {
      return [];
    }
    const batch = group ? { id: crypto.randomUUID(), peers: recipients, sourceCount: sources.length } : null;
    const items = sources.flatMap((source, sourceIndex) => recipients.map((peer) => this.queuedItem(peer, source, { groupId: batch?.id, sourceIndex })));
    if (batch) {
      this.groups.unshift(batch);
    }
    this.items.unshift(...items);
    this.queue.push(...items);
    this.changed(true);
    return items;
  }

  sendShare(share, files, claim) {
    const items = files.flatMap((file, shareIndex) => claim?.files[shareIndex].completed ? [] : [this.queuedItem({ id: share.id, name: claim?.recipientName || '链接分享' }, { kind: 'file', file }, { shareId: share.id, claimId: claim?.id, shareIndex, shareOpen: true })]);
    this.items.unshift(...items);
    this.queue.push(...items);
    this.changed(true);
    return items;
  }

  updatePeers(peers) {
    this.peers = peers;
    for (const item of this.queue) {
      if (item.status === 'queued' && !item.shareId) {
        const peer = peers.find((p) => p.id === item.peerId);
        if (!peer?.online) {
          this.fail(item, peer ? '接收设备已离线，上线后可重试' : '配对已解除，请重新连接后重试');
        }
      }
    }
    this.schedulePump();
  }

  schedulePump() {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  pump() {
    for (const item of this.running) {
      if (ended.has(item.status) && !item.starting) {
        this.running.delete(item);
      }
    }
    if (!this.connection.ready) {
      return;
    }
    while (this.running.size < 3 && this.queue.length) {
      // 按接收会话轮转，普通设备传输也参与同一预算，避免大文件包独占队列。
      const key = (item) => item.claimId || item.peerId;
      const peers = [...new Set(this.queue.map(key))];
      const next = peers[(peers.indexOf(this.lastQueuePeer) + 1) % peers.length];
      const index = this.queue.findIndex((item) => key(item) === next);
      const [item] = this.queue.splice(index, 1);
      this.lastQueuePeer = key(item);
      if (item.status !== 'queued') {
        continue;
      }
      const peer = this.peers.find((p) => p.id === item.peerId);
      if (!item.shareId && !peer?.online) {
        this.fail(item, peer ? '接收设备已离线，上线后可重试' : '配对已解除，请重新连接后重试');
        continue;
      }
      item.status = 'waiting';
      item.activity = Date.now();
      item.starting = true;
      this.running.add(item);
      this.start(item);
    }
  }

  async start(item) {
    try {
      const result = await this.connection.rpc(item.shareId ? 'share.file.start' : 'transfer.start', item.shareId ? { id: item.shareId, claimId: item.claimId, index: item.shareIndex } : { peerId: item.peerId, metadata: { kind: item.kind, name: item.name, size: item.size, mime: item.mime } });
      Object.assign(item, result);
      if (ended.has(item.status)) {
        this.endRemote(item.id, item.status);
        return;
      }
      this.byId.set(item.id, item);
      this.createPeer(item);
    } catch (error) {
      this.fail(item, error.message, error.code);
    } finally {
      item.starting = false;
      this.changed(true);
    }
  }

  groupItems(group) {
    return this.items.filter((item) => item.groupId === group.id);
  }

  cancelGroup(group) {
    for (const item of this.groupItems(group)) {
      this.cancel(item);
    }
  }

  retry(item) {
    if (!item || item.incoming || !['failed', 'cancelled'].includes(item.status) || !this.connection.ready) {
      return;
    }
    const peer = item.shareId ? { id: item.shareId, name: item.peerName || '链接分享' } : this.peers.find((p) => p.id === item.peerId && p.online);
    const index = this.items.indexOf(item);
    if (!peer || index < 0) {
      return;
    }
    const replacement = this.queuedItem(peer, item.source, { localId: item.localId, groupId: item.groupId, sourceIndex: item.sourceIndex, shareId: item.shareId, claimId: item.claimId, shareIndex: item.shareIndex, shareOpen: item.shareOpen });
    this.byId.delete(item.id);
    this.items[index] = replacement;
    this.queue.push(replacement);
    this.changed(true);
  }

  retryGroup(group) {
    for (const item of this.groupItems(group)) {
      if (item.status === 'failed') {
        this.retry(item);
      }
    }
  }

  async receive(offer) {
    const item = this.newItem({ ...offer.metadata, id: offer.id, peerId: offer.peerId, peerName: offer.peerName, incoming: true, iceServers: offer.iceServers, forceRelay: offer.forceRelay, directOnly: offer.directOnly, maxRelayFileBytes: offer.maxRelayFileBytes, parts: [], chunkBytes: 0, hash: sha256.create() });
    this.byId.set(item.id, item);
    try {
      this.createPeer(item);
      await this.connection.rpc('transfer.accept', { id: item.id });
    } catch (error) {
      this.fail(item, error.message, error.code);
    }
  }

  relayError(item) {
    const max = item.maxRelayFileBytes || this.connection.config?.maxRelayFileBytes || this.connection.config?.maxFileBytes || 50 * 1048576;
    return Object.assign(new Error(`无法建立 P2P 直连，服务器中转单个文件不能超过 ${max / 1048576} MB；请更换网络后重试`), { code: 'RELAY_SIZE_LIMIT' });
  }

  createPeer(item) {
    const max = item.maxRelayFileBytes || this.connection.config?.maxRelayFileBytes || this.connection.config?.maxFileBytes || 50 * 1048576;
    item.directOnly = item.directOnly || item.size > max;
    if (item.directOnly && item.forceRelay) {
      throw this.relayError(item);
    }
    const iceServers = (item.iceServers || []).map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !item.directOnly || !/^turns?:/i.test(url)) })).filter((server) => server.urls.length);
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: item.forceRelay ? 'relay' : 'all' });
    item.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate && !ended.has(item.status)) {
        if (item.directOnly && /\btyp relay\b/.test(event.candidate.candidate)) {
          return;
        }
        this.connection.rpc('signal', { id: item.id, signal: { candidate: event.candidate.toJSON() } }).catch((error) => this.fail(item, error.message));
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.fail(item, item.directOnly ? this.relayError(item).message : '无法连接对方，请检查网络或 TURN 中继配置', item.directOnly ? 'RELAY_SIZE_LIMIT' : undefined);
      }
    };
    if (item.incoming) {
      pc.ondatachannel = (event) => this.bindChannel(item, event.channel);
    } else {
      this.bindChannel(item, pc.createDataChannel('suichuan', { ordered: true }));
    }
  }

  async beginOffer(item) {
    if (ended.has(item.status)) {
      return;
    }
    const description = await item.pc.createOffer();
    await item.pc.setLocalDescription(description);
    await this.connection.rpc('signal', { id: item.id, signal: { description } });
  }

  async signal(item, signal) {
    if (ended.has(item.status)) {
      return;
    }
    if (signal.description) {
      const description = item.directOnly ? { ...signal.description, sdp: signal.description.sdp.split(/\r?\n/).filter((line) => !/^a=candidate:.*\btyp relay\b/.test(line)).join('\r\n') } : signal.description;
      await item.pc.setRemoteDescription(description);
      for (const candidate of item.candidates.splice(0)) {
        await item.pc.addIceCandidate(candidate);
      }
      if (signal.description.type === 'offer') {
        const description = await item.pc.createAnswer();
        await item.pc.setLocalDescription(description);
        await this.connection.rpc('signal', { id: item.id, signal: { description } });
      }
    } else if (signal.candidate) {
      if (item.directOnly && /\btyp relay\b/.test(signal.candidate.candidate)) {
        return;
      }
      if (item.pc.remoteDescription) {
        await item.pc.addIceCandidate(signal.candidate);
      } else {
        item.candidates.push(signal.candidate);
      }
    }
  }

  bindChannel(item, channel) {
    if (item.channel) {
      channel.close();
      return;
    }
    item.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      if (ended.has(item.status)) {
        channel.close();
        return;
      }
      item.opening = this.openChannel(item);
      item.opening.then(async () => {
        if (!item.incoming && !ended.has(item.status)) {
          await this.sendBytes(item);
        }
      }).catch((error) => this.fail(item, error.message, error.code));
    };
    channel.onmessage = (event) => {
      item.receiveQueue = (item.receiveQueue || Promise.resolve()).then(async () => {
        await item.opening;
        await this.message(item, event.data);
      }).catch((error) => this.fail(item, error.message, error.code));
    };
    channel.onerror = () => this.fail(item, '数据连接发生错误，请重试');
    channel.onclose = () => {
      if (!ended.has(item.status)) {
        // Allow a previously queued final receipt / digest check to settle.
        (item.receiveQueue || Promise.resolve()).finally(() => {
          if (!ended.has(item.status)) {
            this.fail(item, '数据连接已断开，请重试');
          }
        });
      }
    };
  }

  async openChannel(item) {
    item.activity = Date.now();
    // 大文件仅允许直连，确认实际候选对后才发送文件内容。
    for (let attempt = 0; attempt < (item.directOnly ? 20 : 1); attempt += 1) {
      if (ended.has(item.status)) {
        return;
      }
      const selected = item.pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
      if (selected?.local?.type && selected?.remote?.type) {
        item.route = [selected.local, selected.remote].some((c) => c.type === 'relay') ? 'relay' : 'direct';
      } else {
        const stats = await item.pc.getStats();
        for (const report of stats.values()) {
          const pair = report.type === 'transport' ? stats.get(report.selectedCandidatePairId) : report.type === 'candidate-pair' && (report.selected || report.nominated && report.state === 'succeeded') ? report : null;
          if (pair) {
            const candidates = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)];
            if (candidates.every((candidate) => candidate?.candidateType)) {
              item.route = candidates.some((candidate) => candidate.candidateType === 'relay') ? 'relay' : 'direct';
              break;
            }
          }
        }
      }
      if (item.route || !item.directOnly) {
        break;
      }
      await pause(100);
    }
    if (ended.has(item.status)) {
      return;
    }
    if (item.directOnly && item.route !== 'direct') {
      throw this.relayError(item);
    }
    item.status = 'transferring';
    this.changed(true);
  }

  async sendBytes(item) {
    const hash = sha256.create();
    try {
      for (let start = 0; start < item.size; start += blockSize) {
        if (ended.has(item.status)) {
          return;
        }
        const buffer = new Uint8Array(await item.blob.slice(start, start + blockSize).arrayBuffer());
        hash.update(buffer);
        for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
          while (item.channel.bufferedAmount > 512 * 1024 && !ended.has(item.status)) {
            await pause(15);
          }
          if (ended.has(item.status)) {
            return;
          }
          const chunk = buffer.subarray(offset, offset + chunkSize);
          item.channel.send(chunk);
          item.bytes = start + offset + chunk.byteLength;
          item.activity = Date.now();
          this.changed();
        }
      }
      if (!ended.has(item.status)) {
        item.channel.send(JSON.stringify({ type: 'end', hash: hex(hash.digest()) }));
      }
    } finally {
      hash.destroy();
    }
  }

  async message(item, data) {
    if (ended.has(item.status)) {
      return;
    }
    item.activity = Date.now();
    if (typeof data !== 'string') {
      if (!item.incoming || !(data instanceof ArrayBuffer) || data.byteLength > chunkSize || item.bytes + data.byteLength > item.size || item.receivingEnd) {
        throw new Error('收到的数据与传输声明不一致');
      }
      if (item.directOnly && item.route !== 'direct') {
        throw this.relayError(item);
      }
      item.hash.update(new Uint8Array(data));
      item.chunks.push(data);
      item.chunkBytes += data.byteLength;
      if (item.chunkBytes >= blockSize) {
        item.parts.push(new Blob(item.chunks));
        item.chunks = [];
        item.chunkBytes = 0;
      }
      item.bytes += data.byteLength;
      this.changed();
      return;
    }
    if (data.length > 256) {
      throw new Error('无效的传输回执');
    }
    const message = JSON.parse(data);
    if (message.type === 'cancel') {
      this.finishLocal(item, 'cancelled');
      this.endRemote(item.id, 'cancelled');
    } else if (message.type === 'ack' && !item.incoming) {
      this.finishLocal(item, 'completed');
    } else if (message.type === 'end' && item.incoming && !item.receivingEnd) {
      item.receivingEnd = true;
      if (item.bytes !== item.size) {
        throw new Error('接收内容不完整，请重新发送');
      }
      const blob = new Blob([...item.parts, ...item.chunks], { type: item.mime });
      if (hex(item.hash.digest()) !== message.hash) {
        throw new Error('内容校验失败，请重新发送');
      }
      const text = item.kind === 'text' ? new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()) : undefined;
      if (ended.has(item.status)) {
        return;
      }
      item.blob = blob;
      item.verified = true;
      if (item.kind === 'text') {
        item.text = text;
      }
      if (safeImages.has(item.mime)) {
        item.url = URL.createObjectURL(blob);
      }
      item.status = 'completed';
      item.chunks = [];
      item.parts = [];
      item.channel.send(JSON.stringify({ type: 'ack' }));
      this.endRemote(item.id, 'completed');
      this.changed(true);
      setTimeout(() => this.closePeer(item), 1500);
    } else {
      throw new Error('无效的传输消息');
    }
  }

  endRemote(id, status, reasonCode) {
    if (!id) {
      return;
    }
    const result = { status, ...(reasonCode ? { reasonCode } : {}) };
    this.pendingEnds.set(id, result);
    this.connection.rpc('transfer.end', { id, ...result }).then(() => this.pendingEnds.delete(id)).catch((error) => {
      if (['TRANSFER_ENDED', 'NOT_FOUND', 'NOT_PAIRED'].includes(error.code)) {
        this.pendingEnds.delete(id);
      }
    });
  }

  closePeer(item) {
    item.pc?.close();
    item.chunks = [];
    item.parts = [];
    item.hash?.destroy();
  }

  finishLocal(item, status, reason = '') {
    if (ended.has(item.status)) {
      return;
    }
    item.status = status;
    item.reason = reason;
    this.closePeer(item);
    this.changed(true);
  }

  fail(item, reason, reasonCode) {
    if (!ended.has(item.status)) {
      this.finishLocal(item, 'failed', reason || '传输失败，请重试');
      this.endRemote(item.id, 'failed', reasonCode);
    }
  }

  cancel(item) {
    if (!ended.has(item.status)) {
      if (item.channel?.readyState === 'open') {
        item.channel.send(JSON.stringify({ type: 'cancel' }));
      }
      this.finishLocal(item, 'cancelled');
      this.endRemote(item.id, 'cancelled');
    }
  }

  clear() {
    const activeGroups = new Set(this.items.filter((item) => item.groupId && !ended.has(item.status)).map((item) => item.groupId));
    this.items = this.items.filter((item) => {
      if (item.shareOpen || !ended.has(item.status) || activeGroups.has(item.groupId)) {
        return true;
      }
      if (item.url) {
        URL.revokeObjectURL(item.url);
      }
      this.byId.delete(item.id);
      return false;
    });
    this.groups = this.groups.filter((group) => activeGroups.has(group.id));
    this.queue = this.queue.filter((item) => item.status === 'queued');
    this.changed(true);
  }
}
