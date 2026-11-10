#!/usr/bin/env bash
# Suppress inherited tracing before any credential can be inspected.
{ set +x; } 2>/dev/null
set +o xtrace
export -n SHELLOPTS BASH_XTRACEFD 2>/dev/null || true
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_ROOT}/scripts/cursor-cloud-bootstrap.mjs"
