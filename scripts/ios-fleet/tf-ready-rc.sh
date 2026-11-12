# Shared ensure-tf-ready exit-code handling for ship-testflight.sh and the
# post-sync workflow recheck (OPS-1052 / BF-2552).  Source this file; do not execute it.
#
# BotFleet policy: external TestFlight install path (external group with testers
# or public link), not internal testers.  Expects callers to set BUNDLE_ID and
# BUILD_NUM.  When sourced from ship-testflight.sh, log() is already defined.

if ! declare -f log >/dev/null 2>&1; then
  log() { echo "[ios-ship] $*"; }
fi

# Short label for workflow ship summaries (second readiness check).
tf_ready_rc_summary_label() {
  local rc="${1:?}"
  case "$rc" in
    0) echo "external TestFlight install path is live" ;;
    5) echo "processed but no external tester can install yet" ;;
    6) echo "processed but external installability is unverified" ;;
    3) echo "upload ok; ASC not IN_BETA_TESTING yet" ;;
    4) echo "build not surfaced; export compliance not declared" ;;
    2) echo "ensure-tf-ready API/usage error; export compliance not declared" ;;
    *) echo "ensure-tf-ready unexpected rc=${rc}" ;;
  esac
}

# Map asc-api.mjs ensure-tf-ready exit codes to log lines and GitHub annotations.
# Always returns shell 0 so a successful upload stays a green ship job.
handle_ensure_tf_ready_rc() {
  local rc="${1:?}"
  case "$rc" in
    0)
      log "TestFlight external install path is live for ${BUNDLE_ID} (an external group has testers or an enabled public link); the standing-testers sync assigns and verifies this build next"
      return 0
      ;;
    5)
      log "warning: build ${BUILD_NUM} is processed but ${BUNDLE_ID} has no external TestFlight group with testers or a public link; nobody can install it yet"
      log "warning: the Sync standing TestFlight testers step assigns the external group; otherwise enable the public link under TestFlight > External Testing"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning title=TestFlight has no reachable external tester::${BUNDLE_ID} build ${BUILD_NUM} is processed but no external tester can install it.  Check the Sync standing TestFlight testers step."
      fi
      return 0
      ;;
    6)
      log "warning: build ${BUILD_NUM} is processed but the external TestFlight installability could not be read for ${BUNDLE_ID}; installability is unverified"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning title=TestFlight installability unverified::${BUNDLE_ID} build ${BUILD_NUM} is processed but the external installability could not be read.  Check TestFlight."
      fi
      return 0
      ;;
    3)
      log "warning: upload succeeded but ASC has not reached IN_BETA_TESTING yet; watch TestFlight"
      return 0
      ;;
    4)
      log "warning: ASC never surfaced build ${BUILD_NUM}; export compliance NOT declared on it"
      log "warning: if the phone never gets this build, declare compliance by hand in App Store Connect"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning::ensure-tf-ready could not find uploaded build ${BUILD_NUM} for ${BUNDLE_ID}; export compliance not declared"
      fi
      return 0
      ;;
    2)
      log "warning: ensure-tf-ready failed (rc=$rc); build may be stuck on export compliance"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning::ensure-tf-ready failed (rc=${rc}) for ${BUNDLE_ID} build ${BUILD_NUM}; export compliance not declared"
      fi
      return 0
      ;;
    *)
      log "warning: ensure-tf-ready returned unexpected rc=${rc} for ${BUNDLE_ID} build ${BUILD_NUM}"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::warning::ensure-tf-ready returned unexpected rc=${rc} for ${BUNDLE_ID} build ${BUILD_NUM}"
      fi
      return 0
      ;;
  esac
}
