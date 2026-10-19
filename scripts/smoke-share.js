import { chromium, expect as baseExpect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const expect = baseExpect.configure({ timeout: 20000 });
const origin = new URL(process.argv[2] || 'https://xcopy.werfamily.fun').origin;
const relay = process.argv.includes('--relay');
if (!origin.startsWith('https://') && !origin.startsWith('http://localhost:')) {
  throw new Error('验收只接受 HTTPS 或 localhost');
}
const output = resolve(process.env.XCOPY_ARTIFACTS || `test-results/share-${relay ? 'relay' : 'direct'}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const contexts = [];
const checks = [];
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function page() {
  const context = await browser.newContext();
  contexts.push(context);
  await context.addInitScript(({ relay }) => {
    window.shareRoutes = [];
    const PC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends PC {
      constructor(config) {
        super(relay ? { ...config, iceTransportPolicy: 'relay' } : config);
        this.addEventListener('connectionstatechange', async () => {
          if (this.connectionState !== 'connected') {
            return;
          }
          const stats = await this.getStats();
          for (const report of stats.values()) {
            if (report.type === 'transport' && report.selectedCandidatePairId) {
              const pair = stats.get(report.selectedCandidatePairId);
              window.shareRoutes.push([stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)].some((c) => c?.candidateType === 'relay') ? 'relay' : 'direct');
            }
          }
        });
      }
    };
  }, { relay });
  return context.newPage();
}
try {
  const sender = await page();
  await sender.goto(`${origin}/transfer`);
  await expect(sender.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await sender.getByRole('tab', { name: '链接分享', exact: true }).click();
  const files = Array.from({ length: 8 }, (_, i) => ({ name: i === 0 ? '分享验收 中文.txt' : `share-${i}.bin`, mimeType: 'application/octet-stream', buffer: i === 7 ? Buffer.alloc(0) : Buffer.alloc(i === 6 ? 2 * 1048576 : 2048, i + 25) }));
  await sender.locator('[data-files]').setInputFiles(files);
  await sender.locator('[data-share-generate]').click();
  await expect(sender.locator('[data-share-url]')).toBeVisible();
  await sender.getByRole('tab', { name: '发送给设备', exact: true }).click();
  await expect(sender.locator('[data-attachments]')).toBeHidden();
  await sender.getByRole('tab', { name: '链接分享', exact: true }).click();
  await expect(sender.locator('.qt-intro')).toBeVisible();
  checks.push('创建分享后切换 tab，待发送文件已清空，公共标题保持可见');
  const url = await sender.locator('[data-share-url]').inputValue();
  const image = PNG.sync.read(await sender.locator('.share-qr').screenshot());
  expect(jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data).toBe(url);
  checks.push('8 个文件、二维码解码与分享链接完全一致');
  await sender.screenshot({ path: `${output}/sender.png`, fullPage: true });
  const recipient = await page();
  const other = await page();
  await recipient.goto(url);
  await other.goto(url);
  await expect(recipient.locator('[data-claim]')).toBeEnabled();
  await expect(other.locator('[data-claim]')).toBeEnabled();
  checks.push('两名访客预览不消耗链接');
  await expect(recipient.locator('[data-recipient-name]')).toHaveText(/^你的设备：(Android|iOS|iPadOS|Windows|macOS|Linux|Device)-[A-HJ-NP-Z2-9]{4}$/);
  const recipientName = `验收手机-${Date.now().toString(36)}`;
  await recipient.getByRole('button', { name: '修改领取设备名称' }).click();
  await recipient.getByLabel('你的设备名称', { exact: true }).fill(recipientName);
  await recipient.getByRole('button', { name: '保存名称' }).click();
  await recipient.reload();
  await expect(recipient.locator('[data-recipient-name]')).toHaveText(`你的设备：${recipientName}`);
  checks.push('系统前缀默认名、页内改名和刷新记忆通过');
  await recipient.locator('[data-claim]').click();
  await expect(recipient.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成', { timeout: 90000 });
  await expect(sender.locator('[data-share-record]')).toHaveAttribute('data-status', 'completed');
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('这份分享已被领取');
  await expect(sender.locator('[data-share-record] [data-recipient-name]')).toHaveText(`接收设备：${recipientName}`);
  await expect(other.locator('body')).not.toContainText(recipientName);
  checks.push('领取记录显示实际设备名称，其他预览者不可见');
  const verified = [];
  for (let i = 0; i < files.length; i += 1) {
    const event = recipient.waitForEvent('download');
    await recipient.locator(`[data-save-index="${i}"]`).click();
    const download = await event;
    const bytes = await readFile(await download.path());
    expect(bytes).toEqual(files[i].buffer);
    verified.push({ name: files[i].name, bytes: bytes.length, sha256: hash(bytes) });
  }
  checks.push('8 个文件下载字节一致，包含空文件、中文文件名和 2 MiB 二进制');
  const zipEvent = recipient.waitForEvent('download');
  await recipient.locator('[data-save-all]').click();
  const zip = await zipEvent;
  await zip.saveAs(`${output}/files.zip`);
  await other.reload();
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('这份分享已被领取');
  expect(await recipient.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  checks.push('领取后重开链接失效，访客未创建永久设备身份');
  const routes = [...await sender.evaluate(() => window.shareRoutes), ...await recipient.evaluate(() => window.shareRoutes)];
  expect(routes.length).toBeGreaterThanOrEqual(8);
  if (relay) {
    expect(routes.every((route) => route === 'relay')).toBe(true);
  }
  await recipient.setViewportSize({ width: 375, height: 812 });
  expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await recipient.screenshot({ path: `${output}/recipient-mobile.png`, fullPage: true });
  await sender.getByRole('button', { name: '创建新的分享' }).click();
  await expect(sender.locator('[data-share-generate]')).toBeDisabled();
  await sender.locator('[data-files]').setInputFiles(files);
  await sender.locator('[data-share-generate]').click();
  const cancelled = await sender.locator('[data-share-url]').inputValue();
  sender.once('dialog', (d) => d.accept());
  await sender.locator('[data-share-panel]').getByRole('button', { name: '取消分享', exact: true }).click();
  await expect(sender.locator('[data-share-generate]')).toBeDisabled();
  await expect(sender.locator('.share-upload .share-file')).toHaveCount(0);
  await expect(sender.getByRole('button', { name: '创建新的分享' })).toHaveCount(0);
  await expect(sender.locator('[data-share-record][data-status="cancelled"]')).toBeVisible();
  checks.push('取消后直接显示空白分享表单，取消记录保留在历史记录');
  await other.goto(cancelled);
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('分享已被取消');
  checks.push('新分享取消后无法领取，手机布局无横向溢出');
  const report = { ok: true, origin, relay, timestamp: new Date().toISOString(), checks, files: verified, routes };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, error: error.stack }, null, 2));
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
