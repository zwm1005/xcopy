import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, iceUrls } from '../server/config.js';
import { createApp } from '../server/index.js';
import { messageDescriptor } from '../server/messages.js';
import { chooseLocale, setLocale, t } from '../dist/public/i18n/index.js';
import { messageText } from '../dist/public/i18n/errors.js';
import { parseReply, isServerEvent } from '../dist/public/protocol-runtime.js';
import { assertFrontend } from '../scripts/frontend-artifact.js';

test('ICE URI syntax, auth modes and configuration combinations fail closed without credential disclosure', () => {
  assert.deepEqual(loadConfig({}).stunUrls, []);
  assert.deepEqual(iceUrls(' stun:example.com:3478,stun:[::1]:3478,stun:example.com:3478 ', 'STUN_URLS', ['stun']), ['stun:example.com:3478', 'stun:[::1]:3478']);
  for (const url of ['stun:', 'stuns:example.com', 'stun:host:0', 'stun:host:65536', 'stun:user:pass@host', 'stun:host/path', 'stun:host?transport=udp', 'stun:[bad]:33', 'stun:999.2.3.4', 'stun:-bad.com']) {
    assert.throws(() => loadConfig({ STUN_URLS: url }), /STUN_URLS/);
  }
  const secret = 'private-value-'.repeat(4);
  for (const config of [{ FORCE_RELAY: '1' }, { TURN_URLS: 'turn:host' }, { TURN_URLS: 'turn:host', TURN_AUTH_MODE: 'static' }, { TURN_AUTH_MODE: 'wrong' }, { TURN_AUTH_MODE: 'static', TURN_SECRET: secret }, { TURN_USERNAME: 'user' }, { TURN_CREDENTIAL_TTL_SECONDS: '3599' }, { TURN_CREDENTIAL_TTL_SECONDS: '86401' }, { INDEXNOW_KEY: 'short' }, { DEFAULT_LOCALE: 'xx' }, { CLI_DOWNLOAD_URL: 'javascript:alert(1)' }]) {
    assert.throws(() => loadConfig(config), error => !error.message.includes(secret));
  }
  const config = loadConfig({ TURN_URLS: 'turn:relay.example.com:3478?transport=tcp,turns:[::1]:5349?transport=tcp', TURN_AUTH_MODE: 'static', TURN_USERNAME: 'test-user', TURN_PASSWORD: secret, FORCE_RELAY: '1', DEFAULT_LOCALE: 'en' });
  assert.equal(config.turnUsername, 'test-user');
  assert.equal(config.forceRelay, true);
  assert.equal(config.defaultLocale, 'en');
});

test('locale selection, interpolation and historical errors retain compatibility', () => {
  assert.equal(loadConfig({}).defaultLocale, 'en');
  assert.equal(loadConfig({ DEFAULT_LOCALE: 'zh-CN' }).defaultLocale, 'zh-CN');
  assert.equal(chooseLocale('en', 'zh-CN', 'zh-CN'), 'en');
  assert.equal(chooseLocale('zh-CN', 'en', 'en'), 'zh-CN');
  assert.equal(chooseLocale(null, 'en', 'zh-CN'), 'en');
  assert.equal(chooseLocale(null, 'zh-CN', 'en'), 'zh-CN');
  assert.equal(chooseLocale(null, null, 'zh-CN'), 'zh-CN');
  assert.equal(chooseLocale(null, null, 'en'), 'en');
  assert.equal(chooseLocale('invalid', 'invalid', 'invalid'), 'en');
  setLocale('en');
  assert.equal(t('app.remove', { p0: '<文件.txt>' }), 'Remove <文件.txt>');
  const reason = '无法建立 P2P 直连，服务器中转单个文件不能超过 75 MB；请更换网络后重试';
  const descriptor = messageDescriptor(reason, 'reason');
  assert.match(messageText(reason, descriptor.reasonKey, descriptor.reasonParams), /75 MB/);
  assert.equal(messageText('文件信息无效'), 'Invalid file metadata');
  assert.equal(messageText('untrusted internal exception'), 'Unable to complete the operation. Please try again.');
  setLocale('zh-CN');
  assert.equal(messageText('Invalid file metadata'), '文件信息无效');
});

test('network boundaries reject malformed known replies and events', () => {
  assert.throws(() => parseReply('pair.code', { code: 123, expires: 'tomorrow' }));
  assert.throws(() => parseReply('share.inspect', { id: 'a', files: [{}] }));
  assert.throws(() => parseReply('transfer.start', { id: 'a', iceServers: [{ urls: 123 }] }));
  assert.equal(isServerEvent('signal', { id: 'a', signal: { description: { type: 'bogus', sdp: '' } } }), false);
  assert.equal(isServerEvent('unknown', {}), false);
  assert.deepEqual(parseReply('pair.code', { code: '00000000', expires: 100 }), { code: '00000000', expires: 100 });
});

test('fresh build, exact public routes, discovery HEAD, runtime defaults and private files', async () => {
  await assertFrontend({ fresh: true });
  const dir = await mkdtemp(join(tmpdir(), 'suichuan-config-'));
  const before = await readFile(new URL('../dist/public/app.js', import.meta.url));
  try {
    for (const key of ['', 'test-indexnow-1234', '']) {
      const app = createApp({ host: '127.0.0.1', port: 0, dbPath: join(dir, 'data.sqlite'), origin: 'https://files.example.com', indexnowKey: key, defaultLocale: 'en', turnSecret: 'do-not-expose', turnPassword: 'private-password' });
      await app.listen();
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      try {
        const config = await (await fetch(origin + '/api/client-config')).json();
        assert.deepEqual(config, { defaultLocale: 'en', supportedLocales: ['zh-CN', 'en'], cliDownloadUrl: null });
        for (const [path, status, mime] of [['/robots.txt', 200, 'text/plain'], ['/sitemap.xml', 200, 'application/xml'], ['/indexnow.txt', key ? 200 : 404, 'text/plain']]) {
          const response = await fetch(origin + path);
          assert.equal(response.status, status);
          assert.ok(response.headers.get('content-type').startsWith(mime));
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const body = await response.text();
          if (path !== '/indexnow.txt') {
            assert.match(body, /https:\/\/files.example.com/);
          }
          const head = await fetch(origin + path, { method: 'HEAD' });
          assert.equal(head.status, status);
          assert.equal(await head.text(), '');
        }
        const homepage = await (await fetch(origin + '/')).text();
        assert.match(homepage, /rel="canonical" href="https:\/\/files.example.com\/"/);
        assert.ok(!homepage.includes('xcopy.werfamily'));
        for (const path of ['/.env', '/src/app.ts', '/app.ts', '/app.js.map', '/build-manifest.json', '/server/config.js', '/data/suichuan.sqlite', '/other.txt', '/other.xml']) {
          assert.equal((await fetch(origin + path)).status, 404, path);
        }
        for (const path of Object.keys(JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url), 'utf8')).files)) {
          assert.equal((await fetch(origin + path)).status, 200, path);
        }
      } finally {
        await app.close();
      }
    }
    assert.deepEqual(await readFile(new URL('../dist/public/app.js', import.meta.url)), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
