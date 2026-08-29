# Dossier

**An agent that applies to jobs the way each specific company requires — and stops one click short.**

Built on [TrueForge](https://github.com/truefoundry/trueforge) for the
[Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge)
(WeMakeDevs × TrueFoundry).

---

## The problem

Every company accepts applications differently. Some use Greenhouse, some Ashby, some Workday,
some a homemade form on their own site, some just an email address. There is no single "apply"
API, and a tool that assumes one platform silently fails on most of the market.

So the hard part is not writing a cover letter. It is working out **how this particular employer
wants to be applied to**, then doing that.

## What Dossier does

For each job, the agent:

1. Works out the **application route** by fingerprinting the real apply URL — never the careers
   landing page, which on most large companies is a JavaScript marketing shell that reveals nothing.
2. Learns the **actual form**: Greenhouse publishes a full schema, so it uses that when present.
   Otherwise it renders the page in a real browser and enumerates the fields that are really there.
3. Audits the resume **in a sandbox** against that specific job.
4. Asks the human for anything it genuinely does not know.
5. Fills every field, uploads the resume, screenshots the completed form — and **stops.**
6. Waits at an approval gate on a dashboard. Nothing is submitted until a person says so.

## The two walls

The agent applies by itself everywhere it legitimately can. Two barriers stop it, and neither is
an engineering problem:

- **CAPTCHA** — Greenhouse's embedded form requires a reCAPTCHA Enterprise token minted in a real
  browser session. Defeating that is CAPTCHA bypass. This project does not do that.
- **Account creation** — Workday requires creating a candidate account with email verification
  before you can apply at all.

When it hits either, it **stops, names the wall, and hands over a fully filled form.**

This is deliberate. An agent that silently "submitted" through a CAPTCHA would be worse than
useless, because you would believe you had applied when you had not.

---

## How it uses TrueForge

<!-- TODO: fill in as each capability lands -->

| Harness capability | Used | How |
| --- | --- | --- |
| MCP connectors | ☐ | |
| Sandbox | ☐ | |
| Skills | ☐ | |
| Subagents | ☐ | |
| Persistent sessions | ☐ | |
| Approval gates | ☐ | |
| ask-user-questions | ☐ | |

## Getting started

<!-- TODO -->

## Qodo Code Review Evidence

<!-- TODO: merged PR link + what Qodo surfaced and what changed -->

## AI assistance disclosure

Per hackathon rule 12: Claude Code was used for implementation, debugging and documentation.
All architecture and technical decisions are understood by the author and can be explained
(rule 13).

## License

[MIT](./LICENSE)
