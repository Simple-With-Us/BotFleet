#!/usr/bin/env bash
# Vercel Ignored Build Step.  Exit 0 skips the build.  Exit 1 (or greater) builds.
#
# Automatic git deploys:
#   - skip every preview
#   - skip when this commit did not change site files (effort logs / STATUS /
#     iOS / docs-only merges must not ship the website)
#   - production at most once per 3 hours (stops agent spam even when they keep
#     touching CSS/copy)
# Manual: VERCEL_FORCE_DEPLOY=1, or Dashboard Redeploy with Ignore Build Step unchecked.
set -euo pipefail

if [[ "${VERCEL_FORCE_DEPLOY:-}" == "1" ]]; then
  echo "force deploy"
  exit 1
fi

if [[ "${VERCEL_ENV:-}" != "production" ]]; then
  echo "skip preview auto-deploy"
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# Nested scripts (site/, web/, apps/site) watch their own folder.
# A repo-root script (DealDex) watches the tree minus native/docs/CI.
watch_args=()
if [[ -n "${VERCEL_IGNORE_WATCH:-}" ]]; then
  # shellcheck disable=SC2206
  watch_args=(${VERCEL_IGNORE_WATCH})
elif [[ -n "$git_root" && "$script_dir" != "$git_root" ]]; then
  rel="${script_dir#"$git_root"/}"
  # ":top" anchors to the repo root on purpose.  A bare "$rel" would resolve
  # against the working directory, which IS this folder under Vercel, so it
  # would match nothing and mislead the next reader.
  watch_args=(":(top)${rel}")
else
  watch_args=(
    .
    ":(exclude)docs"
    ":(exclude)native"
    ":(exclude)ios"
    ":(exclude)android"
    ":(exclude).github"
    ":(exclude)Apps"
    ":(exclude)*.xcodeproj"
    ":(exclude)STATUS.md"
    ":(exclude)docs/EFFORT-LOG.md"
    ":(exclude)PLAN.md"
  )
fi

site_changed() {
  local before after rc
  after="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
  if [[ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ]]; then
    before="${VERCEL_GIT_PREVIOUS_SHA}"
  elif git rev-parse --verify --quiet HEAD^ >/dev/null; then
    before="HEAD^"
  else
    echo "no previous commit; treat as site changed"
    return 0
  fi
  set +e
  git diff --quiet "$before" "$after" -- "${watch_args[@]}"
  rc=$?
  set -e
  # 0 = identical, 1 = changed, 2 = git error (shallow clone, missing sha)
  if [[ "$rc" -eq 0 ]]; then
    return 1
  fi
  if [[ "$rc" -eq 1 ]]; then
    return 0
  fi
  echo "git diff failed (rc $rc); treat as site changed"
  return 0
}

if ! site_changed; then
  echo "skip production: no site-file changes (${watch_args[*]})"
  exit 0
fi

# Missing credentials or a failed status query must not silently bypass the
# production cooldown. Vercel treats exit 0 from the ignore step as "skip".
# Use VERCEL_FORCE_DEPLOY=1 for an intentional manual override.
if [[ -z "${VERCEL_TOKEN:-}" || -z "${VERCEL_PROJECT_ID:-}" ]]; then
  echo "skip production: cooldown cannot be checked (missing VERCEL_TOKEN or VERCEL_PROJECT_ID)"
  exit 0
fi

team="${VERCEL_ORG_ID:-}"
qs="projectId=${VERCEL_PROJECT_ID}&target=production&state=READY&limit=1"
if [[ -n "$team" ]]; then
  qs="${qs}&teamId=${team}"
fi
if ! created=$(curl -fsS -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  "https://api.vercel.com/v6/deployments?${qs}" \
  | python3 -c "import json,sys
d=json.load(sys.stdin)
deps=d['deployments']
if not isinstance(deps,list): raise ValueError('deployments is not a list')
created=deps[0]['created'] if deps else 0
if type(created) is not int or created < 0: raise ValueError('invalid deployment time')
print(created)" 2>/dev/null); then
  echo "skip production: cooldown cannot be checked (Vercel API failure)"
  exit 0
fi
now_ms=$(python3 -c "import time; print(int(time.time()*1000))")
if [[ "$created" -gt 0 ]]; then
  age=$(( (now_ms - created) / 1000 ))
  if [[ "$age" -lt 10800 ]]; then
    echo "skip production: last deploy ${age}s ago (one per 3 hours)"
    exit 0
  fi
fi

echo "build production"
exit 1
