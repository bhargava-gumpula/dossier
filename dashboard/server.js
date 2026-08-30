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
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { extractText, storeUpload, skimResume } from '../mcp/lib/resume-intake.js';
import { rankPositions } from './match.js';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.DASHBOARD_PORT ?? 5174);
const TF = (process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790') + '/api/v1';
const QUEUE = `${HERE}/queue.json`;
const PROFILE = process.env.DOSSIER_PROFILE ?? `${ROOT}/fixtures/persona/profile.json`;
const RESUME = process.env.DOSSIER_RESUME ?? `${ROOT}/fixtures/persona/resume.pdf`;
const AGENT = 'dossier';
const JOBS_MCP = `http://127.0.0.1:${process.env.JOBS_MCP_PORT ?? 8793}/mcp`;

async function mcpCall(url, name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result?.structuredContent ?? j.result;
}

// ------------------------------------------------------------------- storage
function loadQueue() {
  if (!existsSync(QUEUE)) return { jobs: [] };
  try { return JSON.parse(readFileSync(QUEUE, 'utf8')); } catch { return { jobs: [] }; }
}
function saveQueue(q) { writeFileSync(QUEUE, JSON.stringify(q, null, 2)); }

// Every mutation loads the whole queue and writes the whole queue back. That is
// fine one at a time and lossy in parallel: "Start all" fires its requests
// together, each reads the same queue, and the last write erases the sessionIds
// the others just recorded - leaving live TrueForge sessions with no job
// pointing at them. Mutations are serialised so each one reads what the previous
// one wrote. Reads that do not write are left alone.
let queueLock = Promise.resolve();
function withQueue(fn) {
  const run = queueLock.then(() => fn(), () => fn());
  queueLock = run.then(() => {}, () => {});
  return run;
}

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
  let resumePath = null;
  let tailoring = null;
  let submitResult = null;
  let fillResult = null;
  let turnError = null;
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
    // tailor_resume reports the PDF that will actually be attached.
    const payload = ev.content ?? ev.output;
    // submit_form's own verdict, read straight off its response.
    if (payload && typeof payload === 'string'
        && (payload.includes('would_have_submitted_to') || payload.includes('"submitted"'))) {
      try {
        const parsed = JSON.parse(payload);
        if (typeof parsed.submitted === 'boolean') {
          submitResult = { submitted: parsed.submitted, wall: parsed.wall ?? null,
                           error: parsed.error ?? null, mode: parsed.mode ?? null };
        }
      } catch { /* not the response we're after */ }
    }
    // fill_form's verdict. A wall is discovered HERE, not at submit time -
    // submit_form is correctly never called once one is found - so reading only
    // submit_form left a CAPTCHA-blocked application reporting "ready". It also
    // carries the handoff: where to finish by hand, and every value already
    // worked out, so the human re-types nothing.
    if (payload && typeof payload === 'string' && payload.includes('"ready_to_submit"')) {
      try {
        const parsed = JSON.parse(payload);
        if (typeof parsed.ready_to_submit === 'boolean') {
          fillResult = {
            readyToSubmit: parsed.ready_to_submit,
            wall: parsed.wall ?? null,
            blocking: parsed.blocking ?? [],
            handoff: parsed.handoff ?? null,
          };
        }
      } catch { /* not the response we're after */ }
    }
    if (payload && typeof payload === 'string' && payload.includes('resume_path')) {
      try {
        const parsed = JSON.parse(payload);
        if (parsed.resume_path) {
          resumePath = parsed.resume_path;
          tailoring = {
            ledWith: parsed.led_with_skills ?? [],
            accomplishments: parsed.led_with_accomplishments ?? [],
            refused: (parsed.rejected ?? []).map((r) => r.value ?? r.match).filter(Boolean),
          };
        }
      } catch { /* not the response we're after */ }
    }
  }

  let status = state.status === 'running' ? 'working' : (job.status ?? 'idle');
  if (pending?.type === 'tool.approval_required') status = 'awaiting-approval';
  else if (pending?.type === 'tool.response_required') status = 'needs-answer';
  // A failed turn used to leave the row reading "working" for ever: there was no
  // case for it, so it fell back to the status stored when the job was started
  // and never changed again. The agent can die for reasons that have nothing to
  // do with this project - an upstream 503 is what surfaced this - and a run
  // that has stopped must not keep claiming it is still going.
  else if (state.status === 'error') {
    status = 'failed';
    turnError = state.message || 'the agent run failed';
  }
  // A cancelled turn has exactly the same problem and was not covered: it is
  // not a failure, but it is just as finished, and it fell through to the same
  // stale "working". Starting many runs at once is how a queue ends up full of
  // them, so this is the common case, not the rare one.
  else if (state.status === 'cancelled') {
    status = 'cancelled';
  }
  else if (state.status === 'done') {
    // "submitted" has to come from what submit_form actually reported, not from
    // the human having approved it: an approved submit can still be refused by a
    // CAPTCHA or an account wall, and saying "submitted" then is the one lie
    // this project must not tell. A refusal is surfaced as its wall instead.
    status = submitResult?.submitted === true ? 'submitted'
      : submitResult?.wall ? `blocked: ${submitResult.wall}`
      // A wall found while filling blocks submission just as hard, and it is
      // the usual case: the agent is told not to call submit_form at all once
      // it sees one. Without this the run read "ready", which is the opposite
      // of the truth - nobody can submit it without doing the CAPTCHA by hand.
      : fillResult?.wall ? `blocked: ${fillResult.wall}`
      : job.approved ? 'not-submitted'
      : 'ready';
  }

  const content = state.output?.content;
  const output = Array.isArray(content)
    ? content.map((b) => b.text ?? '').join('')
    : (content ?? '');

  if (resumePath) {
    await withQueue(async () => {
      const q2 = loadQueue();
      const row = q2.jobs.find((x) => x.id === job.id);
      if (row && row.resumePath !== resumePath) { row.resumePath = resumePath; saveQueue(q2); }
    });
  }

  return {
    status,
    turnId: latest.id,
    resumeAvailable: Boolean(resumePath || job.resumePath),
    tailoring,
    threadId: pending?.thread_id ?? 'main',
    pendingType: pending?.type ?? null,
    pendingToolCallId: pending?.tool_calls?.[0]?.id ?? null,
    question,
    approval,
    steps,
    output,
    submitResult,
    fillResult,
    turnError,
  };
}

// ---------------------------------------------------------------- api handlers
const api = {
  async 'GET /api/state'() {
    const q = loadQueue();
    const all = await Promise.all(q.jobs.map(async (j) => ({ ...j, live: await jobLive(j) })));

    // A cancelled run is dead: its turn cannot be resumed, so the row could
    // never change again. It is dropped rather than parked in the rail for
    // ever. Everything else stays - including failures, which the human needs
    // to see - and it is pruned from the queue too, so the dead sessions are
    // not re-fetched from TrueForge on every poll.
    const jobs = all.filter((j) => j.live?.status !== 'cancelled');
    if (jobs.length !== all.length) {
      const keep = new Set(jobs.map((j) => j.id));
      await withQueue(() => {
        const cur = loadQueue();
        cur.jobs = cur.jobs.filter((j) => keep.has(j.id) || !all.some((a) => a.id === j.id));
        saveQueue(cur);
      });
    }

    const profile = existsSync(PROFILE) ? JSON.parse(readFileSync(PROFILE, 'utf8')) : null;
    if (profile) delete profile._comment;
    return { jobs, profile };
  },

  // Company -> the roles they are actually hiring for, so the human picks
  // rather than the agent guessing which requisition they meant.
  async 'POST /api/positions'(body) {
    const { company, role } = body;
    if (!company) throw new Error('company required');

    // The whole board, deliberately unfiltered. Ranking against a résumé needs
    // every posting: the board arrives in its own order, so filtering or
    // truncating first hands the ranker an arbitrary slice - Anthropic's first
    // 200 of 571 are alphabetical and contain one "Software Engineer".
    let r = await mcpCall(JOBS_MCP, 'find_jobs', { company, limit: 1000 });

    // No machine-readable board. The search fallback has nothing to look for
    // without the role, so that one call does need it.
    if (!r.found && role) {
      r = await mcpCall(JOBS_MCP, 'find_jobs', { company, role, limit: 40 });
    }

    const profile = existsSync(PROFILE) ? JSON.parse(readFileSync(PROFILE, 'utf8')) : null;
    const all = (r.jobs ?? []).map((j, i) => ({
      key: j.id ?? `p${i}`,
      title: j.title ?? j.url,
      location: j.location ?? null,
      url: j.applyUrl ?? j.url,
    }));
    const { ranked, bestFits, matched } = rankPositions(all, profile, role);

    return {
      company,
      found: r.found,
      source: r.source ?? null,
      careersUrl: r.careers_url ?? null,
      note: r.note ?? r.reason ?? null,
      matchedAgainstResume: matched,
      bestFits,
      positions: ranked,
    };
  },

  // Queue the chosen roles. Nothing starts on its own - each row still needs
  // Start, and each still stops at its own gate.
  async 'POST /api/positions/queue'(body) {
    const { company, positions = [] } = body;
    if (!positions.length) throw new Error('no positions selected');
    return withQueue(() => {
    const q = loadQueue();
    const added = [];
    for (const p of positions) {
      const job = {
        id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        url: p.url,
        title: p.title,
        company,
        location: p.location ?? null,
        status: 'found',
        addedAt: new Date().toISOString(),
      };
      q.jobs.unshift(job);
      added.push(job);
    }
    saveQueue(q);
    return { added };
    });
  },

  async 'POST /api/jobs'(body) {
    return withQueue(() => {
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
    });
  },

  async 'POST /api/jobs/start'(body) {
    // Guarded and serialised: a second click used to open another session and
    // overwrite the only stored reference, so the first kept running with
    // nothing able to monitor or answer it.
    const started = await withQueue(async () => {
      const q = loadQueue();
      const job = q.jobs.find((j) => j.id === body.id);
      if (!job) throw new Error('unknown job');
      if (job.sessionId && job.status === 'working') {
        return { already: true, job, sessionId: job.sessionId };
      }
      const session = (await tf('POST', '/sessions', { agent: { name: AGENT } })).data;
      job.sessionId = session.id;
      job.status = 'working';
      saveQueue(q);
      return { already: false, job, sessionId: session.id };
    });
    if (started.already) {
      return { started: false, alreadyRunning: true, sessionId: started.sessionId };
    }
    const job = started.job;
    const session = { id: started.sessionId };

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
    // Approving only lets submit_form run; it can still refuse a CAPTCHA or an
    // account wall, or fail outright. Recording "submitted" here made the
    // dashboard claim an application had been sent whenever the human clicked
    // approve. What is true at this point is that the human approved it - the
    // submission itself is read back from the tool's own result in jobLive.
    //
    // Re-read under the lock rather than writing back the copy loaded before the
    // network call, which by now may be stale.
    await withQueue(() => {
      const q2 = loadQueue();
      const row = q2.jobs.find((j) => j.id === body.id);
      if (row) { row.approved = true; saveQueue(q2); }
    });
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
    return withQueue(() => {
      const q = loadQueue();
      q.jobs = q.jobs.filter((j) => j.id !== body.id);
      saveQueue(q);
      return { removed: true };
    });
  },

  // Serve the resume that will actually be attached, so the gate is not approved
  // blind. Falls back to the base resume when a job has no tailored variant.
  async 'GET /api/jobs/resume'(_, url) {
    const id = url.searchParams.get('id');
    const q = loadQueue();
    const job = q.jobs.find((j) => j.id === id);
    const path = job?.resumePath && existsSync(job.resumePath)
      ? job.resumePath
      : (existsSync(RESUME) ? RESUME : null);
    if (!path) throw new Error('no resume available');
    return { __file: path, __type: 'application/pdf' };
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

  // Ingest an uploaded resume or details file. The profile is the source of
  // truth, so the text has to reach it or tailoring stops working on real people.
  async 'POST /api/profile/upload'(_, url, req) {
    const { file } = await readMultipart(req);
    if (!file) throw new Error('no file uploaded');
    const stored = storeUpload(ROOT, file.filename, file.buffer);
    let extracted;
    try { extracted = await extractText(stored); }
    catch (err) { throw new Error(`could not read ${file.filename}: ${err.message}`); }
    const skim = skimResume(extracted.text);
    return {
      stored_at: stored,
      filename: file.filename,
      bytes: file.buffer.length,
      extracted_with: extracted.how,
      skim,
      text: extracted.text.slice(0, 20000),
      note:
        'Stored outside the repository. Send the text to the agent to turn it into ' +
        'profile data - it decides what becomes a claim, and every edit is versioned.',
    };
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

// Just enough multipart to pull one uploaded file out, without a dependency.
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    const m = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return reject(new Error('not multipart'));
    const boundary = `--${m[1] ?? m[2]}`;
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('error', reject);
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const sep = Buffer.from(`\r\n${boundary}`);
      const parts = [];
      let start = buf.indexOf(Buffer.from(boundary)) + boundary.length;
      while (start > boundary.length - 1) {
        const end = buf.indexOf(sep, start);
        if (end < 0) break;
        parts.push(buf.subarray(start, end));
        start = end + sep.length;
      }
      let file = null;
      const fields = {};
      for (const part of parts) {
        const headEnd = part.indexOf('\r\n\r\n');
        if (headEnd < 0) continue;
        const head = part.subarray(0, headEnd).toString('utf8');
        const content = part.subarray(headEnd + 4);
        const name = head.match(/name="([^"]+)"/)?.[1];
        const filename = head.match(/filename="([^"]*)"/)?.[1];
        if (!name) continue;
        if (filename) file = { field: name, filename, buffer: content };
        else fields[name] = content.toString('utf8').trim();
      }
      resolve({ file, fields });
    });
  });
}

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
      const isMultipart = (req.headers['content-type'] ?? '').startsWith('multipart/');
      const parsed = req.method === 'GET' || isMultipart ? null : await body(req);
      const out = await api[key](parsed, url, req);
      if (out && out.__file) {
        res.writeHead(200, {
          'content-type': out.__type ?? 'application/octet-stream',
          'content-length': statSync(out.__file).size,
        });
        return res.end(readFileSync(out.__file));
      }
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
