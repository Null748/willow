import dns from 'node:dns/promises';
import net from 'node:net';

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function blockedV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224
  );
}

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return blockedV4(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return blockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^(fc|fd|fe[89ab])/.test(l);
  }
  return true;
}

/** Parses a URL and makes sure it points at the public internet (SSRF guard). */
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'Only http and https addresses can be opened.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw httpError(403, 'That address is not allowed.');
  }
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw httpError(502, 'Could not find that site.');
    }
  }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
    throw httpError(403, 'That address is not allowed.');
  }
  return url;
}
