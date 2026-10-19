import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { escapeHtml, translateHtml } from '../server/page-html.js';

test('crawlers receive complete bilingual HTML, canonical URLs and reciprocal sitemap alternates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suichuan-seo-'));
  const publicOrigin = 'https://files.example.com';
  try {
    for (const defaultLocale of ['en', 'zh-CN']) {
      const app = createApp({ host: '127.0.0.1', port: 0, dbPath: join(dir, `${defaultLocale}.sqlite`), origin: publicOrigin, defaultLocale });
      await app.listen();
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      try {
        const canonical = (locale) => `${publicOrigin}/${locale === defaultLocale ? '' : `?lang=${locale}`}`;
        for (const userAgent of ['Googlebot', 'Baiduspider', 'bingbot']) {
          for (const locale of ['en', 'zh-CN']) {
            const response = await fetch(`${origin}/?lang=${locale}`, { headers: { 'User-Agent': userAgent } });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-language'), locale);
            assert.equal(response.headers.get('x-robots-tag'), null);
            const html = await response.text();
            assert.ok(html.includes(`<html lang="${locale}">`));
            assert.ok(html.includes(`<link rel="canonical" href="${canonical(locale)}">`));
            assert.ok(html.includes(`<option value="${locale}" selected>`));
            assert.match(html, /<meta name="robots" content="index, follow/);
            for (const alternate of ['en', 'zh-CN']) {
              assert.ok(html.includes(`<link rel="alternate" hreflang="${alternate}" href="${canonical(alternate)}">`));
              assert.ok(html.includes(`href="/?lang=${alternate}" lang="${alternate}" hreflang="${alternate}"`));
            }
            if (locale === 'zh-CN') {
              assert.match(html, /<title[^>]*>随传 XCopy - 免费开源/);
              assert.match(html, /<meta name="description" content="随传 XCopy/);
              assert.match(html, /<span data-i18n="home.hero.title.devices">多端互传<\/span>/);
              assert.match(html, /<summary><span[^>]*>第一次使用，怎么传？/);
              assert.match(html, /aria-label="首页导航"/);
              assert.match(html, /<meta property="og:locale" content="zh_CN">/);
            } else {
              assert.match(html, /<title[^>]*>XCopy - Free, Open-Source File Transfer/);
              assert.match(html, /<span data-i18n="home.hero.title.devices">Cross-device transfers\.<\/span>/);
              assert.match(html, /<meta property="og:locale" content="en_US">/);
            }
            const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
            assert.equal(schema['@graph'][0]['@type'], 'WebSite');
            assert.equal(schema['@graph'][1]['@type'], 'WebApplication');
            assert.equal(schema['@graph'][1].url, canonical(locale));
            assert.ok(!html.includes('xcopy.werfamily.fun'));
          }
        }
        const sitemapResponse = await fetch(origin + '/sitemap.xml');
        assert.equal(sitemapResponse.status, 200);
        assert.match(sitemapResponse.headers.get('content-type'), /application\/xml/);
        const sitemap = await sitemapResponse.text();
        const entries = [...sitemap.matchAll(/<url>(.*?)<\/url>/g)].map(match => match[1]);
        assert.equal(entries.length, 2);
        for (const locale of ['en', 'zh-CN']) {
          assert.ok(sitemap.includes(`<loc>${canonical(locale)}</loc>`));
          for (const entry of entries) {
            assert.ok(entry.includes(`hreflang="${locale}" href="${canonical(locale)}"`));
            assert.ok(entry.includes(`hreflang="x-default" href="${publicOrigin}/"`));
          }
        }
        assert.ok(!sitemap.includes('/transfer') && !sitemap.includes('/s?'));
        const robots = await (await fetch(origin + '/robots.txt')).text();
        const blocked = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map(match => match[1]);
        for (const path of ['/', '/?lang=zh-CN', '/sitemap.xml', '/home.css', '/home.js', '/styles.css', '/i18n/index.js', '/indexnow.txt', '/transfer', '/s']) {
          assert.ok(!blocked.some(prefix => path.startsWith(prefix)), `${path} must be crawlable`);
        }
        assert.match(robots, /Disallow: \/api\//);
        for (const path of ['/transfer', '/transfer.html', '/s', '/s/', '/share.html']) {
          const response = await fetch(origin + path);
          assert.equal(response.status, 200);
          assert.match(response.headers.get('x-robots-tag'), /noindex/);
          assert.match(await response.text(), /<meta name="robots" content="noindex,/);
        }
        const root = await (await fetch(origin + '/')).text();
        assert.ok(root.includes(`<html lang="${defaultLocale}">`));
        const invalid = await (await fetch(origin + '/?lang=%3Cscript%3E&tracking=ignored')).text();
        assert.ok(invalid.includes(`<link rel="canonical" href="${publicOrigin}/">`));
        for (const path of ['/?lang=zh-CN', '/sitemap.xml', '/robots.txt', '/transfer']) {
          const head = await fetch(origin + path, { method: 'HEAD' });
          assert.equal(head.status, 200);
          assert.equal(await head.text(), '');
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('static translations escape text and attributes and reject missing dictionary keys', () => {
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
  const html = translateHtml('<p data-i18n="page.this.device.s.name">Original</p><input aria-label="Original" data-i18n-aria-label="page.this.device.s.name">', 'en');
  assert.ok(html.includes('This device&#39;s name'));
  assert.match(html, /aria-label="This device&#39;s name"/);
  assert.throws(() => translateHtml('<p data-i18n="missing.key">Original</p>', 'en'), /Unknown page translation/);
});
