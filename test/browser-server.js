import { createApp } from '../server/index.js';

// Browser scenarios create many independent devices on one loopback IP.
// Production guessing limits are separately verified in server.test.js.
const app = createApp({ joinLimit: 100 });
await app.listen();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
