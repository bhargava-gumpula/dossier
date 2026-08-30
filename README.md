# Dossier

**An agent that applies to jobs the way each specific company requires — and stops one click short.**

Built on [TrueForge](https://github.com/truefoundry/trueforge) for the
[Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge)
(WeMakeDevs × TrueFoundry).

You name a company. Dossier finds the real postings, works out how that employer actually
accepts applications, opens the real form in a real browser, tailors the résumé to the role,
fills every field — and then **stops and waits for a human to approve the submit.**

---

## The problem

Every company accepts applications differently. Some use Greenhouse, some Ashby, some Workday,
some Jobvite, some a homemade form on their own site, some just an email address. There is no
single "apply" API, and a tool that assumes one platform silently fails on most of the market.

So the hard part is not writing a cover letter. It is working out **how this particular employer
wants to be applied to**, then doing that — and doing it without inventing credentials the
candidate does not have.

## What it does

```
name a company ─▶ find_jobs ─▶ Greenhouse · Ashby · Workday · Jobvite   (direct board APIs)
                            └▶ web search of the employer's own site    (everyone else)
                                        │
                            detect_apply_route  ← fingerprints the APPLY URL, never the
                                        │          careers landing page
                                        ▼
       inspect_form → tailor_resume → fill_form → submit_form  ◀── HELD FOR A HUMAN
              (real browser)                          │
                                            dashboard approve → sent
```

1. **Finds real postings.** Reads published job boards directly where they exist; falls back to
   searching the employer's own domain for the many companies that publish nothing
   machine-readable. Aggregators (LinkedIn, Indeed, Glassdoor) are excluded — they are not the
   employer, and applying through them is a different act.
2. **Works out the route** by fingerprinting the real apply URL — never the careers landing page,
   which at most large companies is a JavaScript marketing shell that reveals nothing.
3. **Reads the actual form.** Greenhouse publishes a field schema, so it uses that when present.
   Otherwise it renders the page in a real headless browser and enumerates the fields that are
   genuinely there.
4. **Tailors the résumé** to that specific role — by *reordering and promoting* real experience,
   never by inventing it (see below).
5. **Fills every field** and attaches the tailored PDF.
6. **Stops at a human approval gate.** Nothing is submitted until a person clicks approve on the
   dashboard.

### Tailoring reorders; it never invents

`tailor_resume` can only promote skills and accomplishments already present in the candidate's
profile and résumé. Ask it to add a skill the candidate does not have and it refuses. This is
enforced in the tool, not left to the model's judgement, and it is checked live by the test suite
(section 9c: *real skill promoted / unheld skill refused / nothing lost / original untouched*).

A gap reported honestly is worth more than a claim the candidate cannot back in an interview.

## The two walls, and where applications actually go

Every major ATS gates final submission behind an employer credential or a CAPTCHA. That was
verified live across **Greenhouse, Ashby, Lever, SmartRecruiters, Workable and Recruitee**.

- **CAPTCHA** — Greenhouse's embedded form requires a reCAPTCHA Enterprise token minted in a real
  browser session. Defeating that is CAPTCHA bypass. This project does not do that.
- **Account creation** — Workday requires creating a candidate account with email verification
  before you can apply at all.

When Dossier hits either, it **stops, names the wall, and hands over a fully filled form.** It
never implies it submitted something it did not. An agent that silently "submitted" through a
CAPTCHA would be worse than useless, because you would believe you had applied when you had not.

**Where the approved submission goes.** The submission is *mechanically* real — a real browser, a
real form, a real multipart POST with the tailored PDF attached — but the destination is a local
sink (`demo/demo-employer.js`), not a live employer. Sending a synthetic candidate to a real
company would waste a real recruiter's time. The plumbing is genuine; the recipient is not.

---

## Quickstart

**Prerequisites:** Node 20+ (developed on v26), Python 3 (used by the registration script),
and a TrueForge instance. Model, sandbox and search credentials live in TrueForge's own local
settings — **no secrets are stored in this repo.**

```bash
git clone https://github.com/bhargava-gumpula/dossier.git
cd dossier
npm install
npx playwright install chromium     # the real browser used to read and fill forms

# The dashboard is served as a built bundle, and the build output is not in the
# repo - without this step the dashboard answers with nothing.
cd dashboard && npm install && npm run build && cd ..
```

Start TrueForge, then the four local processes. **Two of them need `DOSSIER_ALLOW_ORIGINS`**, or
the egress guard blocks the demo employer and applications cannot be delivered:

```bash
npx @truefoundry/trueforge                                                # :8790

node demo/demo-employer.js &                                              # :8795
DOSSIER_ALLOW_ORIGINS="http://127.0.0.1:8795" node mcp/jobs-server.js &    # :8793
DOSSIER_ALLOW_ORIGINS="http://127.0.0.1:8795" node mcp/apply-server.js &   # :8794
node dashboard/server.js &                                                # :5174

bash scripts/register-mcp-servers.sh    # registers both MCP servers and the agent
```

Then open **http://127.0.0.1:5174** — the landing page — and **/app** for the product itself.

In TrueForge's settings you need a model key, a Daytona sandbox key, and (for discovery beyond
the four direct board APIs) a Bright Data search connector. `scripts/set-sandbox-provider.sh` and
`scripts/add-search-connector.sh` configure the latter two.

### Verify it, don't take my word for it

```bash
node scripts/verify-all.mjs
```

62 live end-to-end checks against real job boards, a real browser and a real agent run — no
mocks, no fixtures standing in for network calls. It exits non-zero on regression. Most checks
exercise the MCP tools directly, so a full pass costs almost nothing in model spend; only
section 10 runs the agent.

```bash
bash scripts/verify-sandbox.sh
```

Proves the agent's execution is genuinely remote, rather than quietly running on the host.

**All 62 pass.** They run against live job boards, a real browser and a real agent turn, so an
occasional network wobble at an employer's end is possible; re-run before concluding anything.

One piece of history worth keeping, because it was the most misleading bug in the project. Section
10 failed intermittently for days and was written off as "the agent sometimes retries". It was
not. The harness wraps every MCP tool in a meta tool — an actual invocation is `call_tool`, while
`get_tool_info` merely reads a schema — and *both* carry the tool's name in
`arguments.tool_name`. The verifier preferred that field, so "look up `submit_form`'s schema"
counted as "call `submit_form`". Since the agent reads all six schemas before it starts, every
run reported the entire workflow twice and two submissions.

The agent had been correct the whole time. The check was wrong. It is fixed by deciding
meta-ness from the real function name before resolving the logical one — and it is a good
argument for reading a flaky test's evidence before believing its story.

---

## How it uses TrueForge

| Harness capability | Used | How |
| --- | --- | --- |
| **MCP connectors** | ✅ | Two local MCP servers — `dossier-jobs` (4 tools) and `dossier-apply` (6 tools) — plus a Bright Data search connector proxied through `mcp/lib/websearch.js`. |
| **Sandbox** | ✅ | Daytona. `sandbox.enabled` on the agent manifest; `scripts/verify-sandbox.sh` proves execution is actually remote. |
| **Approval gates** | ✅ | `require_approval_for_tools: ["submit_form"]`, pinned to the `dossier-apply` **server entry**. Exactly one tool is gated. |
| **ask-user-questions** | ✅ | The agent asks the human for values the profile genuinely lacks rather than inventing them. Handled in `dashboard/server.js`. |
| **Persistent sessions** | ✅ | One session per application; approval and follow-up arrive as later turns on that same session. |
| **Skills** | ❌ | Not used. Résumé tailoring is enforced in a *tool* so its constraints are mechanical rather than advisory. |
| **Subagents** | ❌ | Not used. The workflow is a single strict sequence; splitting it across agents would add failure modes without buying anything. |

The two ❌ rows are deliberate, not unfinished. Claiming capabilities the code does not use would
be easy and worthless.

### Things that cost hours to learn about the harness

Written down because they are not in the published docs, and cost real time:

1. **`require_approval_for_tools` belongs on the MCP *server* entry**, not on `config` or the
   `AgentSpec`. Set on config it is silently ignored, and TrueForge's default
   `["@write","@destructive"]` applies instead — which gates `tailor_resume` and `update_profile`
   too, so the agent stalls at a second, unexpected gate.
2. **`stream` defaults to `true`** on `POST /sessions/{id}/turns`. Without `"stream": false` you
   get SSE and it parses as nothing.
3. **`POST /sessions` takes `{"agent":{"name":…}}`**, not `agent_id`.
4. **Pause data is at `state.required_actions`** — snake_case, unlike the published docs.

More in [`docs/trueforge-api-notes.md`](./docs/trueforge-api-notes.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `mcp/jobs-server.js` | Discovery MCP: `find_jobs`, `search_jobs_on_web`, `fetch_blocked_page`, `detect_apply_route` |
| `mcp/apply-server.js` | Application MCP: `get_candidate_profile`, `update_profile`, `tailor_resume`, `inspect_form`, `fill_form`, `submit_form` |
| `mcp/lib/` | Board APIs, route fingerprinting, browser control, résumé tailoring, egress guard |
| `dashboard/` | The product UI and the approval gate (`:5174`) |
| `demo/demo-employer.js` | Local sink that receives approved applications (`:8795`) |
| `agent/dossier.agent.json` | Agent manifest — instructions, gate, sandbox, iteration limit |
| `fixtures/persona/` | **Synthetic** demo candidate (`avery.okonkwo@example.com`) |
| `scripts/verify-all.mjs` | 62 live end-to-end checks |

Real résumés upload into `private/`, which is gitignored. No personal data and no keys are in
this repository.

## Security notes

- **Egress guard.** Tools that fetch URLs refuse cloud metadata endpoints, `file://`, and the
  local TrueForge control plane, so a malicious posting cannot use the agent to read the host's
  private network. It denies private and loopback ranges rather than allowing a list of hosts, so
  the open web still works. Verified live (section 6). Covered: the initial URL, every hop of a
  server-side redirect, every page subresource, and wherever the page finally lands. The precise
  limit is worth stating — on a redirect the request is still *issued* before the destination is
  known, so a blocked hop stops the contents being reported, not the packet being sent. Blind
  timing remains observable; content does not come back.
- **No CAPTCHA solving and no account creation.** Both walls are reported honestly instead.
- **No secrets in the repo.** All three credentials live in TrueForge's own local database.

## Qodo Code Review Evidence

Every substantive change in this project went through
**[PR #2](https://github.com/bhargava-gumpula/dossier/pull/2)** (40 files, ~7,300 lines), which
was reviewed by **Qodo** via `/agentic_review` and merged only afterwards. `main` is
branch-protected with `enforce_admins: true`, so nothing reaches it any other way.

Qodo raised **26 findings**. Five were already fixed by later commits on the branch and one was
outdated by the time the review settled, leaving **20 live**. All 20 were worked: **19 fixed**, and
**one was not a bug**.

Each was checked against the code before being believed. That mattered — Qodo's line numbers point
at the PR diff rather than current `HEAD`, and one location had drifted onto unrelated code.

### Security

| # | What it actually was | How it was proved |
| --- | --- | --- |
| **9** | The guard checked the URL it was handed, then `page.goto` followed redirects anywhere. A posting could bounce the browser onto loopback and have the contents read back. | The obvious fix does not work: Playwright raises **no route event for a main-frame redirect**. The chain is walked after navigation via `redirectedFrom()`. A/B against two local servers: destination not allowlisted → 0 fields, `wall: blocked`; allowlisted → all 3. |
| **10** | DNS rebinding. The guard resolved a name, approved it, and `fetch` resolved it again when connecting — so the vetted address and the used address could differ. | The address the socket uses is now the vetted one, via an undici dispatcher that refuses blocked ranges at connect time. Proved with `localtest.me` and `127.0.0.1.nip.io` — public names resolving to `127.0.0.1` — refused with the pre-check bypassed, while `example.com` still returns 200. |
| **6** | `fill_form` claimed `readOnlyHint`, but it types into a page this project does not control, whose scripts can transmit values before the gate. | Annotation corrected. Verified it does *not* create a second gate: the server entry pins `submit_form` explicitly. |

### Correctness

| # | What it actually was |
| --- | --- |
| **8** | The submit-time re-check read the page text and then tested only for a CAPTCHA, so an account wall fell through to a generic "Apply" control on a sign-in page and reported success for an application nobody received. |
| **2** | The dashboard set `submitted` the moment the approval turn was accepted — so it claimed an application had been sent whenever a human clicked approve, even when `submit_form` then refused a CAPTCHA. Submission is now read back from the tool's own result. |
| **3** | A failed résumé rebuild left the profile ahead of the PDF, combining new answers with the old attachment. The snapshot is now restored. |
| **22** | Only `op` was required, so an edit with no value persisted `null`, printed "null" on the résumé, and made later edits throw. |
| **4** | `fill_form` returned `fillId` while its schema and `submit_form` both say `fill_id`. |
| **11** | Workday pagination turned a failed page into an empty one, so roles on a timed-out page vanished from a result still presented as complete. |
| **7** | The wall path said "hand the filled form to the human", but the fill lives in a headless context nobody can type into. It now says so, and hands over the URL, the reason and the values. |
| **15** | `"The Browser Company"` — the example in the comment directly above the function — never probed `thebrowsercompany`. |
| **24** | The demo sink echoed the submitted name into HTML unescaped. |
| **26** | `slice(0, -1)` means "all but the last", so asking for `-1` jobs returned nearly all of them. |

### Reliability

| # | What it actually was |
| --- | --- |
| **1**, **20** | Queue writes are read-whole-file/mutate/write-whole-file and "Start all" fired them together, so the last write erased `sessionId`s the others had recorded, orphaning live agent sessions. Mutations are serialised; starting an already-working job is refused. Twelve concurrent adds now all survive. |
| **21** | `update_profile` had the same shape, with batched MCP calls running concurrently. Serialised the same way. |
| **14** | `req.destroy()` emits neither `end` nor reliably `error`, so the promise never settled and the connection hung forever. A 5MB body is now refused in 10ms. |
| **25** | The 20s abort signal covered `fetch` but not the DNS lookup before it. The lookup has its own deadline. |

### The one that was not a bug

**#16** claimed nothing registers `dossier-jobs` on a clean install.
[`scripts/register-mcp-servers.sh`](./scripts/register-mcp-servers.sh) does exactly that, by URL,
and the quickstart above says to run it. Qodo read the agent manifest without the script. Recorded
rather than "fixed", because agreeing with a review you have checked and found wrong is worse than
disagreeing with it.

**#23** — the guard's allowlist being empty by default, which the demo needs — was documented in
`.env.example` and the quickstart rather than changed. Defaulting it open would undo the property
that makes the guard worth having.

## AI assistance disclosure

Per hackathon rule 12: **Claude Code was used throughout** — for implementation, debugging,
verification and this documentation. Architecture and technical decisions are the author's, are
understood, and can be explained on request (rule 13). The harness findings above are examples:
they were derived by reading TrueForge's behaviour against its docs, and they are why the
approval gate works.

## License

[MIT](./LICENSE)
