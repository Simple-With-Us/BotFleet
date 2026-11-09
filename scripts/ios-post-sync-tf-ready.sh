#!/usr/bin/env bash
# Post-sync ensure-tf-ready recheck for hosted ios-ship.yml (OPS-1052 / BF-2552).
# Read-only ASC polling; uses the same readiness labels as ship-testflight.sh.
# When readiness is confirmed (rc=0), emits the Sentry TestFlight receipt from
# the post-sync JSON (not the pre-sync pass inside the ship step).
set -euo pipefail

BUILD_NUM="${1:?12-digit CFBundleVersion}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLEET_DIR="${ROOT}/scripts/ios-fleet"
# shellcheck source=scripts/ios-fleet/tf-ready-rc.sh
source "${FLEET_DIR}/tf-ready-rc.sh"

if ! _APP_META_RAW="$(
  python3 - "${FLEET_DIR}/apps.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
apps = data.get("apps") or {}
app = apps.get("botfleet")
if not isinstance(app, dict):
    raise SystemExit(f"missing apps.botfleet in {path}")
bundle = app.get("bundleId")
apple_id = app.get("appleId")
marketing = app.get("fixedMarketingVersion") or app.get("marketingVersionDefault") or ""
if not bundle or not str(bundle).strip():
    raise SystemExit("missing bundleId")
if apple_id is None or str(apple_id).strip() == "":
    raise SystemExit("missing appleId")
if not str(marketing).strip():
    raise SystemExit("missing marketing version")
print(bundle)
print(marketing)
print(apple_id)
PY
)"; then
  echo "::error title=post-sync tf-ready::failed to read BotFleet app metadata from ${FLEET_DIR}/apps.json"
  exit 1
fi
BUNDLE_ID="$(printf '%s\n' "$_APP_META_RAW" | sed -n '1p')"
MARKETING="$(printf '%s\n' "$_APP_META_RAW" | sed -n '2p')"
APPLE_ID="$(printf '%s\n' "$_APP_META_RAW" | sed -n '3p')"
if [[ -z "$BUNDLE_ID" || -z "$MARKETING" || -z "$APPLE_ID" ]]; then
  echo "::error title=post-sync tf-ready::incomplete BotFleet app metadata (bundle, marketing, or apple id)"
  exit 1
fi

[[ "$BUILD_NUM" =~ ^[1-9][0-9]{11}$ ]] || {
  echo "::error::post-sync tf-ready: build '${BUILD_NUM}' is not a 12-digit merge-stamp build"
  exit 1
}

LOG_DIR="${TMPDIR:-/tmp}/ios-tf-post-sync-$$"
mkdir -p "$LOG_DIR"
set +e
node "${FLEET_DIR}/asc-api.mjs" ensure-tf-ready "$BUNDLE_ID" "$BUILD_NUM" "$MARKETING" "$APPLE_ID" \
  >"${LOG_DIR}/ensure-tf-ready.json" 2>"${LOG_DIR}/ensure-tf-ready.err"
rc=$?
set -e

if [[ -s "${LOG_DIR}/ensure-tf-ready.err" ]]; then
  while IFS= read -r line; do log "tf-ready (post-sync): $line"; done <"${LOG_DIR}/ensure-tf-ready.err"
fi

handle_ensure_tf_ready_rc "$rc"
summary="$(tf_ready_rc_summary_label "$rc")"
log "post-sync readiness for BotFleet (${BUNDLE_ID} build ${BUILD_NUM}): rc=${rc} — ${summary}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "tf_ready_rc=${rc}"
    echo "tf_ready_summary=${summary}"
    echo "tf_ready_bundle=${BUNDLE_ID}"
    echo "tf_ready_build=${BUILD_NUM}"
  } >>"$GITHUB_OUTPUT"
fi

emit_sentry_receipt=0
if [[ "$rc" -eq 0 ]]; then
  emit_sentry_receipt=1
else
  log "warning: No confirmed TestFlight readiness after sync; Sentry deployment was not recorded."
fi

if [[ "$emit_sentry_receipt" -eq 1 && -n "${GITHUB_OUTPUT:-}" ]]; then
  archive="${IOS_SHIP_ARCHIVE_PATH:-}"
  commit="${IOS_SHIP_ARCHIVE_COMMIT:-}"
  if [[ -z "$archive" || -z "$commit" ]]; then
    log "warning: post-sync receipt skipped: missing archive path or commit from the ship step"
    echo "sentry_receipt_error=true" >>"$GITHUB_OUTPUT"
    exit 0
  fi
  if ! SENTRY_ARCHIVE_PATH="$archive" SENTRY_READY_FILE="${LOG_DIR}/ensure-tf-ready.json" \
    SENTRY_REPO_ROOT="$ROOT" SENTRY_ARCHIVE_COMMIT="$commit" \
    SENTRY_BUNDLE_ID="$BUNDLE_ID" SENTRY_MARKETING_VERSION="$MARKETING" SENTRY_BUILD_NUMBER="$BUILD_NUM" \
    node "${ROOT}/scripts/sentry-testflight-receipt.mjs"; then
    echo "sentry_receipt_error=true" >>"$GITHUB_OUTPUT"
  fi
fi

exit 0
