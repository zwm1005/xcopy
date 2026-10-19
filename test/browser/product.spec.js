import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function device(browser, baseURL, name, init) {
  const context = await browser.newContext({ locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
  if (init) {
    await context.addInitScript(init);
  }
  const page = await context.newPage();
  await page.goto(new URL('/transfer', baseURL).href);
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
  await b.getByRole('tab', { name: '输入连接码' }).click();
  await b.getByRole('textbox', { name: '8 位连接码' }).fill(code);
  await b.locator('[data-action="join"]').click();
  await expect(a.locator('[data-approval-panel]')).toBeVisible();
  await a.getByRole('button', { name: '允许并记住' }).click();
  await expect(a.locator('.qt-overlay')).toBeHidden();
  await expect(b.locator('.qt-overlay')).toBeHidden();
}

async function dialogAction(page, action, type, accept) {
  const shown = page.waitForEvent('dialog');
  const operation = action().catch((error) => error);
  const dialog = await shown;
  expect(dialog.type()).toBe(type);
  if (accept) {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
  const result = await operation;
  if (result instanceof Error) {
    expect(type).toBe('beforeunload');
    expect(accept).toBe(false);
    expect(result.message).toMatch(/ERR_ABORTED/);
  }
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
  return { name: mime === 'image/png' ? '截图.png' : '照片.jpg', mimeType: mime, buffer: Buffer.from(base64, 'base64') };
}

test('首次连接引导、名称校验和记忆，窄屏保持可用', async ({ page }, testInfo) => {
  await page.goto('/transfer');
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await expect(page.getByRole('region', { name: '首次连接引导' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light', reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`首次连接-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: '连接第一台设备' }).click();
  await expect(page.getByRole('heading', { name: '给这台设备起个名字' })).toBeVisible();
  await expect(page.locator('[data-code]')).toBeHidden();
  await page.getByRole('textbox', { name: '本机名称' }).fill('   ');
  await page.getByRole('button', { name: '保存并继续' }).click();
  await expect(page.getByRole('alert')).toHaveText('请输入 1–24 个字符的设备名称');
  await page.getByRole('textbox', { name: '本机名称' }).fill('  办公笔记本  ');
  await page.getByRole('textbox', { name: '本机名称' }).press('Enter');
  await expect(page.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  await expect(page.locator('[data-local-name]')).toHaveText('办公笔记本');
  await expect(page.locator('#qt-code-panel')).toContainText('回到本页确认连接');
  await page.screenshot({ path: testInfo.outputPath('连接步骤-320.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="connect"]').click();
  await expect(page.locator('[data-code]')).toBeVisible();
  await expect(page.locator('[data-onboarding-name-panel]')).toBeHidden();
});

test('同名设备可区分，目标离线、刷新和解除配对均不会自动改发', async ({ browser, baseURL }) => {
  const a = await device(browser, baseURL, '发送端');
  const b = await device(browser, baseURL, '我的电脑');
  const c = await device(browser, baseURL, '我的电脑');
  try {
    await pair(a.page, b.page);
    await pair(a.page, c.page);
    await expect(a.page.locator('[data-onboarding]')).toBeHidden();
    const choices = await a.page.locator('[data-target] option').evaluateAll((options) => options.filter((option) => option.value !== 'all-online').map((option) => ({ id: option.value, label: option.textContent })));
    expect(choices).toHaveLength(2);
    expect(choices[0].label).toMatch(/^我的电脑 · [a-f0-9]+$/);
    expect(choices[1].label).toMatch(/^我的电脑 · [a-f0-9]+$/);
    expect(choices[0].label).not.toBe(choices[1].label);
    const bId = await b.page.evaluate(async () => (await (await import('/identity.js')).loadIdentity()).fingerprint);
    await a.page.locator('[data-target]').selectOption(bId);
    await b.page.close();
    await expect(a.page.locator('[data-target] option:checked')).toContainText('已离线');
    await a.page.getByRole('textbox', { name: '要发送的文字' }).fill('只能发给原设备');
    await expect(a.page.locator('[data-action="send"]')).toBeDisabled();
    await a.page.getByRole('textbox', { name: '要发送的文字' }).press('ControlOrMeta+Enter');
    await expect(c.page.locator('[data-transfer]')).toHaveCount(0);
    await a.page.reload();
    await expect(a.page.locator('[data-target] option:checked')).toContainText('已离线');
    await expect(a.page.locator('[data-action="send"]')).toBeDisabled();
    b.page = await b.context.newPage();
    await b.page.goto(new URL('/transfer', baseURL).href);
    await expect(a.page.locator('[data-target]')).toHaveValue(bId);
    await a.page.getByRole('textbox', { name: '要发送的文字' }).fill('恢复后仍发给原设备');
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-status="completed"] pre')).toHaveText('恢复后仍发给原设备');
    await expect(c.page.locator('[data-transfer]')).toHaveCount(0);
    await a.page.locator('[data-action="devices"]').click();
    await expect(a.page.locator(`[data-peer="${bId}"] strong`)).toContainText('我的电脑 · ');
    await a.page.locator(`[data-peer="${bId}"] [data-action="forget"]`).click();
    await a.page.locator('[data-action="close"]').click();
    await expect(a.page.locator('[data-target] option:checked')).toHaveText('原接收设备不可用，请重新选择');
    await a.page.getByRole('textbox', { name: '要发送的文字' }).fill('仍需手动选其他设备');
    await expect(a.page.locator('[data-action="send"]')).toBeDisabled();
  } finally {
    await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
  }
});

test('未保存文件保护刷新、关闭和清空，发起下载后解除提醒', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '发送端');
  const b = await device(browser, baseURL, '接收端');
  try {
    await pair(a.page, b.page);
    const file = { name: '需要保存.txt', mimeType: 'text/plain', buffer: Buffer.from('这份文件应在取消离开后仍然可下载') };
    await a.page.locator('[data-files]').setInputFiles(file);
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-status="completed"]')).toHaveCount(1);
    await expect(b.page.locator('[data-unsaved-note]')).toContainText('还有 1 个文件');
    // Trigger a real reload without waiting for a navigation that the user cancels.
    await dialogAction(b.page, () => b.page.evaluate(() => location.reload()), 'beforeunload', false);
    await dialogAction(b.page, () => b.page.close({ runBeforeUnload: true }), 'beforeunload', false);
    expect(b.page.isClosed()).toBe(false);
    await dialogAction(b.page, () => b.page.getByRole('button', { name: '清空已结束记录' }).click(), 'confirm', false);
    await expect(b.page.locator('[data-status="completed"]')).toHaveCount(1);
    await b.page.screenshot({ path: testInfo.outputPath('未保存文件提醒.png'), fullPage: true });
    const downloaded = b.page.waitForEvent('download');
    await b.page.getByRole('button', { name: '保存', exact: true }).click();
    expect(await readFile(await (await downloaded).path())).toEqual(file.buffer);
    await expect(b.page.locator('[data-unsaved-note]')).toBeHidden();
    await expect(b.page.locator('[data-transfers]')).toContainText('已发起下载，请确认文件已保存');
    const unexpected = [];
    b.page.on('dialog', async (dialog) => {
      unexpected.push(dialog.type());
      await dialog.accept();
    });
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    expect(unexpected).toEqual([]);
    await a.page.locator('[data-files]').setInputFiles(file);
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-unsaved-note]')).toBeVisible();
    await b.page.getByRole('button', { name: '清空已结束记录' }).click();
    await expect(b.page.locator('[data-transfer]')).toHaveCount(0);
    expect(unexpected).toEqual(['confirm']);
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    expect(unexpected).toEqual(['confirm']);
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});

test('PNG 和 JPEG 收到后可复制为可粘贴图片，复制成功解除未保存提醒', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '发送端');
  const b = await device(browser, baseURL, '接收端');
  try {
    await pair(a.page, b.page);
    const fixtures = [await fixtureImage(a.page, 'image/png'), await fixtureImage(a.page, 'image/jpeg')];
    await a.page.locator('[data-files]').setInputFiles(fixtures);
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-status="completed"]')).toHaveCount(2);
    await b.page.bringToFront();
    for (const file of fixtures) {
      const row = b.page.locator('[data-transfer]').filter({ hasText: file.name });
      await row.getByRole('button', { name: '复制图片' }).click();
      await expect(row).toContainText('已复制图片，可粘贴到其他应用');
      const image = await b.page.evaluate(async () => {
        const entries = await navigator.clipboard.read();
        const blob = await entries[0].getType('image/png');
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const result = { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(0, 0, 1, 1).data] };
        bitmap.close();
        return result;
      });
      expect(image.width).toBe(4);
      expect(image.height).toBe(3);
      expect(Math.abs(image.pixel[0] - 36)).toBeLessThan(6);
      expect(Math.abs(image.pixel[1] - 161)).toBeLessThan(6);
      expect(Math.abs(image.pixel[2] - 72)).toBeLessThan(6);
    }
    await expect(b.page.locator('[data-unsaved-note]')).toBeHidden();
    await b.page.setViewportSize({ width: 320, height: 900 });
    expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await b.page.screenshot({ path: testInfo.outputPath('复制图片-320.png'), fullPage: true });
    await b.page.reload();
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});

test('图片复制被拒绝或不受支持时仍可保存，且保留未保存提醒', async ({ browser, baseURL }) => {
  const a = await device(browser, baseURL, '发送端');
  const denied = await device(browser, baseURL, '权限拒绝', () => {
    Object.defineProperty(navigator.clipboard, 'write', { value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) });
  });
  const unsupported = await device(browser, baseURL, '不支持复制', () => {
    Object.defineProperty(window, 'ClipboardItem', { value: undefined });
  });
  try {
    await pair(a.page, denied.page);
    await pair(a.page, unsupported.page);
    const file = await fixtureImage(a.page, 'image/png');
    await a.page.locator('[data-target]').selectOption('all-online');
    await a.page.locator('[data-files]').setInputFiles(file);
    await a.page.locator('[data-action="send"]').click();
    await expect(denied.page.locator('[data-status="completed"]')).toHaveCount(1);
    await expect(unsupported.page.locator('[data-status="completed"]')).toHaveCount(1);
    await denied.page.getByRole('button', { name: '复制图片' }).click();
    await expect(denied.page.getByRole('status')).toContainText('无法复制图片');
    await expect(denied.page.locator('[data-unsaved-note]')).toBeVisible();
    await expect(unsupported.page.getByRole('button', { name: '复制图片' })).toHaveCount(0);
    for (const entry of [denied, unsupported]) {
      const downloaded = entry.page.waitForEvent('download');
      await entry.page.getByRole('button', { name: '保存', exact: true }).click();
      expect(await readFile(await (await downloaded).path())).toEqual(file.buffer);
      await expect(entry.page.locator('[data-unsaved-note]')).toBeHidden();
    }
  } finally {
    await Promise.all([a.context.close(), denied.context.close(), unsupported.context.close()]);
  }
});

test('传输未结束时阻止误关闭，取消后不再拦截', async ({ browser, baseURL }) => {
  const a = await device(browser, baseURL, '发送端');
  const b = await device(browser, baseURL, '接收端');
  try {
    await pair(a.page, b.page);
    await a.page.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const send = Transfers.prototype.sendBytes;
      const gate = new Promise((resolve) => { window.releaseProductTransfer = resolve; });
      Transfers.prototype.sendBytes = async function (item) {
        await gate;
        return send.call(this, item);
      };
    });
    await a.page.getByRole('textbox', { name: '要发送的文字' }).fill('等待取消');
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-status="transferring"]')).toHaveCount(1);
    await dialogAction(a.page, () => a.page.evaluate(() => location.reload()), 'beforeunload', false);
    await dialogAction(b.page, () => b.page.evaluate(() => location.reload()), 'beforeunload', false);
    await a.page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(b.page.locator('[data-status="cancelled"]')).toHaveCount(1);
    await a.page.evaluate(() => window.releaseProductTransfer());
    await a.page.reload();
    await b.page.reload();
    await expect(a.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(b.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});

test('多个页面显示实际接收位置，关闭接收页后后续内容转到剩余页', async ({ browser, baseURL }, testInfo) => {
  const a = await device(browser, baseURL, '发送端');
  const b = await device(browser, baseURL, '接收端');
  try {
    await pair(a.page, b.page);
    const second = await b.context.newPage();
    await second.goto(new URL('/transfer', baseURL).href);
    await expect(b.page.locator('[data-reception-note]')).toContainText('本页负责接收新内容');
    await expect(second.locator('[data-reception-note]')).toContainText('本机另一个随传页面接收');
    await second.screenshot({ path: testInfo.outputPath('另一页面接收提示.png'), fullPage: true });
    await a.page.getByRole('textbox', { name: '要发送的文字' }).fill('第一条只收到首个页面');
    await a.page.locator('[data-action="send"]').click();
    await expect(b.page.locator('[data-status="completed"] pre')).toHaveText('第一条只收到首个页面');
    await expect(second.locator('[data-transfer]')).toHaveCount(0);
    await expect(b.page).toHaveTitle('随传 · 跨设备快传');
    await b.page.close();
    await expect(second.locator('[data-reception-note]')).toBeHidden();
    await a.page.getByRole('textbox', { name: '要发送的文字' }).fill('第二条收到剩余页面');
    await a.page.locator('[data-action="send"]').click();
    await expect(second.locator('[data-status="completed"] pre')).toHaveText('第二条收到剩余页面');
    await expect(second).toHaveTitle('随传 · 跨设备快传');
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});
