#!/bin/bash
# LaunchAgent entry for app.botfleet.companion.
#
# Starts the detached companion runtime, exits 0 when :8810 is already healthy,
# and never starts a second sidecar. The health probe below is what makes the
# KeepAlive restart loop safe: launchd re-runs this script whenever the job
# exits, and the usual exit is "the sidecar is already up", not "start another".
#
# Why this is a separate job from app.botfleet.server: the harness is
# loopback-only and deliberately unpatched, while the companion is the one
# process here that listens off-machine. Keeping the companion out of the
# harness is a security property, and the reverse -- letting the companion die
# with a GUI -- is BF-1339.
#
# A companion process is also the opt-in for the hosted surface (see
# companion/src/index.ts), so this script treats "already healthy" as success
# and "cannot verify" as a failure that stops rather than loops.
set -euo pipefail

ROOT="${BOTFLEET_COMPANION_ROOT:-$HOME/apps/botfleet-companion}"
# The runtime root is the release store's pointer, not a git checkout.
#
# A checkout is a mutable working tree: a seat's branch can delete files the
# sidecar still imports, and an update rewrites the tree under a running
# process.  A promoted release is immutable and named by the commit it holds,
# and the pointer at ~/.botfleet/current is the only thing that moves when
# the sidecar changes version.  The pointer wins when it exists;
# BOTFLEET_COMPANION_ROOT still overrides it, and the legacy checkout path
# stays the fallback for a machine that has never promoted a release.
if [ -z "${BOTFLEET_COMPANION_ROOT:-}" ]; then
  # The COMPANION's own store, not the harness's.  The two version
  # independently: one pointer would mean swapping the server's release
  # changes what the sidecar runs, and vice versa, with no way to roll one
  # back without the other.
  COMPANION_STORE_POINTER="$HOME/.botfleet-companion/current"
  if [ -e "$COMPANION_STORE_POINTER" ] || [ -L "$COMPANION_STORE_POINTER" ]; then
    ROOT="$COMPANION_STORE_POINTER"
  fi
fi
# The published runtime claim, at the path electron/managed-companion-runtime.mjs
# writes (`managedCompanionRuntimePath`): the supervisor publishes its verified
# identity there so the desktop app can adopt the sidecar.  `--stop` removes it,
# mirroring `clearManagedCompanionRuntime` in that module.
RUNTIME_CLAIM="$HOME/.botfleet-companion/runtime/supervisor.json"
PORT="${BOTFLEET_COMPANION_PORT:-8810}"
CONTROL_PORT="${BOTFLEET_COMPANION_CONTROL_PORT:-8811}"
HARNESS_PORT="${BOTFLEET_HARNESS_PORT:-8799}"
NODE="${BOTFLEET_NODE:-/opt/homebrew/bin/node}"
PREFIX="[botfleet-companion-start]"

log() {
  echo "$PREFIX $*"
}

log_err() {
  echo "$PREFIX $*" >&2
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [--stop]

  --stop  Remove the published runtime claim and exit without starting.
EOF
}

# The hosted route lands on the companion's own port, so this is the check that
# actually means "a phone can reach this Mac". It asks for the companion
# identity rather than accepting any 200.
health() {
  /usr/bin/curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null |
    /usr/bin/grep -q '"app"[[:space:]]*:[[:space:]]*"botfleet"'
}

STOP=false
if [ "${1:-}" = "--stop" ]; then
  STOP=true
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
elif [ "$#" -gt 0 ]; then
  log_err "unknown argument: $1"
  usage >&2
  exit 2
fi

if [ "$STOP" = true ]; then
  # Remove the published runtime claim, mirroring clearManagedCompanionRuntime:
  # only the exact regular file the supervisor publishes, never a symlink or
  # anything else at that path.  An absent claim is already the stopped state,
  # so a second --stop is a no-op rather than an error.  A symlink or
  # non-regular file there is not a claim any reader would accept either, so
  # leave it alone and say so instead of removing a file we did not publish.
  if [ -L "$RUNTIME_CLAIM" ]; then
    log "stop requested; $RUNTIME_CLAIM is a symlink, not a published runtime claim; leaving it alone"
  elif [ -f "$RUNTIME_CLAIM" ] && [ ! -O "$RUNTIME_CLAIM" ]; then
    log "stop requested; $RUNTIME_CLAIM is not owned by the current user, so it is not a claim this user published; leaving it alone"
  elif [ -f "$RUNTIME_CLAIM" ]; then
    rm -f "$RUNTIME_CLAIM"
    log "stop requested; removed the published runtime claim at $RUNTIME_CLAIM"
  elif [ -e "$RUNTIME_CLAIM" ]; then
    log "stop requested; $RUNTIME_CLAIM is not a regular file, so it is not a published runtime claim; leaving it alone"
  else
    log "stop requested; no published runtime claim at $RUNTIME_CLAIM"
  fi
  exit 0
fi

if health; then
  log ":${PORT} already serving the companion; not starting a second sidecar"
  exit 0
fi

if [ ! -f "$ROOT/electron/managed-companion-supervisor.mjs" ]; then
  log_err "missing $ROOT/electron/managed-companion-supervisor.mjs"
  log_err "The detached companion checkout is missing or stale. Restore it with:"
  log_err "  git clone --branch main https://github.com/Simple-With-Us/BotFleet.git $ROOT"
  exit 1
fi

if [ ! -x "$NODE" ]; then
  log_err "missing node at $NODE"
  exit 1
fi

# The supervisor allocates its own private origin socket per generation and
# publishes the verified identity; nothing here needs to know either value.
cd "$ROOT"
exec "$NODE" "$ROOT/electron/managed-companion-supervisor.mjs" \
  --harness-port "$HARNESS_PORT"