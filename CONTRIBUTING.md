# 前端与语言包贡献

前端源代码在 `src/`，静态 HTML/CSS 在 `public/`。新增业务模块须加入 `server/assets.js` 精确白名单，保持浏览器模块 URL 稳定。提交源码和 lockfile，不提交 dist。所有 if 使用多行花括号。

中英文词典为 `src/i18n/zh-CN.ts` 和 `en.ts`。使用语义键及 `{参数}` 插值，调用 `t()` 时由 TypeScript 检查键和参数。HTML 使用 `data-i18n` 或 `data-i18n-aria-label` 等允许的属性标识。通过 textContent 输出，禁止将翻译注入 innerHTML。用户设备名、文件名、传输文字不翻译。

新增语言需增加词典，在 `src/i18n/index.ts` 注册语言和规范化规则、HTML 选择器增加选项，扩展配置校验和 `supportedLocales`，再将字典加入检查器。RTL 语言需要额外布局适配。动态内容应在 `onLocaleChange` 中按原状态重绘；不要重建 Connection、Transfers 或设备身份。错误协议用可选 `messageKey/messageParams`、`reasonKey/reasonParams`，继续保留旧中文字段兼容旧客户端；新增服务端消息同步维护 `server/message-keys.js` 和前端字典。

运行 `npm run check`、`npm test`、`npm run test:e2e`。翻译变更也应检查窄屏、键盘操作、属性文案、输入焦点和切换时仍在进行的传输。国际化回归在 `test/browser/i18n.spec.js`。类型契约反例在 `test/types/contracts.ts`，必须保持预期编译错误。
