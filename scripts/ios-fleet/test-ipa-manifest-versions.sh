#!/usr/bin/env bash
# --upload-only must publish the IPA's real versions, or nothing.  Never the
# "(from IPA)" placeholder.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
awk '/^ipa_manifest_versions\(\) \{/ {g=1} g {print} g && /^}/ {exit}' "${here}/ship-testflight.sh" >"${tmp}/fn.sh"
[[ -s "${tmp}/fn.sh" ]] || fail "ipa_manifest_versions not found"
# shellcheck disable=SC1091
source "${tmp}/fn.sh"
mkipa() { # name bundle ver build [app-dir]
  python3 - "$1" "$2" "$3" "$4" "${5:-Payload/X.app}" <<'PY'
import plistlib, sys, zipfile
out, bid, ver, build, d = sys.argv[1:6]
with zipfile.ZipFile(out, "w") as z:
    z.writestr(d + "/Info.plist", plistlib.dumps({"CFBundleIdentifier": bid, "CFBundleShortVersionString": ver, "CFBundleVersion": build}, fmt=plistlib.FMT_BINARY))
PY
}
mkipa "${tmp}/ok.ipa" app.example 0.1.0 0.1.7
[[ "$(ipa_manifest_versions "${tmp}/ok.ipa" app.example)" == "0.1.0 0.1.7" ]] || fail "versions not read"
if ipa_manifest_versions "${tmp}/ok.ipa" other.app >/dev/null; then fail "another app's IPA was accepted"; fi
if ipa_manifest_versions "${tmp}/missing.ipa" app.example >/dev/null; then fail "a missing IPA was accepted"; fi
mkipa "${tmp}/bad.ipa" app.example "(from IPA)" 1
if ipa_manifest_versions "${tmp}/bad.ipa" app.example >/dev/null; then fail "a placeholder version was accepted"; fi
mkipa "${tmp}/nested.ipa" app.example 1.0.0 1 "Payload/X.app/Frameworks/Y.framework"
if ipa_manifest_versions "${tmp}/nested.ipa" app.example >/dev/null; then fail "a nested plist was accepted"; fi
grep -q 'ipa_manifest_versions "\$UPLOAD_ONLY_IPA"' "${here}/ship-testflight.sh" || fail "record_successful_ship does not use it"
echo "ok: --upload-only publishes the IPA's real versions or skips"
