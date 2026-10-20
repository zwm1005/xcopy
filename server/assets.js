// Explicit public URLs; never derive permissions from an arbitrary request path.
export const assets = new Set([
  '/index.html', '/transfer.html', '/share.html', '/home.css', '/styles.css', '/share.css', '/i18n.css',
  '/icon.svg', '/qrcode.js', '/QRCODE-LICENSE.txt',
  ...['app', 'home', 'identity', 'device-name', 'archive', 'connection', 'transfer', 'share', 'share-ui', 'dom', 'protocol-runtime'].map((name) => `/${name}.js`),
  '/shared/device-name.js', '/shared/transfer-limits.js',
  ...['index', 'messages', 'format', 'zh-CN', 'en', 'errors'].map((name) => `/i18n/${name}.js`),
  ...['_md', '_u64', 'sha2', 'utils'].map((name) => `/vendor/noble-hashes/${name}.js`),
  '/vendor/noble-hashes/LICENSE', '/vendor/noble-hashes/README.md',
]);
