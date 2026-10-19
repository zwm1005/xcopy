import en from '../dist/public/i18n/en.js';
import zh from '../dist/public/i18n/zh-CN.js';

export const escapeHtml = (text) => String(text).replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[character]);

export function pageLocale(requestUrl, config) {
  const requested = new URL(requestUrl, config.origin).searchParams.get('lang') || '';
  if (/^zh(?:-|$)/i.test(requested)) {
    return 'zh-CN';
  }
  if (/^en(?:-|$)/i.test(requested)) {
    return 'en';
  }
  return config.defaultLocale;
}

export function localizedUrl(config, locale, path = '/') {
  return `${config.origin}${path}${locale === config.defaultLocale ? '' : `?lang=${locale}`}`;
}

// Templates mark plain-text leaf elements and individual attributes with data-i18n.
// Escape dictionary values just as the browser's textContent/setAttribute rendering does.
export function translateHtml(content, locale) {
  const dictionary = locale === 'zh-CN' ? zh : en;
  let html = content.toString('utf8').replace(/<html lang="[^"]+"/, `<html lang="${locale}"`);
  html = html.replace(/<([a-z][\w:-]*)\b([^>]*\bdata-i18n="([^"]+)"[^>]*)>([^<]*)<\/\1>/g, (match, tag, attributes, key) => {
    if (!Object.hasOwn(dictionary, key)) {
      throw new Error(`Unknown page translation: ${key}`);
    }
    return `<${tag}${attributes}>${escapeHtml(dictionary[key])}</${tag}>`;
  });
  html = html.replace(/<[a-z][^>]*>/g, (tag) => {
    for (const attribute of ['aria-label', 'placeholder', 'title', 'alt', 'data-tooltip', 'content']) {
      const key = tag.match(new RegExp(`\\sdata-i18n-${attribute}="([^"]+)"`))?.[1];
      if (!key) {
        continue;
      }
      if (!Object.hasOwn(dictionary, key)) {
        throw new Error(`Unknown page attribute translation: ${key}`);
      }
      tag = tag.replace(new RegExp(`(\\s${attribute}=")[^"]*"`), (_, prefix) => `${prefix}${escapeHtml(dictionary[key])}"`);
    }
    return tag;
  });
  html = html.replace(/(<option value="(en|zh-CN)")(?: selected)?/g, (_, option, value) => `${option}${value === locale ? ' selected' : ''}`);
  return html.replace(/(<meta property="og:locale" content=")[^"]*"/, `$1${locale === 'en' ? 'en_US' : 'zh_CN'}"`);
}
