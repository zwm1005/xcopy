import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './frontend-artifact.js';

export async function checkI18n() {
  const dictionaries = await Promise.all(['zh-CN', 'en'].map(async (locale) => {
    const text = await readFile(resolve(projectRoot, `src/i18n/${locale}.ts`), 'utf8');
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  }));
  const [zh, en] = dictionaries;
  if (JSON.stringify(Object.keys(zh).sort()) !== JSON.stringify(Object.keys(en).sort())) {
    throw new Error('中英文词典键不一致');
  }
  const params = (text) => [...text.matchAll(/\{([a-zA-Z]\w*)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(zh)) {
    if (typeof en[key] !== 'string' || !en[key] || JSON.stringify(params(zh[key])) !== JSON.stringify(params(en[key]))) {
      throw new Error(`词典缺少翻译或参数不一致：${key}`);
    }
  }
  for (const page of ['index', 'transfer', 'share']) {
    const html = await readFile(resolve(projectRoot, `public/${page}.html`), 'utf8');
    for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
      if (!Object.hasOwn(zh, match[1])) {
        throw new Error(`HTML 引用了未知文案键：${page} → ${match[1]}`);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await checkI18n();
  console.log('中英文词典键及参数检查通过');
}
