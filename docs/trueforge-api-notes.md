# TrueForge API notes

Verified against a live local TrueForge during Phase 1. These are the shapes that actually
work, recorded because several differ from what you would guess.

| Thing | Correct form | Wrong guess that fails |
| --- | --- | --- |
| Register sandbox | `PUT /settings/sandbox-providers` with `{"manifest": {...}}` | sending the manifest unwrapped |
| Read sandbox status | response nests at `data.manifest`, status at `data.status` | reading fields off the top level |
| Create session | `POST /sessions` with `{"agent": {"name": "..."}}` | `{"agent_id": "..."}` → *Unrecognized key* |
| Run a turn | `POST /sessions/{id}/turns` with `"stream": false` | omitting it — **`stream` defaults to true**, so you get SSE, not JSON |
| Turn completion | returns immediately with `status: "running"`; poll `GET /sessions/{id}/turns/{tid}` | expecting the POST to block until done |
| Sandbox tool | appears in the event trace as `exec`, `tool_info.type = truefoundry-system` | — |

Daytona is the only sandbox provider in the catalog. `auth.api_key` is required; responses
redact it, and re-sending the redacted value keeps the stored key.

## Verified sandbox evidence

```
SANDBOX-OK
host=5c374d33-0382-4589-98eb-60089b8d1351
sys=Linux 6.8.0-90-generic
cwd=/home/trueforge
```

The host machine is macOS (Darwin). The sandbox reports Linux. That mismatch is the proof the
code executed remotely rather than in a local shell — `scripts/verify-sandbox.sh` asserts it and
exits non-zero if it ever stops being true.

Event trace for that turn:

```
turn.created
model.message   -> tool=exec  kind=truefoundry-system
tool.response
model.message
turn.done
```

## Phase 2 findings

| Thing | Correct form | Wrong guess that fails |
| --- | --- | --- |
| Register an MCP server | `POST /settings/mcp-servers` with `{"manifest":{type,name,url,description}}` | posting to `/mcp-servers` (GET only) |
| Confirm the harness sees tools | `GET /mcp-servers/{name}/tools` | trusting your own `tools/list` |
| Pause data on a turn | `state.required_actions` — **snake_case** | `state.requiredActions`, as the published docs show |
| Answer `ask_user_question` | new turn with `{"type":"user.tool_response", thread_id, tool_call_id, content}` | — |
| Approve a held tool | new turn with `{"type":"user.tool_approval", ...}` | — |

`TurnInputItem` is exactly three types: `user.message`, `user.tool_approval`, `user.tool_response`.

**Tool annotations are load-bearing.** TrueForge's default approval policy is
`["@write","@destructive"]`, and an unannotated MCP tool is treated as destructive. Every
read-only tool therefore declares `readOnlyHint: true, destructiveHint: false`, or the harness
gates every call and there is no single clean approval gate left to demonstrate.

### Verified agent behaviour

Asked for "a backend engineer role at Ramp", the agent in one turn: loaded tools on demand
(`list_tools` / `get_tool_info`), called `find_jobs` over MCP, **wrote and ran Python in the
sandbox** to process the result, then **stopped and asked which of 32 matching roles to use**
rather than guessing. After the answer it detected the route and reported:

> "Can I complete it myself? **No.** The form is protected by a **CAPTCHA** … I'll fill out the
> entire application form for you … then hand it over to you to solve the CAPTCHA and click
> submit yourself."

That is the product thesis, produced from live detection against a real posting.
