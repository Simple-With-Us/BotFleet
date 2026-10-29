#!/usr/bin/env bash
# Capture the DEBUG TV-Face preview harness on a booted iOS Simulator and
# publish a screenshot for actual pixel review (comparison is not automated).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/ios"

BASELINE="$ROOT/ios/AppStore/screenshots/tv-face-preview.png"
OUT="$ROOT/artifacts/ios-tvface-preview.png"
DEVICE="${IOS_SIM_DEVICE:-iPhone 17}"
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

# Capture target is an engineering default, not a visual-clearance claim.
# Validate both existing and newly-created devices against the deployment
# floor and the runtime's supported-device catalog. Never pick by substring.
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-17"
RUNTIMES_JSON="$ROOT/artifacts/simctl-runtimes.json"
DEVICES_JSON="$ROOT/artifacts/simctl-devices.json"
xcrun simctl list -j runtimes > "$RUNTIMES_JSON"
xcrun simctl list -j devices available > "$DEVICES_JSON"
DEPLOY_FLOOR="$(awk -F"'" '/IPHONEOS_DEPLOYMENT_TARGET:/{print $2; exit}' "$ROOT/ios/project.yml")"
[[ -n "$DEPLOY_FLOOR" ]] || { echo "deployment floor missing" >&2; exit 1; }
SELECTION="$(python3 - "$DEVICE_TYPE" "$RUNTIMES_JSON" "$DEVICES_JSON" "$DEPLOY_FLOOR" "$DEVICE" <<'SELECT'
import json, sys
want, runtime_file, device_file, floor, name = sys.argv[1:]
def version(s):
    return tuple((list(map(int, s.split("."))) + [0, 0, 0])[:3])
runtimes = [r for r in json.load(open(runtime_file))["runtimes"]
    if r.get("platform") == "iOS" and r.get("isAvailable", True)
    and version(r.get("version", "0")) >= version(floor)
    and any(t.get("identifier") == want for t in r.get("supportedDeviceTypes", []))]
if not runtimes:
    sys.exit("No compatible runtime at or above deployment floor")
devices = json.load(open(device_file))["devices"]
for runtime in sorted(runtimes, key=lambda r: version(r["version"]), reverse=True):
    for device in devices.get(runtime["identifier"], []):
        if device.get("name") == name and device.get("deviceTypeIdentifier") == want and device.get("isAvailable", True):
            print(runtime["identifier"], device["udid"])
            sys.exit(0)
if name != "iPhone 17":
    sys.exit("Override device absent; auto-creation is pinned to iPhone 17")
print(max(runtimes, key=lambda r: version(r["version"]))["identifier"], "CREATE")
SELECT
)"
read -r RUNTIME_ID UDID <<< "$SELECTION"
if [[ "$UDID" == "CREATE" ]]; then
  UDID="$(xcrun simctl create "$DEVICE" "$DEVICE_TYPE" "$RUNTIME_ID")"
fi

xcodebuild \
  -project BotFleet.xcodeproj \
  -scheme BotFleet \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=${UDID}" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build


xcrun simctl boot "$UDID" 2>/dev/null || true
# A freshly created device is the slowest to boot; bound the wait so a slow
# boot cannot eat the job's 20-minute budget and fail for an unrelated cause.
BOOT_DEADLINE=$(( $(date +%s) + 240 ))
while true; do
  xcrun simctl list -j devices > "$DEVICES_JSON"
  STATE="$(python3 - "$DEVICES_JSON" "$UDID" <<'STATE'
import json, sys
matches = [d for group in json.load(open(sys.argv[1]))["devices"].values()
           for d in group if d.get("udid") == sys.argv[2]]
if len(matches) != 1:
    sys.exit("Selected simulator missing or ambiguous")
print(matches[0]["state"])
STATE
)"
  [[ "$STATE" == "Booted" ]] && break
  if (( $(date +%s) >= BOOT_DEADLINE )); then
    echo "ios-tvface-screenshot: simulator $UDID not Booted after 240s (state: ${STATE:-unknown})" >&2
    exit 1
  fi
  sleep 5
done

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

python3 - "$BASELINE" "$OUT" <<'PNG_COMPARE'
import struct
import sys
import zlib

def load_rgba(path: str) -> tuple[tuple[int, int], list[int]]:
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    pos = 8
    width = height = None
    raw = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        pos += 4
        chunk_type = data[pos : pos + 4]
        pos += 4
        chunk = data[pos : pos + length]
        pos += length + 4
        if chunk_type == b"IHDR":
            width, height = struct.unpack(">II", chunk[:8])
        elif chunk_type == b"IDAT":
            raw += chunk
        elif chunk_type == b"IEND":
            break
    if width is None or height is None:
        raise SystemExit(f"{path}: missing IHDR")
    inflated = zlib.decompress(raw)
    stride = width * 4 + 1
    pixels: list[int] = []
    prev = [0] * (width * 4)
    offset = 0
    for _ in range(height):
        filter_type = inflated[offset]
        offset += 1
        row = list(inflated[offset : offset + width * 4])
        offset += width * 4
        if filter_type == 1:
            for i in range(4, len(row)):
                row[i] = (row[i] + row[i - 4]) & 0xFF
        elif filter_type == 2:
            for i in range(len(row)):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif filter_type == 0:
            pass
        else:
            raise SystemExit(f"{path}: unsupported PNG filter {filter_type}")
        pixels.extend(row)
        prev = row
    return (width, height), pixels

baseline_path, capture_path = sys.argv[1], sys.argv[2]
baseline_size, baseline_pixels = load_rgba(baseline_path)
capture_size, capture_pixels = load_rgba(capture_path)
if baseline_size != capture_size:
    raise SystemExit(
        f"TV-Face screenshot size mismatch: baseline {baseline_size}, capture {capture_size}"
    )
if baseline_pixels != capture_pixels:
    mismatches = sum(1 for left, right in zip(baseline_pixels, capture_pixels) if left != right)
    raise SystemExit(
        f"TV-Face screenshot differs from baseline ({mismatches} RGBA byte mismatches)"
    )
print(f"TV-Face screenshot matches baseline {baseline_path}")
PNG_COMPARE
