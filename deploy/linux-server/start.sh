#!/bin/sh
# Check storage before opening the application's append log.
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
"$node_bin" "$runtime_root/bin/check-storage.mjs" "$runtime_root/data"
exec "$node_bin" --experimental-strip-types "$code_root/server/index.ts" --require-data-volume >>"$runtime_root/logs/server.log" 2>&1
