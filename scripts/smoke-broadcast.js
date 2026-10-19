import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

async function device(browser, baseURL, name) {
  const context = await browser.newContext();
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

async function holdBytes(page) {
  await page.evaluate(async () => {
    const { Transfers } = await import('/transfer.js');
    const sendBytes = Transfers.prototype.sendBytes;
    const gate = new Promise(resolve => { window.releaseBatch = resolve; });
    Transfers.prototype.sendBytes = async function (item) {
      await gate;
      return sendBytes.call(this, item);
    };
  });
}

const origin = new URL(process.argv[2] || 'https://xcopy.werfamily.fun').origin;
const forceRelay = process.argv.includes('--relay');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const devices = [];
const errors = [];
try {
  for (const name of ['群发验收 A', '群发验收 B', '群发验收 C']) {
    // The hook runs before application startup in each isolated browser instance.
    const proxy = {
      async newContext() {
        const context = await browser.newContext();
        if (forceRelay) {
          await context.addInitScript(() => {
            const RTC = window.RTCPeerConnection;
            window.RTCPeerConnection = class extends RTC {
              constructor(config) {
                super({ ...config, iceTransportPolicy: 'relay' });
              }
            };
          });
        }
        return context;
      }
    };
    const entry = await device(proxy, origin, name);
    entry.page.on('pageerror', error => errors.push(error.message));
    devices.push(entry);
  }
  const [a, b, c] = devices.map(entry => entry.page);
  await pair(a, b);
  await pair(a, c);
  await expect(a.locator('[data-target]')).not.toHaveValue('all-online');
  await a.locator('[data-target]').selectOption('all-online');
  await holdBytes(a);
  const files = Array.from({ length: 7 }, (_, index) => ({ name: `群发验收-${index}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(32768, index + 3) }));
  files.push({ name: '群发截图.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64') });
  const chooser = a.waitForEvent('filechooser');
  await a.getByRole('button', { name: '添加附件', exact: true }).click();
  await (await chooser).setFiles(files);
  const message = '  群发部署验收\n文字、截图和附件一起发送  ';
  await a.locator('[data-editor]').fill(message);
  await a.locator('[data-action="send"]').click();
  const group = a.locator('[data-group]');
  const route = forceRelay ? '[data-route="relay"]' : '';
  await expect(group.locator(`[data-status="transferring"]${route}`)).toHaveCount(3, { timeout: 45000 });
  await expect(group.locator('[data-status="queued"]')).toHaveCount(15);
  await a.evaluate(() => window.releaseBatch());
  await expect(group.locator(`[data-status="completed"]${route}`)).toHaveCount(18, { timeout: 60000 });
  await expect(group.locator('[data-group-status]')).toContainText('全部送达');
  for (const recipient of [b, c]) {
    await expect(recipient.locator(`[data-status="completed"]${route}`)).toHaveCount(9, { timeout: 15000 });
    assert.equal(await recipient.locator('pre').textContent(), message);
    for (const file of files) {
      const download = recipient.waitForEvent('download');
      await recipient.locator('[data-transfer]').filter({ hasText: file.name }).locator('[data-action="save-file"]').click();
      assert.deepEqual(await readFile(await (await download).path()), file.buffer);
    }
    await recipient.locator('.qt-received-image').click();
    await expect(recipient.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
    await recipient.keyboard.press('Escape');
  }
  for (const [width, colorScheme] of [[1280, 'light'], [375, 'dark'], [320, 'light']]) {
    await a.setViewportSize({ width, height: 900 });
    await a.emulateMedia({ colorScheme });
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await a.screenshot({ path: `/tmp/suichuan-broadcast-${width}.png`, fullPage: true });
  }
  await a.locator('[data-target]').selectOption({ label: '群发验收 C' });
  await a.locator('[data-editor]').fill('单发验收');
  await a.locator('[data-action="send"]').click();
  await expect(c.locator('[data-status="completed"]')).toHaveCount(10, { timeout: 30000 });
  await expect(b.locator('[data-status="completed"]')).toHaveCount(9);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ origin, forceRelay, recipients: 2, broadcastTasks: 18, maxConcurrent: 3, verifiedDownloads: 16, singleSend: 'passed', imagePreview: 'passed', errors }, null, 2));
} finally {
  try {
    const a = devices[0]?.page;
    if (a && !a.isClosed()) {
      const cancel = a.locator('[data-action="cancel-group"]');
      if (await cancel.isVisible()) {
        await cancel.click();
      }
      if (await a.locator('.qt-overlay').isVisible()) {
        await a.locator('[data-action="close"]').click();
      }
      await a.locator('[data-action="devices"]').click();
      const forget = a.locator('[data-action="forget"]');
      while (await forget.count()) {
        const count = await forget.count();
        await expect(forget.first()).toBeEnabled({ timeout: 20000 });
        await forget.first().click();
        await expect(forget).toHaveCount(count - 1);
      }
    }
  } finally {
    await Promise.allSettled(devices.map(entry => entry.context.close()));
    await browser.close();
  }
}

