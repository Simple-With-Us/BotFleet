#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
export BOTFLEET_MCP_PORT="${BOTFLEET_MCP_PORT:-8794}"
export BOTFLEET_URL="${BOTFLEET_URL:-http://127.0.0.1:8799}"

export SEAT_MCP_TOKEN="${SEAT_MCP_TOKEN:-${BOTFLEET_MCP_TOKEN:-}}"
if [ -z "$SEAT_MCP_TOKEN" ]; then
  # BF-2457: the pm2 service had no token and crash-looped on this FATAL for
  # days. Fetch from the fleet secret source instead, the same way
  # seat-mcp/start.sh does — Infisical Fleet-OPS /seat-mcp via fleet-secrets,
  # never a literal and never a file.
  FLEET_SECRETS="${FLEET_SECRETS:-$HOME/.local/bin/fleet-secrets}"
  if [ -x "$FLEET_SECRETS" ]; then
    SEAT_MCP_TOKEN="$("$FLEET_SECRETS" get SEAT_MCP_TOKEN --path /seat-mcp 2>/dev/null || true)"
  fi
fi
if [ -z "$SEAT_MCP_TOKEN" ]; then
  echo "[FATAL] SEAT_MCP_TOKEN or BOTFLEET_MCP_TOKEN must be exported for the pm2 service" >&2
  exit 1
fi
export SEAT_MCP_TOKEN

exec "$NODE" --experimental-strip-types scripts/mcp-sse.ts
