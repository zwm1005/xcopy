import { returningVisitor } from './smoke-visitor.js';
import { assertFrontend } from './frontend-artifact.js';
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// With XCOPY_REMOTE, use an already initialized daemon on that SSH target.
// Otherwise start an isolated local server and CLI daemon; no user identity is touched.
const remote = process.env.XCOPY_REMOTE;
if (!remote) {
  await assertFrontend({ fresh: true });
}
const remoteBin = process.env.XCOPY_REMOTE_BIN || '/home/haha/.local/bin/xcopy';
const sshArgs = JSON.parse(process.env.XCOPY_SSH_ARGS || '["-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=8"]');
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const defaultBinary = process.platform === 'linux' ? `cli/dist/xcopy_0.1.2_linux_${arch}/xcopy` : `cli/dist/xcopy-${process.platform}-${arch}`;
const localBin = resolve(process.env.XCOPY_BINARY || defaultBinary);
const temp = await mkdtemp(join(tmpdir(), 'xcopy-smoke-'));
const artifactDir = resolve(process.env.XCOPY_ARTIFACTS || 'test-results/cli');
await mkdir(artifactDir, { recursive: true });
const origin = process.env.XCOPY_ORIGIN || (remote ? 'https://xcopy.werfamily.fun' : 'http://localhost:8797');
const env = { ...process.env, XCOPY_HOME: temp, GORACE: `${process.env.GORACE || ''} atexit_sleep_ms=0`.trim() };
const children = [];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function run(command, args, input, childEnv = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) { resolve(stdout); } else { reject(new Error(`${command} exited ${code}: ${stderr}\n${stdout}`)); }
    });
    child.stdin.end(input);
  });
}
function ssh(command) { return run('ssh', [...sshArgs, remote, command]); }
async function cli(args, input) {
  const output = remote
    ? await run('ssh', [...sshArgs, remote, ['env', ...(process.env.XCOPY_REMOTE_HOME ? [`XCOPY_HOME=${process.env.XCOPY_REMOTE_HOME}`] : []), remoteBin, ...args, '--json'].map(quote).join(' ')], input)
    : await run(localBin, [...args, '--json'], input, env);
  return JSON.parse(output);
}
async function readReceived(path) {
  if (!remote) { return readFile(path); }
  return Buffer.from(await ssh(`base64 ${quote(path)}`), 'base64');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function online() {
  await expect.poll(async () => {
    try { return (await cli(['status'])).online; } catch { return false; }
  }, { timeout: 40000 }).toBe(true);
}
let daemon;
let daemonLogs = '';
const daemonExits = [];
function startDaemon() {
  daemon = spawn(localBin, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(daemon);
  daemon.stdout.on('data', b => { daemonLogs += b; });
  daemon.stderr.on('data', b => { daemonLogs += b; });
  daemon.on('exit', code => { daemonExits.push(code); });
}
async function stop(child) {
  if (!child || child.exitCode !== null) { return; }
  const done = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await done;
}
let browser; let page; let paired = false; let browserPeer;
const checks = [];
try {
  if (!remote) {
    const url = new URL(origin);
    const server = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: url.port, PUBLIC_ORIGIN: origin, DB_PATH: join(temp, 'server.sqlite') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(server);
    server.stderr.on('data', b => process.stderr.write(b));
    await expect.poll(async () => { try { return (await fetch(`${origin}/healthz`)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
    await cli(['init', '--name', 'xcopy 测试终端', '--server', origin, '--receive-dir', join(temp, 'inbox')]);
    startDaemon();
  }
  await online();
  const before = await cli(['status']);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ locale: 'zh-CN' });
  await returningVisitor(context);
  await context.addInitScript(({ relay }) => {
    const PC = window.RTCPeerConnection;
    window.__xcopyIceErrors = [];
    window.__xcopyIceTrace = [];
    window.__xcopyPCs = [];
    window.RTCPeerConnection = class extends PC {
      constructor(config) {
        super(relay ? { ...config, iceTransportPolicy: 'relay' } : config);
        window.__xcopyPCs.push(this);
        window.__xcopyIceTrace.push({ kind: 'config', policy: this.getConfiguration().iceTransportPolicy, urls: (config.iceServers || []).flatMap(s => s.urls) });
        this.addEventListener('icecandidateerror', event => window.__xcopyIceErrors.push({ code: event.errorCode, text: event.errorText, url: event.url }));
        this.addEventListener('iceconnectionstatechange', () => window.__xcopyIceTrace.push({ kind: 'state', state: this.iceConnectionState }));
        this.addEventListener('icecandidate', event => window.__xcopyIceTrace.push({ kind: 'candidate', type: event.candidate?.type, protocol: event.candidate?.protocol }));
        this.addEventListener('connectionstatechange', () => {
          window.__xcopyIceTrace.push({ kind: 'connection', state: this.connectionState });
        });
      }
    };
  }, { relay: process.env.XCOPY_FORCE_RELAY === '1' });
  page = await context.newPage();
  await page.goto(`${origin}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready', { timeout: 25000 });
  const browserName = `CLI验收 ${Date.now().toString(36)}`;
  await page.locator('[data-action="devices"]').click();
  await page.locator('[data-name-input]').fill(browserName);
  await page.locator('[data-action="rename"]').click();
  await expect(page.locator('.qt-overlay')).toBeHidden();
  await page.locator('[data-action="connect"]').click();
  await expect(page.locator('[data-code]')).toHaveText(/\d{4} \d{4}/);
  const code = (await page.locator('[data-code]').textContent()).replace(/\s/g, '');
  await cli(['pair', 'join', code, '--detach']);
  await expect(page.locator('[data-approval-panel]')).toBeVisible();
  await page.locator('[data-action="allow"]').click();
  await expect(page.locator('.qt-overlay')).toBeHidden();
  paired = true;
  await expect.poll(async () => (await cli(['devices'])).some(p => p.name === browserName), { timeout: 10000 }).toBe(true);
  browserPeer = (await cli(['devices'])).find(p => p.name === browserName);
  await page.locator('[data-target]').selectOption({ label: before.name });
  checks.push('浏览器批准 CLI 配对');
  const text = '  Linux ↔ 浏览器\n<script>只作为文字</script>\n树莓派 🍓\t结尾空格  ';
  await page.locator('[data-editor]').fill(text);
  await page.locator('[data-action="send"]').click();
  const incoming = async () => (await cli(['inbox'])).filter(r => r.peerId === browserPeer.id);
  const textDeadline = Date.now() + 45000;
  for (;;) {
    const rows = await incoming();
    if (rows.some(r => r.status === 'failed')) { throw new Error('文字接收失败：' + JSON.stringify(rows)); }
    if (rows.filter(r => r.status === 'completed').length === 1) { break; }
    if (Date.now() > textDeadline) { throw new Error('文字接收超时'); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const textRecord = (await incoming())[0];
  expect((await readReceived(textRecord.path)).toString()).toBe(text);
  expect((await cli(['read', textRecord.id])).text).toBe(text);
  checks.push('浏览器 → CLI：中文、多行、emoji 与首尾空格完全一致');
  const longTurn = process.env.XCOPY_LONG_TURN === '1';
  if (longTurn) {
    await page.evaluate(async () => {
      const { Transfers } = await import('/transfer.js');
      const send = Transfers.prototype.sendBytes;
      Transfers.prototype.sendBytes = async function (item) {
        if (item.name === '浏览器测试.bin') {
          const blob = item.blob;
          item.blob = { slice(start, end) {
            return { async arrayBuffer() {
              await new Promise((resolve) => setTimeout(resolve, 30000));
              return blob.slice(start, end).arrayBuffer();
            } };
          } };
        }
        return send.call(this, item);
      };
    });
  }
  const fileBytes = Buffer.alloc((longTurn ? 32 : process.env.XCOPY_LARGE === '1' ? 50 : 2) * 1048576, 0x5a);
  const files = [
    { name: '浏览器测试.bin', mimeType: 'application/octet-stream', buffer: fileBytes },
    { name: '空文件.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: '测试图.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64') }
  ];
  const filePaths = [];
  for (const file of files) {
    const path = join(temp, file.name);
    await writeFile(path, file.buffer);
    filePaths.push(path);
  }
  await page.locator('[data-files]').setInputFiles(filePaths);
  await page.locator('[data-action="send"]').click();
  const fileStarted = Date.now();
  await expect.poll(async () => (await incoming()).filter(r => r.status === 'completed').length, { timeout: longTurn ? 1500000 : 120000 }).toBe(4);
  if (longTurn) {
    expect(Date.now() - fileStarted).toBeGreaterThan(900000);
    checks.push('真实 TURN：32 MiB 浏览器到 CLI 慢传超过 900 秒凭证有效期');
  }
  for (const file of files) {
    const r = (await incoming()).find(r => r.metadata.name === file.name);
    expect((await readReceived(r.path)).equals(file.buffer)).toBe(true);
    expect(r.sha256).toBe(digest(file.buffer));
  }
  checks.push(`浏览器 → CLI：${fileBytes.length / 1048576} MiB 文件、空文件、PNG 的逐字节及 SHA-256 校验`);
  const sentText = await cli(['send', '--stdin', '--to', browserPeer.id], text);
  expect(sentText.status).toBe('completed');
  const received = page.locator('[data-transfer][data-incoming="true"][data-status="completed"]');
  await expect(received).toHaveCount(1);
  expect(await received.locator('pre').textContent()).toBe(text);
  checks.push('CLI → 浏览器：文字完整保留');
  for (const file of files) {
    if (longTurn && file.name === '浏览器测试.bin') {
      continue;
    }
    const r = (await incoming()).find(r => r.metadata.name === file.name);
    const sent = await cli(['send', r.path, '--to', browserPeer.id]);
    expect(sent.status).toBe('completed');
    const row = received.filter({ hasText: file.name });
    await expect(row).toHaveCount(1);
    const promise = page.waitForEvent('download');
    await row.locator('[data-action="save-file"]').click();
    expect((await readFile(await (await promise).path())).equals(file.buffer)).toBe(true);
  }
  checks.push('CLI → 浏览器：文件、空文件、PNG 下载逐字节一致');
  await page.evaluate(async () => {
    const { Transfers } = await import('/transfer.js');
    const original = Transfers.prototype.sendBytes;
    const gate = new Promise(resolve => { window.releaseCliGate = resolve; });
    Transfers.prototype.sendBytes = async function(item) { await gate; return original.call(this, item); };
  });
  await page.locator('[data-files]').setInputFiles({ name: '取消后重试.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32768, 9) });
  await page.locator('[data-action="send"]').click();
  await expect.poll(async () => (await incoming()).some(r => r.metadata.name === '取消后重试.bin'), { timeout: 30000 }).toBe(true);
  const toCancel = (await incoming()).find(r => r.metadata.name === '取消后重试.bin');
  await cli(['cancel', toCancel.id]);
  const cancelled = page.locator('[data-transfer]').filter({ hasText: '取消后重试.bin' });
  await expect(cancelled).toHaveAttribute('data-status', 'cancelled');
  await cancelled.locator('[data-action="retry"]').click();
  await page.evaluate(() => window.releaseCliGate());
  await expect.poll(async () => (await incoming()).some(r => r.metadata.name === '取消后重试.bin' && r.status === 'completed'), { timeout: 45000 }).toBe(true);
  checks.push('CLI 取消接收；浏览器重试成功');
  if (!remote || process.env.XCOPY_RESTART_SERVICE === '1') {
    if (remote) { await cli(['service', 'restart']).catch(error => { if (!error.message.includes('JSON')) { throw error; } }); } else { await stop(daemon); startDaemon(); }
    await online();
    expect((await cli(['status'])).device.id).toBe(before.device.id);
    expect((await cli(['devices'])).find(p => p.id === browserPeer.id).online).toBe(true);
    expect((await incoming()).filter(r => r.status === 'completed').length).toBe(5);
    checks.push('后台重启后设备身份、配对与传输记录保持');
  }
  await cli(['pair', 'forget', browserPeer.id]);
  paired = false;
  const cliCode = await cli(['pair', 'code']);
  await page.locator('[data-action="connect"]').click();
  await page.locator('[data-pair-tab="enter"]').click();
  await page.locator('[data-code-input]').fill(cliCode.code);
  await page.locator('[data-join]').click();
  await expect.poll(async () => (await cli(['pair', 'requests'])).some(r => r.name === browserName), { timeout: 15000 }).toBe(true);
  const request = (await cli(['pair', 'requests'])).find(r => r.name === browserName);
  expect(request.fingerprint).toBe(browserPeer.id);
  await cli(['pair', 'accept', request.id]);
  paired = true;
  await expect(page.locator('.qt-overlay')).toBeHidden();
  checks.push('CLI 生成配对码、显示请求指纹并批准浏览器');
  await page.screenshot({ path: join(artifactDir, '浏览器与xcopy双向传输.png'), fullPage: true });
  const records = (await cli(['transfers'])).filter(r => r.peerId === browserPeer.id);
  if (process.env.XCOPY_FORCE_RELAY === '1') {
    expect(records.filter(r => r.status === 'completed').every(r => r.route === 'relay')).toBe(true);
  }
  const report = { origin, target: remote || 'local', device: before.name, architecture: process.env.XCOPY_ARCH || process.arch, forcedRelay: process.env.XCOPY_FORCE_RELAY === '1', checks, records };
  await writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, records: records.map(r => ({ direction: r.incoming ? 'in' : 'out', name: r.metadata.name, status: r.status, size: r.metadata.size, route: r.route })) }, null, 2));
} catch (error) {
  console.error('CLI_STATE', await cli(['transfers']).then(records => records.filter(r => r.peerId === browserPeer?.id)).catch(e => e.message));
  if (page) {
    console.error('ICE_TRACE_JSON', JSON.stringify(await page.evaluate(() => window.__xcopyIceTrace)));
    console.error('ICE_DIAGNOSTICS', await page.evaluate(async () => ({ errors: window.__xcopyIceErrors, trace: window.__xcopyIceTrace, peers: await Promise.all((window.__xcopyPCs || []).map(async pc => ({ state: pc.connectionState, candidates: [...(await pc.getStats()).values()].filter(s => ['candidate-pair', 'local-candidate', 'remote-candidate'].includes(s.type)).map(s => ({ type: s.type, state: s.state, candidateType: s.candidateType, protocol: s.protocol, address: s.address, nominated: s.nominated })) }))) })).catch(e => e.message));
  }
  if (page) { await page.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  if (paired && browserPeer) { await cli(['pair', 'forget', browserPeer.id]).catch(error => console.error('test pair cleanup:', error.message)); }
  if (browser) { await browser.close(); }
  for (const child of children.reverse()) { await stop(child); }
  if (!remote) {
    await writeFile(join(artifactDir, 'daemon.log'), daemonLogs);
    expect(daemonLogs.includes('DATA RACE')).toBe(false);
    expect(daemonExits.every(code => code === 0)).toBe(true);
  }
}
