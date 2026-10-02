#!/usr/bin/env bash
# Thin wrapper: ship BotFleet companion to TestFlight (no Xcode UI).
# Prefer the in-repo copy so a GitHub-hosted macos-latest runner without
# /Users/jay/apps/ios-fleet still resolves the 1.0.N train and bundle
# app.botfleet.  Fall back to the Mac runtime when that directory exists.
#
# Hosted path: .github/workflows/ios-ship.yml (push path filter on ios/**,
# schedule, workflow_dispatch). CI invokes this wrapper with no extra flags.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

STABLE_XCODE="${STABLE_XCODE:-/Applications/Xcode.app}"
STABLE_DEV_DIR="${STABLE_XCODE}/Contents/Developer"

resolved="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"

is_beta() {
  local dir="$1"
  [[ "$dir" == *Xcode-beta* ]] && return 0
  local plist="${dir%/Contents/Developer}/Contents/Info.plist"
  if [[ -r "$plist" ]]; then
    local ver
    ver=$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || echo "")
    [[ "$ver" == *[Bb]eta* ]] && return 0
  fi
  return 1
}

if [[ -n "$resolved" ]] && is_beta "$resolved"; then
  if [[ ! -d "$STABLE_DEV_DIR" ]]; then
    echo "ERROR: stable Xcode not found at ${STABLE_XCODE}." >&2
    echo "       Refusing to build for App Store Connect with Xcode-beta —" >&2
    echo "       beta-SDK binaries are rejected as INVALID_BINARY at submission." >&2
    exit 1
  fi
  echo "[ios-ship] refusing beta toolchain at ${resolved}"
  export DEVELOPER_DIR="$STABLE_DEV_DIR"
elif [[ -n "$resolved" ]]; then
  export DEVELOPER_DIR="$resolved"
fi

if [[ -n "${DEVELOPER_DIR:-}" ]] && is_beta "$DEVELOPER_DIR"; then
  echo "ERROR: DEVELOPER_DIR still resolves to a beta Xcode (${DEVELOPER_DIR})." >&2
  exit 1
fi

if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  echo "[ios-ship] DEVELOPER_DIR=${DEVELOPER_DIR}"
  xcodebuild -version 2>/dev/null | sed 's/^/[ios-ship] /' || true
fi

IN_REPO="${ROOT}/scripts/ios-fleet/ship-testflight.sh"
MAC="/Users/jay/apps/ios-fleet/ship-testflight.sh"
if [[ -f "$IN_REPO" ]]; then
  echo "[ios-ship] using in-repo fleet script: ${IN_REPO}"
  exec bash "$IN_REPO" botfleet --repo-root "$ROOT" "$@"
fi
if [[ -f "$MAC" ]]; then
  echo "[ios-ship] ===================================================================" >&2
  echo "[ios-ship] WARNING: in-repo fleet script missing (${IN_REPO})." >&2
  echo "[ios-ship] WARNING: falling back to the UNVERSIONED host copy at" >&2
  echo "[ios-ship] WARNING:   ${MAC}" >&2
  echo "[ios-ship] ===================================================================" >&2
  exec bash "$MAC" botfleet --repo-root "$ROOT" "$@"
fi
echo "error: ios-fleet ship-testflight.sh not found at ${IN_REPO} or ${MAC}" >&2
exit 1
