#!/bin/bash
# Lightweight health probe for app.botfleet.server / com.jay.botfleet-server.
set -euo pipefail

PORT="${BOTFLEET_PORT:-8799}"
if /usr/bin/curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  exit 0
fi
exit 1
