import { test, expect } from './fixtures.js';
import { readFile, writeFile, mkdir, rm, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

async function sender(browser, baseURL, files, mode = 'single') {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.getByRole('tab', { name: '链接分享', exact: true }).click();
  await expect(page.locator('[data-onboarding]')).toBeHidden();
  await expect(page.locator('.qt-transfers')).toBeHidden();
  await expect(page.getByText('还未选择文件', { exact: true })).toHaveCount(0);
  await expect(page.getByText('把文件分享出去', { exact: true })).toHaveCount(0);
  await expect(page.getByText('一个链接或二维码，对方打开就能接收。', { exact: true })).toHaveCount(0);
  const picker = page.locator('[data-share-panel]').getByRole('button', { name: '添加附件', exact: true });
  await expect(picker.locator('svg')).toBeVisible();
  await expect(picker).toHaveText('');
  await page.locator('[data-files]').setInputFiles(files);
  const settings = page.locator('[data-share-settings]');
  await expect(settings).not.toHaveAttribute('open');
  await expect(page.locator('[data-share-mode="single"]')).toBeChecked();
  if (mode === 'multiple') {
    await settings.getByText('更多设置', { exact: true }).click();
    await page.getByRole('radio', { name: '多人领取', exact: true }).check();
    await expect(settings).toHaveAttribute('open');
    await expect(page.locator('[data-share-description]')).toContainText('已开启多人领取');
  }
  await page.getByRole('button', { name: '创建分享', exact: true }).click();
  await expect(page.locator('[data-share-url]')).toBeVisible();
  await expect(page.getByRole('region', { name: '历史记录', exact: true })).toBeVisible();
  await expect(page.locator('.qt-section-heading h2')).toHaveText('历史记录 1');
  await expect(page.locator('.qt-history-footer > span')).toBeHidden();
  const url = await page.locator('[data-share-url]').inputValue();
  return { context, page, url };
}
async function guest(browser, url, options = {}, init) {
  const context = await browser.newContext({ locale: 'zh-CN', ...options });
  if (init) {
    await context.addInitScript(init);
  }
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('[data-claim]')).toBeEnabled();
  return { context, page };
}
const files = [
  { name: '说明 中文.txt', mimeType: 'text/plain', buffer: Buffer.from('多文件分享\n你好，世界！') },
  { name: 'payload.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, 173) },
  { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }
];

for (const mode of ['device', 'share']) {
  test(`${mode} draft accepts ten attachments, rejects an eleventh and shows an inline limit notice`, async ({ page }, testInfo) => {
    await page.goto('/transfer');
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    if (mode === 'share') {
      await page.getByRole('tab', { name: '链接分享', exact: true }).click();
    }
    const draft = page.locator(mode === 'share' ? '[data-share-panel]' : '.qt-composer');
    const notice = page.locator(mode === 'share' ? '[data-share-panel] .share-file-limit' : '[data-device-file-limit]');
    await expect(notice).toHaveText('最多 10 个文件 · P2P 直连不限大小；服务器中转单个不超过 50 MiB');
    for (const [width, scheme] of [[1280, 'light'], [375, 'light'], [320, 'dark']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const icon = notice.locator('svg');
      await expect(icon).toBeVisible();
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      // Read both boxes in one DOM snapshot: a peers update may replace the
      // notice between separate layout measurements.
      const { symbol, text } = await notice.evaluate((node) => ({
        symbol: node.querySelector('svg').getBoundingClientRect().toJSON(),
        text: node.querySelector('span').getBoundingClientRect().toJSON()
      }));
      expect(symbol.x + symbol.width).toBeLessThan(text.x);
      expect(Math.abs(symbol.y - text.y)).toBeLessThan(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.qt-main').screenshot({ path: testInfo.outputPath(`${mode}-文件限制提示-${width}-${scheme}.png`) });
    }
    const attachments = Array.from({ length: 11 }, (_, i) => ({ name: `附件-${i + 1}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`文件 ${i + 1}`) }));
    await page.locator('[data-files]').setInputFiles(attachments);
    await expect(draft.locator('.qt-attachment-name')).toHaveText(attachments.slice(0, 10).map((file) => file.name));
    await expect(page.getByRole('status')).toHaveText('一次最多添加 10 个文件，请分批发送');
    await draft.getByRole('button', { name: '移除 附件-10.txt', exact: true }).click();
    await page.locator('[data-files]').setInputFiles([attachments[10]]);
    await expect(draft.locator('.qt-attachment-name')).toHaveCount(10);
    await expect(draft.locator('.qt-attachment-name').last()).toHaveText('附件-11.txt');
    await page.locator('[data-locale]').selectOption('en');
    await expect(notice).toHaveText('Up to 10 files · No P2P size limit; relay limit 50 MiB per file');
    await expect(notice.locator('svg')).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Add up to 10 files at a time. Send additional files separately.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('tabs keep the common heading in place and successful sharing consumes only submitted draft files', async ({ page, browser, baseURL }, testInfo) => {
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('tab', { name: '发送给设备', exact: true }).click();
    await expect(page.locator('.qt-intro')).toBeVisible();
    await expect(page.locator('.qt-composer')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('.qt-composer')).toHaveCSS('border-top-color', 'rgb(229, 229, 229)');
    const before = await page.locator('.share-tabs').boundingBox();
    await page.screenshot({ path: testInfo.outputPath(`设备发送-${width}.png`), fullPage: true });
    await page.getByRole('tab', { name: '链接分享', exact: true }).click();
    await expect(page.locator('.qt-intro')).toBeVisible();
    const after = await page.locator('.share-tabs').boundingBox();
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`链接分享-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-files]').setInputFiles(files.slice(0, 1));
  await page.evaluate(async () => {
    const { Connection } = await import('/connection.js');
    const rpc = Connection.prototype.rpc;
    let failOnce = true;
    Connection.prototype.rpc = async function (type, data) {
      if (type === 'share.create') {
        if (failOnce) {
          failOnce = false;
          throw new Error('测试：创建暂时失败，请重试');
        }
        await new Promise((resolve) => { window.releaseShareCreate = resolve; });
      }
      return rpc.call(this, type, data);
    };
  });
  await page.locator('[data-share-generate]').click();
  await expect(page.locator('.qt-toast')).toHaveText('操作未完成，请重试。');
  await expect(page.locator('.share-upload .qt-attachment-name')).toHaveText(files[0].name);
  await expect(page.locator('[data-share-generate]')).toBeEnabled();
  await page.locator('[data-share-generate]').click();
  await expect(page.locator('[data-share-generate]')).toHaveText('正在创建…');
  await page.getByRole('tab', { name: '发送给设备', exact: true }).click();
  const nextFile = { name: '稍后发送.txt', mimeType: 'text/plain', buffer: Buffer.from('保留后来选择的文件') };
  await page.locator('[data-files]').setInputFiles([nextFile]);
  await expect(page.locator('[data-attachments] .qt-attachment-name')).toHaveCount(2);
  await page.evaluate(() => window.releaseShareCreate());
  await expect(page.locator('[data-attachments] .qt-attachment-name')).toHaveText([nextFile.name]);
  await page.getByRole('button', { name: `移除 ${nextFile.name}`, exact: true }).click();
  await expect(page.locator('[data-attachments]')).toBeHidden();
  await page.getByRole('tab', { name: '链接分享', exact: true }).click();
  await expect(page.locator('[data-share-url]')).toBeVisible();
  const recipient = await guest(browser, await page.locator('[data-share-url]').inputValue());
  try {
    await recipient.page.locator('[data-claim]').click();
    await expect(recipient.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
    const download = recipient.page.waitForEvent('download');
    await recipient.page.locator('[data-save-index="0"]').click();
    expect(await readFile(await (await download).path())).toEqual(files[0].buffer);
    await page.getByRole('button', { name: '创建新的分享' }).click();
    await expect(page.locator('.share-upload .qt-attachment')).toHaveCount(0);
    await expect(page.locator('[data-share-generate]')).toBeDisabled();
  } finally {
    await recipient.context.close();
  }
});

test('one-time ten-file share: QR, preview, atomic claim, verified bytes, ZIP and consumed link', async ({ browser, baseURL }, testInfo) => {
  const bundle = [...files, ...Array.from({ length: 7 }, (_, i) => ({ name: `多文件-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`文件 ${i}`) }))];
  const s = await sender(browser, baseURL, bundle);
  await s.page.screenshot({ path: testInfo.outputPath('sender-share.png'), fullPage: true });
  await s.page.setViewportSize({ width: 320, height: 850 });
  expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await s.page.screenshot({ path: testInfo.outputPath('sender-mobile.png'), fullPage: true });
  await s.page.setViewportSize({ width: 1024, height: 900 });
  const qr = PNG.sync.read(await s.page.locator('.share-qr').screenshot());
  expect(jsQR(new Uint8ClampedArray(qr.data), qr.width, qr.height)?.data).toBe(s.url);
  const a = await guest(browser, s.url, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1' });
  const b = await guest(browser, s.url, { userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36' });
  await expect(a.page.locator('[data-recipient-name]')).toHaveText(/^你的设备：iOS-/);
  await expect(b.page.locator('[data-recipient-name]')).toHaveText(/^你的设备：Android-/);
  const aliases = new Map(await Promise.all([a.page, b.page].map(async (page) => [page, (await page.locator('[data-recipient-name]').textContent()).replace('你的设备：', '')])));
  // 预览并不消耗链接；两个独立访客同时点击，只有一个获得领取权。
  await Promise.all([a.page, b.page].map((page) => page.evaluate(() => document.querySelector('[data-claim]')?.click())));
  await expect(s.page.locator('[data-share-record]')).toHaveAttribute('data-status', 'completed');
  const recipient = (await a.page.locator('[data-save-index]').count()) ? a.page : b.page;
  const outsider = recipient === a.page ? b.page : a.page;
  await expect(recipient.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
  await expect(outsider.getByRole('heading', { level: 1 })).toHaveText('这份分享已被领取');
  await expect(s.page.locator('[data-share-record] [data-recipient-name]')).toHaveText(`接收设备：${aliases.get(recipient)}`);
  await expect(outsider.locator('[data-recipient-name]')).toHaveCount(0);
  await expect(outsider.locator('body')).not.toContainText(aliases.get(recipient));
  for (let i = 0; i < bundle.length; i += 1) {
    const downloadEvent = recipient.waitForEvent('download');
    // 按正常点击节奏保存，避免浏览器拦截一秒内连续十余次下载。
    await recipient.locator(`[data-save-index="${i}"]`).click({ delay: 150 });
    const download = await downloadEvent;
    expect(await readFile(await download.path())).toEqual(bundle[i].buffer);
  }
  const zipEvent = recipient.waitForEvent('download', { timeout: 15000 });
  await recipient.locator('[data-save-all]').click();
  const zip = await zipEvent;
  await zip.saveAs(testInfo.outputPath('分享文件.zip'));
  const archive = await readFile(await zip.path());
  expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  expect(archive.readUInt16LE(archive.length - 12)).toBe(10);
  const extra = await browser.newContext({ locale: 'zh-CN' });
  const again = await extra.newPage();
  await again.goto(s.url);
  await expect(again.getByRole('heading', { level: 1 })).toHaveText('这份分享已被领取');
  await expect(again.locator('[data-claim]')).toHaveCount(0);
  expect(await recipient.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  await s.page.setViewportSize({ width: 320, height: 800 });
  await recipient.setViewportSize({ width: 375, height: 812 });
  for (const page of [s.page, recipient]) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await recipient.screenshot({ path: testInfo.outputPath('mobile-received.png'), fullPage: true });
  await Promise.all([s.context.close(), a.context.close(), b.context.close(), extra.close()]);
});

test('recipient edits persist before claim, remain literal and appear in the sender record after verified transfer', async ({ browser, baseURL }, testInfo) => {
  const s = await sender(browser, baseURL, files.slice(0, 1));
  const a = await guest(browser, s.url, { viewport: { width: 320, height: 820 } }, () => localStorage.setItem('suichuan-name', '文铭的 iPhone'));
  await expect(a.page.locator('[data-recipient-name]')).toHaveText('你的设备：文铭的 iPhone');
  await a.page.getByRole('button', { name: '修改领取设备名称' }).click();
  await expect(a.page.locator('[data-claim]')).toBeDisabled();
  await a.page.getByLabel('你的设备名称', { exact: true }).fill('   ');
  await a.page.getByRole('button', { name: '保存名称' }).click();
  await expect(a.page.getByRole('alert')).toHaveText('请输入 1–24 个字符的设备名称');
  const name = '<b>工作手机</b>';
  await a.page.getByLabel('你的设备名称', { exact: true }).fill(name);
  await a.page.getByLabel('你的设备名称', { exact: true }).press('Enter');
  await expect(a.page.locator('[data-recipient-name]')).toHaveText(`你的设备：${name}`);
  await a.page.reload();
  await expect(a.page.locator('[data-recipient-name]')).toHaveText(`你的设备：${name}`);
  await a.page.getByRole('button', { name: '修改领取设备名称' }).click();
  await a.page.getByLabel('你的设备名称', { exact: true }).fill('不保存的名字');
  await a.page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(a.page.locator('[data-recipient-name]')).toHaveText(`你的设备：${name}`);
  await a.page.screenshot({ path: testInfo.outputPath('recipient-name-mobile.png'), fullPage: true });
  await a.page.locator('[data-claim]').click();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
  const event = a.page.waitForEvent('download');
  await a.page.locator('[data-save-index="0"]').click();
  expect(await readFile(await (await event).path())).toEqual(files[0].buffer);
  await a.page.evaluate(() => localStorage.setItem('suichuan-share-name', '随后改名'));
  await expect(s.page.locator('[data-share-record] [data-recipient-name]')).toHaveText(`接收设备：${name}`);
  await expect(s.page.locator('[data-share-record] b')).toHaveCount(0);
  await expect(a.page.locator('[data-recipient-name]')).toHaveText(`接收设备：${name}`);
  expect(await a.page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  await s.page.setViewportSize({ width: 320, height: 820 });
  for (const page of [a.page, s.page]) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await s.page.screenshot({ path: testInfo.outputPath('recipient-record-mobile.png'), fullPage: true });
  await Promise.all([s.context.close(), a.context.close()]);
});

test('guest can name and receive files when local storage is blocked', async ({ browser, baseURL }) => {
  const s = await sender(browser, baseURL, files.slice(0, 1));
  const a = await guest(browser, s.url, {}, () => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  const initial = await a.page.locator('[data-recipient-name]').textContent();
  await a.page.getByRole('button', { name: '修改领取设备名称' }).click();
  await a.page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(a.page.locator('[data-recipient-name]')).toHaveText(initial);
  await a.page.getByRole('button', { name: '修改领取设备名称' }).click();
  await a.page.getByLabel('你的设备名称', { exact: true }).fill('临时手机');
  await a.page.getByRole('button', { name: '保存名称' }).click();
  await a.page.locator('[data-claim]').click();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
  await expect(s.page.locator('[data-share-record] [data-recipient-name]')).toHaveText('接收设备：临时手机');
  await Promise.all([s.context.close(), a.context.close()]);
});

test('share cancellation prevents claim and sender refresh invalidates the share', async ({ browser, baseURL }) => {
  const s = await sender(browser, baseURL, files.slice(0, 1));
  const a = await guest(browser, s.url);
  s.page.once('dialog', (d) => d.accept());
  await s.page.locator('[data-share-panel]').getByRole('button', { name: '取消分享', exact: true }).click();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('分享已被取消');
  await expect(s.page.getByRole('button', { name: '创建新的分享' })).toHaveCount(0);
  await expect(s.page.locator('.share-upload .qt-attachment')).toHaveCount(0);
  await expect(s.page.locator('[data-share-generate]')).toBeDisabled();
  await expect(s.page.locator('[data-share-record][data-status="cancelled"]')).toBeVisible();
  await s.page.locator('[data-files]').setInputFiles(files.slice(0, 1));
  await s.page.locator('[data-share-generate]').click();
  const url = await s.page.locator('[data-share-url]').inputValue();
  await a.page.goto(url);
  await expect(a.page.locator('[data-claim]')).toBeEnabled();
  s.page.once('dialog', (d) => d.accept());
  await s.page.reload();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('分享已失效', { timeout: 25000 });
  await Promise.all([s.context.close(), a.context.close()]);
});

test('failed share transfer retries only unfinished files in the same recipient session', async ({ browser, baseURL }) => {
  const s = await sender(browser, baseURL, files);
  await s.page.evaluate(async () => {
    const { Transfers } = await import('/transfer.js');
    const original = Transfers.prototype.sendBytes;
    let failed = false;
    Transfers.prototype.sendBytes = async function (item) {
      if (item.shareIndex === 1 && !failed) {
        failed = true;
        throw new Error('模拟数据链路中断');
      }
      return original.call(this, item);
    };
  });
  const a = await guest(browser, s.url);
  await a.page.locator('[data-claim]').click();
  await expect(a.page.locator('[data-save-index="0"]')).toBeVisible();
  await expect(a.page.locator('[data-save-index="2"]')).toBeVisible();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('连接中断，可以重试');
  const before = await a.page.locator('[data-save-index="0"]').textContent();
  await a.page.getByRole('button', { name: '重试未完成的文件' }).click();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
  expect(await a.page.locator('[data-save-index="0"]').textContent()).toBe(before);
  await expect(s.page.locator('[data-share-record]')).toHaveAttribute('data-status', 'completed');
  await Promise.all([s.context.close(), a.context.close()]);
});

test('forced TURN one-time sharing verifies all file bytes', async ({ browser, baseURL }) => {
  test.skip(process.env.FORCE_RELAY !== '1', '需要本机 TURN 测试环境');
  const s = await sender(browser, baseURL, files);
  const a = await guest(browser, s.url);
  await a.page.locator('[data-claim]').click();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
  for (let index = 0; index < files.length; index += 1) {
    const event = a.page.waitForEvent('download');
    await a.page.locator(`[data-save-index="${index}"]`).click();
    expect(await readFile(await (await event).path())).toEqual(files[index].buffer);
  }
  await Promise.all([s.context.close(), a.context.close()]);
});

test('claim notification loss recovers from the state snapshot and finished share records can be cleared', async ({ browser, baseURL }) => {
  const s = await sender(browser, baseURL, files.slice(0, 1));
  await s.page.evaluate(async () => {
    const { Connection } = await import('/connection.js');
    const emit = Connection.prototype.emit;
    let dropped = false;
    Connection.prototype.emit = function (type, data) {
      if (type === 'share.claimed' && !dropped) {
        dropped = true;
        return;
      }
      return emit.call(this, type, data);
    };
  });
  const a = await guest(browser, s.url);
  await a.page.locator('[data-claim]').click();
  await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
  await s.page.locator('[data-action="clear"]').click();
  await expect(s.page.locator('[data-share-record]')).toHaveCount(0);
  await expect(s.page.locator('[data-share-generate]')).toBeVisible();
  await expect(s.page.locator('.qt-transfers')).toBeHidden();
  await s.page.getByRole('tab', { name: '发送给设备', exact: true }).click();
  await expect(s.page.locator('.qt-transfers')).toBeHidden();
  await expect(s.page.getByText('发出的内容和收到的内容会出现在这里', { exact: true })).toHaveCount(0);
  await expect(s.page.locator('.qt-history-footer > span')).toBeHidden();
  await s.page.getByRole('tab', { name: '链接分享', exact: true }).click();
  await expect(s.page.locator('.qt-transfers')).toBeHidden();
  await Promise.all([s.context.close(), a.context.close()]);
});

test('P2P sharing transfers 257 MiB beyond all previous file, bundle and receive limits', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(300000);
  await mkdir(testInfo.outputDir, { recursive: true });
  const path = testInfo.outputPath('257MiB.bin');
  const content = Buffer.alloc(1048576, 39);
  const expected = createHash('sha256');
  const file = await open(path, 'w');
  try {
    for (let i = 0; i < 257; i += 1) {
      await file.write(content);
      expected.update(content);
    }
  } finally {
    await file.close();
  }
  const s = await sender(browser, baseURL, [path]);
  const a = await guest(browser, s.url);
  try {
    await a.page.locator('[data-claim]').click();
    await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成', { timeout: 270000 });
    const event = a.page.waitForEvent('download');
    await a.page.locator('[data-save-index="0"]').click();
    const actual = createHash('sha256');
    for await (const chunk of createReadStream(await (await event).path())) {
      actual.update(chunk);
    }
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
  } finally {
    await rm(path);
    await Promise.all([s.context.close(), a.context.close()]);
  }
});

test('forced TURN rejects files above 50 MiB with a clear reason and no file payload', async ({ browser, baseURL }, testInfo) => {
  test.skip(process.env.FORCE_RELAY !== '1', '需要本机 TURN 测试环境');
  await mkdir(testInfo.outputDir, { recursive: true });
  const path = testInfo.outputPath('over-relay-limit.bin');
  const file = await open(path, 'w');
  await file.truncate(50 * 1048576 + 1);
  await file.close();
  const s = await sender(browser, baseURL, [path]);
  const a = await guest(browser, s.url);
  try {
    await s.page.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      window.sentFileBytes = 0;
      Transfers.prototype.sendBytes = async function () { window.sentFileBytes += 1; };
    });
    await a.page.locator('[data-claim]').click();
    await expect(a.page.getByRole('alert')).toContainText('服务器中转单个文件不能超过 50 MB');
    await expect(s.page.locator('[data-share-panel]')).toContainText('服务器中转单个文件不能超过 50 MB');
    expect(await s.page.evaluate(() => window.sentFileBytes)).toBe(0);
    await expect(a.page.locator('[data-save-index]')).toHaveCount(0);
    await a.page.screenshot({ path: testInfo.outputPath('中转超限提示.png'), fullPage: true });
  } finally {
    await rm(path);
    await Promise.all([s.context.close(), a.context.close()]);
  }
});

test('completed sharing becomes a compact result; history details stay inline while creating another share', async ({ browser, baseURL }, testInfo) => {
  const file = { name: 'whiteboard_exported_image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64') };
  const s = await sender(browser, baseURL, [file]);
  const recipient = await guest(browser, s.url, {}, () => localStorage.setItem('suichuan-name', '工作用 MacBook'));
  try {
    await recipient.page.locator('[data-claim]').click();
    const record = s.page.locator('[data-share-record][data-status="completed"]');
    const panel = s.page.locator('[data-share-panel]');
    await expect(record).toHaveCount(1);
    await expect(panel.getByRole('heading', { name: '分享已完成' })).toBeVisible();
    await expect(panel).not.toContainText(file.name);
    await expect(panel).not.toContainText('接收设备');
    await expect(panel.locator('.share-files')).toHaveCount(0);
    await expect(panel.locator('[data-share-url], .share-qr')).toHaveCount(0);
    await expect(record.locator('[data-recipient-name]')).toHaveText('接收设备：工作用 MacBook');
    await expect(record.locator('.share-record-details')).toBeHidden();
    for (const [width, scheme] of [[1280, 'light'], [375, 'light'], [320, 'dark']]) {
      await s.page.setViewportSize({ width, height: 850 });
      await s.page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await s.page.screenshot({ path: testInfo.outputPath(`分享完成-${width}-${scheme}.png`), fullPage: true });
    }
    await record.getByRole('button', { name: '查看详情' }).focus();
    await s.page.keyboard.press('Enter');
    const collapse = record.getByRole('button', { name: '收起详情' });
    await expect(collapse).toBeFocused();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(record.locator('.share-record-details')).toContainText(file.name);
    await expect(record.locator('.share-record-details')).toContainText('已校验');
    await expect(record.getByRole('region', { name: '分享文件', exact: true })).toContainText(file.name);
    await expect(record.getByRole('region', { name: '领取设备', exact: true })).toContainText('工作用 MacBook');
    await expect(panel.getByRole('heading', { name: '分享已完成' })).toBeVisible();
    await s.page.screenshot({ path: testInfo.outputPath('分享详情-320-dark.png'), fullPage: true });
    await s.page.setViewportSize({ width: 1280, height: 850 });
    await s.page.emulateMedia({ colorScheme: 'light' });
    await s.page.screenshot({ path: testInfo.outputPath('分享详情-1280-light.png'), fullPage: true });
    await panel.getByRole('button', { name: '创建新的分享' }).click();
    await expect(panel.getByRole('button', { name: '添加附件', exact: true })).toBeFocused();
    await expect(s.page.locator('[data-share-generate]')).toBeDisabled();
    await s.page.locator('[data-files]').setInputFiles([file]);
    await s.page.locator('[data-share-generate]').click();
    const link = s.page.locator('[data-share-url]');
    await expect(link).toBeVisible();
    const newUrl = await link.inputValue();
    expect(newUrl).not.toBe(s.url);
    await collapse.click();
    await record.getByRole('button', { name: '查看详情' }).click();
    await expect(record.locator('.share-record-details')).toBeVisible();
    await expect(link).toHaveValue(newUrl);
    await expect(s.page.locator('.share-qr')).toBeVisible();
    await s.page.getByRole('tab', { name: '发送给设备', exact: true }).click();
    await expect(s.page.locator('[data-share-records]')).toBeHidden();
    await s.page.getByRole('tab', { name: '链接分享', exact: true }).click();
    await s.page.locator('[data-share-record][data-status="ready"]').getByRole('button', { name: '查看分享' }).click();
    await expect(link).toHaveValue(newUrl);
    await expect(panel.getByRole('button', { name: '复制链接', exact: true })).toBeFocused();
    s.page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: '取消分享', exact: true }).click();
    await expect(panel.getByRole('button', { name: '添加附件', exact: true })).toBeFocused();
    await expect(panel.locator('[data-share-generate]')).toBeDisabled();
    await expect(s.page.locator('[data-share-record][data-status="cancelled"] .share-record-details')).toBeHidden();
    const downloadEvent = recipient.page.waitForEvent('download');
    await recipient.page.locator('[data-save-index="0"]').click();
    expect(await readFile(await (await downloadEvent).path())).toEqual(file.buffer);
    await s.page.locator('[data-action="clear"]').click();
    await expect(s.page.locator('[data-share-record]')).toHaveCount(0);
    await expect(s.page.locator('[data-share-generate]')).toBeVisible();
  } finally {
    await Promise.all([s.context.close(), recipient.context.close()]);
  }
});

async function verifyDownloads(page, bundle) {
  for (let index = 0; index < bundle.length; index += 1) {
    const event = page.waitForEvent('download');
    await page.locator(`[data-save-index="${index}"]`).click();
    expect(await readFile(await (await event).path())).toEqual(bundle[index].buffer);
  }
}
async function holdShare(senderPage) {
  await senderPage.evaluate(async () => {
    const { Transfers } = await import('/transfer.js');
    const original = Transfers.prototype.sendBytes;
    window.shareStartedClaims = [];
    const gate = new Promise((resolve) => { window.releaseShare = resolve; });
    Transfers.prototype.sendBytes = async function (item) {
      window.shareStartedClaims.push(item.claimId);
      await gate;
      return original.call(this, item);
    };
  });
}

test('share history aligns with its composer and details separate shared files from receiving devices', async ({ browser, baseURL }, testInfo) => {
  const s = await sender(browser, baseURL, files, 'multiple');
  try {
    const record = s.page.locator('[data-share-record]');
    await record.getByRole('button', { name: '查看详情', exact: true }).click();
    const sharedFiles = record.getByRole('region', { name: '分享文件', exact: true });
    const devices = record.getByRole('region', { name: '领取设备', exact: true });
    await expect(sharedFiles.locator('.share-file-name')).toHaveText(files.map((file) => file.name));
    await expect(devices).toContainText('已领取 0 次');
    await expect(devices).toContainText('还没有人领取');
    await expect(devices.locator('.share-file')).toHaveCount(0);
    for (const [width, scheme] of [[1280, 'light'], [768, 'light'], [375, 'light'], [320, 'dark']]) {
      await s.page.setViewportSize({ width, height: 900 });
      await s.page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await s.page.getByRole('tab', { name: '发送给设备', exact: true }).click();
      await expect(record).toBeHidden();
      await expect(s.page.locator('.qt-transfers')).toBeHidden();
      await s.page.getByRole('tab', { name: '链接分享', exact: true }).click();
      const area = await s.page.locator('[data-share-panel]').boundingBox();
      const card = await record.boundingBox();
      const heading = await s.page.locator('.qt-section-heading').boundingBox();
      const title = await s.page.locator('.qt-section-heading h2 > span').first().boundingBox();
      expect(card.x).toBeCloseTo(area.x, 1);
      expect(card.width).toBeCloseTo(area.width, 1);
      expect(heading.x).toBeCloseTo(area.x, 1);
      expect(title.x).toBeCloseTo(area.x, 1);
      await expect(sharedFiles).toBeVisible();
      await expect(devices).toBeVisible();
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await record.screenshot({ path: testInfo.outputPath(`分享详情-空领取设备-${width}-${scheme}.png`) });
    }
    await s.page.locator('[data-locale]').selectOption('en');
    await expect(record.getByRole('region', { name: 'Shared files', exact: true })).toContainText(files[0].name);
    await expect(record.getByRole('region', { name: 'Receiving devices', exact: true })).toContainText('0 claims received');
    expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await s.context.close();
  }
});

test('viewing the current multiple share gives visible feedback even when the page cannot scroll', async ({ browser, baseURL }, testInfo) => {
  const s = await sender(browser, baseURL, files.slice(0, 1), 'multiple');
  try {
    const panel = s.page.locator('[data-share-panel]');
    const view = s.page.locator('[data-share-record]').getByRole('button', { name: '查看分享', exact: true });
    const copy = panel.getByRole('button', { name: '复制链接', exact: true });
    await s.page.setViewportSize({ width: 1280, height: 1200 });
    expect(await s.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 0 次');
    await expect(panel.locator('[data-share-expiry]')).toHaveText('分享有效期剩余 10 分钟 · 不限领取人数');
    const before = await panel.boundingBox();
    await expect(view).toHaveAttribute('aria-controls', 'share-composer');
    await view.click();
    await expect(copy).toBeFocused();
    await expect(panel.locator('[data-share-url]')).toHaveValue(s.url);
    await expect(s.page.getByRole('status')).toHaveText('已在上方显示这份分享');
    await expect(panel).toHaveCSS('outline-style', 'solid');
    await expect(panel).toHaveCSS('outline-width', '2px');
    expect((await panel.boundingBox()).y).toBeCloseTo(before.y, 1);
    await s.page.screenshot({ path: testInfo.outputPath('查看当前分享-反馈.png'), fullPage: true });
    await expect(panel).toHaveCSS('outline-style', 'none');

    for (const [width, scheme, reducedMotion] of [[1280, 'light', 'no-preference'], [375, 'dark', 'reduce']]) {
      await s.page.setViewportSize({ width, height: 600 });
      await s.page.emulateMedia({ colorScheme: scheme, reducedMotion });
      await s.page.getByRole('tab', { name: '发送给设备', exact: true }).click();
      await expect(view).toBeHidden();
      await s.page.getByRole('tab', { name: '链接分享', exact: true }).click();
      await view.click();
      await expect(s.page.getByRole('tab', { name: '链接分享', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(copy).toBeFocused();
      await expect(panel).toBeInViewport();
      await expect(s.page.locator('[data-share-url]')).toHaveValue(s.url);
      await expect(s.page.getByRole('status')).toHaveText('已在上方显示这份分享');
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await s.page.locator('[data-locale]').selectOption('en');
    await expect(s.page.getByRole('status')).toHaveText('This share is shown above.');
    await expect(s.page.locator('.share-counts')).toHaveText('0 claims received');
    await expect(panel.locator('[data-share-expiry]')).toHaveText('Share expires in 10 minutes · Unlimited recipients');
    await expect(panel.getByRole('button', { name: 'End share', exact: true })).toBeVisible();
    await s.page.locator('[data-share-record]').getByRole('button', { name: 'View share', exact: true }).click();
    await expect(s.page.getByRole('status')).toHaveText('This share is shown above.');
  } finally {
    await s.context.close();
  }
});

test('ending a multiple share cancels active and queued claims while keeping its record', async ({ browser, baseURL }) => {
  const s = await sender(browser, baseURL, files.slice(0, 1), 'multiple');
  const guests = [];
  try {
    await holdShare(s.page);
    const preview = await guest(browser, s.url);
    guests.push(preview);
    const recipients = [];
    for (let i = 0; i < 4; i += 1) {
      const g = await guest(browser, s.url);
      recipients.push(g);
      guests.push(g);
    }
    await Promise.all(recipients.map((g) => g.page.locator('[data-claim]').click()));
    const record = s.page.locator('[data-share-record]');
    await record.getByRole('button', { name: '查看详情' }).click();
    await expect(record.locator('[data-claim-state="transferring"]')).toHaveCount(3);
    await expect(record.locator('[data-claim-state="queued"]')).toHaveCount(1);
    const devices = record.getByRole('region', { name: '领取设备', exact: true });
    await expect(devices.locator('[data-claim-state="transferring"] .share-claim-status')).toHaveText(['0%', '0%', '0%']);
    await expect(devices.locator('[data-claim-state="queued"] .share-claim-status')).toHaveText('等待领取');
    await expect(devices).toContainText('已领取 0 次');
    await expect(devices).not.toContainText(/前面\s*\d+|\d+\s*次(?:传输中|排队)/);
    await expect(devices.locator('[data-claim-state="transferring"] progress')).toHaveCount(3);
    await expect(devices.locator('[data-claim-state="queued"] progress')).toHaveCount(0);
    await expect(record.locator('.share-counts')).toHaveText('已领取 0 次');
    const panel = s.page.locator('[data-share-panel]');
    const end = panel.getByRole('button', { name: '结束分享', exact: true });
    s.page.once('dialog', (dialog) => dialog.dismiss());
    await end.click();
    await expect(panel.locator('[data-share-url]')).toHaveValue(s.url);
    await expect(record.locator('[data-claim-state="queued"]')).toHaveCount(1);
    s.page.once('dialog', (dialog) => dialog.accept());
    await end.click();
    await expect(panel.getByRole('heading', { name: '分享已结束', exact: true })).toBeVisible();
    await expect(panel.locator('[data-share-url], .share-qr')).toHaveCount(0);
    await expect(record).toHaveAttribute('data-status', 'cancelled');
    await expect(record.locator('[data-claim-state="cancelled"]')).toHaveCount(4);
    await expect(record.locator('.share-counts')).toHaveText('已领取 0 次');
    await expect(preview.page.getByRole('heading', { level: 1 })).toHaveText('分享已被取消');
    await expect(preview.page.locator('[data-claim]')).toHaveCount(0);
    for (const g of recipients) {
      await expect(g.page.getByRole('heading', { level: 1 })).toHaveText('本次领取已取消');
    }
  } finally {
    await Promise.all([s.context.close(), ...guests.map((g) => g.context.close())]);
  }
});

test('multiple sharing runs three recipients concurrently, queues a fourth and keeps accepting after twelve completions', async ({ browser, baseURL }, testInfo) => {
  const bundle = [{ name: '多人同时领取.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512 * 1024, 119) }];
  const s = await sender(browser, baseURL, bundle, 'multiple');
  const guests = [];
  try {
    await holdShare(s.page);
    for (let i = 0; i < 4; i += 1) {
      guests.push(await guest(browser, s.url, {}, () => localStorage.setItem('suichuan-name', `领取设备-${crypto.randomUUID().slice(0, 4)}`)));
    }
    await Promise.all(guests.map((g) => g.page.locator('[data-claim]').click()));
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 0 次');
    await expect.poll(() => s.page.evaluate(() => new Set(window.shareStartedClaims).size)).toBe(3);
    await expect(s.page.locator('[data-share-url]')).toHaveValue(s.url);
    await s.page.locator('[data-share-record]').getByRole('button', { name: '查看详情' }).click();
    await expect(s.page.locator('[data-claim-state="transferring"]')).toHaveCount(3);
    await expect(s.page.locator('[data-claim-state="queued"]')).toHaveCount(1);
    for (const width of [1280, 375, 320]) {
      await s.page.setViewportSize({ width, height: 850 });
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await s.page.screenshot({ path: testInfo.outputPath(`多人领取排队-${width}.png`), fullPage: true });
    }
    await s.page.evaluate(() => window.releaseShare());
    for (const g of guests) {
      await expect(g.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
      await verifyDownloads(g.page, bundle);
    }
    for (let i = 4; i < 12; i += 1) {
      const g = await guest(browser, s.url);
      guests.push(g);
      await g.page.locator('[data-claim]').click();
      await expect(g.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
      await verifyDownloads(g.page, bundle);
    }
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 12 次');
    await expect(s.page.locator('[data-share-url]')).toHaveValue(s.url);
    await s.page.setViewportSize({ width: 1280, height: 850 });
    await s.page.screenshot({ path: testInfo.outputPath('多人领取完成-1280.png'), fullPage: true });
    s.page.once('dialog', (d) => d.accept());
    await s.page.getByRole('button', { name: '结束分享', exact: true }).click();
    await expect(s.page.locator('[data-share-panel]')).toContainText('分享已结束');
    await guests[0].page.reload();
    await expect(guests[0].page.getByRole('heading', { level: 1 })).toHaveText('分享已被取消');
    await verifyDownloads(guests[1].page, bundle);
    await s.page.getByRole('button', { name: '创建新的分享' }).click();
    await expect(s.page.locator('[data-share-settings]')).not.toHaveAttribute('open');
    await expect(s.page.locator('[data-share-mode="single"]')).toBeChecked();
    await expect(s.page.locator('[data-share-description]')).toContainText('默认一次领取');
    const settings = s.page.locator('[data-share-settings]');
    for (const [width, scheme] of [[1280, 'light'], [320, 'dark']]) {
      await s.page.setViewportSize({ width, height: 850 });
      await s.page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await s.page.screenshot({ path: testInfo.outputPath(`分享设置-收起-${width}.png`), fullPage: true });
      await settings.getByText('更多设置', { exact: true }).click();
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await s.page.screenshot({ path: testInfo.outputPath(`分享设置-展开-${width}.png`), fullPage: true });
      await settings.getByText('更多设置', { exact: true }).click();
    }
    await settings.getByText('更多设置', { exact: true }).click();
    await s.page.getByLabel('链接有效期', { exact: true }).selectOption('30');
    await s.page.getByRole('radio', { name: '多人领取', exact: true }).check();
    await expect(s.page.getByRole('radio', { name: '多人领取', exact: true })).toBeFocused();
    await expect(s.page.getByLabel('链接有效期', { exact: true })).toHaveValue('30');
    await settings.getByText('更多设置', { exact: true }).click();
    await expect(s.page.locator('[data-share-description]')).toContainText('已开启多人领取');
    await s.page.locator('[data-files]').setInputFiles(bundle);
    await s.page.locator('[data-share-generate]').click();
    await expect(s.page.locator('[data-share-expiry]')).toHaveText('分享有效期剩余 30 分钟 · 不限领取人数');
    const end = s.page.getByRole('button', { name: '结束分享', exact: true });
    await expect(end).toBeVisible();
    await expect(s.page.getByText('更多操作', { exact: true })).toHaveCount(0);
    await expect(s.page.getByRole('button', { name: '停止新领取', exact: true })).toHaveCount(0);
    s.page.once('dialog', (dialog) => dialog.accept());
    await end.click();
    const endedRecords = s.page.locator('[data-share-record][data-status="cancelled"]');
    await expect(endedRecords).toHaveCount(2);
    await expect(endedRecords.first()).toBeVisible();
    await expect(s.page.locator('[data-share-panel]')).toContainText('分享已结束');
    await expect(s.page.getByRole('button', { name: '创建新的分享' })).toBeFocused();
    await s.page.getByRole('button', { name: '创建新的分享' }).click();
    await expect(s.page.locator('[data-share-generate]')).toBeDisabled();
    await expect(settings).not.toHaveAttribute('open');
    await expect(s.page.locator('[data-share-mode="single"]')).toBeChecked();
    await expect(s.page.locator('[data-share-control="expiry"]')).toHaveValue('10');
  } finally {
    await Promise.all([s.context.close(), ...guests.map((g) => g.context.close())]);
  }
});

test('one failed multiple recipient retries unfinished files without resending successes or affecting another recipient', async ({ browser, baseURL }) => {
  const s = await sender(browser, baseURL, files, 'multiple');
  const guests = [];
  try {
    await s.page.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const original = Transfers.prototype.sendBytes;
      let firstClaim;
      let failed = false;
      window.shareAttempts = [];
      Transfers.prototype.sendBytes = async function (item) {
        firstClaim ||= item.claimId;
        window.shareAttempts.push({ claimId: item.claimId, index: item.shareIndex });
        if (item.claimId === firstClaim && item.shareIndex === 1 && !failed) {
          failed = true;
          throw new Error('验收：首次链路故障');
        }
        return original.call(this, item);
      };
    });
    const a = await guest(browser, s.url);
    const b = await guest(browser, s.url);
    guests.push(a, b);
    await a.page.locator('[data-claim]').click();
    await b.page.locator('[data-claim]').click();
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
    await expect(a.page.locator('[data-save-index="0"]')).toBeVisible();
    await expect(a.page.locator('[data-save-index="2"]')).toBeVisible();
    await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('连接中断，可以重试');
    const before = await s.page.evaluate(() => window.shareAttempts);
    await a.page.getByRole('button', { name: '重试未完成的文件' }).click();
    await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
    const after = await s.page.evaluate(() => window.shareAttempts);
    expect(after.length - before.length).toBe(1);
    expect(after.at(-1).index).toBe(1);
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 2 次');
    await expect(s.page.locator('[data-share-url]')).toHaveValue(s.url);
    await verifyDownloads(a.page, files);
    await verifyDownloads(b.page, files);
  } finally {
    await Promise.all([s.context.close(), ...guests.map((g) => g.context.close())]);
  }
});

test('single expiry closes the preview; multiple expiry drains admitted claims and preserves completed downloads', async ({ browser, baseURL }) => {
  const clockFile = `/tmp/suichuan-e2e-clock-${new URL(baseURL).port}`;
  const guests = [];
  const bundle = files.slice(0, 1);
  const s = await sender(browser, baseURL, bundle);
  try {
    const preview = await guest(browser, s.url);
    guests.push(preview);
    await writeFile(clockFile, '600001');
    await expect(preview.page.getByRole('heading', { level: 1 })).toHaveText('这份分享已过期');
    await expect(s.page.locator('[data-share-panel]')).toContainText('分享已过期');
    await expect(preview.page.locator('[data-claim]')).toHaveCount(0);
    await writeFile(clockFile, '0');
    await s.page.getByRole('button', { name: '创建新的分享' }).click();
    await s.page.getByText('更多设置', { exact: true }).click();
    await s.page.locator('[data-share-mode="multiple"]').click();
    await s.page.locator('[data-files]').setInputFiles(bundle);
    await s.page.locator('[data-share-generate]').click();
    const url = await s.page.locator('[data-share-url]').inputValue();
    await writeFile(clockFile, '590000');
    await holdShare(s.page);
    const current = [];
    for (let i = 0; i < 4; i += 1) {
      const g = await guest(browser, url);
      current.push(g);
      guests.push(g);
    }
    await Promise.all(current.map((g) => g.page.locator('[data-claim]').click()));
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 0 次');
    await writeFile(clockFile, '600001');
    await expect(s.page.locator('[data-share-panel]')).toContainText('已停止新的领取');
    await preview.page.goto(url);
    await expect(preview.page.getByRole('heading', { level: 1 })).toHaveText('分享已停止新的领取');
    await expect(preview.page.locator('[data-claim]')).toHaveCount(0);
    await s.page.evaluate(() => window.releaseShare());
    for (const g of current) {
      await expect(g.page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
      await verifyDownloads(g.page, bundle);
    }
    await expect(s.page.locator('[data-share-panel]')).toContainText('分享已过期');
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 4 次');
  } finally {
    await writeFile(clockFile, '0');
    await Promise.all([s.context.close(), ...guests.map((g) => g.context.close())]);
  }
});
