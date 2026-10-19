import { chromium, expect as baseExpect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const expect = baseExpect.configure({ timeout: 15000 });
const origin = new URL(process.argv[2] || 'https://xcopy.werfamily.fun').origin;
if (!origin.startsWith('https://')) {
  throw new Error('部署验收只接受 HTTPS 地址');
}
const forceRelay = process.argv.includes('--relay');
const expectedStun = process.env.XCOPY_EXPECT_STUN;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const contexts = [];
const stamp = Date.now().toString(36);
let sender;
let recipient;

async function device(name) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  contexts.push(context);
  await context.addInitScript(({ relay }) => {
    const PeerConnection = window.RTCPeerConnection;
    window.deploymentIceConfigs = [];
    window.RTCPeerConnection = class extends PeerConnection {
      constructor(config) {
        super(relay ? { ...config, iceTransportPolicy: 'relay' } : config);
        // Record only public server URLs and policies; never retain TURN credentials.
        window.deploymentIceConfigs.push({
          urls: (config.iceServers || []).flatMap((server) => server.urls),
          requestedPolicy: config.iceTransportPolicy,
          effectivePolicy: this.getConfiguration().iceTransportPolicy
        });
      }
    };
  }, { relay: forceRelay });
  const page = await context.newPage();
  await page.goto(origin);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('这边复制');
  await page.getByRole('link', { name: '开始传输', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready', { timeout: 20000 });
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(name);
  await page.locator('[data-action="rename"]').click();
  await expect(page.locator('[data-local-name]')).toHaveText(name);
  await expect(page.locator('.qt-overlay')).toBeHidden();
  return page;
}

try {
  sender = await device(`部署验收 A ${stamp}`);
  recipient = await device(`部署验收 B ${stamp}`);
  await sender.locator('[data-action="connect"]').click();
  await expect(sender.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  const previousCode = await sender.locator('[data-code]').textContent();
  await sender.locator('[data-action="refresh-code"]').click();
  await expect(sender.locator('[data-code]')).not.toHaveText(previousCode);
  await expect(sender.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  const code = (await sender.locator('[data-code]').textContent()).replace(/\s/g, '');
  await recipient.locator('[data-action="connect"]').click();
  await recipient.locator('[data-pair-tab="enter"]').click();
  await recipient.locator('[data-code-input]').fill(code);
  await recipient.locator('[data-join]').click();
  await expect(sender.locator('[data-approval-panel]')).toBeVisible();
  await sender.locator('[data-action="allow"]').click();
  await expect(sender.locator('.qt-overlay')).toBeHidden();
  await expect(recipient.locator('.qt-overlay')).toBeHidden();

  // Fill all three outgoing slots before allowing the batch to drain.
  await sender.evaluate(async () => {
    const { Transfers } = await import('/transfer.js');
    const sendBytes = Transfers.prototype.sendBytes;
    const gate = new Promise((resolve) => { window.releaseSmokeBatch = resolve; });
    Transfers.prototype.sendBytes = async function (item) {
      await gate;
      return sendBytes.call(this, item);
    };
  });
  const files = Array.from({ length: 7 }, (_, index) => ({
    name: `deployment-${index}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(128 * 1024, index + 1)
  }));
  files.push({
    name: 'deployment-image.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64')
  });
  const message = '  阿里云部署验收\n<script>内容保持为文字</script>  ';
  await sender.locator('[data-files]').setInputFiles(files);
  await sender.locator('[data-editor]').fill(message);
  await sender.locator('[data-action="send"]').click();
  const route = forceRelay ? '[data-route="relay"]' : '';
  await expect(sender.locator(`[data-status="transferring"]${route}`)).toHaveCount(3, { timeout: 35000 });
  await expect(sender.locator('[data-status="queued"]')).toHaveCount(6);
  await expect(recipient.locator(`[data-status="transferring"]${route}`)).toHaveCount(3, { timeout: 10000 });
  await recipient.locator('[data-action="devices"]').click();
  await expect(recipient.locator('[data-action="forget"]')).toBeDisabled();
  await recipient.locator('[data-action="close"]').click();
  await sender.evaluate(() => window.releaseSmokeBatch());
  await expect(recipient.locator(`[data-status="completed"]${route}`)).toHaveCount(9, { timeout: 60000 });
  await expect(sender.locator(`[data-status="completed"]${route}`)).toHaveCount(9, { timeout: 10000 });
  expect(await recipient.locator('pre').textContent()).toBe(message);
  await expect(recipient.locator('.qt-received-image')).toHaveCount(1);
  for (const file of files) {
    const downloaded = recipient.waitForEvent('download');
    await recipient.locator('[data-transfer]').filter({ hasText: file.name }).locator('[data-action="save-file"]').click();
    expect(await readFile(await (await downloaded).path())).toEqual(file.buffer);
  }
  const iceConfigs = [];
  for (const page of [sender, recipient]) {
    const configs = await page.evaluate(() => window.deploymentIceConfigs);
    expect(configs).toHaveLength(9);
    for (const config of configs) {
      expect(config.requestedPolicy).toBe('all');
      expect(config.effectivePolicy).toBe(forceRelay ? 'relay' : 'all');
      if (expectedStun) {
        expect(config.urls.filter((url) => url.startsWith('stun:') || url.startsWith('stuns:'))).toEqual([expectedStun]);
      }
    }
    iceConfigs.push(...configs);
  }
  const routes = [...new Set(await recipient.locator('[data-status="completed"]').evaluateAll((rows) => rows.map((row) => row.dataset.route)))];
  await sender.reload();
  await expect(sender.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready', { timeout: 15000 });
  await expect(sender.locator('[data-local-name]')).toHaveText(`部署验收 A ${stamp}`);
  await expect(sender.locator('[data-transfer]')).toHaveCount(0);
  await expect(sender.locator('[data-target] option')).toHaveCount(2);
  await sender.locator('[data-action="devices"]').click();
  await sender.locator('[data-action="forget"]').click();
  await expect(sender.locator('[data-devices-list]')).toHaveText('还没有配对设备');
  await recipient.locator('[data-action="devices"]').click();
  await expect(recipient.locator('[data-devices-list]')).toHaveText('还没有配对设备');
  console.log(JSON.stringify({ origin, mode: forceRelay ? 'forced-relay' : 'automatic', transfers: 9, byteComparison: 'passed', identityAndRevocation: 'passed', routes, iceConfigs }, null, 2));
} finally {
  try {
    if (sender && !sender.isClosed()) {
      sender.on('dialog', async (dialog) => { await dialog.accept(); });
      await sender.reload();
      await expect(sender.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready', { timeout: 20000 });
      await sender.locator('[data-action="devices"]').click();
      const forget = sender.locator('[data-action="forget"]');
      while (await forget.count()) {
        const count = await forget.count();
        await expect(forget.first()).toBeEnabled({ timeout: 25000 });
        await forget.first().click();
        await expect(forget).toHaveCount(count - 1);
      }
    }
  } catch (error) {
    console.error('测试配对清理失败：', error.message);
    process.exitCode = 1;
  }
  await Promise.allSettled(contexts.map((context) => context.close()));
  await browser.close();
}
