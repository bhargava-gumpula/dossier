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
