#!/usr/bin/env bash
# publish-ios-versions.sh — open a pull request that updates the public fleet
# iOS version manifest.
#
# Called by ship-testflight.sh after a successful upload.  Also safe to run by
# hand.  Never prints secret values.  Failure is non-fatal for ships.
#
# Usage:
#   bash scripts/ios-fleet/publish-ios-versions.sh \
#     --bundle-id com.socratictrade.ios \
#     --version 1.0.68 \
#     [--build 202608211800] \
#     [--apple-id 1111111111] \
#     [--display-name "Socratic-Trade"]
#     [--base-json path] [--out-json path] [--skip-push] [--skip-local-write]
#
# Writes:
#   <this-dir>/ios-app-versions.json  (local cache; may be stale)
#   a pull request against Simple-With-Us/AI-Fleet-Coordinator :
#     site/ios-versions.json
#
# WHY A PULL REQUEST AND NOT A DIRECT WRITE:  AI-Fleet-Coordinator's ruleset
# requires `test` and `gitleaks` on main, and a ruleset with required status
# checks refuses a direct write to the protected branch.  A Contents API PUT
# to the default branch is therefore rejected, the ship treats the publish as
# best effort, and the only trace anywhere is one warning line in the ship
# log.  A pull request merge is exempt from that gate, so the manifest is
# published as a branch plus a pull request.  The script never writes to the
# default branch.
#
# GATES: before it publishes, the script runs the fleet icon audit
# (fleet-icon-audit.mjs).  FLEET_ICON_AUDIT=block (default) refuses to publish
# when the audit reports an error or cannot run; warn reports and continues;
# off skips it.  After a successful publish it runs the guarded sheet sync
# shim (~/apps/fleet-apps-sheet-sync.mjs, or FLEET_SHEET_SYNC) so the Fleet
# Reference Sheet follows the manifest; a missing shim is skipped, a failing
# one is reported and fails the run.
#
# THE TOKEN:  the publish needs a credential with write access to
# AI-Fleet-Coordinator.  The ship workflow passes the fleet's GH_PAT secret
# as GH_TOKEN; a hand run reads GH_PAT through fleet-secrets.  A bare gh login
# is never used.  The
# workflow's own GITHUB_TOKEN is read-only by declaration and cannot write to
# another repository, so it is never used for this and never arms auto-merge.
#
# SAFETY: the vendored ios-app-versions.json in this repo is a stale snapshot
# (2026-08-21).  Starting from that file and publishing it would drop
# net.dealdex 1.0.2 and roll Usage Client 1.0.11→1.0.8, Usage Local
# 1.0.9→1.0.7, and Autorotate 1.0.4→1.0.1.  Always seed from the live remote
# (or an explicit --base-json).  Refuse to publish a single-app / empty-apps
# document over a multi-app remote.  Same class as DealDex #173.

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_JSON="${FLEET_DIR}/ios-app-versions.json"
REPO="${AFC_MANIFEST_REPO:-Simple-With-Us/AI-Fleet-Coordinator}"
REMOTE_PATH="site/ios-versions.json"
BASE_BRANCH="${AFC_MANIFEST_BRANCH:-main}"
PR_BRANCH_PREFIX="${AFC_MANIFEST_BRANCH_PREFIX:-ios-versions-publish}"
AUTO_MERGE="${AFC_MANIFEST_AUTO_MERGE:-1}"

BUNDLE_ID=""
VERSION=""
BUILD=""
APPLE_ID=""
DISPLAY_NAME=""
BASE_JSON=""
OUT_JSON=""
SKIP_PUSH=0
SKIP_LOCAL_WRITE=0

need_arg() {
  [[ "$2" -ge 2 ]] || { echo "error: $1 needs a value" >&2; exit 2; }
}

usage() {
  sed -n '1,45p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id) need_arg "$1" "$#"; BUNDLE_ID="$2"; shift 2 ;;
    --version) need_arg "$1" "$#"; VERSION="$2"; shift 2 ;;
    --build) need_arg "$1" "$#"; BUILD="$2"; shift 2 ;;
    --apple-id) need_arg "$1" "$#"; APPLE_ID="$2"; shift 2 ;;
    --display-name) need_arg "$1" "$#"; DISPLAY_NAME="$2"; shift 2 ;;
    --base-json) need_arg "$1" "$#"; BASE_JSON="$2"; shift 2 ;;
    --out-json) need_arg "$1" "$#"; OUT_JSON="$2"; shift 2 ;;
    --skip-push) SKIP_PUSH=1; shift ;;
    --skip-local-write) SKIP_LOCAL_WRITE=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BUNDLE_ID" && -n "$VERSION" ]] || { echo "need --bundle-id and --version" >&2; exit 2; }

# The token the publish uses.  GITHUB_TOKEN is the workflow's own token:  it is
# read-only by declaration and it cannot write to another repository, so it is
# refused here rather than failing later with an authorization error that reads
# like a branch rule.
TOKEN=""
TOKEN_SOURCE=""
resolve_token() {
  if [[ -n "${GH_TOKEN:-}" ]]; then
    TOKEN="$GH_TOKEN"
    TOKEN_SOURCE="env"
    return 0
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "error: GITHUB_TOKEN cannot write to ${REPO}" >&2
    echo "error: pass the fleet GH_PAT secret as GH_TOKEN (the ship workflow does)" >&2
    return 1
  fi
  # No token in the environment:  read the fleet GH_PAT.  A bare gh login is
  # not used, because it may be a personal or read-only credential.
  local pat=""
  if command -v fleet-secrets >/dev/null 2>&1; then
    pat="$(fleet-secrets get GH_PAT 2>/dev/null || true)"
  fi
  if [[ -z "$pat" ]]; then
    echo "error: no GH_TOKEN and fleet-secrets could not return GH_PAT; cannot publish the manifest" >&2
    return 1
  fi
  TOKEN="$pat"
  TOKEN_SOURCE="fleet-secrets"
}

# Read the manifest at a ref (branch or commit) into a file.  Sets FETCHED_SHA
# to the file's blob sha.
fetch_json_at() {
  local ref="$1" dest="$2" meta b64
  command -v gh >/dev/null 2>&1 || return 1
  meta="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}?ref=${ref}" --jq '[.sha, .content] | @tsv' 2>/dev/null || true)"
  [[ -n "$meta" ]] || return 1
  FETCHED_SHA="${meta%%$'\t'*}"
  b64="${meta#*$'\t'}"
  [[ -n "$b64" ]] || return 1
  python3 -c 'import base64,sys; sys.stdout.write(base64.b64decode("".join(sys.argv[1].split())).decode())' "$b64" >"$dest"
}

fetch_remote_json() {
  fetch_json_at "$BASE_BRANCH" "$1"
}

TMP_REMOTE=""
BASE_SNAPSHOT=""
LIVE_JSON=""
FETCHED_SHA=""
BASE_FROM_REMOTE=0
cleanup() {
  rm -f "${TMP_REMOTE:-}" "${BASE_SNAPSHOT:-}" "${LIVE_JSON:-}"
}
trap cleanup EXIT

if [[ -z "$BASE_JSON" ]]; then
  TMP_REMOTE="$(mktemp)"
  if fetch_remote_json "$TMP_REMOTE"; then
    BASE_JSON="$TMP_REMOTE"
    BASE_FROM_REMOTE=1
  else
    echo "error: could not read the live manifest ${REPO}/${REMOTE_PATH}; pass --base-json to seed explicitly" >&2
    echo "error: refusing to seed from the local snapshot (stale; would roll apps back)" >&2
    exit 1
  fi
fi

if [[ ! -f "$BASE_JSON" ]]; then
  echo "error: base json not found: ${BASE_JSON}" >&2
  exit 1
fi

# Work from a private copy of the base, so a later write to LOCAL_JSON or
# OUT_JSON (either may be the same path) cannot change what the no-op check
# compares against.
BASE_SNAPSHOT="$(mktemp)"
cp "$BASE_JSON" "$BASE_SNAPSHOT"
BASE_JSON="$BASE_SNAPSHOT"

merge_doc() {
  python3 - "$1" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys, datetime
path, bundle, version, build, apple_id, display = sys.argv[1:7]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    print("error: base json is not an object", file=sys.stderr)
    sys.exit(1)
apps = data.get("apps")
if not isinstance(apps, dict) or not apps:
    print("error: base json has no apps; refusing to publish a one-app replacement", file=sys.stderr)
    sys.exit(1)
before = set(apps)
entry = dict(apps.get(bundle) or {})
entry["marketingVersion"] = version
if build:
    entry["build"] = build
if apple_id:
    entry["appleId"] = int(apple_id)
if display:
    entry["displayName"] = display
apps[bundle] = entry
after = set(apps)
lost = sorted(before - after)
if lost:
    print("error: merge dropped apps: " + ", ".join(lost), file=sys.stderr)
    sys.exit(1)
data["apps"] = apps
data.setdefault("schemaVersion", 1)
data["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(data, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
}
MERGED="$(merge_doc "$BASE_JSON")"

if [[ "$SKIP_LOCAL_WRITE" -eq 0 ]]; then
  printf '%s\n' "$MERGED" >"$LOCAL_JSON"
  echo "local-manifest-updated ${BUNDLE_ID} ${VERSION}"
fi
if [[ -n "$OUT_JSON" ]]; then
  printf '%s\n' "$MERGED" >"$OUT_JSON"
fi

if [[ "$SKIP_PUSH" -eq 1 ]]; then
  echo "skip-push ${BUNDLE_ID} ${VERSION} apps=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("apps") or {}))' <<<"$MERGED")"
  exit 0
fi

# Nothing to publish:  the remote already carries this version.  A pull
# request for an unchanged manifest is noise, and the fleet's merge queue is
# small.  The build is part of the comparison when one was passed, because a
# ship that re-records the same marketing version with a NEW build is a real
# change:  the version a tester installs is the build, not the label.
#
# This check runs BEFORE the credential is resolved.  A ship that has nothing
# to publish must not need a token, and it must not reach the network at all;
# a run that only re-records the version already on main leaves no pull
# request behind and says so.
# The comparison is the whole document minus updatedAt, so a change to the
# Apple ID or display name is a real change too.
if printf '%s\n' "$MERGED" | python3 -c '
import json, sys
def strip(d):
    d = dict(d); d.pop("updatedAt", None); return d
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    base = json.load(fh)
merged = json.loads(sys.stdin.read())
sys.exit(0 if strip(base) == strip(merged) else 1)
' "$BASE_JSON"; then
  echo "version-manifest: ${BUNDLE_ID} ${VERSION}${BUILD:+ build ${BUILD}} is already recorded"
  exit 0
fi

# Release gate: the fleet icon audit.  block (default) refuses to publish when
# the audit errors or cannot run; warn reports and continues; off skips.
ICON_MODE="${FLEET_ICON_AUDIT:-block}"
ICON_SCRIPT="${FLEET_ICON_AUDIT_SCRIPT:-${FLEET_DIR}/fleet-icon-audit.mjs}"
case "$ICON_MODE" in
  off) ;;
  block|warn)
    if node "$ICON_SCRIPT" --no-lanes >&2; then
      echo "icon-audit: clean"
    elif [[ "$ICON_MODE" == "block" ]]; then
      echo "error: icon audit failed or could not run; refusing to publish (FLEET_ICON_AUDIT=warn reports and continues, off skips)" >&2
      exit 1
    else
      echo "warning: icon audit reported errors; publishing anyway (FLEET_ICON_AUDIT=warn)" >&2
    fi
    ;;
  *) echo "error: FLEET_ICON_AUDIT must be block, warn or off (got: ${ICON_MODE})" >&2; exit 2 ;;
esac

# The credential is resolved before any API call, so a run that cannot
# possibly publish says why, instead of failing later on an authorization
# error that reads like a branch rule.
resolve_token
if [[ -n "$TOKEN" ]]; then
  export GH_TOKEN="$TOKEN"
  unset GITHUB_TOKEN || true
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed; local manifest only" >&2
  exit 1
fi

# ONE SHARED BRANCH.  Every publish lands on the same branch and the same open
# pull request, so two ships cannot open two pull requests that conflict on the
# manifest's top-level updatedAt.  Concurrent publishers are serialized by
# compare-and-swap, never by force:
#   - the document is written with the branch file's blob sha, so a write that
#     lost a race is refused by GitHub and the loop re-reads and retries;
#   - when the default branch moved, the branch is brought up with a real merge
#     commit made by a non-force ref update (a fast-forward from the branch
#     head), so a bump another publisher pushed meanwhile is kept, never reset;
#   - the branch is only reset when it is not ahead of the default branch,
#     which means there is nothing on it to lose.
PR_BRANCH="${PR_BRANCH_PREFIX}/${AFC_MANIFEST_BRANCH_NAME:-fleet}"
PR_TITLE="chore: record the fleet iOS versions in the manifest"
# The gap between the sentences is a real no-break space plus a normal space,
# which is what GitHub renders.  The entity would show up literally.
SENTENCE_GAP=$'\xc2\xa0 '
PR_BODY="Automated fleet iOS version manifest update.${SENTENCE_GAP}Each commit on this branch records one app's version (latest: ${BUNDLE_ID} ${VERSION}).${SENTENCE_GAP}Published by scripts/ios-fleet/publish-ios-versions.sh as a pull request, because the default branch's ruleset requires status checks and refuses a direct write.  Later publishes land on this same branch until it merges."

BRANCH_JSON="$(mktemp)"
LIVE_JSON="$(mktemp)"
MB_JSON="$(mktemp)"
trap 'rm -f "${TMP_REMOTE:-}" "${BASE_SNAPSHOT:-}" "$BRANCH_JSON" "$LIVE_JSON" "$MB_JSON"' EXIT

# Docs differ only by updatedAt?  exit 0 = same.
docs_same() {
  python3 - "$1" "$2" <<'PY'
import json, sys
def strip(p):
    d = json.load(open(p, encoding="utf-8")); d.pop("updatedAt", None); return d
sys.exit(0 if strip(sys.argv[1]) == strip(sys.argv[2]) else 1)
PY
}

# Re-seat the branch on the default branch's document without dropping what is
# pending on it:  default doc + the apps the branch changed since their
# common ancestor.  An app both sides changed differently is refused.
reseat_branch() {
  local branch_sha="$1" base_sha="$2" mb_sha
  mb_sha="$(gh api "repos/${REPO}/compare/${BASE_BRANCH}...${PR_BRANCH}" --jq .merge_base_commit.sha)" || return 1
  fetch_json_at "$mb_sha" "$MB_JSON" || return 1
  fetch_json_at "$PR_BRANCH" "$BRANCH_JSON" || return 1
  local doc
  doc="$(python3 - "$MB_JSON" "$BRANCH_JSON" "$LIVE_JSON" <<'PY'
import json, sys
mb, br, live = (json.load(open(p, encoding="utf-8")) for p in sys.argv[1:4])
mba, bra, lva = (d.get("apps") or {} for d in (mb, br, live))
out = dict(live)
apps = dict(lva)
for k, v in bra.items():
    if mba.get(k) == v:
        continue
    if k in lva and lva[k] != mba.get(k) and lva[k] != v:
        print("error: both the branch and the default branch changed " + k + " differently; reconcile by hand", file=sys.stderr)
        sys.exit(1)
    apps[k] = v
out["apps"] = apps
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
)" || return 1
  local tree_sha new_tree new_commit payload
  tree_sha="$(gh api "repos/${REPO}/git/commits/${base_sha}" --jq .tree.sha)" || return 1
  payload="$(DOC="$doc" python3 -c 'import json,os,sys; print(json.dumps({"base_tree": sys.argv[1], "tree": [{"path": sys.argv[2], "mode": "100644", "type": "blob", "content": os.environ["DOC"]}]}))' "$tree_sha" "$REMOTE_PATH")"
  new_tree="$(printf '%s' "$payload" | gh api --method POST "repos/${REPO}/git/trees" --input - --jq .sha)" || return 1
  payload="$(python3 -c 'import json,sys; print(json.dumps({"message": "chore: bring the manifest branch up to " + sys.argv[3][:7], "tree": sys.argv[1], "parents": [sys.argv[2], sys.argv[3]]}))' "$new_tree" "$branch_sha" "$base_sha")"
  new_commit="$(printf '%s' "$payload" | gh api --method POST "repos/${REPO}/git/commits" --input - --jq .sha)" || return 1
  # Not a force update:  it only succeeds as a fast-forward from the head this
  # run read, so a bump pushed meanwhile makes it fail and the loop re-reads.
  gh api --method PATCH "repos/${REPO}/git/refs/heads/${PR_BRANCH}" -f sha="$new_commit" -F force=false >/dev/null
}

# 0.  The publish loop.  Every pass re-reads the default branch and the shared
#     branch, so the write is always made on current state.
PUBLISHED=0
for attempt in 1 2 3 4 5; do
  fetch_json_at "$BASE_BRANCH" "$LIVE_JSON" || { echo "error: could not re-read the live manifest before publishing" >&2; exit 1; }
  BASE_SHA="$(gh api "repos/${REPO}/git/ref/heads/${BASE_BRANCH}" --jq .object.sha)" || {
    echo "error: could not read ${REPO} ${BASE_BRANCH}" >&2
    exit 1
  }
  if BRANCH_SHA="$(gh api "repos/${REPO}/git/ref/heads/${PR_BRANCH}" --jq .object.sha 2>/dev/null)" && [[ -n "$BRANCH_SHA" ]]; then
    CMP="$(gh api "repos/${REPO}/compare/${BASE_BRANCH}...${PR_BRANCH}" --jq '[.ahead_by, .behind_by] | @tsv')" || continue
    AHEAD="${CMP%%$'\t'*}"
    BEHIND="${CMP#*$'\t'}"
    if [[ "$AHEAD" == "0" ]]; then
      # Nothing on the branch that the default branch lacks:  safe to move.
      if [[ "$BEHIND" != "0" ]]; then
        gh api --method PATCH "repos/${REPO}/git/refs/heads/${PR_BRANCH}" -f sha="$BASE_SHA" -F force=true >/dev/null || continue
      fi
    elif [[ "$BEHIND" != "0" ]]; then
      if ! reseat_branch "$BRANCH_SHA" "$BASE_SHA"; then
        echo "error: could not bring ${PR_BRANCH} up to ${BASE_BRANCH} without losing what is pending on it (attempt ${attempt})" >&2
        [[ "$attempt" -lt 5 ]] && continue
        exit 1
      fi
      continue
    fi
  else
    gh api --method POST "repos/${REPO}/git/refs" -f ref="refs/heads/${PR_BRANCH}" -f sha="$BASE_SHA" >/dev/null || continue
  fi

  fetch_json_at "$PR_BRANCH" "$BRANCH_JSON" || continue
  BRANCH_BLOB="$FETCHED_SHA"
  MERGED_B="$(merge_doc "$BRANCH_JSON")" || exit 1

  # The shrink guard:  the document must keep every app the default branch has.
  MERGED_JSON="$MERGED_B" python3 - "$LIVE_JSON" <<'PY' || exit 1
import json, os, sys
live = json.load(open(sys.argv[1], encoding="utf-8")).get("apps") or {}
merged = json.loads(os.environ["MERGED_JSON"]).get("apps") or {}
gone = sorted(set(live) - set(merged))
if gone:
    print("error: the document would drop apps the live remote has: " + ", ".join(gone), file=sys.stderr)
    sys.exit(1)
PY

  printf '%s\n' "$MERGED_B" >"$MB_JSON"
  if docs_same "$MB_JSON" "$BRANCH_JSON"; then
    echo "version-manifest: ${BUNDLE_ID} ${VERSION} is already on ${PR_BRANCH}"
    PUBLISHED=1
    break
  fi

  CONTENT_B64="$(python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())' <"$MB_JSON")"
  if gh api --method PUT "repos/${REPO}/contents/${REMOTE_PATH}" \
      -f message="chore: ${BUNDLE_ID} ${VERSION}" -f content="${CONTENT_B64}" \
      -f branch="${PR_BRANCH}" -f sha="${BRANCH_BLOB}" >/dev/null 2>&1; then
    PUBLISHED=1
    break
  fi
  echo "version-manifest: ${PR_BRANCH} moved under this publish, re-reading (attempt ${attempt})" >&2
  sleep 1
done
if [[ "$PUBLISHED" -ne 1 ]]; then
  echo "error: version-manifest publish failed (branch ${PR_BRANCH}) after 5 attempts" >&2
  exit 1
fi

# 3.  The pull request.  The open one for the shared branch is reused.
PR_NUMBER="$(gh api "repos/${REPO}/pulls?head=${REPO%%/*}:${PR_BRANCH}&state=open" --jq '.[0].number' 2>/dev/null || true)"
if [[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]]; then
  gh api --method PATCH "repos/${REPO}/pulls/${PR_NUMBER}" -f title="$PR_TITLE" -f body="$PR_BODY" >/dev/null
  PR_URL="https://github.com/${REPO}/pull/${PR_NUMBER}"
else
  PR_URL="$(gh api --method POST "repos/${REPO}/pulls" -f title="$PR_TITLE" -f body="$PR_BODY" -f head="$PR_BRANCH" -f base="$BASE_BRANCH" --jq .html_url)" || {
    echo "error: version-manifest publish failed (could not open the pull request)" >&2
    exit 1
  }
fi

# 4.  Arm the merge with the same elevated credential.  GitHub raises no
#     workflow events for a merge made with the repository's own
#     GITHUB_TOKEN, so the merge is armed here with the fleet token and
#     lands once `test` and `gitleaks` are green.  The default branch's
#     ruleset still decides whether the merge is allowed.
RC=0
if [[ "$AUTO_MERGE" == "1" ]]; then
  PR_NUM="${PR_URL##*/}"
  if gh pr merge "$PR_NUM" --repo "$REPO" --squash --auto >/dev/null 2>&1; then
    echo "version-manifest: auto-merge armed on ${PR_URL}"
  else
    echo "error: version-manifest auto-merge could not be armed on ${PR_URL}" >&2
    RC=1
  fi
fi

echo "version-manifest-pr ${PR_URL}"

# Sheet sync: the Fleet Reference Sheet follows the manifest.  The shim runs
# the registry sync only from a clean checkout at origin/main; a host without
# the shim skips it, a failing shim fails the run.
SHEET_SYNC="${FLEET_SHEET_SYNC:-$HOME/apps/fleet-apps-sheet-sync.mjs}"
if [[ -f "$SHEET_SYNC" ]]; then
  if node "$SHEET_SYNC" >&2; then
    echo "sheet-sync: done"
  else
    echo "error: fleet apps sheet sync failed (run it from an AFC lane: node scripts/fleet-apps-sheet-sync.mjs)" >&2
    RC=1
  fi
else
  echo "sheet-sync: shim ${SHEET_SYNC} not present, skipped"
fi
exit "$RC"
