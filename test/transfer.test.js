import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Transfers } from '../public/transfer.js';

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
