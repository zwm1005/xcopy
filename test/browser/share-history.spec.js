import { test, expect } from './fixtures.js';
import { writeFile, rm } from 'node:fs/promises';

test('share history loads older pages in order without duplicates after resumption', async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const clockFile = `/tmp/suichuan-e2e-clock-${new URL(baseURL).port}`;
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/transfer`);
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await page.evaluate(async () => {
      const { ShareComposer } = await import('/share-ui.js');
      const render = ShareComposer.prototype.render;
      ShareComposer.prototype.render = function (...args) {
        window.historyComposer = this;
        return render.apply(this, args);
      };
    });
    await page.getByRole('tab', { name: '链接分享', exact: true }).click();
    for (let batch = 0; batch < 2; batch += 1) {
      await writeFile(clockFile, String(batch * 61000));
      await page.evaluate(async (batch) => {
        for (let i = 0; i < 13; i += 1) {
          const share = await window.historyComposer.connection.rpc('share.create', { minutes: 10, files: [{ name: `history-${batch * 13 + i}.txt`, mime: 'text/plain', size: 1 }] });
          await window.historyComposer.connection.rpc('share.cancel', { id: share.id });
        }
      }, batch);
    }
    await page.evaluate(() => window.historyComposer.connection.ws.close());
    await expect(page.locator('[data-share-record]')).toHaveCount(20);
    await expect(page.locator('[data-share-record] .share-record-details > *')).toHaveCount(0);
    await page.locator('[data-share-record]').first().getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(page.locator('[data-share-record]').first()).toContainText('history-25.txt');
    await page.getByRole('button', { name: '加载更多分享记录', exact: true }).click();
    await expect(page.locator('[data-share-record]')).toHaveCount(26);
    await page.locator('[data-share-record]').last().getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(page.locator('[data-share-record]').last()).toContainText('history-0.txt');
    const ids = await page.locator('[data-share-record]').evaluateAll((nodes) => nodes.map((node) => node.dataset.shareRecord));
    expect(new Set(ids).size).toBe(26);
    await expect(page.getByRole('button', { name: '加载更多分享记录', exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      window.historyComposer.clear();
      window.historyComposer.connection.ws.close();
    });
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(page.locator('[data-share-record]')).toHaveCount(0);
  } finally {
    await rm(clockFile, { force: true });
    await context.close();
  }
});
