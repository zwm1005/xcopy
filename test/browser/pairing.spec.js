import { test, expect } from '@playwright/test';

async function device(browser, baseURL, name) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  await context.addInitScript(() => localStorage.setItem('suichuan-locale', 'zh-CN'));
  const page = await context.newPage();
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(name);
  await page.locator('[data-action="rename"]').click();
  await expect(page.locator('.qt-overlay')).toBeHidden();
  return { context, page, name };
}

async function codeFor(owner) {
  await owner.page.locator('[data-action="connect"]').click();
  await expect(owner.page.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  return (await owner.page.locator('[data-code]').textContent()).replace(/\s/g, '');
}

async function request(device, code) {
  await device.page.locator('[data-action="connect"]').click();
  await device.page.locator('[data-pair-tab="enter"]').click();
  await device.page.locator('[data-code-input]').fill(code);
  await device.page.locator('[data-join]').click();
  await expect(device.page.locator('[data-join]')).toHaveText('等待对方确认…');
}

test('five devices reuse one code, need individual approvals and receive a broadcast after pairing', async ({ browser, baseURL }, testInfo) => {
  const devices = [];
  try {
    for (const name of ['多人配对主机', '设备 1', '设备 2', '设备 3', '设备 4', '设备 5']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [owner, ...guests] = devices;
    const code = await codeFor(owner);
    await expect(owner.page.locator('#qt-code-panel')).toContainText('此码在有效期内可供多人使用');
    await owner.page.screenshot({ path: testInfo.outputPath('同码多人配对-连接码.png'), fullPage: true });
    await Promise.all(guests.map((guest) => request(guest, code)));
    const pending = owner.page.locator('[data-request-count]');
    await expect(pending).toHaveText('5 台设备等待确认，请逐一确认');
    await owner.page.locator('[data-action="allow"]').focus();
    await owner.page.screenshot({ path: testInfo.outputPath('同码多人配对-5台待确认.png'), fullPage: true });
    await owner.page.locator('[data-action="close"]').click();
    await owner.page.locator('[data-locale]').selectOption('en');
    await owner.page.locator('[data-action="connect"]').click();
    await expect(pending).toHaveText('5 devices awaiting confirmation. Approve each device individually.');
    await owner.page.setViewportSize({ width: 375, height: 812 });
    expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await owner.page.screenshot({ path: testInfo.outputPath('同码多人配对-英文窄屏.png'), fullPage: true });
    await owner.page.locator('[data-action="close"]').click();
    await owner.page.locator('[data-locale]').selectOption('zh-CN');
    await owner.page.locator('[data-action="connect"]').click();
    const waiting = new Map(guests.map((guest) => [guest.name, guest]));
    while (waiting.size) {
      const name = await owner.page.locator('[data-request-name]').textContent();
      const current = waiting.get(name);
      expect(current).toBeTruthy();
      for (const guest of waiting.values()) {
        await expect(guest.page.locator('.qt-overlay')).toBeVisible();
        await expect(guest.page.locator('[data-target]')).not.toContainText(owner.name);
      }
      await owner.page.locator('[data-action="allow"]').click();
      await expect(current.page.locator('.qt-overlay')).toBeHidden();
      await expect(current.page.locator('[data-target]')).toContainText(owner.name);
      waiting.delete(name);
      if (waiting.size > 1) {
        await expect(pending).toHaveText(`${waiting.size} 台设备等待确认，请逐一确认`);
      }
      else {
        await expect(pending).toBeHidden();
      }
    }
    await expect(owner.page.locator('.qt-overlay')).toBeHidden();
    await owner.page.locator('[data-action="connect"]').click();
    await expect(owner.page.locator('[data-code]')).toHaveText(`${code.slice(0, 4)} ${code.slice(4)}`);
    await expect(owner.page.locator('[data-code-expiry]')).not.toContainText('已过期');
    await owner.page.locator('[data-action="close"]').click();
    await expect(owner.page.locator('[data-target] option')).toHaveCount(6);
    await owner.page.locator('[data-target]').selectOption('all-online');
    await owner.page.locator('[data-editor]').fill('一个连接码，逐台确认后群发给五台设备。');
    await owner.page.locator('[data-action="send"]').click();
    await expect(owner.page.locator('[data-group-status]')).toContainText('全部送达');
    for (const guest of guests) {
      await expect(guest.page.locator('pre')).toHaveText('一个连接码，逐台确认后群发给五台设备。');
      await guest.page.locator('[data-action="devices"]').click();
      await expect(guest.page.locator('[data-action="forget"]')).toHaveCount(1);
      await expect(guest.page.locator('[data-devices-list]')).toContainText(owner.name);
      await guest.page.locator('[data-action="close"]').click();
    }
    await owner.page.setViewportSize({ width: 1280, height: 900 });
    await owner.page.locator('[data-action="devices"]').click();
    await expect(owner.page.locator('[data-action="forget"]')).toHaveCount(5);
    await owner.page.screenshot({ path: testInfo.outputPath('同码多人配对-5台已连接.png'), fullPage: true });
  }
  finally {
    await Promise.all(devices.map((device) => device.context.close()));
  }
});

test('cancelling a queued request updates the count and rejected devices can reuse the same code', async ({ browser, baseURL }) => {
  const devices = [];
  try {
    for (const name of ['确认主机', '申请 A', '申请 B', '申请 C']) {
      devices.push(await device(browser, baseURL, name));
    }
    const [owner, ...guests] = devices;
    const code = await codeFor(owner);
    await Promise.all(guests.map((guest) => request(guest, code)));
    const pending = owner.page.locator('[data-request-count]');
    await expect(pending).toHaveText('3 台设备等待确认，请逐一确认');
    const shown = await owner.page.locator('[data-request-name]').textContent();
    const cancelled = guests.find((guest) => guest.name !== shown);
    await cancelled.page.locator('[data-action="close"]').click();
    await expect(pending).toHaveText('2 台设备等待确认，请逐一确认');
    await expect(owner.page.locator('[data-request-name]')).toHaveText(shown);
    await owner.page.locator('[data-action="deny"]').click();
    const denied = guests.find((guest) => guest.name === shown);
    await expect(denied.page.locator('.qt-overlay')).toBeHidden();
    await expect(pending).toBeHidden();
    const last = guests.find((guest) => guest !== denied && guest !== cancelled);
    await expect(owner.page.locator('[data-request-name]')).toHaveText(last.name);
    await owner.page.locator('[data-action="allow"]').click();
    await expect(last.page.locator('.qt-overlay')).toBeHidden();
    await expect(owner.page.locator('.qt-overlay')).toBeHidden();
    await Promise.all([denied, cancelled].map((guest) => request(guest, code)));
    await expect(pending).toHaveText('2 台设备等待确认，请逐一确认');
    await owner.page.locator('[data-action="allow"]').click();
    await expect(pending).toBeHidden();
    await owner.page.locator('[data-action="allow"]').click();
    await expect(owner.page.locator('.qt-overlay')).toBeHidden();
    await expect(owner.page.locator('[data-target] option')).toHaveCount(4);
  }
  finally {
    await Promise.all(devices.map((device) => device.context.close()));
  }
});
