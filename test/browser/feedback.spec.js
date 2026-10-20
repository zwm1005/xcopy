import { test, expect } from './fixtures.js';
import { readFile } from 'node:fs/promises';

async function device(browser, baseURL, name) {
  const context = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(name);
  await page.locator('[data-action="rename"]').click();
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
async function slowFileReads(page) {
  await page.evaluate(() => {
    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () {
      await new Promise(resolve => setTimeout(resolve, 400));
      return arrayBuffer.call(this);
    };
  });
}

test('received text and mixed content show accurate notices and retain unread navigation', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '发送电脑');
  const b = await device(browser, baseURL, '接收电脑');
  try {
    await pair(a.page, b.page);
    await a.page.locator('[data-editor]').fill('文字提醒验收');
    await a.page.locator('[data-action="send"]').click();
    const text = b.page.locator('[data-transfer]').filter({ hasText: '文字提醒验收' });
    await expect(text).toHaveAttribute('data-status', 'completed');
    await expect(text.locator('.qt-new-marker')).toBeVisible();
    await expect(b.page.locator('.qt-notice-title')).toHaveText('收到 1 条新文字');
    await expect(b.page.locator('.qt-notice-description')).not.toContainText('请及时保存');
    await expect(b.page.locator('[data-notice-control="view"]')).toHaveText('查看内容');
    await b.page.locator('[data-locale]').selectOption('en');
    await expect(b.page.locator('.qt-notice-title')).toHaveText('Received 1 item of text');
    await b.page.locator('[data-locale]').selectOption('zh-CN');
    await b.page.locator('[data-notice-control="view"]').click();
    await expect(text).toBeFocused();
    await b.page.screenshot({ path: testInfo.outputPath('文字接收-定位记录.png'), fullPage: true });

    await b.page.locator('[data-mode="share"]').click();
    await a.page.locator('[data-editor]').fill('附件对应的说明');
    await a.page.locator('[data-files]').setInputFiles({
      name: '清单.txt', mimeType: 'text/plain', buffer: Buffer.from('mixed receipt')
    });
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-new-file-count]')).toHaveText('2');
    await expect(b.page.locator('[data-mode="share"]')).toHaveAttribute('aria-selected', 'true');
    await expect(b.page.locator('.qt-notice-title')).toHaveText('收到 2 项新内容');
    await expect(b.page.locator('.qt-notice-description')).toContainText('文件已校验，请及时保存');
    await b.page.screenshot({ path: testInfo.outputPath('文字与文件-接收提醒.png'), fullPage: true });
    await b.page.locator('[data-locale]').selectOption('en');
    await expect(b.page.locator('.qt-notice-title')).toHaveText('Received 2 items');
    await b.page.locator('[data-notice-control="view"]').click();
    await expect(b.page.locator('[data-mode="device"]')).toHaveAttribute('aria-selected', 'true');
    await expect(b.page.locator('.qt-record-highlight').filter({ hasText: /附件对应的说明|清单\.txt/ })).toBeFocused();
  }
  finally {
    await a.context.close();
    await b.context.close();
  }
});

test('verified receipts batch into a light notice, preserve tab isolation and unread files, and link to history', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '发送电脑');
  const b = await device(browser, baseURL, '接收电脑');
  try {
    await pair(a.page, b.page);
    await b.page.locator('[data-mode="share"]').click();
    const files = ['设计说明.txt', '交付清单.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n真实传输与保存验证`) }));
    await a.page.locator('[data-files]').setInputFiles(files);
    await a.page.locator('[data-action="send"]').click();
    await expect(a.page.locator('[data-status="completed"]')).toHaveCount(2);
    await expect(a.page.locator('.qt-notice-title')).toHaveText('发送成功');
    await expect(a.page.locator('[data-new-file-count]')).toBeHidden();
    await expect(b.page.locator('[data-new-file-count]')).toHaveText('2');
    await expect(b.page.locator('[data-mode="share"]')).toHaveAttribute('aria-selected', 'true');
    await expect(b.page.locator('[data-transfers]')).toBeHidden();
    await expect(b.page.locator('.qt-notice-title')).toHaveText('收到 2 个新文件');
    await expect(b.page.locator('.qt-notice-description')).toContainText('文件已校验，请及时保存');
    expect(await b.page.locator('.qt-notice').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    await b.page.locator('[data-locale]').selectOption('en');
    await expect(b.page.locator('.qt-notice-title')).toHaveText('Received 2 files');
    await b.page.locator('[data-locale]').selectOption('zh-CN');
    await b.page.locator('[data-notice-control="view"]').click();
    await expect(b.page.locator('[data-mode="device"]')).toHaveAttribute('aria-selected', 'true');
    await expect(b.page.locator('[data-transfers]')).toBeVisible();
    await expect(b.page.locator('.qt-record-highlight')).toBeFocused();
    await b.page.locator('[data-locale]').selectOption('en');
    await expect(b.page.locator('.qt-record-highlight')).toHaveCount(1);
    await b.page.locator('[data-locale]').selectOption('zh-CN');
    const download = b.page.waitForEvent('download');
    await b.page.locator('[data-transfer]').filter({ hasText: files[0].name }).locator('[data-action="save-file"]').click();
    expect(await readFile(await (await download).path())).toEqual(files[0].buffer);
    await a.page.screenshot({ path: testInfo.outputPath('发送成功-真实传输.png'), fullPage: true });
    await expect(b.page.locator('[data-new-file-count]')).toBeHidden();
  }
  finally {
    await a.context.close();
    await b.context.close();
  }
});

test('broadcast shows independent device progress and rates by default, with responsive header and localized notices', async ({ browser, baseURL }, testInfo) => {
  const devices = [];
  try {
    for (const name of ['我的电脑', '设计工作站', '会议室电脑']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [a, b, c] = devices.map(device => device.page);
    await pair(a, b);
    await pair(a, c);
    await slowFileReads(a);
    await a.locator('[data-target]').selectOption('all-online');
    await a.locator('[data-files]').setInputFiles({ name: '项目素材.zip', mimeType: 'application/zip', buffer: Buffer.alloc(16 * 1024 * 1024, 42) });
    await a.locator('[data-action="send"]').click();
    const rows = a.locator('[data-device-progress]');
    await expect(rows).toHaveCount(2);
    const toggle = a.locator('[data-action="toggle-group"]');
    const controlled = (await toggle.getAttribute('aria-controls')).split(' ');
    expect(controlled).toHaveLength(2);
    for (const id of controlled) {
      await expect(a.locator(`[id="${id}"]`)).toBeHidden();
    }
    for (const name of ['设计工作站', '会议室电脑']) {
      const row = rows.filter({ has: a.getByRole('heading', { name, exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.locator('[data-transfer-speed]').first()).toHaveText(/\d.*[KM]iB\/s/);
      await expect(row.locator('.qt-group-files')).toBeHidden();
      expect(await row.locator('progress').first().evaluate(el => el.value)).toBeGreaterThan(0);
      await expect(row.locator('.qt-transfer-metrics').first()).not.toContainText(/[↑↓]/);
    }
    await a.screenshot({ path: testInfo.outputPath('群发速度-桌面.png'), fullPage: true });
    for (const [width, scheme] of [[375, 'light'], [320, 'dark'], [1280, 'light']]) {
      await a.setViewportSize({ width, height: 900 });
      await a.emulateMedia({ colorScheme: scheme });
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const tools = await a.locator('.site-tools').boundingBox();
      const actions = await a.locator('.qt-header-actions').boundingBox();
      const brand = await a.locator('.qt-brand').boundingBox();
      if (width > 700) {
        expect(actions.x).toBeGreaterThan(tools.x + tools.width);
      }
      else {
        expect(actions.y).toBeGreaterThan(brand.y + brand.height);
        expect(actions.x + actions.width).toBeGreaterThan(width - 25);
      }
      await a.screenshot({ path: testInfo.outputPath(`实现布局-${width}-${scheme}.png`), fullPage: true });
    }
    await expect(a.locator('[data-group-status]')).toContainText('全部送达');
    await expect(a.locator('.qt-notice-title')).toHaveText('已全部送达');
    await expect(a.locator('.qt-notice-description')).toHaveText('1 个文件已送达全部 2 台设备');
    await a.locator('[data-locale]').selectOption('en');
    await expect(a.locator('.qt-notice-title')).toHaveText('Delivered to all devices');
    await expect(a.locator('[data-device-progress] > .qt-transfer-metrics [data-transfer-speed]')).toHaveCount(0);
  }
  finally {
    await Promise.all(devices.map(device => device.context.close()));
  }
});

test('a failed device can be retried without sending again to successful devices', async ({ browser, baseURL }) => {
  const devices = [];
  try {
    for (const name of ['发送电脑', '成功设备', '重试设备']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [a, b, c] = devices.map(device => device.page);
    await pair(a, b);
    await pair(a, c);
    await a.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const original = Transfers.prototype.sendBytes;
      let fail = true;
      Transfers.prototype.sendBytes = function (item) {
        if (item.peerName === '重试设备' && fail) {
          fail = false;
          throw new Error('Injected transfer failure');
        }
        return original.call(this, item);
      };
    });
    await a.locator('[data-target]').selectOption('all-online');
    await a.locator('[data-files]').setInputFiles({ name: '重试.txt', mimeType: 'text/plain', buffer: Buffer.from('retry only failed') });
    await a.locator('[data-action="send"]').click();
    await expect(a.locator('.qt-notice-title')).toHaveText('部分文件未送达');
    await expect(a.locator('.qt-notice-description')).toHaveText('已送达 1 / 2 台设备');
    await a.locator('[data-action="retry-device"]').click();
    await expect(a.locator('.qt-notice-title')).toHaveText('已全部送达');
    await expect(b.locator('[data-transfer]')).toHaveCount(1);
    await expect(c.locator('[data-status="completed"]')).toHaveCount(1);
  }
  finally {
    await Promise.all(devices.map(device => device.context.close()));
  }
});

test('multiple-share recipients have individual rates and verified completion notices on both sides', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '分享电脑');
  const guests = [];
  try {
    await slowFileReads(a.page);
    await a.page.locator('[data-mode="share"]').click();
    await a.page.locator('[data-files]').setInputFiles({ name: '共享素材.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16 * 1024 * 1024, 73) });
    await a.page.locator('[data-share-settings] summary').click();
    await a.page.locator('[data-share-mode="multiple"]').check();
    await a.page.locator('[data-share-generate]').click();
    const url = await a.page.locator('[data-share-url]').inputValue();
    for (let i = 0; i < 2; i += 1) {
      const context = await browser.newContext({ locale: 'zh-CN' });
      const page = await context.newPage();
      guests.push({ context, page });
      await page.goto(url);
      await page.locator('[data-claim]').click();
    }
    const record = a.page.locator('[data-share-record]');
    await record.getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(record.locator('[data-claim-record]')).toHaveCount(2);
    await expect(record.locator('[data-transfer-speed]').first()).toHaveText(/\d.*[KM]iB\/s/);
    await expect(guests[0].page.locator('[data-transfer-speed]')).toHaveText(/\d.*[KM]iB\/s/);
    await expect(record.locator('.share-claim-status').first()).toHaveText(/\d+%/);
    await a.page.screenshot({ path: testInfo.outputPath('分享领取-逐设备进度.png'), fullPage: true });
    await a.page.locator('[data-mode="device"]').click();
    for (const guest of guests) {
      await expect(guest.page.locator('.qt-notice-title')).toHaveText('收到 1 个新文件');
      await expect(guest.page.locator('[data-save-index]')).toBeEnabled();
    }
    await expect(a.page.locator('.qt-notice-title')).toHaveText('文件已送达');
    await expect(a.page.locator('[data-mode="device"]')).toHaveAttribute('aria-selected', 'true');
    await expect(a.page.locator('[data-share-records]')).toBeHidden();
    await a.page.locator('[data-notice-control="view"]').click();
    await expect(a.page.locator('[data-mode="share"]')).toHaveAttribute('aria-selected', 'true');
    await expect(record.locator('[data-claim-state="completed"]')).toHaveCount(2);
    await expect(record.locator('[data-transfer-speed]')).toHaveCount(0);
    await expect(a.page.locator('[data-new-file-count]')).toBeHidden();
  }
  finally {
    await a.context.close();
    await Promise.all(guests.map(guest => guest.context.close()));
  }
});
