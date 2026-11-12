#!/usr/bin/env bash
# Print the NUL-delimited list of paths this pull request changed.
#
# The pull request's own two ends are the branch point and the head.  The
# stored base SHA is the base branch's tip at the last synchronisation of the
# pull request,  and the merge commit is built on a newer tip,  so a diff from
# the base SHA to the merge commit folds every one of main's newer commits
# into the pull request's scope:  a one-file documentation change then looked
# like an iOS change and paid for a hosted macOS runner and a hosted xcode-27
# runner,  the scarcest capacity on the plan.  Measured on PR #1518,  the
# classifier saw 17 changed files instead of 1.
#
# Usage: ci-scope-diff.sh <base_sha> <head_sha>
#
# Prints the changed paths to stdout,  NUL delimited,  and exits 0.  Exits
# non-zero and prints nothing when the scope cannot be established,  so the
# caller can fail open the way it already does.
set -euo pipefail

base_sha="${1:-}"
head_sha="${2:-}"

if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ ]] || [[ "$base_sha" =~ ^0+$ ]]; then
  echo "ERROR: the base SHA is not a commit." >&2
  exit 1
fi
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]] || [[ "$head_sha" =~ ^0+$ ]]; then
  echo "ERROR: the head SHA is not a commit." >&2
  exit 1
fi
if ! git cat-file -e "${base_sha}^{commit}"; then
  echo "ERROR: the base commit is not in this checkout." >&2
  exit 1
fi
if ! git cat-file -e "${head_sha}^{commit}"; then
  echo "ERROR: the head commit is not in this checkout." >&2
  exit 1
fi

scope_base="$(git merge-base "$base_sha" "$head_sha")"
if [[ ! "$scope_base" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: the branch point could not be computed." >&2
  exit 1
fi

git diff --no-renames --name-only -z "$scope_base" "$head_sha"
