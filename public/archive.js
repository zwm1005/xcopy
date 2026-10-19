const encoder = new TextEncoder();
const table = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  table[n] = c >>> 0;
}

// ZIP STORE（不压缩），逐个计算 CRC；不额外同时复制整组文件。
export async function archive(files) {
  const parts = [];
  const directory = [];
  const used = new Set();
  let offset = 0;
  let directoryBytes = 0;
  for (const file of files) {
    const base = file.name.replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+$/, '_') || '随传文件';
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base} (${suffix++})`;
    }
    used.add(name);
    const encoded = encoder.encode(name);
    if (file.blob.size > 0xffffffff || offset + 30 + encoded.length + file.blob.size > 0xffffffff) {
      throw new Error('文件较大，请逐个保存');
    }
    let crc = 0xffffffff;
    for (let start = 0; start < file.blob.size; start += 1048576) {
      const data = new Uint8Array(await file.blob.slice(start, start + 1048576).arrayBuffer());
      for (const byte of data) {
        crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + encoded.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true); h.setUint32(14, crc, true);
    h.setUint32(18, file.blob.size, true); h.setUint32(22, file.blob.size, true); h.setUint16(26, encoded.length, true);
    header.set(encoded, 30);
    parts.push(header, file.blob);
    const entry = new Uint8Array(46 + encoded.length);
    const d = new DataView(entry.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
    d.setUint16(14, 33, true); d.setUint32(16, crc, true);
    d.setUint32(20, file.blob.size, true); d.setUint32(24, file.blob.size, true); d.setUint16(28, encoded.length, true); d.setUint32(42, offset, true);
    entry.set(encoded, 46); directory.push(entry);
    directoryBytes += entry.length;
    offset += header.length + file.blob.size;
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directoryBytes, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
