#!/usr/bin/env bash
# Publish a successful TestFlight ship to the fleet iOS versions manifest.
#
# Reads from --bundle-id, --version, --build, --apple-id, --display-name and
# rewrites the matching entry under `apps` in
#   ai-fleet-coordinator/site/ios-versions.json
# bumping `updatedAt` to the run's ISO 8601 instant.  A first-time entry
# starts at the data the caller passed; an existing entry keeps every field
# the caller did NOT pass (so a routine ship that knows only the version and
# build does not stomp the appleId a previous ship recorded).
#
# The AFC site is GitHub Pages from the main branch, so a single
# `commit + push` on main is enough — the fleet-activity-site.yml workflow
# picks the change up on its every-six-hours schedule and on the next push.
# Pages serves the manifest at the mixed-case path (case-sensitive):
#   https://simple-with-us.github.io/AI-Fleet-Coordinator/ios-versions.json
# iOS TestFlightUpdateCheck must use that URL until infra renames the site path.
# This script NEVER pushes anywhere else; it commits only `site/ios-versions.json`
# on the AFC main branch and only after a clean tree, so a concurrent edit
# in another worktree (digest refresh, calendar regen) surfaces as a non-fatal
# warning instead of silently overwriting.
#
# Best-effort: ship-testflight.sh wraps this in `>/dev/null 2>&1 || true`,
# so a missing AFC checkout, a no-push-auth gh login, or a stale working tree
# logs a warning rather than failing the upload that already succeeded.
#
# Resolution order for the AFC checkout:
#   1. ${AI_FLEET_COORDINATOR_ROOT} if set and points at a real repo on main
#   2. ~/Code/ai-fleet-coordinator  if it is a git repo on main
#   3. /Users/jay/apps/ai-fleet-coordinator  (Mac runtime copy) same rules
#   4. gh repo clone into a per-run tmpdir (uses whatever gh is logged in as)
set -euo pipefail

usage() {
  cat <<'EOF'
usage: publish-ios-versions.sh --bundle-id <id> --version <marketing> [--build <n>] [--apple-id <id>] [--display-name <name>]

  --bundle-id      REQUIRED  e.g. app.botfleet, codes.autorotate
  --version        REQUIRED  marketing version, e.g. 1.0.31
  --build          OPTIONAL  build number as string (CURRENT_PROJECT_VERSION)
  --apple-id       OPTIONAL  numeric App Store Connect appleId, kept if unset
  --display-name   OPTIONAL  human label, kept if unset
EOF
  exit 64
}

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; }
warn() { log "warning: $*" >&2; }
die() { log "error: $*" >&2; exit 1; }

BUNDLE_ID=""
MARKETING=""
BUILD_NUM=""
APPLE_ID=""
DISPLAY_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    --version)   MARKETING="${2:-}"; shift 2 ;;
    --build)     BUILD_NUM="${2:-}"; shift 2 ;;
    --apple-id)  APPLE_ID="${2:-}"; shift 2 ;;
    --display-name) DISPLAY_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$BUNDLE_ID" ]] || usage
[[ -n "$MARKETING" ]] || usage

MANIFEST_REL="site/ios-versions.json"
AFC_REPO="Simple-With-Us/ai-fleet-coordinator"
DEFAULT_BRANCH="main"

resolve_afc_root() {
  if [[ -n "${AI_FLEET_COORDINATOR_ROOT:-}" && -d "${AI_FLEET_COORDINATOR_ROOT}/.git" ]]; then
    echo "${AI_FLEET_COORDINATOR_ROOT}"
    return 0
  fi
  for cand in "${HOME}/Code/ai-fleet-coordinator" "/Users/jay/apps/ai-fleet-coordinator"; do
    if [[ -d "$cand/.git" ]]; then echo "$cand"; return 0; fi
  done
  if command -v gh >/dev/null 2>&1; then
    local clone_root tmp
    tmp="$(mktemp -d -t publish-ios-versions.XXXXXX)"
    if gh repo clone "${AFC_REPO}" "$tmp/afc" -- --depth 1 -b "${DEFAULT_BRANCH}" >/dev/null 2>&1; then
      echo "$tmp/afc"
      return 0
    fi
    rm -rf "$tmp"
  fi
  return 1
}

if ! AFC_ROOT="$(resolve_afc_root)"; then
  warn "could not locate ai-fleet-coordinator (set AI_FLEET_COORDINATOR_ROOT or 'gh auth login')"
  exit 0
fi

cd "$AFC_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ "$BRANCH" != "$DEFAULT_BRANCH" ]]; then
  warn "AFC checkout is on '${BRANCH:-detached}', not main — skipping publish"
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  warn "AFC working tree is dirty — refusing to publish (run 'cd ${AFC_ROOT} && git status' to inspect)"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  warn "neither jq nor node is on PATH — cannot edit ${MANIFEST_REL}"
  exit 0
fi

MANIFEST_PATH="${AFC_ROOT}/${MANIFEST_REL}"
[[ -f "$MANIFEST_PATH" ]] || { warn "manifest ${MANIFEST_PATH} missing"; exit 0; }

NOW_ISO="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

if command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  # Idempotent merge: only the fields the caller passed are written; an
  # existing entry is left alone on every field the caller omitted.  We then
  # bump updatedAt only when something actually changed, so a routine ship
  # that re-records the same marketingVersion+build pair is a no-op rather
  # than a fresh commit on the AFC main branch.
  jq -e \
    --arg bundle "$BUNDLE_ID" \
    --arg version "$MARKETING" \
    --arg now "$NOW_ISO" \
    --arg build "${BUILD_NUM:-}" \
    --arg apple "${APPLE_ID:-}" \
    --arg display "${DISPLAY_NAME:-}" \
    '
      (.apps[$bundle] // {}) as $prev
      | (
          $prev
          | (if $version != "" then .marketingVersion = $version else . end)
          | (if $build   != "" then .build           = $build   else . end)
          | (if $apple   != "" then .appleId         = ($apple|tonumber) else . end)
          | (if $display != "" then .displayName     = $display else . end)
        ) as $merged
      | if ($merged == $prev) and (.updatedAt // "") != "" then
          .
        else
          .updatedAt = $now | .apps[$bundle] = $merged
        end
    ' "$MANIFEST_PATH" > "$tmp"
else
  # node fallback — same shape, slightly more code, identical JSON output.
  tmp="$(mktemp)"
  BUNDLE_ID="$BUNDLE_ID" \
  MARKETING="$MARKETING" \
  BUILD_NUM="$BUILD_NUM" \
  APPLE_ID="$APPLE_ID" \
  DISPLAY_NAME="$DISPLAY_NAME" \
  NOW_ISO="$NOW_ISO" \
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const env = process.env;
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    const apps = data.apps || {};
    const prev = apps[env.BUNDLE_ID] || {};
    const next = { ...prev };
    if (env.MARKETING) next.marketingVersion = env.MARKETING;
    if (env.BUILD_NUM) next.build = env.BUILD_NUM;
    if (env.APPLE_ID) next.appleId = Number(env.APPLE_ID);
    if (env.DISPLAY_NAME) next.displayName = env.DISPLAY_NAME;
    const sameContent = JSON.stringify(next) === JSON.stringify(prev);
    if (sameContent && data.updatedAt) {
      // no-op: leave manifest alone so the script does not push an empty commit
      fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    } else {
      data.apps = { ...apps, [env.BUNDLE_ID]: next };
      data.updatedAt = env.NOW_ISO;
      fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
    }
  ' "$MANIFEST_PATH"
  cp "$MANIFEST_PATH" "$tmp"
fi

if ! diff -q "$MANIFEST_PATH" "$tmp" >/dev/null 2>&1; then
  cp "$tmp" "$MANIFEST_PATH"
fi
rm -f "$tmp"

if [[ -z "$(git status --porcelain -- "$MANIFEST_REL")" ]]; then
  log "version-manifest: ${BUNDLE_ID} ${MARKETING} already current"
  exit 0
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  warn "AFC has no origin remote configured — leaving manifest edit staged but uncommitted"
  exit 0
fi

COMMIT_MSG="version-manifest: ${BUNDLE_ID} ${MARKETING}${BUILD_NUM:+ (build ${BUILD_NUM})}"
if ! git -C "$AFC_ROOT" -c user.name="BotFleet iOS Ship" -c user.email="ship@botfleet.local" \
      commit --only -m "$COMMIT_MSG" -- "$MANIFEST_REL" >/dev/null 2>&1; then
  warn "AFC commit failed — manifest staged but not pushed"
  exit 0
fi

if ! git -C "$AFC_ROOT" push origin "${DEFAULT_BRANCH}" >/dev/null 2>&1; then
  warn "AFC push failed — manifest committed locally on ${DEFAULT_BRANCH}; rerun after auth"
  exit 0
fi

log "version-manifest: published ${BUNDLE_ID} ${MARKETING}"
