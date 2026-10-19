#!/usr/bin/env bash
# Prepare a GitHub-hosted macOS runner to archive BotFleet for TestFlight.
# Validates the existing BotFleet Actions secret names (the ship step reads the
# APPLE_API_* names straight from the environment;  nothing is written under
# ~/.secrets, AFC-359), then imports the iOS Distribution identity.
# Never prints secret values.  Fail closed on a beta macOS host.
# Canonical siblings: Congress.Trade / DealDex / Socratic.Trade
# scripts/ios-appstore-gm-prepare.sh
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[ios-gm] $*"; }

os=$(sw_vers -productVersion)
build=$(sw_vers -buildVersion)
log "macOS ${os} (${build})"
# Apple seed trains stamp a lowercase letter after the build number
# (26A5406e).  GM builds end in digits (25F84, 24G720).
if echo "$build" | grep -Eq '[0-9][a-z]$'; then
  die "beta macOS host ${os} (${build}).  App Store review rejects these as INVALID_BINARY.  Use GitHub-hosted macos-latest (GM)."
fi

# Fleet names (ASC_*) if a sibling copy is ever mapped; otherwise the
# six Plumber-set BotFleet names.  APPLE_API_KEY_P8_BASE64 is base64 of
# the p8 body (the retired ios-testflight.yml decoded it the same way).
if [[ -z "${ASC_KEY_ID:-}" && -n "${APPLE_API_KEY_ID:-}" ]]; then
  ASC_KEY_ID="$APPLE_API_KEY_ID"
fi
if [[ -z "${ASC_ISSUER_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" ]]; then
  ASC_ISSUER_ID="$APPLE_API_ISSUER_ID"
fi
if [[ -z "${IOS_DIST_P12_BASE64:-}" && -n "${IOS_CERT_P12_BASE64:-}" ]]; then
  IOS_DIST_P12_BASE64="$IOS_CERT_P12_BASE64"
fi
if [[ -z "${IOS_DIST_P12_PASSWORD:-}" && -n "${IOS_CERT_PASSWORD:-}" ]]; then
  IOS_DIST_P12_PASSWORD="$IOS_CERT_PASSWORD"
fi

: "${ASC_KEY_ID:?APPLE_API_KEY_ID (or ASC_KEY_ID) required}"
: "${ASC_ISSUER_ID:?APPLE_API_ISSUER_ID (or ASC_ISSUER_ID) required}"
: "${IOS_DIST_P12_BASE64:?IOS_CERT_P12_BASE64 (or IOS_DIST_P12_BASE64) required}"
: "${IOS_DIST_P12_PASSWORD:?IOS_CERT_PASSWORD (or IOS_DIST_P12_PASSWORD) required}"

# Check the p8 is present and decodes to a PEM, without writing it anywhere.
# The ship step (ship-testflight.sh load_secrets, asc-api.mjs) decodes
# APPLE_API_KEY_P8_BASE64 itself into a private temp file and removes it.
if [[ -n "${ASC_KEY_P8:-}" ]]; then
  p8_ok=$(printf '%s\n' "$ASC_KEY_P8" | grep -c "BEGIN " || true)
elif [[ -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
  case "$APPLE_API_KEY_P8_BASE64" in
    *BEGIN*) p8_ok=1 ;;
    *) p8_ok=$(printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode 2>/dev/null | grep -c "BEGIN " || true) ;;
  esac
else
  die "APPLE_API_KEY_P8_BASE64 (or ASC_KEY_P8) required"
fi
if [[ "${p8_ok:-0}" -lt 1 ]]; then
  die "ASC p8 did not decode to a PEM private key"
fi

KC_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KC_PATH="${KC_DIR}/app-signing.keychain-db"
KC_PASS_FILE="${KC_DIR}/app-signing-kc-pass"
P12_PATH="${KC_DIR}/ios-distribution.p12"
( umask 077; printf '%s' "$IOS_DIST_P12_BASE64" | base64 --decode > "$P12_PATH" )
chmod 600 "$P12_PATH"
openssl rand -base64 24 > "$KC_PASS_FILE"
chmod 600 "$KC_PASS_FILE"
KC_PASS=$(cat "$KC_PASS_FILE")

security delete-keychain "$KC_PATH" >/dev/null 2>&1 || true
security create-keychain -p "$KC_PASS" "$KC_PATH"
security set-keychain-settings -lut 21600 "$KC_PATH"
security unlock-keychain -p "$KC_PASS" "$KC_PATH"
security import "$P12_PATH" -k "$KC_PATH" -P "$IOS_DIST_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/xcodebuild >/dev/null
rm -f "$P12_PATH"
security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PASS" "$KC_PATH" >/dev/null
security list-keychain -d user -s "$KC_PATH" login.keychain-db

# Identity names only — never dump the p12.
if ! security find-identity -v -p codesigning "$KC_PATH" | grep -q 'Apple Distribution'; then
  die "imported keychain has no Apple Distribution identity"
fi
log "Apple Distribution identity imported"
log "ASC credential present (key id length ${#ASC_KEY_ID})"
