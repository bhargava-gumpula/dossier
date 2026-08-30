// Work out how a specific employer actually accepts applications.
//
// The rule this module exists to enforce: never assume a platform. Where a job
// was discovered says nothing about how that company wants to receive an
// application, so every job is fingerprinted independently from its apply URL.
//
// Verified 29 Aug 2026: fingerprint the job's APPLY URL, never the careers
// landing page. NVIDIA, Tesla and McDonald's landing pages are JavaScript
// marketing shells that detect as nothing; the real apply URLs detect instantly.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Ordered: the first match wins, so more specific hosts come first.
const PLATFORMS = [
  ['greenhouse',      /(job-)?boards(-api)?\.greenhouse\.io|greenhouse\.io\/embed/i],
  ['ashby',           /jobs\.ashbyhq\.com|ashbyhq\.com\/embed/i],
  ['workday',         /myworkdayjobs\.com|myworkdaysite\.com/i],
  ['lever',           /jobs\.lever\.co|lever\.co\/embed/i],
  ['icims',           /\.icims\.com/i],
  ['smartrecruiters', /jobs\.smartrecruiters\.com|smartrecruiters\.com\/[A-Za-z]/i],
  ['workable',        /apply\.workable\.com/i],
  ['bamboohr',        /\.bamboohr\.com\/(careers|jobs)/i],
  ['jobvite',         /jobs\.jobvite\.com/i],
  ['teamtailor',      /\.teamtailor\.com/i],
  ['recruitee',       /\.recruitee\.com/i],
  ['taleo',           /\.taleo\.net/i],
  ['successfactors',  /\.successfactors\.com|jobs\.sap\.com/i],
  ['phenom',          /phenompeople\.com/i],
  ['eightfold',       /\.eightfold\.ai/i],
  ['avature',         /\.avature\.net/i],
];

// Platforms whose submission endpoint is gated behind an employer credential
// or a CAPTCHA. Verified against six vendors: none permit unauthenticated
// submission. The agent fills these completely and hands over the final click.
const CREDENTIAL_WALLED = new Set([
  'greenhouse', 'ashby', 'lever', 'smartrecruiters',
  'workable', 'recruitee', 'icims', 'taleo', 'successfactors',
]);

// Platforms that require creating a candidate account before applying at all.
const ACCOUNT_WALLED = new Set(['workday']);

const CAPTCHA_PATTERNS = [
  /recaptcha/i, /g-recaptcha/i, /hcaptcha/i, /turnstile/i,
  /challenges\.cloudflare\.com/i, /captcha/i,
];

const LOGIN_PATTERNS = [
  /create an account/i, /sign in to apply/i, /create account/i,
  /candidate\s+account/i, /register to apply/i,
];

const CAREERS_EMAIL =
  /mailto:([a-z0-9._%+-]*(?:career|job|recruit|hiring|talent|resume|cv)[a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,})/ig;


import { assertAllowedUrl, guardedDispatcher } from './net-guard.js';
// undici's own fetch, because the dispatcher that pins DNS at connect time is
// an undici Agent and the global fetch will not accept one from a separately
// installed copy. Same spec-compliant API either way.
import { fetch as guardedFetch } from 'undici';

async function fetchPage(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let current = url;
    // Redirects are followed by hand so each hop can be re-validated: a public
    // host is free to redirect into a private range.
    for (let hop = 0; hop < 6; hop++) {
      // Two layers, deliberately: assertAllowedUrl rejects an address that is
      // already known to be private, and the dispatcher re-checks whatever the
      // resolver returns at the moment the socket is opened, so a name that
      // changes its answer in between cannot be used to reach a private host.
      await assertAllowedUrl(current);
      const res = await guardedFetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: ctl.signal,
        dispatcher: guardedDispatcher,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, status: res.status, finalUrl: current, body: '' };
        current = new URL(loc, current).toString();
        continue;
      }
      const body = (await res.text()).slice(0, 600000);
      return { ok: res.ok, status: res.status, finalUrl: current, body };
    }
    return { ok: false, status: 0, finalUrl: current, body: '', error: 'too many redirects' };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, body: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function detectApplyRoute(applyUrl) {
  const page = await fetchPage(applyUrl);

  // An HTTP error is not an application form, even when it returns a full HTML
  // body. Without this, a 404 page with no CAPTCHA on it fingerprints as a
  // bespoke form and reports canAutoSubmit:true - the agent would then claim it
  // could apply through a dead URL, which is the worst failure this tool has.
  if (!page.ok) {
    return {
      applyUrl,
      finalUrl: page.finalUrl,
      route: 'unknown',
      reachable: false,
      httpStatus: page.status || null,
      error: page.error ?? `http ${page.status}`,
      captchaDetected: null,
      accountRequired: null,
      canAutoSubmit: false,
      wall: null,
      note:
        'The apply URL did not return a usable page, so the route cannot be ' +
        'determined without guessing. Do not treat this posting as applicable.',
    };
  }

  const haystack = `${page.finalUrl} ${page.body}`;
  const platform = PLATFORMS.find(([, re]) => re.test(haystack))?.[0] ?? null;

  const emails = [...new Set(
    [...page.body.matchAll(CAREERS_EMAIL)].map((m) => m[1].toLowerCase()))];

  const captchaDetected = CAPTCHA_PATTERNS.some((re) => re.test(page.body));
  const loginWall = LOGIN_PATTERNS.some((re) => re.test(page.body));

  let route = platform;
  if (!route) route = emails.length ? 'email' : 'bespoke';

  const accountRequired =
    ACCOUNT_WALLED.has(route) || (loginWall && route !== 'email');

  // Can the agent legitimately complete this one by itself?
  let canAutoSubmit;
  let wall = null;
  if (route === 'email') {
    canAutoSubmit = true;
  } else if (CREDENTIAL_WALLED.has(route)) {
    canAutoSubmit = false;
    wall = captchaDetected ? 'captcha' : 'employer-credential';
  } else if (accountRequired) {
    canAutoSubmit = false;
    wall = 'account-required';
  } else if (captchaDetected) {
    canAutoSubmit = false;
    wall = 'captcha';
  } else {
    canAutoSubmit = true; // bespoke form with no wall detected
  }

  return {
    applyUrl,
    finalUrl: page.finalUrl,
    route,
    reachable: true,
    platformFingerprint: platform,
    careersEmails: emails,
    captchaDetected,
    accountRequired,
    canAutoSubmit,
    wall,
    hasJobPostingJsonLd: /"@type"\s*:\s*"JobPosting"|JobPosting/.test(page.body),
  };
}
