// Local Docker proxy integration. The upstream returns only the normalized test IP.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { clientSource } from '../server/client-source.js';

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'suichuan-proxy-test-'));
const names = [];
// Docker Desktop host forwarding reaches loopback; Linux gateways can use the
// explicit override. This setting is for this disposable test upstream only.
const trusted = (process.env.PROXY_TEST_PEER_CIDRS || '127.0.0.1/32,::1/128').split(',');
const resolve = clientSource({ trustProxy: true, trustedProxyCidrs: trusted });
const upstream = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ source: resolve(req.socket.remoteAddress, req.headers['x-forwarded-for']), forwarded: req.headers['x-forwarded-for'] }));
});
upstream.listen(0, '0.0.0.0');
await once(upstream, 'listening');
const upstreamUrl = `host.docker.internal:${upstream.address().port}`;
async function check(name, image, configName, target, content, command) {
  const container = `suichuan-source-${name}-${process.pid}`;
  names.push(container);
  const config = join(dir, configName);
  await writeFile(config, content);
  await exec('docker', ['run', '-d', '--rm', '--name', container, '--add-host=host.docker.internal:host-gateway',
    '-p', '127.0.0.1::8080', '-v', `${config}:${target}:ro`, image, ...command]);
  const { stdout } = await exec('docker', ['port', container, '8080/tcp']);
  const url = `http://${stdout.trim()}`;
  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await fetch(url, { headers: { 'X-Forwarded-For': '1.1.1.1, 8.8.8.8' } });
      if (response.ok) {
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(response?.ok, `${name} must start`);
  const result = await response.json();
  assert.ok(result.source);
  assert.notEqual(result.source, '1.1.1.1');
  assert.notEqual(result.source, '8.8.8.8');
  assert.equal(result.source, result.forwarded, `${name} must feed the app's trusted proxy parser`);
  assert.ok(!result.forwarded.includes('1.1.1.1'), `${name} must discard untrusted incoming XFF`);
  console.log(`PASS: ${name} rejects spoofed incoming XFF before app source quotas`);
}
try {
  await check('nginx', 'nginx:1.28-alpine', 'nginx.conf', '/etc/nginx/nginx.conf',
    `events {}\nhttp { server { listen 8080; location / { proxy_pass http://${upstreamUrl}; proxy_set_header X-Forwarded-For $remote_addr; } } }\n`, []);
  await check('caddy', 'caddy:2-alpine', 'Caddyfile', '/etc/caddy/Caddyfile',
    `:8080 {\n reverse_proxy ${upstreamUrl}\n}\n`, ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
} finally {
  await Promise.all(names.map((name) => exec('docker', ['rm', '-f', name]).catch(() => {})));
  await new Promise((resolve) => upstream.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
