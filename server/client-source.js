import { BlockList, isIP } from 'node:net';

// Normalize mapped IPv4 before both CIDR matching and source quota aggregation.
export function normalizeAddress(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) {
    return null;
  }
  if (isIP(value) === 4) {
    return value;
  }
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const a = parseInt(mapped[1], 16);
    const b = parseInt(mapped[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return canonical;
}

export function trustedNetworks(cidrs) {
  const list = new BlockList();
  if (!Array.isArray(cidrs) || cidrs.length > 128) {
    throw new Error('TRUSTED_PROXY_CIDRS is invalid');
  }
  for (const cidr of cidrs) {
    const match = typeof cidr === 'string' && /^([^/]+)\/(\d{1,3})$/.exec(cidr);
    const address = match && normalizeAddress(match[1]);
    let prefix = match ? Number(match[2]) : -1;
    if (address && isIP(match[1]) === 6 && isIP(address) === 4) {
      prefix -= 96;
    }
    const bits = isIP(address || '') === 4 ? 32 : 128;
    if (!address || prefix < 0 || prefix > bits) {
      throw new Error('TRUSTED_PROXY_CIDRS is invalid');
    }
    list.addSubnet(address, prefix, bits === 32 ? 'ipv4' : 'ipv6');
  }
  return (address) => list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

export function clientSource(config) {
  const trusted = trustedNetworks(config.trustedProxyCidrs);
  if (config.trustProxy && !config.trustedProxyCidrs.length) {
    throw new Error('TRUST_PROXY requires TRUSTED_PROXY_CIDRS');
  }
  return (remote, forwarded) => {
    const peer = normalizeAddress(remote);
    if (!peer || !config.trustProxy || !trusted(peer) || forwarded === undefined) {
      return peer;
    }
    if (typeof forwarded !== 'string' || forwarded.length > 1024) {
      return null;
    }
    const parts = forwarded.split(',');
    if (!parts.length || parts.length > 16) {
      return null;
    }
    const chain = parts.map((part) => normalizeAddress(part.trim()));
    if (chain.some((address) => !address)) {
      return null;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (!trusted(chain[i])) {
        return chain[i];
      }
    }
    return null;
  };
}
