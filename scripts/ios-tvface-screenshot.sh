#!/usr/bin/env bash
# Capture the DEBUG TV-Face preview harness on a booted iOS Simulator and
# compare against the committed baseline (ios/AppStore/screenshots/tv-face-preview.png).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/ios"

BASELINE="$ROOT/ios/AppStore/screenshots/tv-face-preview.png"
OUT="$ROOT/artifacts/ios-tvface-preview.png"
DEVICE="${IOS_SIM_DEVICE:-iPhone 17 Pro}"
BUNDLE_ID="app.botfleet.ios"
DERIVED="$ROOT/ios/build/DerivedData-tvface"
APP_PATH="$DERIVED/Build/Products/Debug-iphonesimulator/BotFleet.app"

mkdir -p "$ROOT/artifacts"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ios-tvface-screenshot: skipped (requires macOS + Simulator)"
  exit 0
fi

brew list xcodegen >/dev/null 2>&1 || brew install xcodegen
xcodegen generate

# The CI runner image ships no "iPhone 17 Pro" device, so a named destination
# fails before the build starts. Create the device when it is absent; the
# device type ships with Xcode and the latest installed iOS runtime is used.
if ! xcrun simctl list devices available | grep -F "${DEVICE} (" >/dev/null; then
  RUNTIME_ID="$(xcrun simctl list runtimes | awk '/^iOS /{print $NF}' | sort -V | tail -1)"
  echo "ios-tvface-screenshot: simulator '${DEVICE}' not present; creating it on ${RUNTIME_ID}"
  xcrun simctl create "${DEVICE}" "${DEVICE}" "${RUNTIME_ID}"
fi

xcodebuild \
  -project BotFleet.xcodeproj \
  -scheme BotFleet \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=${DEVICE}" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build

UDID="$(xcrun simctl list devices available | awk -F '[()]' -v name="$DEVICE" '$0 ~ name {print $2; exit}')"
if [[ -z "${UDID:-}" ]]; then
  echo "No simulator named: $DEVICE" >&2
  exit 1
fi

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b

xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE_ID" -tvface-preview
sleep 4
xcrun simctl io "$UDID" screenshot "$OUT"

if [[ ! -f "$BASELINE" ]]; then
  echo "TV-Face iOS baseline missing at $BASELINE — captured fresh screenshot at $OUT for review."
  test -s "$OUT"
  exit 0
fi

node "$ROOT/scripts/ios-tvface-screenshot-verify.mjs" "$BASELINE" "$OUT"
