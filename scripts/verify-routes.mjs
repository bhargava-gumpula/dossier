#!/usr/bin/env node
// Prove that route detection identifies how each employer really accepts
// applications - across four different platforms plus a bespoke careers site.
//
// This is the assertion the whole product rests on: never assume a platform.
// Exits non-zero if any expectation breaks, so a silent regression cannot pass.

import { detectApplyRoute } from '../mcp/lib/route.js';
import { resolveCompany } from '../mcp/lib/sources.js';

const ROUTE_CASES = [
  {
    label: 'Anthropic',
    url: 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008',
    expect: { route: 'greenhouse', canAutoSubmit: false, wall: 'captcha' },
  },
  {
    label: 'NVIDIA',
    url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-HPC-Storage-Engineer_JR2014997',
    expect: { route: 'workday', canAutoSubmit: false, wall: 'account-required' },
  },
  // Tesla is a bespoke careers site behind bot protection: a plain fetch gets
  // 403, so the detector must report `unknown` and refuse to call it
  // submittable. This is exactly why the browser stage exists - a real browser
  // reaches pages a bare fetch cannot. Asserting "not falsely submittable" is
  // the property that matters and does not depend on a third party's mood.
  {
    label: 'Tesla (bot-protected bespoke)',
    url: 'https://www.tesla.com/careers/search/job/internship-mechanical-engineer-fall-2026-244085',
    expect: { canAutoSubmit: false },
  },
  // A dead posting must never fingerprint as an applicable form. Before this
  // was fixed, a 404 page with no CAPTCHA on it returned bespoke +
  // canAutoSubmit:true, and the agent would claim it could apply through it.
  {
    label: 'dead posting (404)',
    url: 'https://job-boards.greenhouse.io/nosuchboard99999/jobs/1',
    expect: { route: 'unknown', canAutoSubmit: false },
  },
];

// Company-name resolution: "name it, don't link it".
const RESOLVE_CASES = [
  { company: 'Anthropic', expectSource: 'greenhouse' },
  { company: 'Ramp', expectSource: 'ashby' },
  { company: 'NVIDIA', expectSource: 'workday' },
  { company: 'Nutanix', expectSource: 'jobvite' },
];

// Employers that self-host their careers site and publish no machine-readable
// board. Direct probing cannot enumerate them, so discovery falls back to web
// search - which is what makes this general instead of one ATS integration at
// a time. These must still return a careers pointer when search is unavailable.
const SELF_HOSTED = ['Shopify', 'Atlassian'];

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${ok ? String(actual) : `got ${actual}, want ${expected}`}`,
  );
}

console.log('Company resolution — name it, don\'t link it');
for (const c of RESOLVE_CASES) {
  const r = await resolveCompany(c.company);
  check(`${c.company} resolves to ${c.expectSource}`, r.found ? r.source : 'NOT FOUND', c.expectSource);
}

console.log('\nSelf-hosted employers — must fail honestly, with a pointer');
for (const company of SELF_HOSTED) {
  const r = await resolveCompany(company);
  check(`${company} reports no board`, r.found, false);
  check(`${company} points at a careers site`, Boolean(r.careersUrl), true);
}

console.log('\nApply-route detection — never assume a platform');
for (const c of ROUTE_CASES) {
  const r = await detectApplyRoute(c.url);
  for (const [key, want] of Object.entries(c.expect)) {
    check(`${c.label} — ${key}`, r[key], want);
  }
}

console.log(
  failures === 0
    ? '\nROUTE DETECTION VERIFIED'
    : `\nROUTE DETECTION FAILED — ${failures} assertion(s)`,
);
process.exit(failures === 0 ? 0 : 1);
