#!/usr/bin/env bash
# Register Dossier's local MCP servers with a running TrueForge, and register
# the agent that uses them.
#
# Without this a clean install has no `dossier-jobs` setting, so the agent
# resolves no tools. Idempotent: re-running updates in place.
set -euo pipefail

BASE="${TRUEFORGE_BASE_URL:-http://localhost:8790}/api/v1"
JOBS_PORT="${JOBS_MCP_PORT:-8793}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! curl -fsS -m 5 -o /dev/null "${BASE%/api/v1}" 2>/dev/null; then
  echo "error: TrueForge unreachable at ${BASE%/api/v1}" >&2
  echo "start it with:  npx @truefoundry/trueforge" >&2
  exit 1
fi

if ! curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${JOBS_PORT}/health" 2>/dev/null; then
  echo "error: jobs MCP server is not running on port ${JOBS_PORT}" >&2
  echo "start it with:  node ${ROOT}/mcp/jobs-server.js" >&2
  exit 1
fi

register_mcp() {
  local name="$1" url="$2" desc="$3"
  local payload
  payload=$(python3 -c "
import json,sys
print(json.dumps({'manifest':{'type':'remote','name':sys.argv[1],'url':sys.argv[2],'description':sys.argv[3]}}))
" "$name" "$url" "$desc")

  # POST creates; if it already exists, PUT updates in place.
  if echo "$payload" | curl -fsS -X POST "$BASE/settings/mcp-servers" \
        -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1; then
    echo "  registered MCP server: $name"
  else
    echo "$payload" | curl -fsS -X PUT "$BASE/settings/mcp-servers" \
        -H 'content-type: application/json' --data-binary @- >/dev/null
    echo "  updated MCP server:    $name"
  fi
}

register_agent() {
  local file="$1"
  local name
  name=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$file")

  local existing
  existing=$(curl -fsS "$BASE/agents" | python3 -c "
import json,sys
name=sys.argv[1]
for a in json.load(sys.stdin).get('data',[]):
    if a.get('name')==name:
        print(a['id']); break
" "$name")

  if [ -n "$existing" ]; then
    python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
print(json.dumps({'manifest':m['manifest']}))" "$file" \
      | curl -fsS -X PUT "$BASE/agents/$existing" \
          -H 'content-type: application/json' --data-binary @- >/dev/null
    echo "  updated agent:         $name"
  else
    curl -fsS -X POST "$BASE/agents" -H 'content-type: application/json' \
        --data-binary @"$file" >/dev/null
    echo "  registered agent:      $name"
  fi
}

echo "Registering Dossier with TrueForge at ${BASE%/api/v1}"
register_mcp "dossier-jobs" "http://127.0.0.1:${JOBS_PORT}/mcp" \
  "Find live job postings by company name and determine how each specific employer accepts applications."
register_agent "$ROOT/agent/dossier.agent.json"
register_agent "$ROOT/agent/sandbox-check.agent.json"

echo
echo "Tools the harness can now see:"
curl -fsS "$BASE/mcp-servers/dossier-jobs/tools" | python3 -c "
import json,sys
d=json.load(sys.stdin); ts=d.get('data',d)
ts=ts.get('tools',ts) if isinstance(ts,dict) else ts
for t in ts:
    a=t.get('annotations') or {}
    print('  %-22s readOnly=%s destructive=%s' % (t.get('name'), a.get('readOnlyHint'), a.get('destructiveHint')))
"
