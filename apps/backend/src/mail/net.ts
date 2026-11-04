import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Config } from '../lib/config.js';
import { mailError } from './errors.js';

export const MAIL_PORTS = new Set([143, 993, 25, 465, 587, 2525]);

/** True for loopback, private, link-local, CGNAT, multicast, reserved and cloud-metadata ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6) || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8');
}

export interface ResolvedTarget {
  host: string;   // what the user typed (used for TLS SNI and certificate checks)
  address: string; // the vetted IP we actually connect to
  port: number;
}

/**
 * Resolves a user-supplied mail server and refuses private addresses and non-mail ports,
 * so the platform cannot be used to probe internal networks. We connect to the vetted IP
 * (not the name again) so a second DNS answer cannot redirect the connection.
 */
export async function resolveMailHost(cfg: Config, host: string, port: number, stage: 'imap' | 'smtp'): Promise<ResolvedTarget> {
  const clean = host.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(clean) && !isIP(clean)) throw mailError('HOST_NOT_FOUND', stage, host, port);
  if (!MAIL_PORTS.has(port) && !cfg.mail.allowPrivateHosts) throw mailError('PORT_NOT_ALLOWED', stage, host, port);
  let addresses: { address: string }[];
  try {
    addresses = isIP(clean) ? [{ address: clean }] : await lookup(clean, { all: true });
  } catch {
    throw mailError('HOST_NOT_FOUND', stage, host, port);
  }
  const allowed = addresses.filter((a) => cfg.mail.allowPrivateHosts || !isPrivateAddress(a.address));
  if (!allowed.length) throw mailError('BLOCKED_ADDRESS', stage, host, port);
  // Prefer IPv4: many shared hosts have no working IPv6 route.
  const pick = allowed.find((a) => isIP(a.address) === 4) ?? allowed[0]!;
  return { host: clean, address: pick.address, port };
}
