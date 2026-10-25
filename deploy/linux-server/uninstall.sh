#!/bin/bash
# Remove the BotFleet systemd units and the tailnet URL from the Linux server.
#
# The runtime root and the checkout are kept: they hold the data, the logs and
# the engine logins.  Delete them by hand once you are sure nothing needs them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/linux-server/common.sh
. "$SCRIPT_DIR/common.sh"

DRY_RUN=0
ORIGINAL_ARGS=("$@")

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run]

  --dry-run  Print every action instead of running it.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

require_root "${ORIGINAL_ARGS[@]}"

say "removing the tailnet URL on port $TS_HTTPS_PORT"
run tailscale serve "--https=${TS_HTTPS_PORT}" off || note "tailscale serve was not serving on that port"

say "stopping and disabling the units"
run systemctl disable --now "$SERVER_UNIT" "$GATE_UNIT" || note "one of the units was not running"

say "removing the unit files"
run rm -f "/etc/systemd/system/$SERVER_UNIT" "/etc/systemd/system/$GATE_UNIT"
run systemctl daemon-reload

say "done"
note "kept $BF_ROOT (data, logs, config, home)"
note "kept $BF_CODE (the checkout)"
note "delete them by hand when you no longer need the data or the engine logins"
