// Web search, via Bright Data's MCP, proxied through our own server.
//
// Why proxy rather than let TrueForge connect directly: Bright Data speaks
// session-based streamable HTTP - initialize returns an SSE-framed response
// carrying an mcp-session-id header, and every later call must send it back.
// TrueForge does not carry that session through, so a direct connector times
// out after 30s on both transports rather than failing fast. Verified.
//
// The token is read from TrueForge's own settings so it lives in exactly one
// place and never appears in this repo or in a second config file.

import { assertAllowedUrl, guardedDispatcher } from './net-guard.js';

const TF = (process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790') + '/api/v1';
const BD_URL = 'https://mcp.brightdata.com/mcp';

let cached = { token: null, session: null, at: 0 };

async function brightDataToken() {
  if (cached.token) return cached.token;
  if (process.env.BRIGHTDATA_TOKEN) {
    cached.token = process.env.BRIGHTDATA_TOKEN;
    return cached.token;
  }
  try {
    const res = await fetch(`${TF}/settings/mcp-servers/bright-data`);
    if (!res.ok) return null;
    const body = await res.json();
    const url = (body.data ?? body).manifest?.url ?? '';
    const token = new URL(url).searchParams.get('token');
    cached.token = token;
    return token;
  } catch { return null; }
}

// Bright Data frames responses as SSE even for single replies.
function parseFramed(text) {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line) return JSON.parse(line.slice(6));
  return JSON.parse(text);
}

async function rpc(method, params, session, token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(`${BD_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  return { res, body: text ? parseFramed(text) : null };
}

async function session(token) {
  // Sessions expire; re-handshake if the last one is older than ten minutes.
  if (cached.session && Date.now() - cached.at < 10 * 60 * 1000) return cached.session;
  const { res } = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dossier', version: '0.1.0' },
  }, null, token);
  const sid = res.headers.get('mcp-session-id');
  if (!sid) throw new Error('Bright Data did not return a session id');
  cached.session = sid;
  cached.at = Date.now();
  return sid;
}

export async function isSearchAvailable() {
  return Boolean(await brightDataToken());
}

async function callTool(name, args) {
  const token = await brightDataToken();
  if (!token) throw new Error('no Bright Data token configured');
  const sid = await session(token);
  const { body } = await rpc('tools/call', { name, arguments: args }, sid, token);
  if (body?.error) {
    // A stale session is the common failure; drop it and retry once.
    cached.session = null;
    const sid2 = await session(token);
    const retry = await rpc('tools/call', { name, arguments: args }, sid2, token);
    if (retry.body?.error) throw new Error(retry.body.error.message ?? 'search failed');
    return retry.body.result;
  }
  return body?.result;
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// Search the open web for a job. This is what makes discovery general: search
// engines already crawled every careers site, so no per-employer integration is
// needed for the long tail.
// Job boards run by someone other than the employer. A listing here is a copy,
// often stale, and applying through it is not "the way the company asks" - so
// they are dropped rather than ranked down.
const AGGREGATORS =
  /linkedin\.com|indeed\.|glassdoor\.|ziprecruiter\.|monster\.|simplyhired|dice\.com|builtin\.|wellfound|angel\.co|jobs?\.google|talent\.com|jooble|lensa|adzuna|snagajob|careerbuilder/i;

const BOARDS =
  /greenhouse\.io|ashbyhq|myworkdayjobs|jobvite|lever\.co|smartrecruiters|icims|workable|teamtailor|recruitee|phenompeople|eightfold|avature|taleo|successfactors/i;

export async function searchJobs(company, role, { limit = 8 } = {}) {
  const query = `${company} ${role ?? ''} job opening apply`.replace(/\s+/g, ' ').trim();
  const result = await callTool('search_engine', { query, engine: 'google' });
  const text = textOf(result);

  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const urlRe = /https?:\/\/[^\s)"'\]]+/g;
  const seen = new Set();
  const scored = [];

  for (const raw of text.match(urlRe) ?? []) {
    const url = raw.replace(/[.,;]+$/, '');
    if (seen.has(url)) continue;
    if (AGGREGATORS.test(url)) continue; // a copy of the posting, not the source

    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }

    const onBoard = BOARDS.test(url);
    const ownDomain = host.replace(/^www\./, '').split('.')[0] === slug
                   || host.includes(`${slug}.`);
    const jobShaped = /\/job[s]?\/|\/careers?\/|jobid=|\/position|\/opening|\/apply/i.test(url);

    if (!onBoard && !ownDomain) continue;      // must be the employer or their board
    if (!jobShaped && !onBoard) continue;      // and must look like a posting

    // A specific posting beats a listing index: prefer long, id-bearing paths.
    const specific = /[a-f0-9]{8,}|_[A-Za-z0-9]{6,}|\/\d{5,}/.test(url) ? 2 : 0;
    seen.add(url);
    scored.push({
      source: 'web-search',
      url,
      onEmployerDomain: ownDomain,
      onKnownBoard: onBoard,
      score: specific + (onBoard ? 1 : 0) + (ownDomain ? 1 : 0),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  // A search result is a URL and nothing else, so without this every posting
  // found this way reached the UI named after its own href - the picker listed
  // links instead of jobs. The page's own <title> is the name the employer
  // gave the role, and reading it is one plain HTTP GET per candidate: no
  // search-provider call, so this costs nothing beyond the request itself.
  await Promise.allSettled(top.map(async (j) => {
    j.title = await pageTitle(j.url) ?? titleFromUrl(j.url);
  }));

  return { query, jobs: top, rawChars: text.length };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e) => ENTITIES[e])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Read a posting's own title. Never throws - an unreachable page just has no
 *  title, and the caller falls back to the URL. */
export async function pageTitle(url) {
  try {
    await assertAllowedUrl(url);
    const res = await fetch(url, {
      dispatcher: guardedDispatcher,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    // Titles live in <head>; there is no reason to buffer a whole careers page.
    const html = (await res.text()).slice(0, 80_000);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const raw = og?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    // og:title is usually the cleanest, but some boards set it to their own
    // name ("Jobvite"), so both candidates are considered and the better one
    // wins rather than trusting a fixed order.
    const cands = [og?.[1], html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]]
      .filter(Boolean).map((c) => cleanTitle(decode(c))).filter(Boolean);
    if (!cands.length) return null;
    const best = cands.sort((a, b) => scoreTitleText(b) - scoreTitleText(a))[0];
    // A page that only ever says "Jobvite" or "Careers" has not named the role,
    // and the URL is a better guess than the board's own name.
    return scoreTitleText(best) > 0 ? best : null;
  } catch {
    return null;
  }
}

// Board and careers-site furniture, not the name of a role.
const BOILERPLATE =
  /^(?:careers?|jobs?|job search|openings?|apply|home|login|sign in|jobvite|greenhouse|ashby|workday|lever|smartrecruiters|workable|icims)\b/i;

const ROLE_WORDS =
  /engineer|developer|architect|scientist|analyst|manager|designer|director|specialist|associate|consultant|coordinator|representative|recruiter|accountant|technician|lead\b|intern\b|counsel|president|officer|administrator|operator|writer|marketer|strategist/i;

/** How much a string reads like the name of a job rather than a website. */
function scoreTitleText(t) {
  const wordCount = t.split(/\s+/).length;
  let s = wordCount;
  if (ROLE_WORDS.test(t)) s += 6;
  if (BOILERPLATE.test(t) && wordCount <= 3) s -= 8;
  if (t.length < 4) s -= 8;
  return s;
}

/** Page titles carry the employer and the board as well as the role, and the
 *  order is not consistent - Greenhouse leads with the role, Jobvite leads with
 *  the company - so the best-looking segment is chosen, not the first. */
function cleanTitle(s) {
  let t = s.replace(/\s+/g, ' ').trim();
  // Greenhouse renders "Job Application for <role> at <company>".
  t = t.replace(/^job application for\s+/i, '').replace(/\s+at\s+[^,|–—-]+$/i, '');
  // Jobvite renders "<company> is looking for <role>."
  t = t.replace(/^.{1,40}?\s+is\s+(?:looking for|hiring(?:\s+an?|\s+for)?)\s+/i, '')
       .replace(/\.\s*$/, '');
  // Ashby renders "<role> @ <company>". The company is already known here.
  t = t.replace(/\s+@\s+[^@|–—]+$/, '');

  const parts = t.split(/\s+[|–—·]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const best = parts.slice().sort((a, b) => scoreTitleText(b) - scoreTitleText(a))[0];
    if (best.length >= 4) t = best;
  }
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/** Last resort: recover something readable from the URL itself. */
export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const words = decodeURIComponent(seg)
      .replace(/\.(html?|aspx?|php)$/i, '')
      .replace(/[_-]+/g, ' ')
      // Requisition ids and uuids are not part of the name.
      .replace(/\b[0-9a-f]{8,}\b/gi, '')
      .replace(/\b(?:R|REQ|JR)\d{3,}\b/gi, '')
      .replace(/\b\d{4,}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (words.length >= 4) {
      return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    }
    return `Posting on ${u.hostname.replace(/^www\./, '')}`;
  } catch {
    return url;
  }
}

// Fetch a page that ordinary requests cannot reach. Tesla's careers site returns
// 403 to both fetch and headless Chromium; this is the only way through, and it
// is a legitimate fetch through a service the operator pays for - not a CAPTCHA
// bypass and not an attempt to look like a different browser.
export async function scrapeBlocked(url) {
  const result = await callTool('scrape_as_markdown', { url });
  return { url, markdown: textOf(result) };
}
