#!/usr/bin/env bash
# test-publish-ios-versions.sh - Offline tests for publish-ios-versions.sh.
#
# The publisher's only consumer is record_successful_ship() in
# ship-testflight.sh, and the only thing it updates on the AFC main branch
# is site/ios-versions.json. Without these tests a defect in the merge logic
# would surface as either a missed manifest update (the iOS TestFlight banner
# never fires) or a duplicate commit per ship (the AFC site churns). Both
# are reproducible in a scratch git repo without the network, xcodebuild, or
# App Store Connect, so the tests run as plain bash on any Mac.
#
# Usage: bash scripts/ios-fleet/test-publish-ios-versions.sh
#
# ASCII-only (Apple bash 3.2 safe).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUB="${SCRIPT_DIR}/publish-ios-versions.sh"
[[ -f "$PUB" ]] || { echo "missing $PUB"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/publish-ios-versions-test.XXXXXX")"
cleanup() { /bin/rm -rf "$TMP"; }
trap cleanup EXIT

REPO="${TMP}/afc"
MANIFEST_REL="site/ios-versions.json"
mkdir -p "${REPO}/site"

# A throwaway AFC checkout: empty initial commit on main, real git config so
# the publisher's commit -c user.name=… override is the only thing that has
# to work.  No origin remote — the publisher's push step will refuse, which
# is the same behavior it ships in production when a host has no gh login.
git -C "$REPO" init --quiet -b main >/dev/null 2>&1 || git -C "$REPO" init --quiet >/dev/null 2>&1
git -C "$REPO" config user.email "publisher-test@example.invalid"
git -C "$REPO" config user.name  "publisher test"
# A bare mirror of the repo serves as a fake "origin" so the publisher's
# commit step always succeeds; the publisher's push to that bare mirror will
# fail, which the publisher treats as a non-fatal warning — exactly the same
# shape it ships in production when gh has no login.
ORIGIN="${TMP}/origin.git"
git -C "$ORIGIN" init --quiet --bare >/dev/null
git -C "$REPO" remote add origin "$ORIGIN"

# Baseline manifest matches the live one (a real ship entry plus three other
# apps) so the tests exercise the merge-with-existing-data path that runs on
# every production ship.
cat > "${REPO}/${MANIFEST_REL}" <<'JSON'
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-04T03:58:13Z",
  "apps": {
    "app.botfleet": {
      "marketingVersion": "1.0.29",
      "build": "202609032050",
      "appleId": 6806379515,
      "displayName": "BotFleet"
    },
    "com.contactlogo": {
      "marketingVersion": "1.0.3",
      "build": "202609032049",
      "appleId": 6804247582,
      "displayName": "ContactLogo"
    },
    "net.dealdex": {
      "marketingVersion": "1.0.25",
      "build": "202608251750",
      "appleId": 6802474288,
      "displayName": "DealDex"
    }
  }
}
JSON

git -C "$REPO" add "${MANIFEST_REL}"
git -C "$REPO" commit --quiet -m "initial manifest"

PASS=0
FAIL=0
check() {
  # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  ok  : $1 (=$3)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

run_pub() {
  # run_pub <bundle> <version> [build] [apple-id] [display-name]
  # Translates positional args into the publisher's --flag=value shape so the
  # tests read like the call sites in record_successful_ship().
  local bundle="$1" version="$2" build="${3:-}" apple="${4:-}" display="${5:-}"
  local out
  out="$(AI_FLEET_COORDINATOR_ROOT="$REPO" bash "$PUB" \
    --bundle-id "$bundle" --version "$version" \
    ${build:+--build "$build"} \
    ${apple:+--apple-id "$apple"} \
    ${display:+--display-name "$display"} \
    2>&1)" || true
  printf '%s' "$out"
}

read_field() {
  # read_field <bundle> <json-key> -> value via jq
  jq -r --arg b "$1" --arg k "$2" '.apps[$b][$k] // ""' "${REPO}/${MANIFEST_REL}"
}

echo
echo "=== publish-ios-versions.sh: fresh ship updates all four fields ==="
out="$(run_pub app.botfleet 1.0.32 202609180412 6806379515 BotFleet)"
echo "$out" | sed 's/^/    /'
check "marketingVersion written"   "1.0.32"      "$(read_field app.botfleet marketingVersion)"
check "build written"              "202609180412" "$(read_field app.botfleet build)"
check "appleId written"            "6806379515"  "$(read_field app.botfleet appleId)"
check "displayName written"        "BotFleet"    "$(read_field app.botfleet displayName)"
check "updatedAt refreshed"        "yes"         "$(
  before="$(git -C "$REPO" log --format=%s HEAD~1 2>/dev/null || echo '')"
  after="$(git -C "$REPO" log --format=%s HEAD 2>/dev/null || echo '')"
  if [[ "$before" != "$after" ]]; then echo yes; else echo no; fi
)"

echo
echo "=== idempotent re-run with identical args must not produce a commit ==="
git -C "$REPO" rev-parse HEAD > "${TMP}/before-sha"
run_pub app.botfleet 1.0.32 202609180412 6806379515 BotFleet >/dev/null
git -C "$REPO" rev-parse HEAD > "${TMP}/after-sha"
check "HEAD unchanged" "$(cat "${TMP}/before-sha")" "$(cat "${TMP}/after-sha")"
check "log line says already current" "1" "$(
  AI_FLEET_COORDINATOR_ROOT="$REPO" bash "$PUB" \
    --bundle-id app.botfleet --version 1.0.32 --build 202609180412 \
    --apple-id 6806379515 --display-name BotFleet 2>&1 | grep -c "already current"
)"

echo
echo "=== partial args (version only) preserves appleId, displayName, build ==="
run_pub app.botfleet 1.0.33 >/dev/null
check "marketingVersion updated"   "1.0.33"     "$(read_field app.botfleet marketingVersion)"
check "build preserved"           "202609180412" "$(read_field app.botfleet build)"
check "appleId preserved"         "6806379515" "$(read_field app.botfleet appleId)"
check "displayName preserved"     "BotFleet"   "$(read_field app.botfleet displayName)"

echo
echo "=== brand-new bundle id is created with caller-supplied fields ==="
run_pub com.example.newapp 0.1.0 100 9999999999 Example >/dev/null
check "new bundle present"        "true" "$(
  jq -r --arg k "com.example.newapp" '.apps | has($k) | tostring' "${REPO}/${MANIFEST_REL}"
)"
check "new bundle appleId"        "9999999999"  "$(read_field com.example.newapp appleId)"
check "new bundle displayName"    "Example"     "$(read_field com.example.newapp displayName)"
check "contactlogo untouched"     "1.0.3"       "$(read_field com.contactlogo marketingVersion)"

echo
echo "=== missing --bundle-id and --version fail usage, no commit ==="
git -C "$REPO" rev-parse HEAD > "${TMP}/before-sha"
run_pub "" "" >/dev/null 2>&1 || true
git -C "$REPO" rev-parse HEAD > "${TMP}/after-sha"
check "HEAD unchanged on bad args" "$(cat "${TMP}/before-sha")" "$(cat "${TMP}/after-sha")"

echo
echo "=== dirty AFC working tree is refused (no commit) ==="
echo "x" > "${REPO}/untracked-stale"
git -C "$REPO" add "${REPO}/untracked-stale" 2>/dev/null || true
git -C "$REPO" rev-parse HEAD > "${TMP}/before-sha"
out="$(run_pub app.botfleet 1.0.34 202609190700 6806379515 BotFleet)"
git -C "$REPO" rev-parse HEAD > "${TMP}/after-sha"
check "HEAD unchanged on dirty"   "$(cat "${TMP}/before-sha")" "$(cat "${TMP}/after-sha")"
check "warning names dirty tree"  "1" "$(echo "$out" | grep -c "AFC working tree is dirty")"

echo
echo "=== summary: $PASS pass, $FAIL fail ==="
exit "$FAIL"
