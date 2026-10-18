import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['server', 'public', 'scripts', 'test'].flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.js')).map((name) => `${dir}/${name}`));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
console.log(`语法检查通过：${files.length} 个 JavaScript 文件`);
