import { createHmac } from 'node:crypto';
import { TokenBuckets } from './availability.js';

export function turnCredentials(config, now, limited) {
  const cache = new Map();
  const buckets = new TokenBuckets(now);
  function sweep() {
    buckets.sweep();
    for (const [id, value] of cache) {
      if (value.expires <= now() + 60000) {
        cache.delete(id);
      }
    }
  }
  return {
    sweep,
    prepare(task) {
      const base = config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
      if (task.directOnly || !config.turnUrls.length) {
        return [base, base];
      }
      const participants = [
        { id: task.from, ws: task.sender, owner: task.from },
        { id: task.to, ws: task.receiver, owner: task.shareId ? task.from : task.to }
      ];
      const fresh = participants.filter(({ id }) => !cache.has(id) || cache.get(id).expires <= now() + 60000);
      const wait = buckets.take(fresh.flatMap(({ ws, owner }) => [
        { key: `device:${owner}`, perMinute: config.turnRate, burst: config.turnBurst },
        { key: `ip:${ws.source}`, perMinute: config.turnIpRate, burst: config.turnIpBurst },
        { key: 'global', perMinute: config.turnGlobalRate, burst: config.turnGlobalBurst }
      ]));
      if (wait) {
        throw limited(wait);
      }
      for (const { id } of fresh) {
        const expires = (Math.floor(now() / 1000) + config.turnCredentialTtlSeconds) * 1000;
        const username = config.turnAuthMode === 'static' ? config.turnUsername : `${expires / 1000}:${id.slice(0, 16)}`;
        const credential = config.turnAuthMode === 'static' ? config.turnPassword : createHmac('sha1', config.turnSecret).update(username).digest('base64');
        if (cache.size >= 4096) {
          sweep();
          if (cache.size >= 4096) {
            const oldest = [...cache.keys()].find((key) => !participants.some(({ id: participant }) => participant === key));
            cache.delete(oldest);
          }
        }
        cache.set(id, { expires, ice: { urls: config.turnUrls, username, credential } });
      }
      return participants.map(({ id }) => [...base, cache.get(id).ice]);
    }
  };
}
