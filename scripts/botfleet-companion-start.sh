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
  log "stop requested"
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