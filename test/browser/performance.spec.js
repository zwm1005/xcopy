import { test, expect } from './fixtures.js';

test('slow optional configuration does not delay authentication or override a later language choice', async ({ page, baseURL }) => {
  let release;
  let requested;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  await page.route('**/api/client-config', async route => {
    requested();
    await pending;
    await route.fulfill({ json: { defaultLocale: 'zh-CN', supportedLocales: ['zh-CN', 'en'], cliDownloadUrl: '/downloads/xcopy/' } });
  });
  try {
    await page.goto(`${baseURL}/transfer?lang=zh-CN`);
    await started;
    // This must happen before the configuration request's 3-second timeout.
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready', { timeout: 1800 });
    await page.locator('[data-locale]').selectOption('en');
    const configured = page.waitForResponse('**/api/client-config');
    release();
    await configured;
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
    await page.goto(baseURL);
    await expect(page.locator('[data-cli-download]').first()).toHaveAttribute('href', `${baseURL}/downloads/xcopy/`);
  } finally {
    release();
  }
});

test('progress retains existing history rows, focus and hidden share UI with 500 records', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...args) {
      if (type === 'change' && this.constructor.name === 'Transfers') {
        window.testTransfers = this;
      }
      return original.call(this, type, ...args);
    };
  });
  await page.goto(`${baseURL}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  const result = await page.evaluate(() => {
    const model = window.testTransfers;
    clearInterval(model.maintenance);
    model.items = Array.from({ length: 501 }, (_, index) => ({
      localId: `history-${index}`, status: index ? 'completed' : 'transferring',
      kind: 'file', mime: 'application/octet-stream', name: `file-${index}.bin`,
      size: 1048576, bytes: index ? 1048576 : 0, incoming: false,
      peerId: 'test-peer', peerName: 'Receiver', activity: Date.now(),
      chunks: [], parts: [], candidates: [], route: 'direct', reason: '', sourceIndex: 0
    }));
    model.dispatchEvent(new Event('change'));
    const list = document.querySelector('[data-transfers]');
    const completed = list.children[1];
    const active = list.children[0];
    const cancel = active.querySelector('[data-action="cancel"]');
    cancel.focus();
    const panel = document.querySelector('[data-share-panel]');
    const panelChildren = [...panel.childNodes];
    const observer = new MutationObserver(() => {});
    observer.observe(list, { childList: true });
    model.items[0].bytes = 262144;
    model.items[0].speed = 12345;
    for (let i = 0; i < 5; i += 1) {
      model.dispatchEvent(new Event('change'));
    }
    const result = {
      completedRetained: completed === list.children[1],
      activeRetained: active === list.children[0],
      focusRetained: document.activeElement === cancel,
      listMutations: observer.takeRecords().length,
      progress: active.querySelector('progress').value,
      hiddenPanelRetained: panelChildren.length === panel.childNodes.length && panelChildren.every((node, index) => panel.childNodes[index] === node)
    };
    observer.disconnect();
    return result;
  });
  expect(result).toEqual({
    completedRetained: true, activeRetained: true, focusRetained: true,
    listMutations: 0, progress: 262144, hiddenPanelRetained: true
  });
  await page.locator('[data-action="clear"]').click();
  await expect(page.locator('[data-transfer]')).toHaveCount(1);
  await page.locator('[data-action="cancel"]').click();
});
