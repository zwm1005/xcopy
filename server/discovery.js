import { escapeHtml, localizedUrl, pageLocale, translateHtml } from './page-html.js';

const xml = (text) => text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const locales = ['en', 'zh-CN'];

export function indexableUrls(config) {
  return locales.map((locale) => localizedUrl(config, locale));
}

export function discovery(path, req, res, config) {
  let body;
  let type = 'text/plain; charset=utf-8';
  if (path === '/robots.txt') {
    // Public pages must be crawlable for their noindex tags to be seen. A /s
    // prefix also blocks sitemap.xml and styles.css, so only exclude API routes.
    body = `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ws\nDisallow: /healthz\nSitemap: ${config.origin}/sitemap.xml\n`;
  } else if (path === '/sitemap.xml') {
    type = 'application/xml; charset=utf-8';
    const alternates = locales.map((locale) => `<xhtml:link rel="alternate" hreflang="${locale}" href="${xml(localizedUrl(config, locale))}"/>`).join('') + `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(config.origin)}/"/>`;
    const urls = indexableUrls(config).map((url) => `<url><loc>${xml(url)}</loc>${alternates}</url>`).join('');
    body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>\n`;
  } else if (path === '/indexnow.txt') {
    if (!config.indexnowKey) {
      res.writeHead(404, { 'Content-Type': type }).end(req.method === 'HEAD' ? undefined : 'Not found');
      return true;
    }
    body = config.indexnowKey;
  } else {
    return false;
  }
  res.writeHead(200, { 'Content-Type': type }).end(req.method === 'HEAD' ? undefined : body);
  return true;
}

export function pageMetadata(content, file, config, requestUrl = '/') {
  if (!['/index.html', '/transfer.html'].includes(file)) {
    return content;
  }
  const locale = pageLocale(requestUrl, config);
  const url = localizedUrl(config, locale, file === '/index.html' ? '/' : '/transfer');
  const canonical = `<link rel="canonical" href="${xml(url)}">`;
  let home = '';
  if (file === '/index.html') {
    const alternates = locales.map((language) => `<link rel="alternate" hreflang="${language}" href="${escapeHtml(localizedUrl(config, language))}">`).join('');
    const schema = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': `${config.origin}/#website`, name: 'XCopy', alternateName: '随传', url: `${config.origin}/`, inLanguage: locales },
        { '@type': 'WebApplication', '@id': `${config.origin}/#app`, name: 'XCopy', alternateName: '随传', url, applicationCategory: 'UtilitiesApplication', operatingSystem: 'Web, Windows, macOS, Linux', isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } }
      ]
    };
    const json = JSON.stringify(schema).replace(/</g, '\\u003c');
    home = `${alternates}<link rel="alternate" hreflang="x-default" href="${xml(config.origin)}/"><meta property="og:url" content="${xml(url)}"><script type="application/ld+json">${json}</script>`;
  }
  return translateHtml(content, locale).replace('</head>', `${canonical}${home}</head>`);
}
