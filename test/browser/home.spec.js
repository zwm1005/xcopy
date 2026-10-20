import { test, expect } from './fixtures.js';

test('home opens the existing transfer page without registering a device during the demo', async ({ page }) => {
  const sockets = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('多端互传');
  expect(sockets).toEqual([]);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  await page.getByRole('link', { name: '开始传输', exact: true }).click();
  await expect(page).toHaveURL(/\/transfer$/);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  const before = await page.evaluate(async () => (await (await import('/identity.js')).loadIdentity()).fingerprint);
  await page.goto('/');
  await page.getByRole('link', { name: '打开随传', exact: true }).click();
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  const after = await page.evaluate(async () => (await (await import('/identity.js')).loadIdentity()).fingerprint);
  expect(after).toBe(before);
  await page.goto('/transfer/');
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
});

test('demo cycles all three types and can pause, select, send and resume', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const demo = page.getByRole('region', { name: '传输过程演示' });
  await demo.scrollIntoViewIfNeeded();
  await expect(page.getByRole('tab', { name: '文字', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(2500);
  await expect(demo.locator('[data-received]')).toBeVisible();
  await expect(demo.locator('[data-received]')).toContainText('会议改到下午三点');
  await page.clock.runFor(3500);
  await expect(page.getByRole('tab', { name: '截图', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(6000);
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(6000);
  await expect(page.getByRole('tab', { name: '文字', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '暂停演示', exact: true }).click();
  await page.clock.runFor(18000);
  await expect(page.getByRole('tab', { name: '文字', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await page.clock.runFor(18000);
  await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.clock.runFor(1000);
  await expect(demo.locator('[data-received]')).toContainText('首页修改说明.pdf');
  await page.getByRole('button', { name: '播放演示', exact: true }).click();
  await page.clock.runFor(6500);
  await expect(page.getByRole('tab', { name: '文字', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('reduced motion starts paused, tabs work by keyboard, and the page fits narrow screens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('button', { name: '播放演示', exact: true })).toBeVisible();
  await page.clock.runFor(18000);
  const textTab = page.getByRole('tab', { name: '文字', exact: true });
  await expect(textTab).toHaveAttribute('aria-selected', 'true');
  await textTab.focus();
  await textTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '截图', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: '截图', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByText('连接码更新，还能继续传吗？', { exact: true }).click();
  await expect(page.locator('details[open]')).toContainText('不会解除已有配对');
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('offscreen demos stop cycling and resume when visible', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/');
  const demo = page.locator('[data-demo]');
  await demo.scrollIntoViewIfNeeded();
  await expect(page.getByRole('tab', { name: '文字', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(2500);
  await expect(demo.locator('[data-received]')).toBeVisible();
  await demo.evaluate(el => window.scrollTo({ top: scrollY + el.getBoundingClientRect().bottom + 1, behavior: 'instant' }));
  await expect.poll(() => demo.evaluate(el => el.getBoundingClientRect().bottom <= 0)).toBe(true);
  await page.clock.runFor(18000);
  await expect(page.getByRole('tab', { name: '文字', exact: true })).toHaveAttribute('aria-selected', 'true');
  await demo.scrollIntoViewIfNeeded();
  await page.clock.runFor(4500);
  await expect(page.getByRole('tab', { name: '截图', exact: true })).toHaveAttribute('aria-selected', 'true');
});
