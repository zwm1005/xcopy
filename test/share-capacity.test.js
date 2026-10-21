import test from 'node:test';
import assert from 'node:assert/strict';
import { createShares } from '../server/shares.js';
import { loadConfig } from '../server/config.js';
import { setup, metadata } from './helpers/ws-client.js';

test('2000 ended shares do not block creation; eviction preserves pagination, resume and retained request recovery', async (t) => {
  const { app, connect, advance } = await setup(t, { shareListBurst: 100, shareListIpBurst: 100 });
  const senders = [await (await connect()).auth(), await (await connect()).auth()];
  const newcomer = await (await connect()).auth();
  const history = [[], []];
  for (let minute = 0; minute < 50; minute += 1) {
    if (minute > 0) {
      advance(60001);
      app.sweep();
    }
    for (let owner = 0; owner < senders.length; owner += 1) {
      for (let n = 0; n < 20; n += 1) {
        const share = await senders[owner].rpc('share.create', {
          requestId: `request-${history[owner].length}`, minutes: 10, files: [metadata]
        });
        history[owner].push(share);
        await senders[owner].rpc('share.cancel', { id: share.id });
      }
    }
  }
  const firstPage = await senders[0].rpc('share.list', { limit: 50 });
  await senders[0].close();
  const resumed = await (await connect({ keys: senders[0].keys })).auth('设备', senders[0].authResult.sessionId);
  const fresh = await newcomer.rpc('share.create', { minutes: 10, files: [metadata] });
  // Active entries do not displace retained history; ending one evicts the oldest ended entry.
  assert.equal((await resumed.rpc('share.list', { requestId: 'request-0' })).shares[0].id, history[0][0].id);
  await newcomer.rpc('share.cancel', { id: fresh.id });
  assert.deepEqual((await resumed.rpc('share.list', { requestId: 'request-0' })).shares, []);
  advance(60001); // Creation retries still obey the existing per-device rate limit.
  const recovered = await resumed.rpc('share.create', { requestId: 'request-999', minutes: 10, files: [metadata] });
  assert.equal(recovered.id, history[0][999].id);
  assert.equal(recovered.status, 'cancelled');
  const ids = firstPage.shares.map((share) => share.id);
  let cursor = firstPage.nextCursor;
  while (cursor) {
    const page = await resumed.rpc('share.list', { limit: 50, cursor });
    ids.push(...page.shares.map((share) => share.id));
    cursor = page.nextCursor;
  }
  assert.deepEqual(ids, history[0].slice(1).reverse().map((share) => share.id));
  const guest = await (await connect()).guest();
  await assert.rejects(guest.rpc('share.inspect', { token: history[0][0].token }), { code: 'SHARE_NOT_FOUND' });
  assert.equal((await guest.rpc('share.inspect', { token: history[0][1].token })).status, 'cancelled');
  advance(3600001);
  app.sweep();
  assert.deepEqual((await resumed.rpc('share.list')).shares, []);
  assert.deepEqual((await resumed.rpc('share.list', { requestId: 'request-999' })).shares, []);
});

// Exercise the domain's 2000-active limit without opening thousands of TCP sockets.
function capacityFixture() {
  let time = Date.now();
  let sequence = 0;
  const transfers = new Map();
  const shares = createShares({
    config: loadConfig({}), now: () => time, transfers,
    requireThat(condition, code) {
      if (!condition) {
        throw Object.assign(new Error(code), { code });
      }
    },
    rate() {}, rateStart() {}, rateList() {}, send() {}, cleanName: (name) => name, deviceName: (id) => id,
    registerTransfer(task) {
      transfers.set(task.id, task);
      return [[], []];
    },
    finish(task, status) {
      task.status = status;
      shares.finished(task);
    }
  });
  const sender = () => ({ deviceId: `device-${++sequence}`, readyState: 1 });
  const guest = () => {
    const ws = { readyState: 1, source: `source-${++sequence}`, quota: { guest() {} } };
    shares.handle(ws, 'guest.open', { shareProtocol: 2 });
    return ws;
  };
  return {
    shares, transfers, sender, guest,
    create: (ws, data = {}) => shares.handle(ws, 'share.create', { minutes: 60, files: [metadata], ...data }),
    call: (ws, type, data = {}) => shares.handle(ws, type, data),
    advance: (ms) => { time += ms; },
    disconnect: (ws) => { ws.readyState = 3; ws.closedAt = time; }
  };
}

test('active capacity is released by every terminal path but remains occupied while claims drain', () => {
  const { create, call, sender, guest, shares, transfers, advance, disconnect } = capacityFixture();
  const entries = Array.from({ length: 2000 }, (_, index) => {
    const ws = sender();
    return { ws, share: create(ws, { minutes: index === 2 ? 10 : 60, mode: 'multiple', shareProtocol: 2 }) };
  });
  const incoming = sender();
  const full = () => assert.throws(() => create(incoming), { code: 'BUSY' });
  const replace = () => create(sender());
  full();
  call(entries[0].ws, 'share.cancel', { id: entries[0].share.id });
  call(entries[0].ws, 'share.cancel', { id: entries[0].share.id }); // Repeated terminal calls cannot release twice.
  replace();
  full();
  call(entries[1].ws, 'share.stop', { id: entries[1].share.id });
  replace();
  full();
  advance(600001);
  shares.sweep();
  assert.equal(call(entries[2].ws, 'share.list').shares[0].status, 'expired');
  replace();
  full();
  disconnect(entries[3].ws);
  advance(15001);
  shares.sweep();
  assert.equal(call(entries[3].ws, 'share.list').shares[0].status, 'unavailable');
  replace();
  full();
  const receiver = guest();
  call(receiver, 'share.claim', { token: entries[4].share.token });
  assert.equal(call(entries[4].ws, 'share.stop', { id: entries[4].share.id }).status, 'draining');
  full();
  call(receiver, 'share.claim.cancel', { id: entries[4].share.id });
  assert.equal(call(entries[4].ws, 'share.list').shares[0].status, 'stopped');
  const singleSender = sender();
  const single = create(singleSender);
  full();
  call(receiver, 'share.claim', { token: single.token });
  const task = call(singleSender, 'share.file.start', { id: single.id, index: 0 });
  const transfer = transfers.get(task.id);
  transfer.status = 'completed';
  shares.finished(transfer);
  assert.equal(call(singleSender, 'share.list').shares[0].status, 'completed');
  shares.finished(transfer);
  replace();
  full();
});

test('history eviction uses end order and never removes active shares or refreshes terminal retention', () => {
  const { create, call, sender, guest, advance, shares } = capacityFixture();
  const activeSender = sender();
  const active = create(activeSender, { requestId: 'active' });
  const delayedSender = sender();
  const delayed = create(delayedSender, { requestId: 'delayed' });
  const writer = sender();
  const history = [];
  for (let i = 0; i < 2000; i += 1) {
    const entry = create(writer, { requestId: `request-${i}` });
    history.push(entry);
    call(writer, 'share.cancel', { id: entry.id });
  }
  advance(1);
  call(delayedSender, 'share.cancel', { id: delayed.id });
  assert.equal(create(delayedSender, { requestId: 'delayed' }).id, delayed.id);
  assert.deepEqual(call(writer, 'share.list', { requestId: 'request-0' }).shares, []);
  assert.equal(create(activeSender, { requestId: 'active' }).id, active.id);
  assert.throws(() => create(activeSender), { code: 'BUSY' });
  assert.equal(call(guest(), 'share.inspect', { token: active.token }).status, 'ready');
  // A duplicate cancellation must not make an old record the newest history entry.
  call(writer, 'share.cancel', { id: history[1].id });
  const extra = create(writer);
  call(writer, 'share.cancel', { id: extra.id });
  assert.deepEqual(call(writer, 'share.list', { requestId: 'request-1' }).shares, []);
  assert.equal(call(delayedSender, 'share.list', { requestId: 'delayed' }).shares[0].id, delayed.id);
  advance(1800000);
  call(delayedSender, 'share.cancel', { id: delayed.id });
  advance(1800001);
  shares.sweep();
  assert.deepEqual(call(delayedSender, 'share.list', { requestId: 'delayed' }).shares, []);
});
