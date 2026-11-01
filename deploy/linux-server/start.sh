#!/bin/sh
# Check storage before opening the application's append log, then run the
# harness with the vault token from config/harness-infisical-token when the
# environment does not already carry one.
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: start.sh /absolute/runtime-root /absolute/code /absolute/node" >&2
  exit 2
fi
runtime_root="$1"
code_root="$2"
node_bin="$3"
for path in "$runtime_root" "$code_root" "$node_bin"; do
  case "$path" in /*) ;; *) echo "startup paths must be absolute" >&2; exit 2;; esac
done
# Node derives its default V8 heap from the cgroup's memory.high, which
# fleet-coding-memory lowers dynamically: a 1.3 GB ceiling at boot yielded a
# 256 MB heap and the server died with "Reached heap limit" in node:sqlite
# StatementSync::All while loading.  Pin the heap with an explicit flag so
# the cgroup cannot shrink it.  A command-line flag beats NODE_OPTIONS here
# because Datadog's APM injector appends --require to NODE_OPTIONS.
heap="${BF_NODE_HEAP_MB:-6144}"
case "$heap" in
  ''|*[!0-9]*) echo "BF_NODE_HEAP_MB must be an integer 512..65536, got: $heap" >&2; exit 2;;
esac
stripped="$heap"
while [ -n "$stripped" ] && [ "${stripped#0}" != "$stripped" ]; do stripped="${stripped#0}"; done
if [ -z "$stripped" ]; then stripped="0"; fi
if [ "${#stripped}" -gt 5 ] || [ "$stripped" -lt 512 ] || [ "$stripped" -gt 65536 ]; then
  echo "BF_NODE_HEAP_MB must be an integer 512..65536, got: $heap" >&2
  exit 2
fi
heap="$stripped"
"$node_bin" "$runtime_root/bin/check-storage.mjs" "$runtime_root/data"
# The harness vault token: a read-only Infisical service token in
# config/harness-infisical-token (mode 0600, owned by the service user), read
# only when the environment does not already set INFISICAL_TOKEN.  It is
# exported to the server exec below and nowhere else: never echoed, never on
# argv.  Anything wrong with the file is one stderr line naming the file and
# the reason, and the server starts without it.
harness_token_file="$runtime_root/config/harness-infisical-token"
if [ -z "${INFISICAL_TOKEN:-}" ]; then
  if [ -e "$harness_token_file" ] || [ -L "$harness_token_file" ]; then
    harness_token_reason=""
    if [ -L "$harness_token_file" ]; then
      harness_token_reason="it is a symlink"
    elif [ ! -f "$harness_token_file" ]; then
      harness_token_reason="it is not a regular file"
    else
      harness_token_owner="$(stat -c '%u' "$harness_token_file" 2>/dev/null || stat -f '%u' "$harness_token_file" 2>/dev/null || true)"
      if [ -z "$harness_token_owner" ]; then
        harness_token_reason="its ownership cannot be determined"
      elif [ "$harness_token_owner" != "$(id -u)" ]; then
        harness_token_reason="it is not owned by the current user"
      else
        harness_token_mode="$(stat -c '%a' "$harness_token_file" 2>/dev/null || stat -f '%Lp' "$harness_token_file" 2>/dev/null || true)"
        case "$harness_token_mode" in
          *00|0) : ;;
          "") harness_token_reason="its permissions cannot be determined" ;;
          *) harness_token_reason="it has group or other permission bits (mode $harness_token_mode)" ;;
        esac
      fi
    fi
    if [ -n "$harness_token_reason" ]; then
      echo "start.sh: not using $harness_token_file: $harness_token_reason" >&2
    elif harness_token="$(cat "$harness_token_file" 2>/dev/null)"; then
      harness_token_cr="$(printf '\r')"
      harness_token="${harness_token%"$harness_token_cr"}"
      if [ -z "$harness_token" ]; then
        echo "start.sh: ignoring $harness_token_file: it is empty" >&2
      else
        INFISICAL_TOKEN="$harness_token"
        export INFISICAL_TOKEN
      fi
      unset harness_token harness_token_cr
    else
      echo "start.sh: not using $harness_token_file: it cannot be read" >&2
    fi
    unset harness_token_file harness_token_reason harness_token_owner harness_token_mode
  fi
fi
exec "$node_bin" "--max-old-space-size=$heap" --experimental-strip-types "$code_root/server/index.ts" --require-data-volume >>"$runtime_root/logs/server.log" 2>&1
