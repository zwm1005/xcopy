import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeedSampler, transferredBytes } from '../dist/public/transfer-progress.js';
import { TransferFeedback } from '../dist/public/transfer-feedback.js';

function item(values = {}) {
  return { id: 'task', localId: 'local', kind: 'file', status: 'transferring', size: 100000, bytes: 0, incoming: false, ...values };
}

test('speed measures drained bytes over time, detects stalls and resets for retries', () => {
  const sampler = new SpeedSampler();
  const outgoing = item({ channel: { bufferedAmount: 0 } });
  sampler.sample(outgoing, 0);
  outgoing.bytes = 10000;
  outgoing.channel.bufferedAmount = 6000;
  sampler.sample(outgoing, 1000);
  assert.equal(transferredBytes(outgoing), 4000);
  assert.equal(outgoing.speed, 4000);
  outgoing.channel.bufferedAmount = 2000;
  sampler.sample(outgoing, 2000);
  assert.equal(outgoing.speed, 4000);
  for (let now = 3000; now <= 7000; now += 1000) {
    sampler.sample(outgoing, now);
  }
  assert.equal(outgoing.speed, 0);
  assert.equal(outgoing.stalled, true);
  outgoing.status = 'failed';
  sampler.sample(outgoing, 8000);
  assert.equal(outgoing.speed, undefined);
  assert.equal(outgoing.stalled, false);
  const retry = item();
  sampler.sample(retry, 9000);
  retry.bytes = 7000;
  sampler.sample(retry, 10000);
  assert.equal(retry.speed, 7000);
});

test('incoming bytes ignore outgoing control buffers and completed bytes remain correct', () => {
  const incoming = item({ incoming: true, bytes: 20, channel: { bufferedAmount: 100 } });
  assert.equal(transferredBytes(incoming), 20);
  assert.equal(transferredBytes(item({ bytes: 20, channel: { bufferedAmount: 100 } })), 0);
  assert.equal(transferredBytes(item({ bytes: 0, status: 'completed' })), 100000);
});

test('receipt feedback requires verified completion and is observed only once', () => {
  const feedback = new TransferFeedback();
  const receiving = item({ incoming: true, bytes: 100000 });
  assert.deepEqual(feedback.collect([receiving], 0), []);
  assert.equal(feedback.collect([receiving], 1000)[0].kind, 'receiving');
  receiving.status = 'completed';
  assert.deepEqual(feedback.collect([receiving], 1100), []);
  receiving.verified = true;
  assert.equal(feedback.collect([receiving], 1200)[0].kind, 'received');
  assert.deepEqual(feedback.collect([receiving], 1400), []);
  assert.deepEqual(feedback.collect([item({ incoming: true, verified: true, status: 'completed', shareId: 'share' })]), []);
});

test('group success waits for all confirmations, partial results and retries are emitted once', () => {
  const feedback = new TransferFeedback();
  const a = item({ batchId: 'batch', status: 'completed' });
  const b = item({ batchId: 'batch', id: 'b', localId: 'b', bytes: 100000 });
  assert.deepEqual(feedback.collect([a, b]), []);
  b.status = 'failed';
  assert.equal(feedback.collect([a, b])[0].kind, 'partial');
  assert.deepEqual(feedback.collect([a, b]), []);
  const retry = { ...b, id: 'b-retry', status: 'transferring' };
  assert.deepEqual(feedback.collect([a, retry]), []);
  retry.status = 'completed';
  assert.equal(feedback.collect([a, retry])[0].kind, 'sent');
  assert.deepEqual(feedback.collect([a, retry]), []);
  assert.equal(feedback.collect([item({ status: 'cancelled' })])[0].kind, 'cancelled');
});
