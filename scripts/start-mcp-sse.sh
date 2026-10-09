#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
export BOTFLEET_MCP_PORT="${BOTFLEET_MCP_PORT:-8794}"
export BOTFLEET_URL="${BOTFLEET_URL:-http://127.0.0.1:8799}"

export SEAT_MCP_TOKEN="${SEAT_MCP_TOKEN:-${BOTFLEET_MCP_TOKEN:-}}"
if [ -z "$SEAT_MCP_TOKEN" ]; then
  echo "[FATAL] SEAT_MCP_TOKEN or BOTFLEET_MCP_TOKEN must be exported for the pm2 service" >&2
  exit 1
fi
export SEAT_MCP_TOKEN

exec "$NODE" --experimental-strip-types scripts/mcp-sse.ts
