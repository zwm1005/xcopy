import { test, expect } from './fixtures.js';
import { readFile } from 'node:fs/promises';

test('forced TURN browser transfer crosses credential expiry and reconnects signaling', async ({ browser, baseURL }) => {
  test.skip(process.env.TEST_TURN_LONG !== '1', 'Explicit local 900-second TURN compatibility test');
  test.setTimeout(1500000);
  const senderContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const sender = await senderContext.newPage();
    await sender.goto(`${baseURL}/transfer`);
    await expect(sender.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await sender.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const { Connection } = await import('/connection.js');
      const send = Transfers.prototype.sendBytes;
      const rpc = Connection.prototype.rpc;
      Connection.prototype.rpc = function (...args) {
        window.longTurnConnection = this;
        return rpc.apply(this, args);
      };
      Transfers.prototype.sendBytes = async function (item) {
        window.longTurnRoute = item.route;
        const blob = item.blob;
        item.blob = { slice(start, end) {
          return { async arrayBuffer() {
            await new Promise((resolve) => setTimeout(resolve, 30000));
            return blob.slice(start, end).arrayBuffer();
          } };
        } };
        return send.call(this, item);
      };
    });
    await sender.getByRole('tab', { name: '链接分享', exact: true }).click();
    const bytes = Buffer.alloc(32 * 1024 * 1024, 71);
    await sender.locator('[data-files]').setInputFiles({ name: 'expiry.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await sender.locator('[data-share-generate]').click();
    const guest = await guestContext.newPage();
    await guest.goto(await sender.locator('[data-share-url]').inputValue());
    const start = Date.now();
    await guest.locator('[data-claim]').click();
    await expect.poll(() => sender.evaluate(() => window.longTurnRoute)).toBe('relay');
    await sender.evaluate(() => window.longTurnConnection.ws.close());
    await expect(sender.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(guest.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成', { timeout: 1400000 });
    expect(Date.now() - start).toBeGreaterThan(900000);
    const download = guest.waitForEvent('download');
    await guest.locator('[data-save-index="0"]').click();
    expect(await readFile(await (await download).path())).toEqual(bytes);
  } finally {
    await Promise.all([senderContext.close(), guestContext.close()]);
  }
});
