#!/usr/bin/env node
// Full end-to-end check of every feature, against live services.
//
// Nothing here is mocked. Company boards are real, the forms are real, the
// sandbox is a real remote container, and the only submission target is the
// demo employer in this repo - because sending a fabricated candidate to a real
// company would be deceptive, and the model refuses to do it.
//
// Exits non-zero if anything regresses.

import { resolveCompany } from '../mcp/lib/sources.js';
import { detectApplyRoute } from '../mcp/lib/route.js';
import { inspectForm, closeBrowser } from '../mcp/lib/browser.js';
import { isSearchAvailable, searchJobs, scrapeBlocked } from '../mcp/lib/websearch.js';
import { readFileSync, statSync } from 'node:fs';

// The demo employer lives on a private address, which the egress guard blocks by
// design. Naming it here is the same explicit opt-in the MCP servers use - if
// this line is removed the guard correctly refuses to read the form, which is
// the behaviour we want everywhere else.
process.env.DOSSIER_ALLOW_ORIGINS =
  process.env.DOSSIER_ALLOW_ORIGINS ?? 'http://127.0.0.1:8795';

const TF = 'http://localhost:8790/api/v1';
const DEMO = process.env.DEMO_EMPLOYER ?? 'http://127.0.0.1:8795';
const APPLY_MCP = 'http://127.0.0.1:8794/mcp';
const ROOT = new URL('..', import.meta.url).pathname;

let pass = 0, fail = 0;
const t = (label, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
};
const section = (s) => console.log(`\n${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tf(method, path, body) {
  const res = await fetch(TF + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
async function mcp(url, name, args) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  return j.result?.structuredContent ?? j.result;
}

// ---------------------------------------------------------------- 1. services
section('1. Services');
for (const [label, url] of [
  ['TrueForge', 'http://localhost:8790/api/v1/agents'],
  ['jobs MCP', 'http://127.0.0.1:8793/health'],
  ['apply MCP', 'http://127.0.0.1:8794/health'],
  ['demo employer', `${DEMO}/received`],
  ['dashboard', 'http://127.0.0.1:5174/api/state'],
]) {
  let ok = false;
  try { ok = (await fetch(url, { signal: AbortSignal.timeout(8000) })).ok; } catch {}
  t(label, ok);
}

// -------------------------------------------------------- 2. sandbox provider
section('2. Sandbox (R3)');
const prov = (await tf('GET', '/settings/sandbox-providers')).data ?? {};
t('Daytona provider ready', prov.status === 'ready', prov.manifest?.type ?? '');

// ------------------------------------------------------- 3. company discovery
section('3. Company discovery — direct board APIs');
for (const [company, expect] of [
  ['Anthropic', 'greenhouse'], ['Ramp', 'ashby'],
  ['NVIDIA', 'workday'], ['Nutanix', 'jobvite'],
]) {
  const r = await resolveCompany(company);
  t(`${company} → ${expect}`, r.found && r.source === expect,
    r.found ? `${r.source} (${r.jobs.length} jobs)` : 'not found');
}

section('4. Company discovery — web search fallback');
const searchable = await isSearchAvailable();
t('search connector configured', searchable);
if (searchable) {
  for (const company of ['Shopify', 'Atlassian']) {
    const s = await searchJobs(company, 'software engineer', { limit: 4 });
    const own = s.jobs.filter((j) => j.onEmployerDomain).length;
    t(`${company} → employer-owned URLs`, own > 0, `${own}/${s.jobs.length} on own domain`);
  }
  const agg = (await searchJobs('Shopify', 'engineer', { limit: 8 })).jobs
    .filter((j) => /linkedin|indeed|glassdoor|ziprecruiter/i.test(j.url)).length;
  t('aggregators excluded', agg === 0, `${agg} found`);
}

// ------------------------------------------------------- 5. route + the walls
section('5. Apply-route detection and walls');
for (const [label, url, expect] of [
  ['Anthropic → greenhouse/captcha', 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008',
    { route: 'greenhouse', canAutoSubmit: false, wall: 'captcha' }],
  ['NVIDIA → workday/account', 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-HPC-Storage-Engineer_JR2014997',
    { route: 'workday', canAutoSubmit: false, wall: 'account-required' }],
  ['dead posting → never submittable', 'https://job-boards.greenhouse.io/nosuchboard99999/jobs/1',
    { route: 'unknown', canAutoSubmit: false }],
]) {
  const r = await detectApplyRoute(url);
  const ok = Object.entries(expect).every(([k, v]) => r[k] === v);
  t(label, ok, ok ? '' : JSON.stringify({ route: r.route, wall: r.wall, auto: r.canAutoSubmit }));
}

section('6. Egress guard');
for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8790/api/v1/agents', 'file:///etc/passwd']) {
  const r = await detectApplyRoute(bad);
  t(`blocked: ${bad.slice(0, 42)}`, r.reachable === false);
}

section('7. Bot protection');
if (searchable) {
  try {
    const r = await scrapeBlocked('https://www.tesla.com/careers/search/job/internship-mechanical-engineer-fall-2026-244085');
    t('Tesla page retrieved', r.markdown.length > 200 && !/access denied/i.test(r.markdown), `${r.markdown.length} chars`);
  } catch (e) { t('Tesla page retrieved', false, String(e).slice(0, 50)); }
}

// ------------------------------------------------- 7b. resume intake (Phase 7)
section('7b. Résumé upload and extraction');
{
  const { extractText, skimResume } = await import('../mcp/lib/resume-intake.js');
  const r = await extractText(`${ROOT}fixtures/persona/resume.pdf`);
  t('PDF text extracted', r.text.length > 300, `${r.text.length} chars via ${r.how}`);
  const skim = skimResume(r.text);
  t('contact details recovered', skim.emails.length > 0 && skim.phones.length > 0);
  t('sections recognised', skim.sectionsFound.includes('experience'), skim.sectionsFound.join(', '));
}

// ------------------------------------------------------------ 8. form reading
section('8. Form reading');
const demoForm = await inspectForm(`${DEMO}/jobs/backend-engineer`, { screenshot: false });
t('demo employer form read', demoForm.reachable && demoForm.fieldCount >= 8, `${demoForm.fieldCount} fields`);
t('required fields identified', demoForm.requiredCount >= 5, `${demoForm.requiredCount} required`);
t('file upload identified', demoForm.fileUploads?.length > 0);
t('no wall on demo employer', demoForm.wall === null && demoForm.canAutoSubmit === true);

const ghForm = await inspectForm('https://job-boards.greenhouse.io/anthropic/jobs/4461450008', { screenshot: false });
t('real Greenhouse form read', ghForm.reachable && ghForm.fieldCount >= 20, `${ghForm.fieldCount} fields`);
t('CAPTCHA detected on it', ghForm.wall === 'captcha');

// --------------------------------------------------------- 9. résumé editing
section('9. Résumé editing');
const profilePath = `${ROOT}fixtures/persona/profile.json`;
const resumePath = `${ROOT}fixtures/persona/resume.pdf`;
const before = JSON.parse(readFileSync(profilePath, 'utf8'));
const pdfBefore = statSync(resumePath).mtimeMs;
const marker = `TestSkill${Date.now().toString(36).slice(-4)}`;

const edit = await mcp(APPLY_MCP, 'update_profile', {
  edits: [
    { op: 'add_skill', value: marker },
    { op: 'add_bullet', company: 'Meridian Payments', value: `Verified end-to-end at ${new Date().toISOString()}.` },
    { op: 'add_bullet', company: 'Does Not Exist Inc', value: 'should be rejected' },
  ],
});
t('edits applied', edit.updated === true, `${edit.applied?.length} applied`);
t('bogus employer rejected', (edit.rejected ?? []).some((r) => /no experience entry/.test(r.reason ?? '')));
t('résumé PDF rebuilt', edit.resume_rebuilt === true);
t('PDF actually changed on disk', statSync(resumePath).mtimeMs > pdfBefore);
const after = JSON.parse(readFileSync(profilePath, 'utf8'));
t('new skill present', after.skills.includes(marker));
t('original content preserved', before.skills.every((s) => after.skills.includes(s)), `${before.skills.length} kept`);
t('previous version snapshotted', Boolean(edit.previous_version));

// Clean up so repeated runs do not accumulate. The skill was already removed
// here; the bullet was not, so every run left one behind and the demo persona
// had collected eight lines of "Verified end-to-end at ..." in the experience
// that gets tailored, attached and shown. Matched on the shared prefix rather
// than this run's exact text, so a run that died mid-way is mopped up too.
await mcp(APPLY_MCP, 'update_profile', {
  edits: [
    { op: 'remove_skill', value: marker },
    { op: 'remove_bullet', company: 'Meridian Payments', value: 'Verified end-to-end at' },
  ],
});

// --------------------------------------------- 9b. readiness contract (Phase 7)
section('9b. Readiness is decided by the tool, not re-derived');
{
  const partial = await mcp(APPLY_MCP, 'fill_form', {
    apply_url: `${DEMO}/jobs/backend-engineer`,
    answers: { 'First Name': 'Avery', Email: 'avery.okonkwo@example.com' },
  });
  t('incomplete fill is not ready', partial.ready_to_submit === false,
    `${partial.blocking?.length ?? 0} blocking`);
  t('names the missing required fields',
    (partial.blocking ?? []).some((b) => b.kind === 'missing-required'));

  const complete = await mcp(APPLY_MCP, 'fill_form', {
    apply_url: `${DEMO}/jobs/backend-engineer`,
    answers: {
      'First Name': 'Avery', 'Last Name': 'Okonkwo', Email: 'avery.okonkwo@example.com',
      Phone: '+1 415 555 0142', 'Are you authorized to work in the US?': 'Yes',
      'Why do you want to work at Northwind Robotics?': 'Six years on payments infrastructure.',
    },
  });
  t('complete fill is ready', complete.ready_to_submit === true);

  // Dry-run must capture, never send to the employer.
  const dry = await mcp(APPLY_MCP, 'submit_form', { fill_id: complete.fillId });
  t('dry-run captured, not sent', dry.mode === 'dry-run' && dry.submitted === true);
  t('records the real destination', /jobs\/backend-engineer|\/apply/.test(dry.would_have_submitted_to ?? ''),
    dry.would_have_submitted_to ?? '');
  t('résumé travelled with it', (dry.files_sent ?? []).length > 0, (dry.files_sent ?? []).join(','));
}

// ------------------------------------------------- 9c. tailoring cannot invent
section('9c. Tailoring reorders, never invents');
{
  const tl = await mcp(APPLY_MCP, 'tailor_resume', {
    job_title: 'Verify Tailoring',
    lead_skills: ['PostgreSQL', 'Fortran'],
    lead_bullets: [{ company: 'Meridian Payments', match: 'ledger' }],
  });
  t('real skill promoted', (tl.led_with_skills ?? []).includes('PostgreSQL'));
  t('unheld skill refused', (tl.rejected ?? []).some((r) => r.value === 'Fortran'));
  t('nothing lost', tl.content_preserved === true);
  t('original untouched', tl.original_untouched === true);
  t('tailored PDF exists', Boolean(tl.resume_path) && statSync(tl.resume_path).size > 1000);
}

// ---------------------------------------------- 10. full apply run + the gate
section('10. Full application run, and the gate (R4)');
const receivedBefore = (await (await fetch(`${DEMO}/received`)).json()).count;

const session = (await tf('POST', '/sessions', { agent: { name: 'dossier' } })).data;
const turn = (await tf('POST', `/sessions/${session.id}/turns`, {
  input: [{ type: 'user.message', content:
    `Apply for me to ${DEMO}/jobs/backend-engineer. This is a demo employer I run myself, not a real ` +
    'company, so submitting here is intended. Get the candidate profile, detect the route, inspect ' +
    'the form, fill every field, and submit. If a field is not in my profile, use a sensible answer ' +
    'grounded in my real experience rather than asking.' }],
  stream: false,
})).data;

let state, waited = 0;
while (waited < 240000) {
  state = (await tf('GET', `/sessions/${session.id}/turns/${turn.id}`)).data.state;
  if (['done', 'failed', 'error', 'cancelled'].includes(state.status)) break;
  await sleep(4000); waited += 4000;
}

// The harness wraps every MCP tool in a meta tool: an actual invocation is
// call_tool, while list_tools / get_tool_info / get_tool_output_schema only read
// a schema. Both carry the tool's name in arguments.tool_name, so preferring
// that field counted "look up submit_form's schema" as "call submit_form" - and
// since the agent looks up all six tools before starting, every run reported the
// whole workflow twice and two submits. That is what the long-standing
// intermittent failure of this section actually was: a miscount here, not the
// agent redoing its work.
//
// Decide meta-ness from the real function name, then resolve the logical name.
//
// There are two ways a tool actually gets invoked, and both must be counted.
// Directly, as call_tool with the name in arguments.tool_name; or from inside
// the sandbox, where the agent shells out and the name appears only in the
// command it runs:
//
//   mcp-client call-tool dossier-apply inspect_form '{"apply_url":"..."}'
//
// An exec that merely cats a file back is not a tool call and contributes
// nothing. Returns a list because one command can invoke more than one tool.
const META = ['list_tools', 'get_tool_info', 'get_tool_output_schema'];
const MCP_CLI = /mcp-client\s+call-tool\s+\S+\s+([A-Za-z_][A-Za-z0-9_]*)/g;
function invokedTools(c) {
  const fn = c.function?.name;
  if (META.includes(fn)) return [];
  let a = {}; try { a = JSON.parse(c.function?.arguments ?? '{}'); } catch {}
  if (fn === 'exec') {
    const cmd = String(a.command ?? '');
    return [...cmd.matchAll(MCP_CLI)].map((m) => m[1]);
  }
  const n = a.tool_name ?? fn;
  return n ? [n] : [];
}

const events = (await tf('GET', `/sessions/${session.id}/turns/${turn.id}/events`)).data ?? [];
const used = new Set();
for (const e of events) for (const c of ((e.event ?? e).tool_calls ?? [])) {
  for (const n of invokedTools(c)) used.add(n);
}
t('used detect_apply_route', used.has('detect_apply_route'));
t('used get_candidate_profile', used.has('get_candidate_profile'));
t('used inspect_form', used.has('inspect_form'));
t('used fill_form', used.has('fill_form'));

const required = state.required_actions ?? [];
const gate = required.find((r) => r.type === 'tool.approval_required');
t('APPROVAL GATE fired', Boolean(gate), gate ? 'submit_form held' : `pending: ${required[0]?.type ?? 'none'}`);

// The loop bug, asserted directly: one submit, and no re-inspecting after filling.
const calls = [];
const seenCall = new Set();
for (const e of events) for (const c of ((e.event ?? e).tool_calls ?? [])) {
  // A held call appears twice in the stream: the invocation, then the approval
  // event echoing its id. Deduping by id keeps that from reading as two calls.
  if (c.id && seenCall.has(c.id)) continue;
  if (c.id) seenCall.add(c.id);
  calls.push(...invokedTools(c));
}
const submits = calls.filter((c) => c === 'submit_form').length;
t('exactly one submit_form call', submits === 1, `${submits} calls`);
const firstFill = calls.indexOf('fill_form');
const inspectAfterFill = firstFill >= 0 && calls.slice(firstFill).includes('inspect_form');
t('no re-inspection after filling', !inspectAfterFill, calls.join(' → ').slice(0, 90));

const midCount = (await (await fetch(`${DEMO}/received`)).json()).count;
t('nothing submitted while held', midCount === receivedBefore, `${midCount} received`);

if (gate) {
  await tf('POST', `/sessions/${session.id}/turns`, {
    input: [{ type: 'user.tool_approval', thread_id: gate.thread_id ?? 'main',
              tool_call_id: gate.tool_calls[0].id, approval: { status: 'allow' } }],
    stream: false,
  });
  await sleep(12000);
  const afterCount = (await (await fetch(`${DEMO}/received`)).json()).count;
  t('submitted after approval', afterCount === receivedBefore + 1, `${afterCount} received`);

  // After an approval the application is finished. Any further tool call is the
  // stall the user reported - the agent redoing work it had already completed.
  const resumeTurns = (await tf('GET', `/sessions/${session.id}/turns`)).data ?? [];
  const lastTurn = resumeTurns[resumeTurns.length - 1];
  const postEvents = (await tf('GET', `/sessions/${session.id}/turns/${lastTurn.id}/events`)).data ?? [];
  const postCalls = [];
  for (const e of postEvents) for (const c of ((e.event ?? e).tool_calls ?? [])) {
    postCalls.push(...invokedTools(c));
  }
  t('no tool calls after approval', postCalls.length === 0, postCalls.join(', ') || 'none');

  const last = (await (await fetch(`${DEMO}/received`)).json()).applications.at(-1);
  // A dry-run capture records uploads in `files`; a live submit puts the filename
  // inline in `fields`. Accept either, since both are real submissions.
  const attached = (last?.files ?? []).map((f) => f.filename).filter(Boolean).join(',')
    || last?.fields?.resume || '';
  t('résumé PDF attached', /\.pdf/i.test(attached), attached);
  t('the TAILORED résumé was sent', /-/.test(attached) && !/^resume\.pdf$/.test(attached), attached);
  t('all required fields present',
    Boolean(last?.fields?.first_name && last?.fields?.email && last?.fields?.why));
  t('dry-run recorded the real destination', Boolean(last?.intendedDestination),
    last?.intendedDestination ?? '');
}

await closeBrowser();
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES: ' + fail}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
