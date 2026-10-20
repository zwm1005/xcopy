import { test, expect } from './fixtures.js';
import { readFile } from 'node:fs/promises';

async function ready(page, origin) {
  await page.goto(`${origin}/transfer?lang=en`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill('Device 原名');
  await page.locator('[data-action="rename"]').click();
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
  await a.locator('[data-action="allow"]').click();
  await expect(b.locator('.qt-overlay')).toBeHidden();
}

test('browser language selects the default while explicit choices, blocked storage and missing config remain usable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.route('**/api/client-config', route => route.fulfill({ json: { defaultLocale: 'en', supportedLocales: ['zh-CN', 'en'], cliDownloadUrl: null } }));
  try {
    await page.goto(baseURL);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('link', { name: '开始传输', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('suichuan-locale'))).toBeNull();
    await expect(page.locator('[data-cli-download]:visible')).toHaveCount(0);
    await page.getByRole('link', { name: '开始传输', exact: true }).click();
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.goto(baseURL);
    await page.locator('[data-locale]').selectOption('en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.goto(`${baseURL}/?lang=zh-CN`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.setViewportSize({ width: 320, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
  const blocked = await browser.newContext({ locale: 'zh-CN' });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }));
  const fallback = await blocked.newPage();
  await fallback.route('**/api/client-config', route => route.abort());
  try {
    await fallback.goto(baseURL);
    await expect(fallback.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(fallback.getByRole('link', { name: '开始传输', exact: true })).toBeVisible();
    await expect(fallback.locator('[data-demo-send]')).toBeVisible();
    await ready(fallback, baseURL);
    await expect(fallback.locator('html')).toHaveAttribute('lang', 'en');
    await fallback.locator('[data-locale]').selectOption('zh-CN');
    await expect(fallback.locator('[data-editor]')).toHaveAttribute('placeholder', '粘贴文字、截图，或拖入文件');
  } finally {
    await blocked.close();
  }
});

for (const [browserLanguage, expected] of [['zh-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['zh-HK', 'zh-CN'], ['en-US', 'en'], ['ja-JP', 'en'], ['fr-FR', 'en']]) {
  test(`browser ${browserLanguage} receives ${expected} on all pages before and after JavaScript`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ locale: browserLanguage });
    if (browserLanguage === 'fr-FR') {
      await context.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'zh-CN'] }));
    }
    try {
      const page = await context.newPage();
      // The server default and config request must not override the browser.
      await page.route('**/api/client-config', route => route.fulfill({ json: { defaultLocale: expected === 'en' ? 'zh-CN' : 'en', supportedLocales: ['zh-CN', 'en'], cliDownloadUrl: null } }));
      for (const path of ['/', '/transfer', '/s']) {
        const response = await page.goto(baseURL + path);
        expect(response.headers()['content-language']).toBe(expected);
        expect(response.headers().vary).toContain('Accept-Language');
        expect(await response.text()).toContain(`<html lang="${expected}">`);
        await expect(page.locator('html')).toHaveAttribute('lang', expected);
        await expect(page.locator('[data-locale]')).toHaveValue(expected);
        expect(await page.evaluate(() => localStorage.getItem('suichuan-locale'))).toBeNull();
      }
      await page.locator('[data-locale]').selectOption(expected === 'en' ? 'zh-CN' : 'en');
      await page.goto(baseURL + '/transfer');
      await expect(page.locator('html')).toHaveAttribute('lang', expected === 'en' ? 'zh-CN' : 'en');
    } finally {
      await context.close();
    }
  });
}

test('initial HTML contains the selected language and search metadata without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'zh-CN', javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/?lang=en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Cross-device transfers');
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
    await expect(page.locator('[data-locale]')).toHaveValue('en');
    await page.getByRole('link', { name: '简体中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('多端互传');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /免费开源/);
    await expect(page.locator('[data-locale]')).toHaveValue('zh-CN');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${baseURL}/`);
    for (const path of ['/transfer', '/s']) {
      await page.goto(`${baseURL}${path}?lang=en`);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('[data-locale]')).toHaveValue('en');
    }
  } finally {
    await context.close();
  }
});

test('English pairing, text and binary transfer survive switching language without identity, draft or connection resets', async ({ browser, baseURL }, info) => {
  const contexts = await Promise.all([browser.newContext({ locale: 'en-US' }), browser.newContext({ locale: 'en-US' })]);
  await contexts[0].addInitScript(() => {
    window.socketCount = 0;
    const Original = WebSocket;
    window.WebSocket = class extends Original { constructor(...args) { super(...args); window.socketCount++; } };
  });
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  try {
    await Promise.all([ready(a, baseURL), ready(b, baseURL)]);
    await pair(a, b);
    const identity = () => a.evaluate(async () => (await (await import('/identity.js')).loadIdentity()).fingerprint);
    const before = await identity();
    const draft = '<原文>\n  keep spaces and 中文';
    await a.locator('[data-editor]').fill(draft);
    await a.locator('[data-files]').setInputFiles({ name: '原文 <文件>.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1048576, 73) });
    await a.evaluate(async () => {
      const editor = document.querySelector('[data-editor]');
      editor.focus(); editor.setSelectionRange(3, 8);
      (await import('/i18n/index.js')).setLocale('zh-CN');
    });
    await expect(a.locator('[data-editor]')).toHaveValue(draft);
    expect(await a.locator('[data-editor]').evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd])).toEqual([true, 3, 8]);
    await expect(a.locator('[data-attachments] .qt-attachment-name')).toHaveText('原文 <文件>.bin');
    await a.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const original = Transfers.prototype.sendBytes;
      Transfers.prototype.sendBytes = async function (item) { await new Promise(resolve => setTimeout(resolve, 600)); return original.call(this, item); };
    });
    await a.locator('[data-action="send"]').click();
    await a.locator('[data-locale]').selectOption('en');
    const received = b.locator('[data-transfer][data-incoming="true"][data-status="completed"]');
    await expect(received).toHaveCount(2);
    await expect(received.locator('pre')).toHaveText(draft);
    const downloadEvent = b.waitForEvent('download');
    await received.locator('[data-action="save-file"]').click();
    expect(await readFile(await (await downloadEvent).path())).toEqual(Buffer.alloc(1048576, 73));
    expect(await identity()).toBe(before);
    expect(await a.evaluate(() => window.socketCount)).toBe(1);
    await a.setViewportSize({ width: 320, height: 850 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: info.outputPath('english-transfer-mobile.png'), fullPage: true });
  } finally {
    await Promise.all(contexts.map(c => c.close()));
  }
});

test('English share claim retains token, edited name and received bytes through locale changes', async ({ browser, baseURL }, info) => {
  const senderContext = await browser.newContext({ locale: 'en-US' });
  const guestContext = await browser.newContext({ locale: 'en-US' });
  const sender = await senderContext.newPage();
  const guest = await guestContext.newPage();
  try {
    await ready(sender, baseURL);
    await sender.locator('[data-mode="share"]').click();
    await sender.locator('[data-files]').setInputFiles({ name: '文件.txt', mimeType: 'text/plain', buffer: Buffer.from('keep 原文') });
    await sender.locator('[data-share-generate]').click();
    await expect(sender.locator('[data-share-url]')).toBeVisible();
    const link = await sender.locator('[data-share-url]').inputValue();
    await guest.goto(link);
    await expect(guest.locator('[data-claim]')).toBeEnabled();
    await guest.locator('[data-control="edit-name"]').click();
    await guest.locator('[data-recipient-name-input]').fill('<名字>');
    await guest.evaluate(async () => {
      const input = document.querySelector('[data-recipient-name-input]');
      input.focus(); input.setSelectionRange(1, 3);
      (await import('/i18n/index.js')).setLocale('zh-CN');
    });
    await expect(guest.locator('[data-recipient-name-input]')).toHaveValue('<名字>');
    expect(await guest.locator('[data-recipient-name-input]').evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd])).toEqual([true, 1, 3]);
    await guest.getByRole('button', { name: '保存名称', exact: true }).click();
    await guest.locator('[data-locale]').selectOption('en');
    await guest.locator('[data-claim]').click();
    await guest.locator('[data-locale]').selectOption('zh-CN');
    await expect(guest.locator('h1')).toHaveText('全部文件接收完成');
    await guest.locator('[data-locale]').selectOption('en');
    await expect(guest.locator('h1')).toHaveText('All files received');
    expect(new URL(guest.url()).hash).toBe(new URL(link).hash);
    const event = guest.waitForEvent('download');
    await guest.locator('[data-save-index="0"]').click();
    expect((await readFile(await (await event).path())).toString()).toBe('keep 原文');
    await guest.setViewportSize({ width: 320, height: 850 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await guest.screenshot({ path: info.outputPath('english-share-mobile.png'), fullPage: true });
  } finally {
    await senderContext.close(); await guestContext.close();
  }
});

test('English legacy server failures and malformed replies render translated safe feedback', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  try {
    await ready(page, baseURL);
    await page.locator('[data-action="connect"]').click();
    await page.locator('[data-pair-tab="enter"]').click();
    await page.locator('[data-code-input]').fill('12345678');
    await page.locator('[data-join]').click();
    await expect(page.locator('#qt-code-error')).toHaveText('Pairing code is invalid or expired');
    await page.evaluate(async () => (await import('/i18n/index.js')).setLocale('zh-CN'));
    await expect(page.locator('#qt-code-error')).toHaveText('连接码无效或已过期');
  } finally {
    await context.close();
  }
});
