#!/usr/bin/env bash
# ship-testflight.sh - Archive + upload an iOS app to TestFlight without Xcode UI.
#
# Usage:
#   bash /Users/jay/apps/ios-fleet/ship-testflight.sh <socratic|congress|usage|usage-local|dealdex|autorotate|autorotate-mac|contactlogo|contactlogo-mac|botfleet|botfleet-mac> [options]
#
# Options:
#   --repo-root PATH   Repo root (default: cwd)
#   --build N          Force CURRENT_PROJECT_VERSION (exact; default: the repo
#                      commit count, raised above the App Store Connect floor)
#   --version X.Y.Z    Force MARKETING_VERSION (exact; default: the next patch
#                      on the app's train)
#   --export-only      Build IPA only; do not upload
#   --upload-only IPA  Skip archive; upload an existing IPA via ASC API key
#   --dry-run          Print plan and exit
#   --skip-xcodegen    Do not regenerate .xcodeproj
#   --allow-dirty      Allow shipping from a dirty git worktree
#   --force-ship       Bypass min-interval + same-HEAD skip (emergency / owner)
#   --sync-project-version  Write the resolved version into project.pbxproj
#   --allow-unverified-seq  Ship even if App Store Connect cannot be consulted
#                           (dangerous: the marketing version and the build
#                           number are then planned from unverified state)
#
# Version numbering (owner directive 2026-10-24, AFC-517; replaces the
# 1.0.<commit_count> scheme unified in #2801 on 2026-10-18):
#   MARKETING_VERSION       = <prefix>.<P+1>
#       <prefix> is the train from marketingVersionDefault (1.0).  P is the
#       highest patch already used on that train in App Store Connect, counting
#       BOTH the App Store versions (appStoreVersions.versionString) AND the
#       TestFlight trains (preReleaseVersions.version) for the app's platform.
#       A TestFlight train that holds a build named after its own patch (the
#       "1.0.2358 (2358)" drift trains) is IGNORED, so those uploads no longer
#       push the version forward.  App Store versions are never ignored.
#   CURRENT_PROJECT_VERSION = the repo commit count (git rev-list --count
#       HEAD), raised when needed so that it is strictly greater than every
#       build already in the TARGET marketing train (old 12-digit UTC stamps
#       included:  Apple requires build numbers to grow inside one train) and
#       than the app's highest plain-integer build below 1000000000 on that
#       platform.  On macOS EVERY build counts, because macOS build numbers
#       have to grow across all trains.
#   The two numbers are INDEPENDENT:  the build number never names the
#       marketing version, and the marketing version never names the build.  The
#       only coupling is a safety rule:  a ship must never look like "1.0.N (N)",
#       so a build that happens to equal the patch number moves one up.
#   --version X.Y.Z is an exact marketing override and --build N an exact build
#       override.  With --version only the build is still automatic (the commit
#       count, floored against that train);  with --build only the marketing
#       version is still the automatic next patch.
#   App Store Connect renders "<marketing> (<build>)", e.g. "1.0.237 (2360)".
#
# ---------------------------------------------------------------------------
# WHAT IS HOLDING BACK AUTOMATIC SHIPPING: THE MIN-INTERVAL RATE LIMIT
# ---------------------------------------------------------------------------
# Applies to uploads only (--export-only and --dry-run are free):
#   DEFAULT MINIMUM INTERVAL BETWEEN SUCCESSFUL TESTFLIGHT SHIPS, PER APP:
#       DEFAULT_MIN_INTERVAL_SEC=3600  (3600 seconds = 1 hour)
#   That constant is defined a few dozen lines below and is the main reason a
#   merge to main does not become a TestFlight build. .github/workflows/
#   ios-ship.yml fires on every push to main touching clients/ios/**, and this
#   gate turns most of those runs into a no-op skip (exit 0).
#   Override for one run:  IOS_TF_MIN_INTERVAL_SEC=7200 (2h)  or  --force-ship
#   Change the default:    edit DEFAULT_MIN_INTERVAL_SEC below (owner's call).
#
#   Also skips when git HEAD matches the last successful ship (no new commits).
#   Skip exits 0 ("nothing to do") so agent loops stay quiet, and a skipped run
#   does NOT resolve or consume a version (see the ship-gate ordering note
#   at the call site).
#   State: ~/.cache/ios-fleet/last-ship-<app>.txt  (unix_ts + space + git_sha)
#
# ---------------------------------------------------------------------------
# POST-UPLOAD: ensure-tf-ready AND TESTFLIGHT RELEASE NOTES (2026-08-13)
# ---------------------------------------------------------------------------
# ensure_tf_ready now passes BUILD_NUM (CFBundleVersion) to asc-api.mjs, which
# polls App Store Connect until THAT EXACT BUILD appears and only then declares
# export compliance on it. Before this it took "the newest build", which for the
# first minutes after an upload is the PREVIOUS ship -- so compliance was
# declared on the wrong build and the "testers can install this" line described
# a build it had never looked at.
#   IOS_TF_READY_TIMEOUT_SEC   discovery + readiness budget (default 900s)
#   exit 4 from asc-api.mjs    uploaded build never surfaced; warn, do NOT fail
#                              (record_successful_ship must still run or the rate
#                              gate never advances)
#
# It also renders the mandatory AGENT-SYNC "What to Test" release note from the
# commit range since the last successful ship. THIS IS OPT-IN, because it writes
# copy every TestFlight tester reads:
#   IOS_TF_RELEASE_NOTES=1     publish to App Store Connect
#   IOS_TF_RELEASE_NOTES=0     off entirely
#   unset (DEFAULT)            dry render into the ship log; nothing is written
#   IOS_TF_RELEASE_TITLE=...   override the "<App> Update" title
# CI needs `fetch-depth: 0` on actions/checkout or the runner workspace holds a
# single commit and the range is uncomputable (verified 2026-08-13 on all three
# fleet runners).
#
# Secrets (never printed):
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8  (env first; else Infisical via
#   `fleet-secrets get`: /asc ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8, written to a
#   0600 temp file and deleted on exit).  A path in ASC_KEY_PATH is NOT a
#   credential source:  it is ignored wherever it appears.
#   or Xcode-signed-in session for destination=upload export
#   SENTRY_AUTH_TOKEN  (dSYM + Size Analysis upload; env or `fleet-secrets get`)
#   SENTRY_DSN         (injected into xcodebuild so Cocoa plist $(SENTRY_DSN) is set)
#
# Sentry after a successful archive (2026-09-01):
#   debug-files upload of the xcarchive dSYMs, then `sentry-cli build upload`
#   for Size Analysis.  Failures WARN and do not fail the TestFlight ship.
#   Quota: 100 size-analysis builds/month on the sponsored plan.  No LaunchAgent.
#
# ASCII-only (Apple bash 3.2 safe). Team: CC8UTF7ATG.

set -euo pipefail

# LaunchAgents inherit a tiny PATH (no Homebrew). Node is required for
# ensure-tf-ready and for the App Store Connect queries. Keep this before any
# `node` / `xcodegen` call.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
# The node that runs asc-api.mjs.  IOS_FLEET_NODE lets an offline test
# answer App Store Connect from a stub;  a real ship leaves it unset and
# uses node from PATH.
ASC_NODE="${IOS_FLEET_NODE:-node}"

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
APPS_JSON="${FLEET_DIR}/apps.json"
TEAM_ID="CC8UTF7ATG"
# AFC-359: App Store Connect credentials come from the environment (CI sets them) or
# Infisical Fleet-OPS via fleet-secrets.  Nothing is read from the old secrets folder.
FLEET_SECRETS_BIN="${FLEET_SECRETS:-${HOME}/.local/bin/fleet-secrets}"
ASC_TMP_DIR=""
# "staging" means a credential was resolved and the staging path was refused.
# Anything else, including empty, means no credential was resolved.  The upload
# step has to say which one it is.  A path refusal is not a missing key.
ASC_AUTH_FAILURE=""
cleanup_asc_tmp() {
  if [[ -n "${ASC_TMP_DIR:-}" ]]; then
    rm -rf "$ASC_TMP_DIR" 2>/dev/null || true
  fi
  ASC_TMP_DIR=""
}
trap cleanup_asc_tmp EXIT
# 1 hour — owner 2026-08-14: ship unbuilt iOS updates as often as once per hour.
# Not Apple compute; local/process hygiene. Cron ticks twice an hour so a
# trailing merge inside the window is picked up on the next eligible tick.
DEFAULT_MIN_INTERVAL_SEC=3600
# Overridable so the sequence/rate-limit state can be pointed at a scratch dir
# for testing without touching real ship history.
STATE_DIR="${IOS_FLEET_STATE_DIR:-${HOME}/.cache/ios-fleet}"

APP_KEY=""
REPO_ROOT=""
FORCE_BUILD=""
FORCE_VERSION=""
EXPORT_ONLY=0
UPLOAD_ONLY_IPA=""
DRY_RUN=0
SKIP_XCODEGEN=0
ALLOW_DIRTY=0
FORCE_SHIP=0
ALLOW_UNVERIFIED_SEQ=0
SYNC_PROJECT_VERSION=0

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[ios-ship] $*"; }
# Same prefix, but on stderr — for use inside $(...) helpers whose stdout is
# the return value and must stay clean.
logerr() { echo "[ios-ship] $*" >&2; }

usage() {
  # Print the header comment block: everything before the first non-comment line.
  sed -n '2,${/^[^#]/q;p;}' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

json_get() {
  # json_get <app_key> <field>
  /usr/bin/python3 - "$APPS_JSON" "$1" "$2" <<'PY'
import json, sys
path, app, field = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
apps = data["apps"]
if app not in apps:
    print("", end="")
    sys.exit(0)
val = apps[app].get(field)
if val is None:
    print("", end="")
elif isinstance(val, list):
    print(",".join(val), end="")
else:
    print(val, end="")
PY
}

resolve_project() {
  local root="$1" rel="$2" alt="$3"
  if [[ -n "$rel" && -e "${root}/${rel}" ]]; then
    echo "${root}/${rel}"
    return 0
  fi
  if [[ -n "$alt" && -e "${root}/${alt}" ]]; then
    echo "${root}/${alt}"
    return 0
  fi
  return 1
}

# fs_get NAME FOLDER -> value on stdout (never logged); non-zero when absent.
fs_get() {
  local v bin="$FLEET_SECRETS_BIN"
  [[ -x "$bin" ]] || bin="$(command -v fleet-secrets 2>/dev/null || true)"
  [[ -n "$bin" && -x "$bin" ]] || return 1
  v="$("$bin" get "$1" --path "$2" 2>/dev/null </dev/null)" || return 1
  [[ -n "$v" ]] || return 1
  printf '%s' "$v"
}

# A directory mktemp may use.  macOS TMPDIR ends in a slash, and joining
# another slash onto it produces a doubled slash.  resolveStagingTarget
# refuses a path that is not normal, so every trailing slash is stripped
# here.  A TMPDIR of "/" strips down to nothing, and nothing is not a
# directory:  the root of the filesystem is refused rather than turned into
# a path that can be written, because a key staged there would land in "/".
asc_temp_root() {
  local root="${TMPDIR:-/tmp}"
  while [[ "$root" == */ ]]; do
    root="${root%/}"
  done
  #  An empty root is the filesystem root:  a key staged there would land in
  #  "/", so it is refused instead of being turned into a writable path.
  [[ -n "$root" ]] || return 1
  printf '%s' "$root"
}

# Make the temp directory that holds a materialised .p8 (0700), once.
# A directory that cannot be created is a path failure and not a crash:  the
# caller classifies it.  A root TMPDIR reaches it, because asc_temp_root
# refuses the root of the filesystem before mktemp is ever called.
asc_tmp_dir() {
  if [[ -z "$ASC_TMP_DIR" ]]; then
    local root
    root="$(asc_temp_root)" || { ASC_TMP_DIR=""; return 1; }
    ASC_TMP_DIR="$(umask 077; mktemp -d "${root}/asc-key.XXXXXX")" || {
      ASC_TMP_DIR=""
      return 1
    }
  fi
  return 0
}

# Why an upload has no usable staged key.  "staging" is a path or file refusal
# after a credential was resolved.  "credential" is a resolved credential that
# is not a usable PEM private key.  "writer" is the key writer itself failing
# (a crash, a missing node, or a signal), which classifies neither the key nor
# the path.  "missing" is no credential.  The owner handoff for a missing key
# applies to none of the other three.
asc_upload_block() {
  case "${ASC_AUTH_FAILURE:-}" in
    staging) printf '%s\n' "staging" ;;
    credential) printf '%s\n' "credential" ;;
    writer) printf '%s\n' "writer" ;;
    *) printf '%s\n' "missing" ;;
  esac
}

# A rejected credential is named by its SOURCE, its KEY ID and its ISSUER ID:
#  the id and the issuer id are public labels that travel in every App Store
# Connect request header, and together they say exactly WHICH key was
# refused.  The id is printed only when it looks like one:  anything else is
# reported as "unrecognized", so a mis-set id that happens to hold the key, or
# a line break, can never reach the log.
#
# NOTHING taken out of the key itself is printed.  A PEM body is the base64
# of the DER of the private key, so every byte of it is secret and a
# first-eight/last-four slice of it is a slice of the key's own encoding;
# there is no non-secret prefix of a private key the way there is for a
# provider API key, where the prefix is a public label.  A review rule cannot
# authorize exposing a value, and a body mask could not even identify the
# credential:  two different keys share a first eight and a last four.  The
# key id and the issuer id are the public labels that do identify it.
key_label() {
  local v="${1:-}"
  if [[ -z "$v" ]]; then
    printf '%s' "missing"
  elif [[ "${#v}" -le 32 && "$v" =~ ^[A-Za-z0-9]+$ ]]; then
    printf '%s' "$v"
  else
    printf '%s' "unrecognized"
  fi
}

# The ISSUER ID is the other public label of the credential:  it travels in
# every request header beside the key id, so it identifies the key exactly.
# It is a UUID, so it carries dashes, and key_label would report it as
# unrecognized;  it is printed when it looks like one, and anything else is
# reported as "unrecognized", so a mis-set issuer id or a line break can
# never reach the log.
key_issuer_label() {
  local v="${1:-}"
  if [[ -z "$v" ]]; then
    printf '%s' "missing"
  elif [[ "${#v}" -le 64 && "$v" =~ ^[A-Za-z0-9-]+$ ]]; then
    printf '%s' "$v"
  else
    printf '%s' "unrecognized"
  fi
}

# The credential the App Store Connect client used, for the rejection paths
# where the shell has not resolved it yet.  The source selection mirrors
# asc-api.mjs exactly:  a source counts only when its WHOLE trio is present
# and its key decodes to a PEM, so a diagnostic never names a key the client
# skipped.
#
# Only material the ENVIRONMENT already holds is read.  The vault is never
# asked for the key material here:  a diagnostic must not cause a secret
# read.  The vault's KEY ID and ISSUER ID are read when no environment source
# qualifies, because both are public labels that travel in every request
# header.
#
# The result is the public key id in ASC_DIAG_KEY_ID and the public issuer id
# in ASC_DIAG_ISSUER_ID.  NOTHING taken out of the key is reported:  a masked
# preview of a private-key body is not printed anywhere, because every byte
# of that body is secret (see the comment above key_label).
ASC_DIAG_KEY_ID=""
ASC_DIAG_ISSUER_ID=""
asc_resolve_diagnostic_credential() {
  local v="" id="" issuer=""
  if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" && -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
    case "$APPLE_API_KEY_P8_BASE64" in
      *BEGIN*) v="$APPLE_API_KEY_P8_BASE64" ;;
      *) v="$(base64 --decode <<< "$APPLE_API_KEY_P8_BASE64" 2>/dev/null)" || v="" ;;
    esac
    if [[ -n "$v" ]] && node "${FLEET_DIR}/asc-key.mjs" validate >/dev/null 2>&1 <<< "$v"; then
      id="$APPLE_API_KEY_ID"
      issuer="$APPLE_API_ISSUER_ID"
    else
      #  The client skips a source whose key is not a usable PEM and goes on
      #  to the NEXT source, so this diagnostic must not name it -- and must
      #  not stop looking for the source the client did use.
      v=""
    fi
  fi
  #  The client falls through to the environment source when the CI trio is
  #  absent or unusable, so this branch is evaluated on its own and NOT as an
  #  alternative to the CI branch:  an elif would leave a valid ASC_*
  #  credential unreported whenever an APPLE_* trio is present but invalid.
  if [[ -z "$id" && -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${ASC_KEY_P8:-}" ]]; then
    if node "${FLEET_DIR}/asc-key.mjs" validate >/dev/null 2>&1 <<< "$ASC_KEY_P8"; then
      v="$ASC_KEY_P8"
      id="$ASC_KEY_ID"
      issuer="$ASC_ISSUER_ID"
    fi
  fi
  if [[ -z "$id" ]]; then
    #  The client's last source is Infisical /asc.  Only the KEY ID and the
    #  ISSUER ID are read from it:  both are public labels, not key
    #  material.
    id="${ASC_KEY_ID:-}"
    [[ -n "$id" ]] || id="$(fs_get ASC_KEY_ID /asc 2>/dev/null || true)"
    issuer="${ASC_ISSUER_ID:-}"
    [[ -n "$issuer" ]] || issuer="$(fs_get ASC_ISSUER_ID /asc 2>/dev/null || true)"
  fi
  v=""
  ASC_DIAG_KEY_ID="$id"
  ASC_DIAG_ISSUER_ID="$issuer"
}

# Load ASC credentials into the CURRENT shell (must not run inside $(...) or the
# exported ASC_* vars are discarded with the subshell). Sets AUTH_MODE to
# "api_key" or "none". Never prints secret values.
#
# WHY THE KEY IS HANDED OVER IN THE ENVIRONMENT (AFC-459, Kody rule 42 on the
# CodeCaps PR #271 review):  the private key is a secret, and the approved
# secret sources are the process environment, a captured `fleet-secrets get
# NAME` and bootstrap-only Keychain credentials.  A caller-supplied file is not
# one of them, so the node client never reads a key file.  This shell layer
# owns the credential for altool and Xcode, so it hands the key to the client
# in the environment, which is where the client looks for it.
#
# THE CREDENTIAL IS RESOLVED FROM THREE PLACES:
#   1. CI: the APPLE_API_* names the ship workflow exports from Infisical
#   2. ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 already in the environment
#   3. Mac: Infisical Fleet-OPS through fleet-secrets, /asc ASC_KEY_ID,
#      ASC_ISSUER_ID and ASC_KEY_P8.
# A disk credential is not a source at all:  a named ASC_KEY_PATH is ignored,
# so a stale or foreign path in an operator's shell can never sign the upload
# with the wrong key.  The key material never enters a command argument and
# never reaches a log line.
load_secrets() {
  AUTH_MODE="none"
  ASC_AUTH_FAILURE=""
  #  A named ASC_KEY_PATH is not a credential source.  It is remembered only
  #  so the run can say that it ignored it, and it is cleared here:  an
  #  inherited path must never reach xcodebuild when the resolution below
  #  fails, because then it would be a credential this run never resolved.
  #  Only the staging copy written from the resolved credential is exported.
  local named_path="${ASC_KEY_PATH:-}"
  unset ASC_KEY_PATH
  local kid="${ASC_KEY_ID:-}" iss="${ASC_ISSUER_ID:-}" key_pem="" rc=0
  local key_path="" asc_kid="" key_src=""

  # 1. CI: the APPLE_API_* names the ship workflow exports from Infisical.
  #    The p8 is base64 there, so it is decoded here, and it never travels in
  #    an argument:  the here-string hands it to the decoder on stdin.
  if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" && -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
    case "$APPLE_API_KEY_P8_BASE64" in
      *BEGIN*) key_pem="$APPLE_API_KEY_P8_BASE64" ;;
      *) key_pem="$(base64 --decode <<< "$APPLE_API_KEY_P8_BASE64" 2>/dev/null)" || key_pem="" ;;
    esac
    if [[ -n "$key_pem" ]]; then
      rc=0
      node "${FLEET_DIR}/asc-key.mjs" validate >/dev/null 2>&1 <<< "$key_pem" || rc=$?
      if [[ "$rc" -eq 3 ]]; then
        #  The credential was resolved and then rejected.  That is a
        #  credential failure, not a missing key:  the owner has to fix the
        #  value that is there, not create a key that already exists.
        #  The rejected value is named by its SOURCE, its KEY ID and its
        #  ISSUER ID, and by nothing that came out of the key:  every byte of
        #  a private-key body is secret, so there is no fragment of it that
        #  may be shown.
        log "APPLE_API_KEY_P8_BASE64 did not decode to a PEM private key; ignoring it (source APPLE_API_KEY_P8_BASE64, key id $(key_label "${APPLE_API_KEY_ID:-}"), issuer id $(key_issuer_label "${APPLE_API_ISSUER_ID:-}"))"
        key_pem=""
        ASC_AUTH_FAILURE="credential"
      elif [[ "$rc" -ne 0 ]]; then
        #  The validator itself failed (a crash, a missing node):  it never
        #  classified the credential, so this run must not classify it
        #  either.  Calling it a bad credential would send the owner to
        #  re-export a key that is perfectly fine.
        log "could not check APPLE_API_KEY_P8_BASE64; the key validator failed with status ${rc}"
        key_pem=""
        ASC_AUTH_FAILURE="writer"
      else
        kid="$APPLE_API_KEY_ID"
        iss="$APPLE_API_ISSUER_ID"
        key_src="APPLE_API_KEY_P8_BASE64"
      fi
    else
      #  The value did not decode at all, so it failed local validation
      #  before it could be looked at:  it is named by its source, its key
      #  id and its issuer id, and by nothing taken out of the key.
      logerr "APPLE_API_KEY_P8_BASE64 did not decode to a PEM private key; ignoring it (source APPLE_API_KEY_P8_BASE64, key id $(key_label "${APPLE_API_KEY_ID:-}"), issuer id $(key_issuer_label "${APPLE_API_ISSUER_ID:-}"))"
      #  Same class as the validate refusal above:  a credential that was
      #  resolved and cannot be used.
      ASC_AUTH_FAILURE="credential"
    fi
    if [[ -z "$key_pem" ]]; then
      #  An unusable source is removed from the environment.  The client looks
      #  for these names first, so leaving them behind would have it resolve a
      #  broken credential instead of the one this shell layer resolved.
      unset APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_KEY_P8_BASE64
    fi
  fi

  # 2. An ambient ASC_KEY_P8.  It is only usable when it really is a PEM
  #    private key and comes with the key id and issuer it belongs to.
  if [[ -z "$key_pem" && -n "${ASC_KEY_P8:-}" ]]; then
    if [[ -z "$kid" || -z "$iss" ]]; then
      #  A credential without the id and issuer it belongs to is unusable
      #  here, so it failed local validation:  it is named by its source and
      #  by its public labels, and by nothing taken out of the key.
      log "ASC_KEY_P8 is set without ASC_KEY_ID and ASC_ISSUER_ID; ignoring it (source ASC_KEY_P8, key id $(key_label "$kid"), issuer id $(key_issuer_label "$iss"))"
      unset ASC_KEY_P8
    else
      rc=0
      node "${FLEET_DIR}/asc-key.mjs" validate >/dev/null 2>&1 <<< "$ASC_KEY_P8" || rc=$?
      if [[ "$rc" -eq 3 ]]; then
        #  The credential failed local validation:  it is named by its
        #  source, its key id and its issuer id, and by nothing taken out of
        #  the key.
        log "ASC_KEY_P8 is set but does not hold a PEM private key; ignoring it (source ASC_KEY_P8, key id $(key_label "$kid"), issuer id $(key_issuer_label "$iss"))"
        #  The client would refuse this value, so it is removed from the
        #  environment:  the client has to see the credential this shell layer
        #  resolved, not one that cannot be used.
        unset ASC_KEY_P8
        #  Resolved and then rejected, so it is a credential failure and not a
        #  missing key.
        ASC_AUTH_FAILURE="credential"
      elif [[ "$rc" -ne 0 ]]; then
        #  The validator itself failed (a crash, a missing node):  it never
        #  classified the credential, so this run must not classify it
        #  either.  Calling it a bad credential would send the owner to
        #  re-export a key that is perfectly fine.
        log "could not check ASC_KEY_P8; the key validator failed with status ${rc}"
        unset ASC_KEY_P8
        ASC_AUTH_FAILURE="writer"
      else
        key_pem="$ASC_KEY_P8"
        key_src="ASC_KEY_P8"
        #  A usable credential was found, so an earlier rejection of another
        #  source no longer describes this run.
        ASC_AUTH_FAILURE=""
      fi
    fi
  fi

  # 3. The Mac: Infisical Fleet-OPS through fleet-secrets.  Nothing is read
  #    from the old secrets folder (AFC-359) and nothing is read from a named
  #    path (AFC-459).
  if [[ -z "$key_pem" ]]; then
    asc_kid="$(fs_get ASC_KEY_ID /asc 2>/dev/null || true)"
    [[ -n "$kid" ]] || kid="$asc_kid"
    [[ -n "$iss" ]] || iss="$(fs_get ASC_ISSUER_ID /asc)" || iss=""
    if [[ -z "$kid" || -z "$iss" ]]; then
      log "ASC credentials missing: set ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_P8 in the environment, or add ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 to Infisical /asc"
      return 0
    fi
    # /asc holds one key.  A key id from the environment that differs from it
    # has no Infisical copy:  fail with a clear message rather than guess.
    if [[ "$kid" == "$asc_kid" ]]; then
      key_pem="$(fs_get ASC_KEY_P8 /asc)" || key_pem=""
      key_src="Infisical /asc"
    fi
    if [[ -z "$key_pem" ]]; then
      log "no .p8 for key ${kid}: Infisical /asc ASC_KEY_P8 holds a different key (or is unreadable);  export ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 for this key"
      return 0
    fi
    #  A usable credential was found, so an earlier rejection of another
    #  source no longer describes this run.
    ASC_AUTH_FAILURE=""
  fi

  # The key has to be in a mode-600 file for altool and Xcode, and in the
  # environment for the node client, which never reads a file.  The file is
  # written FROM the resolved credential, so it is never read back as one.
  asc_tmp_dir || {
    # The credential was resolved and the directory it has to be staged in
    # could not be created.  That is a path failure and not a crash.
    log "could not stage the ASC key; the credential was resolved and the staging directory could not be created"
    ASC_AUTH_FAILURE="staging"
    key_pem=""
    return 0
  }
  key_path="${ASC_TMP_DIR}/AuthKey_${kid}.p8"
  #  The writer says WHICH failure it was through its exit code:  3 is a value
  #  the Apple tools cannot use, 2 is a path or a file that could not be used.
  #  The two are reported differently, so the code is kept rather than folded
  #  into "something went wrong".
  #
  #  Only the exit code is read.  The helper's own message is never captured
  #  into a shell variable, because the repo's key-capture guard refuses a
  #  `$( ... )` that mentions asc-key.mjs, and a captured message could carry
  #  the key into a trace.
  rc=0
  node "${FLEET_DIR}/asc-key.mjs" write "$key_path" <<< "$key_pem" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    # Leaving AUTH_MODE as none is correct in every case, and calling any of
    # them a missing key is not.
    if [[ "$rc" -eq 3 ]]; then
      # The credential was resolved and it is not a usable PEM private key.
      # It is named by its source, by its key id and by its issuer id -- both
      # public labels that travel in every request header and are not part of
      # the key -- and by NOTHING taken from the key itself:  every byte of a
      # private-key body is secret, so there is no fragment of it that may be
      # shown.
      log "could not stage the ASC key; the credential was resolved but it is not a usable PEM private key (source ${key_src:-unknown}, key id $(key_label "$kid"), issuer id $(key_issuer_label "$iss"))"
      ASC_AUTH_FAILURE="credential"
    elif [[ "$rc" -eq 2 ]]; then
      # The credential was resolved.  The staging path was refused.
      log "could not stage the ASC key; the credential was resolved and the staging path was refused"
      ASC_AUTH_FAILURE="staging"
    else
      # The writer itself failed:  a crash, a missing node, a signal.  It
      # classified neither the key nor the path, so this must not be reported
      # as either one.
      log "could not stage the ASC key; the key writer failed with status ${rc}"
      ASC_AUTH_FAILURE="writer"
    fi
    key_pem=""
    return 0
  fi
  # altool searches API_PRIVATE_KEYS_DIR first, so no symlink into ~/.appstoreconnect is needed.
  export API_PRIVATE_KEYS_DIR="$ASC_TMP_DIR"
  export ASC_KEY_ID="$kid" ASC_ISSUER_ID="$iss" ASC_KEY_P8="$key_pem"
  # The staged path is a materialisation for the Apple tools, not a credential
  # source:  the client takes the key from the environment.
  export ASC_KEY_PATH="$key_path"
  key_pem=""
  if [[ -n "$named_path" && "$named_path" != "$key_path" ]]; then
    log "ASC_KEY_PATH is not a credential source; the credential came from the environment or from Infisical"
  fi
  AUTH_MODE="api_key"
  return 0
}

# The App Store Connect client.  It runs under $ASC_NODE (see the PATH seam at
# the top), so an offline test can answer the ASC queries from a stub.
asc_client() {
  "$ASC_NODE" "${FLEET_DIR}/asc-api.mjs" "$@"
}

# Is an ASC credential obtainable AT ALL? load_secrets() has not run yet when
# the version queries below run, so this cannot rely on the exported ASC_*
# names -- it checks each source asc-api.mjs knows about.
asc_credential_available() {
  [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER_ID:-}" && -n "${APPLE_API_KEY_P8_BASE64:-}" ]] && return 0
  [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${ASC_KEY_P8:-}" ]] && return 0
  [[ -x "$FLEET_SECRETS_BIN" ]] && return 0
  command -v fleet-secrets >/dev/null 2>&1 && return 0
  return 1
}

# Map ship APP_KEY to Sentry project slug in org simple-with-us.
sentry_project_for_app() {
  case "${APP_KEY}" in
    socratic) echo "socratic-trade" ;;
    congress) echo "congress-trade" ;;
    usage|usage-local) echo "usage-monitor" ;;
    dealdex) echo "dealdex" ;;
    autorotate|autorotate-mac) echo "autorotate" ;;
    contactlogo|contactlogo-mac) echo "contactlogo" ;;
    botfleet|botfleet-mac) echo "botfleet" ;;
    codecaps|codecaps-mac) echo "codecaps" ;;
    hoghunter) echo "hoghunter" ;;
    fleetlink) echo "fleetlink" ;;
    *) echo "" ;;
  esac
}

# Pull SENTRY_AUTH_TOKEN from the environment, else from `fleet-secrets get`
# when that helper is installed (Mac).  Extract into a var, never echo.
load_sentry_auth() {
  if [[ -n "${SENTRY_AUTH_TOKEN:-}" ]]; then
    return 0
  fi
  if command -v fleet-secrets &>/dev/null; then
    local token
    token="$(fleet-secrets get SENTRY_AUTH_TOKEN 2>/dev/null | tr -d '\r')" || token=""
    if [[ -n "$token" ]]; then
      SENTRY_AUTH_TOKEN="$token"
      export SENTRY_AUTH_TOKEN
    fi
  fi
}

# Strip anything token-shaped from sentry-cli output before it reaches a
# (public) CI log: the live token value, sntrys_/sntryu_ tokens, bearer headers.
sentry_redact() {
  local tok="${SENTRY_AUTH_TOKEN:-}"
  if [[ -n "$tok" ]]; then
    TOK="$tok" perl -pe 'BEGIN{$t=$ENV{TOK}} s/\Q$t\E/[redacted]/g; s/sntry[su]_[A-Za-z0-9+\/=_.-]+/[redacted]/g; s/(Bearer\s+)\S+/${1}[redacted]/gi'
  else
    perl -pe 's/sntry[su]_[A-Za-z0-9+\/=_.-]+/[redacted]/g; s/(Bearer\s+)\S+/${1}[redacted]/gi'
  fi
}

# After a successful archive: upload dSYMs and Size Analysis.  Never fail the
# TestFlight ship if Sentry is missing or the upload errors.
upload_sentry_artifacts() {
  local project archive sentry_org
  project="$(sentry_project_for_app)"
  archive="${ARCHIVE_PATH:-}"
  # Org that owns the botfleet project (verified 2026-10-09: only org
  # simple-with-us lists project botfleet; a token scoped to the retired
  # slug jays-services fails with "organization not found").  Overridable
  # via the environment so a rotation can be tried without editing this file.
  sentry_org="${SENTRY_ORG:-simple-with-us}"
  if [[ -z "$project" ]]; then
    log "sentry: no project mapping for app=${APP_KEY}; skipping artifact upload"
    return 0
  fi
  if [[ -z "$archive" || ! -d "$archive" ]]; then
    log "sentry: archive missing; skipping artifact upload"
    return 0
  fi
  load_sentry_auth
  if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
    log "sentry: SENTRY_AUTH_TOKEN unset; skipping dSYM / Size Analysis upload"
    return 0
  fi
  if ! command -v sentry-cli >/dev/null 2>&1; then
    log "sentry: sentry-cli not on PATH; trying official installer"
    if ! curl -sL https://sentry.io/get-cli/ | SENTRY_CLI_VERSION="" bash >/dev/null 2>&1; then
      log "warning: sentry-cli install failed; TestFlight ship continues"
      return 0
    fi
    export PATH="${HOME}/.sentry-cli:${PATH}:/opt/homebrew/bin"
  fi
  if ! command -v sentry-cli >/dev/null 2>&1; then
    log "warning: sentry-cli still missing; skipping artifact upload"
    return 0
  fi
  # Both uploads failed silently on 2026-10-07 (rc=1, logs left in the runner's
  # temp dir).  Print what sentry-cli says about auth/org first, and on any
  # failure print the tail of its log, with every token shape redacted, so
  # the hosted ship log carries the real error.
  log "sentry: sentry-cli $(sentry-cli --version 2>/dev/null | awk '{print $NF}'); org=${sentry_org} project=${project}"
  set +e
  SENTRY_ORG="$sentry_org" SENTRY_PROJECT="$project" sentry-cli info 2>&1 \
    | sentry_redact | sed 's/^/[ios-ship] sentry-info: /'
  set -e
  log "sentry: uploading debug files for project=${project} (token length ${#SENTRY_AUTH_TOKEN})"
  set +e
  SENTRY_ORG="$sentry_org" SENTRY_PROJECT="$project" \
    sentry-cli debug-files upload --include-sources "$archive" \
    >"${LOG_DIR}/sentry-debug-files.log" 2>&1
  local dif_rc=$?
  set -e
  if [[ $dif_rc -eq 0 ]]; then
    log "sentry: debug-files upload ok"
  else
    log "warning: sentry debug-files upload rc=${dif_rc}; tail of ${LOG_DIR}/sentry-debug-files.log:"
    tail -n 25 "${LOG_DIR}/sentry-debug-files.log" | sentry_redact | sed 's/^/[ios-ship]   sentry-dif: /'
    sentry_org_mismatch_hint "${LOG_DIR}/sentry-debug-files.log" "$sentry_org"
  fi
  log "sentry: Size Analysis build upload for project=${project}"
  set +e
  SENTRY_ORG="$sentry_org" SENTRY_PROJECT="$project" \
    sentry-cli build upload "$archive" \
    >"${LOG_DIR}/sentry-build-upload.log" 2>&1
  local build_rc=$?
  set -e
  if [[ $build_rc -eq 0 ]]; then
    log "sentry: build upload ok"
  else
    log "warning: sentry build upload rc=${build_rc}; tail of ${LOG_DIR}/sentry-build-upload.log:"
    tail -n 25 "${LOG_DIR}/sentry-build-upload.log" | sentry_redact | sed 's/^/[ios-ship]   sentry-build: /'
    sentry_org_mismatch_hint "${LOG_DIR}/sentry-build-upload.log" "$sentry_org"
  fi
  return 0
}

# When an upload log shows the token's embedded org disagreeing with the
# configured org (2026-10-09: token scoped to retired slug jays-services vs
# org simple-with-us), say exactly what to rotate.  Reads the already-written
# log file and prints only fixed guidance -- never any secret value -- and
# never fails the ship.
sentry_org_mismatch_hint() {
  local sentry_log="$1" hint_org="$2"
  if grep -q -E "organization not found|embedded in token" "$sentry_log" 2>/dev/null; then
    log "sentry: token/org mismatch -- SENTRY_AUTH_TOKEN is scoped to a different or retired org; mint an org token for ${hint_org} and update Infisical prod SENTRY_AUTH_TOKEN (owner approval required). TestFlight ship continues."
  fi
}

link_private_key() {
  # altool / iTMSTransporter look for AuthKey_<id>.p8 in standard dirs.  When
  # load_secrets wrote a temp key it also set API_PRIVATE_KEYS_DIR, so there is
  # nothing to link (and a symlink to a deleted temp file would dangle).
  local key_path="$1" key_id="$2"
  if [[ -n "${ASC_TMP_DIR:-}" && "$key_path" == "${ASC_TMP_DIR}/"* ]]; then
    return 0
  fi
  local dest_dir="${HOME}/.appstoreconnect/private_keys"
  mkdir -p "$dest_dir"
  chmod 700 "$dest_dir"
  local dest="${dest_dir}/AuthKey_${key_id}.p8"
  if [[ -L "$dest" && ! -e "$dest" ]]; then
    rm -f "$dest"
  fi
  if [[ ! -e "$dest" ]]; then
    ln -sf "$key_path" "$dest"
  fi
  chmod 600 "$key_path" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# THE VERSION NUMBERS (owner directive 2026-10-24, AFC-517)
# ---------------------------------------------------------------------------
# The rule itself is in the header comment above; this is where it is applied.
# The readable, unit-tested copy of it is scripts/ios-fleet/version-plan.mjs.
#
# The commit count is the base for CFBundleVersion:
#   - it names the EXACT commit a build came from, so a TestFlight or Sparkle
#     build can be traced to source without a second lookup
#   - it is monotonic by construction, so it can never regress
#   - it is raised above the App Store Connect floor when it has to be (a
#     shallow checkout understates the count, and the retired UTC stamps are
#     still higher than a fresh commit count)
#
# MARKETING_VERSION (CFBundleShortVersionString) is <prefix>.<P+1>:
#   <prefix> is the train from marketingVersionDefault, and P is the highest
#   patch App Store Connect already holds on that train (App Store versions
#   AND TestFlight trains, drift trains ignored).  The marketing version is
#   the next patch, so it never collides with an existing one.
#
# CURRENT_PROJECT_VERSION (CFBundleVersion) is the repo commit count, raised
# above the floor of the TARGET train:  every build already in that train (an
# old 12-digit UTC stamp included) plus the app's plain-integer builds below
# 1000000000 (EVERY build of any size on macOS, where build numbers have to
# grow across trains).
#
# The two numbers are independent.  The build number is NEVER derived from
# the marketing version, and the marketing version is never derived from the
# build number:  that is what stopped App Store Connect from showing
# "1.0.2358 (2358)".
#
# App Store Connect is the only record that shipping advances, so it is the
# only record that can answer "which patches does this train hold?" and
# "which build numbers are taken?".  The local build-seq counter
# (~/.cache/ios-fleet/build-seq-<app>.txt) and the MARKETING_VERSION in
# project.pbxproj are NOT sources any more:  the counter is never written,
# and the project file is only read to print the agreement NOTICE.

# Highest N in MARKETING_VERSION = <prefix>.N across the project's build
# configurations. 0 when the file is unreadable or holds no on-train value.
#
# NOT A SEQUENCING INPUT.  project.pbxproj does not feed the marketing
# version or the build number any more (AFC-517); this only backs the
# agreement NOTICE below, so a stale value in the project file is visible
# instead of silently steering a ship.
project_marketing_seq() {
  local proj_file="$1" prefix="$2" quiet="${3:-}" best=0 v n off_train=""
  if [[ ! -f "$proj_file" ]]; then
    printf '0'
    return 0
  fi
  while IFS= read -r v; do
    [[ -n "$v" ]] || continue
    n="${v#${prefix}.}"
    if [[ "$n" =~ ^[0-9]+$ && "$n" != "$v" ]]; then
      [[ "$n" -gt "$best" ]] && best="$n"
    else
      off_train="$v"
    fi
  done < <(grep -o 'MARKETING_VERSION = [^;]*;' "$proj_file" \
             | sed 's/MARKETING_VERSION = //; s/;$//' | sort -u)
  if [[ -n "$off_train" && -z "$quiet" ]]; then
    logerr "WARNING: project.pbxproj has MARKETING_VERSION=${off_train}, which is not on the ${prefix}.N train."
    logerr "WARNING: that value is ignored for sequencing. If you meant to start a new train,"
    logerr "WARNING: update marketingVersionDefault for '${APP_KEY}' in ${APPS_JSON}."
  fi
  printf '%s' "$best"
}

# Highest patch already used on the <prefix>.N train in App Store Connect:  the
# App Store versions AND the TestFlight trains, drift trains ignored.
# Returns 1 (and prints nothing) when ASC cannot be consulted:  the caller
# must distinguish "no versions yet" (0) from "unknown" (failure).
asc_next_dotted_build() {
  local version="$1" plat="${2:-}" out rc
  command -v "$ASC_NODE" >/dev/null 2>&1 || return 1
  # Not load_secrets: both helpers run inside command substitutions, where a
  # secrets temp dir and its EXIT trap die with the subshell and leave the
  # key behind.  asc-api.mjs resolves its own credential.
  asc_credential_available || return 1
  set +e
  out=$(asc_client next-dotted-build "$BUNDLE_ID" "$version" "$plat" "${APPLE_ID:-}")
  rc=$?
  set -e
  [[ $rc -eq 0 && "$out" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$out"
}

asc_released_store_version() {
  local plat="${1:-}" out rc
  command -v "$ASC_NODE" >/dev/null 2>&1 || return 1
  # Not load_secrets: both helpers run inside command substitutions, where a
  # secrets temp dir and its EXIT trap die with the subshell and leave the
  # key behind.  asc-api.mjs resolves its own credential.
  asc_credential_available || return 1
  # Keep the client's stderr: it carries the reason (HTTP status, unknown
  # state).  Only the labelled lines are logged, never key material, and an
  # auth failure keeps its own status 4.
  local errf errf_root
  errf_root="$(asc_temp_root)" || {
    logerr "asc-released: TMPDIR resolves to the filesystem root; refusing to write there"
    return 1
  }
  errf="$(mktemp "${errf_root}/asc-released-err.XXXXXX")"
  set +e
  out=$(asc_client released-store-version "$BUNDLE_ID" "$plat" "${APPLE_ID:-}" 2>"$errf")
  rc=$?
  set -e
  if [[ -s "$errf" ]]; then
    while IFS= read -r _pl; do
      case "$_pl" in asc-auth:*|released-store-version:*) logerr "asc-released: ${_pl}" ;; esac
    done <"$errf"
  fi
  rm -f "$errf" >/dev/null 2>&1 || true
  [[ $rc -eq 4 ]] && return 4
  [[ $rc -eq 0 ]] || return 1
  printf '%s' "$out"
}

asc_latest_marketing_patch() {
  local prefix="$1" plat="${2:-}" out rc errf
  if ! command -v "$ASC_NODE" >/dev/null 2>&1; then
    logerr "asc-patch: node not on PATH; cannot verify against App Store Connect"
    return 1
  fi
  if ! asc_credential_available; then
    logerr "asc-patch: no App Store Connect credential available; cannot verify against App Store Connect"
    return 1
  fi
  # DO NOT discard asc-api.mjs's stderr. It used to be piped to /dev/null,
  # which threw away the one line that says WHY -- "apps query failed (HTTP
  # 401)" -- and turned every auth or app-resolution fault into the same
  # contentless "query failed (rc=2)". Surfaced here so an UNVERIFIED plan is
  # self-diagnosing in the run log.
  #  asc_temp_root refuses the filesystem root with a status, so the status
  #  is read here:  expanding its empty output would build "/asc-patch-err.*".
  local errf_root
  errf_root="$(asc_temp_root)" || {
    logerr "asc-patch: TMPDIR resolves to the filesystem root; refusing to write there, so App Store Connect cannot be verified"
    return 1
  }
  errf="$(mktemp "${errf_root}/asc-patch-err.XXXXXX")"
  set +e
  out=$(asc_client latest-marketing-patch "$BUNDLE_ID" "$prefix" "$plat" "${APPLE_ID:-}" 2>"$errf")
  rc=$?
  if [[ $rc -eq 4 ]]; then
    set -e
    logerr "asc-patch: App Store Connect rejected the credential (HTTP 401/403)"
    # Forward the client's own lines first:  they carry Apple's status and code,
    # and the asc-auth line names WHICH credential source was used (env or
    # Infisical) and the key id length -- never any key material.
    if [[ -s "$errf" ]]; then
      while IFS= read -r _pl; do
        case "$_pl" in asc-auth:*|latest-marketing-patch:*|latest-build-seq:*) logerr "asc-patch: ${_pl}" ;; esac
      done <"$errf"
    fi
    rm -f "$errf" >/dev/null 2>&1 || true
    return 4
  fi
  set -e
  if [[ -s "$errf" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && logerr "asc-patch: ${line}"
    done < "$errf"
  fi
  # Discard stdout as well as stderr: anything printed here would land in the
  # command substitution that captures this function's value and corrupt the
  # patch number. (A `rm` wrapper that reports what it removed on stdout is
  # enough to turn a correct 74 into an arithmetic error.)
  rm -f "$errf" >/dev/null 2>&1 || true
  if [[ $rc -ne 0 || ! "$out" =~ ^[0-9]+$ ]]; then
    logerr "asc-patch: query failed (rc=${rc}); cannot verify against App Store Connect"
    return 1
  fi
  printf '%s' "$out"
}

# The build number the next ship has to exceed, and the two floors it is made
# of:  every build already in the target train (train floor) and the app's
# plain-integer builds below 1000000000 (app floor;  on macOS every build of
# any size counts, because macOS build numbers grow across trains).
#
# Prints "<floor> <train_floor> <app_floor>".  Returns 1 (and prints nothing)
# when ASC cannot be consulted.
asc_build_floor() {
  local version="$1" plat="${2:-}" out rc errf err train app
  if ! command -v "$ASC_NODE" >/dev/null 2>&1; then
    logerr "asc-floor: node not on PATH; cannot verify against App Store Connect"
    return 1
  fi
  if ! asc_credential_available; then
    logerr "asc-floor: no App Store Connect credential available; cannot verify against App Store Connect"
    return 1
  fi
  #  Read asc_temp_root's refusal here too:  a root TMPDIR would otherwise
  #  build "/asc-floor-err.*".
  local errf_root
  errf_root="$(asc_temp_root)" || {
    logerr "asc-floor: TMPDIR resolves to the filesystem root; refusing to write there, so App Store Connect cannot be verified"
    return 1
  }
  errf="$(mktemp "${errf_root}/asc-floor-err.XXXXXX")"
  set +e
  out=$(asc_client build-floor "$BUNDLE_ID" "$version" "$plat" "${APPLE_ID:-}" 2>"$errf")
  rc=$?
  if [[ $rc -eq 4 ]]; then
    set -e
    logerr "asc-floor: App Store Connect rejected the credential (HTTP 401/403)"
    # Keep the client's build-floor lines:  they carry Apple's HTTP status.
    # Only this path forwards them here;  every other path forwards the
    # whole client output once, below.
    if [[ -s "$errf" ]]; then
      while IFS= read -r _fl; do
        case "$_fl" in asc-auth:*|build-floor:*|latest-build-seq:*) logerr "asc-floor: ${_fl}" ;; esac
      done <"$errf"
    fi
    rm -f "$errf" >/dev/null 2>&1 || true
    return 4
  fi
  set -e
  err="$(cat "$errf" 2>/dev/null || true)"
  if [[ -s "$errf" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && logerr "asc-floor: ${line}"
    done < "$errf"
  fi
  rm -f "$errf" >/dev/null 2>&1 || true
  if [[ $rc -ne 0 || ! "$out" =~ ^[0-9]+$ ]]; then
    logerr "asc-floor: query failed (rc=${rc}); cannot verify against App Store Connect"
    return 1
  fi
  # asc-api.mjs notes the two floors on stderr ("build-floor: train=N app=N
  # -> floor=N");  the note is machine-readable, so the version-plan log line
  # can name where the build number came from.
  train="$(printf '%s\n' "$err" | sed -n 's/.*[^a-z]train=\([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  app="$(printf '%s\n' "$err" | sed -n 's/.*[^a-z]app=\([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  printf '%s %s %s' "$out" "${train:-$out}" "${app:-$out}"
}

# The major.minor train a marketing version belongs to: "2.0.123" -> "2.0",
# "3" -> "3.0".  The floor is per-train, so the train has to come from the
# version actually being shipped rather than always from the default.
version_prefix() {
  printf '%s' "${1:-1.0}" | awk -F. '{ if (NF >= 2) print $1"."$2; else print $1".0" }'
}

marketing_prefix() {
  # "1.0" from marketingVersionDefault (1.0 or 1.0.x both yield 1.0).
  version_prefix "${DEFAULT_MARKETING:-1.0}"
}

ship_state_path() {
  echo "${STATE_DIR}/last-ship-${APP_KEY}.txt"
}

repo_head_sha() {
  git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown"
}

# Decide whether this run may upload: rate limit + "no new commits since the
# last successful ship". Does not apply to --export-only (local IPA only) or
# --force-ship.
#
# This function DECIDES and LOGS; it does not exit. That separation is the fix
# for the ordering bug observed live on 2026-08-12: the gate used to be
# evaluated after the build counter had already committed floor+1 to it, so a
# rate-limited attempt still burned a build number. The sequence advanced
# 5 -> 6 while the run skipped, leaving 1.0.6 existing nowhere and the local
# counter drifting further from App Store Connect. The caller now evaluates the
# gate BEFORE any version is resolved, so a skipped run consumes nothing.
#
# Sets SHIP_GATE_DECISION to "proceed" or "skip".
SHIP_GATE_DECISION="proceed"
evaluate_ship_gate() {
  SHIP_GATE_DECISION="proceed"
  if [[ "$FORCE_SHIP" -eq 1 ]]; then
    log "force-ship: bypassing min-interval / same-HEAD gate"
    return 0
  fi
  if [[ "$EXPORT_ONLY" -eq 1 ]]; then
    return 0
  fi

  local min_sec min_src path last_ts last_sha now elapsed head_sha
  # Report which source the number came from, so the log answers "why did this
  # not ship" without anyone reading the script. Non-numeric / empty -> default,
  # and say so rather than crediting the env var for a value it did not supply.
  if [[ -n "${IOS_TF_MIN_INTERVAL_SEC:-}" && "${IOS_TF_MIN_INTERVAL_SEC}" =~ ^[0-9]+$ ]]; then
    min_sec="$IOS_TF_MIN_INTERVAL_SEC"
    min_src="IOS_TF_MIN_INTERVAL_SEC"
  else
    min_sec="$DEFAULT_MIN_INTERVAL_SEC"
    min_src="DEFAULT_MIN_INTERVAL_SEC in $(basename "$0")"
    if [[ -n "${IOS_TF_MIN_INTERVAL_SEC:-}" ]]; then
      log "ship-gate: IOS_TF_MIN_INTERVAL_SEC is not a number; using the default"
    fi
  fi
  path="$(ship_state_path)"
  head_sha="$(repo_head_sha)"
  now="$(date +%s)"

  if [[ ! -f "$path" ]]; then
    log "ship-gate: no prior ship for ${APP_KEY}; proceeding"
    return 0
  fi

  # Format: "<unix_ts> <git_sha>"
  read -r last_ts last_sha <"$path" || true
  if ! [[ "${last_ts:-}" =~ ^[0-9]+$ ]]; then
    log "ship-gate: bad state file; proceeding"
    return 0
  fi

  if [[ -n "${last_sha:-}" && "$last_sha" != "unknown" && "$head_sha" == "$last_sha" ]]; then
    log "ship-gate: skip — HEAD ${head_sha:0:10} already shipped for ${APP_KEY} (no new commits)"
    log "ship-gate: use --force-ship to upload the same HEAD again"
    SHIP_GATE_DECISION="skip"
    return 0
  fi

  elapsed=$((now - last_ts))
  if [[ "$elapsed" -lt "$min_sec" ]]; then
    local remain=$((min_sec - elapsed))
    local remain_m=$(( (remain + 59) / 60 ))
    local min_m=$(( min_sec / 60 ))
    log "ship-gate: skip — last ${APP_KEY} ship ${elapsed}s ago; min interval ${min_sec}s (~${remain_m}m left)"
    log "ship-gate: that ${min_sec}s (${min_m}m) limit comes from ${min_src}."
    log "ship-gate: it is THE throttle on automatic shipping — .github/workflows/ios-ship.yml"
    log "ship-gate: runs on every push to main touching clients/ios/**, and most runs skip here."
    log "ship-gate: override this run with IOS_TF_MIN_INTERVAL_SEC=<seconds> or --force-ship;"
    log "ship-gate: change the standing limit by editing DEFAULT_MIN_INTERVAL_SEC (owner's call)."
    SHIP_GATE_DECISION="skip"
    return 0
  fi

  log "ship-gate: ok — ${elapsed}s since last ship (min ${min_sec}s from ${min_src}); HEAD ${head_sha:0:10}"
}

# "<marketing> <build>" from an IPA's Info.plist, only when its bundle id is the
# expected one.  Fails (prints nothing) on anything else.  Never guesses.
ipa_manifest_versions() {
  local ipa="$1" want="$2"
  [[ -f "$ipa" && -n "$want" ]] || return 1
  python3 - "$ipa" "$want" <<'PY'
import plistlib, re, sys, zipfile
ipa, want = sys.argv[1:3]
try:
    z = zipfile.ZipFile(ipa)
    names = [n for n in z.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", n)]
    if len(names) != 1:
        sys.exit(1)
    info = plistlib.loads(z.read(names[0]))
except Exception:
    sys.exit(1)
ver, build, bid = info.get("CFBundleShortVersionString"), info.get("CFBundleVersion"), info.get("CFBundleIdentifier")
if bid != want or not ver or not build or re.search(r"\s", ver + build):
    sys.exit(1)
print(ver, build)
PY
}

record_successful_ship() {
  local path head_sha now
  path="$(ship_state_path)"
  head_sha="$(repo_head_sha)"
  now="$(date +%s)"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  printf '%s %s\n' "$now" "$head_sha" >"$path"
  chmod 600 "$path" 2>/dev/null || true
  log "ship-gate: recorded success ts=${now} sha=${head_sha:0:10} -> ${path}"
  # Public version manifest for the in-app update prompt.  Best-effort —
  # a publish miss must never fail a ship that already uploaded.
  # --upload-only reuses an IPA whose versions this run never read, so
  # MARKETING and BUILD_NUM hold a placeholder.  The placeholder must never
  # reach the manifest:  read the real versions out of the IPA's Info.plist,
  # and skip the publish when that cannot be done or names another app.
  if [[ "${MARKETING:-}" == "(from IPA)" || "${BUILD_NUM:-}" == "(from IPA)" ]]; then
    local ipa_ver
    if [[ -n "${UPLOAD_ONLY_IPA:-}" ]] && ipa_ver="$(ipa_manifest_versions "$UPLOAD_ONLY_IPA" "${BUNDLE_ID:-}")" && [[ -n "$ipa_ver" ]]; then
      MARKETING="${ipa_ver%% *}"
      BUILD_NUM="${ipa_ver#* }"
      log "version-manifest: --upload-only versions read from the IPA (${MARKETING} build ${BUILD_NUM})"
    else
      MARKETING=""
      BUILD_NUM=""
      log "version-manifest: skipped (--upload-only and the IPA's versions could not be read for ${BUNDLE_ID:-?})"
    fi
  fi
  if [[ -n "${BUNDLE_ID:-}" && -n "${MARKETING:-}" ]]; then
    local apple_id display pub_out pr_url
    local -a pub_args
    apple_id="$(json_get "$APP_KEY" appleId || true)"
    display="$(json_get "$APP_KEY" displayName || true)"
    pub_args=(--bundle-id "$BUNDLE_ID" --version "$MARKETING")
    [[ -n "${BUILD_NUM:-}" ]] && pub_args+=(--build "$BUILD_NUM")
    [[ -n "${apple_id:-}" ]] && pub_args+=(--apple-id "$apple_id")
    [[ -n "${display:-}" ]] && pub_args+=(--display-name "$display")
    # The publisher opens a pull request against AI-Fleet-Coordinator, so its
    # result is a pull request URL, not a silent write.  The URL is logged,
    # so a ship leaves a reviewable trace instead of one warning line.
    if pub_out="$(bash "${FLEET_DIR}/publish-ios-versions.sh" "${pub_args[@]}" 2>&1)"; then
      # `|| true` keeps the no-URL case (the publisher's no-op path) from
      # tripping `set -e` through pipefail:  a ship that already uploaded must
      # never die on a missing pull request URL.
      pr_url="$(printf '%s\n' "$pub_out" | grep -Eo 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | head -1 || true)"
      if [[ -n "$pr_url" ]]; then
        log "version-manifest: opened ${pr_url}"
      else
        log "version-manifest: ${BUNDLE_ID} ${MARKETING} recorded (${pub_out%%$'\n'*})"
      fi
    else
      log "warning: version-manifest publish failed (non-fatal)"
      printf '%s\n' "$pub_out" | sed 's/^/  /' >&2
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --build) FORCE_BUILD="$2"; shift 2 ;;
    --version) FORCE_VERSION="$2"; shift 2 ;;
    --export-only) EXPORT_ONLY=1; shift ;;
    --upload-only) UPLOAD_ONLY_IPA="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-xcodegen) SKIP_XCODEGEN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --force-ship) FORCE_SHIP=1; shift ;;
    --allow-unverified-seq) ALLOW_UNVERIFIED_SEQ=1; shift ;;
    --sync-project-version) SYNC_PROJECT_VERSION=1; shift ;;
    -h|--help) usage ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *)
      if [[ -z "$APP_KEY" ]]; then
        APP_KEY="$1"; shift
      else
        die "unexpected arg: $1"
      fi
      ;;
  esac
done

[[ -n "$APP_KEY" ]] || die "app key required (e.g. socratic, congress, usage, usage-local, dealdex, autorotate, autorotate-mac, contactlogo, contactlogo-mac, botfleet, botfleet-mac)"
[[ -f "$APPS_JSON" ]] || die "missing apps registry: $APPS_JSON"

# Validate APP_KEY against apps.json before requiring Xcode tools so --help-adjacent
# and CI unit tests can reject unknown keys on Linux runners without xcodebuild.
_EARLY_BUNDLE="$(json_get "$APP_KEY" bundleId)"
_EARLY_SCHEME="$(json_get "$APP_KEY" scheme)"
_EARLY_PROJECT="$(json_get "$APP_KEY" projectRel)"
[[ -n "$_EARLY_BUNDLE" && -n "$_EARLY_SCHEME" && -n "$_EARLY_PROJECT" ]] || die "unknown app key or incomplete registry: $APP_KEY"

# Prefer stable Xcode.app over Xcode-beta for TestFlight / ASC compatibility.
# Beta toolchains + beta macOS stamp BuildMachineOSBuild that App Store review
# rejects as INVALID_BINARY even when TestFlight accepts the same IPA.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  elif [[ -d /Applications/Xcode-beta.app/Contents/Developer ]]; then
    echo "[ios-ship] warning: only Xcode-beta present; ASC Invalid Binary risk" >&2
    export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
  fi
fi
if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  echo "[ios-ship] DEVELOPER_DIR=${DEVELOPER_DIR}"
fi

need_cmd xcodebuild
need_cmd /usr/bin/python3

# Owner 2026-08-11: always use stable Xcode.app for archive/export/upload.
# Xcode-beta breaks TestFlight / App Store Connect tooling compatibility.
# Override only if DEVELOPER_DIR is already set to a non-beta path.
if [[ -z "${DEVELOPER_DIR:-}" || "$DEVELOPER_DIR" == *Xcode-beta* ]]; then
  if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  log "using DEVELOPER_DIR=${DEVELOPER_DIR}"
  xcodebuild -version || die "xcodebuild broken under DEVELOPER_DIR=${DEVELOPER_DIR}"
fi


if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(pwd)"
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

DISPLAY_NAME="$(json_get "$APP_KEY" displayName)"
BUNDLE_ID="$(json_get "$APP_KEY" bundleId)"
APPLE_ID="$(json_get "$APP_KEY" appleId || true)"
PLATFORM="$(json_get "$APP_KEY" platform)"
SCHEME="$(json_get "$APP_KEY" scheme)"
PROJECT_REL="$(json_get "$APP_KEY" projectRel)"
PROJECT_REL_ALT="$(json_get "$APP_KEY" projectRelAlt)"
XCODEGEN_DIR="$(json_get "$APP_KEY" xcodegenDir)"
DEFAULT_MARKETING="$(json_get "$APP_KEY" marketingVersionDefault)"
# Optional fixed-version policy (owner, 2026-10-26): the marketing version does
# not count up per TestFlight ship; the build is a dotted M.m.<n> (see
# asc-api.mjs next-dotted-build) that goes up inside the fixed train.  apps.json
# key: fixedMarketingVersion ("1.1.2").  Absent key keeps the next-patch
# behaviour.  Not used on macOS (builds must grow across all trains).
FIXED_MARKETING="$(json_get "$APP_KEY" fixedMarketingVersion)"

if [[ -z "$PLATFORM" ]]; then
  if [[ "$APP_KEY" == *-mac || "$SCHEME" == *[Mm]ac* ]]; then
    PLATFORM="macOS"
  else
    PLATFORM="iOS"
  fi
fi

[[ -n "$BUNDLE_ID" && -n "$SCHEME" && -n "$PROJECT_REL" ]] || die "unknown app key or incomplete registry: $APP_KEY"
if [[ "$BUNDLE_ID" == "me.grok.dealdex" ]]; then
  die "refusing to upload me.grok.dealdex"
fi
if [[ "$APP_KEY" == "dealdex" && "$BUNDLE_ID" != "net.dealdex" ]]; then
  die "DealDex live bundle is net.dealdex, not ${BUNDLE_ID}"
fi

# BotFleet ships only the ASC record app.botfleet.ios / appleId 6820175685.
# Legacy app.botfleet / 6806379515 must not receive uploads.
if [[ "$APP_KEY" == "botfleet" && "$BUNDLE_ID" == "app.botfleet" ]]; then
  die "refusing legacy BotFleet bundleId app.botfleet (appleId 6806379515); use app.botfleet.ios (6820175685)"
fi
if [[ "$APP_KEY" == "botfleet" && "$BUNDLE_ID" != "app.botfleet.ios" ]]; then
  die "BotFleet ASC app is app.botfleet.ios (appleId 6820175685); refusing bundleId=${BUNDLE_ID}"
fi

if [[ -z "$UPLOAD_ONLY_IPA" && "$DRY_RUN" -eq 0 ]]; then
  if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
    if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      die "not a git repo: $REPO_ROOT (pass --allow-dirty to override)"
    fi
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
      die "dirty worktree at $REPO_ROOT (commit first, or pass --allow-dirty)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# SHIP GATE FIRST, THEN THE BUILD NUMBER.
# ---------------------------------------------------------------------------
# Ordering matters and used to be wrong. The gate was evaluated ~60 lines below
# the point where the build counter committed floor+1, so every
# rate-limited attempt burned a version that never shipped (observed live
# 2026-08-12: skipped at 4392s of a 9000s interval, sequence still went 5 -> 6).
#
# Everything the gate needs is already resolved above: APP_KEY, REPO_ROOT (for
# HEAD), EXPORT_ONLY, FORCE_SHIP, STATE_DIR. Nothing between here and the old
# call site set up anything it reads, so moving it earlier drops no step. What
# it now runs BEFORE is: PBXPROJ resolution, the App Store Connect queries
# (the marketing patch and the build floor), the project-version agreement
# check, --sync-project-version, load_secrets, and the output dirs.  No
# number is consumed from a local cache any more:  App Store Connect is the
# only record that shipping advances.
# The dirty-worktree check stays ahead of the gate so a dirty tree still fails
# loudly rather than being masked by a quiet rate-limit skip.
#
# --force-ship and --export-only still bypass the gate exactly as before, and
# --dry-run still reports the gate outcome alongside the version plan (it peeks
# at the version without shipping it, so evaluating early changes nothing for
# it beyond ordering the log lines).
evaluate_ship_gate

# Capture the previously-shipped sha for the TestFlight release notes BEFORE
# anything can rewrite the state file. record_successful_ship() overwrites it
# after ensure_tf_ready, so reading it later happens to work today -- capturing
# it here makes the notes immune to a future reordering, which is exactly the
# class of bug the ship-gate comment above documents.
PREV_SHIP_SHA=""
if [[ -f "$(ship_state_path)" ]]; then
  read -r _prev_ts PREV_SHIP_SHA <"$(ship_state_path)" || true
  [[ "${PREV_SHIP_SHA:-}" != "unknown" ]] || PREV_SHIP_SHA=""
fi
# Which subtree is "this app's iOS code" -- used only as the tie-break when the
# commit range exceeds the release-notes bullet cap.
IOS_PATH_PREFIX="$(dirname "$PROJECT_REL")"

if [[ "$SHIP_GATE_DECISION" == "skip" && "$DRY_RUN" -eq 0 ]]; then
  log "ship-gate: exiting 0 before any build number is consumed (sequence untouched)"
  exit 0
fi

#  A root TMPDIR is a PATH failure, and it has to be classified as one before
#  any App Store Connect query runs.  The two version queries below write
#  their scratch files through asc_temp_root, so a root TMPDIR makes them
#  fail, and their failure is indistinguishable from an unreachable App Store
#  Connect:  the run would die telling the owner to fix ASC_* credentials for
#  what is a path refusal.  Classify it once, here, before the version plan,
#  and exit with the path-failure status.  The classification needs no
#  credential and no STAMP, so it can sit this early.
#  asc_temp_root refuses the filesystem root with a status.  Read it with
#  that status:  under errexit a bare assignment would end the run with
#  status 1 and no log line, before the owner handoff could classify it.
SHIP_TMP_ROOT="$(asc_temp_root)" || {
  log "Ship blocked: TMPDIR resolves to the filesystem root, so the staging path was refused."
  log "This is a path failure, not a missing key."
  exit 3
}

# Where the version the project itself declares lives. Best-effort: for
# XcodeGen apps the .xcodeproj may not exist until it is generated below, in
# which case the project contributes 0 to the floor and says so.
PBXPROJ=""
if _proj_dir="$(resolve_project "$REPO_ROOT" "$PROJECT_REL" "$PROJECT_REL_ALT" 2>/dev/null)"; then
  PBXPROJ="${_proj_dir}/project.pbxproj"
fi

MARKETING_PREFIX="$(marketing_prefix)"

# The App Store Connect platform key.  "macOS" in apps.json is MAC_OS there.
ASC_PLATFORM="IOS"
if [[ "$PLATFORM" == "macOS" ]]; then
  ASC_PLATFORM="MAC_OS"
fi

# What the version plan is built from.  Printed in the "version plan:" log
# line so the log answers "where did that build number come from?" without
# anyone reading the script.
PLAN_ASC_PATCH="n/a"
PLAN_TARGET_PATCH=""
PLAN_FLOOR="n/a"
PLAN_TRAIN_FLOOR="n/a"
PLAN_APP_FLOOR="n/a"
PLAN_COMMIT_COUNT="n/a"
FIXED_MODE=0
PLAN_READY=0

if [[ -n "$UPLOAD_ONLY_IPA" ]]; then
  # The IPA already carries the versions it was built with. Resolving -- let
  # alone consuming -- a version here would burn a marketing version on a run
  # that cannot possibly use it, which is the same defect as the gate-ordering
  # bug above. It would also drag in the App Store Connect queries' hard
  # failure when ASC is unreachable, blocking a legitimate retry of an
  # already-built IPA.
  MARKETING="(from IPA)"
  BUILD_NUM="(from IPA)"
  log "version: taken from the existing IPA (--upload-only); sequence neither consulted nor consumed"
else
  PLAN_READY=1

  # The repo commit count:  the build number names the exact commit a build
  # came from, so it is the starting point for CFBundleVersion.  It is not
  # enough on its own -- the App Store Connect floor below raises it when it
  # has to be -- but it is never invented:  a checkout with no readable git
  # history cannot be numbered at all.
  COMMIT_COUNT="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || true)"
  if [[ "$COMMIT_COUNT" =~ ^[0-9]+$ ]]; then
    PLAN_COMMIT_COUNT="$COMMIT_COUNT"
  fi

  # ---- the marketing version ---------------------------------------------
  # --version is an exact override.  Otherwise the version is the next patch
  # on the default train, and P comes from App Store Connect.
  FIXED_MODE=0
  if [[ -n "$FIXED_MARKETING" && ( -z "$FORCE_VERSION" || "$FORCE_VERSION" == "$FIXED_MARKETING" ) ]]; then
    [[ "$FIXED_MARKETING" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || die "fixedMarketingVersion '${FIXED_MARKETING}' for ${APP_KEY} in apps.json is not M.m.p (three dot-separated integers).  Nothing was shipped."
    if [[ "$(printf '%s' "${ASC_PLATFORM:-}" | tr a-z A-Z)" == "MAC_OS" ]]; then
      die "fixedMarketingVersion is not supported on macOS:  Mac builds must grow across every train, so a dotted build under a fixed version cannot be ordered safely.  Nothing was shipped."
    fi
    FORCE_VERSION="$FIXED_MARKETING"
    FIXED_MODE=1
    log "version: fixed marketing version ${FIXED_MARKETING} from apps.json; it does not count up per ship"
    # A released App Store version closes its train:  a fixed version at or
    # below one is refused, never silently bumped.
    _rel="$(asc_released_store_version "$ASC_PLATFORM")" \
      || die "cannot read the released App Store version for ${BUNDLE_ID}, so fixedMarketingVersion ${FIXED_MARKETING} cannot be checked against a closed train.  Nothing was shipped or bumped."
    if [[ -n "$_rel" ]]; then
      if ! python3 -c 'import sys
a=[int(x) for x in sys.argv[1].split(".")]; b=[int(x) for x in sys.argv[2].split(".")]
n=max(len(a),len(b)); a+= [0]*(n-len(a)); b+=[0]*(n-len(b))
sys.exit(0 if a>b else 1)' "$FIXED_MARKETING" "$_rel"; then
        die "fixedMarketingVersion ${FIXED_MARKETING} is at or below the released App Store version ${_rel}.  Apple requires each new version to be greater than the last released one.  Nothing was bumped.  Pick a version above ${_rel} in apps.json."
      fi
    fi
  fi
  if [[ -n "$FORCE_VERSION" ]]; then
    MARKETING="$FORCE_VERSION"
    # The patch the operator pinned, on its own train ("2.0.5" -> 5).
    _pinned="${FORCE_VERSION##*.}"
    if [[ "$_pinned" =~ ^[0-9]+$ ]]; then
      PLAN_ASC_PATCH="pinned"
      PLAN_TARGET_PATCH="$_pinned"
    fi
  else
    set +e
    _patch="$(asc_latest_marketing_patch "$MARKETING_PREFIX" "$ASC_PLATFORM")"
    _rc=$?
    if [[ $_rc -eq 4 ]]; then
      # The rejected credential is named by its key id and its issuer id:
      # both are public labels that travel in every request header, and
      # together they say exactly WHICH key App Store Connect refused.  No
      # part of the key is printed:  every byte of a private-key body is
      # secret, so there is no fragment of it that may be shown.
      asc_resolve_diagnostic_credential
      _rejected_key="$(key_label "$ASC_DIAG_KEY_ID")"
      _rejected_issuer="$(key_issuer_label "$ASC_DIAG_ISSUER_ID")"
      die "App Store Connect rejected the API key (HTTP 401/403) while reading the next marketing version (key id ${_rejected_key}, issuer id ${_rejected_issuer}).
  Fix the key (ASC_* in env or Infisical /asc; fleet-secrets doctor) and re-run.
  --allow-unverified-seq does not cover a rejected credential:  the upload would fail with it too."
    fi
    set -e
    if [[ $_rc -ne 0 || ! "$_patch" =~ ^[0-9]+$ ]]; then
      if [[ "$ALLOW_UNVERIFIED_SEQ" -eq 0 ]]; then
        die "cannot determine the next marketing version.
  App Store Connect could not be consulted.  The marketing version is the next
  patch on the ${MARKETING_PREFIX} train, and App Store Connect is the only
  record of which patches that train already holds:  guessing would ship a
  version that already exists (or skip one that does not).
  Fix one of these, then re-run:
    1) restore ASC access: check ASC_* in env or Infisical /asc (fleet-secrets doctor) and that 'node' is on PATH, then
       run: node ${FLEET_DIR}/asc-api.mjs latest-marketing-patch ${BUNDLE_ID} ${MARKETING_PREFIX} ${ASC_PLATFORM}
     2) or pin the version explicitly:  --version <X.Y.Z>
        --version is honoured exactly, so the marketing version no longer needs
        App Store Connect.  The build number is still automatic:  the repo
        commit count, raised above the floor of that train.
    3) or, only if you are certain, re-run with --allow-unverified-seq"
      fi
      logerr "WARNING: --allow-unverified-seq set; the marketing version is planned from an UNVERIFIED patch (P=0)"
      _patch=0
    fi
    PLAN_ASC_PATCH="$_patch"
    PLAN_TARGET_PATCH="$((_patch + 1))"
    MARKETING="${MARKETING_PREFIX}.${PLAN_TARGET_PATCH}"
  fi

  # ---- the build number ---------------------------------------------------
  if [[ -n "$FORCE_BUILD" ]]; then
    if [[ "$FIXED_MODE" -eq 1 && ! "$FORCE_BUILD" =~ ^${MARKETING%.*}\.[0-9]+$ ]]; then
      die "--build ${FORCE_BUILD} is not ${MARKETING%.*}.<n>:  in fixed-version mode the train holds only dotted builds of that shape, and a different one would block every later ship.  Pass --build ${MARKETING%.*}.<n> or leave --build off.  Nothing was shipped."
    fi
    # An explicit --build is honoured exactly, and it does NOT move the
    # marketing version:  the two numbers are independent.
    BUILD_NUM="$FORCE_BUILD"
    # An explicit --build is honoured exactly, but never as the retired
    # "1.0.N (N)" pair (AFC-517):  refuse rather than silently change it.
    # Compared as numbers, so "--build 0236" is caught for 1.0.236 too.
    if [[ -n "$PLAN_TARGET_PATCH" && "$BUILD_NUM" =~ ^[0-9]+$ ]] && (( 10#$BUILD_NUM == 10#$PLAN_TARGET_PATCH )); then
      die "--build ${BUILD_NUM} equals the patch of ${MARKETING}, which would ship ${MARKETING} (${BUILD_NUM}): the 1.0.N (N) form the owner retired (AFC-517).  Pass a different --build."
    fi
    log "version: operator override (--build/--version); the local build-seq counter is not consulted"
  elif [[ "$FIXED_MODE" -eq 1 ]]; then
    if [[ "$(printf '%s' "${ASC_PLATFORM:-}" | tr a-z A-Z)" == "MAC_OS" ]]; then
      die "fixedMarketingVersion is not supported on macOS:  Mac builds must grow across every train, so a dotted build under a fixed version cannot be ordered safely.  Nothing was shipped."
    fi
    # The build reads like the version it ships under (1.1.2 (1.1.2)) and goes
    # up inside the fixed train (1.1.3, 1.1.4, ...).  No floor, seed, count or
    # patch bump applies:  the train itself is the only record.
    BUILD_NUM="$(asc_next_dotted_build "$MARKETING" "$ASC_PLATFORM")" \
      || die "cannot work out the next dotted build for ${MARKETING}: App Store Connect could not be read, or the train holds a build that is not ${MARKETING%.*}.<n>.  Nothing was shipped or guessed."
    log "build: dotted build ${BUILD_NUM} for fixed version ${MARKETING}"
  else
    [[ "$PLAN_COMMIT_COUNT" =~ ^[0-9]+$ ]] || die "could not read the commit count from ${REPO_ROOT}; CFBundleVersion is the repo commit count and UTC timestamps are retired"

    # The floor:  every build already in the TARGET train, plus the app's own
    # plain-integer builds.  It is per-train, so it is read from the train
    # this run actually ships to -- reading 1.0's floor for a 2.0 ship is what
    # produced stale builds like "2.0 (build 202510190002)".
    set +e
    _floor_line="$(asc_build_floor "$MARKETING" "$ASC_PLATFORM")"
    _rc=$?
    if [[ $_rc -eq 4 ]]; then
      # The same public labels as the marketing-version rejection above:  the
      # key id and the issuer id, and nothing that came out of the key.
      asc_resolve_diagnostic_credential
      _rejected_key="$(key_label "$ASC_DIAG_KEY_ID")"
      _rejected_issuer="$(key_issuer_label "$ASC_DIAG_ISSUER_ID")"
      die "App Store Connect rejected the API key (HTTP 401/403) while reading the build floor (key id ${_rejected_key}, issuer id ${_rejected_issuer}).
  Fix the key (ASC_* in env or Infisical /asc; fleet-secrets doctor) and re-run.
  --allow-unverified-seq does not cover a rejected credential:  the upload would fail with it too."
    fi
    set -e
    if [[ $_rc -ne 0 || -z "$_floor_line" ]]; then
      if [[ "$ALLOW_UNVERIFIED_SEQ" -eq 0 ]]; then
        die "cannot determine the build floor for ${MARKETING}.
  App Store Connect could not be consulted.  The build number must be greater
  than every build already in that train and greater than the app's own
  builds, and App Store Connect is the only record of them:  a build number
  that is not greater is rejected as a duplicate.
  Fix one of these, then re-run:
    1) restore ASC access: check ASC_* in env or Infisical /asc (fleet-secrets doctor) and that 'node' is on PATH, then
       run: node ${FLEET_DIR}/asc-api.mjs build-floor ${BUNDLE_ID} ${MARKETING} ${ASC_PLATFORM}
     2) or pass the build number explicitly:  --build <N>
        --build is honoured exactly:  CFBundleVersion becomes N.  It must be
        greater than every build already in that train.  --build does NOT move
        the marketing version any more:  the two numbers are independent.
     3) or, only if you are certain this train is empty, re-run with --allow-unverified-seq"
      fi
      logerr "WARNING: --allow-unverified-seq set; the build floor is UNVERIFIED (0)"
      _floor_line="0 0 0"
    fi
    # "<floor> <train> <app>":  the two parts of the floor, and the result.
    PLAN_FLOOR="$(printf '%s' "$_floor_line" | awk '{print $1}')"
    PLAN_TRAIN_FLOOR="$(printf '%s' "$_floor_line" | awk '{print $2}')"
    PLAN_APP_FLOOR="$(printf '%s' "$_floor_line" | awk '{print $3}')"
    [[ "$PLAN_FLOOR" =~ ^[0-9]+$ ]] || PLAN_FLOOR=0
    [[ "$PLAN_TRAIN_FLOOR" =~ ^[0-9]+$ ]] || PLAN_TRAIN_FLOOR=0
    [[ "$PLAN_APP_FLOOR" =~ ^[0-9]+$ ]] || PLAN_APP_FLOOR=0

    # Strictly-increasing guard:  ASC rejects a repeated (version, build)
    # pair, so never ship at or below the known floor.  The guard fires when
    # the floor is at or above the commit count -- because App Store Connect
    # already holds it, or because a shallow checkout understates the commit
    # count -- so the log line names the floor rather than asserting the
    # commit count was shipped.
    BUILD_NUM="$PLAN_COMMIT_COUNT"
    if [[ "$FIXED_MODE" -ne 1 && "$BUILD_NUM" -le "$PLAN_FLOOR" ]]; then
      BUILD_NUM="$((PLAN_FLOOR + 1))"
      log "build: floor ${PLAN_FLOOR} is at or above the commit count ${PLAN_COMMIT_COUNT}; using ${BUILD_NUM} instead"
    fi
    # A ship must never look like "1.0.N (N)":  if the build number happens
    # to be the patch number of the marketing version, move it one up.
    # Both sides are compared as base-10 digit strings:  a pinned patch such
    # as "0237" would otherwise be read as octal and slip past this guard.
    if [[ "$PLAN_TARGET_PATCH" =~ ^[0-9]+$ && "$BUILD_NUM" =~ ^[0-9]+$ ]] \
      && (( 10#$BUILD_NUM == 10#$PLAN_TARGET_PATCH )); then
      _bumped="$((BUILD_NUM + 1))"
      log "build: ${BUILD_NUM} equals the patch number; using ${_bumped} so the ship does not read ${MARKETING} (${BUILD_NUM})"
      BUILD_NUM="$_bumped"
    fi
  fi
fi

# The project file and the shipped version must never disagree silently. The
# version above is passed on the xcodebuild command line and overrides whatever
# project.pbxproj says, so a stale value there is invisible without this check.
# The project file is NOT a sequencing input any more (AFC-517):  this only
# reports the disagreement.
PROJECT_SEQ_NOW="$(project_marketing_seq "$PBXPROJ" "$MARKETING_PREFIX" quiet)"
if [[ -n "$UPLOAD_ONLY_IPA" ]]; then
  : # no version was resolved for --upload-only; nothing to compare against
elif [[ -z "$PBXPROJ" ]]; then
  log "project version: .xcodeproj not resolvable yet; skipping agreement check"
elif [[ "${MARKETING_PREFIX}.${PROJECT_SEQ_NOW}" != "$MARKETING" ]]; then
  log "NOTICE: project.pbxproj says MARKETING_VERSION=${MARKETING_PREFIX}.${PROJECT_SEQ_NOW}, shipping ${MARKETING}."
  log "NOTICE: the shipped value wins (passed to xcodebuild). To record it in the repo,"
  log "NOTICE: add --sync-project-version to the next REAL ship, then commit"
  log "NOTICE: clients/ios/*.xcodeproj/project.pbxproj. Syncing from a --dry-run would"
  log "NOTICE: write a number the next real ship then exceeds, re-creating this gap."
fi

# Write the resolved version into project.pbxproj so the repo records what
# shipped. Opt-in: it dirties the worktree, and the ship path itself requires a
# clean one.
if [[ "$SYNC_PROJECT_VERSION" -eq 1 ]]; then
  # A dry-run only peeks; nothing is consumed, so the next real ship
  # would exceed whatever we wrote here and the file would be stale again.
  [[ "$DRY_RUN" -eq 0 ]] || die "--sync-project-version cannot be combined with --dry-run.
  A dry-run does not ship anything, so writing ${MARKETING} now would be
  superseded by the next real ship. Pass --sync-project-version on the real ship instead."
  [[ -z "$UPLOAD_ONLY_IPA" ]] || die "--sync-project-version cannot be combined with --upload-only.
  An upload-only run resolves no version of its own — the IPA already carries one — so
  there is nothing to write back. Pass it on the run that builds the archive."
  [[ -n "$PBXPROJ" && -f "$PBXPROJ" ]] || die "--sync-project-version: project.pbxproj not found under $REPO_ROOT"
  /usr/bin/sed -i '' \
    -e "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = ${MARKETING};/g" \
    -e "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = ${BUILD_NUM};/g" \
    "$PBXPROJ"
  log "synced project.pbxproj -> MARKETING_VERSION=${MARKETING} CURRENT_PROJECT_VERSION=${BUILD_NUM}"
  log "commit that change; it is the repo's record of this version"
fi
AUTH_MODE="none"
load_secrets

STAMP="$(date +%Y%m%d-%H%M%S)"
#  SHIP_TMP_ROOT was classified above, before the version plan, so a root
#  TMPDIR is reported as the path failure it is instead of as an
#  unreachable App Store Connect.  It is the same value here:  nothing
#  between the two points changes TMPDIR.
OUT_ROOT="${SHIP_TMP_ROOT}/ios-ship-${APP_KEY}-${STAMP}"
ARCHIVE_PATH="${OUT_ROOT}/${SCHEME}.xcarchive"
EXPORT_DIR="${OUT_ROOT}/export"
LOG_DIR="${OUT_ROOT}/logs"
mkdir -p "$LOG_DIR"

log "app=${DISPLAY_NAME} key=${APP_KEY}"
log "bundleId=${BUNDLE_ID}"
log "scheme=${SCHEME}"
log "repo=${REPO_ROOT}"
if [[ "$PLAN_READY" -eq 1 ]]; then
  log "version plan: asc_patch=${PLAN_ASC_PATCH} -> marketing=${MARKETING}; build floors: train=${PLAN_TRAIN_FLOOR} app=${PLAN_APP_FLOOR} commit_count=${PLAN_COMMIT_COUNT} -> build=${BUILD_NUM}"
fi
log "marketing=${MARKETING} build=${BUILD_NUM}"
log "App Store Connect will show this as: ${MARKETING} (${BUILD_NUM})"
log "auth=${AUTH_MODE} export_only=${EXPORT_ONLY} force_ship=${FORCE_SHIP}"
log "out=${OUT_ROOT}"

# The gate already ran, before any build number was consumed. A real run that
# was told to skip exited there; only --dry-run reaches this point still
# holding a "skip" decision, and it reports it as part of the plan.
if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ "$SHIP_GATE_DECISION" == "skip" ]]; then
    log "dry-run: ship-gate would SKIP this run; no build number would be consumed"
  else
    log "dry-run: would archive + ship; exiting"
  fi
  exit 0
fi

if [[ -n "$UPLOAD_ONLY_IPA" ]]; then
  [[ -f "$UPLOAD_ONLY_IPA" ]] || die "package not found: $UPLOAD_ONLY_IPA"
  if [[ "$AUTH_MODE" != "api_key" ]]; then
    if [[ "$(asc_upload_block)" == "staging" ]]; then
      die "upload-only: the App Store Connect credential was resolved, and the staging path was refused.  This is a path failure, not a missing key."
    fi
    if [[ "$(asc_upload_block)" == "credential" ]]; then
      die "upload-only: the App Store Connect credential was resolved, but it is not a usable PEM private key.  This is a credential failure, not a missing key and not a path failure."
    fi
    if [[ "$(asc_upload_block)" == "writer" ]]; then
      die "upload-only: the key writer itself failed.  It classified neither the credential nor the path, so this is not a missing key and not a path failure."
    fi
    die "upload-only requires ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 (env) or Infisical /asc (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8)"
  fi
  link_private_key "$ASC_KEY_PATH" "$ASC_KEY_ID"
  log "uploading existing package via altool (api key)"
  set +e
  xcrun altool --upload-package "$UPLOAD_ONLY_IPA" \
    --apiKey "$ASC_KEY_ID" \
    --apiIssuer "$ASC_ISSUER_ID" \
    2>&1 | tee "${LOG_DIR}/upload.log"
  UPLOAD_RC=${PIPESTATUS[0]}
  set -e
  [[ $UPLOAD_RC -eq 0 ]] || die "altool upload failed (rc=$UPLOAD_RC); see ${LOG_DIR}/upload.log"
  record_successful_ship
  log "upload submitted; watch TestFlight processing in App Store Connect"
  exit 0
fi

# Optional XcodeGen regenerate
if [[ -n "$XCODEGEN_DIR" && "$XCODEGEN_DIR" != "null" && "$SKIP_XCODEGEN" -eq 0 ]]; then
  if command -v xcodegen >/dev/null 2>&1; then
    log "xcodegen generate in ${REPO_ROOT}/${XCODEGEN_DIR}"
    (cd "${REPO_ROOT}/${XCODEGEN_DIR}" && xcodegen generate) 2>&1 | tee "${LOG_DIR}/xcodegen.log"
  else
    log "xcodegen not installed; using checked-in .xcodeproj"
  fi
fi

PROJECT_PATH="$(resolve_project "$REPO_ROOT" "$PROJECT_REL" "$PROJECT_REL_ALT")" \
  || die "project not found under $REPO_ROOT ($PROJECT_REL / $PROJECT_REL_ALT)"

log "project=${PROJECT_PATH}"

# Archive (device, not simulator). -allowProvisioningUpdates lets Xcode
# download/create App Store distribution profiles for team CC8UTF7ATG.
# Xcode's saved account session can be rejected (observed 2026-08-09:
# "Unable to log in with account ... login details were rejected"), which fails
# automatic signing even when an ASC API key is available. Passing the key
# straight to xcodebuild removes the dependency on the Xcode UI session.
ASC_AUTH_FLAGS=()
if [[ -n "${ASC_KEY_PATH:-}" && -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  _asc_key_expanded="${ASC_KEY_PATH/#\~/$HOME}"
  if [[ -f "$_asc_key_expanded" ]]; then
    ASC_AUTH_FLAGS=(-authenticationKeyPath "$_asc_key_expanded" \
      -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
    log "signing auth: ASC API key"
  fi
fi

# ---------------------------------------------------------------------------
# MANUAL APP STORE SIGNING (2026-10-07, BotFleet app.botfleet.ios first ship)
# ---------------------------------------------------------------------------
# Xcode 26 automatic signing (-allowProvisioningUpdates) calls
# developerservices2.apple.com, and the fleet ASC API key gets HTTP 401 there.
# Manual mode installs App Store profiles over the REST API and archives with
# CODE_SIGN_STYLE=Manual from ios/project.yml Release settings.
MANUAL_SIGN=0
PROVISION_UPDATE_FLAGS=(-allowProvisioningUpdates)
_profile_map_dir="ios"
if [[ -n "$XCODEGEN_DIR" && "$XCODEGEN_DIR" != "null" ]]; then
  _profile_map_dir="$XCODEGEN_DIR"
fi
PROFILE_MAP="${IOS_APPSTORE_PROFILES_MAP:-${REPO_ROOT}/${_profile_map_dir}/appstore-profiles.json}"
if [[ "$PLATFORM" != "macOS" ]]; then
  case "${IOS_MANUAL_SIGN:-}" in
    1) MANUAL_SIGN=1 ;;
    0) MANUAL_SIGN=0 ;;
    *) [[ -f "$PROFILE_MAP" ]] && MANUAL_SIGN=1 ;;
  esac
fi

write_manual_export_plists() {
  EXPORT_PLIST_UPLOAD="${LOG_DIR}/ExportOptions-manual-upload.plist"
  EXPORT_PLIST_IPA="${LOG_DIR}/ExportOptions-manual-ipa.plist"
  python3 - "$PROFILE_MAP" "$TEAM_ID" "$EXPORT_PLIST_UPLOAD" "$EXPORT_PLIST_IPA" <<'PY'
import json, plistlib, sys
profiles = json.load(open(sys.argv[1], encoding="utf-8"))
common = {
    "method": "app-store-connect",
    "teamID": sys.argv[2],
    "signingStyle": "manual",
    "signingCertificate": "Apple Distribution",
    "provisioningProfiles": profiles,
    "uploadSymbols": True,
    "manageAppVersionAndBuildNumber": False,
    "stripSwiftSymbols": True,
}
for path, destination in ((sys.argv[3], "upload"), (sys.argv[4], "export")):
    opts = dict(common)
    opts["destination"] = destination
    with open(path, "wb") as handle:
        plistlib.dump(opts, handle, fmt=plistlib.FMT_XML)
PY
  log "manual export options written (profiles from ${PROFILE_MAP##*/})"
}

if [[ "$MANUAL_SIGN" -eq 1 ]]; then
  [[ -f "$PROFILE_MAP" ]] || die "IOS_MANUAL_SIGN=1 but the profile map is missing: ${PROFILE_MAP}"
  _installer="${IOS_INSTALL_PROFILES_SCRIPT:-${REPO_ROOT}/scripts/ios-install-appstore-profiles.sh}"
  [[ -f "$_installer" ]] || die "manual signing needs ${_installer}"
  log "manual App Store signing: skipping Xcode's provisioning service"
  IOS_APPSTORE_PROFILES_MAP="$PROFILE_MAP" bash "$_installer" \
    || die "could not install the App Store profiles named in ${PROFILE_MAP}"
  PROVISION_UPDATE_FLAGS=()
  ASC_AUTH_FLAGS=()
  write_manual_export_plists
fi

# One Mac hosts three Actions runners. Serialize archive/export so two
# xcodebuild archives cannot thrash DerivedData / codesign at once.
ARCHIVE_LOCK_DIR="${STATE_DIR}/archive.lockdir"
acquire_archive_lock() {
  mkdir -p "$STATE_DIR"
  local tries=0
  until mkdir "$ARCHIVE_LOCK_DIR" 2>/dev/null; do
    tries=$((tries + 1))
    if [[ "$tries" -gt 180 ]]; then
      die "archive lock timeout (${ARCHIVE_LOCK_DIR})"
    fi
    log "archive lock busy; waiting (${tries})"
    sleep 10
  done
  # shellcheck disable=SC2064
  trap "rmdir '$ARCHIVE_LOCK_DIR' 2>/dev/null || true; cleanup_asc_tmp" EXIT
}
release_archive_lock() {
  rmdir "$ARCHIVE_LOCK_DIR" 2>/dev/null || true
}

# After a successful upload, declare export compliance if the IPA omitted
# ITSAppUsesNonExemptEncryption. Otherwise TestFlight stays
# MISSING_EXPORT_COMPLIANCE and the phone never sees the build (ST 1.0.1/2
# on 2026-08-12).
TF_READY_CONFIRMED=0
ensure_tf_ready() {
  log "verifying TestFlight ready-to-install for ${BUNDLE_ID} build ${BUILD_NUM}"
  set +e
  # BUILD_NUM (CFBundleVersion) is REQUIRED. Without it asc-api.mjs would have to
  # guess "the newest build", which for the first minutes after an upload is the
  # PREVIOUS ship -- so compliance got declared on the wrong build and readiness
  # was reported for a build never inspected (2026-08-13). MARKETING is a second
  # predicate, not a substitute: it identifies a train, not a build.
  IOS_TF_NOTES_REPO="$REPO_ROOT" \
  IOS_TF_NOTES_PREV_SHA="$PREV_SHIP_SHA" \
  IOS_TF_NOTES_APP="$DISPLAY_NAME" \
  IOS_TF_NOTES_IOS_PREFIX="$IOS_PATH_PREFIX" \
  node "${FLEET_DIR}/asc-api.mjs" ensure-tf-ready "$BUNDLE_ID" "$BUILD_NUM" "$MARKETING" "${APPLE_ID:-}" \
    >"${LOG_DIR}/ensure-tf-ready.json" 2>"${LOG_DIR}/ensure-tf-ready.err"
  local rc=$?
  set -e
  if [[ -s "${LOG_DIR}/ensure-tf-ready.err" ]]; then
    while IFS= read -r line; do log "tf-ready: $line"; done <"${LOG_DIR}/ensure-tf-ready.err"
  fi
  if [[ $rc -eq 0 ]]; then
    log "TestFlight external install path is live for ${BUNDLE_ID} (an external group has testers or an enabled public link); the standing-testers sync assigns and verifies this build next"
    TF_READY_CONFIRMED=1
    return 0
  fi
  if [[ $rc -eq 5 ]]; then
    # Apple finished processing the build, but it is assigned to no external
    # group with testers or a public link, so nobody can install it.  This is
    # not a failed upload (the build is in App Store Connect), so do not fail
    # the job; make it impossible to miss instead.  A new bundle ID starts with
    # no groups, and 14 green ships once reached nobody this way (GH #1018).
    log "warning: build ${BUILD_NUM} is processed but ${BUNDLE_ID} has no external TestFlight group with testers or a public link; nobody can install it yet"
    log "warning: the Sync standing TestFlight testers step assigns the external group; otherwise enable the public link under TestFlight > External Testing"
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::warning title=TestFlight has no reachable external tester::${BUNDLE_ID} build ${BUILD_NUM} is processed but no external tester can install it.  Check the Sync standing TestFlight testers step."
    fi
    return 0
  fi
  if [[ $rc -eq 6 ]]; then
    # Processed, but the external installability could not be read, so we
    # cannot say anyone can install it.  Say so instead of printing the success line.
    log "warning: build ${BUILD_NUM} is processed but the external TestFlight installability could not be read for ${BUNDLE_ID}; installability is unverified"
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::warning title=TestFlight installability unverified::${BUNDLE_ID} build ${BUILD_NUM} is processed but the external installability could not be read.  Check TestFlight."
    fi
    return 0
  fi
  if [[ $rc -eq 3 ]]; then
    log "warning: upload succeeded but ASC has not reached IN_BETA_TESTING yet; watch TestFlight"
    return 0
  fi
  if [[ $rc -eq 4 ]]; then
    # The upload itself succeeded; ASC simply never surfaced the build in time.
    # Warn loudly but do NOT fail: the caller must still record_successful_ship,
    # or the rate gate never advances and the next scheduled run re-ships the
    # same HEAD. A red job after a successful upload also mislabels the outcome.
    log "warning: ASC never surfaced build ${BUILD_NUM}; export compliance NOT declared on it"
    log "warning: if the phone never gets this build, declare compliance by hand in App Store Connect"
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::warning::ensure-tf-ready could not find uploaded build ${BUILD_NUM} for ${BUNDLE_ID}; export compliance not declared"
    fi
    return 0
  fi
  # rc=2 is a usage error or an ASC API error. Compliance was NOT declared, so
  # this deserves the same CI annotation rc=4 gets -- otherwise the only trace
  # is one log line inside a green job, which is how ST 1.0.1/2 stayed
  # VALID-but-uninstallable without anyone noticing.
  log "warning: ensure-tf-ready failed (rc=$rc); build may be stuck on export compliance"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning::ensure-tf-ready failed (rc=${rc}) for ${BUNDLE_ID} build ${BUILD_NUM}; export compliance not declared"
  fi
  return 0
}

# Freeze source identity before building.  A later checkout change invalidates
# the reporting receipt rather than associating an archive with the wrong SHA.
SENTRY_ARCHIVE_COMMIT="$(repo_head_sha)"
emit_sentry_deployment_receipt() {
  # Hosted BotFleet iOS only.  Skips, export-only, upload-only and pending ASC
  # processing are not deployments and must never manufacture a receipt.
  [[ "$APP_KEY" == "botfleet" && -n "${GITHUB_OUTPUT:-}" ]] || return 0
  if [[ "$TF_READY_CONFIRMED" != "1" ]]; then
    echo "::warning::No confirmed TestFlight readiness; Sentry deployment was not recorded."
    return 0
  fi
  if ! SENTRY_ARCHIVE_PATH="$ARCHIVE_PATH" SENTRY_READY_FILE="${LOG_DIR}/ensure-tf-ready.json" \
  SENTRY_REPO_ROOT="$REPO_ROOT" SENTRY_ARCHIVE_COMMIT="$SENTRY_ARCHIVE_COMMIT" \
  SENTRY_BUNDLE_ID="$BUNDLE_ID" SENTRY_MARKETING_VERSION="$MARKETING" SENTRY_BUILD_NUMBER="$BUILD_NUM" \
    node "${REPO_ROOT}/scripts/sentry-testflight-receipt.mjs"; then
    # Preserve the successful ship result.  The separate reporting job fails
    # visibly on this output before it loads any Sentry credential.
    echo "sentry_receipt_error=true" >> "$GITHUB_OUTPUT"
  fi
}

acquire_archive_lock
log "archiving..."
set +e
if [[ "$PLATFORM" == "macOS" ]]; then
  ARCHIVE_PLATFORM_FLAGS=(-destination "generic/platform=macOS")
else
  ARCHIVE_PLATFORM_FLAGS=(-destination "generic/platform=iOS")
fi

SENTRY_DSN_FLAGS=()
if [[ -n "${SENTRY_DSN:-}" ]]; then
  SENTRY_DSN_FLAGS+=(SENTRY_DSN="$SENTRY_DSN")
  log "SENTRY_DSN present for archive (length ${#SENTRY_DSN})"
else
  log "warning: SENTRY_DSN unset; Cocoa no-ops when the plist value is empty"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning::SENTRY_DSN unset; this TestFlight build ships with Sentry Cocoa inert."
  fi
fi

if [[ "$MANUAL_SIGN" -eq 1 ]]; then
  xcodebuild archive \
    -project "$PROJECT_PATH" \
    -scheme "$SCHEME" \
    -configuration Release \
    "${ARCHIVE_PLATFORM_FLAGS[@]}" \
    -archivePath "$ARCHIVE_PATH" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    MARKETING_VERSION="$MARKETING" \
    CURRENT_PROJECT_VERSION="$BUILD_NUM" \
    ${SENTRY_DSN_FLAGS[@]:+"${SENTRY_DSN_FLAGS[@]}"} \
    2>&1 | tee "${LOG_DIR}/archive.log"
  ARCHIVE_RC="${PIPESTATUS[0]:-$?}"
else
  xcodebuild archive \
    -project "$PROJECT_PATH" \
    -scheme "$SCHEME" \
    -configuration Release \
    "${ARCHIVE_PLATFORM_FLAGS[@]}" \
    -archivePath "$ARCHIVE_PATH" \
    -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration \
    ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    MARKETING_VERSION="$MARKETING" \
    CURRENT_PROJECT_VERSION="$BUILD_NUM" \
    ${SENTRY_DSN_FLAGS[@]:+"${SENTRY_DSN_FLAGS[@]}"} \
    2>&1 | tee "${LOG_DIR}/archive.log"
  ARCHIVE_RC="${PIPESTATUS[0]:-$?}"
fi
set -e
[[ $ARCHIVE_RC -eq 0 ]] || die "archive failed (rc=$ARCHIVE_RC); see ${LOG_DIR}/archive.log"
if [[ "$MANUAL_SIGN" -eq 1 ]]; then
  _archived_app="$(ls -d "${ARCHIVE_PATH}/Products/Applications/"*.app 2>/dev/null | head -1 || true)"
  if [[ -n "$_archived_app" ]]; then
    _authority="$(codesign -dvv "$_archived_app" 2>&1 | sed -n 's/^Authority=//p' | head -1 || true)"
    log "archived app signed by: ${_authority:-unknown}"
  fi
fi
upload_sentry_artifacts

if [[ "$MANUAL_SIGN" -eq 0 ]]; then
  EXPORT_PLIST_UPLOAD="${FLEET_DIR}/ExportOptions-appstore.plist"
  EXPORT_PLIST_IPA="${FLEET_DIR}/ExportOptions-export-ipa.plist"
fi

if [[ "$EXPORT_ONLY" -eq 1 ]]; then
  log "exporting package only..."
  mkdir -p "$EXPORT_DIR"
  set +e
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_PLIST_IPA" \
    ${PROVISION_UPDATE_FLAGS[@]:+"${PROVISION_UPDATE_FLAGS[@]}"} \
    ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
    2>&1 | tee "${LOG_DIR}/export.log"
  EXPORT_RC=${PIPESTATUS[0]}
  set -e
  [[ $EXPORT_RC -eq 0 ]] || die "export failed (rc=$EXPORT_RC); see ${LOG_DIR}/export.log"
  PACKAGE="$(ls -1 "$EXPORT_DIR"/*.ipa "$EXPORT_DIR"/*.pkg 2>/dev/null | head -1 || true)"
  [[ -n "$PACKAGE" ]] || die "no IPA or PKG produced in $EXPORT_DIR"
  log "Package ready: $PACKAGE"
  log "Upload later: bash $0 $APP_KEY --upload-only \"$PACKAGE\""
  exit 0
fi

if [[ "$MANUAL_SIGN" -eq 1 ]]; then
  log "manual signing: exporting the IPA locally, then uploading with altool (api key)"
  : >"${LOG_DIR}/export-upload.log"
else
# Prefer: export with destination=upload (uses Xcode session OR ASC if configured in Xcode)
log "exporting + uploading to App Store Connect..."
mkdir -p "$EXPORT_DIR"
set +e
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST_UPLOAD" \
  -allowProvisioningUpdates \
  ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
  2>&1 | tee "${LOG_DIR}/export-upload.log"
EXPORT_RC=${PIPESTATUS[0]}
set -e

if [[ $EXPORT_RC -eq 0 ]]; then
  log "upload path succeeded via xcodebuild export (destination=upload)"
  log "build ${MARKETING} (${BUILD_NUM}) submitted for ${BUNDLE_ID}"
  release_archive_lock
  ensure_tf_ready
  record_successful_ship
  emit_sentry_deployment_receipt
  log "logs: ${LOG_DIR}"
  exit 0
fi

log "xcodebuild upload export failed (rc=$EXPORT_RC); trying local export + altool"
fi

mkdir -p "$EXPORT_DIR"
set +e
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST_IPA" \
  ${PROVISION_UPDATE_FLAGS[@]:+"${PROVISION_UPDATE_FLAGS[@]}"} \
  ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
  2>&1 | tee "${LOG_DIR}/export-ipa.log"
EXPORT_RC=${PIPESTATUS[0]}
set -e
[[ $EXPORT_RC -eq 0 ]] || die "export failed (rc=$EXPORT_RC); see ${LOG_DIR}/export-ipa.log and ${LOG_DIR}/export-upload.log"

PACKAGE="$(ls -1 "$EXPORT_DIR"/*.ipa "$EXPORT_DIR"/*.pkg 2>/dev/null | head -1 || true)"
[[ -n "$PACKAGE" ]] || die "no IPA or PKG produced in $EXPORT_DIR"

# Re-load secrets before altool: long xcodebuild sessions can leave ASC_*
# unset under `set -u` even when AUTH_MODE was api_key at plan time.
load_secrets
if [[ "$AUTH_MODE" != "api_key" ]]; then
  log "Package ready at: $PACKAGE"
  if [[ "$(asc_upload_block)" == "staging" ]]; then
    log "Upload blocked: the App Store Connect credential was resolved, and the staging path was refused."
    log "This is a path failure, not a missing key."
    exit 3
  fi
  if [[ "$(asc_upload_block)" == "credential" ]]; then
    log "Upload blocked: the App Store Connect credential was resolved, but it is not a usable PEM private key."
    log "This is a credential failure, not a missing key and not a path failure."
    log "The key exists; the value that came back from the vault cannot be used to sign an upload."
    log "Owner handoff:"
    log "  1) Export the .p8 again in App Store Connect (App Manager+)"
    log "  2) Store that file as ASC_KEY_P8 in Infisical Fleet-OPS /asc"
    log "  3) Or export ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 for this run"
    log "  4) Re-run: bash $0 $APP_KEY --upload-only \"$PACKAGE\""
    exit 3
  fi
  if [[ "$(asc_upload_block)" == "writer" ]]; then
    log "Upload blocked: the key tool itself failed."
    log "It classified neither the credential nor the path, so this is not a missing key and not a path failure."
    log "The credential was resolved; the tool that checks or stages it for the Apple tools did not finish."
    exit 3
  fi
  log "Upload blocked: no App Store Connect API key."
  log "Owner handoff:"
  log "  1) Create ASC API key (App Manager+) in App Store Connect"
  log "  2) Store ASC_KEY_ID and ASC_ISSUER_ID in Infisical Fleet-OPS /asc"
  log "  3) Store the .p8 as ASC_KEY_P8 in Infisical /asc"
  log "  4) Or export ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 for this run"
  log "  5) Re-run: bash $0 $APP_KEY --upload-only \"$PACKAGE\""
  log "Also ensure App Store Connect has an app record for ${BUNDLE_ID}."
  exit 3
fi

link_private_key "${ASC_KEY_PATH}" "${ASC_KEY_ID}"
log "uploading package via altool (api key)"
set +e
xcrun altool --upload-package "$PACKAGE" \
  --apiKey "${ASC_KEY_ID}" \
  --apiIssuer "${ASC_ISSUER_ID}" \
  2>&1 | tee "${LOG_DIR}/upload.log"
UPLOAD_RC=${PIPESTATUS[0]}
set -e
if [[ $UPLOAD_RC -ne 0 ]]; then
  log "altool failed (rc=$UPLOAD_RC). Common cause: no App Store Connect app for ${BUNDLE_ID}."
  log "Create the app in ASC (My Apps → +) with this exact bundle id, then:"
  log "  bash $0 $APP_KEY --upload-only \"$PACKAGE\""
  die "altool upload failed (rc=$UPLOAD_RC); see ${LOG_DIR}/upload.log"
fi

release_archive_lock
ensure_tf_ready
record_successful_ship
emit_sentry_deployment_receipt
log "upload submitted; watch TestFlight processing for ${BUNDLE_ID} build ${BUILD_NUM}"
log "logs: ${LOG_DIR}"
exit 0
