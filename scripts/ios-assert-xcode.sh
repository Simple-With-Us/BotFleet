#!/usr/bin/env bash
# Fail unless the selected Xcode (DEVELOPER_DIR / xcode-select) is the exact
# stable version given as $1, e.g. `bash scripts/ios-assert-xcode.sh 27.0`.
# Used by ci.yml (Swift tests + iOS build) and ios-ship.yml on GitHub's hosted
# `xcode-27` image, which also carries Xcode 27.x betas.  ASCII-only.
set -euo pipefail

want="${1:?usage: ios-assert-xcode.sh <major.minor>}"

if [[ -n "${DEVELOPER_DIR:-}" && ! -d "$DEVELOPER_DIR" ]]; then
  echo "::error::DEVELOPER_DIR does not exist on this runner: ${DEVELOPER_DIR}" >&2
  ls -d /Applications/Xcode*.app 2>/dev/null >&2 || true
  exit 1
fi
case "${DEVELOPER_DIR:-}" in
  *[Bb]eta*) echo "::error::DEVELOPER_DIR points at a beta Xcode: ${DEVELOPER_DIR}" >&2; exit 1 ;;
esac

info="$(xcodebuild -version)"
echo "$info"
if grep -qi beta <<<"$info"; then
  echo "::error::xcodebuild reports a beta toolchain" >&2
  exit 1
fi
have="$(awk 'NR==1{print $2}' <<<"$info")"
# "27.0" and "27.0.1" both satisfy want=27.0; "27.1" does not.
case "$have" in
  "$want"|"$want".*) ;;
  *) echo "::error::expected Xcode ${want}, got ${have}" >&2; exit 1 ;;
esac
sdk="$(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null || echo unknown)"
echo "Xcode ${have} OK; iphoneos SDK ${sdk}"
