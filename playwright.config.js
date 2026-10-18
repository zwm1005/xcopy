import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT || '8788';
export default defineConfig({
  testDir: './test/browser', timeout: 90000, expect: { timeout: 15000 },
  fullyParallel: false, workers: 1, reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, channel: 'chrome', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node test/browser-server.js', url: `http://localhost:${port}/healthz`, reuseExistingServer: false,
    env: { ...process.env, PORT: port, PUBLIC_ORIGIN: `http://localhost:${port}`, DB_PATH: `test-results/browser-${port}-${Date.now()}.sqlite` }
  }
});
