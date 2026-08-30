# CLAUDE.md — read this first

Handoff state for a fresh session. Everything needed to pick up without
re-deriving decisions that were already made and paid for.

---

## ▶ RESUME HERE — 29 Aug 2026, ~22:20 PDT

**Deadline: Sunday 30 Aug 2026, 11:00 AM PDT.** Roughly **12.5 hours left.**

**Submission form:** https://forms.gle/7DWiH2SDCJioWtdeA — **not yet submitted.**

### The repository is `bhargava-gumpula/dossier`

There is a second public repo, `bhargava-gumpula/agent-harness-hackathon`, which is a
**different project** (`customs/`, `web/`). None of this work is in it. Running `gh` from
that folder once merged the wrong PR #3. Pass `--repo bhargava-gumpula/dossier` to be safe.

### What is done

| | |
| --- | --- |
| **README** | Rewritten for a stranger. Quickstart, honest capability table, Qodo evidence, AI disclosure. On `main`. |
| **Qodo review** | 26 findings. 5 already fixed, 1 outdated, **all 20 live ones addressed** — 19 fixed, 1 was not a bug. |
| **PR #2** | **Merged.** 42 files, +7,904. |
| **PR #3** | **Merged.** Failed runs no longer report "working" for ever. |
| **Verification** | `node scripts/verify-all.mjs` → **62/62, exit 0**, on Sonnet. |
| **E2E** | Full run through the dashboard: gate in 56s, nothing sent while held, one application on approval, tailored PDF attached. |

`main` is at `42f1086`, 28 commits, and contains the whole product.

### What is NOT done

1. **Demo video** (~3 min) — R8, pass/fail, worth a full criterion. Not started.
2. **Submit the form** — R17. Not started.
3. **PR for `feat/ascii-hero`** — the UI work is pushed but has no PR yet.

---

## Start everything

Five processes. **Two need the allow-origins variable** or the demo employer is unreachable:

```bash
npx @truefoundry/trueforge                                                # :8790

cd ~/dossier
node demo/demo-employer.js &                                              # :8795
DOSSIER_ALLOW_ORIGINS="http://127.0.0.1:8795" node mcp/jobs-server.js &    # :8793
DOSSIER_ALLOW_ORIGINS="http://127.0.0.1:8795" node mcp/apply-server.js &   # :8794
node dashboard/server.js &                                                # :5174

bash scripts/register-mcp-servers.sh
```

**The dashboard serves a built bundle.** After any frontend edit:
`cd dashboard && npm run build`. `dist/` is gitignored, so a clean clone needs
`cd dashboard && npm install && npm run build` too — the README quickstart says so now.

Landing page **http://127.0.0.1:5174** · dashboard **/app**.

### Verify

```bash
node scripts/verify-all.mjs      # 62 live checks; only section 10 spends model credits
bash scripts/verify-sandbox.sh   # proves execution is genuinely remote
```

---

## Ready to film

- Agent is on **`claude-sonnet-5`**, iteration limit 25. Confirm with
  `curl -s http://localhost:8790/api/v1/agents | grep -o 'claude-[a-z0-9-]*'`
- Gate is pinned correctly: `dossier-apply → ["submit_form"]`, `dossier-jobs → []`
- **Queue and sink are cleared**, persona has no test residue. Both files are untracked
  and drift during testing — re-clear before recording:
  `echo '{"jobs": []}' > dashboard/queue.json && : > demo/received-applications.jsonl`
- Good on-camera beat: `detect_apply_route` on a real Anthropic Greenhouse posting returns
  `wall: captcha, canAutoSubmit: false` — the honest refusal, live, against a real employer.
- The tailoring panel shows `refused: []`, which backs the "it can only promote what you
  already have" claim.

---

## Credentials — already configured, none in this repo

All three live in TrueForge's own local database, which is machine-local, so switching
accounts does not lose them.

| What | Where |
| --- | --- |
| Anthropic model key | TrueForge settings |
| Daytona sandbox key | TrueForge settings (`scripts/set-sandbox-provider.sh`) |
| Bright Data token | TrueForge connector **URL** (`scripts/add-search-connector.sh`) |

> **Bright Data's token is in the connector URL and TrueForge does not redact URLs.**
> Do not show the TrueForge connectors screen on camera. Nothing in the demo needs it.

**Cost control.** Agent turns are the spend. Test tools directly over MCP with curl —
59 of the 62 checks cost nothing. `DOSSIER_MODEL=anthropic/claude-haiku-4-5 bash
scripts/register-mcp-servers.sh` switches to a cheap model for iteration; switch back to
`claude-sonnet-5` before filming or final verification.

---

## Architecture, briefly

```
name a company ─▶ jobs-mcp ─▶ Greenhouse · Ashby · Workday · Jobvite  (direct APIs)
                            └▶ Bright Data web search               (everyone else)
                                        │
                            detect_apply_route  ← fingerprints the APPLY URL, never a
                                        │          careers landing page
                                        ▼
      apply-mcp ─▶ inspect_form → tailor_resume → fill_form → submit_form ◀── HELD
                        (real browser)                                    │
                                                              dashboard approve
```

---

## Things that cost hours — do not rediscover them

1. **`require_approval_for_tools` belongs on the MCP *server* entry**, not `config` or
   `AgentSpec`. On config it is silently ignored and TrueForge's default
   `["@write","@destructive"]` applies, which gates `tailor_resume` and `update_profile`
   too — the agent then stalls at a second gate.
2. **`stream` defaults to `true`** on `POST /sessions/{id}/turns`. Without `"stream": false`
   you get SSE and it parses as nothing.
3. **`POST /sessions` takes `{"agent":{"name":…}}`**, not `agent_id`.
4. Pause data is at **`state.required_actions`** — snake_case, unlike the published docs.
5. **Turn ids need a `.local` suffix** on the events endpoint. Without it: "Turn not found".
6. **A tool is invoked two different ways.** Directly as `call_tool`, or from inside the
   sandbox as `exec` running `mcp-client call-tool <server> <tool>`. Both carry the name in
   `arguments.tool_name`, and so do the *meta* tools `get_tool_info` / `list_tools`. Decide
   meta-ness from `function.name` first, then resolve the logical name — otherwise a schema
   lookup counts as a call. **This was the whole "known flake"** that plagued section 10 for
   days: the agent was always correct, the verifier was miscounting.
7. **Fingerprint the apply URL, never the careers landing page.** NVIDIA, Tesla and
   McDonald's landing pages are JS shells that detect as nothing.
8. **Jobvite intermittently 303s a valid board to its support page**, which arrives as a
   healthy 200 with no jobs. Retrying only on a thrown fetch never fires; a response that
   lands anywhere other than the requested board is retried too.
9. **Playwright raises no route event for a main-frame redirect** — Chromium follows the
   30x internally. A `ctx.route` handler guards subresources only; redirect hops are checked
   after navigation via `redirectedFrom()`.
10. **ES imports are hoisted**, so a module reading `process.env` at import time ignores
    anything a caller sets first. `net-guard.js` reads it lazily for this reason.
11. **Lever is dead** — its postings API failed on 7 of 8 real company boards.
12. **`prefers-color-scheme` is live in `theme.css`.** On a machine set to dark, anything
    hardcoded light renders as a white slab. Both surfaces are tokenised now.

---

## Qodo

**Reviews are paused on this account** — `/agentic_review` replies "Qodo reviews are paused
for this user", a plan/seat limit. PR #3 and the UI branch could not be reviewed. The
substantive review of PR #2 (26 findings) is what exists, and the README documents it.

---

## The UI work — `feat/ascii-hero`, pushed, no PR yet

Three commits, all frontend, all verified in light and dark:

- **`9dfca9a`** — the 21st.dev hero, ported off Tailwind/shadcn/TypeScript. Zero new
  dependencies: the chevron is inlined, one link needs no Radix `Slot` or `cva`. Tailwind
  was deliberately *not* installed — its preflight is a global reset and both pages share a
  bundle, so it would have restyled the dashboard.
- **`53c7249`** — the whole homepage in the hero's language.
- **`c986eae`** — the dashboard brought onto the same system. Tokens now live once in
  `theme.css`. **No JSX changed**, so the gate and queue behave exactly as before. Status
  colours deliberately kept — they carry meaning.

`AsciiBackground.jsx` is a full Canvas2D ASCII-forest effect, kept but **unmounted**. The
hero takes a `background` slot, so switching it on is one line.

**Nobody has looked at any of this.** The Browser pane would not display, so it was all
verified by measuring computed styles — geometry, contrast, overflow, both schemes. The
numbers hold; the aesthetics are unjudged.

---

## Rules that will disqualify if missed

- **Rule 4** — every substantive change through a PR. `main` is branch-protected with
  `enforce_admins: true`.
- **Rule 7** — no keys or personal data in the repo or the video. The demo persona is
  synthetic (`fixtures/persona/`). Real résumés upload into `private/`, gitignored.
- **Rule 12** — AI assistance is disclosed in the README.
- **No CAPTCHA solving, no account creation.** Both walls are reported honestly instead.

## The honest framing, for the video and the write-up

Every major ATS gates submission behind an employer credential or a CAPTCHA — verified
across Greenhouse, Ashby, Lever, SmartRecruiters, Workable and Recruitee. So the agent does
everything up to the click those platforms reserve for a human. **Submissions are
mechanically real** — a real browser, a real form, a real multipart payload, the tailored
PDF attached — but the destination is a local sink, because sending a fabricated candidate
to a real employer wastes real recruiters' time.
