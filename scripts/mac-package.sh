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
#   APPLE_API_KEY_P8    Apple notarization API key, plus APPLE_API_KEY_ID and
#   APPLE_API_ISSUER_ID APPLE_API_ISSUER_ID.  Read from the environment
#                       first, then from fleet-secrets (Infisical).  The
#                       Keychain is not an approved source for a provider
#                       credential, so there is no keychain-profile fallback:
#                       a missing credential fails the build instead of
#                       quietly reading a different store.
#   SPARKLE_EDDSA_KEY   sign_update private key file; without it (and
#                       without sign_update on PATH) the appcast is an
#                       unsigned draft and the output says so
#
# Flags:
#   --skip-notarize     Developer build only.  Skips notarization and
#                       stapling, writes into <out>/UNSIGNED and labels
#                       every artifact NOT DISTRIBUTABLE.  No appcast is
#                       generated for such a build.
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
  if [ -n "$P8_FILE" ]; then rm -f "$P8_FILE"; fi
  return 0
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

APP="$WORK/export/BotFleetMac.app"
[ -d "$APP" ] || { echo "export produced no BotFleetMac.app in $WORK/export" >&2; exit 69; }

# Gate: the signature must verify BEFORE notarization.  Notarization accepts
# invalid signatures, so submitting first would burn the slowest step in the
# pipeline to learn what this check answers in seconds.
codesign --verify --deep --strict "$APP"
TEAM="$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[ "$TEAM" = "CC8UTF7ATG" ] || { echo "app is signed by team '${TEAM:-none}', not CC8UTF7ATG" >&2; exit 69; }
echo "ok: signature verifies (team $TEAM)"

# Notarization credentials: the environment first, fleet-secrets (Infisical)
# second.  A keychain profile is not an approved source for a provider
# credential, so there is no keychain fallback here; a build without
# credentials fails loudly instead of authenticating from an unexpected
# store.  The values never reach a command line and never reach the log.
APPLE_API_KEY_P8="${APPLE_API_KEY_P8:-}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}"
APPLE_API_ISSUER_ID="${APPLE_API_ISSUER_ID:-}"
if [ -z "$APPLE_API_KEY_P8" ] && command -v fleet-secrets >/dev/null; then
  APPLE_API_KEY_P8="$(fleet-secrets get APPLE_API_KEY_P8 2>/dev/null || true)"
  APPLE_API_KEY_ID="$(fleet-secrets get APPLE_API_KEY_ID 2>/dev/null || true)"
  APPLE_API_ISSUER_ID="$(fleet-secrets get APPLE_API_ISSUER_ID 2>/dev/null || true)"
fi
if [ "$SKIP_NOTARIZE" -eq 0 ] &&
  { [ -z "$APPLE_API_KEY_P8" ] || [ -z "$APPLE_API_KEY_ID" ] || [ -z "$APPLE_API_ISSUER_ID" ]; }; then
  echo "notarization credentials are missing: set APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID in the environment, or provision them for fleet-secrets" >&2
  exit 69
fi

notarize() {
  # $1 = file to submit.  Requires an "Accepted" result; a rejection stops
  # the package here rather than retrying blind, and the notary's own
  # diagnostic is printed first — "not Accepted" alone is not a reason.
  local file="$1" out
  if [ -z "$P8_FILE" ]; then
    # ONE key file for every submission, so cleanup() can remove it.
    P8_FILE="$(mktemp)"
  fi
  # The private key never enters a command line: the here-string expands in
  # the shell, not in argv, so a traced run cannot print the value.
  cat > "$P8_FILE" <<< "$APPLE_API_KEY_P8"
  chmod 600 "$P8_FILE"
  if ! out="$(xcrun notarytool submit "$file" --key "$P8_FILE" \
    --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait 2>&1)"; then
    echo "$out" >&2
    echo "notarization failed for $file" >&2
    return 1
  fi
  echo "$out" | tail -2
  echo "$out" | grep -q "status: Accepted" || { echo "notarization not Accepted for $file" >&2; return 1; }
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
  # Un-notarized bytes never enter the release directory: the appcast and
  # the verifier must not be able to bless them.
  OUT="$OUT/UNSIGNED"
fi

# Final bytes only from here: stapling already rewrote the bundle.
mkdir -p "$OUT"
# A previous run of the same version leaves its artifacts behind.  The ZIP,
# the DMG and the appcast are rewritten below, and the signature sidecar is
# written by the signing block, so none of them may survive from an earlier
# run: a stale .edsig would be embedded as the signature of today's bytes.
rm -f "$OUT/${APP_NAME}.zip" "$OUT/${APP_NAME}.dmg" "$OUT/${APP_NAME}.zip.edsig" "$OUT/appcast.xml"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/${APP_NAME}.zip"
hdiutil create -volname "BotFleet" -srcfolder "$APP" -ov -format UDZO "$OUT/${APP_NAME}.dmg" >/dev/null

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  notarize "$OUT/${APP_NAME}.dmg"
  xcrun stapler staple "$OUT/${APP_NAME}.dmg"
  xcrun stapler validate "$OUT/${APP_NAME}.dmg"
fi

if [ "$SKIP_NOTARIZE" -ne 0 ]; then
  echo "done: $OUT/${APP_NAME}.zip, $OUT/${APP_NAME}.dmg (NOT DISTRIBUTABLE; no appcast was generated)"
  exit 0
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
