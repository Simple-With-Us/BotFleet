#!/usr/bin/env bash
# Bump the iOS version pair to the repo's commit count, and regenerate the
# Xcode project.
#
#   MARKETING_VERSION        1.0.<commit_count>
#   CURRENT_PROJECT_VERSION  <commit_count>
#
# Usage:
#   scripts/bump-ios-version.sh
#
# The build-number scheme is shared with ios/project.yml and the fleet ship
# script (scripts/ios-fleet/ship-testflight.sh).  Both numbers come from the
# repo's commit count, so MARKETING and BUILD_NUM always describe one number.
# UTC YYYYMMDDHHMM stamps are retired.
#
# The pair must strictly increase: App Store Connect rejects a CFBundleVersion
# that does not increase, so this script refuses a commit count that is not
# greater than the one already recorded.
#
# The recorded value is a floor input for the ship script, not the source of
# truth for what ships next, so it must stay below the commit count of any
# commit that can ship.  It does: this bump is committed ON TOP of the commit
# it names, so the shipping commit always counts one higher.
set -euo pipefail
cd "$(dirname "$0")/../ios"

die() { echo "error: $*" >&2; exit 1; }

repo_root="$(cd .. && pwd)"
commit_count="$(git -C "$repo_root" rev-list --count HEAD 2>/dev/null || true)"
[[ "$commit_count" =~ ^[0-9]+$ ]] \
  || die "cannot read the commit count of $repo_root"

current_marketing=$(grep -m1 'MARKETING_VERSION:' project.yml | awk -F'"' '{print $2}')
current_build=$(grep -m1 'CURRENT_PROJECT_VERSION:' project.yml | awk -F'"' '{print $2}')

next_marketing="1.0.${commit_count}"
next_build="${commit_count}"

if [[ "$current_build" =~ ^[0-9]+$ ]] && (( commit_count <= 10#$current_build )); then
  die "build number $next_build is not greater than the current $current_build; commit before bumping"
fi

echo "Bumping iOS version $current_marketing ($current_build) -> $next_marketing ($next_build)"

# Both targets carry the same pair of settings; /g keeps them in step.
sed -i '' "s/MARKETING_VERSION: \".*\"/MARKETING_VERSION: \"$next_marketing\"/g" project.yml
sed -i '' "s/CURRENT_PROJECT_VERSION: \".*\"/CURRENT_PROJECT_VERSION: \"$next_build\"/g" project.yml

# BotFleet.xcodeproj is gitignored; project.yml is the only file to commit.
xcodegen generate
