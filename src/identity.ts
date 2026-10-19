import { t } from './i18n/index.js';
import type { Identity } from './types/device.js';
export function base64(buffer: ArrayBuffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('suichuan-identity', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('identity');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(t("identity.unable.to.save.device.identity.check.browser.storage")));
    });
}
export async function loadIdentity(): Promise<Identity> {
    if (!globalThis.isSecureContext || !crypto.subtle) {
        throw new Error(t("identity.open.this.page.over.https.local.development.may"));
    }
    const db = await database();
    try {
        const existing = await new Promise<unknown>((resolve, reject) => {
            const request = db.transaction('identity').objectStore('identity').get('device');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        if (existing !== undefined) {
            return validateIdentity(existing);
        }
        const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
        const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', spki))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const created = { privateKey: keys.privateKey, publicKey: base64(spki), fingerprint };
        // Recheck inside the write transaction so simultaneous first-open tabs pick
        // the same identity, even in browsers without the Web Locks API.
        return await new Promise<Identity>((resolve, reject) => {
            const tx = db.transaction('identity', 'readwrite');
            const store = tx.objectStore('identity');
            const request = store.get('device');
            let result: Identity;
            request.onsuccess = () => {
                try {
                    result = request.result === undefined ? created : validateIdentity(request.result);
                    if (request.result === undefined) {
                        store.put(created, 'device');
                    }
                } catch (error) {
                    reject(error);
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(new Error(t("identity.failed.to.save.device.identity.check.browser.storage")));
            tx.onabort = tx.onerror;
        });
    }
    finally {
        db.close();
    }
}
export async function signChallenge(identity: Identity, challenge: string) {
    return base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, new TextEncoder().encode(challenge)));
}
function validateIdentity(value: unknown): Identity {
    if (typeof value !== 'object' || value === null || !('privateKey' in value) || !('publicKey' in value) || !('fingerprint' in value)
        || !(value.privateKey instanceof CryptoKey) || value.privateKey.type !== 'private' || value.privateKey.algorithm.name !== 'ECDSA'
        || typeof value.publicKey !== 'string' || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
        throw new Error(t("identity.saved.device.identity.is.invalid.check.browser.storage"));
    }
    return { privateKey: value.privateKey, publicKey: value.publicKey, fingerprint: value.fingerprint };
}
