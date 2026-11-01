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
exec "$node_bin" "--max-old-space-size=$heap" --experimental-strip-types "$code_root/server/index.ts" --require-data-volume >>"$runtime_root/logs/server.log" 2>&1
