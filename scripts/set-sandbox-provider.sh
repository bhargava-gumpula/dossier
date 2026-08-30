#!/usr/bin/env bash
# Register the Daytona sandbox provider with a locally running TrueForge.
#
# The API key is read with hidden input and piped straight to the local API.
# It is never echoed, never written to disk, and never stored in this repo —
# TrueForge keeps it in its own local database (hackathon rule 7).
set -euo pipefail

BASE="${TRUEFORGE_BASE_URL:-http://localhost:8790}"

if ! curl -fsS -m 5 -o /dev/null "$BASE" 2>/dev/null; then
  echo "error: TrueForge is not reachable at $BASE" >&2
  echo "start it with:  npx @truefoundry/trueforge" >&2
  exit 1
fi

printf 'Daytona API key (input hidden): ' >&2
read -rs DAYTONA_KEY
printf '\n' >&2

if [ -z "${DAYTONA_KEY}" ]; then
  echo "error: no key entered" >&2
  exit 1
fi

RESPONSE=$(
  DAYTONA_KEY="$DAYTONA_KEY" python3 -c '
import json, os, sys
print(json.dumps({
    "manifest": {
        "type": "daytona",
        "auth": {"api_key": os.environ["DAYTONA_KEY"]},
        "exec_timeout_ms": 120000,
        "auto_stop_interval_in_minutes": 5,
        "auto_archive_interval_in_minutes": 60,
        "auto_delete_interval_in_minutes": 7200,
    }
}))' | curl -sS -X PUT "$BASE/api/v1/settings/sandbox-providers" \
        -H 'content-type: application/json' --data-binary @-
)
unset DAYTONA_KEY

echo "$RESPONSE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if "error" in d:
    print("FAILED:", d["error"].get("message", d["error"]), file=sys.stderr)
    sys.exit(1)
print("Daytona sandbox provider registered.")
print("  exec timeout:", d.get("exec_timeout_ms"), "ms")
print("  auto-stop   :", d.get("auto_stop_interval_in_minutes"), "min")
'
