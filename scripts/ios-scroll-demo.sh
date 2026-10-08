#!/bin/sh
# Simulator check for the iOS chat transcript's bottom-follow.
#
# Builds the DEBUG app, launches the scroll demo in manual mode on a
# simulator, plays streamed turns with notifyutil, and saves screenshots and
# the follow log.  No harness, no pairing, no network: the demo seeds a long
# preview thread and drives the real reducer.
#
#   scripts/ios-scroll-demo.sh [--no-build] [--device "BF Scroll iPhone 17 Pro"]
#                              [--out DIR] [--wait-for-scroll SECONDS]
#
# The pinned half runs on its own: a turn plays while the reader sits on the
# newest message, and the log must show it followed with no stop.  The
# scrolled half needs a person or an agent to scroll the transcript up (a
# swipe, or a tap on the status bar) during --wait-for-scroll; then a turn
# plays and the log must show the reader's offset held and following stayed
# off.  Set IOS_LOCK to a lock file to serialize simulator and build work
# with other lanes.  See docs/verification/ios-companion.md.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
device_name="BF Scroll iPhone 17 Pro"
device_type="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
out=""
build=1
wait_for_scroll=0
derived="${DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/bf-scroll-demo}"
bundle_id="app.botfleet.ios"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0 ;;
    --device) device_name="$2"; shift ;;
    --out) out="$2"; shift ;;
    --wait-for-scroll) wait_for_scroll="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$out" ] || out=$(mktemp -d "${TMPDIR:-/tmp}/ios-scroll-demo.XXXXXX")
mkdir -p "$out"

heavy() {
  if [ -n "${IOS_LOCK:-}" ]; then /usr/bin/lockf -k "$IOS_LOCK" "$@"; else "$@"; fi
}

pause() { perl -e 'select(undef, undef, undef, shift)' "$1"; }

# Build and copy the app under one lock, so another lane sharing the
# DerivedData folder cannot swap its build in between.
app="$out/BotFleet.app"
product="$derived/Build/Products/Debug-iphonesimulator/BotFleet.app"
if [ "$build" = 1 ]; then
  (cd "$repo/ios" && xcodegen generate >/dev/null)
  heavy /bin/sh -c '
    xcodebuild -project "$1/ios/BotFleet.xcodeproj" -scheme BotFleet \
      -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO \
      -derivedDataPath "$2" build >"$3/build.log" 2>&1 \
      && rm -rf "$4" && cp -R "$5" "$4"
  ' sh "$repo" "$derived" "$out" "$app" "$product" \
    || { echo "build failed, see $out/build.log" >&2; exit 1; }
else
  rm -rf "$app"
  cp -R "$product" "$app"
fi

# The UUID is the first parenthesis after the name; the last one is the state.
udid=$(xcrun simctl list devices available | grep -F "$device_name (" | head -n 1 \
  | sed 's/^[^(]*(\([0-9A-Fa-f-]*\)).*/\1/')
if [ -z "$udid" ]; then
  udid=$(heavy xcrun simctl create "$device_name" "$device_type")
fi
heavy xcrun simctl boot "$udid" 2>/dev/null || true
heavy xcrun simctl bootstatus "$udid" -b >/dev/null
heavy xcrun simctl install "$udid" "$app"

xcrun simctl spawn "$udid" log stream --level debug --style compact \
  --predicate 'category == "transcript-scroll"' >"$out/scroll.log" 2>&1 &
log_pid=$!
trap 'kill "$log_pid" 2>/dev/null || true' EXIT

heavy xcrun simctl launch --terminate-running-process "$udid" "$bundle_id" \
  -store-preview -open-first -scroll-demo -scroll-demo-manual >/dev/null

# A turn posted before the demo listens is lost, and a loaded Mac can take
# many seconds to lay out the chat.  Wait for both in the log.
tries=0
until grep -q "demo: waiting" "$out/scroll.log" && grep -q "sample offset" "$out/scroll.log"; do
  tries=$((tries + 1))
  [ "$tries" -lt 120 ] || { echo "the demo never started, see $out/scroll.log" >&2; exit 1; }
  pause 1
done
pause 3

shot() { heavy xcrun simctl io "$udid" screenshot "$out/$1.png" >/dev/null 2>&1; }

# A turn is five tool steps, about 150 streamed words and a follow-up.  It
# runs slower than its timers on a loaded Mac, so wait for the log line.
play_turn() {
  before=$(grep -c "demo: turn .* finished" "$out/scroll.log" || true)
  heavy xcrun simctl spawn "$udid" notifyutil -p app.botfleet.scroll-demo.turn
  pause 6
  shot "$1-mid-turn"
  tries=0
  while [ "$(grep -c "demo: turn .* finished" "$out/scroll.log" || true)" -le "$before" ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 90 ] || { echo "turn did not finish, see $out/scroll.log" >&2; exit 1; }
    pause 1
  done
  pause 1
  shot "$1-after-turn"
}

lines_since() { tail -n +"$1" "$out/scroll.log"; }

# Debug lines can be dropped by `log stream` on a loaded Mac.  A window with
# no samples proves nothing either way, so it fails rather than passing.
require_samples() {
  if ! lines_since "$1" | grep -q "sample offset"; then
    echo "FAIL: the log stream dropped the scroll samples for the $2 turn; rerun on a quieter Mac" >&2
    exit 1
  fi
}

shot open
mark=$(($(wc -l <"$out/scroll.log") + 1))
play_turn pinned
require_samples "$mark" pinned
if lines_since "$mark" | grep -q "follow: stopped following"; then
  echo "FAIL: following stopped during a turn the reader did not touch" >&2
  exit 1
fi
echo "pinned: followed the whole turn"

if [ "$wait_for_scroll" -gt 0 ]; then
  echo "scroll the transcript up now (swipe, or tap the status bar); waiting ${wait_for_scroll}s"
  mark=$(($(wc -l <"$out/scroll.log") + 1))
  pause "$wait_for_scroll"
  if ! lines_since "$mark" | grep -q "stopped following"; then
    echo "FAIL: no scroll away from the bottom was seen" >&2
    exit 1
  fi
  shot scrolled-before-turn
  mark=$(($(wc -l <"$out/scroll.log") + 1))
  play_turn scrolled
  require_samples "$mark" scrolled
  if lines_since "$mark" | grep -qE "follow: following|repinning"; then
    echo "FAIL: the transcript moved back to the bottom while the reader was scrolled up" >&2
    exit 1
  fi
  offsets=$(lines_since "$mark" | sed -n 's/.*sample offset=\([-0-9.]*\).*following=false.*/\1/p' | sort -u | wc -l)
  if [ "$offsets" -gt 1 ]; then
    echo "FAIL: the reader's offset changed while a turn streamed below them" >&2
    exit 1
  fi
  echo "scrolled: position held through the turn, Jump to Latest shown"
fi

echo "evidence in $out"
