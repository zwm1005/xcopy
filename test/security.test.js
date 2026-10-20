import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { clientSource } from '../server/client-source.js';
import { loadConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { TokenBuckets } from '../server/availability.js';
import { turnCredentials } from '../server/turn.js';
import { setup, metadata, pair } from './helpers/ws-client.js';

const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const turnConfig = { turnUrls: ['turn:localhost:3478'], turnSecret: 's'.repeat(32) };

test('trusted proxy chain uses the nearest untrusted hop and rejects ambiguous headers', () => {
  const source = clientSource({ trustProxy: true, trustedProxyCidrs: ['127.0.0.1/32', '10.10.0.0/16', '2001:db8:ffff::/48'] });
  assert.equal(source('::ffff:127.0.0.1', '1.1.1.1, 192.0.2.10'), '192.0.2.10');
  assert.equal(source('127.0.0.1', '1.1.1.1, 192.0.2.10, 10.10.0.2'), '192.0.2.10');
  assert.equal(source('192.0.2.20', 'spoofed'), '192.0.2.20');
  assert.equal(source('127.0.0.1', '::ffff:c000:201, 2001:db8:ffff::a'), '192.0.2.1');
  assert.equal(source('127.0.0.1', undefined), '127.0.0.1');
  for (const header of ['', '192.0.2.1,', 'spoofed, 192.0.2.1', '192.0.2.1:80', '[2001:db8::1]', 'fe80::1%eth0', '127.0.0.1, 10.10.0.1', Array(17).fill('192.0.2.1').join(','), 'x'.repeat(1025), ['192.0.2.1']]) {
    assert.equal(source('127.0.0.1', header), null);
  }
  assert.equal(clientSource({ trustProxy: false, trustedProxyCidrs: [] })('192.0.2.20', '1.1.1.1'), '192.0.2.20');
  for (const env of [{ TRUST_PROXY: '1' }, { TRUSTED_PROXY_CIDRS: '*' }, { TRUSTED_PROXY_CIDRS: '127.0.0.1' }, { TRUSTED_PROXY_CIDRS: '127.0.0.1/33' }]) {
    assert.throws(() => loadConfig(env), /TRUST/);
  }
});

test('spoofed leftmost XFF cannot evade an actual WebSocket source quota', async (t) => {
  const { connect, denied } = await setup(t, { maxPendingPerIp: 1 });
  await connect({ source: '1.1.1.1, 192.0.2.20' });
  assert.equal(await denied('8.8.8.8, 192.0.2.20'), 429);
  assert.equal(await denied('invalid, 192.0.2.21'), 403);
  await (await connect({ source: '192.0.2.21' })).auth();
});

test('pending admission reclaims a concentrated source, honors cooldown and releases only on close', async (t) => {
  const { app, connect, denied, advance } = await setup(t, { maxPendingConnections: 4, maxPendingPerIp: 4 });
  const device = await (await connect({ source: '203.0.113.1' })).auth();
  const clients = [];
  for (let i = 0; i < 4; i += 1) {
    clients.push(await connect({ source: '192.0.2.1' }));
  }
  assert.equal(await denied('192.0.2.2'), 503); // Grace floor protects slow honest auth.
  assert.equal(clients[0].ws.readyState, WebSocket.OPEN);
  const closed = once(clients[0].ws, 'close');
  advance(2001);
  assert.equal(await denied('192.0.2.2'), 503); // Retry after actual TCP close.
  await closed;
  assert.equal(await denied('192.0.2.1'), 429);
  await (await connect({ source: '192.0.2.2' })).auth();
  assert.equal(device.ws.readyState, WebSocket.OPEN);
  const expired = once(clients[1].ws, 'close');
  advance(app.config.pendingTimeout);
  app.sweep();
  assert.equal((await expired)[0], 1008);
  await (await connect({ source: '192.0.2.3' })).auth();
});

test('pending pool does not evict equally represented sources or exceed the total cap', async (t) => {
  const { connect, denied, advance } = await setup(t, { maxPendingConnections: 2, maxConnections: 3 });
  const a = await connect({ source: '192.0.2.1' });
  const b = await connect({ source: '192.0.2.2' });
  advance(2001);
  assert.equal(await denied('192.0.2.3'), 503);
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
});

test('repeated valid previews cannot extend the fixed guest deadline', async (t) => {
  const { app, connect, advance } = await setup(t);
  const sender = await (await connect()).auth();
  const share = await sender.rpc('share.create', { minutes: 10, files: [metadata] });
  const guest = await (await connect()).guest();
  await guest.rpc('share.inspect', { token: share.token });
  advance(59000);
  await guest.rpc('share.inspect', { token: share.token });
  guest.ws.pong();
  const closed = once(guest.ws, 'close');
  advance(1001);
  app.sweep();
  const [code, reason] = await closed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'Guest session idle');
  const fresh = await (await connect()).guest();
  assert.equal((await fresh.rpc('share.claim', { token: share.token })).myClaim.state, 'transferring');
});

test('guest fairness reclaims only previews, protects admitted claims and cools down the source', async (t) => {
  const { connect, advance } = await setup(t, { maxGuestConnections: 3 });
  const sender = await (await connect({ source: '203.0.113.1' })).auth();
  const share = await sender.rpc('share.create', { mode: 'multiple', shareProtocol: 2, minutes: 10, files: [metadata] });
  const active = await (await connect({ source: '192.0.2.1' })).guest();
  await active.rpc('share.claim', { token: share.token });
  const previews = [];
  for (let i = 0; i < 2; i += 1) {
    const guest = await (await connect({ source: '192.0.2.1' })).guest();
    await guest.rpc('share.inspect', { token: share.token });
    previews.push(guest);
  }
  advance(2001);
  const closed = once(previews[0].ws, 'close');
  const fresh = await connect({ source: '192.0.2.2' });
  await rejected(fresh.guest(), 'BUSY');
  await closed;
  await (await connect({ source: '192.0.2.2' })).guest();
  const attacker = await connect({ source: '192.0.2.1' });
  await rejected(attacker.guest(), 'RATE_LIMIT');
  assert.equal(active.ws.readyState, WebSocket.OPEN);
});

test('share history uses stable sender-scoped cursors, bounded pages and exact idempotency recovery', async (t) => {
  const { connect, advance } = await setup(t, { shareListBurst: 100, shareListIpBurst: 100, authLimit: 1000 });
  const sender = await (await connect()).auth();
  const other = await (await connect({ keys: sender.keys })).auth();
  const history = [];
  for (let i = 0; i < 26; i += 1) {
    advance(61000); // Creation has its own fixed-window rate.
    const share = await sender.rpc('share.create', { requestId: `request-${i}`, minutes: 10, files: [metadata] });
    history.push(share.id);
    await sender.rpc('share.cancel', { id: share.id });
  }
  const first = await sender.rpc('share.list');
  assert.equal(first.shares.length, 20);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.shares.map((s) => s.id), history.slice(6).reverse());
  assert.equal(Buffer.byteLength(JSON.stringify(first)) < 512 * 1024, true);
  await rejected(other.rpc('share.list', { cursor: first.nextCursor }), 'INVALID');
  await rejected(sender.rpc('share.list', { cursor: first.nextCursor + 'x' }), 'INVALID');
  await rejected(sender.rpc('share.list', { limit: 51 }), 'INVALID');
  const newest = await sender.rpc('share.create', { requestId: 'latest', minutes: 10, files: [metadata] });
  assert.equal((await sender.rpc('share.list')).shares[0].id, newest.id);
  await sender.close();
  const resumed = await (await connect({ keys: sender.keys })).auth('设备', sender.authResult.sessionId);
  const second = await resumed.rpc('share.list', { cursor: first.nextCursor });
  assert.deepEqual(second.shares.map((s) => s.id), history.slice(0, 6).reverse());
  assert.equal(second.hasMore, false);
  const recovered = await resumed.rpc('share.list', { requestId: 'request-0' });
  assert.equal(recovered.shares[0].id, history[0]);
  assert.deepEqual((await other.rpc('share.list', { requestId: 'request-0' })).shares, []);
});

test('share.list budgets cover tabs of one device and different identities on one IP', async (t) => {
  const { connect, advance } = await setup(t, { shareListBurst: 1, shareListRate: 60, shareListIpBurst: 2, shareListIpRate: 60 });
  const first = await (await connect({ source: '192.0.2.1' })).auth();
  const tab = await (await connect({ keys: first.keys, source: '192.0.2.2' })).auth();
  const other = await (await connect({ source: '192.0.2.1' })).auth();
  const third = await (await connect({ source: '192.0.2.1' })).auth();
  await first.rpc('share.list');
  await rejected(tab.rpc('share.list'), 'RATE_LIMIT');
  await other.rpc('share.list');
  await rejected(third.rpc('share.list'), 'RATE_LIMIT');
  advance(1000);
  await third.rpc('share.list'); // Rejection did not burn its own device token.
});

test('new registration budgets and hard capacity leave existing devices usable', async (t) => {
  const { app, connect, advance } = await setup(t, { maxDevices: 2, registerIpBurst: 1, registerGlobalBurst: 2, registerIpRate: 60 });
  const first = await (await connect({ source: '192.0.2.1' })).auth();
  const excess = await connect({ source: '192.0.2.1' });
  await rejected(excess.auth(), 'RATE_LIMIT');
  assert.equal(app.store.deviceCount, 1);
  await (await connect({ keys: first.keys, source: '192.0.2.1' })).auth();
  advance(1000);
  await excess.auth();
  const newDevice = await connect({ source: '192.0.2.2' });
  await rejected(newDevice.auth(), 'DEVICE_CAPACITY');
  await (await connect({ keys: first.keys, source: '192.0.2.2' })).auth();
  assert.equal(app.store.deviceCount, 2);
});

test('legacy SQLite migration is additive, cleanup is bounded and protected records survive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'suichuan-device-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'devices.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE pairs (a TEXT NOT NULL REFERENCES devices(id), b TEXT NOT NULL REFERENCES devices(id), last_used INTEGER NOT NULL, PRIMARY KEY(a,b), CHECK(a < b));
    INSERT INTO devices VALUES ('legacy', 'key', 'name', 1);`);
  old.close();
  const now = Date.now();
  let store = new Store(dbPath, now);
  assert.equal(store.db.prepare('PRAGMA table_info(devices)').all().length, 4);
  assert.equal(store.db.prepare('SELECT last_seen_at FROM device_activity').get().last_seen_at, now);
  for (let i = 0; i < 510; i += 1) {
    store.register(`d${i}`, 'key', 'name', now - 40 * 86400000);
  }
  assert.throws(() => store.touch(['d0', 'missing'], now));
  assert.equal(store.db.prepare("SELECT last_seen_at FROM device_activity WHERE device_id = 'd0'").get().last_seen_at, now - 40 * 86400000);
  store.pair('d0', 'd1', now);
  store.touch(['d2'], now);
  assert.equal(store.cleanup(now - 30 * 86400000, new Set(['d3'])).removed, 499);
  assert.equal(store.deviceCount, 12);
  for (const id of ['d0', 'd1', 'd2', 'd3', 'legacy']) {
    assert.ok(store.device(id));
  }
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM device_activity').get().n, store.deviceCount);
  store.close();
  // The previous version still uses a positional four-column INSERT OR IGNORE.
  const rollback = new DatabaseSync(dbPath);
  rollback.prepare('INSERT OR IGNORE INTO devices VALUES (?, ?, ?, ?)').run('d3', 'key', 'name', now);
  rollback.close();
  store = new Store(dbPath, now);
  assert.equal(store.cleanup(now - 30 * 86400000, new Set()).removed, 7);
  assert.ok(store.device('d3'));
  assert.equal(store.deviceCount, 5);
  store.close();
});

test('cleanup opt-in protects online, paired and reconnecting identities', async (t) => {
  const { app, connect, advance, settle } = await setup(t, { deviceCleanupEnabled: true, deviceRetention: 1000 });
  const online = await (await connect()).auth();
  const left = await (await connect()).auth();
  const right = await (await connect()).auth();
  const reconnecting = await (await connect()).auth();
  const stale = await (await connect()).auth();
  await pair(left, right);
  await Promise.all([left.close(), right.close(), stale.close()]);
  await settle();
  advance(60001);
  await reconnecting.close();
  await settle();
  app.sweep();
  assert.equal(app.store.device(stale.id), undefined);
  for (const client of [online, left, right, reconnecting]) {
    assert.ok(app.store.device(client.id));
  }
  const touch = app.store.touch.bind(app.store);
  const cleanup = app.store.cleanup.bind(app.store);
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  app.store.touch = () => { throw new Error('simulated busy database'); };
  let cleanups = 0;
  app.store.cleanup = (...args) => { cleanups += 1; return cleanup(...args); };
  advance(300001);
  assert.doesNotThrow(() => app.sweep());
  assert.equal(cleanups, 0);
  assert.equal(errors.length, 1);
  app.store.touch = touch;
  advance(300001);
  app.sweep();
  assert.equal(cleanups, 1);
  app.store.cleanup = () => { throw new Error('simulated busy database'); };
  advance(60001);
  assert.doesNotThrow(() => app.sweep());
  assert.equal(errors.length, 2);
  assert.deepEqual((await online.rpc('peers.list')).peers, []);
});

test('TURN credentials reuse a bounded identity budget and charge duplicate keys atomically', () => {
  let time = 1000000;
  const budgets = new TokenBuckets(() => time);
  const budget = { key: 'same', perMinute: 60, burst: 2 };
  assert.equal(budgets.take([budget, budget]), 0);
  assert.equal(budgets.take([budget]), 1000);
  const config = { ...loadConfig({}), ...turnConfig, turnBurst: 3, turnRate: 1 };
  const issuer = turnCredentials(config, () => time, (wait) => Object.assign(new Error('limited'), { wait }));
  const task = (guest) => ({ from: 'device', to: guest, sender: { source: '192.0.2.1' }, receiver: { source: '192.0.2.2' }, shareId: 'share' });
  const first = issuer.prepare(task('guest1'));
  assert.deepEqual(issuer.prepare(task('guest1')), first);
  assert.equal(issuer.prepare(task('guest2'))[0][0].username, first[0][0].username);
  assert.throws(() => issuer.prepare(task('guest3')), /limited/);
  assert.deepEqual(issuer.prepare({ ...task('guest3'), directOnly: true }), [[], []]);
  time += 901000;
  const renewed = issuer.prepare(task('guest1'));
  assert.notEqual(renewed[0][0].username, first[0][0].username);
});

test('TURN rejection creates neither an offer nor a half-registered transfer', async (t) => {
  const { connect } = await setup(t, { ...turnConfig, turnBurst: 2, turnRate: 1 });
  const sender = await (await connect()).auth();
  const share = await sender.rpc('share.create', { mode: 'multiple', shareProtocol: 2, minutes: 10, files: [metadata] });
  const first = await (await connect()).guest();
  const second = await (await connect()).guest();
  const claim1 = await first.rpc('share.claim', { token: share.token });
  const claim2 = await second.rpc('share.claim', { token: share.token });
  await sender.rpc('share.file.start', { id: share.id, claimId: claim1.myClaim.id, index: 0 });
  await rejected(sender.rpc('share.file.start', { id: share.id, claimId: claim2.myClaim.id, index: 0 }), 'RATE_LIMIT');
  assert.equal(second.events.some((event) => event.type === 'transfer.offer'), false);
  await sender.rpc('share.cancel', { id: share.id });
  const next = await sender.rpc('share.create', { minutes: 10, files: [{ ...metadata, size: 51 * 1024 * 1024 }] });
  await second.rpc('share.claim', { token: next.token });
  const direct = await sender.rpc('share.file.start', { id: next.id, index: 0 });
  assert.deepEqual(direct.iceServers, []);
});

test('the default 128-pending pool remains accessible from a new source under concentrated occupancy', async (t) => {
  const { connect, denied, advance } = await setup(t);
  const clients = [];
  for (let ip = 1; ip <= 16; ip += 1) {
    for (let n = 0; n < 8; n += 1) {
      clients.push(await connect({ source: `192.0.2.${ip}` }));
    }
  }
  advance(2001);
  const closed = once(clients[0].ws, 'close');
  assert.equal(await denied('203.0.113.1'), 503);
  await closed;
  await (await connect({ source: '203.0.113.1' })).auth();
  assert.equal(await denied('192.0.2.1'), 429);
});

test('the default 256-guest pool reclaims a preview even before its configured deadline', async (t) => {
  const { connect, advance } = await setup(t, { guestPreviewTimeout: 3600000 });
  const sender = await (await connect({ source: '203.0.113.1' })).auth();
  const tab = await (await connect({ source: '203.0.113.1', keys: sender.keys })).auth();
  const shares = await Promise.all([sender, tab].map((s) => s.rpc('share.create', { minutes: 60, files: [metadata] })));
  const clients = [];
  for (let ip = 1; ip <= 4; ip += 1) {
    for (let n = 0; n < 64; n += 1) {
      if (n === 60) {
        advance(61000);
      }
      const guest = await (await connect({ source: `192.0.2.${ip}` })).guest();
      await guest.rpc('share.inspect', { token: shares[Math.floor((ip - 1) / 2)].token });
      clients.push(guest);
    }
  }
  advance(2001);
  const closed = once(clients[0].ws, 'close');
  await rejected((await connect({ source: '198.51.100.1' })).guest(), 'BUSY');
  await closed;
  await (await connect({ source: '198.51.100.1' })).guest();
});

test('JSON escaping cannot defeat the share.list byte cap or stall its cursor', async (t) => {
  const { connect, advance } = await setup(t);
  const sender = await (await connect()).auth();
  for (let i = 0; i < 50; i += 1) {
    advance(61000);
    const share = await sender.rpc('share.create', { minutes: 10, files: Array.from({ length: 10 }, () => ({ ...metadata, name: '\u0001'.repeat(255) })) });
    await sender.rpc('share.cancel', { id: share.id });
  }
  const first = await sender.rpc('share.list', { limit: 50 });
  assert.ok(first.shares.length > 0 && first.shares.length < 50);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 512 * 1024);
  const second = await sender.rpc('share.list', { limit: 50, cursor: first.nextCursor });
  assert.equal(first.shares.length + second.shares.length, 50);
  assert.equal(second.hasMore, false);
});

test('registration transaction failure and concurrent capacity checks leave no partial identity or lease', async (t) => {
  const { app, connect } = await setup(t, { maxDevices: 1, maxConnectionsPerDevice: 1 });
  const first = await connect();
  app.store.db.exec(`CREATE TRIGGER fail_activity BEFORE INSERT ON device_activity BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  await rejected(first.auth(), 'INVALID');
  assert.equal(app.store.deviceCount, 0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
  app.store.db.exec('DROP TRIGGER fail_activity');
  const second = await connect();
  const results = await Promise.allSettled([first.auth(), second.auth()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(app.store.deviceCount, 1);
  const winner = results[0].status === 'fulfilled' ? first : second;
  await winner.close();
  await (await connect({ keys: winner.keys })).auth();
});

test('TURN cache eviction never removes a participant being returned', () => {
  const config = { ...loadConfig({}), ...turnConfig, turnBurst: 100000, turnIpBurst: 100000, turnGlobalBurst: 100000 };
  const issuer = turnCredentials(config, () => 1000000, () => new Error('unexpected rate limit'));
  for (let i = 0; i < 4100; i += 1) {
    const values = issuer.prepare({ from: 'sender', to: `guest-${i}`, shareId: 'share', sender: { source: 'source' }, receiver: { source: 'source' } });
    assert.equal(values.length, 2);
    assert.ok(values.every((ice) => ice[0]?.credential));
  }
});
