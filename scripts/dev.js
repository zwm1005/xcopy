import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

let building = false;
let dirty = false;
let server;
let timer;
async function build() {
  dirty = true;
  if (building) {
    return;
  }
  building = true;
  while (dirty) {
    dirty = false;
    const child = spawn(process.execPath, ['scripts/build-frontend.js'], { stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    if (code === 0 && !server) {
      server = spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/index.js'], { stdio: 'inherit' });
      server.once('exit', (status) => { process.exitCode = status || 0; shutdown(); });
    }
  }
  building = false;
}
const watchers = ['src', 'public'].map((path) => watch(path, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => { void build(); }, 150);
}));
function shutdown() {
  for (const watcher of watchers) {
    watcher.close();
  }
  server?.kill('SIGTERM');
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await build();
