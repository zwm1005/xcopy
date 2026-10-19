const xml = (text) => text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
export function discovery(path, req, res, config) {
  let body;
  let type = 'text/plain; charset=utf-8';
  if (path === '/robots.txt') {
    body = `User-agent: *\nAllow: /\nDisallow: /s\nDisallow: /transfer\nSitemap: ${config.origin}/sitemap.xml\n`;
  } else if (path === '/sitemap.xml') {
    type = 'application/xml; charset=utf-8';
    body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${xml(config.origin)}/</loc></url></urlset>\n`;
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

export function pageMetadata(content, file, config) {
  if (!['/index.html', '/transfer.html'].includes(file)) {
    return content;
  }
  const url = `${config.origin}${file === '/index.html' ? '/' : '/transfer'}`;
  const canonical = `<link rel="canonical" href="${xml(url)}">`;
  const home = file === '/index.html' ? `<meta property="og:url" content="${xml(url)}"><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'XCopy', alternateName: '随传', url, inLanguage: ['zh-CN', 'en'] })}</script>` : '';
  return content.toString('utf8').replace('</head>', `${canonical}${home}</head>`);
}
