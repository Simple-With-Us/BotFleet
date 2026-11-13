#!/bin/bash
# Update the BotFleet harness on the Linux server to the deployed ref.
#
# The checkout is updated in place and detached at origin/$BF_REF, the
# dependencies and the UI are rebuilt, and both units are restarted.  A dirty
# checkout is refused: an update must never discard local work.
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

Environment overrides: BF_USER, BF_GROUP, BF_ROOT, BF_CODE, BF_REPO, BF_REF,
TS_HTTPS_PORT, GATE_PORT.
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

require_under_volume "$BF_ROOT" "BF_ROOT"
require_under_volume "$BF_CODE" "BF_CODE"

if [ ! -d "$BF_CODE/.git" ]; then
  die "there is no checkout in $BF_CODE; run install.sh first"
fi

say "checking the checkout in $BF_CODE"
dirty="$(as_user git -C "$BF_CODE" status --porcelain || true)"
if [ -n "$dirty" ]; then
  die "the checkout in $BF_CODE has local changes; commit or stash them first"
fi

say "fetching origin and checking out origin/$BF_REF"
run as_user git -C "$BF_CODE" fetch origin
run as_user git -C "$BF_CODE" checkout --detach "origin/$BF_REF"
note "now at $(as_user git -C "$BF_CODE" rev-parse --short HEAD)"

say "installing dependencies and building the UI"
# The root compiler rewrites dependency exports; cached installs need independent copies and lifecycle execution.
run as_user sh -c "cd '$BF_CODE' && pnpm install --frozen-lockfile --force --package-import-method=copy --config.optimistic-repeat-install=false --store-dir '$PNPM_STORE_DIR'"
run as_user sh -c "cd '$BF_CODE' && pnpm exec vite build"

say "restarting the harness and the owner gate"
run systemctl restart "$SERVER_UNIT" "$GATE_UNIT"

say "waiting for the harness to answer"
if wait_for_health "$HARNESS_PORT"; then
  note "the harness is healthy on 127.0.0.1:${HARNESS_PORT}"
else
  die "the harness did not answer http://127.0.0.1:${HARNESS_PORT}/api/health within 60s; check $BF_ROOT/logs/server.log"
fi

note "$SERVER_UNIT: $(systemctl is-active "$SERVER_UNIT" || true)"
note "$GATE_UNIT: $(systemctl is-active "$GATE_UNIT" || true)"
say "done"
