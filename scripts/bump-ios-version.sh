#!/usr/bin/env bash
# Bump the iOS version pair recorded in ios/project.yml to the repo's commit
# count, and regenerate the Xcode project.
#
#   MARKETING_VERSION        1.0.<commit_count>   (the project's declared
#                                                    default, NOT the shipped
#                                                    marketing version)
#   CURRENT_PROJECT_VERSION  <commit_count>       (the build number)
#
# Usage:
#   scripts/bump-ios-version.sh
#
# The build-number scheme is shared with ios/project.yml and the fleet ship
# script (scripts/ios-fleet/ship-testflight.sh).  Since the owner directive of
# 2026-10-24 (AFC-517) the two numbers are INDEPENDENT:  the shipped marketing
# version is the next patch on the app's App Store Connect train (the ship
# script passes it to xcodebuild and overrides whatever is recorded here), and
# the shipped build number is the commit count, raised above the App Store
# Connect floor when it has to be.  UTC YYYYMMDDHHMM stamps are retired.
#
# What this script writes is therefore the PROJECT's declared value, not what
# ships:  the project file is not a sequencing input any more, and the ship
# script prints a NOTICE when the recorded value and the shipped value
# disagree.
#
# The build number must strictly increase: App Store Connect rejects a
# CFBundleVersion that does not increase, so this script refuses a commit count
# that is not greater than the one already recorded.
#
# The recorded build number must stay below the commit count of any commit
# that can ship, so it is never the build number a real ship would use.  It
# does: this bump is committed ON TOP of the commit it names, so the shipping
# commit always counts one higher.
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
