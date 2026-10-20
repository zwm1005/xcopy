import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp } from '../../server/index.js';

export const metadata = { kind: 'file', name: 'test.txt', mime: 'text/plain', size: 1 };
export const identity = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

export async function setup(t, overrides = {}) {
  let time = Date.now();
  const app = createApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', trustProxy: true, now: () => time, ...overrides });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const clients = [];
  let sourceId = 1;
  async function connect({ source = `192.0.2.${sourceId++}`, keys = identity() } = {}) {
    const ws = new WebSocket(url, { origin: app.config.origin, headers: { 'X-Forwarded-For': source } });
    ws.on('error', () => {});
    await once(ws, 'open');
    const pending = new Map();
    const client = {
      ws, keys, events: [],
      rpc(type, data = {}) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${type}`)); }, 3000);
          pending.set(id, { resolve, reject, timer });
          ws.send(JSON.stringify({ id, type, data }));
        });
      },
      async auth(name = '设备', resumeSession) {
        const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        const { challenge } = await client.rpc('auth.begin', { publicKey, name });
        const signature = sign('sha256', Buffer.from(challenge), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
        client.authResult = await client.rpc('auth.finish', { signature, resumeSession });
        client.id = client.authResult.device.id;
        return client;
      },
      async guest() {
        client.authResult = await client.rpc('guest.open', { shareProtocol: 2 });
        return client;
      },
      async close() {
        if (ws.readyState !== WebSocket.CLOSED) {
          const closed = once(ws, 'close');
          ws.close();
          await closed;
        }
      }
    };
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      const waiter = pending.get(message.replyTo);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.replyTo);
        if (message.ok) {
          waiter.resolve(message.data);
        } else {
          waiter.reject(Object.assign(new Error(message.error.message), message.error));
        }
      } else {
        client.events.push(message);
      }
    });
    ws.on('close', () => {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error('Connection closed'));
      }
      pending.clear();
    });
    clients.push(client);
    return client;
  }
  async function denied(source) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin: app.config.origin, headers: { 'X-Forwarded-For': source } });
      ws.on('error', () => {});
      ws.on('open', () => { ws.terminate(); reject(new Error('Expected connection rejection')); });
      ws.on('unexpected-response', (req, res) => {
        res.resume();
        req.destroy();
        resolve(res.statusCode);
      });
    });
  }
  t.after(async () => {
    for (const client of clients) {
      await client.close();
    }
    await app.close();
  });
  return { app, connect, denied, address, advance: (ms) => { time += ms; }, settle: () => delay(app.config.publishInterval + 30) };
}

export async function pair(a, b) {
  const { code } = await a.rpc('pair.code');
  const { id } = await b.rpc('pair.join', { code });
  await a.rpc('pair.respond', { id, allow: true });
  assert.equal((await a.rpc('peers.list')).peers.some((peer) => peer.id === b.id), true);
}
