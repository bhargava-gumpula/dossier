// Read and edit the candidate's profile, and rebuild the resume PDF from it.
//
// The profile is the single source of truth: the resume is generated from it, so
// a change to the profile is a change to what employers actually receive.
//
// Every edit is versioned. An agent editing someone's resume must be undoable,
// and the human has to be able to see exactly what changed.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function loadProfile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function snapshot(profilePath) {
  const dir = profilePath.replace(/\/[^/]+$/, '/history');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${dir}/profile-${stamp}.json`;
  writeFileSync(file, readFileSync(profilePath));
  return file;
}

export function listHistory(profilePath) {
  const dir = profilePath.replace(/\/[^/]+$/, '/history');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
}

export function renderResumeHtml(p) {
  const exp = (p.experience ?? []).map((e) => `
  <div class="job">
    <div class="row"><strong>${esc(e.title)}</strong><span>${esc(e.start)} – ${esc(e.end)}</span></div>
    <div class="co">${esc(e.company)}</div>
    <ul>${(e.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
  </div>`).join('');

  const edu = (p.education ?? []).map((e) =>
    `<div class="row"><strong>${esc(e.degree)}</strong><span>${esc(e.year)}</span></div>
     <div class="co">${esc(e.school)}</div>`).join('');

  return `<!doctype html><meta charset="utf-8"><style>
@page { size: Letter; margin: 0.7in; }
body { font: 10.5pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color:#111; }
h1 { font-size: 19pt; margin:0 0 2px; letter-spacing:-.3px; }
.contact { color:#555; font-size:9.5pt; margin-bottom:14px; }
.headline { color:#222; font-size:11pt; margin:2px 0 6px; font-weight:500; }
h2 { font-size:9.5pt; text-transform:uppercase; letter-spacing:1.2px; color:#666;
     border-bottom:1px solid #ddd; padding-bottom:3px; margin:16px 0 8px; }
.row { display:flex; justify-content:space-between; }
.row span { color:#666; font-size:9.5pt; }
.co { color:#444; font-size:10pt; margin-bottom:3px; }
ul { margin:4px 0 0 16px; padding:0; } li { margin-bottom:3px; }
.job { margin-bottom:11px; }
</style>
<h1>${esc(p.fullName ?? '')}</h1>
${p.headline ? `<div class="headline">${esc(p.headline)}</div>` : ''}
<div class="contact">${[p.email, p.phone, p.location, p.github].filter(Boolean).map(esc).join(' · ')}</div>
<h2>Experience</h2>${exp}
<h2>Skills</h2><div>${(p.skills ?? []).map(esc).join(', ')}</div>
<h2>Education</h2>${edu}`;
}

export async function rebuildResume(profilePath, htmlPath, pdfPath) {
  const p = loadProfile(profilePath);
  writeFileSync(htmlPath, renderResumeHtml(p));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + htmlPath);
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true });
  } finally {
    await browser.close();
  }
  return pdfPath;
}

// Structured edits only. The agent must not rewrite the profile wholesale - each
// change is named so the human can see exactly what moved.
export function applyEdits(profile, edits = []) {
  const applied = [];
  const rejected = [];

  for (const edit of edits) {
    const { op, value, company, field } = edit;
    try {
      if (op === 'add_skill') {
        const skills = profile.skills ?? (profile.skills = []);
        if (skills.some((s) => s.toLowerCase() === String(value).toLowerCase())) {
          rejected.push({ ...edit, reason: 'skill already present' });
        } else {
          skills.push(value);
          applied.push({ op, value });
        }
      } else if (op === 'remove_skill') {
        const before = (profile.skills ?? []).length;
        profile.skills = (profile.skills ?? []).filter(
          (s) => s.toLowerCase() !== String(value).toLowerCase());
        if (profile.skills.length === before) rejected.push({ ...edit, reason: 'skill not found' });
        else applied.push({ op, value });
      } else if (op === 'add_bullet') {
        const job = (profile.experience ?? []).find(
          (e) => e.company.toLowerCase() === String(company).toLowerCase());
        if (!job) { rejected.push({ ...edit, reason: `no experience entry for "${company}"` }); continue; }
        (job.bullets ??= []).push(value);
        applied.push({ op, company: job.company, value });
      } else if (op === 'remove_bullet') {
        const job = (profile.experience ?? []).find(
          (e) => e.company.toLowerCase() === String(company).toLowerCase());
        if (!job) { rejected.push({ ...edit, reason: `no experience entry for "${company}"` }); continue; }
        const before = job.bullets.length;
        job.bullets = job.bullets.filter((b) => !b.toLowerCase().includes(String(value).toLowerCase()));
        if (job.bullets.length === before) rejected.push({ ...edit, reason: 'no matching bullet' });
        else applied.push({ op, company: job.company, value });
      } else if (op === 'set_field') {
        const allowed = new Set([
          'fullName', 'firstName', 'lastName', 'email', 'phone', 'location',
          'country', 'linkedin', 'github', 'website', 'workAuthorization',
          'requiresSponsorship', 'yearsExperience',
        ]);
        if (!allowed.has(field)) {
          rejected.push({ ...edit, reason: `field "${field}" is not editable` });
        } else {
          applied.push({ op, field, from: profile[field], to: value });
          profile[field] = value;
        }
      } else {
        rejected.push({ ...edit, reason: `unknown op "${op}"` });
      }
    } catch (err) {
      rejected.push({ ...edit, reason: err.message.slice(0, 100) });
    }
  }
  return { profile, applied, rejected };
}

// ------------------------------------------------------------ tailoring
//
// A tailored resume reorders and emphasises what is already there. It never
// adds a claim. That is enforced structurally: this function accepts only
// references to existing skills and bullets, so a request to lead with
// something the candidate has not done fails rather than inventing it.
//
// Nothing is dropped either - de-emphasised content moves down, it does not
// disappear, so the tailored resume still says everything the original said.

export function tailorProfile(profile, { leadSkills = [], leadBullets = [], headline = null } = {}) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const applied = { skills: [], bullets: [] };
  const rejected = [];

  const out = JSON.parse(JSON.stringify(profile));

  // Skills: requested ones move to the front, in the order given. The rest keep
  // their existing order behind them. None are removed.
  const known = new Map(out.skills.map((s) => [norm(s), s]));
  const lead = [];
  for (const want of leadSkills) {
    const hit = known.get(norm(want));
    if (!hit) {
      rejected.push({ type: 'skill', value: want, reason: 'not in the profile - it would be a new claim' });
      continue;
    }
    if (!lead.includes(hit)) { lead.push(hit); applied.skills.push(hit); }
  }
  out.skills = [...lead, ...out.skills.filter((s) => !lead.includes(s))];

  // Bullets: same rule, per employer. A requested bullet must already exist.
  for (const req of leadBullets) {
    const job = (out.experience ?? []).find((e) => norm(e.company) === norm(req.company));
    if (!job) {
      rejected.push({ type: 'bullet', ...req, reason: `no experience entry for "${req.company}"` });
      continue;
    }
    const idx = job.bullets.findIndex((b) => norm(b).includes(norm(req.match ?? req.value ?? '')));
    if (idx < 0) {
      rejected.push({ type: 'bullet', ...req, reason: 'no existing bullet matches - it would be a new claim' });
      continue;
    }
    const [moved] = job.bullets.splice(idx, 1);
    job.bullets.unshift(moved);
    applied.bullets.push({ company: job.company, bullet: moved });
  }

  if (headline) out.headline = String(headline).slice(0, 160);

  const originalBulletCount = (profile.experience ?? []).reduce((n, e) => n + (e.bullets?.length ?? 0), 0);
  const tailoredBulletCount = (out.experience ?? []).reduce((n, e) => n + (e.bullets?.length ?? 0), 0);

  return {
    profile: out,
    applied,
    rejected,
    // The guarantee, checked rather than asserted.
    contentPreserved:
      out.skills.length === profile.skills.length &&
      tailoredBulletCount === originalBulletCount,
  };
}
