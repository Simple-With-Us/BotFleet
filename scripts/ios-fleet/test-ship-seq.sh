#!/usr/bin/env bash
# test-ship-seq.sh - Offline tests for ship-testflight.sh's version rules.
#
# Covers:
#   1. ORDERING: a run rejected by the ship gate must NOT resolve or consume
#      a version.  It used to: the gate was evaluated after the counter had
#      already been advanced, so a rate-limited attempt burned a version that
#      shipped nowhere (observed live: skipped at 4392s of a 9000s interval,
#      and the sequence still went 5 -> 6).
#   2. SCHEME (owner directive 2026-10-24, AFC-517): the marketing version is
#      the NEXT PATCH on the app's train (<prefix>.<P+1>, P from App Store
#      Connect), and the build number is INDEPENDENT of it:  the repo commit
#      count, raised above the App Store Connect floor.  The pair never reads
#      "1.0.N (N)" any more.
#   3. COUNTER: the local build-seq counter is retired.  Nothing writes it and
#      nothing reads it, so a leftover from an older scheme cannot push the
#      build number above the commit count it names.
#
# The App Store Connect answers come from a STUB `node` in FAKE_BIN:  it
# answers `asc-api.mjs latest-marketing-patch` with $FAKE_ASC_PATCH and
# `asc-api.mjs build-floor` with $FAKE_ASC_FLOOR (default 0), and exits 2 for
# anything else -- which is exactly what an unreachable App Store Connect
# looks like to the ship script.  Nothing here reaches the network.
#
# Everything runs offline against scratch state:
#   HOME                -> scratch (so no real home files exist and App Store
#                          Connect is never contacted; also makes it impossible
#                          for a test to touch the real ~/.cache/ios-fleet)
#   IOS_FLEET_STATE_DIR -> scratch last-ship file
#   PATH                -> a fake `xcodebuild` that refuses to archive and a
#                          fake `node` (passed as IOS_FLEET_NODE) that
#                          answers the ASC queries
# No network, no Xcode, no credentials. Runs on macOS and Linux.
#
# Usage:
#   bash scripts/ios-fleet/test-ship-seq.sh
#
# Exit 0 = all pass. Exit 1 = at least one failure (details on stdout).
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Sections 1-12 test the unchanged next-patch behaviour, so they run a copy of
# the fleet dir whose apps.json carries no fixed-version keys.  Section 13 tests
# the keys on their own copy.
LEGACY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-legacy.XXXXXX")"
cp -R "$SCRIPT_DIR/." "$LEGACY_DIR/"
python3 - "$LEGACY_DIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for a in d["apps"].values():
    a.pop("fixedMarketingVersion", None)
    a.pop("buildCountSeed", None)
    a.pop("macBundleId", None)
    a.pop("pairedBundleId", None)
    a.pop("pairedBuildFeed", None)
json.dump(d, open(p, "w"), indent=2)
PY
SHIP="${LEGACY_DIR}/ship-testflight.sh"
[[ -f "$SHIP" ]] || { echo "missing $SHIP"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-seq-test.XXXXXX")"
trap 'rm -rf "$WORK" "$LEGACY_DIR"' EXIT

FAKE_HOME="${WORK}/home"
FAKE_BIN="${WORK}/bin"
STATE="${WORK}/state"
REPO="${WORK}/repo"
mkdir -p "$FAKE_HOME" "$FAKE_BIN" "$STATE" "$REPO" "${WORK}/tmp"

# The app keys this repo's scripts/ios-fleet/apps.json defines.
APP_KEYS="botfleet"

# A fake xcodebuild: answers -version, and hard-fails on anything else so a test
# can never start a real archive.
cat >"${FAKE_BIN}/xcodebuild" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "-version" ]]; then
  echo "Xcode 26.0"
  echo "Build version 17A000"
  exit 0
fi
echo "FAKE xcodebuild called with: $*" >&2
exit 99
FAKE
chmod +x "${FAKE_BIN}/xcodebuild"

# A stub `node`:  answers the two App Store Connect version queries from the
# environment and exits 2 for everything else.  Exiting 2 is what the ship
# script sees when App Store Connect cannot be consulted, so a test can drive
# the unreachable-App-Store-Connect path without a network.
#
# The build-floor answer also carries the "train=N app=N -> floor=N" note the
# ship script parses for the version-plan log line;  without it the two floors
# would fall back to the floor itself.
#
# The key VALIDATOR is the real one:  the diagnostic resolves the credential
# the way the client does, so a stub that refuses the validation leaves the
# masked preview withheld and the rejected credential unnamed.  The real node
# is captured here, before the stub exists, so the result does not depend on
# an ambient node in /opt/homebrew/bin or /usr/local/bin --  a runner without
# one used to leave the preview withheld and the assertion failed there.
real_node="$(command -v node)"
cat >"${FAKE_BIN}/node" <<FAKE
#!/usr/bin/env bash
cmd=""
for a in "\$@"; do
  case "\$a" in
    */asc-api.mjs) cmd="asc-api" ;;
    latest-marketing-patch|build-floor|released-store-version|next-shared-build|plan-release-build|max-build)
      if [[ "\$cmd" == "asc-api" ]]; then cmd="\${cmd}:\${a}"; fi
      ;;
  esac
done
case "\$cmd" in
  asc-api:latest-marketing-patch)
    # No stubbed patch = App Store Connect cannot be consulted.
    # "auth" = App Store Connect rejected the key (asc-api exits 4).
    [[ "\${FAKE_ASC_PATCH:-}" == "auth" ]] && exit 4
    [[ -n "\${FAKE_ASC_PATCH:-}" ]] || exit 2
    printf '%s\n' "\$FAKE_ASC_PATCH"
    exit 0
    ;;
  asc-api:released-store-version)
    [[ "\${FAKE_RELEASED:-}" == "fail" ]] && exit 2
    printf '%s\n' "\${FAKE_RELEASED:-}"
    exit 0
    ;;
  asc-api:next-shared-build|asc-api:plan-release-build)
    [[ -n "\${FAKE_ARGV_LOG:-}" ]] && printf '%s\n' "\$*" >>"\$FAKE_ARGV_LOG"
    [[ "\${FAKE_SHARED:-}" == "fail" ]] && exit 3
    [[ -n "\${FAKE_SHARED:-}" ]] || exit 2
    printf '%s\n' "\$FAKE_SHARED"
    exit 0
    ;;
  asc-api:max-build)
    [[ -n "\${FAKE_ARGV_LOG:-}" ]] && printf '%s\n' "\$*" >>"\$FAKE_ARGV_LOG"
    [[ "\${FAKE_MAXTHIS:-}" == "fail" ]] && exit 3
    [[ -n "\${FAKE_MAXTHIS:-}" ]] || exit 2
    [[ "\${FAKE_MAXTHIS:-}" == "empty" ]] && { printf '\n'; exit 0; }
    printf '%s\n' "\$FAKE_MAXTHIS"
    exit 0
    ;;
  asc-api:build-floor)
    _floor="\${FAKE_ASC_FLOOR:-0}"
    printf '%s\n' "\$_floor"
    echo "build-floor: train=\${_floor} app=\${_floor} -> floor=\${_floor}" >&2
    exit 0
    ;;
esac
# The key validator is the real one.  The staged WRITE stays refused, exactly
# as it was before the stub delegated.
if [[ "\${1:-}" == *asc-key.mjs ]]; then
  if [[ "\${2:-}" == "write" ]]; then exit 2; fi
  exec "$real_node" "\$@"
fi
exit 2
FAKE
chmod +x "${FAKE_BIN}/node"

# A stub fleet-secrets that always reports "absent", so ASC credentials stay
# unset and no test can reach the real Infisical (the script falls back to
# fleet-secrets on PATH).
printf '#!/usr/bin/env bash\nexit 3\n' >"${FAKE_BIN}/fleet-secrets"
chmod +x "${FAKE_BIN}/fleet-secrets"
export FLEET_SECRETS="${FAKE_BIN}/fleet-secrets"

# A tiny clean git repo so repo_head_sha() has a real, stable SHA.
git -C "$REPO" init -q 2>/dev/null || git -C "$REPO" init >/dev/null
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "seq test"
echo seed >"${REPO}/README"
git -C "$REPO" add README
git -C "$REPO" -c commit.gpgsign=false commit -qm seed
# Seed enough commits that the repo's commit count sits ABOVE the floor these
# tests use, so the normal path is exercised:  the build number is the commit
# count and the floor guard does not fire.  With a one-commit fixture the
# floor wins and every version assertion ends up testing the guard instead of
# the scheme.
_seed=2
while [ "$_seed" -le 6 ]; do
  echo "seed $_seed" >>"${REPO}/README"
  git -C "$REPO" add README
  git -C "$REPO" -c commit.gpgsign=false commit -qm "seed $_seed"
  _seed=$((_seed + 1))
done
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
# Owner directive 2026-10-24 (AFC-517): the build number starts from the commit
# count.  Read the count from the fixture instead of hard-coding it, so adding
# a seed commit to the harness cannot silently stale the assertions.
COMMIT_COUNT="$(git -C "$REPO" rev-list --count HEAD)"

SEQ_FILE="${STATE}/build-seq-botfleet.txt"
SHIP_FILE="${STATE}/last-ship-botfleet.txt"

# The App Store Connect answers the stub gives.  Unset = unreachable.
FAKE_ASC_PATCH=""
FAKE_ASC_FLOOR=""

PASS=0
FAIL=0
OUT=""
RC=0

# run_ship <args...> - invoke ship-testflight.sh in the sandbox.
# SHIP_TMPDIR overrides the TMPDIR the sandboxed run sees, so a test can
# drive the root-TMPDIR path.  It defaults to a scratch directory under the
# sandbox, which is what every other case wants.
# The synthetic credential is handed to the sandboxed run through an
# INHERITED DESCRIPTOR, never through a command argument:  an argument is
# readable by every process on the machine through ps.  The here-string that
# carries it is a temporary file that bash unlinks as soon as it is open, so
# nothing is left on disk either.  The key id and the issuer are public
# labels, so they stay in the environment where the run expects them.
run_ship() {
  # A credential is EXPECTED whenever the case put one in TEST_ASC_KEY_P8:
  # the descriptor handoff must then be proven to have delivered it.
  local expect_key=0
  [[ -n "${TEST_ASC_KEY_P8:-}" ]] && expect_key=1
  case "${EXPECT_ASC_KEY:-}" in
    0) expect_key=0 ;;
    1) expect_key=1 ;;
  esac
  OUT="$(
    exec 3<<<"${TEST_ASC_KEY_P8:-}"
    env -i \
    HOME="$FAKE_HOME" \
    PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="${SHIP_TMPDIR:-${WORK}/tmp}" \
    IOS_FLEET_STATE_DIR="$STATE" \
    FLEET_SECRETS="${FAKE_BIN}/fleet-secrets" \
    IOS_FLEET_NODE="${FAKE_BIN}/node" \
    ASC_KEY_ID="${TEST_ASC_KEY_ID:-}" \
    ASC_ISSUER_ID="${TEST_ASC_ISSUER_ID:-}" \
    FAKE_ASC_PATCH="$FAKE_ASC_PATCH" \
    FAKE_ASC_FLOOR="$FAKE_ASC_FLOOR" \
    FAKE_RELEASED="${FAKE_RELEASED:-}" \
    FAKE_SHARED="${FAKE_SHARED:-}" \
    FAKE_MAXTHIS="${FAKE_MAXTHIS:-}" \
    FAKE_CURL_FAIL="${FAKE_CURL_FAIL:-}" \
    FAKE_CURL_BODY="${FAKE_CURL_BODY:-}" \
    FAKE_CURL_ERR="${FAKE_CURL_ERR:-}" \
    FAKE_CURL_LOG="${FAKE_CURL_LOG:-}" \
    FAKE_ARGV_LOG="${FAKE_ARGV_LOG:-}" \
    EXPECT_ASC_KEY="$expect_key" \
    bash -c '
      if [[ "${EXPECT_ASC_KEY:-0}" == "1" ]]; then
        # The credential is EXPECTED here.  An unreadable or empty descriptor
        # is a FAILURE of this harness, not a missing credential:  it has to
        # be loud, or every case would report "missing credentials" and pass
        # vacuously.
        if [[ ! -r /dev/fd/3 ]]; then
          echo "FLEET-TEST: the inherited credential descriptor was not readable" >&2
          exit 90
        fi
        _pem="$(cat <&3)"
        if [[ -z "$_pem" ]]; then
          echo "FLEET-TEST: the inherited credential descriptor was empty" >&2
          exit 91
        fi
        export ASC_KEY_P8="$_pem"
        unset _pem
        echo "FLEET-TEST-CREDENTIAL-ARRIVED"
      elif [[ -r /dev/fd/3 ]]; then
        _pem="$(cat <&3)"
        if [[ -n "$_pem" ]]; then export ASC_KEY_P8="$_pem"; fi
        unset _pem
      fi
      exec bash "$1" "${@:2}"
    ' _ "$SHIP" "$@" 2>&1
  )"
  RC=$?
  # The marker is matched and stripped with BASH pattern removal, never with
  # grep:  the captured output carries a UTF-8 em-dash (ship-testflight.sh
  # logs "ship-gate: skip - ..."), and under a C/POSIX locale grep treats
  # that stream as BINARY and replaces the whole capture with a binary-file
  # message, which would make every later assertion fail misleadingly.
  if [[ "$expect_key" == "1" && "$OUT" != *"FLEET-TEST-CREDENTIAL-ARRIVED"* ]]; then
    bad "the credential never reached the sandboxed run (rc=${RC})"
  fi
  # The marker is the harness's own line, and the cases match on the ship
  # script's output, so it is stripped before they look.
  OUT="$(
    while IFS= read -r _line; do
      [[ "$_line" == "FLEET-TEST-CREDENTIAL-ARRIVED" ]] || printf '%s\n' "$_line"
    done <<< "$OUT"
  )"
  return 0
}

ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1"
  # The captured output is NOT printed:  it can carry the credential the
  # case put in the environment, and a failure message lands in the CI log.
  # The count of lines is enough to see that something was produced.
  echo "        (output withheld: it can carry credential bytes; ${#OUT} bytes captured, rc=${RC})"
}

check() { # check <desc> <condition-result 0/1>
  if [[ "$2" -eq 0 ]]; then ok "$1"; else bad "$1"; fi
}

seq_now() { cat "$SEQ_FILE" 2>/dev/null || echo MISSING; }
# Literal substring. grep is a bad fit here: skip lines carry a UTF-8 em-dash
# (C-locale grep then treats the stream as binary) and marketing/build
# needles contain '.' / '()'.
contains() { [[ "$OUT" == *"$1"* ]]; }

# The planned pair, read out of the "marketing=<m> build=<b>" log line.
planned_pair() {
  # The planned pair is read out of the "marketing=<m> build=<b>" log line.
  # grep runs with -a:  the capture carries a UTF-8 em-dash, and under a
  # C/POSIX locale grep treats that stream as binary and would refuse to
  # match.  -a makes grep treat the stream as text.
  local line
  line="$(printf '%s' "$OUT" | grep -a -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  PLANNED_MARKETING="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  PLANNED_BUILD="$(printf '%s' "$line" | sed 's/^.* build=//')"
}

reset_state() {
  rm -f "$SEQ_FILE" "$SHIP_FILE"
  printf '5' >"$SEQ_FILE"
}

# The path below is the projectRel entry for the botfleet key in this repo's
# scripts/ios-fleet/apps.json.  project.pbxproj is NOT a sequencing input any
# more (AFC-517):  the fixture exists so the run gets past the "project not
# found" check and reaches the version resolution.
project_rel() { # <app key>
  case "$1" in
    botfleet) printf '%s' 'ios/BotFleet.xcodeproj' ;;
    *)        return 1 ;;
  esac
}

write_record() { # <app key> <record N>
  local rel dir
  rel="$(project_rel "$1")" || return 1
  dir="${REPO}/${rel}"
  mkdir -p "$dir"
  {
    echo '/* fixture project.pbxproj */'
    echo "        CURRENT_PROJECT_VERSION = ${2};"
    echo "        MARKETING_VERSION = 1.0.${2};"
  } >"${dir}/project.pbxproj"
}

remove_record() { # <app key>
  local rel
  rel="$(project_rel "$1")" || return 1
  rm -f "${REPO}/${rel}/project.pbxproj"
  rmdir "${REPO}/${rel}" 2>/dev/null || true
}

echo "ship-testflight.sh version tests"
echo "state=${STATE}"
echo

# --- 1. Rate-limited run must not consume ----------------------------------
echo "1. ship gate: rate-limited run does not resolve a version"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq
check "exits 0 (nothing to do)" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the rate-limit skip" "$(contains 'ship-gate: skip' && echo 0 || echo 1)"
check "sequence still 5 (was 5 -> 6 before the fix)" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "names the override (IOS_TF_MIN_INTERVAL_SEC / --force-ship)" \
  "$(contains 'IOS_TF_MIN_INTERVAL_SEC' && contains 'force-ship' && echo 0 || echo 1)"
check "names the 3600s default and where it lives" \
  "$(contains '3600s' && contains 'DEFAULT_MIN_INTERVAL_SEC' && echo 0 || echo 1)"
check "skips the App Store Connect round trip entirely" \
  "$(contains 'version plan:' && echo 1 || echo 0)"
echo

# --- 2. Same-HEAD run must not consume -------------------------------------
echo "2. ship gate: already-shipped HEAD does not resolve a version"
reset_state
printf '%s %s\n' "1" "$HEAD_SHA" >"$SHIP_FILE"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the same-HEAD skip" "$(contains 'already shipped' && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 3. A run the gate allows does not advance the counter -----------------
echo "3. ship gate: an allowed run proceeds without advancing the counter"
reset_state
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq
check "proceeds past the gate" "$(contains 'no prior ship' && echo 0 || echo 1)"
check "stops at the missing project (never archives)" \
  "$(contains 'project not found' && echo 0 || echo 1)"
check "the local counter is not advanced (it is not the build number now)" \
  "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "the planned build number is the commit count" \
  "$(contains "build=${COMMIT_COUNT}" && echo 0 || echo 1)"
check "an unverified patch plans the first patch of the train" \
  "$(contains 'marketing=1.0.1 build=' && echo 0 || echo 1)"
check "says loudly that the patch was unverified" \
  "$(contains 'UNVERIFIED' && echo 0 || echo 1)"
echo

# --- 4. --dry-run must not consume -----------------------------------------
echo "4. --dry-run does not ship anything"
reset_state
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "plans the build number without shipping it" \
  "$(contains "build=${COMMIT_COUNT}" && echo 0 || echo 1)"
echo

# --- 5. --dry-run reports a gated run without consuming --------------------
echo "5. --dry-run still reports the gate outcome"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "says the gate would skip" "$(contains 'would SKIP' && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 6. --upload-only must not consume -------------------------------------
echo "6. --upload-only does not resolve a version"
reset_state
: >"${WORK}/fake.ipa"
run_ship botfleet --repo-root "$REPO" --upload-only "${WORK}/fake.ipa"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "says the version comes from the IPA" \
  "$(contains 'from the existing IPA' && echo 0 || echo 1)"
echo

# --- 7. --force-ship still bypasses the gate ------------------------------
echo "7. --force-ship bypasses the gate"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq --force-ship
check "bypasses the gate" "$(contains 'bypassing min-interval' && echo 0 || echo 1)"
check "the local counter is still not advanced" \
  "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 8. The version scheme (owner directive 2026-10-24, AFC-517) -----------
echo "8. version scheme: next patch on the train, independent build number"
FAKE_ASC_PATCH=236
FAKE_ASC_FLOOR=0
for app in $APP_KEYS; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  run_ship "$app" --repo-root "$REPO" --allow-dirty --dry-run
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: the marketing version is the next patch on the train (got '${mk}')" \
    "$([[ "$mk" == "1.0.237" ]] && echo 0 || echo 1)"
  check "${app}: the build number is the repo commit count (got '${bn}')" \
    "$([[ "$bn" == "$COMMIT_COUNT" ]] && echo 0 || echo 1)"
  check "${app}: the build number is not the patch number (no '1.0.N (N)')" \
    "$([[ "$bn" != "237" ]] && echo 0 || echo 1)"
  check "${app}: the marketing version is not 1.0.<build> (got '${mk}' / '${bn}')" \
    "$([[ "$mk" != "1.0.${bn}" ]] && echo 0 || echo 1)"
  check "${app}: reports the App Store Connect rendering" \
    "$(contains "will show this as: ${mk} (${bn})" && echo 0 || echo 1)"
  check "${app}: prints the version plan line" \
    "$(contains 'version plan: asc_patch=236 -> marketing=1.0.237' && echo 0 || echo 1)"
  check "${app}: the version plan line names the floors it used" \
    "$(contains "build floors: train=0 app=0 commit_count=${COMMIT_COUNT} -> build=${COMMIT_COUNT}" && echo 0 || echo 1)"
  remove_record "$app"
done

# The floor above the commit count:  the build number moves to floor + 1 and
# the marketing version stays the next patch.  The two numbers are
# independent, so the floor never moves the version.
FLOOR_HIGH=202610180036
for app in $APP_KEYS; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_FLOOR="$FLOOR_HIGH"
  run_ship "$app" --repo-root "$REPO" --allow-dirty --dry-run
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: a floor above the commit count raises the build to floor + 1 (got '${bn}')" \
    "$([[ "$bn" == "$((FLOOR_HIGH + 1))" ]] && echo 0 || echo 1)"
  check "${app}: the floor does not move the marketing version (got '${mk}')" \
    "$([[ "$mk" == "1.0.237" ]] && echo 0 || echo 1)"
  check "${app}: the marketing version is not 1.0.<build> (got '${mk}' / '${bn}')" \
    "$([[ "$mk" != "1.0.${bn}" ]] && echo 0 || echo 1)"
  remove_record "$app"
done
FAKE_ASC_FLOOR=0

# --version pins the marketing version exactly, and the build number is then
# floored against THAT train.
for app in $APP_KEYS; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_FLOOR=202610180036
  run_ship "$app" --repo-root "$REPO" --allow-dirty --dry-run --version 1.0.236
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: --version is honoured exactly (got '${mk}')" \
    "$([[ "$mk" == "1.0.236" ]] && echo 0 || echo 1)"
  check "${app}: the build is floored against the pinned train (got '${bn}')" \
    "$([[ "$bn" == "202610180037" ]] && echo 0 || echo 1)"
  check "${app}: the marketing version is not 1.0.<build> (got '${mk}' / '${bn}')" \
    "$([[ "$mk" != "1.0.${bn}" ]] && echo 0 || echo 1)"
  remove_record "$app"
done
FAKE_ASC_FLOOR=0

# A pinned patch with a leading zero is still compared in base 10, so the
# 1.0.N (N) guard bumps the build instead of reading "0237" as octal 159.
for app in $APP_KEYS; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_FLOOR=236
  run_ship "$app" --repo-root "$REPO" --allow-dirty --dry-run --version 1.0.0237
  planned_pair
  check "${app}: a leading-zero pinned patch still bumps the build off 237 (got '${PLANNED_MARKETING}' / '${PLANNED_BUILD}')" \
    "$([[ "$PLANNED_BUILD" == "238" ]] && echo 0 || echo 1)"
  check "${app}: the 1.0.N guard does not trip bash arithmetic" \
    "$(contains 'value too great for base' && echo 1 || echo 0)"
  remove_record "$app"
done
FAKE_ASC_FLOOR=0

# --build pins the build number exactly, and the marketing version is still
# the automatic next patch.
for app in $APP_KEYS; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_FLOOR=202610180036
  run_ship "$app" --repo-root "$REPO" --allow-dirty --dry-run --build 999
  planned_pair
  mk="$PLANNED_MARKETING"
  bn="$PLANNED_BUILD"

  check "${app}: --build is honoured exactly (got '${bn}')" \
    "$([[ "$bn" == "999" ]] && echo 0 || echo 1)"
  check "${app}: --build does not move the marketing version (got '${mk}')" \
    "$([[ "$mk" == "1.0.237" ]] && echo 0 || echo 1)"
  remove_record "$app"
done
FAKE_ASC_FLOOR=0

# Without --allow-unverified-seq, an unreachable App Store Connect is fatal:
# the marketing version and the build floor both come from it.
for app in $APP_KEYS; do
  rm -f "${STATE}/build-seq-${app}.txt" "${STATE}/last-ship-${app}.txt"
  write_record "$app" 5
  FAKE_ASC_PATCH=""
  run_ship "$app" --repo-root "$REPO" --allow-dirty --dry-run
  check "${app}: an unreachable App Store Connect fails the run (rc=${RC})" \
    "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
  check "${app}: says what could not be determined" \
    "$(contains 'cannot determine the next marketing version' && echo 0 || echo 1)"
  check "${app}: does not ship a version it could not verify" \
    "$(contains 'marketing=1.0.' && echo 1 || echo 0)"
  remove_record "$app"
done
FAKE_ASC_PATCH=236
echo

# --- 9. The counter no longer decides the version -------------------------
echo "9. the counter stays put; the version comes from App Store Connect"
rm -f "$SEQ_FILE" "$SHIP_FILE"
printf '5' >"$SEQ_FILE"
seen=""
for i in 1 2 3; do
  run_ship botfleet --repo-root "$REPO" --dry-run
  seen="${seen} $(seq_now)"
done
check "three allowed runs leave the counter at 5 (got:${seen})" \
  "$([[ "$seen" == " 5 5 5" ]] && echo 0 || echo 1)"
check "the run planned the next patch on the train" \
  "$(contains 'marketing=1.0.237' && echo 0 || echo 1)"
echo

# --- 10. Standing 1-hour gate: just-under skips, at-or-over proceeds -------
# Owner 2026-08-14: unbuilt iOS updates may ship as often as once per hour.
# Pin both sides of the boundary so a future edit of DEFAULT_MIN_INTERVAL_SEC
# cannot silently restore 2.5h (or drop the gate) without this suite going red.
# A different HEAD is required so this is not the same-HEAD skip.
# Margins (3000 / 3700) absorb the second that passes between writing the
# state file and the script reading `date +%s`.
echo "10. 1-hour standing gate: 3000s still skips; 3700s proceeds"
reset_state
printf '%s %s\n' "$(( $(date +%s) - 3000 ))" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq
check "3000s ago is still gated" "$(contains 'ship-gate: skip' && echo 0 || echo 1)"
check "3000s ago does not consume a number" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
reset_state
printf '%s %s\n' "$(( $(date +%s) - 3700 ))" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq
check "3700s ago proceeds past the gate" "$(contains 'ship-gate: skip' && echo 1 || echo 0)"
check "3700s ago does not advance the counter" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 11. ASC unverified die-text names the real cause ------------------------
# The local build-seq counter is retired, so it is not a floor source and the
# die text must not blame it.  The cause is App Store Connect being
# unverifiable, and that alone is fatal.
echo "11. unverified ASC die-text names App Store Connect, not the local counter"
reset_state
# An empty stubbed patch is exactly what an unreachable App Store Connect
# looks like to the ship script.
FAKE_ASC_PATCH=""
run_ship botfleet --repo-root "$REPO"
check "exits 1 without --allow-unverified-seq" "$([[ $RC -eq 1 ]] && echo 0 || echo 1)"
check "does not claim there is no local sequence" \
  "$(contains 'there is no local sequence' && echo 1 || echo 0)"
check "the retired local counter does not feed the floor" \
  "$(contains 'local=0' && echo 1 || echo 0)"
check "names the marketing version as what could not be determined" \
  "$(contains 'cannot determine the next marketing version' && echo 0 || echo 1)"
check "names App Store Connect as the cause" \
  "$(contains 'App Store Connect could not be' && echo 0 || echo 1)"
FAKE_ASC_PATCH=236
echo

# --- rejected API key -----------------------------------------------------
# A 401/403 from App Store Connect is not "unreachable":  even
# --allow-unverified-seq must not plan a version around a key Apple rejects.
echo "rejected API key: fatal even with --allow-unverified-seq"
reset_state 2>/dev/null || true
FAKE_ASC_PATCH=auth
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq --dry-run
check "a rejected key fails the run (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "says the key was rejected" "$(contains 'rejected the API key' && echo 0 || echo 1)"
check "plans no version around it" "$(contains 'UNVERIFIED patch' && echo 1 || echo 0)"
# The rejected credential is named by its KEY ID and its ISSUER ID, the two
# public labels that travel in every App Store Connect request header, so
# the owner can tell exactly which key Apple refused.  NOTHING taken out of
# the key is printed:  every byte of a private-key body is secret, and a
# first-eight/last-four slice of it could not even identify the credential,
# because two different keys share one.
# A REAL key pair, generated here and never committed:  the diagnostic
# resolves the credential the way the client does, and a value that is not a
# usable PEM is skipped by both.
syn_pem="$(node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }))')"
syn_body="$(printf '%s\n' "$syn_pem" | sed '1d;$d' | tr -d ' \n')"
TEST_ASC_KEY_ID="ABCDE12345"
TEST_ASC_ISSUER_ID="issuer-synthetic"
TEST_ASC_KEY_P8="$syn_pem"
run_ship botfleet --repo-root "$REPO" --allow-unverified-seq --dry-run
check "names the rejected key by its key id" \
  "$(contains 'key id ABCDE12345' && echo 0 || echo 1)"
check "names the rejected key by its issuer id" \
  "$(contains 'issuer id issuer-synthetic' && echo 0 || echo 1)"
check "does not print the key or any masked slice of it" \
  "$([[ "$OUT" != *"$syn_body"* && "$OUT" != *"${syn_body:0:8}...${syn_body:$((${#syn_body}-4))}"* ]] && echo 0 || echo 1)"
TEST_ASC_KEY_ID=""
TEST_ASC_ISSUER_ID=""
TEST_ASC_KEY_P8=""
unset syn_body syn_pem
FAKE_ASC_PATCH=236
echo

# --- 12. A root TMPDIR is a PATH failure, not a credential failure ----------
# The version plan consults App Store Connect before the run creates its
# staging directory, and those two queries write scratch files through
# asc_temp_root.  A root TMPDIR makes them fail, and their failure looks
# exactly like an unreachable App Store Connect, so the run used to die
# telling the owner to fix ASC_* credentials for what is a path refusal.
# The root has to be classified BEFORE the version plan, and the run has to
# end with the path-failure status (3), not the credential status (1).
echo "12. a root TMPDIR is classified as a path failure before the version plan"
reset_state
FAKE_ASC_PATCH=""
SHIP_TMPDIR="/" run_ship botfleet --repo-root "$REPO" --allow-unverified-seq
check "exits 3 (the path-failure status)" "$([[ $RC -eq 3 ]] && echo 0 || echo 1)"
check "says the staging path was refused" \
  "$(contains 'staging path was refused' && echo 0 || echo 1)"
check "says it is a path failure, not a missing key" \
  "$(contains 'not a missing key' && echo 0 || echo 1)"
check "does not send the owner to repair ASC credentials" \
  "$(contains 'restore ASC access' && echo 1 || echo 0)"
check "does not claim App Store Connect could not be consulted" \
  "$(contains 'App Store Connect could not be' && echo 1 || echo 0)"
# The version plan never runs, so it never asks App Store Connect anything.
check "no App Store Connect query was made" \
  "$(contains 'asc-patch:' && echo 1 || echo 0)"
SHIP_TMPDIR=""
FAKE_ASC_PATCH=236
echo

echo "13. fixed marketing version + shared merge-timestamp build (apps.json fixedMarketingVersion)"
FIXDIR="${WORK}/fleet-fixed"
rm -rf "$FIXDIR"; cp -R "$SCRIPT_DIR" "$FIXDIR"
python3 - "$FIXDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
a = d["apps"]
for k in list(a)[:1]:
    a[k]["fixedMarketingVersion"] = "1.1.2"
    a[k].pop("buildCountSeed", None)
    a[k].pop("macBundleId", None)
    a[k].pop("pairedBundleId", None)
    a[k].pop("pairedBuildFeed", None)
json.dump(d, open(p, "w"), indent=2)
PY
FIXAPP="$(python3 -c 'import json,sys; print(list(json.load(open(sys.argv[1]))["apps"])[0])' "$FIXDIR/apps.json")"
FIXBUNDLE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["apps"][sys.argv[2]]["bundleId"])' "$FIXDIR/apps.json" "$FIXAPP")"
SHIP_REAL="$SHIP"; SHIP="${FIXDIR}/ship-testflight.sh"
rm -f "${STATE}/build-seq-${FIXAPP}.txt" "${STATE}/last-ship-${FIXAPP}.txt"
write_record "$FIXAPP" 5
FAKE_ASC_PATCH=239; FAKE_ASC_FLOOR=2383; FAKE_RELEASED=""; FAKE_SHARED="202610290000"; FAKE_MAXTHIS=""
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
planned_pair
check "fixed: marketing stays 1.1.2 even though ASC holds patch 239 (got '${PLANNED_MARKETING}')" \
  "$([[ "$PLANNED_MARKETING" == "1.1.2" ]] && echo 0 || echo 1)"
check "fixed: an empty inventory plans the stubbed merge-timestamp build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290000" ]] && echo 0 || echo 1)"
check "fixed: the integer floor and commit count play no part" \
  "$(contains 'shared merge-timestamp build 202610290000 for fixed version 1.1.2' && echo 0 || echo 1)"
FAKE_SHARED="202610290001"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
planned_pair
check "fixed: one above the max plans one higher (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290001" ]] && echo 0 || echo 1)"
FAKE_SHARED="fail"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: an unreadable inventory stops the run, nothing guessed" \
  "$(contains 'cannot work out the next shared merge-timestamp build' && echo 0 || echo 1)"
FAKE_SHARED=""
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: an unreachable inventory stops the run" \
  "$(contains 'cannot work out the next shared merge-timestamp build' && echo 0 || echo 1)"
FAKE_SHARED="202610290000"; FAKE_RELEASED="1.1.2"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: a version at the released App Store version is refused, not bumped" \
  "$(contains 'at or below the released App Store version 1.1.2' && echo 0 || echo 1)"
FAKE_RELEASED="fail"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run
check "fixed: an unreadable released App Store version stops the run (fail closed)" \
  "$(contains 'cannot read the released App Store version' && echo 0 || echo 1)"
# The --build runs below pin HEAD's committer date: the stamp check compares
# the value against the merge stamp of the commit being shipped, and the
# shared $REPO stamps "now", which would make these assertions time-dependent.
# Oct 29 2026 is CDT (UTC-5), so this pins the stamp to 202610290000.
STAMPREPO="${WORK}/stamp-repo"
rm -rf "$STAMPREPO"; mkdir -p "$STAMPREPO"
git -C "$STAMPREPO" init -q 2>/dev/null || git -C "$STAMPREPO" init >/dev/null
git -C "$STAMPREPO" config user.email test@example.invalid
git -C "$STAMPREPO" config user.name "stamp test"
echo seed >"${STAMPREPO}/README"
git -C "$STAMPREPO" add README
GIT_COMMITTER_DATE="2026-10-29 00:00:00 -0500" git -C "$STAMPREPO" -c commit.gpgsign=false commit -qm seed
FAKE_SHARED="202610290001"; FAKE_RELEASED=""; FAKE_MAXTHIS="202610290000"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 1.1.9
check "fixed: a dotted --build is refused (fixed mode needs a 12-digit merge-timestamp build)" \
  "$(contains 'fixed mode requires a 12-digit merge-timestamp build' && echo 0 || echo 1)"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 999
check "fixed: a three-digit --build is refused" \
  "$(contains 'fixed mode requires a 12-digit merge-timestamp build' && echo 0 || echo 1)"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610290000
check "fixed: a --build equal to this platform's max is refused" \
  "$(contains 'at or below this platform'"'"'s highest build 202610290000' && echo 0 || echo 1)"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610270000
check "fixed: a --build below this platform's max is refused" \
  "$(contains 'at or below this platform'"'"'s highest build 202610290000' && echo 0 || echo 1)"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610290001
planned_pair
check "fixed: a --build above this platform's max is honoured even when it equals the paired platform's build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290001" ]] && echo 0 || echo 1)"
FAKE_MAXTHIS=""
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610290001
check "fixed: an unreadable this-platform max stops --build (fail closed)" \
  "$(contains 'cannot verify this platform'"'"'s highest build' && echo 0 || echo 1)"
FAKE_MAXTHIS="empty"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610290001
planned_pair
check "fixed: with no builds on this platform yet any 12-digit --build at or above the stamp is honoured (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290001" ]] && echo 0 || echo 1)"
# A --build below the merge stamp of the HEAD being shipped was planned for
# an older commit: refused even when this platform's max would allow it.
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610280000
check "fixed: a --build below the HEAD merge stamp is refused with no builds on this platform" \
  "$(contains 'below the merge stamp 202610290000' && contains 'planned for an older commit' && echo 0 || echo 1)"
FAKE_MAXTHIS="202610270000"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run --build 202610280000
check "fixed: a --build above this platform's max but below the HEAD merge stamp is refused" \
  "$(contains 'below the merge stamp 202610290000' && echo 0 || echo 1)"
FAKE_MAXTHIS="202610290000"
run_ship "$FIXAPP" --repo-root "$REPO" --dry-run --version 1.1.2
planned_pair
check "fixed: --version equal to the fixed version stays in fixed mode (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290001" ]] && echo 0 || echo 1)"
# The planner receives HEAD's committer date as the merge stamp (STAMPREPO
# above pins it to 202610290000).
FAKE_ARGV_LOG="${WORK}/stamp-argv.log"; : >"$FAKE_ARGV_LOG"
FAKE_SHARED="202610290000"
run_ship "$FIXAPP" --repo-root "$STAMPREPO" --dry-run
check "fixed: the planner receives HEAD's committer date as --merge-stamp 202610290000" \
  "$(grep -a -q "plan-release-build ${FIXBUNDLE} --merge-stamp 202610290000" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
FAKE_ARGV_LOG=""
python3 - "$FIXDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["apps"]["fixmac"] = {
  "displayName": "Fixed Mac",
  "fixedMarketingVersion": "1.1.2",
  "bundleId": "app.botfleet.fixmac",
  "scheme": "FixMac",
  "projectRel": "mac/FixMac.xcodeproj",
  "platform": "macOS",
  "marketingVersionDefault": "1.0.0"
}
json.dump(d, open(p, "w"), indent=2)
PY
FAKE_SHARED="202610290000"; FAKE_RELEASED=""
rm -f "${STATE}/build-seq-fixmac.txt" "${STATE}/last-ship-fixmac.txt"
run_ship "fixmac" --repo-root "$REPO" --dry-run
planned_pair
check "fixed macOS: marketing stays 1.1.2 (got '${PLANNED_MARKETING}')" \
  "$([[ "$PLANNED_MARKETING" == "1.1.2" ]] && echo 0 || echo 1)"
check "fixed macOS: plans the shared merge-timestamp build instead of refusing (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290000" ]] && echo 0 || echo 1)"
check "fixed macOS: logs the shared build line" \
  "$(contains 'shared merge-timestamp build 202610290000 for fixed version 1.1.2' && echo 0 || echo 1)"
SHIP="$SHIP_REAL"; FAKE_ASC_FLOOR=0; FAKE_RELEASED=""; FAKE_SHARED=""; FAKE_MAXTHIS=""; FAKE_ASC_PATCH=236
echo

echo "14. paired build feed + paired bundle id (apps.json pairedBuildFeed / pairedBundleId)"
# A stub curl: records its argv, then fails with FAKE_CURL_FAIL (a curl exit
# code, e.g. 28 for a timeout) or serves FAKE_CURL_BODY.  It lands in FAKE_BIN
# only here, so the earlier sections keep the real curl they never call.
cat >"${FAKE_BIN}/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_CURL_LOG:-/dev/null}"
if [[ -n "${FAKE_CURL_FAIL:-}" ]]; then
  echo "curl: (${FAKE_CURL_FAIL}) ${FAKE_CURL_ERR:-Simulated curl failure}" >&2
  exit "${FAKE_CURL_FAIL}"
fi
printf '%s' "${FAKE_CURL_BODY:-}"
FAKE
chmod +x "${FAKE_BIN}/curl"
FAKE_CURL_LOG="${WORK}/curl-argv.log"
FAKE_ARGV_LOG="${WORK}/asc-argv.log"
: >"$FAKE_CURL_LOG"; : >"$FAKE_ARGV_LOG"
FEEDDIR="${WORK}/fleet-feed"
rm -rf "$FEEDDIR"; cp -R "$SCRIPT_DIR" "$FEEDDIR"
python3 - "$FEEDDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for k in list(d["apps"])[:1]:
    d["apps"][k]["fixedMarketingVersion"] = "1.1.2"
    d["apps"][k].pop("buildCountSeed", None)
json.dump(d, open(p, "w"), indent=2)
PY
FEEDAPP="$(python3 -c 'import json,sys; print(list(json.load(open(sys.argv[1]))["apps"])[0])' "$FEEDDIR/apps.json")"
FEEDBUNDLE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["apps"][sys.argv[2]]["bundleId"])' "$FEEDDIR/apps.json" "$FEEDAPP")"
SHIP_REAL="$SHIP"; SHIP="${FEEDDIR}/ship-testflight.sh"
rm -f "${STATE}/build-seq-${FEEDAPP}.txt" "${STATE}/last-ship-${FEEDAPP}.txt"
write_record "$FEEDAPP" 5
set_feed_keys() { # <pairedBundleId> <macBundleId> <pairedBuildFeed> (empty clears)
  python3 - "$FEEDDIR/apps.json" "$FEEDAPP" "$1" "$2" "$3" <<'PY'
import json, sys
p, app, paired, mac, feed = sys.argv[1:6]
d = json.load(open(p))
a = d["apps"][app]
for key, val in (("pairedBundleId", paired), ("macBundleId", mac), ("pairedBuildFeed", feed)):
    if val:
        a[key] = val
    else:
        a.pop(key, None)
json.dump(d, open(p, "w"), indent=2)
PY
}
FEED_URL="https://example.invalid/appcast.xml"
FAKE_RELEASED=""; FAKE_SHARED="202610290005"; FAKE_CURL_FAIL=""; FAKE_CURL_BODY=""; FAKE_CURL_ERR=""
# pairedBundleId reaches the client as the second arg, ahead of --merge-stamp.
set_feed_keys "app.example.mac" "" ""
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
planned_pair
check "paired: pairedBundleId is passed to plan-release-build" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} app.example.mac --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
check "paired: the run still plans the stubbed build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290005" ]] && echo 0 || echo 1)"
# macBundleId stays an accepted alias.
set_feed_keys "" "app.example.mac-legacy" ""
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "paired: macBundleId is still accepted as the paired id" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} app.example.mac-legacy --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
# pairedBundleId wins when both are set.
set_feed_keys "app.example.mac" "app.example.mac-legacy" ""
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
_paired_exact="$(grep -a -E -c "plan-release-build ${FEEDBUNDLE} app.example.mac --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" || true)"
_paired_legacy="$(grep -a -c "mac-legacy" "$FAKE_ARGV_LOG" || true)"
check "paired: pairedBundleId is preferred over macBundleId" \
  "$([[ "$_paired_exact" -ge 1 && "$_paired_legacy" -eq 0 ]] && echo 0 || echo 1)"
# A curl timeout (rc 28) is a feed failure: fail closed, with the URL and
# curl's stderr in the message -- not an App Store Connect failure.
set_feed_keys "" "" "$FEED_URL"
FAKE_CURL_FAIL=28; FAKE_CURL_ERR="Operation timed out after 30000 milliseconds"
: >"$FAKE_CURL_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: a curl timeout fails the run closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "feed: says the shared build cannot be worked out" \
  "$(contains 'cannot work out the next shared merge-timestamp build' && echo 0 || echo 1)"
check "feed: the message names the feed URL" \
  "$(contains "$FEED_URL" && echo 0 || echo 1)"
check "feed: the message carries curl's stderr" \
  "$(contains 'Operation timed out' && echo 0 || echo 1)"
check "feed: the fetch is bounded with connect and max timeouts" \
  "$(grep -a -q -- '--connect-timeout 10 --max-time 30' "$FAKE_CURL_LOG" && echo 0 || echo 1)"
check "feed: the fetch pins https and caps the body" \
  "$(grep -a -q -- '--proto =https --proto-redir =https' "$FAKE_CURL_LOG" && grep -a -q -- '--max-filesize 5000000' "$FAKE_CURL_LOG" && echo 0 || echo 1)"
check "feed: not reported as an App Store Connect failure" \
  "$(contains 'App Store Connect could not be' && echo 1 || echo 0)"
FAKE_CURL_FAIL=""; FAKE_CURL_ERR=""
# A feed with no numeric <sparkle:version> fails closed and says so.
FAKE_CURL_BODY='<rss version="2.0"><channel><title>x</title></channel></rss>'
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: no numeric sparkle:version fails the run closed" \
  "$(contains 'cannot work out the next shared merge-timestamp build' && echo 0 || echo 1)"
check "feed: the message names the URL and says no numeric version was found" \
  "$(contains "$FEED_URL" && contains 'no numeric' && echo 0 || echo 1)"
check "feed: empty feed fails closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
# The feed's max numeric version joins the counter as a floor arg.
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>1500</sparkle:version></item><item><sparkle:version>1499</sparkle:version></item></channel></rss>'
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
planned_pair
check "feed: the max sparkle:version is passed as the floor" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} 1500 --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
check "feed: the run still plans the stubbed build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290005" ]] && echo 0 || echo 1)"
# Whitespace-padded versions still count: the digits are extracted.
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>  1501  </sparkle:version></item><item><sparkle:version>1499</sparkle:version></item></channel></rss>'
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: whitespace-padded sparkle:version is read as the floor" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} 1501 --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
# A non-https feed is rejected before curl runs.
set_feed_keys "" "" "http://example.invalid/appcast.xml"
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>1500</sparkle:version></item></channel></rss>'
: >"$FAKE_CURL_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: non-https URL fails the run closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "feed: non-https rejection names the URL" \
  "$(contains 'http://example.invalid/appcast.xml' && contains 'https' && echo 0 || echo 1)"
check "feed: non-https URL never reaches curl" \
  "$([[ ! -s "$FAKE_CURL_LOG" ]] && echo 0 || echo 1)"
set_feed_keys "" "" "$FEED_URL"
# No four-digit cap any more: 9999 is a valid floor and reaches the planner.
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>9999</sparkle:version></item></channel></rss>'
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
planned_pair
check "feed: floor 9999 plans the stubbed build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290005" ]] && echo 0 || echo 1)"
check "feed: floor 9999 reaches the planner" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} 9999 --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
# A 12-digit Sparkle floor is valid and travels exactly, digit for digit.
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>202610290007</sparkle:version></item></channel></rss>'
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: a 12-digit floor reaches the planner exactly" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} 202610290007 --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
# Past 12 digits the floor fails closed: it would plan a build the 12-digit
# gate rejects, so the run stops with the feed URL and the value.
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>202610290000000001</sparkle:version></item></channel></rss>'
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: an 18-digit floor fails the run closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "feed: out-of-range 18-digit floor names the URL and the value" \
  "$(contains "$FEED_URL" && contains '202610290000000001' && contains 'exceeds 12 digits' && echo 0 || echo 1)"
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>0</sparkle:version></item></channel></rss>'
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: floor 0 fails the run closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "feed: out-of-range zero names the URL" \
  "$(contains "$FEED_URL" && contains 'outside 1..999999999999' && echo 0 || echo 1)"
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>1234567890123456789</sparkle:version></item></channel></rss>'
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: a 19-digit floor fails the run closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "feed: out-of-range 19-digit floor names the URL and the value" \
  "$(contains "$FEED_URL" && contains '1234567890123456789' && contains 'exceeds 12 digits' && echo 0 || echo 1)"
FAKE_CURL_BODY='<rss><channel><item><sparkle:version>1500</sparkle:version></item><item><sparkle:version>1499</sparkle:version></item></channel></rss>'
# Paired id and feed floor travel together, in that order.
set_feed_keys "app.example.mac" "" "$FEED_URL"
: >"$FAKE_ARGV_LOG"
run_ship "$FEEDAPP" --repo-root "$REPO" --dry-run
check "feed: paired id and feed floor travel together" \
  "$(grep -a -E -q "plan-release-build ${FEEDBUNDLE} app.example.mac 1500 --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
FAKE_CURL_BODY=""
# A macOS entry names the iOS bundle id as its paired id.
python3 - "$FEEDDIR/apps.json" "$FEEDBUNDLE" <<'PY'
import json, sys
p, ios_bundle = sys.argv[1:3]
d = json.load(open(p))
d["apps"]["feedmac"] = {
  "displayName": "Feed Mac",
  "fixedMarketingVersion": "1.1.2",
  "bundleId": "app.example.mac",
  "pairedBundleId": ios_bundle,
  "scheme": "FeedMac",
  "projectRel": "mac/FeedMac.xcodeproj",
  "platform": "macOS",
  "marketingVersionDefault": "1.0.0"
}
json.dump(d, open(p, "w"), indent=2)
PY
rm -f "${STATE}/build-seq-feedmac.txt" "${STATE}/last-ship-feedmac.txt"
: >"$FAKE_ARGV_LOG"
run_ship "feedmac" --repo-root "$REPO" --dry-run
planned_pair
check "paired: a macOS entry passes the iOS bundle id as the paired id" \
  "$(grep -a -E -q "plan-release-build app.example.mac ${FEEDBUNDLE} --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
check "paired: the macOS entry still plans the stubbed build (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "202610290005" ]] && echo 0 || echo 1)"
# A macOS entry with no paired id borrows the iOS peer that points at it.
python3 - "$FEEDDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["apps"]["revmac"] = {
  "displayName": "Rev Mac",
  "fixedMarketingVersion": "1.1.2",
  "bundleId": "app.example.revmac",
  "scheme": "RevMac",
  "projectRel": "mac/RevMac.xcodeproj",
  "platform": "macOS",
  "marketingVersionDefault": "1.0.0"
}
json.dump(d, open(p, "w"), indent=2)
PY
rm -f "${STATE}/build-seq-revmac.txt" "${STATE}/last-ship-revmac.txt"
set_feed_keys "app.example.revmac" "" ""
: >"$FAKE_ARGV_LOG"
run_ship "revmac" --repo-root "$REPO" --dry-run
check "paired: macOS reverse lookup passes the iOS bundle id" \
  "$(grep -a -E -q "plan-release-build app.example.revmac ${FEEDBUNDLE} --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
set_feed_keys "" "app.example.revmac" ""
: >"$FAKE_ARGV_LOG"
run_ship "revmac" --repo-root "$REPO" --dry-run
check "paired: macOS reverse lookup follows the macBundleId alias" \
  "$(grep -a -E -q "plan-release-build app.example.revmac ${FEEDBUNDLE} --merge-stamp [0-9]{12}$" "$FAKE_ARGV_LOG" && echo 0 || echo 1)"
set_feed_keys "" "" ""
# The client joins both platforms of both apps, concurrently.
check "union: plan-release-build reads IOS and MAC_OS for both apps via Promise.all" \
  "$(grep -a -q 'allBuilds(macAppId, "IOS", ' "${SCRIPT_DIR}/asc-api.mjs" && grep -a -q 'allBuilds(macAppId, "MAC_OS", ' "${SCRIPT_DIR}/asc-api.mjs" && grep -a -q 'Promise.all' "${SCRIPT_DIR}/asc-api.mjs" && echo 0 || echo 1)"
check "union: the planner command exists under both names" \
  "$(grep -a -q 'method === "plan-release-build"' "${SCRIPT_DIR}/asc-api.mjs" && grep -a -q 'method === "next-shared-build"' "${SCRIPT_DIR}/asc-api.mjs" && echo 0 || echo 1)"
check "union: no four-digit counter wording remains in the planner, client or ship script" \
  "$(grep -a -q 'four-digit' "${SCRIPT_DIR}/shared-build.mjs" "${SCRIPT_DIR}/asc-api.mjs" "${SCRIPT_DIR}/ship-testflight.sh" && echo 1 || echo 0)"
SHIP="$SHIP_REAL"; FAKE_SHARED=""; FAKE_MAXTHIS=""; FAKE_CURL_LOG=""; FAKE_ARGV_LOG=""
rm -f "${FAKE_BIN}/curl"
echo

echo "15. --plan-build-only prints the shared build and exits before Xcode"
SHIP_REAL="$SHIP"; SHIP="${FIXDIR}/ship-testflight.sh"
rm -f "${STATE}/build-seq-${FIXAPP}.txt" "${STATE}/last-ship-${FIXAPP}.txt"
FAKE_SHARED="202610290007"; FAKE_RELEASED=""; FAKE_MAXTHIS=""
mv "${FAKE_BIN}/xcodebuild" "${FAKE_BIN}/xcodebuild.hidden"
run_ship "$FIXAPP" --repo-root "$REPO" --plan-build-only
mv "${FAKE_BIN}/xcodebuild.hidden" "${FAKE_BIN}/xcodebuild"
check "plan: exits 0 with no xcodebuild on PATH" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "plan: stdout is exactly the planned build (got '${OUT}')" \
  "$([[ "$OUT" == "202610290007" ]] && echo 0 || echo 1)"
FAKE_SHARED="fail"
run_ship "$FIXAPP" --repo-root "$REPO" --plan-build-only
check "plan: an unreadable inventory fails closed (rc=${RC})" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "plan: says the shared release build cannot be worked out" \
  "$(contains 'cannot work out the shared release build' && echo 0 || echo 1)"
FAKE_SHARED="202610290007"
SHIP="${LEGACY_DIR}/ship-testflight.sh"
run_ship "botfleet" --repo-root "$REPO" --plan-build-only
check "plan: without fixedMarketingVersion it refuses instead of guessing" \
  "$(contains 'no fixedMarketingVersion' && echo 0 || echo 1)"
SHIP="$SHIP_REAL"; FAKE_SHARED=""; FAKE_MAXTHIS=""
echo

echo "----------------------------------------"
echo "passed: ${PASS}   failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
