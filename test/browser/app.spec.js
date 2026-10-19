import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

async function device(browser, baseURL, name) {
  const context = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(new URL('/transfer', baseURL).href);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(name);
  await page.locator('[data-action="rename"]').click();
  await expect(page.locator('[data-local-name]')).toHaveText(name);
  await expect(page.locator('.qt-overlay')).toBeHidden();
  return { context, page };
}

async function pair(a, b) {
  await a.locator('[data-action="connect"]').click();
  await a.locator('[data-action="refresh-code"]').click();
  await expect(a.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  const code = (await a.locator('[data-code]').textContent()).replace(/\s/g, '');
  await b.locator('[data-action="connect"]').click();
  await b.locator('[data-pair-tab="enter"]').click();
  await b.locator('[data-code-input]').fill(code);
  await b.locator('[data-join]').click();
  await expect(a.locator('[data-approval-panel]')).toBeVisible();
  await a.locator('[data-action="allow"]').click();
  await expect(a.locator('.qt-overlay')).toBeHidden();
  await expect(b.locator('.qt-overlay')).toBeHidden();
}

test('离线设备提示只保留在附件按钮旁，中央不重复显示', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '提示检查发送端');
  const b = await device(browser, baseURL, '提示检查接收端');
  try {
    await pair(a.page, b.page);
    await a.page.locator('[data-target]').selectOption('all-online');
    await b.context.close();
    const target = a.page.locator('.qt-compose-tools [data-target]');
    await expect(target).toHaveText('等待接收设备上线');
    await expect(target).toBeDisabled();
    await expect(a.page.locator('[data-send-note]')).toBeHidden();
    await expect(a.page.locator('[data-send-note]')).toHaveText('');
    await a.page.locator('[data-editor]').fill('离线时仍可编辑');
    await expect(a.page.locator('[data-action="send"]')).toBeDisabled();
    await expect(a.page.locator('[data-send-note]')).toBeHidden();
    // Reload also checks the ordinary single-device selection.
    await a.page.reload();
    await expect(target).toHaveText('等待接收设备上线');
    await expect(a.page.locator('[data-send-note]')).toBeHidden();
    for (const width of [1440, 375]) {
      await a.page.setViewportSize({ width, height: 900 });
      expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await a.page.screenshot({ path: testInfo.outputPath(`离线提示-${width}.png`), fullPage: true });
    }
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});

test('three-device pairing, real text/files/screenshots, refresh identity, revocation and mobile layout', async ({ browser, baseURL }) => {
  const a = await device(browser, baseURL, '办公电脑');
  const b = await device(browser, baseURL, '家里电脑');
  const c = await device(browser, baseURL, '笔记本');
  try {
    await pair(a.page, b.page);
    await pair(a.page, c.page);
    await b.page.locator('[data-action="devices"]').click();
    await expect(b.page.locator('[data-devices-list]')).toContainText('办公电脑');
    await expect(b.page.locator('[data-devices-list]')).not.toContainText('笔记本');
    await b.page.locator('[data-action="close"]').click();

    await a.page.locator('[data-target]').selectOption({ label: '家里电脑' });
    const text = '  第一行\n<script>alert("xss")</script>\n最后一行  ';
    await a.page.locator('[data-editor]').fill(text);
    await a.page.locator('[data-action="send"]').click();
    const received = b.page.locator('[data-transfer][data-incoming="true"][data-status="completed"]');
    await expect(received).toHaveCount(1);
    await expect(received.locator('pre')).toHaveText(text);
    expect(await received.locator('pre').textContent()).toBe(text);
    await received.locator('[data-action="copy-text"]').click();
    expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    const file = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
    await a.page.locator('[data-files]').setInputFiles([
      { name: '测试文件.bin', mimeType: 'application/octet-stream', buffer: file },
      { name: '截图.png', mimeType: 'image/png', buffer: png }
    ]);
    await expect(a.page.locator('.qt-composer .qt-attachment-preview')).toHaveCount(1);
    await a.page.locator('[data-action="send"]').click();
    await expect(received).toHaveCount(3);
    const fileRow = b.page.locator('[data-transfer]').filter({ hasText: '测试文件.bin' });
    const downloadPromise = b.page.waitForEvent('download');
    await fileRow.locator('[data-action="save-file"]').click();
    const download = await downloadPromise;
    expect(await readFile(await download.path())).toEqual(file);
    await expect(b.page.locator('.qt-received-image')).toHaveCount(1);

    const imageClipboard = await a.page.evaluate(async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      } catch {
        return false;
      }
    });
    expect(imageClipboard).toBe(true);
    await a.page.locator('[data-editor]').focus();
    await a.page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await expect(a.page.locator('.qt-composer .qt-attachment-preview')).toHaveCount(1);
    await a.page.locator('[data-action="send"]').click();
    await expect(received).toHaveCount(4);

    // The introduction page must not change a previously paired browser identity.
    await a.page.goto(baseURL);
    await a.page.getByRole('link', { name: '开始传输', exact: true }).click();
    await expect(a.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(a.page.locator('[data-local-name]')).toHaveText('办公电脑');
    await expect(a.page.locator('[data-transfer]')).toHaveCount(0);
    await expect(a.page.locator('[data-target] option')).toHaveCount(3);
    const secondTab = await a.context.newPage();
    await secondTab.goto(new URL('/transfer', baseURL).href);
    await expect(secondTab.locator('[data-local-name]')).toHaveText('办公电脑');
    await expect(secondTab.locator('[data-target] option')).toHaveCount(3);

    await a.page.locator('[data-action="devices"]').click();
    await a.page.locator('.qt-device-row').filter({ hasText: '家里电脑' }).locator('[data-action="forget"]').click();
    await expect(a.page.locator('[data-devices-list]')).not.toContainText('家里电脑');
    await expect(a.page.locator('[data-devices-list]')).toContainText('笔记本');
    // This scenario deliberately discards received screenshots when reloading.
    b.page.once('dialog', (dialog) => dialog.accept());
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await b.page.locator('[data-action="devices"]').click();
    await expect(b.page.locator('[data-devices-list]')).toHaveText('还没有配对设备');
    await b.page.locator('[data-action="close"]').click();
    await b.page.setViewportSize({ width: 375, height: 812 });
    expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await b.page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
    await a.page.locator('[data-action="close"]').click();
    await a.page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  } finally {
    await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
  }
});

test('cancellation stops an active transfer and allows retry; forgetting is disabled across tabs', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '发送端');
  const b = await device(browser, baseURL, '接收端');
  try {
    await pair(a.page, b.page);
    // Delay sending with real data-channel calls, preserving actual WebRTC and
    // server authorization so the cancel race can be tested deterministically.
    await a.page.evaluate(() => {
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (data) {
        if (data instanceof ArrayBuffer) {
          const start = performance.now();
          while (performance.now() - start < 2) {}
        }
        return send.call(this, data);
      };
    });
    const filePath = testInfo.outputPath('大文件.bin');
    await writeFile(filePath, Buffer.alloc(50 * 1048576, 7));
    await a.page.locator('[data-files]').setInputFiles(filePath);
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-transfer]')).toHaveCount(1);
    await b.page.locator('[data-action="devices"]').click();
    await expect(b.page.locator('[data-action="forget"]')).toBeDisabled();
    await b.page.locator('[data-action="close"]').click();
    await b.page.locator('[data-action="cancel"]').click();
    await expect(a.page.locator('[data-transfer]')).toHaveAttribute('data-status', 'cancelled');
    await a.page.locator('[data-action="retry"]').click();
    await expect(b.page.locator('[data-status="completed"]')).toHaveCount(1, { timeout: 60000 });
    const row = b.page.locator('[data-status="completed"]');
    const downloadPromise = b.page.waitForEvent('download');
    await row.locator('[data-action="save-file"]').click();
    expect(await readFile(await (await downloadPromise).path())).toEqual(Buffer.alloc(50 * 1048576, 7));
    await b.page.locator('[data-action="devices"]').click();
    await expect(b.page.locator('[data-action="forget"]')).toBeEnabled();
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});

test('forced TURN relay carries eight files plus text through the bounded queue', async ({ browser, baseURL }) => {
  test.skip(process.env.FORCE_RELAY !== '1', '通过 npm run test:relay 启动本地 TURN 验收');
  const a = await device(browser, baseURL, 'Relay A');
  const b = await device(browser, baseURL, 'Relay B');
  try {
    await pair(a.page, b.page);
    // Fill all three queue slots before releasing content over real TURN.
    await a.page.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const sendBytes = Transfers.prototype.sendBytes;
      const gate = new Promise((resolve) => { window.releaseRelayBatch = resolve; });
      Transfers.prototype.sendBytes = async function (item) {
        await gate;
        return sendBytes.call(this, item);
      };
    });
    const files = Array.from({ length: 8 }, (_, index) => ({
      name: `relay-${index}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024, index + 1)
    }));
    await a.page.locator('[data-files]').setInputFiles(files);
    await a.page.locator('[data-editor]').fill('经自建 TURN 中继传输');
    await a.page.locator('[data-action="send"]').click();
    await expect(a.page.locator('[data-status="transferring"][data-route="relay"]')).toHaveCount(3);
    await expect(a.page.locator('[data-status="queued"]')).toHaveCount(6);
    await expect(b.page.locator('[data-status="transferring"][data-route="relay"]')).toHaveCount(3);
    await a.page.evaluate(() => window.releaseRelayBatch());
    await expect(b.page.locator('[data-status="completed"][data-route="relay"]')).toHaveCount(9);
    await expect(a.page.locator('[data-status="completed"][data-route="relay"]')).toHaveCount(9);
    await expect(b.page.locator('pre')).toHaveText('经自建 TURN 中继传输');
    for (const file of files) {
      const downloadPromise = b.page.waitForEvent('download');
      await b.page.locator('[data-transfer]').filter({ hasText: file.name }).locator('[data-action="save-file"]').click();
      expect(await readFile(await (await downloadPromise).path())).toEqual(file.buffer);
    }
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});
