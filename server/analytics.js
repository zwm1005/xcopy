import { escapeHtml, pageLocale } from './page-html.js';

export function analyticsMarkup(content, file, config) {
  if (!config.analyticsEnabled || !['/index.html', '/transfer.html', '/share.html'].includes(file)) {
    return content;
  }
  const base = escapeHtml(config.analyticsPath);
  return content.toString().replace('</head>', `<script type="module" src="/analytics.js" data-analytics-base="${base}"></script></head>`)
    .replace('</body>', '<a class="analytics-privacy-link" href="/analytics-privacy">Statistics / 访问统计</a></body>');
}

export function analyticsPrivacy(config, requestUrl) {
  const zh = pageLocale(requestUrl, config) === 'zh-CN';
  const title = zh ? '本站访问统计' : 'Site statistics';
  const description = zh
    ? '本站已由部署者开启访问统计。统计页面浏览、匿名浏览器标识、来源域名、浏览器和系统，以及 IP 推断的地区。原始 IP 最多保留 30 天，访问明细保留 90 天，日汇总保留 13 个月。统计不包含传输文字、剪贴板、文件名、文件内容或分享令牌。'
    : 'This deployment has enabled site statistics: page views, anonymous browser identifiers, referring domains, browser and OS, and approximate IP-based location. Raw IPs are kept for up to 30 days, events for 90 days, and daily totals for 13 months. Transfer text, clipboard data, filenames, file contents and share tokens are excluded.';
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>${title}</title><link rel="stylesheet" href="/styles.css"></head><body><div id="suichuan"><main class="qt-main"><h1>${title}</h1><p>${description}</p><p><a href="/?analytics=off">${zh ? '排除本浏览器的后续访问' : 'Exclude future visits from this browser'}</a></p><p><a href="/?analytics=on">${zh ? '恢复本浏览器的访问统计' : 'Enable statistics for this browser'}</a></p><p><a href="/">${zh ? '返回首页' : 'Home'}</a></p></main></div><script type="module" src="/analytics.js" data-analytics-base="${escapeHtml(config.analyticsPath)}" data-analytics-preferences></script></body></html>`;
}
