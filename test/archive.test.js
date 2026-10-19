import test from 'node:test';
import assert from 'node:assert/strict';
import { archive } from '../public/archive.js';

test('ZIP stores UTF-8 names, empty files, duplicates and binary payloads with correct CRC', async () => {
  const blob = await archive([
    { name: '中文.txt', blob: new Blob(['123456789']) },
    { name: '中文.txt', blob: new Blob([]) },
    { name: '../bad.bin', blob: new Blob([new Uint8Array([0, 255, 127])]) }
  ]);
  const bytes = Buffer.from(await blob.arrayBuffer());
  let position = 0;
  const decoded = [];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(bytes.readUInt32LE(position), 0x04034b50);
    assert.equal(bytes.readUInt16LE(position + 6), 0x800);
    const length = bytes.readUInt16LE(position + 26);
    const size = bytes.readUInt32LE(position + 18);
    const name = bytes.subarray(position + 30, position + 30 + length).toString();
    decoded.push({ name, data: bytes.subarray(position + 30 + length, position + 30 + length + size) });
    if (i === 0) {
      assert.equal(bytes.readUInt32LE(position + 14), 0xcbf43926);
    }
    position += 30 + length + size;
  }
  assert.deepEqual(decoded.map((f) => f.name), ['中文.txt', '中文.txt (2)', '.._bad.bin']);
  assert.equal(decoded[0].data.toString(), '123456789');
  assert.equal(decoded[1].data.length, 0);
  assert.deepEqual(decoded[2].data, Buffer.from([0, 255, 127]));
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), 3);
  assert.equal(bytes.readUInt32LE(bytes.length - 6), position);
});
