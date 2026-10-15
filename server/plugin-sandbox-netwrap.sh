#!/bin/sh
# Drop loopback in a fresh network namespace, then exec the plugin sandbox
# Node child.  Linux only; spawned under `unshare --net` from plugin-loader.
set -eu
if command -v ip >/dev/null 2>&1; then
  ip link set dev lo down 2>/dev/null || true
fi
exec "$@"
