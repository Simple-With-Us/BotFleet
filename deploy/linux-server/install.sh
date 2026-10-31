#!/bin/bash
# Install the BotFleet harness and its owner gate on a Linux host.
#
# The harness runs headless as the service user, every file it writes lives
# under the fleet volume, and the only way in is a Tailscale serve URL that
# carries an owner credential: a Tailscale login for user-owned devices, or
# the desktop gate token for tagged ones.  See README.md for the security
# model.
#
# The owner gate reads its whole configuration from Infisical, so this script
# never writes a gate configuration file: the only local item it insists on is
# the read-only Infisical service token the gate bootstraps with.
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
NODE_VERSION, TS_HTTPS_PORT.
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
for dir in home data logs tmp var-tmp config workdir node bin; do
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
  "$BF_ROOT/tmp" "$BF_ROOT/var-tmp" "$BF_ROOT/config" "$BF_ROOT/workdir" "$BF_ROOT/node" "$BF_ROOT/bin"
run chmod 2770 "$BF_ROOT" "$BF_ROOT/home" "$BF_ROOT/data" "$BF_ROOT/logs" \
  "$BF_ROOT/tmp" "$BF_ROOT/var-tmp" "$BF_ROOT/config" "$BF_ROOT/workdir" "$BF_ROOT/node" "$BF_ROOT/bin"
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
# The root compiler rewrites dependency exports; cached installs need independent copies and lifecycle execution.
run as_user sh -c "cd '$BF_CODE' && pnpm install --frozen-lockfile --force --package-import-method=copy --config.optimistic-repeat-install=false --store-dir '$PNPM_STORE_DIR'"
run as_user sh -c "cd '$BF_CODE' && pnpm exec vite build"

# --------------------------------------------------------------------------
# (f) The configuration files.  No secrets live here.
# --------------------------------------------------------------------------

# The harness launch parameters still live in a local env file.  Moving them
# into Infisical is tracked as a follow-up; the gate is already there.
if [ ! -f "$BF_ROOT/config/server.env" ]; then
  say "writing $BF_ROOT/config/server.env"
  write_file "$BF_ROOT/config/server.env" 0640 <<EOF
# BotFleet harness environment for the Linux server.
# No secrets live in this file.  Secrets come from Infisical (INFISICAL.md)
# and from the engine CLIs' own login files under the service user's home.
# OMB_DATA_DIR, OMB_STATIC_DIR and OMB_PORT are set by the systemd unit.
EOF
else
  say "keeping the existing $BF_ROOT/config/server.env"
fi

# The owner gate reads its configuration from Infisical: the BotFleet project,
# the prod environment, the /botfleet-server path.  The only local item is the
# bootstrap, a read-only Infisical service token.
say "checking the Infisical read token"
require_infisical_read_token "$INFISICAL_READ_TOKEN_FILE"

# The gate used to read a local env file and a local desktop token.  Neither
# is read any more.  The files are left exactly as they are: deleting them is
# the owner's call, once the values are in Infisical.
for old_file in "$BF_ROOT/config/gate.env" "$BF_ROOT/config/desktop-token"; do
  if [ -e "$old_file" ]; then
    note "migration: $old_file is no longer read by the gate."
    note "  after BOTFLEET_SERVER_GATE_TOKEN, BOTFLEET_OWNER_LOGINS and BOTFLEET_PUBLIC_ORIGIN are in Infisical (BotFleet, prod, /botfleet-server), delete it."
  fi
done

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
  "$BF_ROOT/node/bin/node" --experimental-strip-types "$SCRIPT_DIR/render-resources.mjs" --write-unit "$(basename "$src")"
}

say "installing the systemd units"
for helper in start.sh check-storage.mjs; do
  run install -m 0755 -o "$BF_USER" -g "$BF_GROUP" "$SCRIPT_DIR/$helper" "$BF_ROOT/bin/$helper"
done
export BF_VOLUME BF_ROOT BF_CODE BF_USER BF_GROUP
if [ "$DRY_RUN" -eq 1 ]; then
  run "$BF_ROOT/node/bin/node" --experimental-strip-types "$SCRIPT_DIR/render-resources.mjs" --dry-run
else
  "$BF_ROOT/node/bin/node" --experimental-strip-types "$SCRIPT_DIR/render-resources.mjs" --write
fi
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
say "the owner gate reads its configuration from Infisical"
note "BotFleet, prod, /botfleet-server: BOTFLEET_OWNER_LOGINS, BOTFLEET_PUBLIC_ORIGIN, BOTFLEET_SERVER_GATE_TOKEN"
note "the desktop app reads BOTFLEET_SERVER_MODE, BOTFLEET_SERVER_URL and BOTFLEET_SERVER_GATE_TOKEN from the same place"
say "done"
