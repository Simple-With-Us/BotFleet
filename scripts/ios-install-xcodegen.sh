#!/usr/bin/env bash
# Installs XcodeGen for hosted iOS builds. projectFormat requires >= 2.45.0.
set -euo pipefail

min_version="2.45.0"

# Pure bash so it does not depend on `sort -V` (GNU extension).
version_ge() {
  local have="$1" need="$2" i
  local -a h n
  IFS=. read -r -a h <<<"$have"
  IFS=. read -r -a n <<<"$need"
  for i in 0 1 2; do
    local hv="${h[i]:-0}" nv="${n[i]:-0}"
    hv="${hv%%[!0-9]*}"; nv="${nv%%[!0-9]*}"
    hv="${hv:-0}"; nv="${nv:-0}"
    if (( 10#$hv > 10#$nv )); then return 0; fi
    if (( 10#$hv < 10#$nv )); then return 1; fi
  done
  return 0
}

current_version() {
  xcodegen --version 2>&1 | awk '{print $NF}'
}

if ! command -v xcodegen >/dev/null 2>&1; then
  brew install xcodegen
elif ! version_ge "$(current_version)" "$min_version"; then
  brew upgrade xcodegen
fi

have="$(current_version)"
if ! version_ge "$have" "$min_version"; then
  echo "::error::xcodegen >= ${min_version} required (have ${have}) for projectFormat in ios/project.yml" >&2
  exit 1
fi

echo "xcodegen ${have}"
