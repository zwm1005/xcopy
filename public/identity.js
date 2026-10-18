export function base64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('suichuan-identity', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identity');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法保存设备身份，请检查浏览器存储权限'));
  });
}

export async function loadIdentity() {
  if (!globalThis.isSecureContext || !crypto.subtle) {
    throw new Error('请通过 HTTPS 打开；本机开发可使用 localhost');
  }
  const db = await database();
  try {
    const existing = await new Promise((resolve, reject) => {
      const request = db.transaction('identity').objectStore('identity').get('device');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (existing) {
      return existing;
    }
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', spki))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const created = { privateKey: keys.privateKey, publicKey: base64(spki), fingerprint };
    // Recheck inside the write transaction so simultaneous first-open tabs pick
    // the same identity, even in browsers without the Web Locks API.
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('identity', 'readwrite');
      const store = tx.objectStore('identity');
      const request = store.get('device');
      let result;
      request.onsuccess = () => {
        result = request.result || created;
        if (!request.result) {
          store.put(created, 'device');
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error('设备身份保存失败，请检查浏览器存储权限'));
      tx.onabort = tx.onerror;
    });
  } finally {
    db.close();
  }
}

export async function signChallenge(identity, challenge) {
  return base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, new TextEncoder().encode(challenge)));
}
