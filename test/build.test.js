import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('clean staged build removes stale files and preserves the previous release on compiler or copy failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suichuan-build-'));
  try {
    for (const path of ['src', 'public', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.frontend.json']) {
      await cp(resolve(path), join(root, path), { recursive: true });
    }
    await mkdir(join(root, 'server'));
    await cp(resolve('server/assets.js'), join(root, 'server/assets.js'));
    await symlink(resolve('node_modules'), join(root, 'node_modules'));
    const build = () => spawnSync(process.execPath, ['scripts/build-frontend.js'], { cwd: root, encoding: 'utf8' });
    const clean = build();
    assert.equal(clean.status, 0, clean.stderr);
    const manifest = await readFile(join(root, 'dist/build-manifest.json'), 'utf8');
    await writeFile(join(root, 'src/invalid.ts'), 'const invalid: string = 42;');
    assert.notEqual(build().status, 0);
    assert.equal(await readFile(join(root, 'dist/build-manifest.json'), 'utf8'), manifest);
    await rm(join(root, 'src/invalid.ts'));
    await writeFile(join(root, 'public/app.js'), 'throw new Error("stale JavaScript");');
    assert.notEqual(build().status, 0);
    assert.equal(await readFile(join(root, 'dist/build-manifest.json'), 'utf8'), manifest);
    await rm(join(root, 'public/app.js'));
    await writeFile(join(root, 'dist/public/stale.js'), 'old');
    assert.equal(build().status, 0);
    await assert.rejects(readFile(join(root, 'dist/public/stale.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
