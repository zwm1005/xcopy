import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { sourceKey, TokenBuckets } from '../server/availability.js';
import { loadConfig } from '../server/config.js';
import { setup, identity, pair, metadata } from './helpers/ws-client.js';

const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const peerEvents = (client) => client.events.filter((event) => event.type === 'peers');

function http(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: headers.Upgrade ? '/ws' : '/healthz', headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('availability configuration rejects invalid limits and normalizes source identities', () => {
  const config = loadConfig({});
  assert.equal(config.maxConnectionsPerIp, 64);
  assert.equal(config.maxConnectionsPerDevice, 8);
  assert.equal(config.maxGuestConnections, 256);
  for (const env of [{ WS_MAX_CONNECTIONS_PER_IP: '0' }, { WS_GUEST_IDLE_SECONDS: '-1' }, { WS_TRANSFER_BURST: 'NaN' }]) {
    assert.throws(() => loadConfig(env), /配置无效/);
  }
  assert.equal(sourceKey('::ffff:192.0.2.1'), sourceKey('192.0.2.1'));
  assert.equal(sourceKey('::ffff:c000:201'), sourceKey('192.0.2.1'));
  assert.equal(sourceKey('2001:db8:1:2::1'), sourceKey('2001:0db8:0001:0002:ffff::a'));
  assert.notEqual(sourceKey('2001:db8:1:3::1'), sourceKey('2001:db8:1:2::1'));
  assert.equal(sourceKey('spoofed'), null);
});

test('token buckets bound bursts, refill, charge budgets atomically and expire idle state', () => {
  let time = 0;
  const buckets = new TokenBuckets(() => time);
  const device = { key: 'device', perMinute: 60, burst: 2 };
  const ip = { key: 'ip', perMinute: 60, burst: 1 };
  assert.equal(buckets.take([ip]), 0);
  assert.equal(buckets.take([device, ip]), 1000);
  assert.equal(buckets.take([device]), 0);
  assert.equal(buckets.take([device]), 0);
  assert.equal(buckets.take([device]), 1000);
  time += 1000;
  assert.equal(buckets.take([device, ip]), 0);
  time += 60001;
  buckets.sweep();
  assert.equal(buckets.entries.size, 0);
});

test('per-IP limits include pending, guest and device sockets and release on disconnect', async (t) => {
  const { connect, denied } = await setup(t, { maxConnectionsPerIp: 3, maxPendingPerIp: 2 });
  const a = await connect({ source: '192.0.2.1' });
  const b = await connect({ source: '192.0.2.1' });
  assert.equal(await denied('192.0.2.1'), 429);
  await a.auth();
  await b.guest();
  const pending = await connect({ source: '192.0.2.1' });
  assert.equal(await denied('::ffff:192.0.2.1'), 429);
  const other = await connect({ source: '192.0.2.2' });
  await other.auth();
  await b.close();
  const replacement = await connect({ source: '192.0.2.1' });
  await replacement.guest();
  await pending.close();
});

test('pending and total global caps reject excess upgrades while HTTP stays available', async (t) => {
  const { connect, denied, address } = await setup(t, { maxConnections: 3, maxPendingConnections: 2 });
  const a = await connect();
  const b = await connect();
  assert.equal(await denied('192.0.2.90'), 503);
  await a.guest();
  const c = await connect();
  await c.auth();
  assert.equal(await denied('192.0.2.91'), 503);
  assert.equal(await http(address.port), 200);
  await b.close();
  await (await connect()).auth();
});

test('guest pool cannot consume device capacity and rejected guest admission releases its lease', async (t) => {
  const { connect } = await setup(t, { maxGuestConnections: 2, maxConnections: 4 });
  await (await connect()).guest();
  await (await connect()).guest();
  const rejectedGuest = await connect();
  const closed = once(rejectedGuest.ws, 'close');
  await rejected(rejectedGuest.guest(), 'BUSY');
  await closed;
  await (await connect()).auth();
});

test('device quota preserves existing receiving tabs and frees capacity before reconnect', async (t) => {
  const { connect, settle } = await setup(t, { maxConnectionsPerDevice: 2 });
  const keys = identity();
  const first = await (await connect({ keys })).auth();
  const second = await (await connect({ keys })).auth();
  const excess = await connect({ keys });
  const closed = once(excess.ws, 'close');
  await rejected(excess.auth(), 'BUSY');
  await closed;
  assert.equal(first.ws.readyState, WebSocket.OPEN);
  assert.equal(second.ws.readyState, WebSocket.OPEN);
  assert.deepEqual(second.authResult.reception, { here: false, pages: 2 });
  await first.close();
  await settle();
  assert.deepEqual(peerEvents(second).at(-1).data.reception, { here: true, pages: 1 });
  const replacement = await (await connect({ keys })).auth();
  assert.deepEqual(replacement.authResult.reception, { here: false, pages: 2 });
});

test('failed WebSocket handshakes and authentication timeouts release reserved capacity', async (t) => {
  const { app, connect, address, advance } = await setup(t, { maxConnections: 1, maxPendingConnections: 1 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await http(address.port, { Upgrade: 'websocket', Connection: 'Upgrade', Origin: app.config.origin, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'invalid' }), 400);
  }
  const pending = await connect();
  const closed = once(pending.ws, 'close');
  advance(app.config.challengeTtl + 1);
  app.sweep();
  assert.equal((await closed)[0], 1008);
  await (await connect()).auth();
});

test('pongs and invalid requests do not extend an unbound guest lifetime; devices remain available', async (t) => {
  const { app, connect, advance } = await setup(t);
  const guest = await (await connect()).guest();
  const device = await (await connect()).auth();
  const closed = once(guest.ws, 'close');
  advance(app.config.guestIdleTimeout + 1);
  guest.ws.pong();
  await rejected(guest.rpc('share.inspect', { token: 'invalid' }), 'SHARE_NOT_FOUND');
  app.sweep();
  const [code, reason] = await closed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'Guest session idle');
  advance(86400000);
  app.sweep();
  assert.equal(device.ws.readyState, WebSocket.OPEN);
  assert.deepEqual((await device.rpc('peers.list')).peers, []);
});

test('queued claims and draining transfers survive guest idle cleanup', async (t) => {
  const { app, connect, advance } = await setup(t, { shareConcurrency: 1 });
  const sender = await (await connect()).auth();
  const share = await sender.rpc('share.create', { mode: 'multiple', shareProtocol: 2, minutes: 10, files: [metadata] });
  const first = await (await connect()).guest();
  await first.rpc('share.inspect', { token: share.token });
  const a = await first.rpc('share.claim', { token: share.token });
  advance(61000);
  app.sweep();
  assert.equal(first.ws.readyState, WebSocket.OPEN);
  const second = await (await connect()).guest();
  const b = await second.rpc('share.claim', { token: share.token });
  assert.equal(b.myClaim.state, 'queued');
  advance(600001);
  app.sweep();
  assert.equal(first.ws.readyState, WebSocket.OPEN);
  assert.equal(second.ws.readyState, WebSocket.OPEN);
  const started = await sender.rpc('share.file.start', { id: share.id, claimId: a.myClaim.id, index: 0 });
  await first.rpc('transfer.accept', { id: started.id });
  await first.rpc('transfer.end', { id: started.id, status: 'completed' });
  assert.equal((await second.rpc('share.inspect', { token: share.token })).myClaim.state, 'transferring');
  await sender.rpc('share.cancel', { id: share.id });
  const closed = once(second.ws, 'close');
  advance(app.config.guestIdleTimeout + 1);
  app.sweep();
  assert.equal((await closed)[0], 1000);
});

test('rename fanout is coalesced per device, shares snapshots across tabs and excludes unrelated users', async (t) => {
  const { app, connect, settle, advance } = await setup(t, { publishInterval: 100 });
  const keys = identity();
  const tabs = [];
  for (let i = 0; i < 6; i += 1) {
    tabs.push(await (await connect({ keys })).auth());
  }
  const peer = await (await connect()).auth();
  const unrelated = await (await connect()).auth();
  await pair(tabs[0], peer);
  await settle();
  for (const client of [...tabs, peer, unrelated]) {
    client.events.length = 0;
  }
  const reads = [];
  for (const name of ['peers', 'device']) {
    const original = app.store[name].bind(app.store);
    app.store[name] = (id) => { reads.push({ name, id }); return original(id); };
  }
  await Promise.all(['first', 'second', 'last'].map((name) => tabs[0].rpc('device.rename', { name })));
  await settle();
  for (let i = 0; i < tabs.length; i += 1) {
    const events = peerEvents(tabs[i]);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.name, 'last');
    assert.deepEqual(events[0].data.reception, { here: i === 0, pages: 6 });
  }
  assert.equal(peerEvents(peer).length, 1);
  assert.equal(peerEvents(peer)[0].data.peers[0].name, 'last');
  assert.equal(peerEvents(unrelated).length, 0);
  assert.equal(reads.filter((read) => read.id === unrelated.id).length, 0);
  assert.equal(reads.filter((read) => read.id === peer.id).length, 2);
  assert.equal(reads.filter((read) => read.id === tabs[0].id).length, 8);
  await assert.rejects(tabs[1].rpc('device.rename', { name: 'excess' }), (error) => error.code === 'RATE_LIMIT' && error.retryAfterMs > 0);
  advance(6001);
  for (const client of [...tabs, peer]) {
    client.events.length = 0;
  }
  reads.length = 0;
  await tabs[0].rpc('device.rename', { name: 'last' });
  await settle();
  assert.equal(peerEvents(tabs[0]).length, 0);
  assert.equal(peerEvents(peer).length, 0);
  assert.equal(reads.length, 1);
});

test('normal and share starts share a budget; valid ends bypass creation limits and release active slots', async (t) => {
  const { app, connect, advance, settle } = await setup(t, { transferRate: 60, transferBurst: 2, maxActive: 2 });
  const sender = await (await connect()).auth();
  const peer = await (await connect()).auth();
  const guest = await (await connect()).guest();
  await pair(sender, peer);
  const share = await sender.rpc('share.create', { minutes: 10, files: [metadata, metadata] });
  await guest.rpc('share.claim', { token: share.token });
  const normal = await sender.rpc('transfer.start', { peerId: peer.id, metadata });
  const shared = await sender.rpc('share.file.start', { id: share.id, index: 0 });
  await rejected(sender.rpc('transfer.start', { peerId: peer.id, metadata }), 'RATE_LIMIT');
  await rejected(sender.rpc('share.file.start', { id: share.id, index: 1 }), 'RATE_LIMIT');
  await sender.rpc('transfer.end', { id: normal.id, status: 'cancelled' });
  await guest.rpc('transfer.accept', { id: shared.id });
  await guest.rpc('transfer.end', { id: shared.id, status: 'completed' });
  await settle();
  sender.events.length = 0;
  peer.events.length = 0;
  const prepare = app.store.db.prepare.bind(app.store.db);
  let selects = 0;
  app.store.db.prepare = (sql) => { selects += Number(sql.startsWith('SELECT')); return prepare(sql); };
  await rejected(guest.rpc('transfer.end', { id: shared.id, status: 'completed' }), 'TRANSFER_ENDED');
  await settle();
  assert.equal(selects, 0);
  assert.equal(peerEvents(sender).length, 0);
  assert.equal(peerEvents(peer).length, 0);
  advance(1000);
  const next = await sender.rpc('share.file.start', { id: share.id, index: 1 });
  await guest.rpc('transfer.accept', { id: next.id });
  await guest.rpc('transfer.end', { id: next.id, status: 'completed' });
  assert.equal((await sender.rpc('share.list')).shares[0].status, 'completed');
  await settle();
  assert.equal(selects, 0);
  assert.equal(peerEvents(sender).length, 0);
  assert.equal(peerEvents(peer).length, 0);
});

test('per-IP operation budgets cover different device keys and message bursts terminate the offender', async (t) => {
  await t.test('rename and start IP budgets', async (t) => {
    const { connect } = await setup(t, { renameIpBurst: 1, transferIpBurst: 1 });
    const a = await (await connect({ source: '192.0.2.1' })).auth();
    const b = await (await connect({ source: '192.0.2.1' })).auth();
    const c = await (await connect()).auth();
    await a.rpc('device.rename', { name: 'changed' });
    await rejected(b.rpc('device.rename', { name: 'blocked' }), 'RATE_LIMIT');
    await pair(a, c);
    await pair(b, c);
    const started = await a.rpc('transfer.start', { peerId: c.id, metadata });
    await rejected(b.rpc('transfer.start', { peerId: c.id, metadata }), 'RATE_LIMIT');
    await a.rpc('transfer.end', { id: started.id, status: 'cancelled' });
  });
  await t.test('burst gate before dispatch', async (t) => {
    const { connect } = await setup(t, { messageBurst: 3 });
    const guest = await (await connect()).guest();
    await rejected(guest.rpc('unsupported'), 'UNAUTHORIZED');
    await rejected(guest.rpc('unsupported'), 'UNAUTHORIZED');
    const closed = once(guest.ws, 'close');
    guest.ws.send(JSON.stringify({ id: 'over-budget', type: 'guest.open' }));
    assert.equal((await closed)[0], 1008);
  });
});

test('batch transfers and reconnect resume keep active counts and receiving ownership consistent', async (t) => {
  const { connect, advance, settle } = await setup(t, { maxConnectionsPerDevice: 1 });
  const a = await (await connect()).auth();
  const b = await (await connect()).auth();
  await pair(a, b);
  for (let i = 0; i < 40; i += 1) {
    advance(101);
    const started = await a.rpc('transfer.start', { peerId: b.id, metadata });
    assert.equal((await a.rpc('peers.list')).peers[0].busy, 1);
    await b.rpc('transfer.accept', { id: started.id });
    await b.rpc('transfer.end', { id: started.id, status: 'completed' });
  }
  const started = await a.rpc('transfer.start', { peerId: b.id, metadata });
  await a.close();
  const resumed = await (await connect({ keys: a.keys })).auth('设备', a.authResult.sessionId);
  assert.equal(resumed.authResult.resumed, true);
  assert.deepEqual(resumed.authResult.reception, { here: true, pages: 1 });
  assert.equal(resumed.authResult.tasks.some((task) => task.id === started.id), true);
  await b.rpc('transfer.accept', { id: started.id });
  await b.rpc('transfer.end', { id: started.id, status: 'completed' });
  await settle();
  assert.equal((await resumed.rpc('peers.list')).peers[0].busy, 0);
  assert.equal(peerEvents(resumed).at(-1).data.peers[0].busy, 0);
  await resumed.rpc('pair.forget', { peerId: b.id });
});

test('one IP cannot accumulate 1000 retained guest connections across seventeen rate windows', async (t) => {
  // Also retain the old per-IP protection when the new preview policy is disabled.
  const { app, connect, denied, advance } = await setup(t, { guestPreviewEnabled: false });
  const sender = await (await connect()).auth();
  const share = await sender.rpc('share.create', { minutes: 60, files: [metadata] });
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (i > 0 && i % 60 === 0) {
      advance(60001);
      app.sweep();
    }
    if (accepted < app.config.maxConnectionsPerIp) {
      const guest = await (await connect({ source: '198.51.100.1' })).guest();
      await guest.rpc('share.inspect', { token: share.token });
      accepted += 1;
    } else {
      assert.equal(await denied('198.51.100.1'), 429);
      refused += 1;
    }
  }
  assert.equal(accepted, 64);
  assert.equal(refused, 936);
  const legitimate = await (await connect({ source: '203.0.113.1' })).auth();
  assert.equal(legitimate.ws.readyState, WebSocket.OPEN);
});

test('slow consumers are disconnected without evicting other devices and their quota is released', async (t) => {
  const { app, connect } = await setup(t, { maxConnectionsPerDevice: 1 });
  const slow = await (await connect()).auth();
  const other = await (await connect()).auth();
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount');
  Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
    ...descriptor,
    get() {
      return this.deviceId === slow.id ? app.config.maxBufferedBytes + 1 : descriptor.get.call(this);
    }
  });
  const restore = () => Object.defineProperty(WebSocket.prototype, 'bufferedAmount', descriptor);
  t.after(restore);
  const closed = once(slow.ws, 'close');
  await assert.rejects(slow.rpc('peers.list'), /Connection closed/);
  assert.equal((await closed)[0], 1013);
  restore();
  assert.deepEqual((await other.rpc('peers.list')).peers, []);
  await (await connect({ keys: slow.keys })).auth();
});

test('a client that never acknowledges closure cannot retain its connection lease', async (t) => {
  const { app, connect, denied, advance } = await setup(t, { maxConnections: 1 });
  const pending = await connect();
  pending.ws.pause();
  advance(app.config.challengeTtl + 1);
  app.sweep();
  assert.equal(await denied('203.0.113.9'), 503);
  await delay(2100);
  await (await connect({ source: '203.0.113.9' })).auth();
  const closed = once(pending.ws, 'close');
  pending.ws.resume();
  await closed;
});

test('heartbeats probe live sockets without querying SQLite or publishing device lists', async (t) => {
  const interval = globalThis.setInterval;
  let heartbeat;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    if (ms === 15000) {
      heartbeat = callback;
    }
    return interval(callback, ms, ...args);
  });
  const { app, connect, settle } = await setup(t);
  const device = await (await connect()).auth();
  await settle();
  device.events.length = 0;
  const prepare = app.store.db.prepare.bind(app.store.db);
  let queries = 0;
  app.store.db.prepare = (sql) => { queries += 1; return prepare(sql); };
  const ping = once(device.ws, 'ping');
  heartbeat();
  await ping;
  assert.equal(queries, 0);
  assert.equal(peerEvents(device).length, 0);
});
