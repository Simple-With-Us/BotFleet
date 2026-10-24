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
GATE_PORT="${GATE_PORT:-8798}"
TS_HTTPS_PORT="${TS_HTTPS_PORT:-8799}"

# The Tailscale logins allowed to reach the harness, comma separated.
# May be empty: the desktop gate token is a second owner credential, and the
# token alone is enough.
OWNER_LOGINS="${OWNER_LOGINS:-}"

# The desktop gate token.  A tagged Tailscale device (a tag:prod Mac) gets
# no Tailscale-User-Login header, so the desktop app presents this token
# instead.  The token lives in this file, owner-only; only its sha256 goes
# into gate.env.
DESKTOP_TOKEN_FILE="${BF_ROOT}/config/desktop-token"

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

# The sha256 of a file, as 64 lowercase hex characters.
sha256_of_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | cut -d' ' -f1
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | cut -d' ' -f1
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | sed 's/.*= *//'
    return 0
  fi
  if [ -x "$BF_ROOT/node/bin/node" ]; then
    "$BF_ROOT/node/bin/node" -e '
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const digest = crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
      process.stdout.write(digest);
    ' "$path"
    return 0
  fi
  return 1
}

# A random hex token.  openssl is the usual source; node's crypto is the
# fallback for a host without openssl.
generate_random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if [ -x "$BF_ROOT/node/bin/node" ]; then
    "$BF_ROOT/node/bin/node" -e '
      process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"));
    '
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
    return 0
  fi
  return 1
}

# The desktop gate token: the second owner credential.  A tagged Tailscale
# device (a tag:prod Mac) gets no Tailscale-User-Login header, so the
# desktop app presents this token instead.
#
# The token is written owner-only and is never echoed to the terminal, into a
# log line or into a dry-run preview.  The file holds the token and nothing
# else, with no trailing newline, so the sha256 of the file is the sha256 of
# the token the client sends.
ensure_desktop_token() {
  local path="$1"
  if [ -s "$path" ]; then
    return 0
  fi
  local token
  if ! token="$(generate_random_token)" || [ -z "$token" ]; then
    die "could not generate a desktop gate token: install openssl or node on this host"
  fi
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    note "would generate a desktop gate token in ${path} (mode 0600)"
    unset token
    return 0
  fi
  # The token goes straight from the generator to the file.  It is never
  # printed, so it cannot end up in a transcript or a log.
  local tmp="${path}.tmp"
  (umask 077 && printf '%s' "$token" >"$tmp")
  chmod 0600 "$tmp"
  chown "$BF_USER:$BF_GROUP" "$tmp"
  mv -f "$tmp" "$path"
  unset token
}

# Set one KEY=VALUE line in an env file, leaving every other line as it is.
# The file is rewritten through a temporary file and renamed over the
# original, so the mode (0640) and the owner survive the edit and a crash
# cannot leave a truncated env file behind.
set_env_value() {
  local path="$1" key="$2" value="$3"
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    note "would set ${key} in ${path}"
    return 0
  fi
  local tmp="${path}.tmp"
  if [ -f "$path" ]; then
    awk -v k="$key" -v v="$value" '
      index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
      { print }
    ' "$path" >"$tmp"
  else
    : >"$tmp"
  fi
  if ! grep -q "^${key}=" "$tmp" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 0640 "$tmp"
  chown "$BF_USER:$BF_GROUP" "$tmp"
  mv -f "$tmp" "$path"
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
