import { assertFrontend } from '../scripts/frontend-artifact.js';
await assertFrontend({ fresh: true });
import { readFileSync } from 'node:fs';
import { createApp } from '../server/index.js';

// Browser scenarios create many independent devices on one loopback IP.
// Production guessing limits are separately verified in server.test.js.
const clockFile = `/tmp/suichuan-e2e-clock-${process.env.PORT}`;
const app = createApp({ joinLimit: 100, authLimit: 1000, connectLimit: 1000, now: () => {
  try {
    return Date.now() + Number(readFileSync(clockFile, 'utf8'));
  } catch {
    return Date.now();
  }
} });
await app.listen();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
