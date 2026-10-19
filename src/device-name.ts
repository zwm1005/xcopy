import { t } from './i18n/index.js';
import { validDeviceName } from './shared/device-name.js';
export { validDeviceName } from './shared/device-name.js';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
interface PlatformInfo {
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
    userAgentData?: {
        platform?: string;
    };
}
interface NameOptions {
    storage?: () => Pick<Storage, 'getItem' | 'setItem'> | null;
    platform?: () => string;
    random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}
export function devicePlatform(info: PlatformInfo = globalThis.navigator || {}) {
    const ua = info.userAgent || '';
    const platform = info.userAgentData?.platform || info.platform || '';
    if (/iPad/i.test(ua) || (/Mac/i.test(platform) && (info.maxTouchPoints || 0) > 1)) {
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
export function createDeviceNames({ storage = () => globalThis.localStorage, platform = devicePlatform, random = (bytes) => crypto.getRandomValues(bytes) }: NameOptions = {}) {
    const memory = new Map<string, string>();
    const unsaved = new Set<string>();
    function read(key: string) {
        if (unsaved.has(key)) {
            return memory.get(key) || null;
        }
        try {
            const saved = storage();
            if (saved) {
                const value = saved.getItem(key);
                if (value === null) {
                    memory.delete(key);
                }
                else {
                    memory.set(key, value);
                }
                return value;
            }
        }
        catch { /* 使用本页内存。 */ }
        return memory.get(key) || null;
    }
    function write(key: string, value: string) {
        memory.set(key, value);
        unsaved.add(key);
        try {
            const saved = storage();
            if (saved) {
                saved.setItem(key, value);
                unsaved.delete(key);
            }
        }
        catch { /* 名称持久化失败不阻断传输。 */ }
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
        rememberDevice(name: string) {
            if (validDeviceName(name)) {
                write('suichuan-name', name);
            }
        },
        renameGuest(name: string) {
            const valid = validDeviceName(name);
            if (!valid) {
                throw new Error(t("app.enter.a.device.name.with.1.24.characters"));
            }
            write('suichuan-share-name', valid);
            return valid;
        },
        needsConfirmation(id?: string, name?: string) {
            return read('suichuan-name-confirmed') !== id && (name === '我的电脑' || name === read('suichuan-auto-name'));
        }
    };
}
export const deviceNames = createDeviceNames();
