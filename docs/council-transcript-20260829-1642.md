# LLM Council — Dossier project critique
**Run:** 29 Aug 2026, 16:42 PDT · **18.3 hours to deadline** (Sun 30 Aug, 11:00 PDT / 19:00 UTC)

## The question put to the council

Is "Dossier" a good project for the Agent Harness Hackathon, and should it be built as planned
with ~18 hours left? Solo builder. Must run on TrueForge. Six equally weighted criteria: impact,
creativity, technical excellence, sponsor-tool use (TrueForge central + Qodo-reviewed PRs),
control & safety, presentation. Build plan is ~16h of work against ~18h remaining, with Phase 3
(Playwright inspect/fill/submit + CAPTCHA wall detection, 4h) blocking six downstream phases.

Verified research supplied to advisors: no major ATS permits unauthenticated submission
(Greenhouse = reCAPTCHA Enterprise + employer key; Lever/Ashby/SmartRecruiters/Workable/Recruitee
all require employer credentials). Public read APIs confirmed: Greenhouse (571 jobs @ Anthropic +
full 19-field form schema), Ashby (758 @ OpenAI), Workday (2000 @ NVIDIA). Lever dead (7 of 8
boards failed). Route detection verified on 5 real companies.

---

## Advisor responses

### The Contrarian  *(anonymised as Response C)*
Fatal flaw isn't in the tech — it's in what "done" means. Verification budget went to the hard
parts (ATS detection, CAPTCHA walls, schemas) and none to what judges score: does an 18-hour solo
build with zero slack produce something that runs live in 3 minutes without narrating over a crash.
16h estimated against 18h remaining, and that estimate assumes nothing goes wrong. Phase 3 is the
most fragile category of software to write; if it runs long by 90 minutes, sandbox, gate, dashboard,
README, Qodo review and video get squeezed simultaneously. No fallback phase, no cut line, no "if
Phase 3 isn't done by hour 6, do X." That's not a build plan, that's a hope schedule. Second: your
own research proves the headline feature is mostly theater — "applies to jobs" degrades to "fills a
form and asks a human to click submit" for most real companies. Nobody has decided whether the demo
says that plainly or quietly lets the CAPTCHA case do the heavy lifting. Ask now, not at hour 16:
what one thing, if it breaks, kills the demo — and do you have a recorded fallback clip already?

### The First Principles Thinker  *(anonymised as Response A)*
You're optimizing the wrong variable. "Win the hackathon" decomposes into "maximize score across six
equally-weighted axes in ~14 effective hours," not "build the product I'd ship in three months."
Full autonomous ATS submission is structurally impossible — that's not a Phase 3 risk to manage,
it's proof the kill feature doesn't exist. The demo's climax for most companies is "here's a filled
form, please click submit," undercutting criterion 1 exactly where you need it strongest. What's
novel isn't reaching five ATS platforms — it's that the harness makes a judgment call, asks a human
what it can't know, refuses to fabricate a claim, and stops before an irreversible act. That's the
whole safety axis and most of the sponsor-tool axis, demonstrable with ONE reliable route plus ONE
wall-detection example. Cut the rest. Breadth isn't buying judging points; it's spending your only
scarce resource on integration risk against axes nobody's scoring.

### The Expansionist  *(anonymised as Response D)*
The judges aren't grading a job-application tool, they're grading a demonstration of an agent
harness doing real orchestration. The verified research is the asset, not the feature. The
"stops at a wall and hands over a filled form" behavior is not a limitation to apologize for — it's
the single most valuable thing in the pitch, and it's currently one bullet point in an eight-step
build. That's control-and-safety AND impact AND presentation all pointing at the same three seconds
of footage: agent hits reCAPTCHA, names it, hands a completed form to a human. Make that moment
unmissable — bigger dashboard treatment, a running tally ("3 auto-submitted, 5 handed off, walls
named"), because that tally is the product thesis in one glance. Bigger swing: let Start All queue
five real companies live and show the harness triaging in parallel — some submit, some hit walls.
That's TrueForge visibly doing orchestration instead of one linear script.

### The Outsider  *(anonymised as Response B)*
Three things jump out cold. First: TrueForge is the hard requirement and one of six criteria, and
it's the least-described part of the plan. Everything else gets verified findings and hour
estimates; TrueForge gets one line — "one session per job application." That's a session count, not
an architecture. Judges are told to penalize "a thin wrapper around a model call," and what I read —
slugify → probe boards → fingerprint → read schema → fill → screenshot → stop — reads like a
deterministic pipeline with an LLM drafting text at one step. If that's wrong, the plan needs to
show me where, because right now it's invisible. Second: the pitch verb is "applies to jobs." The
findings say it mostly can't. That's a legitimate, safer product — but a different one than pitched.
A judge hears "applies the way each company requires," then watches it stop and ask a human to click
submit. That gap must be the headline, not a caveat, or it plays as overpromising. Third: Phase 3 is
a single point of failure with no fallback.

### The Executor  *(anonymised as Response E)*
16h of work against 18h remaining, solo, including sleep — that's a rounding error away from
failure. Cut now, while it's cheap. Phase 3 gates everything after it, and browser automation
against real DOMs always runs long — especially Workday, notoriously bot-hardened. If it slips you
don't lose an hour, you lose the whole back half simultaneously. Scope: three ATS integrations,
fuzzy company-matching, a résumé audit sandbox, persistent Q&A memory, essay drafting with
citation-checking, screenshot gates, and a two-view React dashboard with Start All. That's four
products. Judges watch a 3-minute demo of ONE run. Cut line: Greenhouse only. One bespoke-form
stop-and-handover as the safety beat. Kill Workday and Ashby — "designed for" in the README, not
built. Kill Start All. Also: write the demo script and record a placeholder walkthrough NOW, before
Phase 3 lands, so video isn't a blind 1.5h estimate at hour 17 with a tired brain.

---

## Peer review (anonymised; mapping revealed above)

**Reviewer 1** — Strongest: **B**. Only response interrogating the mandatory TrueForge requirement
rather than repackaging the user's own research. "One session per job" is a session count, not an
architecture; if the harness is one LLM step in a deterministic pipeline, no amount of Phase 3
execution saves the sponsor-tool score. Biggest blind spot: **D** — the wall-stop reframe is right,
but its prescription (live parallel Start All across five companies) adds scope at the exact moment
A, C and E are screaming to cut, and D never engages the schedule math at all. Missed by all:
**Qodo** — named in criterion 4 coequally with TrueForge, mentioned by nobody. Also résumé PII
inside the sandbox, and TrueForge's own live-demo reliability as distinct from Playwright risk.

**Reviewer 2** — Strongest: **B**, same reasoning: a deterministic pipeline wearing an agent costume
risks a full axis outright, and nobody else looks there. Biggest blind spot: **D** — right
diagnosis, wrong prescription; argues for more surface area on a build with zero slack, undercutting
its own safety framing. Missed by all: **Qodo**; the reputational/legal risk of live-demoing real
submissions to real ATS systems; and hallucination risk in the "grounded" essay drafts, which is a
safety concern as real as the approval gate everyone fixates on.

**Reviewer 3** — Strongest: **D**. Only response that follows the project's own verified finding to
its conclusion: if no major ATS allows unauthenticated submission, the wall-stop isn't a fallback,
it's the *only* thing that ever happens on an ATS route. Biggest blind spot: **A** — it proposes
"ONE reliable route (Greenhouse — API-based, no Playwright needed)" as distinct from a wall example,
but Greenhouse *always* hits the wall, and still needs real-browser filling. Combined with "cut
email/bespoke entirely," A's plan leaves the demo with **zero genuine auto-submit cases** — the
opposite of what it claims to protect. E echoes a softer version of the same error. Missed by all:
whether to run live against real companies' production ATS at all — spamming real recruiters and
betting the demo on sites you don't control.

**Reviewer 4** — Strongest: **B**. The only response to catch that TrueForge — a hard requirement
and one of six *equal* criteria that explicitly penalises "a thin wrapper around a model call" —
gets one line in the entire plan. The described flow reads as a deterministic pipeline with an LLM
doing text-drafting at one step, not a harness reasoning through judgment calls. If that's accurate,
criterion 4 fails regardless of how well Phase 3 ships — a risk no amount of scope-cutting (A, E) or
schedule-padding (C) fixes. Biggest blind spot: **D** — correctly reframes the wall-stop as the
product thesis, then recommends *adding* scope without once mentioning the 16-vs-18-hour budget,
Phase 3's blocking position, or a fallback. Good instinct, no risk math. Missed by all: nobody
mentions the required Qodo-reviewed, **merged** PR — a named deliverable and half of criterion 4.
Getting bot review, addressing feedback and merging solo inside this window is its own unbudgeted
scheduling risk.

**Reviewer 5** — Strongest: **E**. The only one that turns diagnosis into an executable checklist
rather than a stance, and it correctly avoids the trap of claiming Greenhouse itself auto-submits
(it can't — CAPTCHA wall). Its sharpest addition: write the demo script and record a placeholder
walkthrough *now*, decoupling the required video from Phase 3's completion risk. A makes the same
reframe more elegantly but stays philosophical where E is executable in ten minutes. Biggest blind
spot: **D** — never runs the clock. Missed by all: (a) the Qodo-reviewed *merged* PR has its own
external latency and nobody schedules for it; (b) **nobody does the sleep arithmetic** — "18 hours
including sleep" against "16 estimated" isn't a rounding error, it's likely a multi-hour deficit
once sleep is actually subtracted. E gestures at this but never computes it.

---

## Final tally across all five peer reviews

| | Result |
|---|---|
| **Strongest response** | **The Outsider — 3 of 5** (Expansionist 1, Executor 1) |
| **Biggest blind spot** | **The Expansionist — 4 of 5** (First Principles 1) |
| **Universal miss** | **Qodo — flagged by 4 of 5.** Also: the sleep deficit, live-demo risk against real production ATS, résumé PII in the sandbox, hallucination risk in "grounded" essays |

## Chairman synthesis

**Keep the project.** Not one advisor argued for abandoning it, and the verified ATS research is a
genuine moat most entries won't have.

**Reject the council's most popular recommendation.** Three advisors said "cut to Greenhouse only."
Reviewer 3 caught why that is self-defeating: Greenhouse, being an ATS, *always* hits the reCAPTCHA
wall. Cut email and bespoke and the demo contains zero genuine auto-submit cases — the opposite of
what those advisors intended. **Email is load-bearing.** Cut Workday and Ashby instead.

**Act on the Outsider (3 of 5).** "One TrueForge session per job application" is a session count,
not an architecture. The agent's real judgment — choosing among fuzzy role matches, mapping résumé
evidence to requirements, refusing unbacked claims, deciding what it must ask, recovering from a
deny — exists but is invisible in the plan. Fix it in the README and the video, not in code.

**Adopt the Expansionist's diagnosis, refuse its prescription (4 of 5 called this the blind spot).**
Keep the dashboard tally — it is cheap and it is the thesis in one glance. Do not add live parallel
triage across five companies.

**Confront the sleep deficit (Reviewer 5).** 18.3h wall clock minus ~6h sleep minus breaks is
~11–12h effective against 16h planned. That is a ~4–5h deficit, not a tight schedule. Cuts are
mandatory, not optional.

**Schedule the Qodo merge explicitly (4 of 5).** It has external latency — bot review, addressing
findings, merging solo with `--admin`. It is half of criterion 4 and currently unbudgeted.
