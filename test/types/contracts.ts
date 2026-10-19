import { Connection } from '../../src/connection.js';
import { t } from '../../src/i18n/index.js';
import type { Source } from '../../src/types/transfer.js';
const connection = new Connection();
void connection.rpc('pair.code');
void connection.rpc('pair.join', { code: '12345678' });
// @ts-expect-error Unknown methods cannot cross the protocol boundary.
void connection.rpc('pair.unknown');
// @ts-expect-error Required payload is enforced.
void connection.rpc('pair.join');
// @ts-expect-error Payload types are enforced.
void connection.rpc('pair.join', { code: 12345678 });
// @ts-expect-error A file source must contain its File.
const source: Source = { kind: 'file', text: 'not a file' };
void source;
t('app.remove', { p0: 'file.txt' });
// @ts-expect-error Translation keys are checked.
t('missing.key');
// @ts-expect-error Placeholders are required.
t('app.remove');
// @ts-expect-error Misspelled placeholders are checked.
t('app.remove', { filename: 'file.txt' });
connection.addEventListener('ready', (event) => {
  const name: string = event.detail.device.name;
  // @ts-expect-error Typed events do not permit arbitrary fields.
  void event.detail.nonexistent;
  void name;
});
