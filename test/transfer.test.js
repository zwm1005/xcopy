import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Transfers } from '../dist/public/transfer.js';

const peers = [{ id: 'b', name: '电脑 B', online: true }, { id: 'c', name: '电脑 C', online: true }];
const sources = Array.from({ length: 9 }, (_, index) => ({ kind: 'text', text: `内容 ${index}` }));

// The network and RTC are external boundaries; queue/state methods remain real.
class Connection extends EventTarget {
  ready = true;
  device = { id: 'a' };
  config = { maxFileBytes: 50 * 1048576 };
  starts = [];
  ends = [];
  deferred = false;
  rpc(type, data) {
    if (type === 'transfer.start') {
      const call = { ...data, id: `remote-${this.starts.length}` };
      this.starts.push(call);
      const result = { id: call.id, iceServers: [], forceRelay: false };
      if (this.deferred) {
        return new Promise((resolve) => { call.release = () => resolve(result); });
      }
      return Promise.resolve(result);
    }
    if (type === 'transfer.end') {
      this.ends.push(data);
    }
    return Promise.resolve({});
  }
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function setup(t) {
  const connection = new Connection();
  const oldRTC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class {
    createDataChannel() {
      return { readyState: 'connecting', close() {} };
    }
    close() {}
  };
  const transfers = new Transfers(connection);
  connection.emit('ready', { peers, tasks: [], resumed: false });
  t.after(() => {
    clearInterval(transfers.maintenance);
    clearTimeout(transfers.changeTimer);
    globalThis.RTCPeerConnection = oldRTC;
  });
  return { connection, transfers };
}

async function settle() {
  await delay(10);
}

async function complete(transfers, item) {
  await transfers.message(item, JSON.stringify({ type: 'ack' }));
  await settle();
}

test('18 outgoing transfers share three slots until actual completion, including single sends', async (t) => {
  const { connection, transfers } = setup(t);
  assert.equal(typeof transfers.sendBatch, 'function', 'batch queue must exist');
  transfers.sendBatch(peers, sources, { group: true });
  await settle();
  assert.equal(connection.starts.length, 3, 'RPC success alone must not release a slot');
  assert.equal(transfers.items.filter(item => item.status === 'queued').length, 15);
  await transfers.send(peers[0], sources[0]);
  await settle();
  assert.equal(connection.starts.length, 3, 'single sends use the same queue');
  await complete(transfers, transfers.items.find(item => item.id === 'remote-0'));
  assert.equal(connection.starts.length, 4);
  assert.equal(transfers.items.filter(item => item.status === 'completed').length, 1);
});

test('recipient snapshot deduplicates devices and excludes later arrivals', async (t) => {
  const { connection, transfers } = setup(t);
  transfers.sendBatch([peers[0], peers[0], peers[1]], sources.slice(0, 2), { group: true });
  connection.emit('peers', { peers: [...peers, { id: 'd', name: '后来上线', online: true }] });
  await settle();
  assert.equal(transfers.items.length, 4);
  for (const item of [...transfers.items].filter(item => item.id)) {
    await complete(transfers, item);
  }
  assert.equal(connection.starts.length, 4);
  assert.deepEqual(new Set(connection.starts.map(call => call.peerId)), new Set(['b', 'c']));
});

test('cancelled in-flight creation still cancels its server task and never starts queued work', async (t) => {
  const { connection, transfers } = setup(t);
  connection.deferred = true;
  transfers.sendBatch(peers, sources, { group: true });
  await settle();
  transfers.cancelGroup(transfers.groups[0]);
  assert.equal(transfers.items.filter(item => item.status === 'cancelled').length, 18);
  connection.starts.forEach(call => call.release());
  await settle();
  assert.equal(connection.starts.length, 3);
  assert.deepEqual(new Set(connection.ends.map(end => end.id)), new Set(['remote-0', 'remote-1', 'remote-2']));
  assert.ok(connection.ends.every(end => end.status === 'cancelled'));
});

test('retrying failures preserves successes and clear retains an unfinished group', async (t) => {
  const { connection, transfers } = setup(t);
  transfers.sendBatch(peers, sources.slice(0, 1), { group: true });
  await settle();
  const failed = transfers.items.find(item => item.peerId === 'b');
  const success = transfers.items.find(item => item.peerId === 'c');
  await complete(transfers, success);
  transfers.clear();
  assert.equal(transfers.items.length, 2, 'keep the success while the group is unfinished');
  transfers.fail(failed, '测试断线');
  transfers.retryGroup(transfers.groups[0]);
  await settle();
  assert.deepEqual(connection.starts.map(call => call.peerId), ['b', 'c', 'b']);
  assert.equal(transfers.items.length, 2);
  assert.equal(transfers.items.find(item => item.peerId === 'c'), success);
  transfers.retryGroup(transfers.groups[0]);
  await settle();
  assert.equal(connection.starts.length, 3, 'a second click must not duplicate a queued retry');
  await complete(transfers, transfers.items.find(item => item.peerId === 'b'));
  transfers.clear();
  assert.equal(transfers.items.length, 0);
  assert.equal(transfers.groups.length, 0);
});

test('offline or revoked targets fail queued work without blocking other recipients', async (t) => {
  const { connection, transfers } = setup(t);
  transfers.sendBatch(peers, sources.slice(0, 4), { group: true });
  await settle();
  connection.emit('peers', { peers: [peers[1]] });
  await settle();
  const queuedB = transfers.items.filter(item => item.peerId === 'b' && !item.id);
  assert.equal(queuedB.length, 2);
  assert.ok(queuedB.every(item => item.status === 'failed'));
  for (const item of transfers.items.filter(item => item.id)) {
    await complete(transfers, item);
  }
  assert.equal(connection.starts.filter(call => call.peerId === 'b').length, 2);
  assert.equal(connection.starts.filter(call => call.peerId === 'c').length, 4);
  transfers.retryGroup(transfers.groups[0]);
  await settle();
  assert.equal(connection.starts.filter(call => call.peerId === 'b').length, 2);
});

test('clearing a partially delivered single-device batch preserves its completion summary', async (t) => {
  const { transfers } = setup(t);
  transfers.sendBatch([peers[0]], sources.slice(0, 2));
  await settle();
  const first = transfers.items[0];
  const second = transfers.items[1];
  assert.equal(first.batchId, second.batchId);
  await complete(transfers, first);
  transfers.clear();
  assert.equal(transfers.items.length, 2);
  transfers.fail(second, 'Test failure');
  transfers.retry(second);
  assert.equal(transfers.items.find(item => item.localId === second.localId).batchId, first.batchId);
});

test('queued work survives long waits and reconnect without being mistaken for a lost remote task', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { connection, transfers } = setup(t);
  connection.ready = false;
  transfers.sendBatch(peers, sources, { group: true });
  for (const item of transfers.items) {
    item.activity = Date.now() - 60000;
  }
  t.mock.timers.tick(5000);
  await settle();
  assert.ok(transfers.items.every(item => item.status === 'queued'));
  assert.equal(connection.starts.length, 0);
  connection.ready = true;
  connection.emit('ready', { peers, tasks: [], resumed: false });
  await settle();
  assert.equal(connection.starts.length, 3);
  assert.equal(transfers.items.filter(item => item.status === 'queued').length, 15);
});

test('cancelling one queued item never sends it later', async (t) => {
  const { connection, transfers } = setup(t);
  transfers.sendBatch(peers, sources.slice(0, 3), { group: true });
  await settle();
  const queued = transfers.items.find(item => item.status === 'queued');
  transfers.cancel(queued);
  for (const item of [...transfers.items].filter(item => item.id)) {
    await complete(transfers, item);
  }
  assert.equal(connection.starts.length, 5);
  assert.equal(queued.status, 'cancelled');
  assert.equal(queued.id, undefined);
});

test('files are read and checked in bounded blocks with the original SHA-256 wire format', async (t) => {
  const { transfers } = setup(t);
  const content = Buffer.alloc(3 * 1048576 + 79, 173);
  const file = new File([content], '大文件.bin');
  file.arrayBuffer = () => { throw new Error('不应一次读取整个文件'); };
  const messages = [];
  const sender = transfers.queuedItem(peers[0], { kind: 'file', file });
  sender.status = 'transferring';
  sender.channel = { bufferedAmount: 0, send: (data) => messages.push(typeof data === 'string' ? data : Buffer.from(data)) };
  await transfers.sendBytes(sender);
  const end = JSON.parse(messages.pop());
  assert.equal(end.hash, createHash('sha256').update(content).digest('hex'));
  assert.ok(messages.every((chunk) => chunk.byteLength <= 16384));
  assert.deepEqual(Buffer.concat(messages), content);
  await transfers.receive({ id: 'receive-large', peerId: 'b', metadata: { kind: 'file', name: file.name, size: file.size, mime: file.type }, iceServers: [] });
  const receiver = transfers.byId.get('receive-large');
  receiver.channel = { send() {}, readyState: 'open' };
  for (const chunk of messages) {
    await transfers.message(receiver, chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    assert.ok(receiver.chunkBytes < 1048576);
  }
  await transfers.message(receiver, JSON.stringify(end));
  assert.equal(receiver.status, 'completed');
  assert.equal(receiver.verified, true);
  assert.deepEqual(Buffer.from(await receiver.blob.arrayBuffer()), content);
});

test('large incoming files are accepted for direct transfer but never send data over a relay route', async (t) => {
  const { connection, transfers } = setup(t);
  await transfers.receive({ id: 'unlimited', peerId: 'b', metadata: { kind: 'file', name: '5GiB.bin', size: 5 * 1024 ** 3 }, iceServers: [] });
  const incoming = transfers.byId.get('unlimited');
  assert.equal(incoming.status, 'waiting');
  assert.equal(incoming.directOnly, true);
  const file = new File(['x'], 'large.bin');
  const outgoing = transfers.queuedItem(peers[0], { kind: 'file', file });
  outgoing.directOnly = true;
  outgoing.pc = { sctp: { transport: { iceTransport: { getSelectedCandidatePair: () => ({ local: { type: 'relay' }, remote: { type: 'host' } }) } } } };
  await assert.rejects(transfers.openChannel(outgoing), { code: 'RELAY_SIZE_LIMIT' });
  assert.equal(outgoing.bytes, 0);
  await transfers.receive({ id: 'forced', peerId: 'b', metadata: { kind: 'file', name: 'large.bin', size: 50 * 1048576 + 1 }, iceServers: [], forceRelay: true });
  assert.equal(transfers.byId.get('forced').status, 'failed');
  assert.match(transfers.byId.get('forced').reason, /50 MB/);
  assert.ok(connection.ends.some((entry) => entry.id === 'forced' && entry.reasonCode === 'RELAY_SIZE_LIMIT'));
});
