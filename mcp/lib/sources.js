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
  return [...new Set([base, hyphen])].filter(Boolean);
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
  const postings = [...first.jobPostings];
  for (let i = 0; i < offsets.length; i += 5) {
    const batch = await Promise.all(
      offsets.slice(i, i + 5).map((o) => workdayPage(origin, slug, site, o, limit)),
    );
    postings.push(...batch.flatMap((r) => r?.jobPostings ?? []));
    if (postings.length >= maxJobs) break;
  }

  return postings.slice(0, maxJobs).map((j) => ({
    source: 'workday',
    board: `${slug}/${site}`,
    id: (j.bulletFields ?? [])[0] ?? j.externalPath,
    title: j.title,
    location: j.locationsText ?? null,
    applyUrl: `${origin}/en-US/${site}${j.externalPath}`,
    postedOn: j.postedOn ?? null,
  }));
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
    );
  }
  const results = (await Promise.all(probes)).filter(Boolean);
  if (!results.length) return { found: false, company, triedSlugs: slugs };
  // Prefer Greenhouse: it is the only source that publishes a form schema.
  const rank = { greenhouse: 0, ashby: 1, workday: 2 };
  results.sort((a, b) => rank[a.source] - rank[b.source]);
  const best = results[0];
  return { found: true, company, source: best.source, board: best.slug, jobs: best.jobs };
}
