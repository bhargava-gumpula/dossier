#!/usr/bin/env node
// jobs-mcp - job discovery and application-route analysis, exposed over MCP.
//
// TrueForge only connects to REMOTE MCP servers (HTTP URL, header auth or
// OAuth); there is no stdio transport. So a local capability gets in by
// listening on 127.0.0.1 and being registered by URL.
//
// Every tool here is annotated readOnlyHint:true / destructiveHint:false.
// That matters: TrueForge's default approval policy is ["@write","@destructive"]
// and an unannotated tool is treated as destructive, which would gate every
// single call and leave no single clean approval gate to demonstrate.

import { createServer } from 'node:http';
import { resolveCompany, greenhouseJobs, ashbyJobs, workdayJobs, boardFromUrl } from './lib/sources.js';
import { detectApplyRoute } from './lib/route.js';
import { searchJobs, scrapeBlocked, isSearchAvailable } from './lib/websearch.js';

const PORT = Number(process.env.JOBS_MCP_PORT ?? 8793);
const PROTOCOL_VERSION = '2025-06-18';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

const TOOLS = [
  {
    name: 'find_jobs',
    description:
      'Find live job postings at a company by name. Resolves the company to its ' +
      'public job board (Greenhouse, Ashby or Workday) and returns matching roles. ' +
      'Optionally filter by a role description such as "backend engineer".',
    annotations: { title: 'Find jobs', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name, e.g. "Ramp".' },
        role: { type: 'string', description: 'Optional role text to match, e.g. "backend engineer".' },
        limit: { type: 'integer', description: 'Max results (default 10).' },
      },
      required: ['company'],
    },
  },
  {
    name: 'search_jobs_on_web',
    description:
      'Find job postings by searching the open web. Use this when find_jobs ' +
      'reports no public job board - most large employers self-host their ' +
      'careers site and publish no machine-readable listing. Returns candidate ' +
      "job URLs on the employer's own domain or their applicant system, with " +
      'third-party aggregators excluded because a listing there is a copy, not ' +
      'the way the company asks to be applied to.',
    annotations: { title: 'Search the web for jobs', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        role: { type: 'string', description: 'Role text, e.g. "backend engineer".' },
        limit: { type: 'integer' },
      },
      required: ['company'],
    },
  },
  {
    name: 'fetch_blocked_page',
    description:
      'Fetch a page that ordinary requests cannot reach. Some careers sites ' +
      'refuse both a plain fetch and a real browser with a 403. Use this only ' +
      'after a normal attempt has failed. This is a paid fetch through a proxy ' +
      'service, not a CAPTCHA bypass.',
    annotations: { title: 'Fetch a blocked page', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'detect_apply_route',
    description:
      'Determine how a specific employer actually accepts applications, by ' +
      'fingerprinting the job\'s apply URL. Returns the platform, whether a ' +
      'CAPTCHA or account wall blocks automated submission, and whether the ' +
      'agent can legitimately complete this application by itself. ' +
      'Always call this on the apply URL, never on a careers landing page.',
    annotations: { title: 'Detect apply route', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        apply_url: { type: 'string', description: 'The job\'s apply URL.' },
      },
      required: ['apply_url'],
    },
  },
];

// ---------------------------------------------------------------- tool impls

function scoreTitle(title, role) {
  const t = title.toLowerCase();
  const words = role.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hits = words.filter((w) => t.includes(w)).length;
  return hits / words.length;
}

async function toolSearchJobsOnWeb({ company, role, limit = 8 }) {
  limit = clampLimit(limit, 8);
  if (!(await isSearchAvailable())) {
    return { error: 'web search is not configured. Run scripts/add-search-connector.sh.' };
  }
  const r = await searchJobs(company, role, { limit });
  return {
    ...r,
    note: r.jobs.length
      ? 'These are candidate URLs from the open web. Call detect_apply_route on ' +
        'the one you choose - searching found the page, it did not tell you how ' +
        'to apply.'
      : 'Search returned nothing usable on the employer\'s own domain.',
  };
}

async function toolFetchBlockedPage({ url }) {
  if (!(await isSearchAvailable())) {
    return { error: 'web search is not configured. Run scripts/add-search-connector.sh.' };
  }
  const r = await scrapeBlocked(url);
  return { ...r, chars: r.markdown.length };
}

async function toolFindJobs({ company, role, limit = 10 }) {
  limit = clampLimit(limit, 10);
  let r = await resolveCompany(company);

  if (!r.found) {
    // Direct board APIs are fast, free and exact, but they only cover employers
    // who publish a machine-readable board. For everyone else, search is how
    // this generalises - no per-employer integration required.
    const searchable = await isSearchAvailable();
    if (searchable) {
      const web = await searchJobs(company, role, { limit });

      // Search usually finds the board's INDEX rather than a posting - the
      // slug it was asked for did not match ("Crusoe Energy" resolves nothing,
      // but search finds jobs.ashbyhq.com/Crusoe). That index is a board this
      // already knows how to read, so it is turned back into real postings
      // instead of being handed over as a link for the human to click.
      for (const hit of web.jobs) {
        const board = await boardFromUrl(hit.url);
        if (board) { r = { found: true, company, viaSearch: true, ...board }; break; }
      }

      if (!r.found && web.jobs.length) {
        return {
          found: true,
          company,
          source: 'web-search',
          careers_url: r.careersUrl ?? null,
          total_matching: web.jobs.length,
          jobs: web.jobs,
          note:
            'This employer publishes no machine-readable job board, so these came ' +
            'from a web search of their own site. Call detect_apply_route on the ' +
            'URL you pick before doing anything else.',
        };
      }
    }
    if (!r.found) return {
      found: false,
      company,
      tried_slugs: r.triedSlugs,
      careers_url: r.careersUrl ?? null,
      reason: r.reason,
      note: searchable
        ? r.whatToDo ?? 'No board and no usable search results. Give me a job URL.'
        : 'No public job board found, and web search is not configured. ' +
          'Give me a job URL directly, or run scripts/add-search-connector.sh.',
    };
  }

  let jobs = r.jobs;
  if (role) {
    jobs = jobs
      .map((j) => ({ j, s: scoreTitle(j.title, role) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ ...x.j, match: Number(x.s.toFixed(2)) }));
  }

  const total = jobs.length;
  return {
    found: true,
    company,
    source: r.source,
    board: r.board,
    total_matching: total,
    ambiguous: Boolean(role) && total > 1,
    jobs: jobs.slice(0, clampLimit(limit)),
    ...(r.incomplete ? { incomplete: true, incomplete_note: r.note } : {}),
    note:
      Boolean(role) && total > 1
        ? 'Several roles matched. Present these to the human and let them pick ' +
          'rather than guessing - applying to the wrong requisition is not recoverable.'
        : undefined,
  };
}

async function toolDetectApplyRoute({ apply_url }) {
  return detectApplyRoute(apply_url);
}

const IMPL = {
  find_jobs: toolFindJobs,
  search_jobs_on_web: toolSearchJobsOnWeb,
  fetch_blocked_page: toolFetchBlockedPage,
  detect_apply_route: toolDetectApplyRoute,
};

// ------------------------------------------------------------- MCP transport

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg) {
  // A bare `null` or a JSON scalar is valid JSON but not a JSON-RPC message.
  // Destructuring it throws inside Promise.all, which surfaces as an unhandled
  // rejection and can take the process down instead of returning an error.
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id = null, method, params } = msg;
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request: missing method');
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dossier-jobs', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null; // notifications get no response
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const fn = IMPL[name];
    if (!fn) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      const out = await fn(params?.arguments ?? {});
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
        isError: false,
      });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Tool ${name} failed: ${err.message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

// A negative limit turns slice(0, n) into "everything except the last n", so a
// caller asking for -1 results got nearly all of them. Anything not a sane
// positive integer falls back to the documented default.
//
// The ceiling is high because a caller that means to rank a board itself needs
// the whole board: the postings arrive in board order, so a low cap hands back
// an alphabetical slice - Anthropic's first 200 of 571 reach "H" and contain a
// single "Software Engineer". The default stays small, so this only affects a
// caller that explicitly asks for more.
function clampLimit(n, fallback = 10) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), 1000);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // destroy() alone emits neither 'end' nor, reliably, 'error', so the promise
    // it was supposed to guard never settled and the request hung for ever.
    // Reject explicitly, and treat an early close as a failure too.
    req.on('data', (c) => {
      data += c;
      if (data.length > 4e6) { req.destroy(); reject(new Error('request body too large')); }
    });
    req.on('close', () => reject(new Error('connection closed before the body arrived')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, server: 'dossier-jobs', tools: TOOLS.map((t) => t.name) }));
  }

  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
  }

  const batch = Array.isArray(payload) ? payload : [payload];
  let out;
  try {
    out = (await Promise.all(batch.map((m) => handleRpc(m)))).filter(Boolean);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32603, `Internal error: ${err.message}`)));
  }

  if (!out.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(payload) ? out : out[0]));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dossier-jobs MCP on http://127.0.0.1:${PORT}/mcp`);
  console.log(`health: http://127.0.0.1:${PORT}/health`);
});
