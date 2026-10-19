import { createHash } from 'node:crypto';
import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export const projectRoot = resolve(import.meta.dirname, '..');
export async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await filesUnder(path));
    } else if (entry.isFile()) {
      result.push(path);
    } else {
      throw new Error(`Unsupported source entry: ${path}`);
    }
  }
  return result.sort();
}
export async function inputDigest() {
  const hash = createHash('sha256');
  const inputs = [
    ...await filesUnder(resolve(projectRoot, 'src')),
    ...await filesUnder(resolve(projectRoot, 'public')),
    ...['package.json', 'package-lock.json', 'tsconfig.frontend.json', 'scripts/build-frontend.js', 'scripts/frontend-artifact.js', 'scripts/check-i18n.js', 'server/assets.js'].map((p) => resolve(projectRoot, p)),
  ].sort();
  for (const path of inputs) {
    hash.update(relative(projectRoot, path));
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}
export async function assertFrontend({ fresh = false } = {}) {
  try {
    const manifest = JSON.parse(await readFile(resolve(projectRoot, 'dist/build-manifest.json'), 'utf8'));
    if (!manifest.files || !['/index.html', '/transfer.html', '/share.html', '/app.js', '/home.js', '/share.js'].every((p) => p in manifest.files)) {
      throw new Error('incomplete manifest');
    }
    await Promise.all(Object.keys(manifest.files).map((p) => access(resolve(projectRoot, `dist/public${p}`))));
    if (fresh && manifest.inputDigest !== await inputDigest()) {
      throw new Error('source changed after build');
    }
  } catch (cause) {
    throw new Error('前端构建不存在、不完整或已过期，请先执行 npm run build。', { cause });
  }
}
