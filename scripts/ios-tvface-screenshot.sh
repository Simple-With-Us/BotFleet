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
from collections.abc import Iterator

# Decodes one 8-bit PNG row at a time into a bytearray, with all five
# filter types, so a full simulator capture is never held as Python ints.
CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def read_png(path: str) -> tuple[tuple[int, int], int, bytes]:
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    pos = 8
    header = None
    idat: list[bytes] = []
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        chunk_type = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += length + 12
        if chunk_type == b"IHDR":
            header = struct.unpack(">IIBBBBB", chunk[:13])
        elif chunk_type == b"IDAT":
            idat.append(chunk)
        elif chunk_type == b"IEND":
            break
    if header is None:
        raise SystemExit(f"{path}: missing IHDR")
    width, height, depth, color, _, _, interlace = header
    if depth != 8 or color not in CHANNELS or interlace != 0:
        raise SystemExit(
            f"{path}: unsupported PNG (bit depth {depth}, color type {color}, interlace {interlace})"
        )
    return (width, height), CHANNELS[color], zlib.decompress(b"".join(idat))


def rows(path: str) -> tuple[tuple[int, int, int], Iterator[bytearray]]:
    (width, height), bpp, inflated = read_png(path)
    stride = width * bpp
    if len(inflated) < height * (stride + 1):
        raise SystemExit(f"{path}: truncated image data")

    def generate() -> Iterator[bytearray]:
        prev = bytearray(stride)
        offset = 0
        for _ in range(height):
            filter_type = inflated[offset]
            row = bytearray(inflated[offset + 1 : offset + 1 + stride])
            offset += stride + 1
            if filter_type == 1:
                for i in range(bpp, stride):
                    row[i] = (row[i] + row[i - bpp]) & 0xFF
            elif filter_type == 2:
                for i in range(stride):
                    row[i] = (row[i] + prev[i]) & 0xFF
            elif filter_type == 3:
                for i in range(stride):
                    left = row[i - bpp] if i >= bpp else 0
                    row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xFF
            elif filter_type == 4:
                for i in range(stride):
                    left = row[i - bpp] if i >= bpp else 0
                    upper_left = prev[i - bpp] if i >= bpp else 0
                    row[i] = (row[i] + paeth(left, prev[i], upper_left)) & 0xFF
            elif filter_type != 0:
                raise SystemExit(f"{path}: invalid PNG filter {filter_type}")
            yield row
            prev = row

    return (width, height, bpp), generate()


baseline_path, capture_path = sys.argv[1], sys.argv[2]
baseline_size, baseline_rows = rows(baseline_path)
capture_size, capture_rows = rows(capture_path)
if baseline_size != capture_size:
    raise SystemExit(
        "TV-Face screenshot size mismatch (width, height, channels): "
        f"baseline {baseline_size}, capture {capture_size}"
    )
mismatches = 0
for left_row, right_row in zip(baseline_rows, capture_rows):
    if left_row != right_row:
        mismatches += sum(1 for left, right in zip(left_row, right_row) if left != right)
if mismatches:
    raise SystemExit(f"TV-Face screenshot differs from baseline ({mismatches} byte mismatches)")
print(f"TV-Face screenshot matches baseline {baseline_path}")
PNG_COMPARE
