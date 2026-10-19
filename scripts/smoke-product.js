import { chromium, expect as baseExpect } from '@playwright/test';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// One set of isolated devices exercises the release without exhausting production pairing limits.
const origin = new URL(process.argv[2] || 'http://localhost:18942').origin;
const artifacts = resolve(process.env.XCOPY_ARTIFACTS || 'test-results/product-smoke');
const waitRelease = process.argv.includes('--wait-release');
const expect = baseExpect.configure({ timeout: 25000 });
const report = { origin, startedAt: new Date().toISOString(), checks: [], downloads: [], errors: [] };
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const devices = [];
const suffix = Date.now().toString(36);
let a; let b; let c;

async function step(name, action) {
  const started = Date.now();
  await action();
  report.checks.push({ name, status: 'passed', milliseconds: Date.now() - started });
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`通过：${name}`);
}

async function openPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.goto(`${origin}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  return page;
}

async function device(name) {
  const context = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  const entry = { context };
  devices.push(entry);
  entry.page = await openPage(context);
  await entry.page.locator('[data-action="devices"]').click();
  await entry.page.locator('[data-name-input]').fill(name);
  await entry.page.locator('[data-action="rename"]').click();
  await expect(entry.page.locator('.qt-overlay')).toBeHidden();
  entry.id = await entry.page.evaluate(async () => (await (await import('/identity.js')).loadIdentity()).fingerprint);
  return entry;
}

async function pair(owner, requester) {
  await owner.locator('[data-action="connect"]').click();
  await expect(owner.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  const code = (await owner.locator('[data-code]').textContent()).replace(/\s/g, '');
  await requester.locator('[data-action="connect"]').click();
  await requester.getByRole('tab', { name: '输入连接码' }).click();
  await requester.getByRole('textbox', { name: '8 位连接码' }).fill(code);
  await requester.locator('[data-action="join"]').click();
  await expect(owner.locator('[data-approval-panel]')).toBeVisible();
  await owner.getByRole('button', { name: '允许并记住' }).click();
  await expect(owner.locator('.qt-overlay')).toBeHidden();
  await expect(requester.locator('.qt-overlay')).toBeHidden();
}

async function sendText(from, to, message) {
  await from.locator('[data-editor]').fill(message);
  await from.locator('[data-action="send"]').click();
  await expect(to.locator('[data-incoming="true"][data-status="completed"] pre').filter({ hasText: message.trim() })).toHaveText(message);
}

async function dialogAction(page, action, type, accept = false) {
  const shown = page.waitForEvent('dialog');
  const operation = action();
  const dialog = await shown;
  expect(dialog.type()).toBe(type);
  if (accept) {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
  await operation;
}

async function fixtureImage(page, mime) {
  const base64 = await page.evaluate((type) => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 3;
    const paint = canvas.getContext('2d');
    paint.fillStyle = '#24a148';
    paint.fillRect(0, 0, 4, 3);
    return canvas.toDataURL(type).split(',')[1];
  }, mime);
  return { name: mime === 'image/png' ? '验收截图.png' : '验收照片.jpg', mimeType: mime, buffer: Buffer.from(base64, 'base64') };
}

async function sendFiles(page, files) {
  await page.locator('[data-files]').setInputFiles(files);
  await page.locator('[data-action="send"]').click();
}

function incoming(page, name) {
  return page.locator('[data-incoming="true"][data-status="completed"]').filter({ hasText: name });
}

async function save(page, file) {
  const downloading = page.waitForEvent('download');
  await incoming(page, file.name).locator('[data-action="save-file"]').click();
  const downloaded = await downloading;
  const bytes = await readFile(await downloaded.path());
  expect(bytes.equals(file.buffer)).toBe(true);
  report.downloads.push({ name: file.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

try {
  await step('连接码审批配对，两组独立测试关系', async () => {
    a = await device(`上线验收发送-${suffix}`);
    b = await device(`上线验收接收-${suffix}`);
    c = await device(`上线验收接收-${suffix}`);
    await pair(a.page, b.page);
    await pair(a.page, c.page);
    await a.page.locator('[data-target]').selectOption(b.id);
    await sendText(a.page, b.page, '发布前配对探测');
    report.devices = devices.map(({ id }) => id);
  });
  if (waitRelease) {
    const marker = join(artifacts, 'release-ready');
    await expect(access(marker).then(() => true, () => false)).resolves.toBe(false);
    await writeFile(join(artifacts, 'prepared.json'), JSON.stringify({ ...report, waitingFor: marker }, null, 2));
    console.log(`发布前配对已完成，等待标记：${marker}`);
    await expect.poll(() => access(marker).then(() => true, () => false), { timeout: 1200000, intervals: [1000] }).toBe(true);
  }
  await step('刷新后保留设备身份、名称和两组配对，双向文字逐字一致', async () => {
    for (const entry of [a, b, c]) {
      await entry.page.reload();
      await expect(entry.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
      expect(await entry.page.evaluate(async () => (await (await import('/identity.js')).loadIdentity()).fingerprint)).toBe(entry.id);
    }
    await expect(a.page.locator('[data-local-name]')).toHaveText(`上线验收发送-${suffix}`);
    await expect(a.page.locator('[data-target] option')).toHaveCount(3);
    await expect(a.page.locator('[data-target]')).toHaveValue(b.id);
    await sendText(a.page, b.page, '  中文\n<script>仅为文字</script> 🍓\t保留空白  ');
    await sendText(b.page, a.page, '接收端反向发送确认');
  });
  await step('首次引导、一次性命名、空白校验和 320px 窄屏', async () => {
    const context = await browser.newContext({ locale: 'zh-CN' });
    const entry = { context, page: await openPage(context) };
    devices.push(entry);
    const page = entry.page;
    await expect(page.getByRole('region', { name: '首次连接引导' })).toBeVisible();
    await expect(page.locator('[data-action="send"]')).toBeDisabled();
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(artifacts, `首次连接-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: '连接第一台设备' }).click();
    await expect(page.getByRole('heading', { name: '给这台设备起个名字' })).toBeVisible();
    await page.getByRole('textbox', { name: '本机名称' }).fill('   ');
    await page.getByRole('button', { name: '保存并继续' }).click();
    await expect(page.getByRole('alert')).toHaveText('请输入 1–24 个字符的设备名称');
    await page.getByRole('textbox', { name: '本机名称' }).fill(`  首次引导-${suffix}  `);
    await page.getByRole('textbox', { name: '本机名称' }).press('Enter');
    await expect(page.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
    await page.reload();
    await expect(page.locator('[data-local-name]')).toHaveText(`首次引导-${suffix}`);
    await page.locator('[data-action="connect"]').click();
    await expect(page.locator('[data-code]')).toBeVisible();
    await expect(page.locator('[data-onboarding-name-panel]')).toBeHidden();
    await context.close();
  });
  await step('同名设备区分，离线与刷新不改发，回线后恢复原目标', async () => {
    const labels = await a.page.locator('[data-target] option:not([value="all-online"])').allTextContents();
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/ · [a-f0-9]+$/);
    expect(labels[1]).toMatch(/ · [a-f0-9]+$/);
    expect(labels[0]).not.toBe(labels[1]);
    await b.page.close();
    await expect(a.page.locator('[data-target] option:checked')).toContainText('已离线');
    await a.page.locator('[data-editor]').fill('不得误发另一台在线设备');
    await expect(a.page.locator('[data-action="send"]')).toBeDisabled();
    await a.page.locator('[data-editor]').press('ControlOrMeta+Enter');
    await expect(c.page.locator('[data-transfer]')).toHaveCount(0);
    await a.page.reload();
    await expect(a.page.locator('[data-target] option:checked')).toContainText('已离线');
    b.page = await openPage(b.context);
    await expect(a.page.locator('[data-target]')).toHaveValue(b.id);
    await sendText(a.page, b.page, '回线后仍发送到原目标');
    await expect(c.page.locator('[data-transfer]')).toHaveCount(0);
  });
  await step('文件传输、刷新/关闭/清空拦截，保存后释放提醒', async () => {
    const file = { name: '验收-2MiB.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, 91) };
    await sendFiles(a.page, file);
    await expect(incoming(b.page, file.name)).toHaveCount(1);
    await expect(b.page.locator('[data-unsaved-note]')).toContainText('还有 1 个文件');
    await b.page.locator('[data-editor]').click();
    await dialogAction(b.page, () => b.page.evaluate(() => location.reload()), 'beforeunload');
    await dialogAction(b.page, () => b.page.close({ runBeforeUnload: true }), 'beforeunload');
    expect(b.page.isClosed()).toBe(false);
    await dialogAction(b.page, () => b.page.getByRole('button', { name: '清空已结束记录' }).click(), 'confirm');
    await expect(incoming(b.page, file.name)).toHaveCount(1);
    await b.page.screenshot({ path: join(artifacts, '未保存文件提醒.png'), fullPage: true });
    await save(b.page, file);
    await expect(b.page.locator('[data-unsaved-note]')).toBeHidden();
    await expect(incoming(b.page, file.name)).toContainText('已发起下载，请确认文件已保存');
    const unexpected = [];
    const handle = async (dialog) => { unexpected.push(dialog.type()); await dialog.accept(); };
    b.page.on('dialog', handle);
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    b.page.off('dialog', handle);
    expect(unexpected).toEqual([]);
    const empty = { name: '验收-空文件.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) };
    await sendFiles(b.page, empty);
    await expect(incoming(a.page, empty.name)).toHaveCount(1);
    await save(a.page, empty);
  });
  await step('PNG/JPEG 复制真实剪贴板像素，图片预览与窄屏', async () => {
    const images = [await fixtureImage(a.page, 'image/png'), await fixtureImage(a.page, 'image/jpeg')];
    await sendFiles(a.page, images);
    await b.page.bringToFront();
    for (const file of images) {
      const row = incoming(b.page, file.name);
      await expect(row).toHaveCount(1);
      await row.getByRole('button', { name: '复制图片' }).click();
      await expect(row).toContainText('已复制图片，可粘贴到其他应用');
      const image = await b.page.evaluate(async () => {
        const entries = await navigator.clipboard.read();
        const bitmap = await createImageBitmap(await entries[0].getType('image/png'));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const paint = canvas.getContext('2d');
        paint.drawImage(bitmap, 0, 0);
        const result = { width: bitmap.width, height: bitmap.height, pixel: [...paint.getImageData(0, 0, 1, 1).data] };
        bitmap.close();
        return result;
      });
      expect(image.width).toBe(4);
      expect(image.height).toBe(3);
      for (const [index, value] of [36, 161, 72].entries()) {
        expect(Math.abs(image.pixel[index] - value)).toBeLessThan(6);
      }
      await save(b.page, file);
    }
    await expect(b.page.locator('[data-unsaved-note]')).toBeHidden();
    await b.page.locator('.qt-received-image').first().click();
    await expect(b.page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
    await b.page.keyboard.press('Escape');
    await b.page.setViewportSize({ width: 320, height: 900 });
    expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await b.page.screenshot({ path: join(artifacts, '复制图片-320.png'), fullPage: true });
    await b.page.setViewportSize({ width: 1280, height: 900 });
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  });
  await step('复制权限拒绝/浏览器不支持时可保存，清空必须确认', async () => {
    const file = await fixtureImage(a.page, 'image/png');
    await sendFiles(a.page, file);
    await expect(incoming(b.page, file.name)).toHaveCount(1);
    await b.page.evaluate(() => {
      window.originalClipboardWrite = navigator.clipboard.write;
      Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) });
    });
    await incoming(b.page, file.name).getByRole('button', { name: '复制图片' }).click();
    await expect(b.page.getByRole('status')).toContainText('无法复制图片');
    await expect(b.page.locator('[data-unsaved-note]')).toBeVisible();
    await save(b.page, file);
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await b.page.evaluate(() => { Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: undefined }); });
    await sendFiles(a.page, file);
    await expect(incoming(b.page, file.name)).toHaveCount(1);
    await expect(b.page.getByRole('button', { name: '复制图片' })).toHaveCount(0);
    await expect(b.page.locator('[data-unsaved-note]')).toBeVisible();
    await save(b.page, file);
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await sendFiles(a.page, { ...file, name: '验收可清空.png' });
    await expect(b.page.locator('[data-unsaved-note]')).toBeVisible();
    await dialogAction(b.page, () => b.page.getByRole('button', { name: '清空已结束记录' }).click(), 'confirm', true);
    await expect(b.page.locator('[data-transfer]')).toHaveCount(0);
    await expect(b.page.locator('[data-unsaved-note]')).toBeHidden();
  });
  await step('传输进行中阻止离开，取消后允许刷新', async () => {
    await a.page.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const send = Transfers.prototype.sendBytes;
      const gate = new Promise((release) => { window.releaseSmokeTransfer = release; });
      Transfers.prototype.sendBytes = async function (item) { await gate; return send.call(this, item); };
    });
    await a.page.locator('[data-editor]').fill('验收取消中的传输');
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-status="transferring"]')).toHaveCount(1);
    await dialogAction(a.page, () => a.page.evaluate(() => location.reload()), 'beforeunload');
    await dialogAction(b.page, () => b.page.evaluate(() => location.reload()), 'beforeunload');
    await a.page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(b.page.locator('[data-status="cancelled"]')).toHaveCount(1);
    await a.page.evaluate(() => window.releaseSmokeTransfer());
    for (const entry of [a, b]) {
      const unexpected = [];
      const handle = async (dialog) => { unexpected.push(dialog.type()); await dialog.accept(); };
      entry.page.on('dialog', handle);
      await entry.page.reload();
      await expect(entry.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
      entry.page.off('dialog', handle);
      expect(unexpected).toEqual([]);
    }
  });
  await step('多页面接收提示与接收页关闭后的交接，标题不加未读提示', async () => {
    const second = await openPage(b.context);
    await expect(b.page.locator('[data-reception-note]')).toContainText('本页负责接收新内容');
    await expect(second.locator('[data-reception-note]')).toContainText('本机另一个随传页面接收');
    await second.screenshot({ path: join(artifacts, '另一页面接收提示.png'), fullPage: true });
    await sendText(a.page, b.page, '首条只到原接收页');
    await expect(second.locator('[data-transfer]')).toHaveCount(0);
    await expect(b.page).toHaveTitle('随传 · 跨设备快传');
    await b.page.close();
    b.page = second;
    await expect(second.locator('[data-reception-note]')).toBeHidden();
    await sendText(a.page, second, '后续交接到剩余页面');
    await expect(second).toHaveTitle('随传 · 跨设备快传');
  });
  await step('解除配对后保留不可用目标，禁止自动改发', async () => {
    await a.page.locator('[data-action="devices"]').click();
    await expect(a.page.locator(`[data-peer="${b.id}"] strong`)).toContainText(' · ');
    await a.page.locator(`[data-peer="${b.id}"] [data-action="forget"]`).click();
    await a.page.locator('[data-action="close"]').click();
    await expect(a.page.locator('[data-target] option:checked')).toHaveText('原接收设备不可用，请重新选择');
    await a.page.locator('[data-editor]').fill('仍需手动选择其他设备');
    await expect(a.page.locator('[data-action="send"]')).toBeDisabled();
    await expect(c.page.locator('[data-transfer]')).toHaveCount(0);
  });
  expect(report.errors).toEqual([]);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
  for (const [index, entry] of devices.entries()) {
    if (entry.page && !entry.page.isClosed()) {
      await entry.page.screenshot({ path: join(artifacts, `失败现场-${index}.png`), fullPage: true }).catch(() => {});
    }
  }
} finally {
  try {
    if (a?.page && !a.page.isClosed()) {
      await a.page.reload();
      await expect(a.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
      await a.page.locator('[data-action="devices"]').click();
      const forget = a.page.locator('[data-action="forget"]');
      while (await forget.count()) {
        const count = await forget.count();
        await expect(forget.first()).toBeEnabled();
        await forget.first().click();
        await expect(forget).toHaveCount(count - 1);
      }
      report.pairCleanup = 'passed';
    }
  } catch (error) {
    report.pairCleanup = error.message;
    process.exitCode = 1;
  }
  await Promise.allSettled(devices.map(({ context }) => context.close()));
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, downloads: report.downloads.length, pairCleanup: report.pairCleanup, artifacts }, null, 2));
}
