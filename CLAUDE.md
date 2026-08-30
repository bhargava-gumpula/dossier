# CLAUDE.md — read this first

Handoff state for a fresh session. Everything needed to pick up without
re-deriving decisions that were already made and paid for.

---

## ▶ RESUME HERE — 29 Aug 2026, ~21:40 PDT

**Deadline: Sunday 30 Aug 2026, 11:00 AM PDT** (19:00 UTC / 8 PM London).
Roughly **13 hours left.**

**Submission form:** https://forms.gle/7DWiH2SDCJioWtdeA

### What is done

Phases 0–7 of the plan. **59 of 62 end-to-end checks pass** (`node scripts/verify-all.mjs`);
the 3 failures are a flaky agent run, not product bugs — see "Known flake" below.

The product works end to end: name a company → pick roles → route detected → real form read
in a real browser → résumé tailored → form filled → **held at a human gate** → approved →
payload captured to a local sink with the tailored PDF attached.

### What is NOT done — this is the whole remaining job

| # | Task | Why it matters |
| --- | --- | --- |
| 1 | **README** rewrite for a stranger | R6/R7 — pass/fail |
| 2 | **Qodo review** of PR #2 (~5,000 lines, unreviewed since the dashboard landed) | R10/R11 — half of criterion 4 |
| 3 | **Merge PR #2** | R10 needs a *merged* reviewed PR |
| 4 | **~3 minute demo video** | R8 — pass/fail, worth a full criterion |
| 5 | **Submit the form** | R17 |

**Nothing else should be built.** Three of six judging criteria are unaddressed and all five
tasks above are pass/fail. The endgame guard in the plan says building stops at 08:00 PDT.

---

## Start everything

Four local processes plus TrueForge. **All four must be running**, and two need the
allow-origins variable or the demo employer is unreachable:

```bash
npx @truefoundry/trueforge                      # http://localhost:8790

cd ~/dossier
node demo/demo-employer.js &                                             # :8795
DOSSIER_ALLOW_ORIGINS="http://127.0.0.1:8795" node mcp/jobs-server.js &   # :8793
DOSSIER_ALLOW_ORIGINS="http://127.0.0.1:8795" node mcp/apply-server.js &  # :8794
node dashboard/server.js &                                               # :5174

bash scripts/register-mcp-servers.sh            # registers servers + agents
```

Dashboard: **http://127.0.0.1:5174** (landing) and **/app** (the product).

### Verify it all works

```bash
node scripts/verify-all.mjs      # 62 checks, live, exits non-zero on regression
bash scripts/verify-sandbox.sh   # proves execution is genuinely remote
```

---

## Credentials — already configured, none in this repo

All three live in TrueForge's own local database (`~/Library/Application Support/trueforge/`),
which is **machine-local, not account-local**, so switching accounts does not lose them.

| What | Where | Notes |
| --- | --- | --- |
| Anthropic model key | TrueForge settings | Pre-existing. 8 models resolve. |
| Daytona sandbox key | TrueForge settings | `scripts/set-sandbox-provider.sh` rotates it. |
| Bright Data token | TrueForge connector **URL** | `scripts/add-search-connector.sh` rotates it. |

> **Bright Data's token sits in the connector URL, and TrueForge redacts header secrets but
> not URLs.** Do not show the TrueForge connectors screen on camera (rule 7). Nothing in the
> demo needs it — everything filmed happens in the Dossier dashboard.

**Cost control.** Agent turns are the spend. `iteration_limit` is pinned to **25** (it was
unset, defaulting to 100). Test tools directly over MCP with curl — 59 of the 62 checks cost
nothing. `DOSSIER_MODEL=anthropic/claude-haiku-4-5 bash scripts/register-mcp-servers.sh`
switches the agent to a cheap model for iteration; switch back to `claude-sonnet-5` before
filming.

---

## Architecture, briefly

```
name a company ─▶ jobs-mcp ─▶ Greenhouse · Ashby · Workday · Jobvite  (direct APIs)
                            └▶ Bright Data web search               (everyone else)
                                        │
                            detect_apply_route  ← fingerprints the APPLY URL, never a
                                        │          careers landing page (they are JS shells)
                                        ▼
      apply-mcp ─▶ inspect_form → tailor_resume → fill_form → submit_form ◀── HELD
                        (real browser)                                    │
                                                              dashboard approve
```

**Agent:** `dossier` on TrueForge. **Gate:** `submit_form` only, pinned on the
`dossier-apply` MCP server entry.

---

## Things that cost hours to discover — do not rediscover them

1. **`require_approval_for_tools` belongs on the MCP *server* entry**, not `config` or
   `AgentSpec`. Setting it on config is silently ignored and TrueForge's default
   `["@write","@destructive"]` applies, which gates `tailor_resume` and `update_profile` too —
   the agent then stalls at a second gate.
2. **`stream` defaults to `true`** on `POST /sessions/{id}/turns`. Without `"stream": false`
   you get SSE and it parses as nothing.
3. **`POST /sessions` takes `{"agent":{"name":…}}`**, not `agent_id`.
4. Pause data is at **`state.required_actions`** — snake_case, unlike the published docs.
5. **Fingerprint the apply URL, never the careers landing page.** NVIDIA, Tesla and McDonald's
   landing pages are JS marketing shells that detect as nothing.
6. **TrueForge's Bright Data catalog entry is wrong** — it says `Authorization: Bearer`, but
   the token belongs in the query string, and the mismatch *times out for 60s* rather than
   returning 401. Bright Data also needs an `mcp-session-id` handshake TrueForge does not
   carry, which is why it is proxied through `mcp/lib/websearch.js`.
7. **ES imports are hoisted**, so a module reading `process.env` at import time ignores
   anything a caller sets first. `net-guard.js` reads it lazily for this reason.
8. **Lever is dead** — its postings API failed on 7 of 8 real company boards.
9. **No PDF text extractor existed on this machine.** `pdf-parse` was added; `textutil`
   (macOS, present) handles Word and RTF.

---

## Known flake

`verify-all.mjs` section 10 occasionally fails when the agent, on Haiku, retries after a
transient MCP error. The product path is correct — a clean run shows
`get_candidate_profile → detect_apply_route → inspect_form → tailor_resume → fill_form →
submit_form`, one submit, nothing after approval. **Re-run before concluding anything, and
film on `claude-sonnet-5`.**

---

## Rules that will disqualify if missed

- **Rule 4** — every substantive change through a Qodo-reviewed PR. `main` is branch-protected
  with `enforce_admins: true`, so direct pushes are rejected. Solo merge: `gh pr merge 2 --merge`.
- **Rule 7** — no keys or personal data in the repo or the video. The demo persona is
  synthetic (`fixtures/persona/`). Real résumés upload into `private/`, which is gitignored.
- **Rule 12** — AI assistance is disclosed in the README.
- **No CAPTCHA solving, no account creation.** Both walls are reported honestly instead.

## The honest framing, for the video and the write-up

Every major ATS gates submission behind an employer credential or a CAPTCHA — verified across
Greenhouse, Ashby, Lever, SmartRecruiters, Workable and Recruitee. So the agent does everything
up to the click those platforms reserve for a human. **Submissions are mechanically real** — a
real browser, a real form, a real multipart payload, the tailored PDF attached — but the
destination is a local sink, because sending a fabricated candidate to a real employer wastes
real recruiters' time. The model refused to do it when asked, and it was right.
