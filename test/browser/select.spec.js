import { test, expect } from './fixtures.js';

test('language combobox selects by keyboard, persists, and dismisses without changing the value', async ({ page }) => {
  await page.goto('/');
  const picker = page.getByRole('combobox', { name: '语言', exact: true });
  await picker.click();
  await expect(page.getByRole('option', { name: '简体中文' })).toHaveAttribute('aria-selected', 'true');
  await picker.press('ArrowUp');
  await picker.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(picker).toBeFocused();
  await picker.click();
  await picker.click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await picker.press('Enter');
  await picker.press('Home');
  await picker.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveText('English');
  await page.reload();
  const english = page.getByRole('combobox', { name: 'Language', exact: true });
  await expect(english).toHaveText('English');
  await english.click();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
  await english.click();
  await english.press('Tab');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(english).not.toBeFocused();
});

test('language menu remains within narrow viewports in both themes and works on all pages', async ({ page }) => {
  for (const path of ['/', '/transfer', '/s']) {
    await page.goto(`${path}?lang=zh-CN`);
    const picker = page.getByRole('combobox', { name: '语言', exact: true });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        await picker.click();
        const menu = page.getByRole('listbox', { name: '语言', exact: true });
        await expect(menu).toBeVisible();
        const bounds = await menu.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        const background = await menu.evaluate(element => getComputedStyle(element).backgroundColor);
        expect(background).toBe(colorScheme === 'dark' ? 'rgb(37, 37, 35)' : 'rgb(255, 255, 255)');
        await picker.press('Escape');
      }
    }
    await picker.click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  }
});

test('device combobox follows pairing, selects the actual recipient, and closes when the last peer disconnects', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [sender, receiver] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([sender, receiver].map(async (page, index) => {
      await page.goto(`${baseURL}/transfer?lang=zh-CN`);
      await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
      await page.locator('[data-action="devices"]').click();
      await page.locator('[data-name-input]').fill(index ? '下拉菜单接收端' : '下拉菜单发送端');
      await page.locator('[data-action="rename"]').click();
      await expect(page.locator('.qt-overlay')).toBeHidden();
    }));
    const target = sender.getByRole('combobox', { name: '接收设备', exact: true });
    await expect(target).toBeDisabled();
    await expect(target).toHaveText('请先添加设备');
    await sender.locator('[data-action="connect"]').click();
    await expect(sender.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
    const code = (await sender.locator('[data-code]').textContent()).replace(/\s/g, '');
    await receiver.locator('[data-action="connect"]').click();
    await receiver.locator('[data-pair-tab="enter"]').click();
    await receiver.locator('[data-code-input]').fill(code);
    await receiver.locator('[data-join]').click();
    await sender.locator('[data-action="allow"]').click();
    await expect(target).toBeEnabled();
    await target.click();
    await sender.getByRole('option', { name: '全部在线设备（1 台）', exact: true }).click();
    await expect(target).toHaveText('全部在线设备（1 台）');
    await target.click();
    await sender.getByRole('option', { name: '下拉菜单接收端', exact: true }).click();
    await expect(target).toHaveText('下拉菜单接收端');
    await target.click();
    await receiver.locator('[data-action="devices"]').click();
    await receiver.locator('[data-name-input]').fill('已改名的接收端');
    await receiver.locator('[data-action="rename"]').click();
    await expect(sender.getByRole('option', { name: '已改名的接收端', exact: true })).toBeVisible();
    await target.press('Escape');
    await expect(target).toHaveText('已改名的接收端');
    await sender.locator('[data-editor]').fill('自定义下拉菜单选择后的实际传输');
    await sender.locator('[data-action="send"]').click();
    await expect(receiver.locator('[data-transfer][data-status="completed"] pre')).toHaveText('自定义下拉菜单选择后的实际传输');
    await target.click();
    await contexts[1].close();
    await expect(target).toBeDisabled();
    await expect(target).toHaveText('等待接收设备上线');
    await expect(sender.getByRole('listbox')).toBeHidden();
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
