#!/usr/bin/env bash
# Cursor cloud install for BotFleet (plumber/cursor-cloud-env).
# Runs once per agent build; MUST be idempotent on Ubuntu Linux.
#
# macOS / iOS / Electron packaging and Xcode steps are Mac-only and are
# intentionally skipped -- a Cursor cloud session runs on Linux and has
# no use for the helper plists, .app bundles, or TestFlight ship pipeline.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

log() { printf '[cursor-cloud-install] %s\n' "$*"; }

# 1.  Corepack + pnpm 10.33.0 -- the value pinned by package.json#packageManager.
#     `corepack enable` is a no-op once the shim is on PATH; `corepack prepare`
#     with --activate is a no-op once that exact version is the active one.
log "Enabling corepack and preparing pnpm@10.33.0."
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10.33.0 --activate >/dev/null 2>&1 || true
else
  # Fall back to npm-global pnpm only when corepack itself is unavailable
  # (very old compose-latest snapshots).  This branch is rare; the success
  # path is corepack.
  log "corepack not found; falling back to npm install -g pnpm@10.33.0."
  npm install -g pnpm@10.33.0 >/dev/null 2>&1 || true
fi

# 2.  Install workspace dependencies with the frozen lockfile so the agent
#     gets the exact graph the repo was authored against.
log "Running pnpm install --frozen-lockfile."
pnpm install --frozen-lockfile

# 3.  Skip macOS / iOS / Electron packaging:
#     - electron-builder mac targets need a macOS host.
#     - scripts/ios-ship-testflight.sh drives xcodebuild + xcrun simctl.
#     - The recorder/speech helper Info.plist tweaks are build-time only.
log "Skipping macOS / iOS / Electron packaging steps (Mac-only)."

log "Install complete."