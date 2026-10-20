import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const authMode = process.env.TEST_TURN_AUTH_MODE || 'shared-secret';
const transport = process.env.TEST_TURN_TRANSPORT || 'both';
if (!['shared-secret', 'static'].includes(authMode) || !['both', 'udp', 'tcp'].includes(transport)) {
  throw new Error('Invalid local TURN test mode or transport');
}
const dir = await mkdtemp(join(tmpdir(), 'suichuan-turn-'));
const secret = randomBytes(32).toString('hex');
const port = process.env.TEST_TURN_PORT || '34799';
const config = join(dir, 'turn.conf');
const limits = await readFile(new URL('../deploy/turn-limits.conf', import.meta.url), 'utf8');
await writeFile(config, [
  `listening-port=${port}`, 'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1',
  limits, 'realm=suichuan-test',
  ...(authMode === 'static' ? ['lt-cred-mech', `user=local-test:${secret}`] : ['use-auth-secret', `static-auth-secret=${secret}`]), 'allow-loopback-peers',
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
  const child = spawn(process.execPath, process.env.TEST_TURN_CLI === '1' ? ['scripts/smoke-cli.js'] : ['node_modules/@playwright/test/cli.js', 'test', '--output', `test-results/relay-${authMode}-${transport}`, '--grep', process.env.TEST_TURN_GREP || 'forced TURN'], {
    stdio: 'inherit', env: { ...process.env, E2E_PORT: process.env.E2E_PORT || '8789', DEFAULT_LOCALE: 'zh-CN', XCOPY_FORCE_RELAY: '1', FORCE_RELAY: '1', TURN_URLS: (transport === 'both' ? ['udp', 'tcp'] : [transport]).map(value => `turn:127.0.0.1:${port}?transport=${value}`).join(','), TURN_AUTH_MODE: authMode, TURN_SECRET: authMode === 'shared-secret' ? secret : '', TURN_USERNAME: authMode === 'static' ? 'local-test' : '', TURN_PASSWORD: authMode === 'static' ? secret : '' }
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  turn.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
