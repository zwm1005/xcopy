import { isIP } from 'node:net';
import { resolve } from 'node:path';

function number(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} 配置无效`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const origin = env.PUBLIC_ORIGIN || 'http://localhost:8787';
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN 必须是无路径的 HTTPS origin；仅本机开发允许 HTTP');
  }
  const stunUrls = iceUrls(env.STUN_URLS || '', 'STUN_URLS', ['stun']);
  const turnUrls = iceUrls(env.TURN_URLS || '', 'TURN_URLS', ['turn', 'turns']);
  const turnAuthMode = env.TURN_AUTH_MODE || 'shared-secret';
  const turnSecret = env.TURN_SECRET || '';
  const turnUsername = env.TURN_USERNAME || '';
  const turnPassword = env.TURN_PASSWORD || '';
  if (!['shared-secret', 'static'].includes(turnAuthMode)) {
    throw new Error('TURN_AUTH_MODE must be shared-secret or static');
  }
  if (turnAuthMode === 'shared-secret' && (turnUsername || turnPassword)) {
    throw new Error('TURN_USERNAME/TURN_PASSWORD conflict with shared-secret authentication');
  }
  if (turnAuthMode === 'static' && turnSecret) {
    throw new Error('TURN_SECRET conflicts with static authentication');
  }
  if (turnUrls.length && (turnAuthMode === 'static' ? !turnUsername || !turnPassword : turnSecret.length < 32)) {
    throw new Error('TURN authentication is incomplete: provide a secret of at least 32 characters or static username/password');
  }
  const forceRelay = boolean(env, 'FORCE_RELAY');
  if (forceRelay && !turnUrls.length) {
    throw new Error('FORCE_RELAY requires TURN_URLS and valid authentication');
  }
  const defaultLocale = env.DEFAULT_LOCALE || 'en';
  if (!['zh-CN', 'en'].includes(defaultLocale)) {
    throw new Error('DEFAULT_LOCALE must be zh-CN or en');
  }
  const indexnowKey = env.INDEXNOW_KEY || '';
  if (indexnowKey && !/^[a-zA-Z0-9-]{8,128}$/.test(indexnowKey)) {
    throw new Error('INDEXNOW_KEY must be 8–128 ASCII letters, digits or hyphens');
  }
  const cliDownloadUrl = env.CLI_DOWNLOAD_URL || '';
  if (cliDownloadUrl) {
    const download = new URL(cliDownloadUrl, origin);
    if ((!cliDownloadUrl.startsWith('/') && download.protocol !== 'https:') || (cliDownloadUrl.startsWith('/') && download.origin !== origin) || /[\\\u0000-\u0020]/.test(cliDownloadUrl) || cliDownloadUrl.startsWith('//') || download.username || download.password || !['https:', 'http:'].includes(download.protocol)) {
      throw new Error('CLI_DOWNLOAD_URL must be a same-origin path or HTTPS URL');
    }
  }
  return {
    host: env.HOST || '127.0.0.1', port: number(env, 'PORT', 8787, 0, 65535),
    origin, dbPath: resolve(env.DB_PATH || 'data/suichuan.sqlite'),
    trustProxy: boolean(env, 'TRUST_PROXY'),
    maxFileBytes: number(env, 'MAX_FILE_MB', 50, 1, 1024) * 1024 * 1024,
    maxTextBytes: 1024 * 1024, maxActive: 16,
    codeTtl: 600000, challengeTtl: 60000,
    idleTimeout: 90000, reconnectGrace: 15000,
    shareConcurrency: Math.floor(number(env, 'SHARE_CONCURRENCY', 3, 1, 3)),
    shareQueueLimit: Math.floor(number(env, 'SHARE_QUEUE_LIMIT', 20, 0, 200)),
    shareGlobalClaims: Math.floor(number(env, 'SHARE_GLOBAL_CLAIMS', 256, 3, 2000)),
    shareWatcherLimit: Math.floor(number(env, 'SHARE_WATCHER_LIMIT', 200, 1, 1000)),
    joinLimit: 5, joinGlobalLimit: number(env, 'PAIR_GLOBAL_LIMIT', 100, 1, 10000),
    turnUrls, turnSecret, turnAuthMode, turnUsername, turnPassword, stunUrls, forceRelay, defaultLocale, cliDownloadUrl, indexnowKey,
    turnCredentialTtlSeconds: number(env, 'TURN_CREDENTIAL_TTL_SECONDS', 3600, 3600, 86400)
  };
}

function boolean(env, name) {
  if (env[name] !== undefined && !['', '0', '1'].includes(env[name])) {
    throw new Error(`${name} must be 0 or 1`);
  }
  return env[name] === '1';
}

export function iceUrls(value, name, schemes) {
  const urls = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
  for (const uri of urls) {
    const match = /^(stun|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/.exec(uri);
    if (!match || !schemes.includes(match[1])) {
      throw new Error(`${name} contains an invalid ICE URI`);
    }
    const [, scheme, host, port, transport] = match;
    const validHost = host.startsWith('[') ? isIP(host.slice(1, -1)) === 6
      : isIP(host) === 4 || (!/^[0-9.]+$/.test(host) && host.length <= 253 && host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)));
    if (!validHost || (port && (Number(port) < 1 || Number(port) > 65535)) || (scheme === 'stun' && transport) || (scheme === 'turns' && transport === 'udp')) {
      throw new Error(`${name} contains an invalid host, port or transport`);
    }
  }
  return urls;
}
