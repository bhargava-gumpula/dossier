#!/usr/bin/env node
// Dashboard backend.
//
// Two jobs. It owns the application queue (TrueForge has sessions, not a job
// list, so the mapping job -> session lives here). And it proxies TrueForge,
// which serves no CORS headers, so a browser cannot call it directly.
//
// Approving here is not a UI convention: it releases a real tool call that the
// harness is genuinely holding, via user.tool_approval.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.DASHBOARD_PORT ?? 5174);
const TF = (process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790') + '/api/v1';
const QUEUE = `${HERE}/queue.json`;
const PROFILE = process.env.DOSSIER_PROFILE ?? `${ROOT}/fixtures/persona/profile.json`;
const AGENT = 'dossier';

// ------------------------------------------------------------------- storage
function loadQueue() {
  if (!existsSync(QUEUE)) return { jobs: [] };
  try { return JSON.parse(readFileSync(QUEUE, 'utf8')); } catch { return { jobs: [] }; }
}
function saveQueue(q) { writeFileSync(QUEUE, JSON.stringify(q, null, 2)); }

// ------------------------------------------------------------------ trueforge
async function tf(method, path, body) {
  const res = await fetch(TF + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error?.message ?? `${res.status} on ${path}`);
  return json;
}

// Derive what the human needs to see from the session's latest turn.
async function jobLive(job) {
  if (!job.sessionId) return { status: job.status ?? 'found' };
  let turns;
  try { turns = (await tf('GET', `/sessions/${job.sessionId}/turns`)).data ?? []; }
  catch { return { status: job.status ?? 'unknown', error: 'session unreachable' }; }
  if (!turns.length) return { status: 'starting' };

  const latest = turns[turns.length - 1];
  const state = latest.state ?? {};
  const required = state.required_actions ?? [];
  const pending = required[0] ?? null;

  let events = [];
  try { events = (await tf('GET', `/sessions/${job.sessionId}/turns/${latest.id}/events`)).data ?? []; }
  catch { /* events are best-effort */ }

  const steps = [];
  let question = null;
  let approval = null;
  for (const entry of events) {
    const ev = entry.event ?? entry;
    for (const c of ev.tool_calls ?? []) {
      const fn = c.function?.name;
      if (!fn || ['list_tools', 'get_tool_info', 'get_tool_output_schema'].includes(fn)) continue;
      let label = fn;
      let args = {};
      try { args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments) : (c.function.arguments ?? {}); } catch {}
      if (fn === 'call_tool') label = args.tool_name ?? 'call_tool';
      if (fn === 'exec') label = 'sandbox: ' + (args.intent ?? 'ran code').slice(0, 60);
      if (fn === 'ask_user_question') {
        label = 'asked you a question';
        question = { toolCallId: c.id, text: args.question ?? '', options: args.options ?? [] };
      }
      steps.push({ label, id: c.id });
      if (label === 'submit_form') approval = { toolCallId: c.id, args };
    }
  }

  let status = state.status === 'running' ? 'working' : (job.status ?? 'idle');
  if (pending?.type === 'tool.approval_required') status = 'awaiting-approval';
  else if (pending?.type === 'tool.response_required') status = 'needs-answer';
  else if (state.status === 'done') status = job.submitted ? 'submitted' : 'ready';

  const content = state.output?.content;
  const output = Array.isArray(content)
    ? content.map((b) => b.text ?? '').join('')
    : (content ?? '');

  return {
    status,
    turnId: latest.id,
    threadId: pending?.thread_id ?? 'main',
    pendingType: pending?.type ?? null,
    pendingToolCallId: pending?.tool_calls?.[0]?.id ?? null,
    question,
    approval,
    steps,
    output,
  };
}

// ---------------------------------------------------------------- api handlers
const api = {
  async 'GET /api/state'() {
    const q = loadQueue();
    const jobs = await Promise.all(q.jobs.map(async (j) => ({ ...j, live: await jobLive(j) })));
    const profile = existsSync(PROFILE) ? JSON.parse(readFileSync(PROFILE, 'utf8')) : null;
    if (profile) delete profile._comment;
    return { jobs, profile };
  },

  async 'POST /api/jobs'(body) {
    const q = loadQueue();
    const job = {
      id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      query: body.query ?? null,
      url: body.url ?? null,
      title: body.title ?? body.query ?? body.url,
      company: body.company ?? null,
      status: 'found',
      addedAt: new Date().toISOString(),
    };
    q.jobs.unshift(job);
    saveQueue(q);
    return { job };
  },

  async 'POST /api/jobs/start'(body) {
    const q = loadQueue();
    const job = q.jobs.find((j) => j.id === body.id);
    if (!job) throw new Error('unknown job');
    const session = (await tf('POST', '/sessions', { agent: { name: AGENT } })).data;
    job.sessionId = session.id;
    job.status = 'working';
    saveQueue(q);

    const ask = job.url
      ? `Apply for me to this job: ${job.url}\n\nGet the candidate profile, detect the apply route, inspect the form, fill every field, then submit if the route permits it.`
      : `Find and apply to: ${job.query}\n\nUse find_jobs first. If several roles match, ask me which one. Then detect the route, inspect the form, fill it, and submit if the route permits it.`;

    // Fire the turn but do not block the request on it.
    tf('POST', `/sessions/${session.id}/turns`, {
      input: [{ type: 'user.message', content: ask }], stream: false,
    }).catch(() => {});
    return { started: true, sessionId: session.id };
  },

  async 'POST /api/jobs/answer'(body) {
    const q = loadQueue();
    const job = q.jobs.find((j) => j.id === body.id);
    if (!job?.sessionId) throw new Error('job not started');
    await tf('POST', `/sessions/${job.sessionId}/turns`, {
      input: [{
        type: 'user.tool_response',
        thread_id: body.threadId ?? 'main',
        tool_call_id: body.toolCallId,
        content: body.content,
      }],
      stream: false,
    });
    return { answered: true };
  },

  // Releases the real held tool call. This is the gate.
  async 'POST /api/jobs/approve'(body) {
    const q = loadQueue();
    const job = q.jobs.find((j) => j.id === body.id);
    if (!job?.sessionId) throw new Error('job not started');
    await tf('POST', `/sessions/${job.sessionId}/turns`, {
      input: [{
        type: 'user.tool_approval',
        thread_id: body.threadId ?? 'main',
        tool_call_id: body.toolCallId,
        approval: { status: 'allow' },
      }],
      stream: false,
    });
    job.submitted = true;
    saveQueue(q);
    return { approved: true };
  },

  async 'POST /api/jobs/deny'(body) {
    const q = loadQueue();
    const job = q.jobs.find((j) => j.id === body.id);
    if (!job?.sessionId) throw new Error('job not started');
    await tf('POST', `/sessions/${job.sessionId}/turns`, {
      input: [{
        type: 'user.tool_approval',
        thread_id: body.threadId ?? 'main',
        tool_call_id: body.toolCallId,
        approval: { status: 'deny', reason: body.reason ?? 'denied by user' },
      }],
      stream: false,
    });
    return { denied: true };
  },

  async 'POST /api/jobs/remove'(body) {
    const q = loadQueue();
    q.jobs = q.jobs.filter((j) => j.id !== body.id);
    saveQueue(q);
    return { removed: true };
  },

  // Resume editing: runs a turn against the same agent, which owns update_profile.
  async 'POST /api/profile/prompt'(body) {
    const session = (await tf('POST', '/sessions', { agent: { name: AGENT } })).data;
    const turn = await tf('POST', `/sessions/${session.id}/turns`, {
      input: [{
        type: 'user.message',
        content:
          `Update my resume: ${body.prompt}\n\n` +
          'Use update_profile with structured edits. Only make the changes I asked for. ' +
          'Then tell me exactly what changed.',
      }],
      stream: false,
    });
    return { sessionId: session.id, turnId: turn.data.id };
  },

  async 'GET /api/profile/status'(_, url) {
    const sessionId = url.searchParams.get('session');
    const turnId = url.searchParams.get('turn');
    if (!sessionId || !turnId) throw new Error('session and turn required');
    const t = (await tf('GET', `/sessions/${sessionId}/turns/${turnId}`)).data;
    const content = t.state?.output?.content;
    return {
      status: t.state?.status,
      output: Array.isArray(content) ? content.map((b) => b.text ?? '').join('') : (content ?? ''),
    };
  },
};

// ------------------------------------------------------------------- transport
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function body(req) {
  return new Promise((res, rej) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 5e6) req.destroy(); });
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { res({}); } });
    req.on('error', rej);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  if (api[key]) {
    try {
      const out = await api[key](req.method === 'GET' ? null : await body(req), url);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // static: built frontend, falling back to index.html for client routing
  const dist = `${HERE}/dist`;
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  let path = `${dist}${file}`;
  if (!existsSync(path)) path = `${dist}/index.html`;
  if (!existsSync(path)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('dashboard not built yet - run: npm run build --prefix dashboard');
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
  res.end(readFileSync(path));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`dossier dashboard on http://127.0.0.1:${PORT}`);
});
