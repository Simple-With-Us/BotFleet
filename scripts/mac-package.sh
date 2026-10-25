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
# Signing material is never read from this repo and never printed.  The Apple
# notarization credentials are resolved in the fleet's approved order: the
# environment first, then Infisical through `fleet-secrets get`, and only then
# this machine's own notarytool keychain profile, which is a bootstrap
# identity rather than a shared secret store:
#   APPLE_API_KEY_P8   App Store Connect API private key (PEM)
#   APPLE_API_KEY_ID   the key's id, and APPLE_API_ISSUER_ID its issuer
#   NOTARY_PROFILE     notarytool keychain profile (default: AC_PASSWORD)
#   MAC_SIGN_IDENTITY  Keychain identity (default: Developer ID Application)
#   SPARKLE_EDDSA_KEY  sign_update private key file; without it (and
#                       without sign_update on PATH) the appcast is an
#                       unsigned draft and the output says so
#
# The API key never reaches argv and never stays at a path: it is written to
# a private temporary file, that file is opened on a file descriptor and
# unlinked at once, and notarytool reads it through the descriptor.
#
# Flags:
#   --skip-notarize     Developer build only.  Skips notarization and
#                       stapling, writes to an UNSIGNED/ subdirectory, and
#                       labels every artifact NOT DISTRIBUTABLE.
#   --out DIR           Output directory (default: release-native)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release-native"
SKIP_NOTARIZE=0
# The native assets live on their own release tag, exactly as the workflow
# does: release.yml owns the v<version> release, verifies that its asset set
# is exactly the Electron set, and deletes every asset it does not
# recognise.  The appcast's enclosure URL therefore names the native tag.
NATIVE_TAG_SUFFIX="${NATIVE_TAG_SUFFIX:--native}"
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
P8_FD_OPEN=0
cleanup() {
  rm -rf "$WORK"
  if [ -n "$P8_FILE" ]; then rm -f "$P8_FILE"; fi
  if [ "$P8_FD_OPEN" -eq 1 ]; then exec 3<&-; fi
  # The trap must never change the script's exit status: a successful run
  # that ends on a false test would otherwise report failure.
  return 0
}
trap cleanup EXIT

# Resolve the Apple notarization credentials in the approved order.  The
# environment wins; Infisical is the next source; the keychain profile below
# is the machine-identity bootstrap and the last resort.  Nothing is printed.
resolve_notary_credentials() {
  if [ -z "${APPLE_API_KEY_P8:-}" ] && command -v fleet-secrets >/dev/null 2>&1; then
    APPLE_API_KEY_P8="$(fleet-secrets get APPLE_API_KEY_P8 2>/dev/null || true)"
  fi
  if [ -z "${APPLE_API_KEY_ID:-}" ] && command -v fleet-secrets >/dev/null 2>&1; then
    APPLE_API_KEY_ID="$(fleet-secrets get APPLE_API_KEY_ID 2>/dev/null || true)"
  fi
  if [ -z "${APPLE_API_ISSUER_ID:-}" ] && command -v fleet-secrets >/dev/null 2>&1; then
    APPLE_API_ISSUER_ID="$(fleet-secrets get APPLE_API_ISSUER_ID 2>/dev/null || true)"
  fi
}

# Open the API key on a file descriptor and unlink it at once, so the key is
# never at a path again and one file serves every notarization in the run.
open_api_key() {
  if [ "$P8_FD_OPEN" -eq 1 ]; then return 0; fi
  P8_FILE="$(mktemp)"
  # `set +x` around the one write that sees the key: a traced run must not be
  # able to echo it.  The previous trace state is restored afterwards.
  xtrace_was_on=0
  case "$-" in *x*) xtrace_was_on=1 ;; esac
  set +x
  printf '%s' "$APPLE_API_KEY_P8" > "$P8_FILE"
  if [ "$xtrace_was_on" -eq 1 ]; then set -x; fi
  exec 3< "$P8_FILE"
  rm -f "$P8_FILE"
  P8_FILE=""
  P8_FD_OPEN=1
}

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

resolve_notary_credentials

notarize() {
  # $1 = file to submit.  Requires an "Accepted" result; a rejection stops
  # the package here rather than retrying blind.  The notary's own output is
  # printed before the failure, because that output is the only place the
  # reason is written down ("not signed with a valid Developer ID
  # certificate", "does not use the hardened runtime").
  local file="$1" out
  if [ -n "${APPLE_API_KEY_P8:-}" ] || [ -n "${APPLE_API_KEY_ID:-}" ] || [ -n "${APPLE_API_ISSUER_ID:-}" ]; then
    # A half-set API key is a configuration error, not a reason to fall back
    # to a different identity.
    if [ -z "${APPLE_API_KEY_P8:-}" ] || [ -z "${APPLE_API_KEY_ID:-}" ] || [ -z "${APPLE_API_ISSUER_ID:-}" ]; then
      echo "notarization credentials are incomplete: APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID must be set together" >&2
      exit 69
    fi
    open_api_key
    out="$(xcrun notarytool submit "$file" --key /dev/fd/3 \
      --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait 2>&1)" || {
      echo "$out"
      echo "notarization failed for $file" >&2
      exit 69
    }
  else
    out="$(xcrun notarytool submit "$file" \
      --keychain-profile "${NOTARY_PROFILE:-AC_PASSWORD}" --wait 2>&1)" || {
      echo "$out"
      echo "notarization failed for $file" >&2
      exit 69
    }
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
  # Keep the un-notarized bytes out of the release directory.  An appcast
  # generated over them would advertise a build that Sparkle and Gatekeeper
  # reject, and the release verifier would accept it, so an un-notarized
  # build gets its own directory and no feed at all.
  OUT="$OUT/UNSIGNED"
  mkdir -p "$OUT"
fi

# Final bytes only from here: stapling already rewrote the bundle.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/${APP_NAME}.zip"
hdiutil create -volname "BotFleet" -srcfolder "$APP" -ov -format UDZO "$OUT/${APP_NAME}.dmg" >/dev/null

if [ "$SKIP_NOTARIZE" -ne 0 ]; then
  echo "done: $OUT/${APP_NAME}.zip, $OUT/${APP_NAME}.dmg (NOT DISTRIBUTABLE; no appcast generated)"
  exit 0
fi

notarize "$OUT/${APP_NAME}.dmg"
xcrun stapler staple "$OUT/${APP_NAME}.dmg"
xcrun stapler validate "$OUT/${APP_NAME}.dmg"

# Sparkle signature over the FINAL zip.  The private key stays in a file the
# caller names; its value never reaches this script's output.  Any signature
# left over from an earlier run of the same version describes different
# bytes, so it goes before signing, never after.
rm -f "$OUT/${APP_NAME}.zip.edsig"
if [ -n "${SPARKLE_EDDSA_KEY:-}" ] && command -v sign_update >/dev/null; then
  SIGNATURE="$(sign_update --ed-key-file "$SPARKLE_EDDSA_KEY" "$OUT/${APP_NAME}.zip" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')"
  [ -n "$SIGNATURE" ] || { echo "sign_update produced no signature" >&2; exit 69; }
  printf '%s' "$SIGNATURE" > "$OUT/${APP_NAME}.zip.edsig"
  echo "ok: Sparkle EdDSA signature recorded"
else
  echo "note: no Sparkle signing (SPARKLE_EDDSA_KEY unset or sign_update missing); appcast will be an unsigned draft"
fi

node "$ROOT/scripts/native-appcast.mjs" "$OUT" "$VERSION" "v$VERSION${NATIVE_TAG_SUFFIX}"
if [ -n "${SPARKLE_EDDSA_KEY:-}" ] && [ -f "$OUT/${APP_NAME}.zip.edsig" ]; then
  node "$ROOT/scripts/verify-native-release.mjs" "$OUT" "$VERSION" --require-signature
else
  node "$ROOT/scripts/verify-native-release.mjs" "$OUT" "$VERSION"
fi

echo "done: $OUT/${APP_NAME}.zip, $OUT/${APP_NAME}.dmg, $OUT/appcast.xml ($VERSION)"
