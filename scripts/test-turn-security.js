// Local-only protocol checks against a real coturn. No production endpoints.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const duration = Number(process.env.TURN_SECURITY_DURATION_SECONDS || 8);
assert.ok(Number.isInteger(duration) && duration >= 8 && duration <= 1800);
const capacityOnly = process.env.TURN_SECURITY_CAPACITY_ONLY === '1';
const port = Number(process.env.TURN_SECURITY_PORT || 34897);
const dir = await mkdtemp(join(tmpdir(), 'suichuan-turn-security-'));
const secret = randomBytes(32).toString('hex');
const configPath = join(dir, 'turn.conf');
const limits = await readFile(new URL('../deploy/turn-limits.conf', import.meta.url), 'utf8');
await writeFile(configPath, [
  capacityOnly ? limits.replace(/^bps-capacity=\d+$/m, 'bps-capacity=81920') : limits,
  `listening-port=${port}`, 'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1',
  'realm=local-security-test', 'use-auth-secret', `static-auth-secret=${secret}`,
  'allow-loopback-peers', 'no-multicast-peers', 'no-cli', 'no-tls', 'no-dtls',
  `pidfile=${join(dir, 'turn.pid')}`, `log-file=${join(dir, 'turn.log')}`, 'no-stdout-log'
].join('\n'), { mode: 0o600 });
const server = spawn(process.env.TURNSERVER_BIN || 'turnserver', ['-c', configPath], { stdio: 'ignore' });
const children = new Set();
function credential(ttl) {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:local-test`;
  return [username, createHmac('sha1', secret).update(username).digest('base64')];
}
function attribute(type, value) {
  const buffer = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  buffer.writeUInt16BE(type);
  buffer.writeUInt16BE(value.length, 2);
  value.copy(buffer, 4);
  return buffer;
}
async function allocateError(ttl, transport) {
  // RFC6062 allocations must be requested over a reliable client transport.
  // Requesting TCP relay over UDP would be rejected even without no-tcp-relay.
  const tcp = transport === 6;
  const socket = tcp ? createConnection({ host: '127.0.0.1', port }) : createSocket('udp4');
  if (tcp) {
    await once(socket, 'connect');
  }
  const [username, password] = credential(ttl);
  async function request(attributes, key) {
    const header = Buffer.alloc(20);
    header.writeUInt16BE(3);
    header.writeUInt16BE(attributes.length + (key ? 24 : 0), 2);
    header.writeUInt32BE(0x2112a442, 4);
    randomBytes(12).copy(header, 8);
    let packet = Buffer.concat([header, attributes]);
    if (key) {
      packet = Buffer.concat([packet, attribute(8, createHmac('sha1', key).update(packet).digest())]);
    }
    return new Promise((resolve, reject) => {
      const event = tcp ? 'data' : 'message';
      const timer = setTimeout(() => { socket.off(event, received); reject(new Error('TURN response timeout')); }, 3000);
      let buffered = Buffer.alloc(0);
      function received(chunk) {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 20 || buffered.length < 20 + buffered.readUInt16BE(2)) {
          return;
        }
        const data = buffered.subarray(0, 20 + buffered.readUInt16BE(2));
        if (!data.subarray(8, 20).equals(header.subarray(8))) {
          return;
        }
        clearTimeout(timer);
        socket.off(event, received);
        const attributes = new Map();
        for (let offset = 20; offset < data.length;) {
          const size = data.readUInt16BE(offset + 2);
          attributes.set(data.readUInt16BE(offset), data.subarray(offset + 4, offset + 4 + size));
          offset += 4 + Math.ceil(size / 4) * 4;
        }
        resolve(attributes);
      }
      socket.on(event, received);
      if (tcp) {
        socket.write(packet);
      } else {
        socket.send(packet, port, '127.0.0.1');
      }
    });
  }
  try {
    const requested = attribute(0x19, Buffer.from([transport, 0, 0, 0]));
    const challenge = await request(requested);
    const realm = challenge.get(0x14);
    const nonce = challenge.get(0x15);
    assert.ok(realm && nonce, 'authentication challenge required');
    const key = createHash('md5').update(`${username}:${realm}:${password}`).digest();
    const result = await request(Buffer.concat([requested, attribute(6, Buffer.from(username)), attribute(0x14, realm), attribute(0x15, nonce)]), key);
    const error = result.get(9);
    return error ? error[2] * 100 + error[3] : 0;
  } finally {
    if (tcp) {
      socket.destroy();
    } else {
      socket.close();
    }
  }
}
function run(args, ttl, timeout = 15000) {
  const [username, password] = credential(ttl);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.TURNCLIENT_BIN || 'turnutils_uclient', [
      '-p', String(port), '-u', username, '-w', password, ...args, '127.0.0.1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
try {
  await delay(1000);
  assert.equal(server.exitCode, null, 'coturn must start');
  if (capacityOnly) {
    assert.equal(await allocateError(900, 17), 0, 'first allocation must fit the bandwidth budget');
    const rejected = await allocateError(900, 17);
    assert.ok([486, 508].includes(rejected), `second allocation must exceed the bandwidth budget, got ${rejected}`);
    console.log(`PASS: bps-capacity refuses an allocation beyond the reserved budget (${rejected})`);
  } else {
    assert.equal(await allocateError(900, 6), 442, 'RFC6062 must be refused');
    assert.equal(await allocateError(-60, 17), 401, 'expired credentials must be refused');
    console.log('PASS: TCP relay refused and expired credentials cannot allocate');
    const ttl = duration >= 920 ? 900 : 3;
    const results = await Promise.all([[], ['-t']].map((transport) =>
      run([...transport, '-v', '-y', '-c', '-m', '1', '-n', String(duration), '-z', '1000', '-l', '1000'], ttl, (duration + 25) * 1000)));
    for (let i = 0; i < results.length; i += 1) {
      assert.equal(results[i].code, 0, results[i].output.slice(-1500));
      assert.match(results[i].output, /Total lost packets 0/, results[i].output.slice(-1500));
      console.log(`PASS: ${i ? 'TCP' : 'UDP'} client carried data for ${duration}s across ${ttl}s credential expiry`);
    }
    const saturated = await run(['-v', '-y', '-c', '-m', '1', '-n', '2000', '-z', '1', '-l', '1000'], 900, 30000);
    assert.equal(saturated.code, 0, saturated.output.slice(-1500));
    const lost = /Total lost packets (\d+)/.exec(saturated.output);
    assert.ok(lost && Number(lost[1]) > 0, 'traffic above max-bps must be dropped');
    console.log(`PASS: local traffic above max-bps was limited (${lost[1]} packets dropped)`);
  }
} finally {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  server.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
