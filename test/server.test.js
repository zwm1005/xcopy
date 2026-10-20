import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

const identity = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

class Client {
  constructor(ws, keys) {
    this.ws = ws;
    this.keys = keys;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.replyTo) {
        const waiter = this.pending.get(message.replyTo);
        this.pending.delete(message.replyTo);
        if (message.ok) {
          waiter.resolve(message.data);
        } else {
          waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        }
      } else {
        const index = this.waiters.findIndex((w) => w.type === message.type && w.predicate(message.data));
        if (index >= 0) {
          const waiter = this.waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(message.data);
        } else {
          this.events.push(message);
        }
      }
    });
  }

  rpc(type, data = {}) {
    const id = randomBytes(10).toString('hex');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, data }));
    });
  }

  event(type, predicate = () => true) {
    const index = this.events.findIndex((e) => e.type === type && predicate(e.data));
    if (index >= 0) {
      return Promise.resolve(this.events.splice(index, 1)[0].data);
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, timer: setTimeout(() => reject(new Error(`Missing ${type}`)), 3000) };
      this.waiters.push(waiter);
    });
  }

  async auth(name = '电脑', resumeSession) {
    const publicKey = this.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const result = await this.rpc('auth.begin', { publicKey, name });
    const signature = sign('sha256', Buffer.from(result.challenge), { key: this.keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    this.authResult = await this.rpc('auth.finish', { signature, resumeSession });
    this.id = this.authResult.device.id;
    return this.authResult;
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      await once(this.ws, 'close');
    }
  }
}

async function setup(t, overrides = {}) {
  const app = createApp({ port: 0, dbPath: ':memory:', ...overrides });
  const address = await app.listen();
  const clients = [];
  const connect = async (name, keys = identity(), authenticate = true, resumeSession) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: app.config.origin });
    await once(ws, 'open');
    const client = new Client(ws, keys);
    clients.push(client);
    if (authenticate) {
      await client.auth(name, resumeSession);
    }
    return client;
  };
  t.after(async () => {
    for (const c of clients) {
      await c.close();
    }
    await app.close();
  });
  return { app, connect, address };
}

async function pair(a, b) {
  const { code } = await a.rpc('pair.code');
  const { id } = await b.rpc('pair.join', { code });
  const request = await a.event('pair.request', (r) => r.id === id);
  assert.equal(request.fingerprint, b.id);
  await a.rpc('pair.respond', { id, allow: true });
  return code;
}

const metadata = { name: 'hello.txt', size: 5, kind: 'file', mime: 'text/plain' };
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);

async function guest(connect, resumeSession) {
  const client = await connect('访客', identity(), false);
  client.authResult = await client.rpc('guest.open', { resumeSession });
  return client;
}

test('share previews do not consume the link; concurrent claims have one winner and no device pairing', async (t) => {
  const { connect, app } = await setup(t);
  const sender = await connect('分享者');
  const s = await sender.rpc('share.create', { files: [metadata, { ...metadata, name: '空文件', size: 0 }], minutes: 10 });
  const [a, b] = await Promise.all([guest(connect), guest(connect)]);
  const view = await a.rpc('share.inspect', { token: s.token });
  assert.equal(view.status, 'ready');
  assert.equal(view.token, undefined);
  assert.equal((await b.rpc('share.inspect', { token: s.token })).status, 'ready');
  await rejected(a.rpc('pair.code'), 'UNAUTHORIZED');
  await rejected(a.rpc('transfer.start', { peerId: sender.id, metadata }), 'UNAUTHORIZED');
  await rejected(a.rpc('share.list'), 'UNAUTHORIZED');
  const claims = await Promise.allSettled([a.rpc('share.claim', { token: s.token, name: 'iOS-A3X8' }), b.rpc('share.claim', { token: s.token, name: 'Android-K7M2' })]);
  assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(claims.find((r) => r.status === 'rejected').reason.code, 'SHARE_CLAIMED');
  const winner = claims[0].status === 'fulfilled' ? a : b;
  const loser = winner === a ? b : a;
  const recipientName = winner === a ? 'iOS-A3X8' : 'Android-K7M2';
  assert.equal(claims.find((r) => r.status === 'fulfilled').value.recipientName, recipientName);
  assert.equal((await sender.rpc('share.list')).shares[0].recipientName, recipientName);
  assert.equal((await loser.rpc('share.inspect', { token: s.token })).recipientName, undefined);
  const hidden = await loser.event('share.state', (state) => state.status === 'claimed');
  assert.equal(hidden.recipientName, undefined);
  const tasks = [];
  for (const index of [0, 1]) {
    const task = await sender.rpc('share.file.start', { id: s.id, index });
    tasks.push(task);
    await rejected(loser.rpc('transfer.accept', { id: task.id }), 'NOT_FOUND');
    await winner.rpc('transfer.accept', { id: task.id });
    await rejected(sender.rpc('transfer.end', { id: task.id, status: 'completed' }), 'FORBIDDEN');
  }
  await winner.rpc('transfer.end', { id: tasks[0].id, status: 'completed' });
  assert.equal((await winner.rpc('share.inspect', { token: s.token })).status, 'claimed');
  await winner.rpc('transfer.end', { id: tasks[1].id, status: 'completed' });
  assert.equal((await winner.rpc('share.inspect', { token: s.token })).status, 'completed');
  assert.equal((await sender.rpc('share.list')).shares[0].recipientName, recipientName);
  assert.equal((await loser.rpc('share.inspect', { token: s.token })).recipientName, undefined);
  await rejected(winner.rpc('share.claim', { token: s.token }), 'SHARE_CLOSED');
  await rejected(loser.rpc('share.claim', { token: s.token }), 'SHARE_CLOSED');
  assert.equal(app.store.peers(sender.id).length, 0);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM devices').get().n, 1);
});

test('recipient names are validated before claiming, frozen on retries and retained on guest reconnect', async (t) => {
  const { connect } = await setup(t);
  const sender = await connect('分享者');
  const s = await sender.rpc('share.create', { files: [metadata], minutes: 10 });
  const a = await connect('访客', identity(), false);
  for (const name of ['', ' ', 'a'.repeat(25), '设备\n换行', null]) {
    await rejected(a.rpc('guest.open', { name }), 'INVALID_NAME');
  }
  const opened = await a.rpc('guest.open', { name: 'iOS-A3X8' });
  assert.equal(opened.device.name, 'iOS-A3X8');
  for (const name of ['', ' ', 'a'.repeat(25), '设备\n换行', null]) {
    await rejected(a.rpc('share.claim', { token: s.token, name }), 'INVALID_NAME');
    assert.equal((await a.rpc('share.inspect', { token: s.token })).status, 'ready');
  }
  const claimed = await a.rpc('share.claim', { token: s.token, name: '  文铭的 iPhone  ' });
  assert.equal(claimed.recipientName, '文铭的 iPhone');
  assert.equal((await a.rpc('share.claim', { token: s.token, name: '新的名字' })).recipientName, '文铭的 iPhone');
  await a.close();
  const resumed = await guest(connect, opened.sessionId);
  assert.equal(resumed.authResult.device.name, '文铭的 iPhone');
  assert.equal((await resumed.rpc('share.inspect', { token: s.token })).recipientName, '文铭的 iPhone');
  await sender.rpc('share.cancel', { id: s.id });
  assert.equal((await sender.rpc('share.list')).shares[0].recipientName, '文铭的 iPhone');
});

test('share creation retries recover the same link without reserving a second share', async (t) => {
  const { connect } = await setup(t);
  const sender = await connect('分享者');
  const input = { requestId: 'request-123', files: [metadata], minutes: 10 };
  const first = await sender.rpc('share.create', input);
  const again = await sender.rpc('share.create', input);
  assert.equal(again.token, first.token);
  assert.equal((await sender.rpc('share.list')).shares.length, 1);
});

test('direct files have no fixed size cap; TURN credentials and relay candidates are excluded above the relay boundary', async (t) => {
  const { connect } = await setup(t, { stunUrls: ['stun:stun.example:3478'], turnUrls: ['turn:turn.example:3478'], turnSecret: 'a'.repeat(32) });
  const a = await connect('发送者');
  const b = await connect('接收者');
  await pair(a, b);
  const relay = 'candidate:1 1 udp 1 192.0.2.1 50000 typ relay raddr 0.0.0.0 rport 0';
  const host = 'candidate:2 1 udp 2 192.0.2.2 50001 typ host';
  for (const size of [50 * 1048576, 50 * 1048576 + 1, 5 * 1024 ** 3]) {
    const directOnly = size > 50 * 1048576;
    const started = await a.rpc('transfer.start', { peerId: b.id, metadata: { ...metadata, size } });
    const offer = await b.event('transfer.offer', (value) => value.id === started.id);
    for (const value of [started, offer]) {
      assert.equal(value.directOnly, directOnly);
      assert.equal(value.maxRelayFileBytes, 50 * 1048576);
      assert.equal(value.iceServers.some((server) => server.urls.some((url) => url.startsWith('turn:'))), !directOnly);
    }
    await b.rpc('transfer.accept', { id: started.id });
    await a.rpc('signal', { id: started.id, signal: { description: { type: 'offer', sdp: `v=0\r\na=${relay}\r\na=${host}\r\n` } } });
    const signalled = await b.event('signal', (value) => value.id === started.id);
    assert.equal(signalled.signal.description.sdp.includes('typ relay'), !directOnly);
    await a.rpc('signal', { id: started.id, signal: { candidate: { candidate: relay } } });
    await a.rpc('signal', { id: started.id, signal: { candidate: { candidate: host } } });
    const candidate = await b.event('signal', (value) => value.id === started.id);
    assert.equal(candidate.signal.candidate.candidate, directOnly ? host : relay);
    await a.rpc('transfer.end', { id: started.id, status: 'failed', reasonCode: 'RELAY_SIZE_LIMIT' });
    const state = await b.event('transfer.state', (value) => value.id === started.id);
    assert.equal(state.reason.includes('50 MB'), directOnly);
  }
  const share = await a.rpc('share.create', { files: [{ ...metadata, size: 5 * 1024 ** 3 }, ...Array(4).fill({ ...metadata, size: 50 * 1048576 })], minutes: 10 });
  assert.equal(share.totalBytes, 5 * 1024 ** 3 + 200 * 1048576);
  const recipient = await guest(connect);
  await recipient.rpc('share.claim', { token: share.token });
  const large = await a.rpc('share.file.start', { id: share.id, index: 0 });
  assert.equal(large.directOnly, true);
  assert.equal(large.iceServers.length, 1);
  await a.rpc('transfer.end', { id: large.id, status: 'failed', reasonCode: 'RELAY_SIZE_LIMIT' });
  assert.match((await recipient.rpc('share.inspect', { token: share.token })).myClaim.reason, /50 MB/);
  const small = await a.rpc('share.file.start', { id: share.id, index: 1 });
  assert.equal(small.directOnly, false);
  assert.equal(small.iceServers.length, 2);
});

test('share cancellation, expiry and metadata limits are enforced on the server', async (t) => {
  let time = Date.now();
  const { connect, app } = await setup(t, { now: () => time });
  const sender = await connect('分享者');
  const outsider = await connect('其他设备');
  const a = await guest(connect);
  for (const files of [[], Array(11).fill(metadata), [{ ...metadata, size: -1 }], [{ ...metadata, size: Number.MAX_SAFE_INTEGER + 1 }], [{ ...metadata, size: 1.5 }]]) {
    await rejected(sender.rpc('share.create', { files, minutes: 10 }), 'SIZE_LIMIT');
  }
  await rejected(sender.rpc('share.create', { files: [metadata], minutes: 0 }), 'INVALID');
  const s = await sender.rpc('share.create', { files: [metadata], minutes: 10 });
  await rejected(outsider.rpc('share.cancel', { id: s.id }), 'NOT_FOUND');
  await rejected(a.rpc('share.cancel', { id: s.id }), 'NOT_FOUND');
  await rejected(sender.rpc('share.create', { files: [metadata], minutes: 10 }), 'BUSY');
  time += 600001;
  await rejected(a.rpc('share.claim', { token: s.token }), 'SHARE_CLOSED');
  assert.equal((await a.rpc('share.inspect', { token: s.token })).status, 'expired');
  const next = await sender.rpc('share.create', { files: [metadata], minutes: 30 });
  await a.rpc('share.claim', { token: next.token });
  const task = await sender.rpc('share.file.start', { id: next.id, index: 0 });
  await a.rpc('transfer.accept', { id: task.id });
  await sender.rpc('share.cancel', { id: next.id });
  await rejected(a.rpc('transfer.end', { id: task.id, status: 'completed' }), 'TRANSFER_ENDED');
  assert.equal((await a.rpc('share.inspect', { token: next.token })).status, 'cancelled');
  app.sweep();
});

test('single and multiple shares accept ten files and reject eleven', async (t) => {
  const { connect } = await setup(t);
  const sender = await connect('十文件分享');
  assert.equal((await sender.rpc('share.list')).maxShareFiles, 10);
  for (const mode of ['single', 'multiple']) {
    const options = { mode, minutes: 10, shareProtocol: 2 };
    await assert.rejects(sender.rpc('share.create', { ...options, files: Array(11).fill(metadata) }), (error) => {
      assert.equal(error.code, 'SIZE_LIMIT');
      assert.equal(error.message, '一次分享支持 1–10 个文件');
      return true;
    });
    const share = await sender.rpc('share.create', { ...options, files: Array(10).fill(metadata) });
    assert.equal(share.files.length, 10);
    await sender.rpc('share.cancel', { id: share.id });
  }
});

test('share retry retains completed files and the original claimant; guests resume without device credentials', async (t) => {
  let time = Date.now();
  const { connect, app } = await setup(t, { now: () => time });
  const sender = await connect('分享者');
  const s = await sender.rpc('share.create', { files: [metadata, metadata], minutes: 10 });
  const a = await guest(connect);
  await a.rpc('share.claim', { token: s.token });
  const first = await sender.rpc('share.file.start', { id: s.id, index: 0 });
  await a.rpc('transfer.accept', { id: first.id });
  await a.rpc('transfer.end', { id: first.id, status: 'completed' });
  const second = await sender.rpc('share.file.start', { id: s.id, index: 1 });
  await a.rpc('transfer.accept', { id: second.id });
  await a.rpc('transfer.end', { id: second.id, status: 'failed' });
  time += 31000; app.sweep();
  await rejected(sender.rpc('share.file.start', { id: s.id, index: 0 }), 'BUSY');
  const stranger = await guest(connect);
  await rejected(stranger.rpc('share.retry', { id: s.id }), 'NOT_FOUND');
  await a.close();
  const resumed = await guest(connect, a.authResult.sessionId);
  assert.equal(resumed.authResult.resumed, true);
  assert.equal((await resumed.rpc('share.inspect', { token: s.token })).mine, true);
  await resumed.rpc('share.retry', { id: s.id });
  const retry = await sender.rpc('share.file.start', { id: s.id, index: 1 });
  await resumed.rpc('transfer.accept', { id: retry.id });
  await resumed.rpc('transfer.end', { id: retry.id, status: 'completed' });
  assert.equal((await resumed.rpc('share.inspect', { token: s.token })).status, 'completed');
});

test('sender resumption belongs to its page; closing either endpoint never releases the link', async (t) => {
  let time = Date.now();
  const { connect, app } = await setup(t, { now: () => time });
  const sender = await connect('分享者');
  const s = await sender.rpc('share.create', { files: [metadata], minutes: 10 });
  const a = await guest(connect);
  await sender.close();
  assert.equal((await a.rpc('share.inspect', { token: s.token })).senderOnline, false);
  const otherTab = await connect('同一设备其他标签页', sender.keys);
  await rejected(otherTab.rpc('share.cancel', { id: s.id }), 'NOT_FOUND');
  const resumed = await connect('分享者', sender.keys, true, sender.authResult.sessionId);
  assert.equal((await a.rpc('share.inspect', { token: s.token })).senderOnline, true);
  await a.rpc('share.claim', { token: s.token });
  await a.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  time += 15001; app.sweep();
  const b = await guest(connect);
  assert.equal((await b.rpc('share.inspect', { token: s.token })).status, 'unavailable');
  await rejected(b.rpc('share.claim', { token: s.token }), 'SHARE_CLOSED');
  const next = await resumed.rpc('share.create', { files: [metadata], minutes: 10 });
  await resumed.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  time += 15001; app.sweep();
  assert.equal((await b.rpc('share.inspect', { token: next.token })).status, 'unavailable');
});

test('malformed HTTP request targets return 400 without stopping the service', async (t) => {
  const { address } = await setup(t);
  for (const path of ['//[/', 'http://[', '//example.com/']) {
    const status = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
  }
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200);
});

test('proof of private key is required; challenges are single-use; unauthenticated operations fail', async (t) => {
  const { connect } = await setup(t);
  const a = await connect('A', identity(), false);
  await rejected(a.rpc('peers.list'), 'UNAUTHORIZED');
  const publicKey = a.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const { challenge } = await a.rpc('auth.begin', { publicKey, name: 'A' });
  const wrong = sign('sha256', Buffer.from(challenge), { key: identity().privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  await rejected(a.rpc('auth.finish', { signature: wrong }), 'AUTH_FAILED');
  const signature = sign('sha256', Buffer.from(challenge), { key: a.keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  await rejected(a.rpc('auth.finish', { signature }), 'AUTH_FAILED');
  await a.auth('A');
  const b = await connect('B', a.keys);
  assert.equal(a.id, b.id);
  assert.equal(b.authResult.device.name, 'A');
});

test('reception status identifies the actual receiving tab and follows its disconnection', async (t) => {
  const { connect } = await setup(t);
  const sender = await connect('发送端');
  const first = await connect('接收端');
  await pair(sender, first);
  assert.deepEqual(first.authResult.reception, { here: true, pages: 1 });
  const second = await connect('接收端', first.keys);
  assert.deepEqual(second.authResult.reception, { here: false, pages: 2 });
  const updated = await first.event('peers', (event) => event.reception.pages === 2);
  assert.deepEqual(updated.reception, { here: true, pages: 2 });
  const initial = await sender.rpc('transfer.start', { peerId: first.id, metadata });
  await first.event('transfer.offer', (offer) => offer.id === initial.id);
  await rejected(second.rpc('transfer.accept', { id: initial.id }), 'NOT_FOUND');
  await sender.rpc('transfer.end', { id: initial.id, status: 'cancelled' });
  await first.close();
  const takeover = await second.event('peers', (event) => event.reception.here && event.reception.pages === 1);
  assert.deepEqual(takeover.reception, { here: true, pages: 1 });
  const next = await sender.rpc('transfer.start', { peerId: second.id, metadata });
  await second.event('transfer.offer', (offer) => offer.id === next.id);
  await second.rpc('transfer.accept', { id: next.id });
  await sender.rpc('transfer.end', { id: next.id, status: 'cancelled' });
});

test('A–B and A–C never authorize B–C; approval binds the specific requester and consumes code', async (t) => {
  const { connect } = await setup(t);
  const [a, b, c] = await Promise.all([connect('A'), connect('B'), connect('C')]);
  const code = await pair(a, b);
  await rejected(c.rpc('pair.join', { code }), 'INVALID_CODE');
  await pair(a, c);
  assert.deepEqual(new Set((await a.rpc('peers.list')).peers.map((p) => p.id)), new Set([b.id, c.id]));
  assert.deepEqual((await b.rpc('peers.list')).peers.map((p) => p.id), [a.id]);
  await rejected(b.rpc('transfer.start', { peerId: c.id, metadata }), 'NOT_PAIRED');
  await rejected(b.rpc('pair.forget', { peerId: c.id }), 'NOT_FOUND');
});

test('wrong and expired codes give the same response; changing a code cancels pending approvals', async (t) => {
  let time = Date.now();
  const { app, connect } = await setup(t, { now: () => time, codeTtl: 1000 });
  const a = await connect('A');
  const b = await connect('B');
  const { code } = await a.rpc('pair.code');
  const { id } = await b.rpc('pair.join', { code });
  await a.rpc('pair.code');
  await rejected(a.rpc('pair.respond', { id, allow: true }), 'NOT_FOUND');
  const fresh = await a.rpc('pair.code');
  time += 2000;
  app.sweep();
  await rejected(b.rpc('pair.join', { code: fresh.code }), 'INVALID_CODE');
  await rejected(b.rpc('pair.join', { code: 'wrong' }), 'INVALID_CODE');
});

test('pair guessing is rate-limited by source and globally', async (t) => {
  const { connect } = await setup(t, { joinLimit: 1 });
  const a = await connect('A');
  await rejected(a.rpc('pair.join', { code: '00000000' }), 'INVALID_CODE');
  await rejected(a.rpc('pair.join', { code: '00000000' }), 'RATE_LIMIT');
});

test('in-flight tasks block forgetting in every tab; only recipient may acknowledge completion', async (t) => {
  const { connect } = await setup(t);
  const a = await connect('A');
  const b = await connect('B');
  const a2 = await connect('A again', a.keys);
  await pair(a, b);
  const { id } = await a.rpc('transfer.start', { peerId: b.id, metadata });
  const offer = await b.event('transfer.offer');
  assert.equal(offer.id, id);
  await rejected(a2.rpc('pair.forget', { peerId: b.id }), 'BUSY');
  await rejected(b.rpc('pair.forget', { peerId: a.id }), 'BUSY');
  await rejected(a.rpc('transfer.end', { id, status: 'completed' }), 'FORBIDDEN');
  await b.rpc('transfer.accept', { id });
  await rejected(a2.rpc('transfer.end', { id, status: 'completed' }), 'NOT_FOUND');
  await b.rpc('transfer.end', { id, status: 'completed' });
  await a2.rpc('pair.forget', { peerId: b.id });
  assert.equal((await b.rpc('peers.list')).peers.length, 0);
  await rejected(b.rpc('transfer.start', { peerId: a.id, metadata }), 'NOT_PAIRED');
});

test('cancel, timeout and simultaneous start/forget release or serialize the same pair', async (t) => {
  let time = Date.now();
  const { app, connect } = await setup(t, { now: () => time });
  const a = await connect('A');
  const b = await connect('B');
  await pair(a, b);
  const first = await a.rpc('transfer.start', { peerId: b.id, metadata });
  await a.rpc('transfer.end', { id: first.id, status: 'cancelled' });
  const second = await a.rpc('transfer.start', { peerId: b.id, metadata });
  time += 100000;
  app.sweep();
  assert.equal((await a.event('transfer.state', (e) => e.id === second.id)).status, 'failed');
  const race = await Promise.allSettled([a.rpc('transfer.start', { peerId: b.id, metadata }), b.rpc('pair.forget', { peerId: a.id })]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
});

test('pairs survive ten years without use; forgotten pairs never return and other edges stay usable', async (t) => {
  let time = Date.now();
  const { app, connect } = await setup(t, { now: () => time });
  const [a, b, c] = await Promise.all([connect('A'), connect('B'), connect('C')]);
  await pair(a, b);
  await pair(a, c);
  await a.rpc('pair.forget', { peerId: b.id });
  assert.deepEqual((await a.rpc('peers.list')).peers.map((p) => p.id), [c.id]);
  await b.close();
  await c.close();
  await rejected(a.rpc('transfer.start', { peerId: c.id, metadata }), 'OFFLINE');
  time += 3650 * 86400000;
  app.sweep();
  const offlinePeers = (await a.rpc('peers.list')).peers;
  assert.deepEqual(offlinePeers.map((p) => p.id), [c.id]);
  assert.equal(offlinePeers[0].online, false);
  await rejected(a.rpc('transfer.start', { peerId: c.id, metadata }), 'OFFLINE');
  const c2 = await connect('C', c.keys);
  assert.deepEqual(c2.authResult.peers.map((p) => p.id), [a.id]);
  const transfer = await c2.rpc('transfer.start', { peerId: a.id, metadata });
  await a.rpc('transfer.accept', { id: transfer.id });
  await c2.rpc('signal', { id: transfer.id, signal: { description: { type: 'offer', sdp: 'test-offer' } } });
  await a.rpc('transfer.end', { id: transfer.id, status: 'completed' });
  const b2 = await connect('B', b.keys);
  assert.equal(b2.authResult.peers.length, 0);
  await rejected(b2.rpc('transfer.start', { peerId: a.id, metadata }), 'NOT_PAIRED');
  await a.rpc('pair.forget', { peerId: c2.id });
  assert.equal((await c2.rpc('peers.list')).peers.length, 0);
  await rejected(c2.rpc('transfer.start', { peerId: a.id, metadata }), 'NOT_PAIRED');
});

test('reconnect can reattach the current tab within grace period; TURN credentials are temporary HMAC', async (t) => {
  const secret = 'test-secret-at-least-thirty-two-characters';
  const { connect } = await setup(t, { turnUrls: ['turn:localhost:3478'], turnSecret: secret });
  const a = await connect('A');
  const b = await connect('B');
  await pair(a, b);
  const task = await a.rpc('transfer.start', { peerId: b.id, metadata });
  const ice = task.iceServers[0];
  assert.equal(ice.credential, createHmac('sha1', secret).update(ice.username).digest('base64'));
  const sessionId = a.authResult.sessionId;
  await a.close();
  const a2 = await connect('A', a.keys, true, sessionId);
  assert.equal(a2.authResult.resumed, true);
  await a2.rpc('transfer.end', { id: task.id, status: 'cancelled' });
  await a2.rpc('pair.forget', { peerId: b.id });
});

test('a new server instance reads persisted relationships and names; limits and private files remain protected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'suichuan-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'data.sqlite');
  const first = await setup(t, { dbPath });
  const a = await first.connect('A');
  const b = await first.connect('B');
  await pair(a, b);
  await a.rpc('device.rename', { name: '办公电脑' });
  // A separate server instance opening the same WAL database verifies persistence.
  const second = await setup(t, { dbPath, now: () => Date.now() + 3650 * 86400000 });
  const a2 = await second.connect('ignored', a.keys);
  const b2 = await second.connect('ignored', b.keys);
  assert.equal(a2.authResult.device.name, '办公电脑');
  assert.equal((await a2.rpc('peers.list')).peers[0].id, b2.id);
  await rejected(a2.rpc('transfer.start', { peerId: b2.id, metadata: { ...metadata, size: -1 } }), 'SIZE_LIMIT');
  const response = await fetch(`http://127.0.0.1:${second.address.port}/data/suichuan.sqlite`);
  assert.equal(response.status, 404);
});

async function multipleGuest(connect) {
  const client = await connect('访客', identity(), false);
  client.authResult = await client.rpc('guest.open', { shareProtocol: 2 });
  return client;
}
const multipleInput = { files: [metadata], minutes: 10, mode: 'multiple', shareProtocol: 2 };
async function completeClaim(sender, receiver, share, claimId, index = 0) {
  const task = await sender.rpc('share.file.start', { id: share.id, claimId, index });
  await receiver.rpc('transfer.accept', { id: task.id });
  await receiver.rpc('transfer.end', { id: task.id, status: 'completed' });
  return task;
}

test('multiple shares isolate four concurrent claims, release queued slots and permit more than ten completed claims', async (t) => {
  const { connect } = await setup(t);
  const sender = await connect('多人发送');
  const s = await sender.rpc('share.create', multipleInput);
  const visitors = await Promise.all(Array.from({ length: 4 }, () => multipleGuest(connect)));
  const states = await Promise.all(visitors.map((c, i) => c.rpc('share.claim', { token: s.token, name: `接收 ${i}` })));
  assert.equal(states.filter((r) => r.myClaim.state === 'transferring').length, 3);
  assert.equal(states[3].myClaim.state, 'queued');
  assert.equal(states[3].myClaim.position, 1);
  assert.equal(states[0].claims, undefined);
  assert.equal((await visitors[0].rpc('share.claim', { token: s.token })).myClaim.id, states[0].myClaim.id);
  await rejected(visitors[1].rpc('share.retry', { id: s.id, claimId: states[0].myClaim.id }), 'NOT_FOUND');
  await rejected(sender.rpc('share.file.start', { id: s.id, claimId: states[3].myClaim.id, index: 0 }), 'BUSY');
  await completeClaim(sender, visitors[0], s, states[0].myClaim.id);
  assert.equal((await visitors[3].rpc('share.inspect', { token: s.token })).myClaim.state, 'transferring');
  assert.equal((await visitors[0].rpc('share.claim', { token: s.token })).myClaim.state, 'completed');
  for (let i = 1; i < visitors.length; i += 1) {
    await completeClaim(sender, visitors[i], s, states[i].myClaim.id);
  }
  for (let i = 4; i < 12; i += 1) {
    const receiver = await multipleGuest(connect);
    const claimed = await receiver.rpc('share.claim', { token: s.token });
    await completeClaim(sender, receiver, s, claimed.myClaim.id);
  }
  const result = (await sender.rpc('share.list')).shares[0];
  assert.equal(result.counts.completed, 12);
  assert.equal(result.accepting, true);
  assert.equal(result.status, 'ready');
  const observer = await multipleGuest(connect);
  const view = await observer.rpc('share.inspect', { token: s.token });
  assert.equal(view.claims, undefined);
  assert.equal(view.counts, undefined);
  assert.equal(view.recipientName, undefined);
  assert.equal(JSON.stringify(view).includes('接收 0'), false);
});

test('multiple expiry rejects new claims at the exact deadline while admitted and queued claims complete', async (t) => {
  let time = Date.now();
  const { connect } = await setup(t, { now: () => time, shareConcurrency: 1 });
  const sender = await connect('多人发送');
  const s = await sender.rpc('share.create', multipleInput);
  const [a, b, late] = await Promise.all(Array.from({ length: 3 }, () => multipleGuest(connect)));
  const ca = await a.rpc('share.claim', { token: s.token });
  const cb = await b.rpc('share.claim', { token: s.token });
  assert.equal(cb.myClaim.state, 'queued');
  time = s.expires;
  await rejected(late.rpc('share.claim', { token: s.token }), 'SHARE_CLOSED');
  assert.equal((await a.rpc('share.inspect', { token: s.token })).status, 'draining');
  await completeClaim(sender, a, s, ca.myClaim.id);
  await completeClaim(sender, b, s, cb.myClaim.id);
  const ended = (await sender.rpc('share.list')).shares[0];
  assert.equal(ended.status, 'expired');
  assert.equal(ended.counts.completed, 2);
  assert.equal((await b.rpc('share.inspect', { token: s.token })).myClaim.state, 'completed');
});

test('multiple retry, disconnection and stop affect only intended claims; already completed files cannot resend', async (t) => {
  let time = Date.now();
  const { connect, app } = await setup(t, { now: () => time });
  const sender = await connect('多人发送');
  const s = await sender.rpc('share.create', { ...multipleInput, files: [metadata, metadata] });
  const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => multipleGuest(connect)));
  const [ca, cb, cc] = await Promise.all([a, b, c].map((r) => r.rpc('share.claim', { token: s.token })));
  await completeClaim(sender, a, s, ca.myClaim.id);
  const broken = await sender.rpc('share.file.start', { id: s.id, claimId: ca.myClaim.id, index: 1 });
  const healthy = await sender.rpc('share.file.start', { id: s.id, claimId: cb.myClaim.id, index: 0 });
  await a.rpc('transfer.accept', { id: broken.id });
  await b.rpc('transfer.accept', { id: healthy.id });
  await a.rpc('transfer.end', { id: broken.id, status: 'failed' });
  await a.rpc('share.retry', { id: s.id, claimId: ca.myClaim.id });
  await rejected(sender.rpc('share.file.start', { id: s.id, claimId: ca.myClaim.id, index: 0 }), 'BUSY');
  await b.rpc('transfer.end', { id: healthy.id, status: 'completed' });
  await c.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  time += 15001;
  app.sweep();
  assert.equal((await sender.rpc('share.list')).shares[0].claims.find((claim) => claim.id === cc.myClaim.id).state, 'unavailable');
  await sender.rpc('share.stop', { id: s.id });
  const extra = await multipleGuest(connect);
  await rejected(extra.rpc('share.claim', { token: s.token }), 'SHARE_CLOSED');
  await completeClaim(sender, a, s, ca.myClaim.id, 1);
  await completeClaim(sender, b, s, cb.myClaim.id, 1);
  const ended = (await sender.rpc('share.list')).shares[0];
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.counts.completed, 2);
  assert.equal(ended.counts.failed, 1);
});

test('multiple queue capacity, recipient cancellation, compatibility and forced ending are enforced', async (t) => {
  const { connect } = await setup(t, { shareConcurrency: 1, shareQueueLimit: 1 });
  const sender = await connect('多人发送');
  await rejected(sender.rpc('share.create', { ...multipleInput, shareProtocol: undefined }), 'UPDATE_REQUIRED');
  const s = await sender.rpc('share.create', multipleInput);
  const old = await guest(connect);
  await rejected(old.rpc('share.inspect', { token: s.token }), 'UPDATE_REQUIRED');
  const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => multipleGuest(connect)));
  const ca = await a.rpc('share.claim', { token: s.token });
  const cb = await b.rpc('share.claim', { token: s.token });
  await rejected(c.rpc('share.claim', { token: s.token }), 'BUSY');
  await b.rpc('share.claim.cancel', { id: s.id, claimId: cb.myClaim.id });
  const cc = await c.rpc('share.claim', { token: s.token });
  assert.equal(cc.myClaim.state, 'queued');
  const task = await sender.rpc('share.file.start', { id: s.id, claimId: ca.myClaim.id, index: 0 });
  await a.rpc('transfer.accept', { id: task.id });
  await sender.rpc('share.cancel', { id: s.id });
  await rejected(a.rpc('transfer.end', { id: task.id, status: 'completed' }), 'TRANSFER_ENDED');
  assert.equal((await c.rpc('share.inspect', { token: s.token })).myClaim.state, 'cancelled');
});

test('multiple history remains bounded and a pruned recipient retains an idempotent private receipt', async (t) => {
  let time = Date.now();
  const { connect } = await setup(t, { now: () => time, connectLimit: 1000 });
  const sender = await connect('多人发送');
  const s = await sender.rpc('share.create', { ...multipleInput, minutes: 60 });
  let first;
  for (let i = 0; i < 55; i += 1) {
    time += 1500;
    const receiver = await multipleGuest(connect);
    const claim = await receiver.rpc('share.claim', { token: s.token });
    await completeClaim(sender, receiver, s, claim.myClaim.id);
    first ||= receiver;
  }
  const record = (await sender.rpc('share.list')).shares[0];
  assert.equal(record.counts.completed, 55);
  assert.equal(record.claims.length, 50);
  assert.equal((await first.rpc('share.claim', { token: s.token })).myClaim.state, 'completed');
  assert.equal((await sender.rpc('share.list')).shares[0].counts.completed, 55);
});

test('static and shared-secret credentials use the same authorized ICE path for devices and guests', async (t) => {
  for (const mode of ['static', 'shared-secret']) {
    await t.test(mode, async (t) => {
      const time = 1700000000000;
      const secret = 's'.repeat(32);
      const { connect } = await setup(t, { now: () => time, turnAuthMode: mode, turnSecret: secret, turnUsername: 'local-test-user', turnPassword: 'local-test-password', turnCredentialTtlSeconds: 7200, stunUrls: ['stun:stun.example:3478'], turnUrls: ['turns:relay.example:5349?transport=tcp'], forceRelay: true });
      const a = await connect('A');
      const b = await connect('B');
      await pair(a, b);
      const started = await a.rpc('transfer.start', { peerId: b.id, metadata });
      const offer = await b.event('transfer.offer');
      const share = await a.rpc('share.create', { files: [metadata], minutes: 10 });
      const recipient = await guest(connect);
      await recipient.rpc('share.claim', { token: share.token });
      const sharing = await a.rpc('share.file.start', { id: share.id, index: 0 });
      const guestOffer = await recipient.event('transfer.offer');
      for (const result of [started, offer, sharing, guestOffer]) {
        assert.equal(result.forceRelay, true);
        assert.deepEqual(result.iceServers[0].urls, ['stun:stun.example:3478']);
        const turn = result.iceServers[1];
        assert.deepEqual(turn.urls, ['turns:relay.example:5349?transport=tcp']);
        if (mode === 'static') {
          assert.equal(turn.username, 'local-test-user');
          assert.equal(turn.credential, 'local-test-password');
        } else {
          assert.equal(Number(turn.username.split(':')[0]), Math.floor(time / 1000) + 7200);
          assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
        }
      }
    });
  }
});
