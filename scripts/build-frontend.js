import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, cp, rm, rename, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { filesUnder, inputDigest, projectRoot } from './frontend-artifact.js';
import { assets } from '../server/assets.js';
import { checkI18n } from './check-i18n.js';

const lock = resolve(projectRoot, '.frontend-build-lock');
await mkdir(lock).catch(() => { throw new Error('另一个前端构建正在进行；若上次构建异常退出，确认无构建进程后删除 .frontend-build-lock。'); });
const staging = await mkdtemp(resolve(projectRoot, '.frontend-build-'));
const output = resolve(staging, 'public');
const destination = resolve(projectRoot, 'dist');
const previous = resolve(projectRoot, '.frontend-build-previous');
try {
  const digest = await inputDigest();
  await checkI18n();
  const compiler = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.frontend.json', '--outDir', output], { cwd: projectRoot, stdio: 'inherit' });
  if (compiler.status !== 0) {
    throw new Error('TypeScript 编译失败，保留上一份完整构建。');
  }
  await rm(resolve(output, 'types'), { recursive: true, force: true });
  for (const source of await filesUnder(resolve(projectRoot, 'public'))) {
    const path = relative(resolve(projectRoot, 'public'), source);
    if (['robots.txt', 'sitemap.xml', 'indexnow.txt'].includes(path) || (extname(path) === '.js' && path !== 'qrcode.js' && !path.startsWith('vendor/'))) {
      throw new Error(`静态目录存在已迁移或不允许的资源：${path}`);
    }
    const target = resolve(output, path);
    if (await stat(target).then(() => true, () => false)) {
      throw new Error(`静态资源与编译输出同名：${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
  const files = {};
  for (const file of await filesUnder(output)) {
    const url = `/${relative(output, file)}`;
    if (!assets.has(url)) {
      throw new Error(`构建资源缺少精确 HTTP 白名单：${url}`);
    }
    const bytes = await readFile(file);
    files[url] = createHash('sha256').update(bytes).digest('hex');
    const text = bytes.toString('utf8');
    const references = extname(file) === '.js'
      ? [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
      : extname(file) === '.html'
        ? [...text.matchAll(/<(?:script|link|img|use)\b[^>]*(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]) : [];
    for (const reference of references) {
      if (reference.startsWith('#') || /^(https?:|data:|blob:)/.test(reference)) {
        continue;
      }
      if (!reference.startsWith('.') && !reference.startsWith('/')) {
        throw new Error(`浏览器不支持裸模块导入：${url} → ${reference}`);
      }
      const resolved = new URL(reference, `http://build.local${url}`).pathname;
      if (['/', '/transfer', '/s'].includes(resolved)) {
        continue;
      }
      if (!assets.has(resolved)) {
        throw new Error(`引用未开放的资源：${url} → ${resolved}`);
      }
      await stat(resolve(output, `.${resolved}`));
    }
  }
  if (digest !== await inputDigest()) {
    throw new Error('构建期间源码发生变化，请重新构建。');
  }
  await writeFile(resolve(staging, 'build-manifest.json'), `${JSON.stringify({ inputDigest: digest, files }, null, 2)}\n`);
  await rm(previous, { recursive: true, force: true });
  const existed = await stat(destination).then(() => true, () => false);
  if (existed) {
    await rename(destination, previous);
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (existed) {
      await rename(previous, destination);
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  console.log(`前端构建完成：${Object.keys(files).length} 个公开资源。`);
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
