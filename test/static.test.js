import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { staticFiles, representation } from '../server/static.js';

function get(origin, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function server(t) {
  const app = createApp({ port: 0, host: '127.0.0.1', dbPath: ':memory:' });
  const address = await app.listen();
  t.after(() => app.close());
  return `http://127.0.0.1:${address.port}`;
}

test('static responses negotiate compression, validate ETags and preserve HEAD semantics', async t => {
  const origin = await server(t);
  const plain = await get(origin, '/app.js');
  assert.equal(plain.headers['cache-control'], 'public, no-cache');
  assert.equal(plain.headers['content-encoding'], undefined);
  for (const [encoding, decode] of [['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
    const headers = { 'accept-encoding': encoding };
    const compressed = await get(origin, '/app.js', headers);
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], encoding);
    assert.deepEqual(decode(compressed.body), plain.body);
    assert.ok(compressed.body.length < plain.body.length / 2);
    assert.match(compressed.headers.vary, /Accept-Encoding/);
    assert.notEqual(compressed.headers.etag, plain.headers.etag);
    const head = await get(origin, '/app.js', headers, 'HEAD');
    assert.equal(head.headers['content-length'], String(compressed.body.length));
    assert.equal(head.body.length, 0);
    const cached = await get(origin, '/app.js', { ...headers, 'if-none-match': `"other", W/${compressed.headers.etag}` });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal((await get(origin, '/app.js', { ...headers, 'if-none-match': plain.headers.etag })).status, 200);
  }
  assert.equal((await get(origin, '/app.js', { 'accept-encoding': 'br;q=0, gzip;q=0' })).headers['content-encoding'], undefined);
  assert.equal((await get(origin, '/app.js', { 'accept-encoding': '*;q=0' })).status, 406);
});

test('HTML versions public assets while HTML, config and invalid versions never become immutable', async t => {
  const origin = await server(t);
  const page = await get(origin, '/transfer?lang=zh-CN', { 'accept-encoding': 'gzip' });
  const html = gunzipSync(page.body).toString();
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers.vary, /Accept-Language/);
  assert.match(page.headers.vary, /Accept-Encoding/);
  assert.equal(page.headers['content-language'], 'zh-CN');
  const path = html.match(/src="(\/app\.js\?v=[a-f0-9]{64})"/)[1];
  const asset = await get(origin, path);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(new URL(path, origin).searchParams.get('v'), createHash('sha256').update(asset.body).digest('hex'));
  assert.equal((await get(origin, '/app.js?v=old-release')).headers['cache-control'], 'public, no-cache');
  assert.equal((await get(origin, '/api/client-config')).headers['cache-control'], 'no-store');
  assert.equal((await get(origin, '/transfer', { 'if-none-match': '*' })).status, 200);
  assert.match(html, /href="\/icon.svg\?v=[a-f0-9]{64}#mark"/);
  assert.equal((await get(origin, '/.env?v=anything')).status, 404);
});

test('one release reuses loaded files; a new release produces new validators', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'suichuan-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'app.js');
  await writeFile(path, 'old release');
  const first = staticFiles(directory);
  const before = await first.load('/app.js');
  await writeFile(path, 'new release');
  assert.strictEqual(await first.load('/app.js'), before);
  const after = await staticFiles(directory).load('/app.js');
  assert.notEqual((await representation(before)).digest, (await representation(after)).digest);
});
