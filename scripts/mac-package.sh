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
# notarization credentials come from the store and from nowhere else (owner
# ruling, November 22, 2026:  the environment carries no copy of a value):
# Infisical through the scoped reader, with this consumer's own read-only
# account.  An inherited value is cleared before the read, so a hand-set one
# can never displace the reviewed grant:
#   APPLE_API_KEY_P8   App Store Connect API private key (PEM)
#   APPLE_API_KEY_ID   the key's id, and APPLE_API_ISSUER_ID its issuer
#   NOTARY_PROFILE     notarytool keychain profile, named by the store;  the
#                       machine's own keychain holds the credential, and the
#                       store names which profile it is.  There is no
#                       default profile and no ambient fallback:  without the
#                       store's answer the build stops here.
#   MAC_SIGN_IDENTITY  Keychain identity (default: Developer ID Application)
#   SPARKLE_EDDSA_KEY  sign_update private key file; required with
#                       sign_update on PATH for distributable packaging
#   SENTRY_DSN         native Sentry DSN (BF-2541); the scoped reader only,
#                       never printed.  Empty is fine:  the package ships
#                       with Sentry inert, exactly like the release workflow.
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

# The shared scoped reader helper.  It resolves the reader, names the
# consumer's own account and fails closed when there is no reader or no
# grant:  the value reaches stdout and nothing else does.  A helper that is
# not there refuses the read rather than stopping the packaging run.
FLEET_INFISICAL_HELPER="$ROOT/scripts/lib/fleet-infisical-read.sh"
if [ -f "$FLEET_INFISICAL_HELPER" ]; then
  . "$FLEET_INFISICAL_HELPER"
else
  fleet_secret_get() {
    echo "the scoped reader helper is not installed at ${FLEET_INFISICAL_HELPER}" >&2
    return 4
  }
fi

# Where the notarization credentials live, and which account reads them.
# They are the App Store Connect key, so they live in the fleet's App Store
# Connect folder, and the account is that consumer's own read-only service
# token:  a grant covers exactly one folder, so it is named here rather than
# guessed at runtime.
NOTARY_SECRET_FOLDER="/asc"
NOTARY_SECRET_ACCOUNT="${FLEET_INFISICAL_ASC_ACCOUNT:-fleet-tools-mm-asc-ro}"
# The Sentry DSN is a fleet-wide key, so it lives in the global keys folder
# with its own account.  An account that is not provisioned is a refused read:
# it never falls back to another consumer's grant.
SENTRY_SECRET_FOLDER="/global-api-keys"
SENTRY_SECRET_ACCOUNT="${FLEET_INFISICAL_SENTRY_ACCOUNT:-}"
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

# Create the DMG (BF-2711).  hdiutil is deprecated on macOS 27, so prefer
# `diskutil image` where the host has it and keep the hdiutil spelling as
# the fallback for older runners.  The rm preserves hdiutil's -ov
# (overwrite) semantics, which diskutil create does not offer.
create_dmg() { # volume-name source-folder destination.dmg
  rm -f "$3"
  if /usr/sbin/diskutil image create from --help >/dev/null 2>&1; then
    /usr/sbin/diskutil image create from --format UDZO --volumeName "$1" "$2" "$3" >/dev/null
  else
    /usr/bin/hdiutil create -volname "$1" -srcfolder "$2" -ov -format UDZO "$3" >/dev/null
  fi
}

# Resolve the Apple notarization credentials.  Nothing is printed.
#
# The store is the only source.  The environment is not a second source and
# not a fallback (owner ruling, November 22, 2026):  the inherited names are
# cleared before the read, so a hand-set value cannot displace the reviewed
# grant, and nothing that was inherited is used when the store has nothing.
#
# The folder holds the key under the ASC spelling the fleet's own reader uses
# and under the Apple spelling the workflows use.  Both name the same
# credential, so both are tried and the first answer wins.  The notarytool
# keychain profile is named by the store too:  the machine's keychain holds
# the credential, and the store says which profile it is.
resolve_notary_credentials() {
  local value
  # An inherited copy of any of these names is cleared before the store is
  # asked, so it can never be used as a credential.
  unset APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER_ID
  unset ASC_KEY_P8 ASC_KEY_ID ASC_ISSUER_ID
  unset NOTARY_PROFILE
  value="$(fleet_secret_get ASC_KEY_P8 "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  [ -n "$value" ] || value="$(fleet_secret_get APPLE_API_KEY_P8 "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  if [ -n "$value" ]; then APPLE_API_KEY_P8="$value"; fi
  value="$(fleet_secret_get ASC_KEY_ID "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  [ -n "$value" ] || value="$(fleet_secret_get APPLE_API_KEY_ID "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  if [ -n "$value" ]; then APPLE_API_KEY_ID="$value"; fi
  value="$(fleet_secret_get ASC_ISSUER_ID "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  [ -n "$value" ] || value="$(fleet_secret_get APPLE_API_ISSUER_ID "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  if [ -n "$value" ]; then APPLE_API_ISSUER_ID="$value"; fi
  # The keychain profile is the store's answer as well:  without it there is
  # no identity to notarize with, and the run stops with a reason that names
  # the folder and the account it needed.
  NOTARY_PROFILE=""
  value="$(fleet_secret_get NOTARY_PROFILE "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  [ -n "$value" ] || value="$(fleet_secret_get NOTARY_KEYCHAIN_PROFILE "$NOTARY_SECRET_FOLDER" "$NOTARY_SECRET_ACCOUNT" 2>/dev/null || true)"
  if [ -n "$value" ]; then NOTARY_PROFILE="$value"; fi
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

# Only an explicitly nondistributable build may omit public update metadata.
# Existing local fields are comparison inputs, never canonical configuration.
export MIRROR_BOTFLEET_NATIVE_UPDATE_FEED_URL="${MIRROR_BOTFLEET_NATIVE_UPDATE_FEED_URL:-${BOTFLEET_NATIVE_UPDATE_FEED_URL:-}}"
export MIRROR_BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY="${MIRROR_BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY:-${BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY:-}}"
if [ "$SKIP_NOTARIZE" -eq 1 ]; then
  node "$ROOT/scripts/native-update-release-config.mjs" --output "$WORK/native-update.env" --allow-unconfigured
else
  node "$ROOT/scripts/native-update-release-config.mjs" --output "$WORK/native-update.env"
fi
while IFS='=' read -r name value; do export "$name=$value"; done < "$WORK/native-update.env"
if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  if [ -z "${SPARKLE_EDDSA_KEY:-}" ] || ! command -v sign_update >/dev/null; then
    echo "distributable native updates require the Sparkle signing key file and sign_update" >&2
    exit 69
  fi
fi

# The Xcode project is generated, never committed (ios/.gitignore).
if ! command -v xcodegen >/dev/null; then
  bash "$ROOT/scripts/ios-install-xcodegen.sh"
fi
(cd "$ROOT/ios" && xcodegen generate)

# Native Sentry (BF-2541): same stamping as native-mac-release.yml.  The
# store is the only source for the DSN, and an inherited copy is cleared
# before the read (owner ruling, November 22, 2026).  The DSN is never
# printed, and an empty DSN packages with Sentry inert rather than failing
# the build.
unset SENTRY_DSN
SENTRY_DSN_VALUE="$(fleet_secret_get SENTRY_DSN "$SENTRY_SECRET_FOLDER" "$SENTRY_SECRET_ACCOUNT" 2>/dev/null || true)"
if [ -n "$SENTRY_DSN_VALUE" ]; then SENTRY_DSN="$SENTRY_DSN_VALUE"; fi
SENTRY_DSN="${SENTRY_DSN:-}"
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -z "$SENTRY_DSN" ]; then
  echo "note: no SENTRY_DSN in the scoped reader at $SENTRY_SECRET_FOLDER; package ships with Sentry inert"
fi

mkdir -p "$OUT"
xcodebuild archive \
  -project "$ROOT/ios/BotFleet.xcodeproj" \
  -scheme BotFleetMac \
  -destination 'generic/platform=macOS' \
  -archivePath "$WORK/BotFleetMac.xcarchive" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  SENTRY_DSN="$SENTRY_DSN" \
  SOURCE_COMMIT="$SOURCE_COMMIT" \
  BOTFLEET_NATIVE_UPDATE_FEED_URL="${BOTFLEET_NATIVE_UPDATE_FEED_URL:-}" \
  BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY="${BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY:-}" \
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

# The notarization credentials are resolved only on the path that notarizes.  A
# --skip-notarize build is a developer build:  it submits nothing to
# Apple, it writes to an UNSIGNED/ directory and it is labelled NOT
# DISTRIBUTABLE, so reading the API key and the notarytool profile would be a
# secret lookup for a step that never runs.  The reads live inside
# resolve_notary_credentials, so guarding the call guards the reads.
if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  resolve_notary_credentials
fi

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
    # No App Store Connect key in the store:  the keychain profile it names
    # is the identity.  There is no default profile and no ambient fallback,
    # so without the store's answer the run stops here and says what it
    # needed.  The name of a profile is a grant name, not a secret, and no
    # value is printed.
    if [ -z "${NOTARY_PROFILE:-}" ]; then
      echo "no notarization identity in the store: read NOTARY_PROFILE (or APPLE_API_KEY_P8, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID) from Infisical ${NOTARY_SECRET_FOLDER} for account ${NOTARY_SECRET_ACCOUNT}" >&2
      exit 69
    fi
    out="$(xcrun notarytool submit "$file" \
      --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" || {
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
create_dmg "BotFleet" "$APP" "$OUT/${APP_NAME}.dmg"

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
  echo "Sparkle signing is required for distributable native updates" >&2
  exit 69
fi

node "$ROOT/scripts/native-appcast.mjs" "$OUT" "$VERSION" "v$VERSION${NATIVE_TAG_SUFFIX}"
node "$ROOT/scripts/verify-native-release.mjs" "$OUT" "$VERSION" --require-signature --public-key "$BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY"

echo "done: $OUT/${APP_NAME}.zip, $OUT/${APP_NAME}.dmg, $OUT/appcast.xml ($VERSION)"
