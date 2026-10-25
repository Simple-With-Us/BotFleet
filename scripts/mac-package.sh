#!/usr/bin/env bash
# Package BotFleetMac as a notarized, stapled Developer ID build (BF-2486).
#
# The local counterpart of .github/workflows/native-mac-release.yml: same
# gates, same order, same asset names, so a build cut on a Mac and a build
# cut in CI differ only in where the signing material came from.  The order
# below is not negotiable; each step exists because skipping it shipped a
# broken update once (see docs/releasing.md for the incident list):
#
#   archive -> export -> codesign gate -> zip -> notarize -> staple
#   -> FINAL zip/dmg bytes -> appcast -> verify
#
# Notarization accepts invalid signatures, so the codesign gate runs before
# anything is submitted.  Stapling rewrites the bundle, so the ZIP, DMG,
# lengths and appcast are all produced after stapling, never before.
#
# Signing material is never read from this repo and never printed:
#   MAC_SIGN_IDENTITY   Keychain identity (default: Developer ID Application)
#   NOTARY_PROFILE      notarytool keychain profile (default: AC_PASSWORD),
#                       or APPLE_API_KEY_P8 / APPLE_API_KEY_ID /
#                       APPLE_API_ISSUER_ID for API-key auth
#   SPARKLE_EDDSA_KEY   sign_update private key file; without it (and
#                       without sign_update on PATH) the appcast is an
#                       unsigned draft and the output says so
#
# Flags:
#   --skip-notarize     Developer build only.  Skips notarization and
#                       stapling and labels every artifact NOT DISTRIBUTABLE.
#   --out DIR           Output directory (default: release-native)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release-native"
SKIP_NOTARIZE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-notarize) SKIP_NOTARIZE=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

command -v xcodebuild >/dev/null || { echo "xcodebuild not found; run on a Mac with Xcode installed" >&2; exit 69; }
if xcodebuild -version | grep -qi beta; then
  echo "xcodebuild reports a beta Xcode toolchain; refusing to package" >&2; exit 69
fi

VERSION="$(node "$ROOT/scripts/stamp-commit-version.mjs" "$ROOT")"
BUILD="${VERSION##*.}"
APP_NAME="BotFleetMac-${VERSION}"
WORK="$(mktemp -d)"
P8_FILE=""
cleanup() {
  rm -rf "$WORK"
  [ -n "$P8_FILE" ] && rm -f "$P8_FILE"
}
trap cleanup EXIT

echo "packaging BotFleetMac $VERSION (build $BUILD)"

# The Xcode project is generated, never committed (ios/.gitignore).
if ! command -v xcodegen >/dev/null; then
  bash "$ROOT/scripts/ios-install-xcodegen.sh"
fi
(cd "$ROOT/ios" && xcodegen generate)

mkdir -p "$OUT"
xcodebuild archive \
  -project "$ROOT/ios/BotFleet.xcodeproj" \
  -scheme BotFleetMac \
  -destination 'generic/platform=macOS' \
  -archivePath "$WORK/BotFleetMac.xcarchive" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="${MAC_SIGN_IDENTITY:-Developer ID Application}" \
  DEVELOPMENT_TEAM=CC8UTF7ATG

xcodebuild -exportArchive \
  -archivePath "$WORK/BotFleetMac.xcarchive" \
  -exportOptionsPlist "$ROOT/ios/ExportOptions-DeveloperID.plist" \
  -exportPath "$WORK/export"

APP="$WORK/export/BotFleet.app"
[ -d "$APP" ] || { echo "export produced no BotFleet.app in $WORK/export" >&2; exit 69; }

# Gate: the signature must verify BEFORE notarization.  Notarization accepts
# invalid signatures, so submitting first would burn the slowest step in the
# pipeline to learn what this check answers in seconds.
codesign --verify --deep --strict "$APP"
TEAM="$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[ "$TEAM" = "CC8UTF7ATG" ] || { echo "app is signed by team '${TEAM:-none}', not CC8UTF7ATG" >&2; exit 69; }
echo "ok: signature verifies (team $TEAM)"

notarize() {
  # $1 = file to submit.  Requires an "Accepted" result; a rejection stops
  # the package here rather than retrying blind.
  local file="$1" out
  if [ -n "${APPLE_API_KEY_P8:-}" ]; then
    P8_FILE="$(mktemp)"
    printf '%s' "$APPLE_API_KEY_P8" > "$P8_FILE"
    out="$(xcrun notarytool submit "$file" --key "$P8_FILE" \
      --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait 2>&1)"
  else
    out="$(xcrun notarytool submit "$file" \
      --keychain-profile "${NOTARY_PROFILE:-AC_PASSWORD}" --wait 2>&1)"
  fi
  echo "$out" | tail -2
  echo "$out" | grep -q "status: Accepted" || { echo "notarization not Accepted for $file" >&2; exit 69; }
}

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/submit.zip"
  notarize "$WORK/submit.zip"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type execute "$APP" || { echo "Gatekeeper assessment failed for $APP" >&2; exit 69; }
  echo "ok: notarized, stapled, Gatekeeper-clean"
else
  echo "WARNING: --skip-notarize; this build is NOT DISTRIBUTABLE"
fi

# Final bytes only from here: stapling already rewrote the bundle.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/${APP_NAME}.zip"
hdiutil create -volname "BotFleet" -srcfolder "$APP" -ov -format UDZO "$OUT/${APP_NAME}.dmg" >/dev/null

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  notarize "$OUT/${APP_NAME}.dmg"
  xcrun stapler staple "$OUT/${APP_NAME}.dmg"
  xcrun stapler validate "$OUT/${APP_NAME}.dmg"
fi

# Sparkle signature over the FINAL zip.  The private key stays in a file the
# caller names; its value never reaches this script's output.
if [ -n "${SPARKLE_EDDSA_KEY:-}" ] && command -v sign_update >/dev/null; then
  SIGNATURE="$(sign_update --ed-key-file "$SPARKLE_EDDSA_KEY" "$OUT/${APP_NAME}.zip" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')"
  [ -n "$SIGNATURE" ] || { echo "sign_update produced no signature" >&2; exit 69; }
  printf '%s' "$SIGNATURE" > "$OUT/${APP_NAME}.zip.edsig"
  echo "ok: Sparkle EdDSA signature recorded"
else
  echo "note: no Sparkle signing (SPARKLE_EDDSA_KEY unset or sign_update missing); appcast will be an unsigned draft"
fi

node "$ROOT/scripts/native-appcast.mjs" "$OUT" "$VERSION"
if [ -n "${SPARKLE_EDDSA_KEY:-}" ] && [ -f "$OUT/${APP_NAME}.zip.edsig" ]; then
  node "$ROOT/scripts/verify-native-release.mjs" "$OUT" "$VERSION" --require-signature
else
  node "$ROOT/scripts/verify-native-release.mjs" "$OUT" "$VERSION"
fi

echo "done: $OUT/${APP_NAME}.zip, $OUT/${APP_NAME}.dmg, $OUT/appcast.xml ($VERSION)"
