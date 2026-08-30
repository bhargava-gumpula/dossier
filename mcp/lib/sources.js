// Job discovery across the public board APIs, plus company-name resolution.
//
// Every endpoint here is public and unauthenticated. None of them is scraped:
// these APIs exist so companies can build their own careers pages, which is
// exactly what we are doing on the candidate's behalf.
//
// Verified live 29 Aug 2026:
//   Greenhouse  571 jobs @ anthropic   + full application form schema
//   Ashby       758 jobs @ openai      listings only
//   Workday    2000 jobs @ nvidia      listings only
//   Lever       failed on 7 of 8 real company boards - deliberately not supported

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15000;

async function getJson(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { accept: 'application/json', 'user-agent': UA, ...(opts.headers ?? {}) },
      body: opts.body,
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// "Ramp"  ->  "ramp"      "The Browser Company" -> "thebrowsercompany"
export function slugify(company) {
  return company
    .toLowerCase()
    .replace(/[''’]/g, '')
    .replace(/\b(inc|llc|ltd|corp|co|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Candidate slugs to probe, most likely first.
export function slugCandidates(company) {
  const base = slugify(company);
  const hyphen = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // slugify() strips filler words, which is right for "Coinbase Inc" and wrong
  // for a company whose name really starts with one: "The Browser Company"
  // became "browsercompany", so its actual board, thebrowsercompany, was never
  // probed. Keep the stripped form first, but try the intact one as well.
  const intact = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [...new Set([base, intact, hyphen])].filter(Boolean);
}

export async function greenhouseJobs(slug) {
  const d = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`);
  if (!d?.jobs?.length) return null;
  return d.jobs.map((j) => ({
    source: 'greenhouse',
    board: slug,
    id: String(j.id),
    title: j.title,
    location: j.location?.name ?? null,
    applyUrl: j.absolute_url,
    updatedAt: j.updated_at ?? null,
  }));
}

export async function ashbyJobs(slug) {
  const d = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
  if (!d?.jobs?.length) return null;
  return d.jobs.map((j) => ({
    source: 'ashby',
    board: slug,
    id: j.id,
    title: j.title,
    location: j.location ?? null,
    applyUrl: j.applyUrl || j.jobUrl,
    description: j.descriptionPlain ?? null,
  }));
}

// Workday tenants live at <tenant>.wdN.myworkdayjobs.com and the site name
// varies per company, so both have to be probed. The site name is the awkward
// part: NVIDIA's is "NVIDIAExternalCareerSite", i.e. the tenant upper-cased
// with a suffix, which no single lower-case pattern would ever find.
// All combinations are probed concurrently - serial probing cost ~5s per company.
const WORKDAY_HOSTS = ['wd1', 'wd5', 'wd3', 'wd2'];

function workdaySites(slug) {
  const upper = slug.toUpperCase();
  const title = slug.charAt(0).toUpperCase() + slug.slice(1);
  return [...new Set([
    `${upper}ExternalCareerSite`,
    `${title}ExternalCareerSite`,
    `${slug}ExternalCareerSite`,
    'ExternalCareerSite',
    'External_Career_Site',
    'External',
    'Careers',
    'careers',
    slug,
  ])];
}

// Workday caps a page at 20; role matching over only the first page silently
// reports real requisitions as absent on large boards (NVIDIA has 2000+).
async function workdayPage(origin, slug, site, offset, limit) {
  return getJson(`${origin}/wday/cxs/${slug}/${site}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }),
    timeoutMs: 8000,
  });
}

export async function workdayJobs(slug, { limit = 20, maxJobs = 200 } = {}) {
  // Two stages on purpose. Probing every host/site combination while ALSO
  // paginating each one fires ~360 concurrent requests, most of which time out
  // and silently return short results. So: find the live board with one cheap
  // request each, then paginate only the board that answered.
  const attempts = [];
  for (const host of WORKDAY_HOSTS) {
    for (const site of workdaySites(slug)) attempts.push({ host, site });
  }

  const found = (await Promise.all(attempts.map(async ({ host, site }) => {
    const origin = `https://${slug}.${host}.myworkdayjobs.com`;
    const d = await workdayPage(origin, slug, site, 0, limit);
    return d?.jobPostings?.length ? { origin, site, first: d } : null;
  }))).find(Boolean);

  if (!found) return null;

  const { origin, site, first } = found;
  const total = Math.min(first.total ?? first.jobPostings.length, maxJobs);
  const offsets = [];
  for (let o = limit; o < total; o += limit) offsets.push(o);

  // Paginate the one live board in small concurrent batches.
  //
  // A page that fails and a page that is genuinely empty both used to arrive
  // here as "nothing", so a timed-out page silently removed its roles and the
  // result was still presented as the complete list. find_jobs could then say
  // there was no matching requisition when there was one, on a page that never
  // loaded. Failures are retried once and whatever is still missing is reported.
  const postings = [...first.jobPostings];
  const failed = [];
  for (let i = 0; i < offsets.length; i += 5) {
    const slice = offsets.slice(i, i + 5);
    const batch = await Promise.all(slice.map((o) => workdayPage(origin, slug, site, o, limit)));
    batch.forEach((r, k) => {
      if (r?.jobPostings) postings.push(...r.jobPostings);
      else failed.push(slice[k]);
    });
    if (postings.length >= maxJobs) break;
  }

  if (failed.length) {
    const retried = await Promise.all(failed.map((o) => workdayPage(origin, slug, site, o, limit)));
    const stillFailed = [];
    retried.forEach((r, k) => {
      if (r?.jobPostings) postings.push(...r.jobPostings);
      else stillFailed.push(failed[k]);
    });
    failed.length = 0;
    failed.push(...stillFailed);
  }

  const jobs = postings.slice(0, maxJobs).map((j) => ({
    source: 'workday',
    board: `${slug}/${site}`,
    id: (j.bulletFields ?? [])[0] ?? j.externalPath,
    title: j.title,
    location: j.locationsText ?? null,
    applyUrl: `${origin}/en-US/${site}${j.externalPath}`,
    postedOn: j.postedOn ?? null,
  }));

  // Carried on the array so callers keep the plain list they expect, and can
  // still tell the human the listing was partial rather than implying it was all.
  if (failed.length) {
    jobs.incomplete = true;
    jobs.missingPages = failed.length;
  }
  return jobs;
}

// Jobvite publishes no JSON feed, but its board pages carry a stable link shape
// (/{company}/job/{id}) with the title in the anchor text, so the listing can be
// read from the HTML without a browser. Nutanix is on Jobvite.
//
// Jobvite intermittently bounces a valid board to its job-seeker support page
// with a 303 instead of serving it. Because the fetch follows redirects, that
// arrives as a perfectly good 200 carrying no job links, and the caller reported
// "this employer has no Jobvite board" - the one answer that is definitely
// wrong. Nutanix resolved to nothing on roughly one call in three this way.
//
// A bounce cannot be told apart from a company that genuinely is not on Jobvite,
// since both land on the same support page, so the only remedy is to ask again:
// a real absence still answers the same way on the retry and still returns null,
// a blip resolves. Landing anywhere other than the requested board counts as a
// bounce, as does a thrown fetch.
async function getBoardHtml(url, isBoard, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: ctl.signal,
      });
      if (res.ok && isBoard(res.url)) return await res.text();
      if (attempt === attempts) return null;
    } catch {
      if (attempt === attempts) return null;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return null;
}

export async function jobviteJobs(slug) {
  const url = `https://jobs.jobvite.com/${encodeURIComponent(slug)}`;
  const onBoard = (landed) => {
    try { return new URL(landed).pathname.toLowerCase().startsWith(`/${slug.toLowerCase()}`); }
    catch { return false; }
  };
  const html = await getBoardHtml(url, onBoard);
  if (!html) return null;

  const re = new RegExp(
    `<a[^>]+href="(/${slug}/job/([A-Za-z0-9]+))"[^>]*>([\\s\\S]{0,200}?)</a>`, 'gi');
  const jobs = [];
  const seen = new Set();
  for (const m of html.matchAll(re)) {
    const [, href, id, inner] = m;
    const title = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || seen.has(id)) continue;
    seen.add(id);
    jobs.push({
      source: 'jobvite',
      board: slug,
      id,
      title,
      location: null,
      applyUrl: `https://jobs.jobvite.com${href}`,
    });
  }
  return jobs.length ? jobs : null;
}

// Last resort when no public board answers: find where the company actually
// posts jobs, so the answer is "here is their careers site" rather than a dead
// end. Many large employers self-host (Nutanix, Shopify, Atlassian all do), and
// those sites cannot be enumerated without per-vendor work - but the rest of the
// pipeline works fine from a job URL, so pointing the human at the right place
// is genuinely useful.
async function findCareersSite(slug) {
  const candidates = [
    `https://careers.${slug}.com`,
    `https://jobs.${slug}.com`,
    `https://www.${slug}.com/careers`,
    `https://${slug}.com/careers`,
  ];
  const probe = async (url) => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      return res.ok ? res.url : null;
    } catch { return null; }
  };
  const results = await Promise.all(candidates.map(probe));
  return results.find(Boolean) ?? null;
}

// Try every source for a company name. Returns the first board that answers.
export async function resolveCompany(company) {
  const slugs = slugCandidates(company);
  const probes = [];
  for (const slug of slugs) {
    probes.push(
      greenhouseJobs(slug).then((jobs) => (jobs ? { source: 'greenhouse', slug, jobs } : null)),
      ashbyJobs(slug).then((jobs) => (jobs ? { source: 'ashby', slug, jobs } : null)),
      workdayJobs(slug).then((jobs) => (jobs ? { source: 'workday', slug, jobs } : null)),
      jobviteJobs(slug).then((jobs) => (jobs ? { source: 'jobvite', slug, jobs } : null)),
    );
  }
  const results = (await Promise.all(probes)).filter(Boolean);

  if (!results.length) {
    const careersUrl = await findCareersSite(slugs[0]);
    return {
      found: false,
      company,
      triedSlugs: slugs,
      careersUrl,
      reason: careersUrl
        ? 'This employer does not publish a machine-readable job board. Their ' +
          'careers site is self-hosted, so roles cannot be listed automatically.'
        : 'No public job board and no careers site found at the usual addresses.',
      whatToDo: careersUrl
        ? `Open ${careersUrl}, find the role, and give me its URL. Everything after ` +
          'that - reading the form, filling it and the approval gate - works exactly the same.'
        : 'Give me the job URL directly and I will handle the rest.',
    };
  }
  // Prefer Greenhouse: it is the only source that publishes a form schema.
  const rank = { greenhouse: 0, ashby: 1, workday: 2, jobvite: 3 };
  results.sort((a, b) => rank[a.source] - rank[b.source]);
  const best = results[0];
  return {
    found: true, company, source: best.source, board: best.slug, jobs: best.jobs,
    // Propagate a partial listing so the caller does not present it as the lot.
    ...(best.jobs.incomplete
      ? { incomplete: true,
          note: `${best.jobs.missingPages} page(s) of this board did not load, so this list may be missing roles.` }
      : {}),
  };
}
