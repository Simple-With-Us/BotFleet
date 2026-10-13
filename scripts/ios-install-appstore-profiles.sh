#!/usr/bin/env bash
# Ensure, download, and install BotFleet App Store provisioning profiles over the
# App Store Connect API for MANUAL Release signing.
#
# WHY: Xcode 26 automatic signing (-allowProvisioningUpdates) calls
# developerservices2.apple.com, and the fleet App Store Connect API key gets
# HTTP 401 NOT_AUTHORIZED there while api.appstoreconnect.apple.com accepts the
# same key.  Hosted ships therefore create or reuse IOS_APP_STORE profiles over
# the REST API (asc-api.mjs ensure-appstore-profiles), install them here, and
# archive with CODE_SIGN_STYLE=Manual from ios/project.yml Release settings.
#
# Map: ios/appstore-profiles.json  { "<bundle id>": "<profile name>" }
# Names must equal PROVISIONING_PROFILE_SPECIFIER in ios/project.yml.
#
# Checks, all fail closed:
#   - exactly the mapped name, for the mapped bundle id, profileState ACTIVE
#   - profile application-identifier ends with the bundle id
#   - get-task-allow is false (distribution, not development)
#   - installed profile entitlements include IOS_REQUIRED_APP_GROUP (default
#     group.app.botfleet) when the target entitlements require it
#   - when a codesigning identity is installed, one of the profile certificates
#     matches that identity
#
# Prints names, bundle ids, UUIDs, and certificate SHA-1 fingerprints only.
# Never prints profile bytes or credentials.  ASCII-only (Apple bash 3.2 safe).
#
# Env overrides (tests / local use):
#   IOS_APPSTORE_PROFILES_MAP   profile map (default ios/appstore-profiles.json)
#   IOS_PROFILES_DIR            install dir (default ~/Library/MobileDevice/Provisioning Profiles)
#   IOS_REQUIRED_APP_GROUP      App Group entitlement required in each profile
#   IOS_PROFILE_SKIP_IDENTITY_CHECK=1   skip the keychain certificate match
set +o xtrace
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAP="${IOS_APPSTORE_PROFILES_MAP:-${ROOT}/ios/appstore-profiles.json}"
CLIENT="${ROOT}/scripts/ios-fleet/asc-api.mjs"
DEST="${IOS_PROFILES_DIR:-${HOME}/Library/MobileDevice/Provisioning Profiles}"
REQUIRED_APP_GROUP="${IOS_REQUIRED_APP_GROUP:-group.app.botfleet}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/bf-profiles.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

[[ -f "$MAP" ]] || { echo "error: profile map missing: $MAP" >&2; exit 1; }
[[ -f "$CLIENT" ]] || { echo "error: App Store Connect client missing: $CLIENT" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node not on PATH" >&2; exit 1; }
command -v security >/dev/null 2>&1 || { echo "error: security(1) not found (macOS only)" >&2; exit 1; }

mkdir -p "$DEST"

log() { echo "[ios-profiles] $*"; }

log "ensuring App Store profiles exist (reuse ACTIVE profiles; create only when missing)"
set +e
node "$CLIENT" ensure-appstore-profiles "$MAP" 2>"$WORKDIR/ensure.err"
ensure_rc=$?
set -e
if [[ -s "$WORKDIR/ensure.err" ]]; then
  while IFS= read -r line; do [[ -n "$line" ]] && log "$line"; done <"$WORKDIR/ensure.err"
fi
[[ "$ensure_rc" -eq 0 ]] || {
  echo "error: ensure-appstore-profiles failed (rc=${ensure_rc})" >&2
  exit 1
}

IDENTITIES="$WORKDIR/identities.txt"
: >"$IDENTITIES"
if [[ "${IOS_PROFILE_SKIP_IDENTITY_CHECK:-}" != "1" ]]; then
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -nE 's/^ *[0-9]+\) ([0-9A-F]{40}) "(.*)"$/\1 \2/p' >"$IDENTITIES" || true
fi

set +e
node "$CLIENT" GET '/v1/profiles?filter[profileType]=IOS_APP_STORE&limit=200&include=bundleId' \
  >"$WORKDIR/profiles.json" 2>"$WORKDIR/profiles.err"
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  status_line="$(grep -m1 -E '^HTTP [0-9]+' "$WORKDIR/profiles.err" || echo 'no HTTP status')"
  code="$(python3 -c 'import json,sys
try:
    e=(json.load(open(sys.argv[1])).get("errors") or [{}])[0]
    print(e.get("code") or e.get("title") or "")
except Exception:
    print("")' "$WORKDIR/profiles.json")"
  echo "error: App Store Connect profile list failed (rc=${rc}, ${status_line}${code:+, ${code}})" >&2
  exit 1
fi

python3 - "$MAP" "$DEST" "$WORKDIR" "$IDENTITIES" "$REQUIRED_APP_GROUP" <<'PY'
import base64, hashlib, json, os, plistlib, subprocess, sys

want = json.load(open(sys.argv[1], encoding="utf-8"))
dest, workdir, identities_path, required_group = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
data = json.load(open(os.path.join(workdir, "profiles.json"), encoding="utf-8"))
if data.get("errors"):
    err = data["errors"][0]
    raise SystemExit("error: profile list failed: %s %s" % (err.get("status") or "", err.get("code") or err.get("title") or "unknown"))
if not isinstance(want, dict) or not want:
    raise SystemExit("error: profile map must be a non-empty {bundleId: profileName} object")

identities = {}
for line in open(identities_path, encoding="utf-8"):
    line = line.strip()
    if line:
        sha1, _, name = line.partition(" ")
        identities[sha1.upper()] = name

bundles = {}
for inc in data.get("included") or []:
    if inc.get("type") == "bundleIds":
        bundles[inc["id"]] = (inc.get("attributes") or {}).get("identifier")

found = {}
for row in data.get("data") or []:
    rel = ((row.get("relationships") or {}).get("bundleId") or {}).get("data") or {}
    bid = bundles.get(rel.get("id"))
    attrs = row.get("attributes") or {}
    if bid in want and attrs.get("name") == want[bid] and attrs.get("profileState") == "ACTIVE":
        prev = found.get(bid)
        if prev is None or (attrs.get("expirationDate") or "") > ((prev.get("attributes") or {}).get("expirationDate") or ""):
            found[bid] = row

missing = sorted(bid for bid in want if bid not in found)
if missing:
    raise SystemExit(
        "error: no ACTIVE IOS_APP_STORE profile named as mapped for: %s.  "
        "ensure-appstore-profiles should have created these; re-run or fix ios/appstore-profiles.json." % ", ".join(missing))

for bid, row in sorted(found.items()):
    attrs = row.get("attributes") or {}
    name = attrs.get("name")
    blob = base64.b64decode(attrs.get("profileContent") or "")
    if not blob:
        raise SystemExit("error: profile %s has no content" % name)
    raw_path = os.path.join(workdir, bid + ".mobileprovision")
    with open(raw_path, "wb") as handle:
        handle.write(blob)
    os.chmod(raw_path, 0o600)
    plist = plistlib.loads(subprocess.check_output(["security", "cms", "-D", "-i", raw_path], stderr=subprocess.DEVNULL))
    ents = plist.get("Entitlements") or {}
    app_id = str(ents.get("application-identifier") or "")
    if not app_id.endswith("." + bid):
        raise SystemExit("error: profile %s is for %s, not %s" % (name, app_id, bid))
    if ents.get("get-task-allow") is not False:
        raise SystemExit("error: profile %s is not a distribution profile (get-task-allow is not false)" % name)
    if required_group:
        groups = ents.get("com.apple.security.application-groups") or []
        if isinstance(groups, str):
            groups = [groups]
        if required_group not in groups:
            raise SystemExit(
                "error: profile %s for %s is missing App Group %s required by the target entitlements.  "
                "Assign App Group %s to App ID %s in the Apple Developer portal, then delete the stale "
                "profile in App Store Connect or re-run the ship so ensure-appstore-profiles can create a "
                "new one.  See ios/AppStore/RELEASE.md." % (name, bid, required_group, required_group, bid))
    uuid = plist.get("UUID")
    if not uuid:
        raise SystemExit("error: profile %s has no UUID" % name)
    certs = [hashlib.sha1(c).hexdigest().upper() for c in plist.get("DeveloperCertificates") or []]
    if identities:
        hits = [c for c in certs if c in identities]
        if not hits:
            raise SystemExit(
                "error: profile %s does not include any installed codesigning identity.  "
                "Profile certs: %s.  Installed: %s.  Regenerate the profile with the Apple "
                "Distribution certificate that ios-appstore-gm-prepare.sh imports."
                % (name, ", ".join(certs) or "none", ", ".join(sorted(identities)) or "none"))
        print("profile %s matches identity %s (%s)" % (name, hits[0], identities[hits[0]]))
    final = os.path.join(dest, uuid + ".mobileprovision")
    os.replace(raw_path, final)
    os.chmod(final, 0o644)
    print("installed %s name=%s uuid=%s expires=%s" % (bid, name, uuid, attrs.get("expirationDate")))
PY
