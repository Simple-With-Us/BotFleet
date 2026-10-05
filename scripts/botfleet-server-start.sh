#!/bin/bash
# Tracked copy of the LaunchAgent entry for app.botfleet.server (legacy label
# com.jay.botfleet-server).  Install to ~/apps/botfleet-server-start.sh and
# point the LaunchAgent ProgramArguments at this path after merge.
#
# Starts the detached checkout harness, exits 0 when :8799 is already healthy,
# and self-heals once when node_modules is missing or imports fail with
# ERR_MODULE_NOT_FOUND / Cannot find package.
#
# Log rotation (OP7): launchd owns server.log as this process's
# StandardOutPath/StandardErrorPath for its whole life, so the harness
# itself can never rotate the file out from under its own open file
# descriptor.  This script can: it runs BEFORE exec'ing the harness, when
# nothing holds the path open yet (the health check above already confirmed
# no harness is currently serving), so rotating here is safe.
set -euo pipefail

ROOT="${BOTFLEET_SERVER_ROOT:-$HOME/apps/botfleet-server}"
# `current` is a symlink into ~/.botfleet/releases/<commit>.  Resolve it once,
# physically, so every later path is the real directory: `cd -P` means the
# server's own working directory is the release rather than the pointer, which
# matters because the updater's dependency fingerprint and bundle identity checks
# both refuse a symlinked root, and because two processes that disagree about
# which path they are in cannot be compared.
# If this fails, do NOT let `set -e` abort here: at this point in the script
# fail_or_stop_storm does not exist yet, so an abort here would exit non-zero
# with no ledger record and no operator message — the one failure that bypasses
# the machinery that exists to report failures.  The half-resolved state is
# carried and reported through the real channel below, once that function is
# defined.
ROOT_UNRESOLVED=""
if [ -d "$ROOT" ]; then
  if ! ROOT_RESOLVED="$(cd -P "$ROOT" 2>/dev/null && pwd)"; then
    ROOT_RESOLVED=""
  fi
  if [ -n "$ROOT_RESOLVED" ]; then
    ROOT="$ROOT_RESOLVED"
  else
    ROOT_UNRESOLVED="$ROOT"
  fi
elif [ -L "$ROOT" ] || [ -e "$ROOT" ]; then
  # It exists but is not a directory.  For a symlink root this is a DANGLING
  # `current` pointer, because `test -d` follows symlinks — so the branch above
  # never sees it, and without this the operator gets only preflight's
  # "missing $ROOT/server/index.ts" plus a generic "run pnpm install" that
  # reinstalls IN PLACE and cannot recreate a release that has been deleted.
  # That is the precise misdiagnosis the block above exists to prevent.
  ROOT_UNRESOLVED="$ROOT"
fi
PORT="${BOTFLEET_PORT:-8799}"
NODE="${BOTFLEET_NODE:-/opt/homebrew/bin/node}"
PNPM="${BOTFLEET_PNPM:-pnpm}"
HEAL_MINUTES="${BOTFLEET_HEAL_MINUTES:-15}"
# The heal stamp records "a self-heal was tried recently", so it is MUTABLE state
# and cannot live inside a release directory: a release is read-only by
# construction, and writing there fails on exactly the path that exists to report
# a problem.  One stamp per machine rather than per root, because there is one
# harness and a shared budget is the honest thing: a heal that is too recent for
# one root is too recent for the other too.
STAMP="${BOTFLEET_HEAL_STAMP:-$HOME/Library/Caches/BotFleet/server-start-heal-stamp}"
LOG_FILE="${BOTFLEET_SERVER_LOG:-$HOME/Library/Logs/botfleet/server.log}"
LOG_MAX_BYTES=$((20 * 1024 * 1024))
PREFIX="[botfleet-server-start]"
# Consecutive-failure ledger.  launchd's KeepAlive.SuccessfulExit=false plus
# ThrottleInterval 5 respawns this job every 5-7s forever on any non-zero
# exit, which turns a persistently broken checkout (node_modules deleted by
# the disk janitor, a bad deploy) into a restart storm.  After enough
# consecutive failures inside one rolling window we exit 0 instead, so
# launchd stops; com.jay.mac-process-watch kickstarts the job every 120s
# while health is down, which is the intended slow retry from then on.
FAIL_LEDGER="${BOTFLEET_FAIL_LEDGER:-$HOME/Library/Caches/BotFleet/server-start-failures}"
FAIL_WINDOW_SECONDS="${BOTFLEET_FAIL_WINDOW_SECONDS:-3600}"
FAIL_STORM_THRESHOLD="${BOTFLEET_FAIL_STORM_THRESHOLD:-20}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--heal-only]

  --heal-only  Run dependency self-heal if needed, then exit (no server start).
EOF
}

health() {
  /usr/bin/curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

log() {
  echo "$PREFIX $*"
}

log_err() {
  echo "$PREFIX $*" >&2
}

rotate_log_if_large() {
  [ -f "$LOG_FILE" ] || return 0
  local size
  size=$(/usr/bin/stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
    log "rotating $LOG_FILE (${size} bytes) to server.log.1"
    mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
  fi
}

stamp_recent() {
  if [ ! -f "$STAMP" ]; then
    return 1
  fi
  local last now
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [ "$((now - last))" -lt "$((HEAL_MINUTES * 60))" ]; then
    return 0
  fi
  return 1
}

record_heal_attempt() {
  mkdir -p "$(dirname "$STAMP")"
  date +%s >"$STAMP"
}

# Called on every path that reaches a known-good state: the port already
# answers, or dependencies are confirmed present and the server is about to
# start.  Clears the storm ledger so a later failure starts counting fresh.
reset_fail_ledger() {
  rm -f "$FAIL_LEDGER" 2>/dev/null || true
}

# Record one failed attempt and decide whether the launchd restart loop needs
# to be stopped.  Always exits the script: 1 for an ordinary failure (launchd
# retries again after ThrottleInterval), 0 once $FAIL_STORM_THRESHOLD
# consecutive failures land inside $FAIL_WINDOW_SECONDS (logs the fix once).
fail_or_stop_storm() {
  local now count start
  now="$(date +%s)"
  count=0
  start="$now"
  if [ -f "$FAIL_LEDGER" ]; then
    read -r count start <"$FAIL_LEDGER" 2>/dev/null || { count=0; start="$now"; }
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    case "$start" in ''|*[!0-9]*) start="$now" ;; esac
    if [ "$((now - start))" -gt "$FAIL_WINDOW_SECONDS" ]; then
      count=0
      start="$now"
    fi
  fi
  count=$((count + 1))
  mkdir -p "$(dirname "$FAIL_LEDGER")" 2>/dev/null || true
  printf '%s %s\n' "$count" "$start" >"$FAIL_LEDGER" 2>/dev/null || true
  if [ "$count" -ge "$FAIL_STORM_THRESHOLD" ]; then
    log_err "botfleet-server-start has failed $count times in the last $((FAIL_WINDOW_SECONDS / 60)) minutes; giving up so launchd stops restarting it."
    log_err "FIX: cd $ROOT && $PNPM install --frozen-lockfile   (see the failure logged above for the exact cause)"
    log_err "com.jay.mac-process-watch retries this job every 120s while health is down; that is the intended slow retry now."
    exit 0
  fi
  exit 1
}

needs_module_heal() {
  if [ ! -d "$ROOT/node_modules" ]; then
    return 0
  fi
  if [ ! -e "$ROOT/node_modules/yaml" ]; then
    return 0
  fi
  return 1
}

looks_like_missing_module() {
  local log_file="${1:-}"
  [ -n "$log_file" ] || return 1
  if /usr/bin/grep -Eq 'ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module' "$log_file"; then
    return 0
  fi
  return 1
}

# Is $ROOT a promoted, immutable release?
#
# This is the whole reason self-heal needs a mode.  In a mutable checkout,
# reinstalling dependencies in place is the correct repair: it fixes a
# half-deleted node_modules and gets the harness back up in a minute.  In a
# release directory it is the WRONG repair and a destructive one: the release is
# supposed to be byte-identical to the commit it names, reinstalling mutates it
# into something that is no longer the thing the updater verified, and it
# cannot work at all if the directory is read-only.  The right action there is to
# build a NEW release and swap the pointer, which is the updater's job, not this
# script's.
is_immutable_release() {
  [ -f "$ROOT/.botfleet-release.json" ]
}

run_install_once() {
  if is_immutable_release; then
    # Not a failure to work around: a release with missing dependencies was
    # already broken when it was promoted, and the repair belongs to the updater
    # that promoted it.  Say so, and say what to run.
    log_err "$ROOT is an immutable release (commit $(manifest_commit)), so its dependency tree is not repaired in place."
    log_err "Repairing it here would mutate a verified release into something it was never checked as, and it is read-only anyway."
    log_err "Build a new release instead:  ~/apps/update-botfleet.sh prepare && ~/apps/update-botfleet.sh apply --stage <stage>"
    return 1
  fi
  if stamp_recent; then
    log_err "dependency self-heal already attempted within ${HEAL_MINUTES}m (stamp: $STAMP)"
    log_err "manual fix: cd $ROOT && $PNPM install --frozen-lockfile"
    return 1
  fi
  if ! command -v "$PNPM" >/dev/null 2>&1; then
    log_err "$PNPM not on PATH; cannot self-heal missing node_modules"
    return 1
  fi
  record_heal_attempt
  log "missing dependencies detected; running $PNPM install --frozen-lockfile in $ROOT"
  (cd "$ROOT" && "$PNPM" install --frozen-lockfile)
}

# The commit a release names, for the message above.  Best effort: this only ever
# feeds a log line, and failing to read it must not change the exit behaviour.
manifest_commit() {
  /usr/bin/sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([a-f0-9]*\)".*/\1/p' \
    "$ROOT/.botfleet-release.json" 2>/dev/null | /usr/bin/head -n 1
}

preflight() {
  if [ ! -f "$ROOT/server/index.ts" ]; then
    log_err "missing $ROOT/server/index.ts"
    return 1
  fi
  if [ ! -x "$NODE" ]; then
    log_err "missing node at $NODE"
    return 1
  fi
}

probe_imports() {
  local probe_log
  probe_log="$(mktemp "${TMPDIR:-/tmp}/botfleet-probe.XXXXXX")"
  # Probe packages the harness loads at boot — not only yaml — plus the config
  # module (side-effect free) so a partial install missing any of these still
  # triggers the one-shot heal before exec'ing server/index.ts.
  if (cd "$ROOT" && "$NODE" --experimental-strip-types -e "
    await import('yaml');
    await import('zod');
    await import('./server/config.ts');
  ") >"$probe_log" 2>&1; then
    rm -f "$probe_log"
    return 0
  fi
  if looks_like_missing_module "$probe_log"; then
    log_err "import probe failed with missing-module error:"
    /usr/bin/tail -n 10 "$probe_log" >&2 || true
    rm -f "$probe_log"
    return 1
  fi
  log_err "import probe failed:"
  /usr/bin/tail -n 20 "$probe_log" >&2 || true
  rm -f "$probe_log"
  return 2
}

maybe_heal_dependencies() {
  if needs_module_heal; then
    run_install_once
    return
  fi
  # The probe must run as an if-condition: under `set -e` a bare failing
  # call exits the script before rc is captured and the self-heal below
  # never runs for a partially broken installation.
  local rc=0
  if probe_imports; then
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 1 ]; then
    run_install_once
  elif [ "$rc" -ne 0 ]; then
    fail_or_stop_storm
  fi
}

HEAL_ONLY=false
if [ "${1:-}" = "--heal-only" ]; then
  HEAL_ONLY=true
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
elif [ "$#" -gt 0 ]; then
  log_err "unknown argument: $1"
  usage >&2
  exit 2
fi

# --heal-only must prepare the checkout even when the currently running
# harness is healthy (e.g. during an update while the old process still
# serves).  Skip the healthy-exit shortcut in that mode.
if [ "$HEAL_ONLY" != true ] && health; then
  log ":${PORT} already healthy; not starting a second harness"
  reset_fail_ledger
  exit 0
fi

if [ -n "$ROOT_UNRESOLVED" ]; then
  echo "botfleet-server-start: could not resolve \$ROOT physically: $ROOT_UNRESOLVED" >&2
  echo "botfleet-server-start: the path exists but will not resolve to a real directory." >&2
  echo "botfleet-server-start: that is the signature of a release left half read-only by an" >&2
  echo "  interrupted permission walk, or a release pruned while it was live. Check it with:" >&2
  echo "    ls -ld '$ROOT_UNRESOLVED' && ls -l '$ROOT_UNRESOLVED'" >&2
  echo "botfleet-server-start: fix the permissions or point BOTFLEET_SERVER_ROOT elsewhere." >&2
  fail_or_stop_storm
fi
preflight || fail_or_stop_storm
maybe_heal_dependencies || fail_or_stop_storm

if [ "$HEAL_ONLY" = true ]; then
  log "self-heal complete; --heal-only set, not starting server"
  reset_fail_ledger
  exit 0
fi

if health; then
  log ":${PORT} already healthy after self-heal; not starting a second harness"
  reset_fail_ledger
  exit 0
fi

if needs_module_heal; then
  log_err "node_modules still missing after self-heal attempt"
  fail_or_stop_storm
fi

reset_fail_ledger

# Keeps one prior generation (server.log.1); the harness's own log carries
# no size cap beyond this, so a generation can still be up to LOG_MAX_BYTES.
# Runs last, right before we actually become the writer: every branch above
# this point can still exit without ever touching the log file.
rotate_log_if_large

cd "$ROOT"
exec "$NODE" --experimental-strip-types server/index.ts
