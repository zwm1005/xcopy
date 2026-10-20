import { test as base, expect } from '@playwright/test';

// Existing product flows use returning visitors. guide.spec.js uses fresh
// browser contexts directly to exercise the actual first-visit experience.
export const test = base.extend({
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      await context.addInitScript(() => {
        for (const kind of ['localStorage', 'sessionStorage']) {
          try {
            window[kind].setItem('suichuan-guide-seen', '1');
          } catch { /* Storage-restriction scenarios still cover their fallback. */ }
        }
      });
      return context;
    };
    try {
      await use(browser);
    } finally {
      browser.newContext = newContext;
    }
  }, { scope: 'worker' }]
});
export { expect };
