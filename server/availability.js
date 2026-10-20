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
    const grouped = new Map();
    for (const budget of budgets) {
      const previous = grouped.get(budget.key);
      grouped.set(budget.key, { ...budget, cost: (previous?.cost || 0) + (budget.cost ?? 1) });
    }
    const entries = [...grouped.values()].map(({ key, burst, perMinute, cost }) => {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = { tokens: burst, updated: time };
        this.entries.set(key, entry);
      }
      entry.tokens = Math.min(burst, entry.tokens + Math.max(0, time - entry.updated) * perMinute / 60000);
      entry.updated = time;
      entry.expires = time + Math.max(60000, burst * 60000 / perMinute);
      return { entry, perMinute, cost };
    });
    const wait = Math.max(0, ...entries.map(({ entry, perMinute, cost }) => Math.ceil((cost - entry.tokens) * 60000 / perMinute)));
    if (!wait) {
      for (const { entry, cost } of entries) {
        entry.tokens -= cost;
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

export function connectionQuotas(config, requireThat, now = Date.now, retire) {
  let total = 0;
  let pending = 0;
  let guests = 0;
  const sources = new Map();
  const devices = new Map();
  const leases = new Set();
  const cooldowns = new Map();

  function sweep() {
    for (const [key, expires] of cooldowns) {
      if (expires <= now()) {
        cooldowns.delete(key);
      }
    }
  }

  function reclaim(phase, source, counts) {
    sweep();
    // Cooldown storage is bounded independently of the number of IPs seen.
    if (cooldowns.size >= config.maxConnections * 2) {
      return;
    }
    const candidates = [...leases].filter((lease) => {
      if (lease.phase !== phase || lease.closing || lease.socket.destroyed || now() - lease.opened < 2000) {
        return false;
      }
      if (phase === 'guest' && (!lease.ws || lease.ws.readyState !== 1 || lease.ws.guestClaims?.size)) {
        return false;
      }
      return lease.source !== source && lease.counts[phase] > counts[phase] + 1;
    });
    candidates.sort((a, b) => b.counts[phase] - a.counts[phase] || a.opened - b.opened);
    const victim = candidates[0];
    if (victim) {
      victim.closing = true;
      cooldowns.set(`${phase}:${victim.source}`, now() + 15000);
      if (phase === 'guest') {
        retire(victim.ws, 1000, 'Guest session idle');
      } else {
        victim.socket.destroy();
      }
    }
  }

  return {
    sweep,
    reserve(source, socket) {
      const counts = sources.get(source) || { total: 0, pending: 0, guest: 0 };
      requireThat(counts.total < config.maxConnectionsPerIp && counts.pending < config.maxPendingPerIp, 'RATE_LIMIT', 'Too many connections');
      requireThat((cooldowns.get(`pending:${source}`) || 0) <= now(), 'RATE_LIMIT', 'Too many connections');
      requireThat(total < config.maxConnections, 'BUSY', 'Too many connections');
      if (pending >= config.maxPendingConnections && config.pendingFairAdmission) {
        reclaim('pending', source, counts);
      }
      requireThat(pending < config.maxPendingConnections, 'BUSY', 'Too many connections');
      sources.set(source, counts);
      total += 1;
      pending += 1;
      counts.total += 1;
      counts.pending += 1;
      const lease = { source, socket, counts, phase: 'pending', opened: now(), closing: false, ws: null };
      leases.add(lease);
      let deviceId;
      let released = false;

      const identify = (next) => {
        requireThat(!released && !lease.closing && lease.phase === 'pending', 'INVALID', '已经建立会话');
        lease.phase = next;
        pending -= 1;
        counts.pending -= 1;
      };
      // Track the TCP socket, including failed upgrades and the close handshake.
      socket.once('close', () => {
        if (released) {
          return;
        }
        released = true;
        leases.delete(lease);
        total -= 1;
        counts.total -= 1;
        if (lease.phase === 'pending') {
          pending -= 1;
          counts.pending -= 1;
        } else if (lease.phase === 'guest') {
          guests -= 1;
          counts.guest -= 1;
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
        bind(ws) {
          lease.ws = ws;
        },
        checkDevice(id) {
          requireThat(!released && !lease.closing && lease.phase === 'pending', 'INVALID', '已经建立会话');
          requireThat((devices.get(id) || 0) < config.maxConnectionsPerDevice, 'BUSY', 'Too many connections');
        },
        device(id) {
          this.checkDevice(id);
          identify('device');
          deviceId = id;
          devices.set(id, (devices.get(id) || 0) + 1);
        },
        guest() {
          requireThat((cooldowns.get(`guest:${source}`) || 0) <= now(), 'RATE_LIMIT', 'Too many connections');
          if (guests >= config.maxGuestConnections && config.guestPreviewEnabled) {
            reclaim('guest', source, counts);
          }
          requireThat(guests < config.maxGuestConnections, 'BUSY', 'Too many connections');
          identify('guest');
          guests += 1;
          counts.guest += 1;
        }
      };
    }
  };
}
