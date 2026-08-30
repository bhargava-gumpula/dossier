// Read and fill real application forms with a real browser.
//
// Why a browser at all: most application forms are rendered by JavaScript, so a
// plain fetch sees an empty shell. Verified - Anthropic's Greenhouse form has 30
// inputs, 4 textareas and a file upload that only exist after JS runs.
//
// What a browser does NOT do: defeat bot protection. Tesla's careers site
// returns 403 "Access Denied" to headless Chromium exactly as it does to fetch.
// That is reported honestly as a wall, never worked around.

import { chromium } from 'playwright';
import { assertAllowedUrl } from './net-guard.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let browserPromise = null;

// A browser that has been closed must not poison every later call. Playwright
// keeps returning the dead instance from the cached promise, so isConnected()
// is checked and a new one launched when needed.
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch {
      // fall through and relaunch
    }
    browserPromise = null;
  }
  browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

async function newPage() {
  let browser = await getBrowser();
  try {
    const probe = await browser.newContext();
    await probe.close();
  } catch {
    browserPromise = null;
    browser = await getBrowser();
  }
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
  });
  return { ctx, page: await ctx.newPage() };
}

// Runs in the page. Pulls the fields that actually exist after JS has run,
// with the label a human would read rather than the internal field name.
const EXTRACT_FIELDS = `(() => {
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = document.getElementById(labelledBy);
      if (t && t.innerText.trim()) return t.innerText.trim();
    }
    let n = el.previousElementSibling;
    for (let i = 0; i < 3 && n; i++, n = n.previousElementSibling) {
      if (/^(label|legend|h\\d|p|span|div)$/i.test(n.tagName) && n.innerText.trim()) {
        return n.innerText.trim();
      }
    }
    return el.getAttribute('placeholder') || el.name || el.id || '';
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    if (!visible(el) && type !== 'file') continue;

    const label = labelFor(el).replace(/\\s+/g, ' ').slice(0, 200);
    const key = label + '|' + type + '|' + (el.name || '');
    if (seen.has(key)) continue;
    seen.add(key);

    const field = {
      label,
      name: el.name || null,
      id: el.id || null,
      type: el.tagName.toLowerCase() === 'select' ? 'select'
          : el.tagName.toLowerCase() === 'textarea' ? 'textarea'
          : type,
      required: el.required || el.getAttribute('aria-required') === 'true'
                || /\\*/.test(label),
    };
    if (el.tagName.toLowerCase() === 'select') {
      field.options = [...el.options].map((o) => o.label || o.value).filter(Boolean).slice(0, 40);
    }
    if (type === 'radio' || type === 'checkbox') field.value = el.value || null;
    out.push(field);
  }

  const text = document.body.innerText || '';
  return {
    title: document.title,
    fields: out,
    formCount: document.querySelectorAll('form').length,
    // Wall signals, read from the live DOM rather than raw HTML.
    captcha: Boolean(
      document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, [data-sitekey], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]')
      || /recaptcha|hcaptcha|turnstile/i.test(document.documentElement.innerHTML)),
    accountWall: /create an account|sign in to apply|create account|candidate account|register to apply|already have an account/i.test(text),
    accessDenied: /access denied|forbidden|are you a robot|unusual traffic|blocked/i.test(text.slice(0, 2000)),
    textLength: text.length,
  };
})()`;

export async function inspectForm(url, { screenshot = true } = {}) {
  try { await assertAllowedUrl(url); }
  catch (err) {
    return { url, reachable: false, error: `blocked: ${err.message}`, fields: [],
             canAutoSubmit: false, wall: 'blocked' };
  }
  const { ctx, page } = await newPage();
  try {
    let status = null;
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = res?.status() ?? null;
    } catch (err) {
      return {
        url, reachable: false, httpStatus: status,
        error: `navigation failed: ${err.message.slice(0, 160)}`,
        fields: [], canAutoSubmit: false, wall: 'unreachable',
      };
    }

    await page.waitForTimeout(2500);
    const info = await page.evaluate(EXTRACT_FIELDS);

    // A page we cannot read is never treated as an application form.
    if (status && status >= 400) {
      return {
        url, reachable: false, httpStatus: status,
        pageTitle: info.title,
        error: `http ${status}`,
        botBlocked: info.accessDenied,
        fields: [], canAutoSubmit: false,
        wall: info.accessDenied ? 'bot-protection' : 'unreachable',
        note:
          'The application page did not load. A real browser was used and it was ' +
          'still refused, so this cannot be filled automatically.',
      };
    }

    let wall = null;
    if (info.captcha) wall = 'captcha';
    else if (info.accountWall) wall = 'account-required';
    else if (!info.fields.length) wall = 'no-form-found';

    return {
      url,
      reachable: true,
      httpStatus: status,
      pageTitle: info.title,
      formCount: info.formCount,
      fieldCount: info.fields.length,
      requiredCount: info.fields.filter((f) => f.required).length,
      fileUploads: info.fields.filter((f) => f.type === 'file').map((f) => f.label),
      fields: info.fields,
      captchaDetected: info.captcha,
      accountRequired: info.accountWall,
      wall,
      canAutoSubmit: wall === null,
      screenshotBase64: screenshot
        ? (await page.screenshot({ fullPage: false, type: 'png' })).toString('base64')
        : undefined,
    };
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------ fill and hold
//
// A filled form is held open, keyed by a fill id, so that the submit click
// lands on exactly the page a human approved - not on a re-filled reconstruction
// that might differ. Sessions expire so an abandoned approval cannot leak a
// browser context forever.

const FILL_TTL_MS = 30 * 60 * 1000;
const fills = new Map();

function sweepFills() {
  const now = Date.now();
  for (const [id, f] of fills) {
    if (now - f.createdAt > FILL_TTL_MS) {
      f.ctx.close().catch(() => {});
      fills.delete(id);
    }
  }
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Match an answer key to a field by label, name or id - tolerant, because the
// agent supplies human-readable keys like "First Name" for name="first_name".
function findAnswer(field, answers) {
  const keys = Object.keys(answers);
  // Empty or near-empty targets match everything under substring comparison,
  // which is how "Country" once ended up answering a visa-sponsorship question.
  // A wrong answer on a real application is worse than no answer, so short and
  // empty targets are dropped and fuzzy matching needs real overlap.
  const targets = [field.label, field.name, field.id]
    .filter(Boolean)
    .map(norm)
    .filter((t) => t.length >= 3);

  if (!targets.length) return undefined;

  for (const k of keys) {
    const nk = norm(k);
    if (nk.length >= 3 && targets.some((t) => t === nk)) return answers[k];
  }
  for (const k of keys) {
    const nk = norm(k);
    if (nk.length < 4) continue;
    // Require the answer key to be a substantial part of the target, not just
    // any shared substring: "country" must not match a 60-character question.
    if (targets.some((t) => t.startsWith(nk) || (t.includes(nk) && nk.length / t.length >= 0.5))) {
      return answers[k];
    }
  }
  return undefined;
}

export async function fillForm(url, { answers = {}, resumePath = null } = {}) {
  try { await assertAllowedUrl(url); }
  catch (err) { return { url, filled: false, error: `blocked: ${err.message}` }; }
  sweepFills();
  const { ctx, page } = await newPage();

  let status = null;
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = res?.status() ?? null;
  } catch (err) {
    await ctx.close();
    return { url, filled: false, error: `navigation failed: ${err.message.slice(0, 160)}` };
  }
  await page.waitForTimeout(2500);

  const info = await page.evaluate(EXTRACT_FIELDS);
  if (status && status >= 400) {
    await ctx.close();
    return {
      url, filled: false, httpStatus: status,
      wall: info.accessDenied ? 'bot-protection' : 'unreachable',
      error: `http ${status}`,
    };
  }

  const applied = [];
  const skipped = [];

  for (const field of info.fields) {
    if (field.type === 'file') {
      if (!resumePath) { skipped.push({ ...field, reason: 'no file supplied' }); continue; }
      try {
        const loc = field.id
          ? page.locator(`#${field.id.replace(/([^\w-])/g, '\\$1')}`)
          : field.name
            ? page.locator(`input[type=file][name="${field.name}"]`)
            : page.locator('input[type=file]').first();
        // Greenhouse and Ashby hide the real <input type=file> behind a styled
        // button, so it is not "visible" to Playwright's actionability check.
        // setInputFiles works on the hidden input directly.
        await loc.first().setInputFiles(resumePath, { timeout: 15000 });
        applied.push({
          label: field.label || 'file upload',
          type: 'file',
          value: resumePath.split('/').pop(),
        });
      } catch (err) {
        skipped.push({ ...field, reason: `upload failed: ${err.message.slice(0, 90)}` });
      }
      continue;
    }

    const answer = findAnswer(field, answers);
    if (answer === undefined || answer === null || answer === '') {
      if (field.required) skipped.push({ ...field, reason: 'no answer supplied' });
      continue;
    }

    const sel = field.id
      ? `#${field.id.replace(/([^\w-])/g, '\\$1')}`
      : field.name
        ? `[name="${field.name}"]`
        : null;
    if (!sel) { skipped.push({ ...field, reason: 'no selector' }); continue; }

    try {
      const loc = page.locator(sel).first();
      if (field.type === 'select') {
        await loc.selectOption({ label: String(answer) }, { timeout: 8000 });
      } else if (field.type === 'radio' || field.type === 'checkbox') {
        if (String(answer).toLowerCase() === String(field.value || '').toLowerCase()
            || String(answer).toLowerCase() === 'true') {
          await loc.check({ timeout: 8000 });
        } else continue;
      } else {
        await loc.fill(String(answer), { timeout: 8000 });
      }
      applied.push({ label: field.label, type: field.type, value: String(answer).slice(0, 120) });
    } catch (err) {
      skipped.push({ ...field, reason: `fill failed: ${err.message.slice(0, 80)}` });
    }
  }

  const shot = await page.screenshot({ fullPage: true, type: 'png' });

  let wall = null;
  if (info.captcha) wall = 'captcha';
  else if (info.accountWall) wall = 'account-required';

  const fillId = `fill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  fills.set(fillId, { ctx, page, url, createdAt: Date.now(), applied });

  return {
    fillId,
    url,
    filled: true,
    fieldsFilled: applied.length,
    requiredMissing: skipped.filter((s) => s.required).length,
    applied,
    skipped,
    wall,
    canSubmit: wall === null,
    screenshotBase64: shot.toString('base64'),
    note: wall
      ? `Form is filled but ${wall === 'captcha' ? 'a CAPTCHA' : 'an account wall'} blocks ` +
        'automated submission. Hand the filled form to the human for the final click.'
      : 'Form is filled and ready. Nothing has been submitted.',
  };
}

export function getFill(fillId) {
  sweepFills();
  return fills.get(fillId) ?? null;
}

export async function dropFill(fillId) {
  const f = fills.get(fillId);
  if (f) { await f.ctx.close().catch(() => {}); fills.delete(fillId); }
}
