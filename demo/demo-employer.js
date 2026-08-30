#!/usr/bin/env node
// A stand-in employer with a real application form.
//
// Why this exists: the agent must not submit a fabricated candidate into a real
// company's hiring pipeline. That wastes real recruiters' time and is deceptive,
// and the model correctly refuses to do it. So the end-to-end submit demo posts
// to this, a form we control, which behaves like a real one: a genuine HTML
// form, a real POST, a real confirmation, and a record written to disk.
//
// The submission is still irreversible in the sense that matters for the demo -
// once sent, it is recorded and cannot be unsent.

import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

// The submitted name is echoed back into an HTML page, so it is attacker-
// controlled markup unless it is escaped. This is only the local demo sink,
// but it is also the page a reader is most likely to copy from.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PORT = Number(process.env.DEMO_EMPLOYER_PORT ?? 8795);
const LOG = new URL('./received-applications.jsonl', import.meta.url).pathname;

const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Careers at Northwind Robotics — Backend Engineer</title><style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 max-width:640px;margin:40px auto;padding:0 20px;color:#111}
h1{font-size:24px;margin:0 0 4px}.sub{color:#666;margin-bottom:28px}
label{display:block;margin:16px 0 4px;font-weight:600;font-size:13px}
.req::after{content:" *";color:#c00}
input,textarea,select{width:100%;padding:9px;border:1px solid #ccc;border-radius:6px;font:inherit}
textarea{min-height:90px}
button{margin-top:24px;padding:11px 22px;background:#1a1a1a;color:#fff;border:0;
 border-radius:6px;font:inherit;font-weight:600;cursor:pointer}
.note{margin-top:28px;padding:12px;background:#f6f6f4;border-radius:6px;color:#555;font-size:13px}
</style></head><body>
<h1>Backend Engineer, Payments</h1>
<div class="sub">Northwind Robotics · San Francisco, CA · Full-time</div>
<p>We are looking for a backend engineer to work on payments infrastructure.
Experience with distributed systems, PostgreSQL and event streaming is relevant.</p>
<form method="POST" action="/apply" enctype="multipart/form-data">
  <label class="req" for="first_name">First Name</label>
  <input id="first_name" name="first_name" required>
  <label class="req" for="last_name">Last Name</label>
  <input id="last_name" name="last_name" required>
  <label class="req" for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <label for="phone">Phone</label>
  <input id="phone" name="phone" type="tel">
  <label for="linkedin">LinkedIn Profile</label>
  <input id="linkedin" name="linkedin">
  <label class="req" for="resume">Resume</label>
  <input id="resume" name="resume" type="file" required>
  <label class="req" for="authorized">Are you authorized to work in the US?</label>
  <select id="authorized" name="authorized" required>
    <option value="">Select...</option><option>Yes</option><option>No</option>
  </select>
  <label class="req" for="why">Why do you want to work at Northwind Robotics?</label>
  <textarea id="why" name="why" required></textarea>
  <label for="start">Earliest start date</label>
  <input id="start" name="start">
  <button type="submit">Submit application</button>
</form>
<div class="note">Demo employer. This form exists so the agent's submit step can be
exercised end to end without sending a fabricated application to a real company.</div>
</body></html>`;

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/jobs'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(FORM);
  }
  if (req.method === 'GET' && req.url.startsWith('/received')) {
    const body = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      count: body.trim() ? body.trim().split('\n').length : 0,
      applications: body.trim() ? body.trim().split('\n').map((l) => JSON.parse(l)) : [],
    }, null, 2));
  }
  // Dry-run sink. Records the payload AND where it was really headed, so the log
  // makes the difference between "captured" and "sent" impossible to miss.
  if (req.method === 'POST' && req.url.startsWith('/capture')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 12e6) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw); } catch {}
      const record = {
        receivedAt: new Date().toISOString(),
        mode: 'dry-run',
        intendedDestination: payload.destination ?? '(unknown)',
        method: payload.method ?? 'POST',
        fields: Object.fromEntries((payload.fields ?? []).map((f) => [f.name, f.value])),
        files: payload.files ?? [],
      };
      appendFileSync(LOG, JSON.stringify(record) + '\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        captured: true,
        wouldHaveGoneTo: record.intendedDestination,
        fieldCount: Object.keys(record.fields).length,
        reference: `DRY-${Date.now().toString(36).toUpperCase()}`,
      }));
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/apply')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 12e6) req.destroy(); });
    req.on('end', () => {
      // Pull the readable fields out of the multipart body without a dependency.
      const fields = {};
      for (const m of raw.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r?\n(?:Content-Type:[^\r\n]*\r?\n)?\r?\n([\s\S]*?)\r?\n--/g)) {
        const [, name, filename, value] = m;
        fields[name] = filename ? `<file: ${filename}, ${value.length} bytes>` : value.trim();
      }
      const record = { receivedAt: new Date().toISOString(), fields };
      appendFileSync(LOG, JSON.stringify(record) + '\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Application received</title>
<body style="font:16px/1.6 -apple-system,sans-serif;max-width:600px;margin:60px auto;padding:0 20px">
<h1>Application received</h1>
<p>Thank you, ${esc(fields.first_name || 'candidate')}. Your application for
<strong>Backend Engineer, Payments</strong> has been received.</p>
<p style="color:#666">Reference: NR-${Date.now().toString(36).toUpperCase()}</p>
</body>`);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`demo employer on http://127.0.0.1:${PORT}/jobs/backend-engineer`);
  console.log(`received applications: http://127.0.0.1:${PORT}/received`);
});
