// Ranking postings against the candidate's own résumé.
//
// Why this exists: asking a board for "backend engineer" and keeping every
// title that shares ANY word with the query returns a wall of loosely related
// reqs - "Technical Recruiter | Engineering" scores the same as a real backend
// role because both contain "engineer". That reads as generic filler, and it
// buries the two roles the person is actually right for.
//
// So the board is fetched whole and ranked here instead, against what the
// candidate has actually done. It is deliberately deterministic - no model
// call - so the picker stays instant and free, and every score can be
// explained back to the human as the terms that produced it.
//
// This ranks TITLES, not descriptions. Fetching every description would be one
// request per posting. That limit is stated in the UI rather than hidden.

// Words that appear in almost every engineering title and so separate nothing.
const GENERIC = new Set([
  'engineer', 'engineering', 'senior', 'staff', 'software', 'developer',
  'manager', 'lead', 'sr', 'jr', 'i', 'ii', 'iii', 'iv', 'and', 'the', 'of',
  'at', 'for', 'to', 'a', 'an', 'in', 'on', 'with',
  // Real words, but so broad that on their own they match almost anything.
  'systems', 'system', 'platform', 'product', 'service', 'services', 'data',
]);

// The title says what the job IS. A product area that merely mentions another
// department ("Software Engineer, Backend, Marketing Product") must not be
// mistaken for that department's own req, so this is only ever applied to
// titles that are not themselves engineering roles.
const OFF_FUNCTION = /recruit|talent acquisition|\bsales\b|account executive|account manager|\bmarketing\b|counsel|\blegal\b|paralegal|accountant|accounting|controller|procurement|treasury|customer success|support specialist|office manager|executive assistant/i;

const ENGINEERING = /\bengineer\b|\bengineering\b|\bdeveloper\b|\barchitect\b|\bsre\b|programmer/i;

const TOO_JUNIOR = /\bintern\b|internship|new grad|university grad|apprentice|\bjunior\b/i;
const TOO_SENIOR = /\bdirector\b|\bvp\b|vice president|head of|\bchief\b|\bcto\b|distinguished|\bfellow\b/i;
const SENIOR_HINT = /\bsenior\b|\bsr\.?\b|\bstaff\b/i;

// Broad areas of work. A résumé rarely shares literal words with a job title,
// so matching only on shared words misses obvious fits - a payments engineer
// who knows Kafka and Kubernetes is clearly right for "Software Engineer, Data
// Platform" even though that title contains none of their skills verbatim.
const FAMILIES = {
  backend: /backend|back-end|server-?side|\bapi\b|distributed|micro-?services|\bcore\b/i,
  infrastructure: /infra|infrastructure|kubernetes|\bcloud\b|devops|\bsre\b|reliability|observability|terraform|platform/i,
  data: /\bdata\b|streaming|kafka|pipeline|analytics|warehouse|\betl\b/i,
  payments: /payment|billing|ledger|transaction|fintech|\bcard\b|settlement|money|invoic/i,
  security: /security|fraud|identity|privacy|\bauth\b/i,
};

const words = (s) =>
  String(s ?? '').toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean);

/**
 * Turn a profile into weighted terms plus the areas the person has actually
 * worked in. Skills and held titles carry the most signal; words mined from
 * their bullets carry a little.
 */
export function buildSignal(profile) {
  const terms = new Map();
  const bump = (term, w) => {
    if (!term) return;
    terms.set(term, Math.max(terms.get(term) ?? 0, w));
  };

  for (const skill of profile?.skills ?? []) {
    // Multi-word skills ("payments infrastructure") are matched as a phrase,
    // which is a far stronger signal than either word alone.
    bump(String(skill).toLowerCase(), 3);
    for (const w of words(skill)) if (!GENERIC.has(w) && w.length > 2) bump(w, 2);
  }

  for (const job of profile?.experience ?? []) {
    for (const w of words(job.title)) {
      if (w.length < 3) continue;
      bump(w, GENERIC.has(w) ? 0.5 : 2.5);
    }
    for (const bullet of job.bullets ?? []) {
      for (const w of words(bullet)) {
        if (w.length < 5 || GENERIC.has(w)) continue;
        bump(w, 0.6);
      }
    }
  }

  // Everything the résumé says, for deciding which areas they have worked in.
  const corpus = [
    ...(profile?.skills ?? []),
    ...(profile?.experience ?? []).flatMap((j) => [j.title, j.company, ...(j.bullets ?? [])]),
  ].join(' ');

  const families = Object.keys(FAMILIES).filter((f) => FAMILIES[f].test(corpus));
  const isEngineer = (profile?.experience ?? []).some((j) => ENGINEERING.test(j.title ?? ''));

  return { terms, families, isEngineer, years: Number(profile?.yearsExperience) || 0 };
}

/**
 * Score one title. Returns the score and the reasons that earned it, so the UI
 * can show why a role surfaced instead of asking for trust.
 */
export function scorePosition(position, signal, role) {
  const title = String(position.title ?? '');
  const lower = title.toLowerCase();
  const isEngRole = ENGINEERING.test(title);
  let score = 0;
  const reasons = [];

  // Being in the right function at all is the single biggest signal, and no
  // amount of keyword overlap should outweigh it.
  if (signal.isEngineer && isEngRole) score += 4;

  // Areas of work they have actually done. Capped, so a title that happens to
  // touch four of them cannot outrank a direct hit.
  let familyScore = 0;
  for (const f of signal.families) {
    if (!FAMILIES[f].test(title)) continue;
    familyScore += 3;
    reasons.push(f);
  }
  score += Math.min(familyScore, 6);

  for (const [term, weight] of signal.terms) {
    if (!lower.includes(term)) continue;
    score += weight;
    if (weight >= 2.5) reasons.push(term);
  }

  // What they typed still matters, and outranks résumé inference - the person
  // asking for "backend" gets backend, even if their résumé is broader.
  if (role) {
    const rw = words(role).filter((w) => !GENERIC.has(w));
    if (rw.length && rw.every((w) => lower.includes(w))) {
      score += 5;
      reasons.unshift(`you asked for "${role}"`);
    } else {
      for (const w of rw) if (lower.includes(w)) score += 2;
    }
  }

  if (signal.isEngineer && !isEngRole && OFF_FUNCTION.test(title)) score -= 10;
  if (signal.years >= 4 && TOO_JUNIOR.test(title)) score -= 8;
  if (signal.years < 12 && TOO_SENIOR.test(title)) score -= 5;
  if (signal.years >= 5 && SENIOR_HINT.test(title)) score += 1.5;

  // Dedupe while keeping the strongest first.
  const seen = new Set();
  const clean = reasons.filter((r) => !seen.has(r) && seen.add(r)).slice(0, 4);
  return { score: Number(score.toFixed(2)), reasons: clean };
}

/**
 * Rank a whole board. Everything is returned - ordered, never dropped - plus
 * the short list worth acting on. Hiding the remainder would repeat the bug
 * this replaces, just in the other direction.
 */
export function rankPositions(positions, profile, role, { topN = 5 } = {}) {
  if (!profile || !(profile.skills?.length || profile.experience?.length)) {
    return { ranked: positions, bestFits: [], matched: false };
  }

  const signal = buildSignal(profile);
  const ranked = positions
    .map((p) => ({ ...p, ...scorePosition(p, signal, role) }))
    .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));

  // A "best fit" has to clear a real bar, not merely top a bad list. If
  // nothing clears it the short list is empty and the UI says so, rather than
  // promoting whatever happened to sort first.
  const floor = Math.max(8, (ranked[0]?.score ?? 0) * 0.6);
  const bestFits = ranked.filter((p) => p.score >= floor).slice(0, topN);

  return { ranked, bestFits, matched: true };
}
