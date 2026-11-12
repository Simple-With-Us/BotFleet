#!/usr/bin/env bash
# Probe the installed Claude CLI's slash commands in -p stream-json mode, in a
# sandbox, and record the frames as fixtures.  Run by hand; never part of CI.
#
#   scripts/probe-engine-commands.sh [--cli PATH] [--out DIR]
#
# Why it exists: forwarding an arbitrary slash command to the CLI can change the
# owner's global settings (a bare "/advisor opus" rewrote advisorModel), so a
# command is only ever shown or sent once a recorded probe has proven it works
# here without touching anything.  The probe runs the CLI with:
#
#   - HOME, CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME in a fresh mktemp directory
#     (removed on exit), and a fresh working folder, so nothing real is read
#     or written;
#   - no credential of any kind in its environment.  A command that needs the
#     model therefore cannot be proven here, and stays off the allowlist until
#     someone supplies a scoped, revocable key for the probe.
#
# It stats the real settings files before and after.  A moved ~/.claude/settings.json
# fails the probe.  ~/.claude.json is also printed, but it is the CLI's own state
# file and any Claude Code session running on this Mac rewrites it, so a change
# there is information, not failure.
set -euo pipefail

REAL_HOME="${HOME:?HOME must be set}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CLI="$(command -v claude || true)"
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cli) CLI="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CLI" ] || { echo "no claude binary on PATH; pass --cli PATH" >&2; exit 2; }

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo missing; }

VERSION="$("$CLI" --version 2>/dev/null | head -1 | awk '{print $1}')"
[ -n "$VERSION" ] || { echo "could not read the CLI version" >&2; exit 2; }
[ -n "$OUT" ] || OUT="$REPO/server/drivers/__fixtures__/engine-commands/claude/$VERSION"

SETTINGS_BEFORE="$(mtime "$REAL_HOME/.claude/settings.json")"
STATE_BEFORE="$(mtime "$REAL_HOME/.claude.json")"
echo "real settings.json mtime before: $SETTINGS_BEFORE"
echo "real .claude.json mtime before:  $STATE_BEFORE"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/config" "$TMP/xdg" "$TMP/cwd"

# Everything below sees only the throwaway directories.
status=0
(
  export HOME="$TMP/home" CLAUDE_CONFIG_DIR="$TMP/config" XDG_CONFIG_HOME="$TMP/xdg"
  cd "$REPO"
  node scripts/probe-engine-commands.mjs "$CLI" "$OUT" "$TMP/cwd"
) || status=$?

SETTINGS_AFTER="$(mtime "$REAL_HOME/.claude/settings.json")"
STATE_AFTER="$(mtime "$REAL_HOME/.claude.json")"
echo "real settings.json mtime after:  $SETTINGS_AFTER"
echo "real .claude.json mtime after:   $STATE_AFTER"

if [ "$SETTINGS_BEFORE" != "$SETTINGS_AFTER" ]; then
  echo "FAIL: the real ~/.claude/settings.json changed during the probe" >&2
  exit 1
fi
if [ "$STATE_BEFORE" != "$STATE_AFTER" ]; then
  echo "note: ~/.claude.json changed; another Claude Code session on this Mac writes it" >&2
fi
exit "$status"
