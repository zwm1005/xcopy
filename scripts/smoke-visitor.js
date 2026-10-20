// Existing product smoke flows use a returning Chinese-language visitor.
// smoke-deployed.js and guide.spec.js exercise first-visit onboarding itself.
export async function returningVisitor(context) {
  await context.addInitScript(() => {
    localStorage.setItem('suichuan-locale', 'zh-CN');
    localStorage.setItem('suichuan-guide-seen', '1');
  });
}
