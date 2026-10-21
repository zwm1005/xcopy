import zh from './zh-CN.js';
import en from './en.js';
import { isMessageKey } from './messages.js';
import { enhanceSelect, syncSelect } from '../select.js';
import type { MessageArgs, MessageKey, MessageParams } from './messages.js';
export type Locale = 'zh-CN' | 'en';
export interface ClientConfig { defaultLocale: Locale; supportedLocales: Locale[]; cliDownloadUrl: string | null }
let locale: Locale = 'en';
const listeners = new Set<() => void>();
const englishPlural = new Intl.PluralRules('en');
export const currentLocale = () => locale;
export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  if (/^zh(?:-|$)/i.test(value || '')) {
    return 'zh-CN';
  }
  if (/^en(?:-|$)/i.test(value || '')) {
    return 'en';
  }
  return undefined;
}
export function chooseLocale(url: string | null, saved: string | null, browserLanguage: string): Locale {
  return normalizeLocale(url) || normalizeLocale(saved) || normalizeLocale(browserLanguage) || 'en';
}
export function translate(key: string, params: MessageParams = {}): string {
  if (!isMessageKey(key)) {
    return locale === 'en' ? 'Unable to complete the operation. Please try again.' : '操作未完成，请重试。';
  }
  let message: string = (locale === 'en' ? en : zh)[key];
  if (locale === 'en') {
    message = message.replace(/\{(\w+)\} (files|devices|items|claims|minutes|recipients)/g, (match, name: string, noun: string) => englishPlural.select(Number(params[name])) === 'one' ? `{${name}} ${noun.slice(0, -1)}` : match);
  }
  return message.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  return translate(key, args[0]);
}
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function applyTranslations(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = translate(element.dataset.i18n || '');
  }
  for (const attribute of ['aria-label', 'placeholder', 'title', 'alt', 'data-tooltip', 'content']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, translate(element.getAttribute(`data-i18n-${attribute}`) || ''));
    }
  }
  for (const template of root.querySelectorAll('template')) {
    applyTranslations(template.content);
  }
}
export function setLocale(next: Locale, persist = true): void {
  locale = next;
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.lang = locale;
  applyTranslations();
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-locale]')) {
    select.value = locale;
    select.setAttribute('aria-label', translate('language.label'));
    syncSelect(select);
  }
  document.querySelector('meta[property="og:locale"]')?.setAttribute('content', locale === 'en' ? 'en_US' : 'zh_CN');
  const alternate = document.querySelector<HTMLLinkElement>(`link[rel="alternate"][hreflang="${locale}"]`);
  if (alternate) {
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', alternate.href);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', alternate.href);
  }
  if (persist) {
    try {
      localStorage.setItem('suichuan-locale', locale);
    } catch { /* Private browsing may disable storage. */ }
    const url = new URL(location.href);
    if (url.searchParams.has('lang') || alternate) {
      url.searchParams.set('lang', locale);
      history.replaceState(history.state, '', url);
    }
  }
  for (const listener of listeners) {
    listener();
  }
}
async function loadClientConfig(): Promise<void> {
  const config: ClientConfig = { defaultLocale: 'en', supportedLocales: ['zh-CN', 'en'], cliDownloadUrl: null };
  try {
    const response = await fetch('/api/client-config', { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null && 'defaultLocale' in data && typeof data.defaultLocale === 'string') {
      config.defaultLocale = normalizeLocale(data.defaultLocale) || 'en';
      if ('cliDownloadUrl' in data && typeof data.cliDownloadUrl === 'string') {
        const url = new URL(data.cliDownloadUrl, location.origin);
        if (url.protocol === 'https:' || (url.origin === location.origin && url.protocol === 'http:')) {
          config.cliDownloadUrl = url.href;
        }
      }
    }
  } catch { /* The application can start with the built-in locales while offline. */ }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-cli-download]')) {
    link.hidden = !config.cliDownloadUrl;
    if (config.cliDownloadUrl) {
      link.href = config.cliDownloadUrl;
    }
  }
}
export function initI18n(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('suichuan-locale');
  } catch { /* Locale persistence is optional. */ }
  const browserLanguage = navigator.languages?.[0] || navigator.language;
  setLocale(chooseLocale(new URL(location.href).searchParams.get('lang'), saved, browserLanguage), false);
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-locale]')) {
    select.addEventListener('change', () => setLocale(normalizeLocale(select.value) || 'en'));
    enhanceSelect(select);
  }
  // Language selection is entirely local. Optional download configuration must
  // not delay identity loading, WebSocket authentication or page interaction.
  void loadClientConfig();
}
