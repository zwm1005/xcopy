import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT || '8788';
export default defineConfig({
  outputDir: process.env.E2E_OUTPUT || 'test-results/browser',
  testDir: './test/browser', timeout: 90000, expect: { timeout: 15000 },
  fullyParallel: false, workers: 1, reporter: 'list',
  use: { locale: 'zh-CN', baseURL: `http://localhost:${port}`, channel: 'chrome', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node test/browser-server.js', url: `http://localhost:${port}/healthz`, reuseExistingServer: false,
    // Existing product scenarios assert Chinese copy; default-language behavior is tested separately.
    env: { ...process.env, DEFAULT_LOCALE: 'zh-CN', PORT: port, PUBLIC_ORIGIN: `http://localhost:${port}`, DB_PATH: `test-results/browser-${port}-${Date.now()}.sqlite` }
  }
});
