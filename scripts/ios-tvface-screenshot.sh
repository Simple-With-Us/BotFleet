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

# The CI runner image ships no "iPhone 17 Pro" device instance, so a named
# destination fails before the build starts. Create it when absent, pinned to
# the explicit device type identifier; a name passed as the type is not a
# verified model. Fail clearly when the Xcode catalog lacks the type or a
# caller override names a different device - never substitute another model,
# whose different geometry would make the screenshot meaningless.
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
if ! xcrun simctl list devices available | grep -F "${DEVICE} (" >/dev/null; then
  if [[ "${DEVICE}" != "iPhone 17 Pro" ]]; then
    echo "ios-tvface-screenshot: simulator '${DEVICE}' not present; auto-create is pinned to iPhone 17 Pro" >&2
    exit 1
  fi
  if ! xcrun simctl list devicetypes | grep -F "${DEVICE_TYPE}" >/dev/null; then
    echo "ios-tvface-screenshot: device type ${DEVICE_TYPE} not in this Xcode catalog" >&2
    exit 1
  fi
  # Pick the newest available iOS runtime whose own supported-device list
  # includes the pinned type; the newest runtime alone is not a contract -
  # e.g. a beta runtime can reject a shipping device type ("Incompatible
  # device", SimError 403). Fail clearly when no runtime supports the type.
  RUNTIMES_JSON="$ROOT/artifacts/simctl-runtimes.json"
  xcrun simctl list -j runtimes > "$RUNTIMES_JSON"
  RUNTIME_ID="$(python3 - "${DEVICE_TYPE}" "$RUNTIMES_JSON" <<'PY'
import json, sys
want = sys.argv[1]
runtimes = json.load(open(sys.argv[2]))["runtimes"]
def ver(r):
    return [int(x) for x in r.get("version", "0").split(".")]
cands = [
    r for r in runtimes
    if r.get("platform") == "iOS"
    and r.get("isAvailable", True)
    and any(t.get("identifier") == want for t in r.get("supportedDeviceTypes", []))
]
if not cands:
    sys.exit(1)
cands.sort(key=ver)
print(cands[-1]["identifier"])
PY
)" || {
    echo "ios-tvface-screenshot: no available iOS runtime supports ${DEVICE_TYPE} on this runner" >&2
    exit 1
  }
  echo "ios-tvface-screenshot: simulator '${DEVICE}' not present; creating ${DEVICE_TYPE} on ${RUNTIME_ID}"
  xcrun simctl create "${DEVICE}" "${DEVICE_TYPE}" "${RUNTIME_ID}"
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

# The compare needs pngjs + pixelmatch; install just those, only on the
# baseline path, so the ios-build job never pays a monorepo install for a
# capture-only run.  NODE_PATH is honored by the verify script's CJS require.
VERIFY_DEPS="$ROOT/artifacts/.tvface-verify-deps"
if [[ ! -d "$VERIFY_DEPS/node_modules/pixelmatch" ]]; then
  npm install --no-save --prefix "$VERIFY_DEPS" pngjs pixelmatch
fi
NODE_PATH="$VERIFY_DEPS/node_modules" node "$ROOT/scripts/ios-tvface-screenshot-verify.mjs" "$BASELINE" "$OUT"
