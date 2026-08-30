#!/usr/bin/env bash
# Register a web-search MCP connector with a locally running TrueForge.
#
# Search is how job discovery generalises. Direct board APIs (Greenhouse, Ashby,
# Workday, Jobvite) are fast, free and exact, but they only cover employers who
# publish a machine-readable board. Everyone else self-hosts. Rather than
# integrating one more ATS forever, the agent searches for the posting the way a
# person would, and the rest of the pipeline works from any URL.
#
# The token is read with hidden input and piped straight to the local API. It is
# never echoed, never written to disk, and never stored in this repo - TrueForge
# keeps it in its own local database (hackathon rule 7).
set -euo pipefail

BASE="${TRUEFORGE_BASE_URL:-http://localhost:8790}"
PROVIDER="${1:-bright-data}"

# Bright Data authenticates with the token in the query string, NOT with an
# Authorization header. TrueForge's own connector catalog lists a Bearer header,
# and that silently times out on both transports rather than returning 401 -
# which is a slow and confusing way to discover the difference.
case "$PROVIDER" in
  bright-data) MODE="query";  URL="https://mcp.brightdata.com/mcp" ;;
  exa)         MODE="header"; URL="https://mcp.exa.ai/mcp" ;;
  tavily)      MODE="header"; URL="https://mcp.tavily.com/mcp" ;;
  *) echo "unknown provider: $PROVIDER (use bright-data, exa or tavily)" >&2; exit 1 ;;
esac

if ! curl -fsS -m 5 -o /dev/null "$BASE" 2>/dev/null; then
  echo "error: TrueForge unreachable at $BASE" >&2
  echo "start it with:  npx @truefoundry/trueforge" >&2
  exit 1
fi

printf 'API token for %s (input hidden): ' "$PROVIDER" >&2
read -rs TOKEN
printf '\n' >&2
[ -n "${TOKEN}" ] || { echo "error: no token entered" >&2; exit 1; }

PAYLOAD=$(
  TOKEN="$TOKEN" PROVIDER="$PROVIDER" URL="$URL" MODE="$MODE" python3 -c '
import json, os, urllib.parse
mode, url, token = os.environ["MODE"], os.environ["URL"], os.environ["TOKEN"]
manifest = {
    "type": "remote",
    "name": os.environ["PROVIDER"],
    "url": url + "?token=" + urllib.parse.quote(token, safe="") if mode == "query" else url,
    "description": "Search the web to find job postings at employers that publish no machine-readable job board.",
}
if mode == "header":
    manifest["auth"] = {"type": "header", "headers": {"Authorization": "Bearer " + token}}
print(json.dumps({"manifest": manifest}))'
)
unset TOKEN

# POST creates; if the name already exists, PUT rotates it in place.
RESPONSE=$(echo "$PAYLOAD" | curl -sS -X POST "$BASE/api/v1/settings/mcp-servers" \
             -H 'content-type: application/json' --data-binary @- || true)
if echo "$RESPONSE" | grep -q '"error"'; then
  RESPONSE=$(echo "$PAYLOAD" | curl -sS -X PUT "$BASE/api/v1/settings/mcp-servers" \
               -H 'content-type: application/json' --data-binary @- || true)
  echo "  (rotated existing connector)" >&2
fi
unset PAYLOAD

if [ "$MODE" = "query" ]; then
  echo "  NOTE: this provider carries its token in the connector URL. TrueForge" >&2
  echo "        redacts header secrets but not URLs, so do not show the connector" >&2
  echo "        settings screen on camera (hackathon rule 7)." >&2
fi

echo "Registered $PROVIDER. Tools the harness can see:"
curl -fsS "$BASE/api/v1/mcp-servers/$PROVIDER/tools" | python3 -c '
import json, sys
d = json.load(sys.stdin); ts = d.get("data", d)
ts = ts.get("tools", ts) if isinstance(ts, dict) else ts
for t in ts[:12]:
    print("  -", t.get("name"))
' 2>/dev/null || echo "  (could not list tools - check the token)"
