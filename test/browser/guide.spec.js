import { test, expect } from '@playwright/test';

const guide = page => page.locator('[data-guide]');
const next = page => page.locator('[data-guide-next]');
const file = { name: '引导草稿.txt', mimeType: 'text/plain', buffer: Buffer.from('keep my draft') };

async function open(page) {
  await page.goto('/transfer?lang=zh-CN');
  await expect(guide(page)).toBeVisible();
  await expect(page.locator('#qt-guide-title')).toHaveText('先连接另一台设备');
}

async function dismiss(page) {
  await page.locator('[data-guide-skip]').click();
  await expect(guide(page)).toBeHidden();
}

test('首次展示后记住，刷新、关闭、跳过和完成均不重复，可主动重看', async ({ page, context }) => {
  await open(page);
  await page.reload();
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await expect(guide(page)).toBeHidden();
  await expect(page.locator('[data-onboarding]')).toHaveCount(0);
  await expect(page.locator('[data-target] option:checked')).toHaveText('请先添加设备');
  for (const action of ['close', 'skip', 'done']) {
    await page.locator('[data-use-guide]').click();
    await expect(guide(page)).toBeVisible();
    if (action === 'done') {
      await next(page).click();
      await next(page).click();
      await next(page).click();
    } else {
      await page.locator(`[data-guide-${action}]`).click();
    }
    await expect(guide(page)).toBeHidden();
    await expect(page.locator('[data-mode="device"]')).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await expect(guide(page)).toBeHidden();
  }
  const second = await context.newPage();
  await second.goto('/transfer');
  await expect(second.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await expect(guide(second)).toBeHidden();
});

for (const [width, height, locale] of [[1280, 900, 'zh-CN'], [375, 812, 'zh-CN'], [320, 640, 'en']]) {
  test(`第二三步固定位置，只圈文件区域，${width}px ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light', reducedMotion: 'reduce' });
    await page.goto(`/transfer?lang=${locale}`);
    await expect(guide(page)).toBeVisible();
    await next(page).click();
    const card = await page.locator('.qt-guide-card').boundingBox();
    const button = await next(page).boundingBox();
    const scroll = await page.evaluate(() => scrollY);
    await page.screenshot({ path: testInfo.outputPath('发送引导.png') });
    await next(page).click();
    await expect(page.locator('[data-mode="share"]')).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('.qt-guide-card').boundingBox()).toEqual(card);
    expect(await next(page).boundingBox()).toEqual(button);
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    const spotlight = await page.locator('.qt-guide-spotlight').boundingBox();
    const upload = await page.locator('#share-composer .share-upload').boundingBox();
    const tab = await page.locator('[data-mode="share"]').boundingBox();
    expect(spotlight.y).toBeCloseTo(upload.y - 6, 0);
    expect(spotlight.height).toBeCloseTo(upload.height + 12, 0);
    expect(spotlight.y).toBeGreaterThan(tab.y + tab.height);
    expect(card.y + card.height).toBeLessThanOrEqual(height);
    expect(card.x + card.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('分享引导.png') });
    await page.locator('[data-guide-back]').click();
    expect(await page.locator('.qt-guide-card').boundingBox()).toEqual(card);
    expect(await next(page).boundingBox()).toEqual(button);
  });
}

test('手动重看保留附件、文字、TAB，键盘焦点约束和退出恢复', async ({ page }) => {
  await open(page);
  await dismiss(page);
  await page.locator('[data-editor]').fill('尚未发送的内容');
  await page.locator('[data-files]').setInputFiles(file);
  await page.locator('[data-mode="share"]').click();
  await page.locator('[data-use-guide]').click();
  await expect(next(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-guide-close]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(next(page)).toBeFocused();
  await next(page).click();
  await next(page).click();
  await page.keyboard.press('Escape');
  await expect(guide(page)).toBeHidden();
  await expect(page.locator('[data-use-guide]')).toBeFocused();
  await expect(page.locator('[data-mode="share"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.share-upload')).toContainText(file.name);
  await page.locator('[data-mode="device"]').click();
  await expect(page.locator('[data-editor]')).toHaveValue('尚未发送的内容');
  await expect(page.locator('[data-attachments]')).toContainText(file.name);
  await expect(page.locator('[data-transfer]')).toHaveCount(0);
  await expect(page.locator('[data-share-record]')).toHaveCount(0);
});

test('本地存储被禁用时仍可结束、重看和操作页面', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await open(page);
  await dismiss(page);
  await page.reload();
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await expect(guide(page)).toBeHidden();
  await page.locator('[data-use-guide]').click();
  await next(page).click();
  await next(page).click();
  await next(page).click();
  await page.locator('[data-action="connect"]').click();
  await expect(page.locator('.qt-overlay')).toBeVisible();
});

test('首页和分享领取页不展示首次引导', async ({ page }) => {
  await page.goto('/');
  await expect(guide(page)).toHaveCount(0);
  await page.goto('/s#invalid-share');
  await expect(guide(page)).toHaveCount(0);
  await open(page);
});

test('收到配对请求和新内容时退出引导，保持确认和接收可用', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext({ locale: 'zh-CN' }), browser.newContext({ locale: 'zh-CN' })]);
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    for (const [index, page] of [a, b].entries()) {
      await page.goto(`${baseURL}/transfer?lang=zh-CN`);
      await expect(guide(page)).toBeVisible();
      await dismiss(page);
      await page.locator('[data-action="devices"]').click();
      await page.locator('[data-name-input]').fill(`引导验收 ${index}`);
      await page.locator('[data-action="rename"]').click();
      await expect(page.locator('.qt-overlay')).toBeHidden();
    }
    await a.locator('[data-action="connect"]').click();
    await expect(a.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
    const code = (await a.locator('[data-code]').textContent()).replace(/\s/g, '');
    await a.locator('[data-action="close"]').click();
    await a.locator('[data-use-guide]').click();
    await b.locator('[data-action="connect"]').click();
    await b.locator('[data-pair-tab="enter"]').click();
    await b.locator('[data-code-input]').fill(code);
    await b.locator('[data-join]').click();
    await expect(guide(a)).toBeHidden();
    await expect(a.locator('[data-approval-panel]')).toBeVisible();
    await a.locator('[data-action="allow"]').click();
    await expect(a.locator('.qt-overlay')).toBeHidden();
    await expect(b.locator('.qt-overlay')).toBeHidden();
    await a.locator('[data-use-guide]').click();
    await b.locator('[data-editor]').fill('引导期间收到的内容');
    await b.locator('[data-action="send"]').click();
    await expect(guide(a)).toBeHidden();
    await expect(a.locator('[data-status="completed"] pre')).toHaveText('引导期间收到的内容');
    await expect(a.locator('.qt-app')).not.toHaveAttribute('inert');
    await expect(a.locator('.qt-notice')).toContainText('新');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
