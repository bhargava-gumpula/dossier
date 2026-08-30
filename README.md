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

**One known source of variance, named rather than hidden.** Section 10 runs the real agent, and
a model that retries after a transient MCP error can call `submit_form` twice; the approved
submission then does not land and three assertions fail together. It is model-dependent —
noticeably more frequent on `claude-haiku-4-5`, which was used to keep iteration cheap. A clean
run shows exactly `get_candidate_profile → detect_apply_route → inspect_form → tailor_resume →
fill_form → submit_form`: one submit, nothing after approval.

Worth knowing when reading a failure there: the *tailored résumé was sent* assertion inspects the
last record in the sink, so when the submit does not land it reports a stale record from an
earlier run and fails as a consequence of the first failure, not on its own. Tailoring is proven
independently by sections 9b and 9c.

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
  local TrueForge control plane — so a malicious job posting cannot turn the browser into a
  confused deputy against the host. Verified live (section 6).
- **No CAPTCHA solving and no account creation.** Both walls are reported honestly instead.
- **No secrets in the repo.** All three credentials live in TrueForge's own local database.

## Qodo Code Review Evidence

<!-- FILLED IN AFTER THE QODO REVIEW RUNS ON PR #2, BEFORE MERGE -->

## AI assistance disclosure

Per hackathon rule 12: **Claude Code was used throughout** — for implementation, debugging,
verification and this documentation. Architecture and technical decisions are the author's, are
understood, and can be explained on request (rule 13). The harness findings above are examples:
they were derived by reading TrueForge's behaviour against its docs, and they are why the
approval gate works.

## License

[MIT](./LICENSE)
