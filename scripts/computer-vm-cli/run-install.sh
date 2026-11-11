#!/usr/bin/env bash
# Install manifest-selected CLIs for cloud-agent or local-vm surfaces.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENVIRONMENT="${1:-cloud}"
SCRIPT="$(node --experimental-strip-types "${REPO_ROOT}/scripts/computer-vm-cli/install.mjs" "${ENVIRONMENT}")"
if [ "$(id -u)" -eq 0 ]; then
  bash -c "$SCRIPT"
else
  printf '%s\n' "$SCRIPT" | sudo bash
fi
