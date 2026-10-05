#!/usr/bin/env bash
#
# sync-cli-credentials.sh - Sync host developer CLI credentials to Local VM or Cloud VPS.
#
# Copies local developer credentials (Infisical, SSH, Git, Docker, Cloud, NPM,
# Cargo, etc.) into a virtual machine container so tools and agents running
# inside the VM inherit active authentication without interactive logins.
#
# Designed for use by any fleet seat (Instinct, Muse, Claude, Monet, AG, etc.)
# or human operator across any machine.
#
# PURE ASCII ONLY (Mac bash 3.2 compatibility).

set -euo pipefail

TARGET="auto"
CONTAINER=""
SSH_ALIAS=""
SRC_HOME="${HOME:-}"
CONTAINER_USER="cua"
DRY_RUN=0
QUIET=0
JSON_OUTPUT=0

usage() {
  cat <<'EOF'
Usage: sync-cli-credentials.sh [OPTIONS]

Copies host developer CLI credentials into a Local VM or Cloud VPS container.

Options:
  -t, --target <local|vps|all>   Target environment:
                                  local: Local VM container (default: botfleet-computer)
                                  vps:   Cloud VPS container (default: botfleet-vps-shared)
                                  all:   Sync to both local and VPS containers
                                 (default: auto-detect from active config/containers)
  -c, --container <name>         Container name override
  -a, --alias <ssh-alias>        SSH host alias for VPS (default: read from config.json)
      --home <path>              Source home directory override (default: $HOME)
  -u, --user <name>              Container user (default: cua)
  -n, --dry-run                  List credential items without copying
  -q, --quiet                    Suppress non-essential progress output
      --json                     Print summary as JSON
  -h, --help                     Show this help

Examples:
  sync-cli-credentials.sh --target vps
  sync-cli-credentials.sh --target local
  sync-cli-credentials.sh --target all
  sync-cli-credentials.sh --alias production-vps --container botfleet-vps-shared
  sync-cli-credentials.sh --container custom-vm-container --dry-run
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--target)
      TARGET="${2:-}"
      shift 2
      ;;
    -c|--container)
      CONTAINER="${2:-}"
      shift 2
      ;;
    -a|--alias)
      SSH_ALIAS="${2:-}"
      shift 2
      ;;
    --home)
      SRC_HOME="${2:-}"
      shift 2
      ;;
    -u|--user)
      CONTAINER_USER="${2:-}"
      shift 2
      ;;
    -n|--dry-run)
      DRY_RUN=1
      shift
      ;;
    -q|--quiet)
      QUIET=1
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$SRC_HOME" ] || [ ! -d "$SRC_HOME" ]; then
  echo "Error: Source home directory '$SRC_HOME' not found." >&2
  exit 1
fi

log() {
  if [ "$QUIET" -eq 0 ] && [ "$JSON_OUTPUT" -eq 0 ]; then
    echo "$@"
  fi
}

# Resolve SSH alias from BotFleet config if not provided
resolve_config_alias() {
  local cfg_file="$SRC_HOME/.botfleet/config.json"
  if [ -f "$cfg_file" ]; then
    python3 -c "
import json, sys
try:
    with open('$cfg_file') as f:
        d = json.load(f)
    alias = d.get('vps', {}).get('sshAlias', '')
    if alias:
        sys.stdout.write(alias)
except Exception:
    pass
" 2>/dev/null || true
  fi
}

if [ -z "$SSH_ALIAS" ]; then
  SSH_ALIAS="$(resolve_config_alias)"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARE_GPG_PRIVATE_KEYS="${BOTFLEET_SHARE_GPG_PRIVATE_KEYS:-0}"

# Candidate developer credentials to sync (manifest-driven)
FOUND=()
TAR_ROOT=""
CREDENTIAL_PLAN="$(
  cd "$REPO_ROOT" && SRC_HOME="$SRC_HOME" SHARE_GPG_PRIVATE_KEYS="$SHARE_GPG_PRIVATE_KEYS" node --experimental-strip-types - <<'NODE'
import { prepareCredentialSyncWorkspace } from "./server/vm-cli-credentials.ts";
const homeDir = process.env.SRC_HOME ?? "";
const shareGpgPrivateKeys = process.env.SHARE_GPG_PRIVATE_KEYS === "1";
const { plan } = await prepareCredentialSyncWorkspace(homeDir, { shareGpgPrivateKeys });
const root = plan.stagingDir ?? homeDir;
const rels = [...new Set([...plan.archiveRelPaths, ...plan.stagedRelPaths])].sort();
console.log(JSON.stringify({ root, rels }));
NODE
)" || { echo "Error: manifest-driven credential discovery failed." >&2; exit 1; }
TAR_ROOT="$(printf '%s' "$CREDENTIAL_PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["root"])')"

cleanup_staging() {
  if [ -n "$TAR_ROOT" ] && [ "$TAR_ROOT" != "$SRC_HOME" ] && [ -d "$TAR_ROOT" ]; then
    rm -rf "$TAR_ROOT"
  fi
}
trap cleanup_staging EXIT
trap 'cleanup_staging; exit 130' INT
trap 'cleanup_staging; exit 143' TERM

while IFS= read -r rel; do
  [ -n "$rel" ] && FOUND+=("$rel")
done <<< "$(printf '%s' "$CREDENTIAL_PLAN" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["rels"]))')"

if [ ${#FOUND[@]} -eq 0 ]; then
  log "No matching CLI credentials found in $SRC_HOME."
  if [ "$JSON_OUTPUT" -eq 1 ]; then
    echo '{"ok":true,"synced":[],"message":"No credentials found"}'
  fi
  exit 0
fi

log "Found ${#FOUND[@]} developer credential item(s) in $SRC_HOME:"
for item in "${FOUND[@]}"; do
  log "  - $item"
done

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] Would sync ${#FOUND[@]} items without modifying containers."
  if [ "$JSON_OUTPUT" -eq 1 ]; then
    ITEMS_JSON=$(printf '%s\n' "${FOUND[@]}" | python3 -c 'import sys, json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
    echo "{\"ok\":true,\"dryRun\":true,\"items\":$ITEMS_JSON}"
  fi
  exit 0
fi

# Auto-detect target if not specified
if [ "$TARGET" = "auto" ]; then
  if [ -n "$CONTAINER" ]; then
    if [ -n "$SSH_ALIAS" ]; then
      TARGET="vps"
    else
      TARGET="local"
    fi
  elif [ -n "$SSH_ALIAS" ]; then
    TARGET="vps"
  else
    TARGET="local"
  fi
fi

sync_to_container() {
  local mode="$1" # "local" or "vps"
  local c_name="$2"
  local host_alias="${3:-}"

  local docker_cmd=("docker")
  if [ "$mode" = "vps" ]; then
    if [ -z "$host_alias" ]; then
      echo "Error: VPS target requested but no SSH alias provided or found in config." >&2
      return 1
    fi
    docker_cmd=("docker" "-H" "ssh://$host_alias")
  else
    # On local, fall back to podman if docker is not installed
    if ! command -v docker >/dev/null 2>&1 && command -v podman >/dev/null 2>&1; then
      docker_cmd=("podman")
    fi
  fi

  # Verify container is running
  local is_running
  is_running="$("${docker_cmd[@]}" inspect --format '{{.State.Running}}' "$c_name" 2>/dev/null || echo "false")"
  if [ "$is_running" != "true" ]; then
    echo "Error: Container '$c_name' (${mode}) is not running." >&2
    return 1
  fi

  log "Syncing ${#FOUND[@]} credential path(s) to '$c_name' ($mode)..."

  # Stream tar archive into container (staged docker/gnupg transforms use TAR_ROOT)
  COPYFILE_DISABLE=1 tar --format=ustar -C "$TAR_ROOT" --no-xattrs \
    --exclude="*/virtenv*" \
    --exclude="*/agent/*" \
    --exclude="*.sock" \
    --exclude="*cm-*" \
    --exclude="*.DS_Store" \
    -cf - \
    "${FOUND[@]}" | \
    "${docker_cmd[@]}" exec -i -u "$CONTAINER_USER" "$c_name" tar -xf - -C "/home/$CONTAINER_USER"

  # Harden permissions inside container
  "${docker_cmd[@]}" exec -u "$CONTAINER_USER" "$c_name" sh -c "
    for d in .ssh .infisical .aws .config .azure .oci .kube .cargo .cf .kodus; do
      if [ -d \"/home/$CONTAINER_USER/\$d\" ]; then
        chmod 700 \"/home/$CONTAINER_USER/\$d\" 2>/dev/null || true
      fi
    done
    if [ -d \"/home/$CONTAINER_USER/.ssh\" ]; then
      chmod 600 /home/$CONTAINER_USER/.ssh/id_* /home/$CONTAINER_USER/.ssh/known_hosts* /home/$CONTAINER_USER/.ssh/config 2>/dev/null || true
    fi
  "

  log "Successfully synced credentials to '$c_name' ($mode)."
  return 0
}

SYNCED_TARGETS=()

if [ "$TARGET" = "vps" ] || [ "$TARGET" = "all" ]; then
  VPS_CONTAINER="${CONTAINER:-botfleet-vps-shared}"
  if sync_to_container "vps" "$VPS_CONTAINER" "$SSH_ALIAS"; then
    SYNCED_TARGETS+=("vps:$VPS_CONTAINER")
  fi
fi

if [ "$TARGET" = "local" ] || [ "$TARGET" = "all" ]; then
  if [ -n "$CONTAINER" ]; then
    LOCAL_CONTAINER="$CONTAINER"
  else
    USER_CLEAN="$(echo "${USER:-$(whoami)}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-' | sed 's/^-//;s/-$//')"
    DEFAULT_LOCAL_CONTAINER="botfleet-computer-${USER_CLEAN:-user}"
    LOCAL_CONTAINER="$DEFAULT_LOCAL_CONTAINER"
    for check_cmd in "docker" "podman"; do
      if command -v "$check_cmd" >/dev/null 2>&1; then
        if "$check_cmd" inspect --format '{{.State.Running}}' "$DEFAULT_LOCAL_CONTAINER" 2>/dev/null | grep -q "true"; then
          LOCAL_CONTAINER="$DEFAULT_LOCAL_CONTAINER"
          break
        elif "$check_cmd" inspect --format '{{.State.Running}}' "botfleet-computer" 2>/dev/null | grep -q "true"; then
          LOCAL_CONTAINER="botfleet-computer"
          break
        fi
      fi
    done
  fi
  if sync_to_container "local" "$LOCAL_CONTAINER"; then
    SYNCED_TARGETS+=("local:$LOCAL_CONTAINER")
  fi
fi

if [ "$JSON_OUTPUT" -eq 1 ]; then
  ITEMS_JSON=$(printf '%s\n' "${FOUND[@]}" | python3 -c 'import sys, json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
  # bash 3.2 (macOS) crashes on "${EMPTY[@]}" under set -u; the + guard
  # expands to nothing when no target synced, and printf then emits one
  # blank line that the python filter drops -> "targets":[].
  TARGETS_JSON=$(printf '%s\n' ${SYNCED_TARGETS[@]+"${SYNCED_TARGETS[@]}"} | python3 -c 'import sys, json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
  echo "{\"ok\":true,\"synced\":$ITEMS_JSON,\"targets\":$TARGETS_JSON}"
fi
