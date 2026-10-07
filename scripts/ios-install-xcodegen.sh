#!/usr/bin/env bash
# Installs XcodeGen for hosted iOS builds. projectFormat requires >= 2.45.0.
set -euo pipefail

min_version="2.45.0"

version_ge() {
  local have="$1" need="$2"
  [[ "$(printf '%s\n' "$need" "$have" | sort -V | head -1)" == "$need" ]]
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
