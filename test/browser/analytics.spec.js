import { test, expect } from './fixtures.js';
import { createApp } from '../../server/index.js';

let app;
let enabledOrigin;
const serverEvents = [];
test.beforeAll(async () => {
  app = createApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', analyticsEnabled: true, analyticsPath: '/api/analytics' });
  const serveApplication = app.server.listeners('request')[0];
  app.server.removeAllListeners('request');
  app.server.on('request', async (request, response) => {
    if (request.url === '/api/analytics/bootstrap') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"enabled":true}');
      return;
    }
    if (request.url === '/api/analytics/events') {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      serverEvents.push(...JSON.parse(Buffer.concat(chunks).toString()).events);
      response.writeHead(204).end();
      return;
    }
    serveApplication(request, response);
  });
  await app.listen();
  enabledOrigin = `http://127.0.0.1:${app.server.address().port}`;
  app.config.origin = enabledOrigin;
});
test.afterAll(async () => { await app.close(); });

async function collector(page, options = {}) {
  const events = [];
  const attempts = [];
  await page.route('**/api/analytics/bootstrap', async route => {
    if (options.bootstrapFailure) {
      await route.abort();
    } else {
      await route.fulfill({ json: { enabled: true } });
    }
  });
  await page.route('**/api/analytics/events', async route => {
    const batch = route.request().postDataJSON().events;
    attempts.push(...batch);
    if (options.retry && attempts.length === 1) {
      await route.abort();
      return;
    }
    events.push(...batch);
    await route.fulfill({ status: 204 });
  });
  return { events, attempts };
}

test('default deployment makes zero analytics requests and creates no analytics cookies', async ({ page, context }) => {
  const requests = [];
  page.on('request', r => {
    if (r.url().includes('/analytics')) {
      requests.push(r.url());
    }
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(250);
  expect(requests).toEqual([]);
  expect((await context.cookies()).filter(c => /analytics/.test(c.name))).toEqual([]);
});

test('share page whitelists metadata and never sends secret hash, unrelated query or referrer path', async ({ page }) => {
  const { events } = await collector(page);
  await page.goto(`${enabledOrigin}/s?lang=zh-CN&private=secret-query&utm_source=test#secret-share-token`, { referer: 'https://search.example.test/private-path?password=secret' });
  await expect.poll(() => events.length).toBe(1);
  expect(events[0]).toMatchObject({ eventName: 'page_view', pageKey: 'share', locale: 'zh-CN', referrerHost: 'search.example.test', utmSource: 'test' });
  expect(Object.keys(events[0]).sort()).toEqual(['eventId', 'eventName', 'locale', 'pageKey', 'referrerHost', 'utmSource']);
  expect(JSON.stringify(events)).not.toContain('secret');
  expect(JSON.stringify(events)).not.toContain('private-path');
});

test('opt out persists across pages and can be explicitly reversed', async ({ page }) => {
  const { events } = await collector(page);
  let bootstrap = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/analytics/bootstrap')) {
      bootstrap++;
    }
  });
  await page.goto(`${enabledOrigin}/?analytics=off`);
  expect(page.url()).not.toContain('analytics=');
  await page.goto(`${enabledOrigin}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await page.waitForTimeout(250);
  expect(events).toEqual([]);
  expect(bootstrap).toBe(0);
  await page.goto(`${enabledOrigin}/?analytics=on`);
  await expect.poll(() => events.length).toBe(1);
  expect(bootstrap).toBe(1);
});

test('network retry reuses event ID, background switching adds no PV, BFCache restoration does', async ({ page }) => {
  const { events, attempts } = await collector(page, { retry: true });
  await page.goto(`${enabledOrigin}/`);
  await expect.poll(() => events.length).toBe(1);
  expect(attempts.length).toBe(2);
  expect(attempts[0].eventId).toBe(attempts[1].eventId);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  expect(events.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => events.length).toBe(2);
});

test('bootstrap failure keeps transfer usable and tab events count only actual switches', async ({ page }) => {
  const { events } = await collector(page, { bootstrapFailure: true });
  await page.goto(`${enabledOrigin}/transfer`);
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await expect.poll(() => events.length).toBe(1);
  await page.locator('[data-mode="share"]').click();
  await page.locator('[data-mode="share"]').click();
  await page.locator('[data-mode="device"]').click();
  await expect.poll(() => events.length).toBe(3);
  expect(events.map(e => e.eventName)).toEqual(['page_view', 'tab_share', 'tab_device']);
});

test('navigation flushes the home transfer click before unloading', async ({ page }) => {
  // Use real HTTP: an unloaded document can lose Playwright's page-scoped route interception.
  serverEvents.length = 0;
  await page.goto(`${enabledOrigin}/`);
  await expect.poll(() => serverEvents.length).toBe(1);
  await page.locator('.hero-actions a[href="/transfer"]').click();
  await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection', 'ready');
  await expect.poll(() => serverEvents.filter(event => event.eventName === 'home_transfer_click').length).toBe(1);
  await expect.poll(() => serverEvents.filter(event => event.eventName === 'page_view').length).toBe(2);
});
