import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setup, metadata } from './helpers/ws-client.js';

for (const stopped of [false, true]) {
  test(`sender resumption schedules queued claims after an offline completion (${stopped ? 'draining' : 'accepting'})`, async (t) => {
    const { app, connect } = await setup(t, { shareConcurrency: 1, shareListBurst: 1, shareListRate: 1 });
    const accepted = once(app.server, 'connection');
    const sender = await (await connect()).auth();
    const [senderSocket] = await accepted;
    const share = await sender.rpc('share.create', { mode: 'multiple', shareProtocol: 2, minutes: 10, files: [metadata] });
    const recipients = [];
    const claims = [];
    for (let i = 0; i < 3; i += 1) {
      const recipient = await (await connect()).guest();
      recipients.push(recipient);
      claims.push((await recipient.rpc('share.claim', { token: share.token })).myClaim);
    }
    assert.deepEqual(claims.map((claim) => claim.state), ['transferring', 'queued', 'queued']);
    const first = await sender.rpc('share.file.start', { id: share.id, claimId: claims[0].id, index: 0 });
    await recipients[0].rpc('transfer.accept', { id: first.id });
    if (stopped) {
      await sender.rpc('share.stop', { id: share.id });
    }
    await sender.rpc('share.list'); // Exhaust the read budget before reconnecting.
    const closed = once(senderSocket, 'close');
    await sender.close();
    await closed;
    await recipients[0].rpc('transfer.end', { id: first.id, status: 'completed' });

    const resumed = await (await connect({ keys: sender.keys })).auth('设备', sender.authResult.sessionId);
    assert.equal(resumed.authResult.resumed, true);
    const scheduled = resumed.events.filter((event) => event.type === 'share.claimed');
    assert.deepEqual(scheduled.map((event) => event.data.claimId), [claims[1].id]);
    const state = resumed.events.findLast((event) => event.type === 'share.state').data;
    assert.deepEqual(state.claims.map((claim) => claim.state), ['completed', 'transferring', 'queued']);
    assert.equal(state.accepting, !stopped);
    await assert.rejects(resumed.rpc('share.list'), (error) => error.code === 'RATE_LIMIT');

    // Repeated maintenance cannot duplicate the offer or exceed concurrency.
    app.sweep();
    app.sweep();
    const second = await resumed.rpc('share.file.start', { id: share.id, claimId: claims[1].id, index: 0 });
    assert.equal(resumed.events.filter((event) => event.type === 'share.claimed').length, 1);
    await assert.rejects(resumed.rpc('share.file.start', { id: share.id, claimId: claims[2].id, index: 0 }), (error) => error.code === 'BUSY');
    await recipients[1].rpc('transfer.accept', { id: second.id });
    await recipients[1].rpc('transfer.end', { id: second.id, status: 'completed' });
    const third = await resumed.rpc('share.file.start', { id: share.id, claimId: claims[2].id, index: 0 });
    await recipients[2].rpc('transfer.accept', { id: third.id });
    await recipients[2].rpc('transfer.end', { id: third.id, status: 'completed' });
  });
}
