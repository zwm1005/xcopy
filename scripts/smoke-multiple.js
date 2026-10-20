import { chromium, expect as baseExpect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const expect = baseExpect.configure({ timeout: 25000 });
const origin = new URL(process.argv[2] || 'https://xcopy.werfamily.fun').origin;
const relay = process.argv.includes('--relay');
const expiry = process.argv.includes('--expiry');
if (!origin.startsWith('https://') && !origin.startsWith('http://localhost:')) {
  throw new Error('验收只接受 HTTPS 或 localhost');
}
const output = resolve(process.env.XCOPY_ARTIFACTS || `test-results/multiple-${expiry ? 'expiry' : relay ? 'relay' : 'direct'}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const contexts = [];
const checks = [];
const verified = [];
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const files = [
  { name: '多人领取说明.txt', mimeType: 'text/plain', buffer: Buffer.from('随传：一次领取与多人领取独立验证。\n') },
  { name: '共享文件.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512 * 1024, 137) },
  { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }
];
async function page() {
  const context = await browser.newContext({ locale: 'zh-CN' });
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
              window.shareRoutes.push([stats.get(pair?.localCandidateId), stats.get(pair?.remoteCandidateId)].some((c) => c?.candidateType === 'relay') ? 'relay' : 'direct');
            }
          }
        });
      }
    };
  }, { relay });
  return context.newPage();
}
async function sender(mode, bundle, behavior = {}) {
  const p = await page();
  await p.goto(`${origin}/transfer`);
  await expect(p.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await p.evaluate(async ({ hold, fail }) => {
    const { Connection } = await import('/connection.js');
    const rpc = Connection.prototype.rpc;
    Connection.prototype.rpc = async function (type, data) {
      const result = await rpc.call(this, type, data);
      if (type === 'share.create') {
        window.createdShare = result;
      }
      return result;
    };
    const { Transfers } = await import('/transfer.js');
    const sendBytes = Transfers.prototype.sendBytes;
    let firstClaim;
    let failed = false;
    window.shareAttempts = [];
    const gate = hold ? new Promise((resolveGate) => { window.releaseShare = resolveGate; }) : Promise.resolve();
    Transfers.prototype.sendBytes = async function (item) {
      firstClaim ||= item.claimId;
      window.shareAttempts.push({ claimId: item.claimId, index: item.shareIndex });
      await gate;
      if (fail && item.claimId === firstClaim && item.shareIndex === 1 && !failed) {
        failed = true;
        throw new Error('验收：模拟一次发送数据连接失败');
      }
      return sendBytes.call(this, item);
    };
  }, behavior);
  await p.getByRole('tab', { name: '链接分享', exact: true }).click();
  await p.locator('[data-files]').setInputFiles(bundle);
  if (mode === 'multiple') {
    await p.getByText('更多设置', { exact: true }).click();
    await p.getByRole('radio', { name: '多人领取', exact: true }).check();
  }
  await p.locator('[data-share-generate]').click();
  await expect(p.locator('[data-share-url]')).toBeVisible();
  const url = await p.locator('[data-share-url]').inputValue();
  const expires = await p.evaluate(() => window.createdShare.expires);
  return { page: p, url, expires };
}
async function recipient(url) {
  const p = await page();
  await p.goto(url);
  await expect(p.locator('[data-claim]')).toBeEnabled();
  return p;
}
async function verify(p, bundle) {
  await expect(p.getByRole('heading', { level: 1 })).toHaveText('全部文件接收完成', { timeout: 90000 });
  for (let index = 0; index < bundle.length; index += 1) {
    const event = p.waitForEvent('download');
    await p.locator(`[data-save-index="${index}"]`).click();
    const bytes = await readFile(await (await event).path());
    expect(bytes).toEqual(bundle[index].buffer);
    verified.push({ name: bundle[index].name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
async function stop(s) {
  s.page.once('dialog', (d) => d.accept());
  await s.page.getByRole('button', { name: '结束分享', exact: true }).click();
  await expect(s.page.locator('[data-share-panel]')).toContainText('分享已结束');
}
try {
  if (expiry) {
    const startedAt = Date.now();
    const single = await sender('single', files.slice(0, 1));
    const multiple = await sender('multiple', files.slice(0, 1), { hold: true });
    const previewSingle = await recipient(single.url);
    const late = await recipient(multiple.url);
    const recipients = [];
    for (let i = 0; i < 4; i += 1) {
      recipients.push(await recipient(multiple.url));
    }
    checks.push('线上创建真实 10 分钟链接；未改服务器时钟或有效期');
    while (Date.now() < multiple.expires - 15000) {
      console.log(JSON.stringify({ stage: '等待线上真实到期', secondsLeft: Math.ceil((multiple.expires - Date.now()) / 1000) }));
      await pause(Math.min(30000, multiple.expires - 15000 - Date.now()));
    }
    await Promise.all(recipients.map((p) => p.locator('[data-claim]').click()));
    await expect(multiple.page.locator('.share-counts')).toHaveText('已领取 0 次');
    await pause(Math.max(0, multiple.expires - Date.now() + 1500));
    await expect(previewSingle.getByRole('heading', { level: 1 })).toHaveText('这份分享已过期');
    await expect(previewSingle.locator('[data-claim]')).toHaveCount(0);
    await expect(late.getByRole('heading', { level: 1 })).toHaveText('分享已停止新的领取');
    await expect(late.locator('[data-claim]')).toHaveCount(0);
    await multiple.page.evaluate(() => window.releaseShare());
    for (const p of recipients) {
      await verify(p, files.slice(0, 1));
    }
    await expect(multiple.page.locator('[data-share-panel]')).toContainText('分享已过期');
    await expect(multiple.page.locator('.share-counts')).toHaveText('已领取 4 次');
    checks.push(`真实等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒：一次领取过期拒绝领取；多人到期拒绝新领取，3 个在传和 1 个排队任务完成且下载字节一致`);
    await multiple.page.screenshot({ path: `${output}/多人真实到期.png`, fullPage: true });
    await previewSingle.screenshot({ path: `${output}/一次领取真实到期.png`, fullPage: true });
  } else {
    const bundle = files.slice(1, 2);
    const s = await sender('multiple', bundle, { hold: true });
    const recipients = [];
    for (let i = 0; i < 4; i += 1) {
      recipients.push(await recipient(s.url));
    }
    await Promise.all(recipients.map((p) => p.locator('[data-claim]').click()));
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 0 次');
    await expect.poll(() => s.page.evaluate(() => new Set(window.shareAttempts.map((i) => i.claimId)).size)).toBe(3);
    await s.page.locator('[data-share-record]').getByRole('button', { name: '查看详情' }).click();
    await expect(s.page.locator('[data-claim-state="transferring"]')).toHaveCount(3);
    await expect(s.page.locator('[data-claim-state="queued"]')).toHaveCount(1);
    await s.page.screenshot({ path: `${output}/多人并发与排队.png`, fullPage: true });
    await s.page.evaluate(() => window.releaseShare());
    for (const p of recipients) {
      await verify(p, bundle);
    }
    checks.push('3 个独立接收会话同时传输，第 4 个排队后自动完成，下载字节一致');
    for (let i = 4; i < 12; i += 1) {
      const p = await recipient(s.url);
      recipients.push(p);
      await p.locator('[data-claim]').click();
      await verify(p, bundle);
    }
    await expect(s.page.locator('.share-counts')).toHaveText('已领取 12 次');
    await expect(s.page.locator('[data-share-url]')).toHaveValue(s.url);
    checks.push('同一链接完成 12 次领取后仍保持开放，无 5/10 人累计上限');
    for (const width of [1280, 375, 320]) {
      await s.page.setViewportSize({ width, height: 850 });
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await s.page.screenshot({ path: `${output}/多人领取记录-${width}.png`, fullPage: true });
    }
    await stop(s);
    await verify(recipients[0], bundle);
    checks.push('结束分享后进入紧凑结束态，已接收文件仍可保存');
    const retry = await sender('multiple', files, { fail: true });
    const a = await recipient(retry.url);
    const b = await recipient(retry.url);
    await a.locator('[data-claim]').click();
    await b.locator('[data-claim]').click();
    await expect(a.getByRole('heading', { level: 1 })).toHaveText('连接中断，可以重试');
    await expect(a.locator('[data-save-index="0"]')).toBeVisible();
    await expect(a.locator('[data-save-index="2"]')).toBeVisible();
    await verify(b, files);
    const before = await retry.page.evaluate(() => window.shareAttempts.length);
    await a.getByRole('button', { name: '重试未完成的文件' }).click();
    await verify(a, files);
    const attempts = await retry.page.evaluate(() => window.shareAttempts);
    expect(attempts.length - before).toBe(1);
    expect(attempts.at(-1).index).toBe(1);
    await expect(retry.page.locator('.share-counts')).toHaveText('已领取 2 次');
    checks.push('对第一个领取者注入一次数据发送失败，第二人不受影响；仅重试失败文件，所有下载字节一致');
    await stop(retry);
  }
  const routes = [];
  for (const context of contexts) {
    for (const p of context.pages()) {
      routes.push(...await p.evaluate(() => window.shareRoutes));
    }
  }
  expect(routes.length).toBeGreaterThan(0);
  if (relay) {
    expect(routes.every((route) => route === 'relay')).toBe(true);
    checks.push('全部已建立数据连接均确认通过 TURN 中继');
  }
  const report = { ok: true, origin, relay, expiry, timestamp: new Date().toISOString(), checks, verified, routes };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, checks, verifiedDownloads: verified.length, routes }));
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, error: error.stack }, null, 2));
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
