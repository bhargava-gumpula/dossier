#!/usr/bin/env node
// apply-mcp - read, fill and submit real application forms with a real browser.
//
// The approval gate lives here. inspect_form and fill_form are read-only: they
// look at a page and type into it, but nothing leaves the machine. submit_form
// is the single irreversible action, annotated destructive so TrueForge holds
// it until a human approves on the dashboard.
//
// Two walls are reported, never worked around:
//   captcha          - the form requires a CAPTCHA. Not solved. Handed over.
//   account-required - applying needs a candidate account first. Handed over.
// Bot protection is a third: Tesla's careers site returns 403 to headless
// Chromium exactly as it does to fetch. Reported honestly.

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectForm, fillForm, getFill, dropFill } from './lib/browser.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The sandbox is a remote container with no view of this machine's disk, so the
// agent cannot read the candidate's files with `exec`. Anything it needs from
// disk has to arrive through a tool that runs here, on the host.
const PROFILE_PATH = process.env.DOSSIER_PROFILE ?? `${ROOT}/fixtures/persona/profile.json`;
const RESUME_PATH = process.env.DOSSIER_RESUME ?? `${ROOT}/fixtures/persona/resume.pdf`;

const PORT = Number(process.env.APPLY_MCP_PORT ?? 8794);
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'get_candidate_profile',
    description:
      "Return the candidate's profile and the path to their resume PDF. Call this " +
      'first: the sandbox cannot see this machine\'s filesystem, so this is the ' +
      'only way to reach the candidate\'s details. Use these values as the source ' +
      'of truth when filling forms, and never invent anything not present here.',
    annotations: { title: 'Get candidate profile', readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'inspect_form',
    description:
      'Open a job application page in a real browser and report the fields that ' +
      'actually exist, with types, required flags and select options. Also ' +
      'reports whether a CAPTCHA, an account wall or bot protection blocks ' +
      'automated submission. Nothing is typed or sent.',
    annotations: { title: 'Inspect application form', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { apply_url: { type: 'string', description: "The job's apply URL." } },
      required: ['apply_url'],
    },
  },
  {
    name: 'fill_form',
    description:
      'Fill an application form in a real browser and attach the resume, then ' +
      'STOP before submitting. Returns a screenshot of the completed form and a ' +
      'fill_id. Nothing is submitted. Answer keys are matched to fields by label, ' +
      'so use the labels reported by inspect_form.',
    annotations: { title: 'Fill application form', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        apply_url: { type: 'string' },
        answers: { type: 'object', description: 'Field label -> answer.', additionalProperties: true },
        resume_path: { type: 'string', description: 'Absolute path to the resume PDF.' },
      },
      required: ['apply_url', 'answers'],
    },
  },
  {
    name: 'submit_form',
    description:
      'Submit a form that was previously filled with fill_form. THIS IS ' +
      'IRREVERSIBLE - it sends a real application to a real employer and it ' +
      'cannot be recalled. Requires the fill_id from fill_form. Refuses when a ' +
      'CAPTCHA or account wall is present, because those are handed to the human.',
    annotations: {
      title: 'Submit application', readOnlyHint: false, destructiveHint: true,
      idempotentHint: false, openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        fill_id: { type: 'string', description: 'The fill_id returned by fill_form.' },
      },
      required: ['fill_id'],
    },
  },
];

function toolGetCandidateProfile() {
  if (!existsSync(PROFILE_PATH)) {
    return { error: `no candidate profile configured at ${PROFILE_PATH}` };
  }
  const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
  delete profile._comment;
  return {
    profile,
    resume_path: existsSync(RESUME_PATH) ? RESUME_PATH : null,
    note:
      'Pass resume_path straight to fill_form. Do not try to read these files ' +
      'from the sandbox - it is a remote container and cannot see them.',
  };
}

async function toolInspectForm({ apply_url }) {
  const r = await inspectForm(apply_url, { screenshot: false });
  return r;
}

async function toolFillForm({ apply_url, answers = {}, resume_path = null }) {
  // Default to the configured resume so a missing path is not a silent no-upload.
  if (!resume_path && existsSync(RESUME_PATH)) resume_path = RESUME_PATH;
  if (resume_path && !existsSync(resume_path)) {
    return { filled: false, error: `resume not found at ${resume_path}` };
  }
  const r = await fillForm(apply_url, { answers, resumePath: resume_path });
  // The screenshot is large; hand back a path-free marker plus size so the
  // model does not try to reason about a megabyte of base64.
  const { screenshotBase64, ...rest } = r;
  return {
    ...rest,
    screenshot_available: Boolean(screenshotBase64),
    screenshot_bytes: screenshotBase64 ? Math.round((screenshotBase64.length * 3) / 4) : 0,
    _screenshot_base64: screenshotBase64,
  };
}

async function toolSubmitForm({ fill_id }) {
  const fill = getFill(fill_id);
  if (!fill) {
    return {
      submitted: false,
      error: 'unknown or expired fill_id. Re-run fill_form before submitting.',
    };
  }
  const { page, url } = fill;

  // Re-check the wall at submit time: a page can change between fill and approval.
  const live = await page.evaluate(`(() => ({
    captcha: Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey], iframe[src*="turnstile"]')),
    text: (document.body.innerText || '').slice(0, 3000),
  }))()`);
  if (live.captcha) {
    return {
      submitted: false, url, wall: 'captcha',
      error:
        'This form requires a CAPTCHA. This agent does not solve CAPTCHAs. The ' +
        'form is filled and waiting - a human must complete the CAPTCHA and click submit.',
    };
  }

  const candidates = [
    'button[type=submit]', 'input[type=submit]',
    'button:has-text("Submit application")', 'button:has-text("Submit Application")',
    'button:has-text("Submit")', 'button:has-text("Apply")',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout: 15000 });
        await page.waitForTimeout(4000);
        const after = await page.evaluate('(document.body.innerText || "").slice(0, 1200)');
        await dropFill(fill_id);
        return {
          submitted: true, url, clicked: sel,
          confirmation_text: after.slice(0, 600),
          note: 'Application submitted. This cannot be undone.',
        };
      } catch (err) {
        return { submitted: false, url, error: `submit click failed: ${err.message.slice(0, 140)}` };
      }
    }
  }
  return { submitted: false, url, error: 'no submit control found on the filled page' };
}

const IMPL = {
  get_candidate_profile: toolGetCandidateProfile,
  inspect_form: toolInspectForm,
  fill_form: toolFillForm,
  submit_form: toolSubmitForm,
};

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id = null, method, params } = msg;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request: missing method');

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dossier-apply', version: '0.1.0' },
    });
  }
  if (method.startsWith('notifications/')) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const fn = IMPL[params?.name];
    if (!fn) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
    try {
      const out = await fn(params?.arguments ?? {});
      const { _screenshot_base64, ...visible } = out;
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(visible, null, 2) }],
        structuredContent: visible,
        isError: false,
      });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Tool ${params?.name} failed: ${err.message}` }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 8e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, server: 'dossier-apply', tools: TOOLS.map((t) => t.name) }));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  let out;
  try { out = (await Promise.all(batch.map((m) => handleRpc(m)))).filter(Boolean); }
  catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32603, `Internal error: ${err.message}`)));
  }
  if (!out.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(payload) ? out : out[0]));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dossier-apply MCP on http://127.0.0.1:${PORT}/mcp`);
});
