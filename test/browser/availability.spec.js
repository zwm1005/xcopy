import { test, expect } from './fixtures.js';
import { readFile, writeFile, rm } from 'node:fs/promises';

async function device(browser, baseURL) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(`恢复设备-${Math.random().toString(16).slice(2, 6)}`);
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

test('live transfer resumes its signaling session and a second tab takes over receiving', async ({ browser, baseURL }) => {
  const a = await device(browser, baseURL);
  const b = await device(browser, baseURL);
  try {
    await pair(a.page, b.page);
    const second = await b.context.newPage();
    await second.goto(`${baseURL}/transfer`);
    await expect(second.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await a.page.evaluate(async () => {
      const { Connection } = await import('/connection.js');
      const { Transfers } = await import('/transfer.js');
      const rpc = Connection.prototype.rpc;
      const emit = Connection.prototype.emit;
      const send = Transfers.prototype.sendBytes;
      const gate = new Promise((resolve) => { window.releaseAvailabilityBytes = resolve; });
      Connection.prototype.rpc = function (type, ...args) {
        window.availabilityConnection = this;
        return rpc.call(this, type, ...args);
      };
      Connection.prototype.emit = function (type, value) {
        if (type === 'ready') {
          window.availabilityResumed = value.resumed;
        }
        return emit.call(this, type, value);
      };
      Transfers.prototype.sendBytes = async function (item) {
        await gate;
        return send.call(this, item);
      };
    });
    const bytes = Buffer.alloc(1024 * 1024, 89);
    await a.page.locator('[data-files]').setInputFiles({ name: 'resume.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await a.page.locator('[data-action="send"]').click();
    await expect(a.page.locator('[data-status="transferring"]')).toHaveCount(1);
    await a.page.evaluate(() => window.availabilityConnection.ws.close());
    await expect.poll(() => a.page.evaluate(() => window.availabilityResumed)).toBe(true);
    await expect(a.page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await a.page.evaluate(() => window.releaseAvailabilityBytes());
    await expect(b.page.locator('[data-status="completed"]')).toHaveCount(1);
    const download = b.page.waitForEvent('download');
    await b.page.locator('[data-action="save-file"]').click();
    expect(await readFile(await (await download).path())).toEqual(bytes);
    await expect(second.locator('[data-transfer]')).toHaveCount(0);
    b.page.once('dialog', (dialog) => dialog.accept());
    await b.page.close();
    await expect(second.locator('[data-reception-note]')).toBeHidden();
    await a.page.locator('[data-editor]').fill('接收标签页已切换');
    await a.page.locator('[data-action="send"]').click();
    await expect(second.locator('[data-status="completed"] pre')).toHaveText('接收标签页已切换');
  } finally {
    await Promise.all([a.context.close(), b.context.close()]);
  }
});

test('completed share downloads survive guest cleanup without an automatic reconnect loop', async ({ browser, baseURL }) => {
  const sender = await device(browser, baseURL);
  const guest = await browser.newContext({ locale: 'zh-CN' });
  const clockFile = `/tmp/suichuan-e2e-clock-${new URL(baseURL).port}`;
  try {
    await sender.page.getByRole('tab', { name: '链接分享', exact: true }).click();
    const bytes = Buffer.from('断开空闲访客连接后仍可保存');
    await sender.page.locator('[data-files]').setInputFiles({ name: 'saved.txt', mimeType: 'text/plain', buffer: bytes });
    await sender.page.locator('[data-share-generate]').click();
    const url = await sender.page.locator('[data-share-url]').inputValue();
    const page = await guest.newPage();
    let opened = 0;
    let closed = 0;
    page.on('websocket', (ws) => {
      opened += 1;
      ws.on('close', () => { closed += 1; });
    });
    await page.goto(url);
    await page.locator('[data-claim]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
    await writeFile(clockFile, '61000');
    await expect.poll(() => closed).toBe(1);
    await page.waitForTimeout(1800);
    expect(opened).toBe(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
    const download = page.waitForEvent('download');
    await page.locator('[data-save-index="0"]').click();
    expect(await readFile(await (await download).path())).toEqual(bytes);
  } finally {
    await rm(clockFile, { force: true });
    await Promise.all([sender.context.close(), guest.close()]);
  }
});

test('a sleeping preview wakes once to claim and preserves the recipient name', async ({ browser, baseURL }) => {
  const sender = await device(browser, baseURL);
  const guest = await browser.newContext({ locale: 'zh-CN' });
  const clockFile = `/tmp/suichuan-e2e-clock-${new URL(baseURL).port}`;
  try {
    await sender.page.getByRole('tab', { name: '链接分享', exact: true }).click();
    await sender.page.locator('[data-files]').setInputFiles({ name: 'wake.txt', mimeType: 'text/plain', buffer: Buffer.from('wake') });
    await sender.page.locator('[data-share-generate]').click();
    const page = await guest.newPage();
    let opened = 0;
    let closed = 0;
    const messages = [];
    page.on('websocket', (ws) => {
      opened += 1;
      ws.on('close', () => { closed += 1; });
      ws.on('framesent', ({ payload }) => { messages.push(JSON.parse(String(payload)).type); });
    });
    await page.goto(await sender.page.locator('[data-share-url]').inputValue());
    await expect(page.locator('[data-claim]')).toBeEnabled();
    await page.locator('[data-control="edit-name"]').click();
    await page.locator('[data-recipient-name-input]').fill('休眠后继续领取');
    await writeFile(clockFile, '61000');
    await expect.poll(() => closed).toBe(1);
    await page.waitForTimeout(1500);
    expect(opened).toBe(1);
    await expect(page.locator('[data-recipient-name-input]')).toHaveValue('休眠后继续领取');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(page.locator('[data-claim]')).toBeEnabled();
    const name = (await page.locator('[data-recipient-name]').textContent()).split('：').at(-1);
    messages.length = 0;
    await page.locator('[data-claim]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成');
    expect(opened).toBe(2);
    expect(messages.filter((type) => type === 'share.claim')).toHaveLength(1);
    expect(messages.filter((type) => type === 'share.inspect')).toHaveLength(0);
    expect(await page.locator('[data-recipient-name]').textContent()).toContain(name);
  } finally {
    await rm(clockFile, { force: true });
    await Promise.all([sender.context.close(), guest.close()]);
  }
});

test('a sleeping preview revalidates expiry when explicitly claimed', async ({ browser, baseURL }) => {
  const sender = await device(browser, baseURL);
  const guest = await browser.newContext();
  const clockFile = `/tmp/suichuan-e2e-clock-${new URL(baseURL).port}`;
  try {
    await sender.page.getByRole('tab', { name: '链接分享', exact: true }).click();
    await sender.page.locator('[data-files]').setInputFiles({ name: 'expired.txt', mimeType: 'text/plain', buffer: Buffer.from('expired') });
    await sender.page.locator('[data-share-generate]').click();
    const page = await guest.newPage();
    let closed = 0;
    page.on('websocket', (ws) => ws.on('close', () => { closed += 1; }));
    await page.goto(await sender.page.locator('[data-share-url]').inputValue());
    await expect(page.locator('[data-claim]')).toBeEnabled();
    await writeFile(clockFile, '61000');
    await expect.poll(() => closed).toBe(1);
    await writeFile(clockFile, '610001');
    await page.locator('[data-claim]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('这份分享已过期');
    await expect(page.locator('[data-save-index]')).toHaveCount(0);
  } finally {
    await rm(clockFile, { force: true });
    await Promise.all([sender.context.close(), guest.close()]);
  }
});
