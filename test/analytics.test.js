import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { loadConfig } from '../server/config.js';

test('statistics are disabled by default with no script, cookie or privacy route', async () => {
  assert.equal(loadConfig({}).analyticsEnabled, false);
  const app = createApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', analyticsEnabled: false });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const path of ['/', '/transfer', '/s']) {
      const response = await fetch(origin + path);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.doesNotMatch(await response.text(), /data-analytics-base|analytics-privacy-link/);
    }
    for (const path of ['/analytics.js', '/analytics-privacy']) {
      assert.equal((await fetch(origin + path)).status, 404);
    }
  } finally {
    await app.close();
  }
});

test('explicit opt-in injects only same-origin configuration and bilingual disclosure', async () => {
  const app = createApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', analyticsEnabled: true, analyticsPath: '/api/analytics' });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const path of ['/', '/transfer', '/s']) {
      const html = await (await fetch(origin + path)).text();
      assert.match(html, /src="\/analytics.js\?v=[a-f0-9]{64}" data-analytics-base="\/api\/analytics"/);
      assert.match(html, /href="\/analytics-privacy"/);
      assert.doesNotMatch(html, /X-Analytics-Proxy-Key|HMAC_KEY/);
    }
    assert.equal((await fetch(origin + '/analytics.js')).status, 200);
    const privacy = await (await fetch(origin + '/analytics-privacy?lang=zh-CN')).text();
    assert.match(privacy, /30 天/);
    assert.match(privacy, /analytics=off/);
    assert.match(privacy, /noindex/);
    assert.throws(() => loadConfig({ ANALYTICS_PATH: 'https://third-party.example/collect' }));
    assert.throws(() => loadConfig({ ANALYTICS_PATH: '//third-party.example' }));
  } finally {
    await app.close();
  }
});
