#!/usr/bin/env bash
# Applied via ios/project.yml options.postGenCommand after `xcodegen generate`.
# XcodeGen 2.46.x only emits projectFormat up to xcode16_3 (objectVersion 90).
# Xcode 27 stable uses objectVersion 100 and compatibilityVersion "Xcode 27.0".
set -euo pipefail

ios_dir="$(cd "$(dirname "$0")/../ios" && pwd)"
pbxproj="${ios_dir}/BotFleet.xcodeproj/project.pbxproj"

if [[ ! -f "$pbxproj" ]]; then
  echo "ios-xcodegen-post: missing ${pbxproj} (run xcodegen generate first)" >&2
  exit 1
fi

perl -i -pe '
  s/objectVersion = \d+;/objectVersion = 100;/g;
  s/preferredProjectObjectVersion = \d+;/preferredProjectObjectVersion = 100;/g;
  s/compatibilityVersion = "[^"]*";/compatibilityVersion = "Xcode 27.0";/g;
' "$pbxproj"

if ! grep -q 'compatibilityVersion = "Xcode 27.0"' "$pbxproj"; then
  perl -i -pe '
    if (/^\tobjectVersion = 100;/ && !$done++) {
      $_ .= "\tcompatibilityVersion = \"Xcode 27.0\";\n";
    }
  ' "$pbxproj"
fi

if ! grep -q 'objectVersion = 100;' "$pbxproj"; then
  echo "ios-xcodegen-post: failed to set objectVersion 100" >&2
  exit 1
fi
