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
import { resolveCompany, greenhouseJobs, ashbyJobs, workdayJobs } from './lib/sources.js';
import { detectApplyRoute } from './lib/route.js';

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

async function toolFindJobs({ company, role, limit = 10 }) {
  const r = await resolveCompany(company);
  if (!r.found) {
    return {
      found: false,
      company,
      tried_slugs: r.triedSlugs,
      note:
        'No public job board found for this company on Greenhouse, Ashby or ' +
        'Workday. It may use a bespoke careers site - supply a job URL directly ' +
        'and use detect_apply_route on it.',
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
    jobs: jobs.slice(0, limit),
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

const IMPL = { find_jobs: toolFindJobs, detect_apply_route: toolDetectApplyRoute };

// ------------------------------------------------------------- MCP transport

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg) {
  const { id, method, params } = msg;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
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
  const out = (await Promise.all(batch.map(handleRpc))).filter(Boolean);

  if (!out.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(payload) ? out : out[0]));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dossier-jobs MCP on http://127.0.0.1:${PORT}/mcp`);
  console.log(`health: http://127.0.0.1:${PORT}/health`);
});
