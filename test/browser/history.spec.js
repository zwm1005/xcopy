import { test, expect } from '@playwright/test';

async function device(browser, baseURL, name) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(name);
  await page.locator('[data-action="rename"]').click();
  await expect(page.locator('.qt-overlay')).toBeHidden();
  return { context, page };
}

async function pair(a, b) {
  await a.locator('[data-action="connect"]').click();
  await expect(a.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  const code = (await a.locator('[data-code]').textContent()).replace(/\s/g, '');
  await b.locator('[data-action="connect"]').click();
  await b.locator('[data-pair-tab="enter"]').click();
  await b.locator('[data-code-input]').fill(code);
  await b.locator('[data-join]').click();
  await a.locator('[data-action="allow"]').click();
  await expect(a.locator('.qt-overlay')).toBeHidden();
  await expect(b.locator('.qt-overlay')).toBeHidden();
}

for (const clearFirst of ['share', 'device']) {
  test(`tab histories isolate counts, background receipts and clearing ${clearFirst} first`, async ({ browser, baseURL }, testInfo) => {
    const a = await device(browser, baseURL, '历史隔离电脑');
    const b = await device(browser, baseURL, '历史隔离手机');
    const guest = await browser.newContext({ locale: 'zh-CN' });
    const dialogs = [];
    a.page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.accept();
    });
    const select = (mode) => a.page.getByRole('tab', { name: mode === 'share' ? '链接分享' : '发送给设备', exact: true }).click();
    const history = a.page.locator('.qt-transfers');
    const count = a.page.locator('[data-count]');
    const clear = a.page.locator('[data-action="clear"]');
    const record = a.page.locator('[data-share-record]');
    try {
      await pair(a.page, b.page);
      await select('share');
      await a.page.locator('[data-files]').setInputFiles({ name: '链接分享文件.txt', mimeType: 'text/plain', buffer: Buffer.from('share only') });
      await a.page.locator('[data-share-generate]').click();
      const url = await a.page.locator('[data-share-url]').inputValue();
      await expect(count).toHaveText('1');
      await expect(clear).toBeHidden();

      // A device receipt completes while the recipient is looking at share history.
      await b.page.locator('[data-files]').setInputFiles({ name: '设备收到文件.txt', mimeType: 'text/plain', buffer: Buffer.from('device only') });
      await b.page.locator('[data-action="send"]').click();
      await expect(a.page.locator('[data-transfer][data-status="completed"]')).toHaveCount(1);
      await expect(a.page.locator('[data-transfers]')).toBeHidden();
      await expect(a.page.locator('[data-unsaved-note]')).toBeHidden();
      await expect(count).toHaveText('1');
      await expect(clear).toBeHidden();

      await select('device');
      await expect(record).toBeHidden();
      await expect(count).toHaveText('1');
      await expect(a.page.locator('[data-unsaved-note]')).toContainText('1');
      await a.page.locator('[data-target]').selectOption('all-online');
      await a.page.locator('[data-editor]').fill('设备群发记录');
      await a.page.locator('[data-action="send"]').click();
      await expect(a.page.locator('[data-group-status]')).toContainText('全部送达');
      await expect(count).toHaveText('2');

      await select('share');
      const recipient = await guest.newPage();
      await recipient.goto(url);
      await recipient.locator('[data-claim]').click();
      await expect(record).toHaveAttribute('data-status', 'completed');
      await expect(count).toHaveText('1');
      await expect(clear).toBeVisible();
      await expect(a.page.locator('[data-unsaved-note]')).toBeHidden();
      await record.getByRole('button', { name: '查看详情', exact: true }).click();
      await expect(record.getByRole('region', { name: '分享文件', exact: true })).toContainText('链接分享文件.txt');
      for (const mode of ['device', 'share']) {
        await select(mode);
        await a.page.setViewportSize({ width: 1280, height: 900 });
        await a.page.screenshot({ path: testInfo.outputPath(`历史隔离-${mode}.png`), fullPage: true });
        await a.page.setViewportSize({ width: 375, height: 812 });
        expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(count).toHaveText(mode === 'share' ? '1' : '2');
        await expect(record).toBeVisible({ visible: mode === 'share' });
        await expect(a.page.locator('[data-transfers]')).toBeVisible({ visible: mode === 'device' });
      }

      await select(clearFirst);
      await clear.click();
      await expect(history).toBeHidden();
      const other = clearFirst === 'share' ? 'device' : 'share';
      await select(other);
      await expect(history).toBeVisible();
      await expect(count).toHaveText(other === 'share' ? '1' : '2');
      if (other === 'device') {
        await expect(a.page.locator('[data-group]')).toBeVisible();
        await expect(a.page.locator('[data-transfer]').filter({ hasText: '设备收到文件.txt' })).toBeVisible();
        await expect(a.page.locator('[data-unsaved-note]')).toContainText('1');
      }
      else {
        await expect(record.getByRole('region', { name: '分享文件', exact: true })).toContainText('链接分享文件.txt');
        await expect(record.getByRole('region', { name: '领取设备', exact: true })).toBeVisible();
      }
      await clear.click();
      await expect(history).toBeHidden();
      expect(dialogs).toEqual(['confirm']);
      await select(clearFirst);
      await expect(history).toBeHidden();
    }
    finally {
      await Promise.all([a.context.close(), b.context.close(), guest.close()]);
    }
  });
}
