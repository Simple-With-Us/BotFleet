#!/bin/bash
# Shared defaults for the BotFleet Linux server deploy scripts.
#
# Sourced by install.sh, update.sh and uninstall.sh.  Every value can be
# overridden from the environment, so a second host can use another root
# without editing a script.

# The fleet volume.  Everything the harness writes has to live under it.
BF_VOLUME="${BF_VOLUME:-/mnt/fleet-extra}"

# The service account and its group.
BF_USER="${BF_USER:-jay}"
BF_GROUP="${BF_GROUP:-fleet}"

# The runtime root (home, data, logs, config, workdir) and the code checkout.
BF_ROOT="${BF_ROOT:-$BF_VOLUME/apps/botfleet-server}"
BF_CODE="${BF_CODE:-$BF_VOLUME/Code/BotFleet-server}"

# The upstream repository and the ref to deploy.
BF_REPO="${BF_REPO:-https://github.com/Simple-With-Us/BotFleet.git}"
BF_REF="${BF_REF:-main}"

# An optional local clone the checkout borrows objects from.  Off by default:
# a partial (blob:none) clone cannot serve as a reference and fails the clone.
BF_REFERENCE_REPO="${BF_REFERENCE_REPO:-}"

# Node, the pnpm store, and the ports.
NODE_VERSION="${NODE_VERSION:-24.18.0}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$BF_VOLUME/.pnpm-store}"
HARNESS_PORT="${HARNESS_PORT:-8799}"
TS_HTTPS_PORT="${TS_HTTPS_PORT:-8799}"

# The owner gate's port is fixed in code (deploy/linux-server/owner-gate.mjs):
# the gate is a loopback listener in front of a loopback harness, and there is
# nothing about it to configure.  `tailscale serve` has to point at exactly
# that port.
GATE_PORT="8798"

# The Infisical service token the owner gate bootstraps with.  This is the ONE
# local item: a read-only Infisical service token, scoped to the BotFleet
# project, the prod environment and the /botfleet-server path.  The gate reads
# its whole configuration from the vault; the token is only the key to it.
INFISICAL_READ_TOKEN_FILE="${BF_ROOT}/config/infisical-read-token"

# The systemd units.
SERVER_UNIT="botfleet-server.service"
GATE_UNIT="botfleet-owner-gate.service"

say() {
  printf '==> %s\n' "$*"
}

note() {
  printf '    %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Run a command, or print what would run when --dry-run is set.
run() {
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    note "would run: $*"
    return 0
  fi
  "$@"
}

# Write a file from stdin, or print it when --dry-run is set.
write_file() {
  local path="$1"
  local mode="${2:-0640}"
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    note "would write ${path} (mode ${mode}):"
    sed 's/^/      /'
    return 0
  fi
  cat >"$path"
  chmod "$mode" "$path"
  chown "$BF_USER:$BF_GROUP" "$path"
}

# Run a command as the service user, with the service user's home and PATH.
as_user() {
  runuser -u "$BF_USER" -- env "HOME=$BF_ROOT/home" "PATH=$BF_ROOT/node/bin:$PATH" "$@"
}

# Refuse to install without the Infisical read token, and say exactly how to
# create it.  The token never touches argv and never reaches the shell
# history: it is read from the terminal without echo and written straight
# into the file by the service user.
#
# The file has to be a regular file (a symlink is refused), mode 0600 and
# owned by the service user: it is the key to the vault, and the gate refuses
# anything else.
require_infisical_read_token() {
  local path="$1"
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    note "would check $path (a regular file, mode 0600, owned by $BF_USER)"
    return 0
  fi

  local problem=""
  local mode=""
  local owner=""

  if [ -L "$path" ]; then
    problem="it is a symlink"
  elif [ ! -e "$path" ]; then
    problem="it does not exist"
  elif [ ! -f "$path" ]; then
    problem="it is not a regular file"
  else
    mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || echo "")"
    owner="$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null || echo "")"
    if [ "$mode" != "600" ]; then
      problem="its mode is ${mode:-unknown}, not 600"
    elif [ -n "$owner" ] && [ "$owner" != "$(id -u "$BF_USER" 2>/dev/null || echo "")" ]; then
      problem="it is not owned by $BF_USER"
    fi
  fi

  if [ -z "$problem" ]; then
    say "the Infisical read token is in place"
    return 0
  fi

  local message
  message="$(cat <<EOF
the Infisical read token $path cannot be used: $problem

Create it with a read-only Infisical service token scoped to the BotFleet project, the prod environment and the /botfleet-server path.  The token is read from the terminal without echo, so it never reaches argv or the shell history:

  sudo install -m 600 -o $BF_USER -g $BF_GROUP /dev/null $BF_ROOT/config/infisical-read-token && sudo -u $BF_USER bash -c 'IFS= read -rs t && printf %s "\$t" > '"$BF_ROOT"'/config/infisical-read-token'
EOF
)"
  die "$message"
}

# Refuse to run unless we are root, re-executing with sudo when that is possible.
require_root() {
  if [ "$(id -u)" -eq 0 ]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    say "re-executing as root with sudo"
    exec sudo -E bash "$0" "$@"
  fi
  die "this script must run as root; re-run it with: sudo $0 $*"
}

# Refuse a path that is not under the fleet volume.
require_under_volume() {
  local path="$1"
  local label="$2"
  case "$path" in
    "$BF_VOLUME"/*) return 0 ;;
    *) die "$label must live under $BF_VOLUME: $path" ;;
  esac
}

# The tailnet DNS name of this host, without the trailing dot.
tailscale_dns_name() {
  local json name
  json="$(tailscale status --self --json 2>/dev/null || true)"
  if [ -z "$json" ]; then
    return 1
  fi
  if [ -x "$BF_ROOT/node/bin/node" ]; then
    name="$(printf '%s' "$json" | "$BF_ROOT/node/bin/node" -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const j=JSON.parse(s);const n=(j&&j.Self&&j.Self.DNSName)||"";process.stdout.write(String(n).replace(/\.$/,""));}catch(e){process.exit(1);}});')" || return 1
  elif command -v node >/dev/null 2>&1; then
    name="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const j=JSON.parse(s);const n=(j&&j.Self&&j.Self.DNSName)||"";process.stdout.write(String(n).replace(/\.$/,""));}catch(e){process.exit(1);}});')" || return 1
  elif command -v python3 >/dev/null 2>&1; then
    name="$(printf '%s' "$json" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))')" || return 1
  else
    return 1
  fi
  if [ -z "$name" ]; then
    return 1
  fi
  printf '%s' "$name"
}

# Wait for the harness to answer its health route.
wait_for_health() {
  local port="${1:-$HARNESS_PORT}"
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}
