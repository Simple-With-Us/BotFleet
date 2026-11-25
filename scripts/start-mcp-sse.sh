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
  # seat-mcp/start.sh does — Infisical Fleet-OPS /seat-mcp through the shared
  # scoped reader, never a literal and never a file.
  #
  # The helper resolves the reader, names the consumer's own account and
  # fails closed when there is no reader or no grant.  A helper that is not
  # there refuses the read rather than stopping the service.
  FLEET_INFISICAL_HELPER="$ROOT/scripts/lib/fleet-infisical-read.sh"
  if [ -f "$FLEET_INFISICAL_HELPER" ]; then
    . "$FLEET_INFISICAL_HELPER"
  else
    fleet_secret_get() {
      echo "the scoped reader helper is not installed at ${FLEET_INFISICAL_HELPER}" >&2
      return 4
    }
  fi
  SEAT_MCP_TOKEN="$(fleet_secret_get SEAT_MCP_TOKEN "/seat-mcp" "${FLEET_INFISICAL_SEAT_MCP_ACCOUNT:-seat-mcp-ro}" 2>/dev/null || true)"
fi
if [ -z "$SEAT_MCP_TOKEN" ]; then
  echo "[FATAL] SEAT_MCP_TOKEN or BOTFLEET_MCP_TOKEN must be exported for the pm2 service" >&2
  exit 1
fi
export SEAT_MCP_TOKEN

exec "$NODE" --experimental-strip-types scripts/mcp-sse.ts
