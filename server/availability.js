import { isIP } from 'node:net';

// IPv4-mapped addresses share one budget with IPv4. IPv6 privacy addresses in
// one /64 share a budget so rotating interface identifiers cannot evade it.
export function sourceKey(address) {
  if (isIP(address) === 4) {
    return address;
  }
  if (isIP(address) !== 6) {
    return null;
  }
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const parts = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const words = parts.map((part) => parseInt(part, 16));
  if (words.slice(0, 5).every((part) => part === 0) && words[5] === 65535) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return `${words.slice(0, 4).map((part) => part.toString(16)).join(':')}::/64`;
}

export class TokenBuckets {
  constructor(now) {
    this.now = now;
    this.entries = new Map();
  }

  // Check all budgets before spending any tokens. A rejected IP budget must
  // not consume a device's tokens while the client waits to retry.
  take(budgets) {
    const time = this.now();
    const entries = budgets.map(({ key, burst, perMinute }) => {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = { tokens: burst, updated: time };
        this.entries.set(key, entry);
      }
      entry.tokens = Math.min(burst, entry.tokens + Math.max(0, time - entry.updated) * perMinute / 60000);
      entry.updated = time;
      entry.expires = time + Math.max(60000, burst * 60000 / perMinute);
      return { entry, perMinute };
    });
    const wait = Math.max(0, ...entries.map(({ entry, perMinute }) => Math.ceil((1 - entry.tokens) * 60000 / perMinute)));
    if (!wait) {
      for (const { entry } of entries) {
        entry.tokens -= 1;
      }
    }
    return wait;
  }

  sweep() {
    for (const [key, entry] of this.entries) {
      if (this.now() >= entry.expires) {
        this.entries.delete(key);
      }
    }
  }
}

export function connectionQuotas(config, requireThat) {
  let total = 0;
  let pending = 0;
  let guests = 0;
  const sources = new Map();
  const devices = new Map();

  return {
    reserve(source, socket) {
      const counts = sources.get(source) || { total: 0, pending: 0 };
      requireThat(total < config.maxConnections && pending < config.maxPendingConnections, 'BUSY', 'Too many connections');
      requireThat(counts.total < config.maxConnectionsPerIp && counts.pending < config.maxPendingPerIp, 'RATE_LIMIT', 'Too many connections');
      sources.set(source, counts);
      total += 1;
      pending += 1;
      counts.total += 1;
      counts.pending += 1;
      let phase = 'pending';
      let deviceId;
      let released = false;

      const identify = (next) => {
        requireThat(!released && phase === 'pending', 'INVALID', '已经建立会话');
        phase = next;
        pending -= 1;
        counts.pending -= 1;
      };
      // Track the TCP socket, including failed upgrades and the close handshake.
      socket.once('close', () => {
        if (released) {
          return;
        }
        released = true;
        total -= 1;
        counts.total -= 1;
        if (phase === 'pending') {
          pending -= 1;
          counts.pending -= 1;
        } else if (phase === 'guest') {
          guests -= 1;
        } else {
          const count = devices.get(deviceId) - 1;
          if (count) {
            devices.set(deviceId, count);
          } else {
            devices.delete(deviceId);
          }
        }
        if (!counts.total) {
          sources.delete(source);
        }
      });
      return {
        device(id) {
          requireThat((devices.get(id) || 0) < config.maxConnectionsPerDevice, 'BUSY', 'Too many connections');
          identify('device');
          deviceId = id;
          devices.set(id, (devices.get(id) || 0) + 1);
        },
        guest() {
          requireThat(guests < config.maxGuestConnections, 'BUSY', 'Too many connections');
          identify('guest');
          guests += 1;
        }
      };
    }
  };
}
