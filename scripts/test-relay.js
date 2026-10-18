import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'suichuan-turn-'));
const secret = randomBytes(32).toString('hex');
const port = process.env.TEST_TURN_PORT || '34799';
const config = join(dir, 'turn.conf');
const limits = await readFile(new URL('../deploy/turn-limits.conf', import.meta.url), 'utf8');
await writeFile(config, [
  `listening-port=${port}`, 'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1',
  limits, 'realm=suichuan-test',
  'use-auth-secret', `static-auth-secret=${secret}`, 'allow-loopback-peers',
  'no-multicast-peers', 'no-cli', 'no-tls', 'no-dtls',
  `pidfile=${join(dir, 'turn.pid')}`, 'log-file=stdout', 'simple-log', 'no-stdout-log'
].join('\n'), { mode: 0o600 });
const turn = spawn(process.env.TURNSERVER_BIN || 'turnserver', ['-c', config], { stdio: 'ignore' });
let turnError;
turn.on('error', (error) => { turnError = error; });
try {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (turnError || turn.exitCode !== null) {
    throw new Error('本机 TURN 启动失败，请安装 coturn，或用 TURNSERVER_BIN 指定 turnserver');
  }
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--grep', 'forced TURN'], {
    stdio: 'inherit', env: { ...process.env, E2E_PORT: '8789', FORCE_RELAY: '1', TURN_URLS: `turn:127.0.0.1:${port}?transport=udp,turn:127.0.0.1:${port}?transport=tcp`, TURN_SECRET: secret }
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  turn.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
