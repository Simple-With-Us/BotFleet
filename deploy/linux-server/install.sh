#!/bin/bash
# Install the BotFleet harness and its owner gate on a Linux host.
#
# The harness runs headless as the service user, every file it writes lives
# under the fleet volume, and the only way in is a Tailscale serve URL that
# carries an owner credential: a Tailscale login for user-owned devices, or
# the desktop gate token for tagged ones.  See README.md for the security
# model.
#
# The script is idempotent: run it again to repair or re-point an install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/linux-server/common.sh
. "$SCRIPT_DIR/common.sh"

DRY_RUN=0
ORIGINAL_ARGS=("$@")

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run]

  --dry-run  Print every action instead of running it.

Environment overrides: BF_USER, BF_GROUP, BF_ROOT, BF_CODE, BF_REPO, BF_REF,
NODE_VERSION, TS_HTTPS_PORT, GATE_PORT, OWNER_LOGINS.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

require_root "${ORIGINAL_ARGS[@]}"

# --------------------------------------------------------------------------
# (a) The runtime root and the checkout must live on the fleet volume.
# --------------------------------------------------------------------------

say "checking the target paths"
require_under_volume "$BF_ROOT" "BF_ROOT"
require_under_volume "$BF_CODE" "BF_CODE"
note "root: $BF_ROOT"
note "code: $BF_CODE"

# --------------------------------------------------------------------------
# (b) The service account, the directory tree and its ownership.
# --------------------------------------------------------------------------

say "creating the runtime tree under $BF_ROOT"
for dir in home data logs tmp config workdir node; do
  run mkdir -p "$BF_ROOT/$dir"
done
run mkdir -p "$PNPM_STORE_DIR"

if ! getent group "$BF_GROUP" >/dev/null 2>&1; then
  say "creating the group $BF_GROUP"
  run groupadd "$BF_GROUP"
fi
if ! id -u "$BF_USER" >/dev/null 2>&1; then
  say "creating the service user $BF_USER"
  run useradd --home-dir "$BF_ROOT/home" --shell /bin/bash --gid "$BF_GROUP" --no-create-home "$BF_USER"
fi

run chown "$BF_USER:$BF_GROUP" "$BF_ROOT" "$BF_ROOT/home" "$BF_ROOT/data" "$BF_ROOT/logs" \
  "$BF_ROOT/tmp" "$BF_ROOT/config" "$BF_ROOT/workdir" "$BF_ROOT/node"
run chmod 2770 "$BF_ROOT" "$BF_ROOT/home" "$BF_ROOT/data" "$BF_ROOT/logs" \
  "$BF_ROOT/tmp" "$BF_ROOT/config" "$BF_ROOT/workdir" "$BF_ROOT/node"
# The pnpm store is shared by every host on the fleet volume and is owned by
# root:fleet, so it is created when it is missing and never re-owned here.

# The service home is on the volume, so seed its git identity from the
# account's real home once.  Later edits to either file stay independent.
user_home="$(getent passwd "$BF_USER" | cut -d: -f6 || true)"
if [ ! -f "$BF_ROOT/home/.gitconfig" ] && [ -n "$user_home" ] && [ -f "$user_home/.gitconfig" ]; then
  say "seeding $BF_ROOT/home/.gitconfig from $user_home/.gitconfig"
  run install -m 0640 -o "$BF_USER" -g "$BF_GROUP" "$user_home/.gitconfig" "$BF_ROOT/home/.gitconfig"
fi

# --------------------------------------------------------------------------
# (c) Node, verified against the published checksums.
# --------------------------------------------------------------------------

node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "" ;;
  esac
}

install_node() {
  local arch version tarname base tmpdir
  arch="$(node_arch)"
  if [ -z "$arch" ]; then
    die "no Node build for this architecture: $(uname -m)"
  fi
  version="v${NODE_VERSION}"
  base="https://nodejs.org/dist/${version}"
  tarname="node-${version}-linux-${arch}.tar.xz"

  say "installing Node ${version} (${arch}) into ${BF_ROOT}/node"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would download ${base}/${tarname}"
    note "would verify its sha256 against ${base}/SHASUMS256.txt"
    note "would unpack it into ${BF_ROOT}/node"
    return 0
  fi

  tmpdir="$(mktemp -d)"
  curl -fsSL "${base}/SHASUMS256.txt" -o "${tmpdir}/SHASUMS256.txt"
  curl -fsSL "${base}/${tarname}" -o "${tmpdir}/${tarname}"
  if ! (cd "$tmpdir" && grep " ${tarname}\$" SHASUMS256.txt | sha256sum -c -); then
    rm -rf "$tmpdir"
    die "the checksum of ${tarname} does not match SHASUMS256.txt"
  fi
  tar -xJf "${tmpdir}/${tarname}" --strip-components=1 -C "$BF_ROOT/node"
  rm -rf "$tmpdir"
  chown -R "$BF_USER:$BF_GROUP" "$BF_ROOT/node"
}

if [ -x "$BF_ROOT/node/bin/node" ] && [ "$("$BF_ROOT/node/bin/node" --version 2>/dev/null || true)" = "v${NODE_VERSION}" ]; then
  say "Node v${NODE_VERSION} is already installed"
else
  install_node
fi

# --------------------------------------------------------------------------
# (d) The checkout, detached at the ref we deploy.
# --------------------------------------------------------------------------

if [ -d "$BF_CODE/.git" ]; then
  say "updating the checkout in $BF_CODE"
  run as_user git -C "$BF_CODE" fetch origin
else
  say "cloning $BF_REPO into $BF_CODE"
  if [ -n "$BF_REFERENCE_REPO" ]; then
    run as_user git clone --reference-if-able "$BF_REFERENCE_REPO" --dissociate "$BF_REPO" "$BF_CODE"
  else
    run as_user git clone "$BF_REPO" "$BF_CODE"
  fi
fi

if [ -d "$BF_CODE/.git" ]; then
  dirty="$(as_user git -C "$BF_CODE" status --porcelain || true)"
  if [ -n "$dirty" ]; then
    die "the checkout in $BF_CODE has local changes; commit or stash them first"
  fi
  run as_user git -C "$BF_CODE" checkout --detach "origin/$BF_REF"
fi

# --------------------------------------------------------------------------
# (e) Dependencies and the built UI, as the service user.
# --------------------------------------------------------------------------

say "installing dependencies and building the UI"
run as_user corepack enable --install-directory "$BF_ROOT/node/bin"
run as_user sh -c "cd '$BF_CODE' && pnpm install --frozen-lockfile --store-dir '$PNPM_STORE_DIR'"
run as_user sh -c "cd '$BF_CODE' && pnpm exec vite build"

# --------------------------------------------------------------------------
# (f) The environment files.  No secrets live here.
# --------------------------------------------------------------------------

if [ ! -f "$BF_ROOT/config/server.env" ]; then
  say "writing $BF_ROOT/config/server.env"
  write_file "$BF_ROOT/config/server.env" 0640 <<EOF
# BotFleet harness environment for the Linux server.
# No secrets live in this file.  Secrets come from Infisical (INFISICAL.md)
# and from the engine CLIs' own login files under the service user's home.
# OMB_DATA_DIR, OMB_STATIC_DIR and OMB_PORT are set by the systemd unit.
EOF
else
  say "keeping the existing $BF_ROOT/config/server.env"
fi

# The desktop gate token is the second owner credential.  A tagged Tailscale
# device (a tag:prod Mac) gets no Tailscale-User-Login header, so the desktop
# app presents this token instead.  It is generated once and then kept: a
# re-run of the installer never rotates it behind the app's back.
say "checking the desktop gate token"
ensure_desktop_token "$DESKTOP_TOKEN_FILE"

token_sha256="$(sha256_of_file "$DESKTOP_TOKEN_FILE" || true)"
if [ -z "$token_sha256" ]; then
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    # A dry run does not create the token, so there is nothing to hash yet.
    token_sha256="<the sha256 of the token generated at install time>"
  else
    die "could not compute the sha256 of $DESKTOP_TOKEN_FILE"
  fi
fi

# At least one owner credential has to exist.  The desktop token counts on its
# own, so OWNER_LOGINS may be empty.
if [ -z "$OWNER_LOGINS" ] && [ ! -s "$DESKTOP_TOKEN_FILE" ] && [ "${DRY_RUN:-0}" -eq 0 ]; then
  die "no owner credential: set OWNER_LOGINS to the comma-separated list of Tailscale logins allowed to reach the harness, or keep the desktop gate token in $DESKTOP_TOKEN_FILE"
fi

if [ -n "$OWNER_LOGINS" ] || [ ! -f "$BF_ROOT/config/gate.env" ]; then
  dns_name="$(tailscale_dns_name || true)"
  if [ -z "$dns_name" ]; then
    dns_name="$(hostname -f 2>/dev/null || hostname)"
    note "could not read the tailnet DNS name; using $dns_name for the public origin"
  fi
  say "writing $BF_ROOT/config/gate.env"
  write_file "$BF_ROOT/config/gate.env" 0640 <<EOF
# BotFleet owner gate.  Only the listed Tailscale logins and the holder of
# the desktop gate token may reach the harness.
BOTFLEET_GATE_HOST=127.0.0.1
BOTFLEET_GATE_PORT=${GATE_PORT}
BOTFLEET_HARNESS_PORT=${HARNESS_PORT}
BOTFLEET_OWNER_LOGINS=${OWNER_LOGINS}
BOTFLEET_GATE_TOKEN_SHA256=${token_sha256}
BOTFLEET_PUBLIC_ORIGIN=https://${dns_name}:${TS_HTTPS_PORT}
EOF
else
  say "keeping the existing $BF_ROOT/config/gate.env"
  # The gate keeps only the hash of the token, so the hash line has to keep
  # matching the token file even when the rest of the file is left alone.
  set_env_value "$BF_ROOT/config/gate.env" "BOTFLEET_GATE_TOKEN_SHA256" "$token_sha256"
fi

# --------------------------------------------------------------------------
# (g) The systemd units.
# --------------------------------------------------------------------------

render_unit() {
  local src="$1"
  local dst="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "would render ${src} into ${dst}"
    return 0
  fi
  sed -e "s|@BF_USER@|$BF_USER|g" \
    -e "s|@BF_GROUP@|$BF_GROUP|g" \
    -e "s|@BF_ROOT@|$BF_ROOT|g" \
    -e "s|@BF_CODE@|$BF_CODE|g" \
    -e "s|@NODE_BIN@|$BF_ROOT/node/bin/node|g" \
    "$src" >"$dst"
  chmod 0644 "$dst"
}

say "installing the systemd units"
render_unit "$SCRIPT_DIR/botfleet-server.service.in" "/etc/systemd/system/$SERVER_UNIT"
render_unit "$SCRIPT_DIR/botfleet-owner-gate.service.in" "/etc/systemd/system/$GATE_UNIT"
run systemctl daemon-reload
run systemctl enable --now "$SERVER_UNIT" "$GATE_UNIT"

# --------------------------------------------------------------------------
# (h) The tailnet URL.  Serve is tailnet only.  Never Funnel: Funnel is
# public and adds no identity header, which would leave the gate without an
# owner check at all.
# --------------------------------------------------------------------------

say "publishing the tailnet URL on port $TS_HTTPS_PORT"
note "Tailscale Serve stays inside the tailnet.  Never enable Funnel."
run tailscale serve --bg "--https=${TS_HTTPS_PORT}" "http://127.0.0.1:${GATE_PORT}"

# --------------------------------------------------------------------------
# (i) Health and the final state.
# --------------------------------------------------------------------------

say "waiting for the harness to answer"
if [ "$DRY_RUN" -eq 1 ]; then
  note "would wait for http://127.0.0.1:${HARNESS_PORT}/api/health"
  exit 0
fi
if wait_for_health "$HARNESS_PORT"; then
  note "the harness is healthy on 127.0.0.1:${HARNESS_PORT}"
else
  die "the harness did not answer http://127.0.0.1:${HARNESS_PORT}/api/health within 60s; check $BF_ROOT/logs/server.log"
fi

dns_name="$(tailscale_dns_name || true)"
if [ -n "$dns_name" ]; then
  say "the harness is reachable at https://${dns_name}:${TS_HTTPS_PORT}"
else
  say "the harness is reachable through the tailnet URL on port ${TS_HTTPS_PORT}"
fi
note "$SERVER_UNIT: $(systemctl is-active "$SERVER_UNIT" || true)"
note "$GATE_UNIT: $(systemctl is-active "$GATE_UNIT" || true)"
say "the desktop gate token is ready"
note "read it with: sudo cat $DESKTOP_TOKEN_FILE"
note "paste it into the desktop app's server target file as \"token\", then set \"mode\" to \"remote\" and restart the app"
say "done"
