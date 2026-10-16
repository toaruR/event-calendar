import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { AppError } from '../errors.ts';

export type Resolver = (host: string) => Promise<string[]>;

export interface SsrfOptions {
  resolve?: Resolver;
  allowlist?: string[];
}

export const defaultResolve: Resolver = async (host) => {
  const r = await lookup(host, { all: true });
  return r.map((x) => x.address);
};

function blocked(msg: string, details: unknown = {}): AppError {
  return new AppError('SSRF_BLOCKED', msg, details);
}

export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16), lo = parseInt(mappedHex[2]!, 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ''));
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

/** Throws AppError(SSRF_BLOCKED) unless url is http(s) and every resolved IP is public (or host is allowlisted). */
export async function assertUrlAllowed(url: string, opts: SsrfOptions = {}): Promise<URL> {
  let u: URL;
  try { u = new URL(url); } catch { throw blocked('invalid url', { url }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw blocked(`scheme not allowed: ${u.protocol}`, { url });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw blocked('empty host', { url });
  const allow = (opts.allowlist ?? []).map((h) => h.toLowerCase());
  if (allow.includes(host)) return u;
  const addrs = isIP(host) ? [host] : await (opts.resolve ?? defaultResolve)(host).catch(() => {
    throw blocked('dns resolution failed', { host });
  });
  if (addrs.length === 0) throw blocked('no address', { host });
  for (const a of addrs) {
    if (isPrivateIp(a)) throw blocked('address not allowed', { host, address: a });
  }
  return u;
}
