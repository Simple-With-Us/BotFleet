#!/usr/bin/env bash
# Stable protocol-v1 entrypoint. No transaction policy or module list lives on
# the machine. Load its complete helper from immutable, fetched main objects.
# Initial migration from a pre-v1 machine copy is a separate rollout action.
set -euo pipefail
exec 3>&2
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
CHECKOUT="${BOTFLEET_CHECKOUT:-$HOME/apps/botfleet-server}"
CACHE="${BOTFLEET_HELPER_CACHE:-$HOME/Library/Caches/BotFleet/helper}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then echo 'BotFleet bootstrap: Node.js is missing.' >&2; exit 127; fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/botfleet-loader.XXXXXX")"
COMMAND=update
case "${1:-}" in prepare|apply|unquiesce|update) COMMAND="$1" ;; esac
PROGRESS=""; RUN_ID=""; EXPECT=""
for arg in "$@"; do
  if [[ "$EXPECT" == progress ]]; then PROGRESS="$arg"; EXPECT=""; continue; fi
  if [[ "$EXPECT" == run ]]; then RUN_ID="$arg"; EXPECT=""; continue; fi
  case "$arg" in --progress) EXPECT=progress ;; --run-id) EXPECT=run ;; esac
done
# Preserve a transaction's terminal record. If import/bootstrap failed before
# that writer existed, atomically report its actual stderr instead of making
# the harness infer "never started". The controller is a second fallback.
finish() {
  code=$?
  trap - EXIT
  [[ ! -f "$TMP/error.log" ]] || cat "$TMP/error.log" >&3
  if [[ "$code" != 0 && -n "$PROGRESS" && -n "$RUN_ID" ]]; then
    "$NODE" - "$PROGRESS" "$RUN_ID" "$TMP/error.log" "$COMMAND" 2>&3 <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [file, runId, log, command] = process.argv.slice(2);
try {
 let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
 if (!(old?.runId === runId && old.finishedAt && old.outcome)) {
  const now = new Date().toISOString();
  const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(-4000) : '';
  const detail = tail.split('\n').find(line => /Error|failed|fatal:|refusing/i.test(line)) || tail.trim().split('\n').pop() || 'See the updater log.';
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary = file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary, JSON.stringify({schemaVersion:1,runId,command,pid:process.pid,startedAt:old?.startedAt || now,updatedAt:now,finishedAt:now,outcome:'failed',step:'bootstrap',message:'Updater bootstrap failed: '+detail.slice(0,800)})+'\n',{mode:0o600});
  fs.renameSync(temporary,file);
 }
} catch (error) { console.error('Could not record bootstrap failure: '+error.message); }
JS
  fi
  rm -rf "$TMP"
  # Old harnesses use launchctl submit with keep-alive-on-failure. A managed
  # run reports failure in its progress/log channel, never by retrying itself.
  if [[ -n "$PROGRESS" && -n "$RUN_ID" ]]; then exit 0; fi
  exit "$code"
}
trap finish EXIT
# No caller-controlled branch supplies loader code. Policy handles an explicit
# target after validating its ancestry independently, including prepared stages.
{
 git -C "$CHECKOUT" fetch --quiet origin main
 COMMIT="$(git -C "$CHECKOUT" rev-parse --verify 'origin/main^{commit}')"
 [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]
 git -C "$CHECKOUT" merge-base --is-ancestor "$COMMIT" origin/main
 git -C "$CHECKOUT" show "$COMMIT:scripts/update-botfleet-bootstrap.mjs" > "$TMP/loader.mjs"
 "$NODE" "$TMP/loader.mjs" "$CHECKOUT" "$COMMIT" "$CACHE" "$@"
} 2> "$TMP/error.log"
