const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function validDeviceName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const name = value.trim();
  return name.length > 0 && name.length <= 24 && !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : '';
}

export function devicePlatform(info = globalThis.navigator || {}) {
  const ua = info.userAgent || '';
  const platform = info.userAgentData?.platform || info.platform || '';
  if (/iPad/i.test(ua) || (/Mac/i.test(platform) && info.maxTouchPoints > 1)) {
    return 'iPadOS';
  }
  if (/iPhone|iPod/i.test(ua) || /^iOS$/i.test(platform)) {
    return 'iOS';
  }
  if (/Android/i.test(`${platform} ${ua}`)) {
    return 'Android';
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    return 'Windows';
  }
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) {
    return 'macOS';
  }
  if (/Linux/i.test(`${platform} ${ua}`)) {
    return 'Linux';
  }
  return 'Device';
}

// 访客只保存名称偏好，不创建永久设备身份；存储被禁用时仍可在本页领取。
export function createDeviceNames({ storage = () => globalThis.localStorage, platform = devicePlatform, random = (bytes) => crypto.getRandomValues(bytes) } = {}) {
  const memory = new Map();
  const unsaved = new Set();
  function read(key) {
    if (unsaved.has(key)) {
      return memory.get(key) || null;
    }
    try {
      const saved = storage();
      if (saved) {
        const value = saved.getItem(key);
        if (value === null) {
          memory.delete(key);
        } else {
          memory.set(key, value);
        }
        return value;
      }
    } catch { /* 使用本页内存。 */ }
    return memory.get(key) || null;
  }
  function write(key, value) {
    memory.set(key, value);
    unsaved.add(key);
    try {
      const saved = storage();
      if (saved) {
        saved.setItem(key, value);
        unsaved.delete(key);
      }
    } catch { /* 名称持久化失败不阻断传输。 */ }
  }
  function automatic() {
    let name = validDeviceName(read('suichuan-auto-name'));
    if (!name) {
      const suffix = [...random(new Uint8Array(4))].map((n) => alphabet[n % alphabet.length]).join('');
      name = `${platform()}-${suffix}`;
      write('suichuan-auto-name', name);
    }
    return name;
  }
  function device() {
    return validDeviceName(read('suichuan-name')) || automatic();
  }
  function guest() {
    return validDeviceName(read('suichuan-share-name')) || device();
  }
  return {
    read, write, automatic, device, guest,
    rememberDevice(name) {
      if (validDeviceName(name)) {
        write('suichuan-name', name);
      }
    },
    renameGuest(name) {
      const valid = validDeviceName(name);
      if (!valid) {
        throw new Error('请输入 1–24 个字符的设备名称');
      }
      write('suichuan-share-name', valid);
      return valid;
    },
    needsConfirmation(id, name) {
      return read('suichuan-name-confirmed') !== id && (name === '我的电脑' || name === read('suichuan-auto-name'));
    }
  };
}

export const deviceNames = createDeviceNames();
