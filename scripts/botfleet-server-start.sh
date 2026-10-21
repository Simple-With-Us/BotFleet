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

# BF-2456 (owner decision, 2026-10-18): the operator fleet is on, so role
# bots launch with their BF-<ROLE> seat (AGENT_LAUNCH_SEAT) and the matching
# seat prompt. Without this, launchIdentityFor returns a null seat and every
# BF role starts seatless. An explicit operator value still wins.
export BOTFLEET_FLEET_SEAT_PROMPTS="${BOTFLEET_FLEET_SEAT_PROMPTS-1}"

ROOT="${BOTFLEET_SERVER_ROOT:-$HOME/apps/botfleet-server}"
# The runtime root is the release store's pointer, not a git checkout.
#
# A checkout is a mutable working tree: an update rewrote it under a live
# server, a seat's branch deleted files the harness still imported, and a
# janitor removed its node_modules from under a serving process.  A promoted
# release is immutable and named by the commit it holds, and the pointer at
# ~/.botfleet/current is the only thing that changes when the harness moves
# to a new version.
#
# The pointer wins when it exists.  BOTFLEET_SERVER_ROOT still overrides it
# (tests point it at a fixture), and the legacy checkout path stays the
# fallback for a machine that has never promoted a release, so nothing
# breaks on a fresh install.
if [ -z "${BOTFLEET_SERVER_ROOT:-}" ]; then
  STORE_POINTER="$HOME/.botfleet/current"
  if [ -e "$STORE_POINTER" ] || [ -L "$STORE_POINTER" ]; then
    ROOT="$STORE_POINTER"
  fi
fi
# `current` is a symlink into ~/.botfleet/releases/<commit>.  Resolve it once,
# physically, so every later path is the real directory: `cd -P` means the
# server's own working directory is the release rather than the pointer, which
# matters because the updater's dependency fingerprint and bundle identity checks
# both refuse a symlinked root, and because two processes that disagree about
# which path they are in cannot be compared.
# If this fails, do NOT let `set -e` abort here: at this point in the script
# fail_or_stop_storm does not exist yet, so an abort here would exit non-zero
# with no ledger record and no operator message -- the one failure that bypasses
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
  # `current` pointer, because `test -d` follows symlinks -- so the branch above
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

# The "stopped on purpose" sentinel, written by POST /api/system/shutdown.
#
# Without it there is no such thing as a quiet shutdown on this Mac.  The
# launchd agent carries KeepAlive.SuccessfulExit=false and StartInterval=300,
# so a clean exit is not resurrected by the first pair of settings -- but the
# five-minute tick still runs this script, a closed port still reads as a
# crash, and the harness comes back.  Whoever turned the server off would find
# it on again a few minutes later with nothing in the logs to explain it.
#
# Exiting 0 here is what keeps the tick quiet: SuccessfulExit=false means
# launchd leaves a clean exit alone, and the periodic run stays the cheap health
# check it is documented to be.
#
# Only the launchd path respects the marker.  A person running this script by
# hand is asking for the server, so that clears the marker and starts -- which
# is the recovery path when someone stops it and then changes their mind.
SHUTDOWN_MARKER="${BOTFLEET_SHUTDOWN_MARKER:-${OMB_DATA_DIR:-$HOME/.botfleet}/stopped.marker}"
STARTUP_DISABLED_MARKER="${BOTFLEET_STARTUP_DISABLED_MARKER:-${OMB_DATA_DIR:-$HOME/.botfleet}/startup-disabled.marker}"
STARTUP_ENABLED_MARKER="${BOTFLEET_STARTUP_ENABLED_MARKER:-${OMB_DATA_DIR:-$HOME/.botfleet}/startup-enabled.marker}"
STARTUP_SESSION="${BOTFLEET_STARTUP_SESSION:-${OMB_DATA_DIR:-$HOME/.botfleet}/startup-session}"
LAUNCHD_SERVICE_NAME="${XPC_SERVICE_NAME:-}"

boot_session() {
  if [ -n "${BOTFLEET_BOOT_SESSION_OVERRIDE:-}" ]; then
    printf '%s' "$BOTFLEET_BOOT_SESSION_OVERRIDE"
  else
    /usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null
  fi
}

# The V1 policy is opt-in until the installed wrapper has been upgraded.
honour_startup_policy() {
  # BF_CONTROL_STARTUP_POLICY_V1.  Marker absence preserves the original
  # launchd behaviour; no environment opt-in is needed by installed users.
  if invoked_by_launchd && [ ! -f "$STARTUP_DISABLED_MARKER" ] && [ ! -f "$STARTUP_ENABLED_MARKER" ]; then return 0; fi
  local current recorded
  current="$(boot_session)" || { log_err "cannot read boot session"; exit 1; }
  [ -n "$current" ] || { log_err "boot session is empty"; exit 1; }
  if ! invoked_by_launchd; then
    mkdir -p "$(dirname "$STARTUP_SESSION")"
    printf '%s\n' "$current" >"$STARTUP_SESSION"
    return 0
  fi
  recorded="$(cat "$STARTUP_SESSION" 2>/dev/null || true)"
  if [ -f "$STARTUP_DISABLED_MARKER" ] && [ "$recorded" != "$current" ]; then
    log "startup is disabled at login; leaving the stopped marker unchanged"
    exit 0
  fi
  # Explicit login enablement outranks a stop from a PREVIOUS boot only.
  # On this boot an intentional Stop must remain durable through every tick.
  if [ ! -f "$STARTUP_DISABLED_MARKER" ] && [ -f "$STARTUP_ENABLED_MARKER" ] && [ "$recorded" != "$current" ]; then
    mkdir -p "$(dirname "$STARTUP_SESSION")"
    printf '%s\n' "$current" >"$STARTUP_SESSION"
    rm -f "$SHUTDOWN_MARKER"
    log "startup is enabled at login; starting for this boot"
  fi
}

# True when launchd invoked us rather than a person.
invoked_by_launchd() {
  [ -n "$LAUNCHD_SERVICE_NAME" ]
}

# Exit 0 if the harness was stopped on purpose.  Returns 1 to carry on.
honour_shutdown_marker() {
  [ -f "$SHUTDOWN_MARKER" ] || return 1
  if ! invoked_by_launchd; then
    log "stopped.marker present but this run is not from launchd; treating it as a deliberate start"
    rm -f "$SHUTDOWN_MARKER"
    return 1
  fi
  log "stopped.marker present ($SHUTDOWN_MARKER); the harness was shut down on purpose and stays down."
  log "Delete that file, or launch the BotFleet app, to let it come back."
  exit 0
}

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
  # The store validates the manifest before treating a directory as a release
  # (unknown keys, a non-SHA commit, and an unparseable promotedAt are all
  # rejected).  A bare existence test is weaker than that contract: a truncated
  # manifest would permanently disable the in-place self-heal for an ordinary
  # checkout and print an empty commit to the operator.  Require the commit field
  # to be a full lowercase SHA, the part that is actually load-bearing.
  [ -f "$ROOT/.botfleet-release.json" ] || return 1
  local commit
  commit="$(manifest_commit)"
  printf '%s' "$commit" | grep -Eq '^[a-f0-9]{40}$'
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
  # Probe packages the harness loads at boot -- not only yaml -- plus the config
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

# Before anything else: a deliberate stop is a deliberate stop, even when the
# harness happens to still be healthy.  Checking it ahead of the health
# shortcut is what makes the marker authoritative rather than advisory.
#
# `|| true` is load-bearing under `set -e`: the function returns 1 to mean
# "carry on and start the harness", and an unguarded bare call would abort the
# whole script on exactly the ordinary, marker-absent path.  The exit 0 inside
# the function still exits -- that is an `exit`, not a return status.
if [ "$HEAL_ONLY" != true ]; then
  honour_startup_policy
  honour_shutdown_marker || true
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

# --- the Infisical machine identity --------------------------------------
# Recovered through `fleet-secrets get`, and nothing else out of it.
#
# This one credential is deliberately not in the vault -- a lock cannot hold
# its own key -- and not in config.json, which is plaintext, because it can
# read every name in the project.  That leaves exactly one place a
# launchd-started harness can get it, and without it the harness comes up
# "Infisical is not configured" and silently drops every vault-backed
# credential: the speech-to-speech keys, Zulip's per-role keys, the lot.
#
# The desktop app can also replay the identity into a running harness, but
# only while it is attached -- `before-quit` stops the replay on purpose,
# because the always-on harness outlives it.  A crash, an update, or a manual
# restart therefore leaves nothing to restore it, which is exactly when it
# is most needed.
#
# The Node server never calls fleet-secrets.  This wrapper is the launchd entry
# point, and it copies only the machine-identity pair into the environment
# loadConfig() already prefers.  The values are fetched one name at a time
# rather than injected wholesale (`fleet-secrets run` would also refuse every
# INFISICAL_* name):  `ps eww` prints a process environment and Fleet-OPS holds
# every fleet secret, so only the identity belongs in this process.  When both
# halves are already in the environment, nothing is fetched.  A missing helper
# or a failed fetch is not fatal -- the harness still starts, and the desktop
# app can still supply the identity in memory.
#
# The helper is addressed by its absolute path, $HOME/.local/bin/fleet-secrets,
# because a LaunchAgent's PATH is minimal.  It authenticates from the login
# Keychain machine identity (see INFISICAL.md in AI-Fleet-Coordinator).
#
# An empty string must not be exported.  loadConfig() treats a defined env var
# as present (`process.env[name] !== undefined`), so INFISICAL_CLIENT_ID=""
# would hide config.json and the INFISICAL_UNIVERSAL_AUTH_* aliases.  A half
# pair would do the same to one side.  Apply the fetched values only when they
# yield both halves, and only into names that are still empty.  Documented
# keys (INFISICAL_CLIENT_*) win;  the automation names are the fallback.
fleet_secret() {
  local name="$1" bin="$HOME/.local/bin/fleet-secrets"
  # Anything but an executable file is "no identity"; keep going.
  [ -f "$bin" ] && [ -x "$bin" ] || return 0
  # The value goes to stdout only; errors are dropped so no fragment is shown.
  "$bin" get "$name" 2>/dev/null | tr -d '\r' || true
  return 0
}

# First non-empty fetched value among the given names.  Always exits 0 so a
# missing name cannot trip `set -e` and take the harness down with it.
first_fleet_secret() {
  local name value
  for name in "$@"; do
    value="$(fleet_secret "$name")"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

load_infisical_identity() {
  local fetched_id="" fetched_secret=""
  if [ -n "${INFISICAL_CLIENT_ID:-}" ] && [ -n "${INFISICAL_CLIENT_SECRET:-}" ]; then
    export INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET
    return 0
  fi
  [ -f "$HOME/.local/bin/fleet-secrets" ] && [ -x "$HOME/.local/bin/fleet-secrets" ] || return 0
  fetched_id="$(first_fleet_secret INFISICAL_CLIENT_ID INFISICAL_AUTOMATION_CLIENT_ID)"
  fetched_secret="$(first_fleet_secret INFISICAL_CLIENT_SECRET INFISICAL_AUTOMATION_CLIENT_SECRET)"
  if [ -n "$fetched_id" ] && [ -n "$fetched_secret" ]; then
    if [ -z "${INFISICAL_CLIENT_ID:-}" ]; then
      INFISICAL_CLIENT_ID="$fetched_id"
    fi
    if [ -z "${INFISICAL_CLIENT_SECRET:-}" ]; then
      INFISICAL_CLIENT_SECRET="$fetched_secret"
    fi
  fi
  if [ -n "${INFISICAL_CLIENT_ID:-}" ]; then
    export INFISICAL_CLIENT_ID
  fi
  if [ -n "${INFISICAL_CLIENT_SECRET:-}" ]; then
    export INFISICAL_CLIENT_SECRET
  fi
}

load_infisical_identity

cd "$ROOT"
exec "$NODE" --experimental-strip-types server/index.ts
