// Shared egress guard for every tool that fetches a caller-supplied URL.
//
// Both the route detector and the browser take URLs from the agent, so both must
// refuse to become a network probe. Only public http(s) destinations are allowed.
//
// DOSSIER_ALLOW_ORIGINS is a deliberate, opt-in escape hatch for a demo employer
// the operator runs themselves. It is empty by default, it must name exact
// origins, and it is the only way a private address is ever reachable.

import { lookup } from 'node:dns/promises';
import net from 'node:net';

// Read at call time, not at import time. ES imports are hoisted and evaluated
// before any statement in the importing module, so snapshotting the environment
// here would ignore anything a caller sets before invoking us.
function allowed() {
  return new Set(
    (process.env.DOSSIER_ALLOW_ORIGINS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
}

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true;
  if (/^f[cd]/.test(v6)) return true;
  if (/^fe[89ab]/.test(v6)) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  return false;
}

export async function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('not a valid URL'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`blocked scheme: ${u.protocol}`);
  }
  if (allowed().has(u.origin)) return u; // explicitly allowed demo target

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('blocked address range');
    return u;
  }
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('blocked hostname');

  let addrs;
  try { addrs = await lookup(host, { all: true }); }
  catch { throw new Error('host does not resolve'); }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
    throw new Error('resolves to a blocked address range');
  }
  return u;
}

export function allowedOrigins() { return [...allowed()]; }
