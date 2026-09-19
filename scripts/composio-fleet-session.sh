#!/usr/bin/env bash
# composio-fleet-session.sh — Mint a Composio Platform session for a fleet user_id.
#
# Purpose: every seat in the fleet (Mavis, Claude/Monet, Cursor, Codex,
# Grok/Designer, Antigravity) needs its own session MCP URL because the
# session ID is embedded in the URL and each session has its own TTL.  What
# every seat shares is `user_id` — connected accounts (Slack, GitHub, etc.)
# are scoped to user_id, so one OAuth grant flows to every agent that uses
# the same user_id.
#
# Usage:
#   composio-fleet-session.sh [options]
#
# Options:
#   --user-id ID        Fleet user_id (default: jay-fleet)
#   --out PATH          Where to persist the session_id (default: ~/.secrets/composio-session-id)
#   --print-for PLAT    Print a paste-ready MCP config snippet for PLAT
#                       (none|json|claude-code|cursor|antigravity|grok|codex)
#   --check-only        Verify the session_id already at --out; do not mint
#   --no-persist        Don't write to --out (use for one-off inspection)
#   -h, --help          This help
#
# API key resolution order:
#   1. $COMPOSIO_API_KEY env
#   2. ~/.secrets/global-api-keys (line `COMPOSIO_API_KEY="ak_..."`)

set -euo pipefail

USER_ID="jay-fleet"
OUT="$HOME/.secrets/composio-session-id"
PRINT_FOR="none"
CHECK_ONLY=0
PERSIST=1

usage() { sed -n '2,28p' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-id)     USER_ID="$2"; shift 2 ;;
    --out)         OUT="$2"; shift 2 ;;
    --print-for)   PRINT_FOR="$2"; shift 2 ;;
    --check-only)  CHECK_ONLY=1; shift ;;
    --no-persist)  PERSIST=0; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

resolve_api_key() {
  if [[ -n "${COMPOSIO_API_KEY:-}" ]]; then
    printf "%s" "$COMPOSIO_API_KEY"; return 0
  fi
  local key_file="$HOME/.secrets/global-api-keys"
  if [[ ! -r "$key_file" ]]; then
    echo "COMPOSIO_API_KEY not set and $key_file unreadable" >&2
    return 1
  fi
  grep -oE '^COMPOSIO_API_KEY="[^"]+"' "$key_file" | head -1 | sed 's/COMPOSIO_API_KEY="//;s/"$//'
}

mint_session() {
  local api_key="$1" body
  body=$(cat <<EOF
{
  "user_id": "${USER_ID}",
  "manage_connections": {
    "enable": true,
    "enable_wait_for_connections": true,
    "enable_connection_removal": true
  },
  "multi_account": {
    "enable": true,
    "max_accounts_per_toolkit": 5,
    "require_explicit_selection": true
  }
}
EOF
)
  curl -fsS -X POST 'https://backend.composio.dev/api/v3.1/tool_router/session' \
    -H "accept: application/json" \
    -H "x-api-key: ${api_key}" \
    -H "content-type: application/json" \
    -d "$body"
}

verify_session() {
  local api_key="$1" sid="$2"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    "https://backend.composio.dev/api/v3.1/tool_router/session/${sid}" \
    -H "accept: application/json" \
    -H "x-api-key: ${api_key}")
  [[ "$code" == "200" ]]
}

print_summary() {
  local sid="$1" url="$2" api_key="$3"
  echo "user_id:       ${USER_ID}"
  echo "session_id:    ${sid}"
  echo "mcp_url:       ${url}"
  local prefix="${api_key:0:8}"
  echo "x-api-key:     ${prefix}...(length ${#api_key})"
  echo "persisted_to:  ${OUT}"
}

print_config_snippet() {
  local url="$1" api_key="$2" plat="$3"
  case "$plat" in
    none) return ;;
    json)
      cat <<EOF
{
  "mcpServers": {
    "composio": {
      "type": "streamable-http",
      "url": "${url}",
      "headers": { "x-api-key": "${api_key}" }
    }
  }
}
EOF
      ;;
    claude-code)
      cat <<EOF
# Paste into ~/.claude/mcp_servers.json (merge into existing mcpServers):
{
  "mcpServers": {
    "composio": {
      "type": "http",
      "url": "${url}",
      "headers": { "x-api-key": "${api_key}" }
    }
  }
}
EOF
      ;;
    cursor)
      cat <<EOF
# Paste into ~/.cursor/mcp.json (merge into existing mcpServers):
{
  "mcpServers": {
    "composio": {
      "url": "${url}",
      "headers": { "x-api-key": "${api_key}" }
    }
  }
}
EOF
      ;;
    antigravity)
      cat <<EOF
# Settings > Customizations > Open MCP Config (merge into mcpServers):
{
  "mcpServers": {
    "composio": {
      "serverUrl": "${url}",
      "headers": { "x-api-key": "${api_key}" }
    }
  }
}
EOF
      ;;
    grok)
      cat <<EOF
# Grok Connectors -> New Connector -> Custom (paid tier required):
URL:     ${url}
Header:  x-api-key: ${api_key}
EOF
      ;;
    codex)
      cat <<EOF
# ~/.codex/mcp_config.json (or composio login installs the plugin instead):
{
  "mcpServers": {
    "composio": {
      "type": "http",
      "url": "${url}",
      "headers": { "x-api-key": "${api_key}" }
    }
  }
}
EOF
      ;;
    *) echo "Unknown --print-for: $plat" >&2; return 2 ;;
  esac
}

main() {
  local api_key
  api_key=$(resolve_api_key) || exit 1

  local sid="" url=""
  if [[ $CHECK_ONLY -eq 1 && -r "$OUT" ]]; then
    sid=$(head -1 "$OUT" | tr -d '[:space:]')
    if [[ -n "$sid" ]] && verify_session "$api_key" "$sid"; then
      url="https://backend.composio.dev/tool_router/${sid}/mcp"
      print_summary "$sid" "$url" "$api_key"
      print_config_snippet "$url" "$api_key" "$PRINT_FOR"
      exit 0
    fi
    echo "Existing session at ${OUT} is missing or invalid; minting a new one" >&2
  fi

  local resp
  resp=$(mint_session "$api_key")
  sid=$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
  url=$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["mcp"]["url"])')

  if [[ $PERSIST -eq 1 ]]; then
    mkdir -p "$(dirname "$OUT")"
    chmod 700 "$(dirname "$OUT")"
    printf "%s\n" "$sid" > "$OUT"
    chmod 600 "$OUT"
  fi

  print_summary "$sid" "$url" "$api_key"
  print_config_snippet "$url" "$api_key" "$PRINT_FOR"
}

main
