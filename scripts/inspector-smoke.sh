#!/usr/bin/env bash
# Smoke test of the built server (run `npm run build` first) with the MCP Inspector CLI, over stdio and over HTTP:
# lists the tools and calls one, like a client would. The CLI exits non-zero when it can't connect or a tool
# returns an error, and `set -e` turns that, or a missing expected line, into a failed run.
set -euo pipefail

inspector=(npx --yes @modelcontextprotocol/inspector@2.14.0 --cli)

check() { # check <output> <text it must contain>
  grep -qF -- "$2" <<<"$1" || { echo "Expected $2 in:"; echo "$1"; exit 1; }
}

expect_tools_and_match() { # expect_tools_and_match <inspector target arguments...>
  local tools result
  tools=$("${inspector[@]}" "$@" --method tools/list)
  for name in search_invoices get_invoice match_invoice request_approval; do check "$tools" "\"name\": \"$name\""; done
  result=$("${inspector[@]}" "$@" --method tools/call --tool-name match_invoice --tool-arg invoiceId=INV-1001)
  check "$result" '"status": "matched"'
}

echo "stdio: the Inspector starts dist/index.js"
expect_tools_and_match node dist/index.js

echo "HTTP: dist/http-main.js with a bearer token"
export MCP_AUTH_TOKEN=inspector-smoke-test-token-0123456789
export PORT=3917
node dist/http-main.js &
server=$!
trap 'kill "$server"' EXIT
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
expect_tools_and_match "http://127.0.0.1:$PORT/mcp" --transport http --header "Authorization: Bearer $MCP_AUTH_TOKEN"

echo "Inspector smoke test passed"
