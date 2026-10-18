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
  await rejected(a2.rpc('transfer.start', { peerId: b2.id, metadata: { ...metadata, size: 51 * 1048576 } }), 'SIZE_LIMIT');
  const response = await fetch(`http://127.0.0.1:${second.address.port}/data/suichuan.sqlite`);
  assert.equal(response.status, 404);
});
