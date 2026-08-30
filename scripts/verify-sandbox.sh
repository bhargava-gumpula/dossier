#!/usr/bin/env bash
# Prove that TrueForge really executes agent code in a remote Daytona sandbox.
#
# The assertion that matters: the sandbox reports Linux while this repo is
# developed on macOS. A local shell pretending to be a sandbox cannot do that.
# Exits non-zero if the sandbox is not genuinely remote.
set -euo pipefail

BASE="${TRUEFORGE_BASE_URL:-http://localhost:8790}/api/v1"
AGENT="dossier-sandbox-check"

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }

python3 - "$BASE" "$AGENT" <<'PY'
import json, sys, time, urllib.request, urllib.error

BASE, AGENT = sys.argv[1], sys.argv[2]

def call(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"content-type": "application/json"} if data else {})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())
    except urllib.error.HTTPError as e:
        print("HTTP %s on %s %s: %s" % (e.code, method, path, e.read().decode()[:300]),
              file=sys.stderr)
        raise SystemExit(1)

# 0. the sandbox provider must be registered and ready
prov = call("GET", "/settings/sandbox-providers").get("data", {})
if prov.get("status") != "ready":
    print("FAIL: sandbox provider not ready:", prov.get("status"), file=sys.stderr)
    raise SystemExit(1)
print("sandbox provider : %s (%s)" % (prov["manifest"]["type"], prov["status"]))

# 1. a session on the check agent
sid = call("POST", "/sessions", {"agent": {"name": AGENT}})["data"]["id"]

# 2. a turn that must actually run code
prompt = (
    "Execute this in the sandbox and report its exact stdout, verbatim:\n\n"
    "python3 -c \"import platform,os,socket;print('SANDBOX-OK');"
    "print('host='+socket.gethostname());"
    "print('sys='+platform.system()+' '+platform.release());"
    "print('cwd='+os.getcwd())\"\n\n"
    "Actually run it. Do not predict or simulate the output.")
tid = call("POST", "/sessions/%s/turns" % sid,
           {"input": [{"type": "user.message", "content": prompt}],
            "stream": False})["data"]["id"]

# 3. poll to completion
deadline = time.time() + 240
while time.time() < deadline:
    turn = call("GET", "/sessions/%s/turns/%s" % (sid, tid), timeout=30)["data"]
    status = turn["state"].get("status")
    if status in ("done", "failed", "cancelled", "error"):
        break
    time.sleep(4)
else:
    print("FAIL: turn did not finish in 240s", file=sys.stderr)
    raise SystemExit(1)

if status != "done":
    print("FAIL: turn status =", status, file=sys.stderr)
    raise SystemExit(1)

content = (turn["state"].get("output") or {}).get("content")
text = "".join(b.get("text", "") for b in content) if isinstance(content, list) else str(content)

# 4. The proof has to come from the tool response, not the model's prose.
#    A model can write "SANDBOX-OK / Linux" without ever running anything, so
#    asserting against its own summary proves nothing. Correlate instead: find
#    the exec tool call, then assert its actual response carried the markers.
events = call("GET", "/sessions/%s/turns/%s/events" % (sid, tid))["data"]

exec_call_ids = set()
for entry in events:
    ev = entry.get("event", entry)
    for c in (ev.get("tool_calls") or []):
        if (c.get("function") or {}).get("name") == "exec":
            exec_call_ids.add(c.get("id"))

exec_output = ""
for entry in events:
    ev = entry.get("event", entry)
    if ev.get("type") in ("tool.response", "tool_response") or ev.get("tool_call_id"):
        if ev.get("tool_call_id") in exec_call_ids:
            exec_output += json.dumps(ev.get("content") or ev.get("output") or "")

used_exec = bool(exec_call_ids)

ok = True
for label, cond in (
        ("harness called its exec tool", used_exec),
        ("exec RESPONSE contains SANDBOX-OK", "SANDBOX-OK" in exec_output),
        ("exec RESPONSE reports Linux (host is macOS)", "Linux" in exec_output),
        ("model summary matches the tool output", "SANDBOX-OK" in text)):
    print("  %-34s %s" % (label, "PASS" if cond else "FAIL"))
    ok = ok and cond

print()
print("SANDBOX VERIFIED" if ok else "SANDBOX VERIFICATION FAILED")
raise SystemExit(0 if ok else 1)
PY
