import { resolve } from 'node:path';

function number(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
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
  const turnUrls = (env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turnUrls.some((value) => !/^turns?:[^\s]+$/.test(value))) {
    throw new Error('TURN_URLS 只接受 turn: 或 turns: 地址');
  }
  if (turnUrls.length && (!env.TURN_SECRET || env.TURN_SECRET.length < 32)) {
    throw new Error('配置 TURN 时 TURN_SECRET 至少需要 32 个字符');
  }
  return {
    host: env.HOST || '127.0.0.1', port: number(env, 'PORT', 8787, 0, 65535),
    origin, dbPath: resolve(env.DB_PATH || 'data/suichuan.sqlite'),
    trustProxy: env.TRUST_PROXY === '1',
    maxFileBytes: number(env, 'MAX_FILE_MB', 50, 1, 1024) * 1024 * 1024,
    maxTextBytes: 1024 * 1024, maxActive: 16,
    codeTtl: 600000, challengeTtl: 60000,
    idleTimeout: 90000, reconnectGrace: 15000,
    shareConcurrency: Math.floor(number(env, 'SHARE_CONCURRENCY', 3, 1, 3)),
    shareQueueLimit: Math.floor(number(env, 'SHARE_QUEUE_LIMIT', 20, 0, 200)),
    shareGlobalClaims: Math.floor(number(env, 'SHARE_GLOBAL_CLAIMS', 256, 3, 2000)),
    shareWatcherLimit: Math.floor(number(env, 'SHARE_WATCHER_LIMIT', 200, 1, 1000)),
    joinLimit: 5, joinGlobalLimit: number(env, 'PAIR_GLOBAL_LIMIT', 100, 1, 10000),
    turnUrls, turnSecret: env.TURN_SECRET || '',
    stunUrls: (env.STUN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    forceRelay: env.FORCE_RELAY === '1'
  };
}
