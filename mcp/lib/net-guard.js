// Shared egress guard for every tool that fetches a caller-supplied URL.
//
// Both the route detector and the browser take URLs from the agent, so both must
// refuse to become a network probe. Only public http(s) destinations are allowed.
//
// DOSSIER_ALLOW_ORIGINS is a deliberate, opt-in escape hatch for a demo employer
// the operator runs themselves. It is empty by default, it must name exact
// origins, and it is the only way a private address is ever reachable.

import { lookup } from 'node:dns/promises';
import { lookup as lookupCb } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

// Read at call time, not at import time. ES imports are hoisted and evaluated
// before any statement in the importing module, so snapshotting the environment
// here would ignore anything a caller sets before invoking us.
function allowed() {
  return new Set(
    (process.env.DOSSIER_ALLOW_ORIGINS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
}

const DNS_TIMEOUT_MS = 5000;

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

  // The resolver gets its own deadline. Callers put an AbortSignal on fetch, but
  // that signal does not cover this lookup, so a resolver that simply never
  // answers used to hang the whole tool well past its advertised timeout.
  let addrs;
  try {
    addrs = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), DNS_TIMEOUT_MS)),
    ]);
  } catch (err) {
    throw new Error(err.message === 'dns timeout' ? 'host did not resolve in time' : 'host does not resolve');
  }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
    throw new Error('resolves to a blocked address range');
  }
  return u;
}

// Checking a name here and letting fetch resolve it again at connect time is a
// gap, not a guard: a hostname under someone else's control can answer with a
// public address for the check and a private one microseconds later, and the
// connection goes wherever the second answer points. Closing that means the
// address the socket actually uses has to be the one that was vetted, so the
// check moves into the connection itself.
//
// A literal IP never reaches this - the runtime dials it directly - which is
// why an explicitly allowed origin such as the demo employer on 127.0.0.1 still
// connects: assertAllowedUrl has already approved it by origin.
function guardedLookup(hostname, options, callback) {
  lookupCb(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const bad = list.find((a) => isBlockedIp(a.address));
    if (bad) return callback(new Error(`blocked address range: ${bad.address}`));
    return callback(null, address, family);
  });
}

// Use this dispatcher for any fetch that takes a caller-supplied URL.
export const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

export function allowedOrigins() { return [...allowed()]; }
