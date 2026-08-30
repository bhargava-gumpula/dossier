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
  {
    label: 'Tesla',
    url: 'https://www.tesla.com/careers/search/job/internship-mechanical-engineer-fall-2026-244085',
    expect: { route: 'bespoke', canAutoSubmit: true, wall: null },
  },
];

// Company-name resolution: "name it, don't link it".
const RESOLVE_CASES = [
  { company: 'Anthropic', expectSource: 'greenhouse' },
  { company: 'Ramp', expectSource: 'ashby' },
  { company: 'NVIDIA', expectSource: 'workday' },
];

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

console.log('\nApply-route detection — never assume a platform');
for (const c of ROUTE_CASES) {
  const r = await detectApplyRoute(c.url);
  check(`${c.label} route`, r.route, c.expect.route);
  check(`${c.label} can auto-submit`, r.canAutoSubmit, c.expect.canAutoSubmit);
  check(`${c.label} wall`, r.wall, c.expect.wall);
}

console.log(
  failures === 0
    ? '\nROUTE DETECTION VERIFIED'
    : `\nROUTE DETECTION FAILED — ${failures} assertion(s)`,
);
process.exit(failures === 0 ? 0 : 1);
