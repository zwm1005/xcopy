import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceNames, devicePlatform, validDeviceName } from '../public/device-name.js';

test('platform names handle client hints, Android/Linux overlap and iPad desktop mode', () => {
  for (const [info, expected] of [
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)', platform: 'iPhone' }, 'iOS'],
    [{ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X)' }, 'iPadOS'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }, 'iPadOS'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 10; K)', platform: 'Linux aarch64' }, 'Android'],
    [{ userAgentData: { platform: 'Windows' }, platform: 'Win32' }, 'Windows'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, 'Windows'],
    [{ userAgentData: { platform: 'macOS' }, platform: 'MacIntel', maxTouchPoints: 0 }, 'macOS'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux aarch64)' }, 'Linux'],
    [{}, 'Device']
  ]) {
    assert.equal(devicePlatform(info), expected);
  }
});

function store(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('names persist across reloads, reuse existing aliases and keep guest edits separate from paired identity', () => {
  const storage = store();
  const first = createDeviceNames({ storage: () => storage, platform: () => 'iOS' });
  const generated = first.guest();
  assert.match(generated, /^iOS-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(first.device(), generated);
  const reload = createDeviceNames({ storage: () => storage, platform: () => 'macOS' });
  assert.equal(reload.guest(), generated);
  first.rememberDevice('文铭的 iPhone');
  assert.equal(reload.guest(), '文铭的 iPhone');
  assert.equal(reload.renameGuest('  工作手机  '), '工作手机');
  assert.equal(first.guest(), '工作手机');
  assert.equal(first.device(), '文铭的 iPhone');
  const legacy = createDeviceNames({ storage: () => store({ 'suichuan-name': '我的电脑' }) });
  assert.equal(legacy.device(), '我的电脑');
});

test('blocked or read-only local storage does not interrupt naming or rename', () => {
  for (const storage of [() => { throw new Error('blocked'); }, () => ({ getItem: () => null, setItem: () => { throw new Error('quota'); } })]) {
    const names = createDeviceNames({ storage, platform: () => 'Android' });
    const generated = names.guest();
    assert.equal(names.guest(), generated);
    names.renameGuest('临时手机');
    assert.equal(names.guest(), '临时手机');
  }
  const names = createDeviceNames({ storage: () => ({ getItem: () => '旧名称', setItem: () => { throw new Error('quota'); } }) });
  names.renameGuest('新名称');
  assert.equal(names.guest(), '新名称');
});

test('empty, oversized and misleading control characters are rejected; custom names remain literal text', () => {
  for (const value of [null, 7, '', '  ', 'a'.repeat(25), '设备\n另一行', 'name\u202etxt']) {
    assert.equal(validDeviceName(value), '');
  }
  assert.equal(validDeviceName('  文铭的 iPhone  '), '文铭的 iPhone');
  assert.equal(validDeviceName('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(validDeviceName('<b>手机</b>'), '<b>手机</b>');
});
