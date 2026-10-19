import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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

test('群发固定配对名单，18 项有界传输，支持展开结果和切回单发', async ({ browser, baseURL }, testInfo) => {
  const devices = [];
  try {
    for (const name of ['发送电脑', '电脑 B', '电脑 C', '电脑 D']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [a, b, c, d] = devices.map(entry => entry.page);
    await pair(a, b);
    await pair(a, c);
    await pair(b, d);
    await expect(a.locator('[data-target]')).not.toHaveValue('all-online');
    await expect(b.locator('[data-target]')).not.toContainText('电脑 C');
    await expect(a.locator('[data-target]')).not.toContainText('电脑 D');
    await a.locator('[data-target]').selectOption('all-online');
    await expect(a.locator('[data-action="send"]')).toHaveAttribute('aria-label', '发送');
    await holdBytes(a);
    const files = Array.from({ length: 8 }, (_, index) => ({ name: `附件-${index}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(32768, index + 1) }));
    // The attachment button still invokes the real file chooser.
    const chooser = a.waitForEvent('filechooser');
    await a.locator('[data-action="pick"]').click();
    await (await chooser).setFiles(files);
    await a.locator('[data-editor]').fill('群发原文\n<script>按文字发送</script>');
    await a.locator('[data-action="send"]').click();
    const group = a.locator('[data-group]');
    await expect(group).toHaveCount(1);
    await expect(group.locator('[data-status="transferring"]')).toHaveCount(3);
    await expect(group.locator('[data-status="queued"]')).toHaveCount(15);
    await group.locator('[data-action="toggle-group"]').click();
    await expect(group.locator('[data-group-details]')).toBeVisible();
    await a.locator('[data-action="devices"]').click();
    await expect(a.locator('[data-action="forget"]').first()).toBeDisabled();
    await a.locator('[data-action="close"]').click();
    await pair(a, d);
    await expect(a.locator('[data-target]')).toContainText('全部在线设备（3 台）');
    await expect(group.locator('.qt-group-title')).toHaveText('群发 · 2 台设备');
    await a.evaluate(() => window.releaseBatch());
    await expect(group.locator('[data-status="completed"]')).toHaveCount(18, { timeout: 45000 });
    for (const recipient of [b, c]) {
      await expect(recipient.locator('[data-status="completed"]')).toHaveCount(9);
      await expect(recipient.locator('pre')).toHaveText('群发原文\n<script>按文字发送</script>');
      const download = recipient.waitForEvent('download');
      await recipient.locator('[data-transfer]').filter({ hasText: files[7].name }).locator('[data-action="save-file"]').click();
      expect(await readFile(await (await download).path())).toEqual(files[7].buffer);
    }
    await expect(d.locator('[data-transfer]')).toHaveCount(0);
    await expect(group.locator('[data-group-status]')).toContainText('全部送达');
    for (const width of [1440, 375, 320]) {
      await a.setViewportSize({ width, height: 900 });
      await a.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light' });
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await a.screenshot({ path: testInfo.outputPath(`群发-${width}.png`), fullPage: true });
    }
    await a.locator('[data-target]').selectOption({ label: '电脑 C' });
    await a.locator('[data-editor]').fill('只发给 C');
    await a.locator('[data-action="send"]').click();
    await expect(c.locator('[data-status="completed"]')).toHaveCount(10);
    await expect(b.locator('[data-status="completed"]')).toHaveCount(9);
    await expect(d.locator('[data-transfer]')).toHaveCount(0);
    await a.locator('[data-target]').selectOption('all-online');
    await a.reload();
    await expect(a.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(a.locator('[data-target]')).not.toHaveValue('all-online');
    await expect(a.locator('[data-target] option:checked')).toHaveText('电脑 C');
  } finally {
    await Promise.all(devices.map(entry => entry.context.close()));
  }
});

test('群发失败重试只发送失败设备，成功设备不重复接收', async ({ browser, baseURL }) => {
  const devices = [];
  try {
    for (const name of ['发送电脑', '成功设备', '失败后重试设备']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [a, b, c] = devices.map(entry => entry.page);
    await pair(a, b);
    await pair(a, c);
    await a.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const sendBytes = Transfers.prototype.sendBytes;
      let injected = false;
      Transfers.prototype.sendBytes = async function (item) {
        if (item.peerName === '失败后重试设备' && !injected) {
          injected = true;
          throw new Error('模拟网络发送失败');
        }
        return sendBytes.call(this, item);
      };
    });
    await a.locator('[data-target]').selectOption('all-online');
    await a.locator('[data-editor]').fill('失败重试内容');
    await a.locator('[data-action="send"]').click();
    const group = a.locator('[data-group]');
    await expect(group.locator('[data-status="completed"]')).toHaveCount(1);
    await expect(group.locator('[data-status="failed"]')).toHaveCount(1);
    await group.locator('[data-action="retry-group"]').click();
    await expect(group.locator('[data-status="completed"]')).toHaveCount(2);
    await expect(group.locator('[data-transfer]')).toHaveCount(2);
    await expect(b.locator('[data-transfer]')).toHaveCount(1);
    await expect(c.locator('[data-status="completed"]')).toHaveCount(1);
    await expect(group.locator('[data-group-status]')).toContainText('全部送达');
  } finally {
    await Promise.all(devices.map(entry => entry.context.close()));
  }
});

test('取消群发停止排队和活跃任务，随后可忘记配对', async ({ browser, baseURL }) => {
  const devices = [];
  try {
    for (const name of ['取消发送端', '接收端 B', '接收端 C']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [a, b, c] = devices.map(entry => entry.page);
    await pair(a, b);
    await pair(a, c);
    await holdBytes(a);
    await a.locator('[data-target]').selectOption('all-online');
    await a.locator('[data-editor]').fill('待取消');
    await a.locator('[data-files]').setInputFiles(Array.from({ length: 8 }, (_, index) => ({ name: `cancel-${index}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024) })));
    await a.locator('[data-action="send"]').click();
    const group = a.locator('[data-group]');
    await expect(group.locator('[data-status="transferring"]')).toHaveCount(3);
    await group.locator('[data-action="cancel-group"]').click();
    await expect(group.locator('[data-status="cancelled"]')).toHaveCount(18);
    await a.evaluate(() => window.releaseBatch());
    await expect(b.locator('[data-status="cancelled"]')).toHaveCount(2);
    await expect(c.locator('[data-status="cancelled"]')).toHaveCount(1);
    await a.locator('[data-action="devices"]').click();
    await expect(a.locator('[data-action="forget"]').first()).toBeEnabled();
    await a.locator('[data-action="close"]').click();
    await a.locator('[data-action="clear"]').click();
    await expect(a.locator('[data-group]')).toHaveCount(0);
  } finally {
    await Promise.all(devices.map(entry => entry.context.close()));
  }
});
