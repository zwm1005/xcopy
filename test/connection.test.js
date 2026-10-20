import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection } from '../dist/public/connection.js';

const ready = { device: { id: 'guest', name: 'Guest' }, sessionId: 'session', resumed: false, peers: [], tasks: [], config: { maxFileBytes: 1, maxTextBytes: 1 } };
const started = { id: 'transfer', forceRelay: false, iceServers: [] };

async function setup(t, reply) {
  const originals = { WebSocket: globalThis.WebSocket, location: globalThis.location };
  const sockets = [];
  const calls = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const request = JSON.parse(raw);
      calls.push(request);
      const response = request.type === 'guest.open' ? { ok: true, data: ready } : reply(request);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ replyTo: request.id, ...response }) })));
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
    }
  }
  globalThis.WebSocket = Socket;
  globalThis.location = { href: 'http://localhost/s' };
  const connection = new Connection({ guest: true });
  t.after(() => {
    connection.stop();
    globalThis.WebSocket = originals.WebSocket;
    globalThis.location = originals.location;
  });
  const connected = once(connection, 'ready');
  connection.connect();
  await connected;
  return { connection, sockets, calls };
}

for (const kind of ['transfer.start', 'share.file.start']) {
  test(`${kind} retries creation only after a recoverable rate limit`, async (t) => {
    let attempts = 0;
    const { connection, calls } = await setup(t, () => {
      attempts += 1;
      return attempts < 3 ? { ok: false, error: { code: 'RATE_LIMIT', message: '操作太频繁，请稍后再试', retryAfterMs: 1 } } : { ok: true, data: started };
    });
    assert.equal((await connection.rpc(kind, {})).id, 'transfer');
    assert.equal(calls.filter((call) => call.type === kind).length, 3);
    assert.equal(new Set(calls.map((call) => call.id)).size, calls.length);
  });
}

for (const [kind, code] of [['device.rename', 'RATE_LIMIT'], ['transfer.start', 'NOT_PAIRED']]) {
  test(`${kind} ${code} is never automatically replayed`, async (t) => {
    const { connection, calls } = await setup(t, () => ({ ok: false, error: { code, message: '操作太频繁，请稍后再试', retryAfterMs: 1 } }));
    await assert.rejects(connection.rpc(kind, { name: 'new' }), (error) => error.code === code && error.retryAfterMs === 1);
    assert.equal(calls.filter((call) => call.type === kind).length, 1);
  });
}

test('idle guests stop reconnecting and concurrent explicit requests wake one connection', async (t) => {
  const snapshot = { id: 'share', mode: 'single', status: 'ready', expires: 1, totalBytes: 0, senderName: 'Sender', accepting: true, senderOnline: true, mine: false, files: [] };
  const { connection, sockets, calls } = await setup(t, () => ({ ok: true, data: snapshot }));
  sockets[0].close(1000, 'Guest session idle');
  assert.equal(connection.suspended, true);
  assert.equal(connection.timer, undefined);
  assert.equal(sockets.length, 1);
  const results = await Promise.all([connection.rpc('share.inspect', { token: 'token' }), connection.rpc('share.inspect', { token: 'token' })]);
  assert.equal(results.length, 2);
  assert.equal(sockets.length, 2);
  assert.equal(calls.filter((call) => call.type === 'guest.open').length, 2);
  assert.equal(connection.ready, true);
});

test('unexpected disconnects still schedule reconnection with backoff', async (t) => {
  const { connection, sockets } = await setup(t, () => ({ ok: true, data: {} }));
  const connected = once(connection, 'ready');
  sockets[0].close(1006, 'Network lost');
  assert.equal(connection.suspended, false);
  assert.ok(connection.timer);
  await connected;
  assert.equal(sockets.length, 2);
  assert.equal(connection.ready, true);
});

test('closing during a rate wait does not create a task on another session', async (t) => {
  let attempts = 0;
  const { connection, sockets } = await setup(t, () => {
    attempts += 1;
    return { ok: false, error: { code: 'RATE_LIMIT', message: '操作太频繁，请稍后再试', retryAfterMs: 20 } };
  });
  const result = assert.rejects(connection.rpc('transfer.start', {}));
  await delay(5);
  connection.stop();
  await result;
  assert.equal(attempts, 1);
  assert.equal(sockets.length, 1);
});
