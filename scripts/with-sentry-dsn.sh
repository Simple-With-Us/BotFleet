#!/usr/bin/env bash
# Resolve SENTRY_DSN and VITE_SENTRY_DSN for a local packaging run, export
# both, then exec the given command.  electron-builder / Vite inline
# VITE_SENTRY_DSN at build time, so it must be in the environment before
# `pnpm package:mac:local` (or any other package:* script) starts.
#
# Resolution order per name: already-exported environment variable ->
# Infisical (only if the `infisical` CLI is on PATH and already logged in --
# this script never runs `infisical login`) -> the local handoff file
# ~/.secrets/botfleet-sentry.env, read with awk so that only the value
# after the first `NAME=` is ever produced, never the whole `NAME=value`
# row.  A value found for SENTRY_DSN but not VITE_SENTRY_DSN is copied
# across, since they are meant to be the same DSN.
# Never echoes, logs, traces, or otherwise prints a resolved value.
#
# Usage:
#   scripts/with-sentry-dsn.sh pnpm package:mac:local
#
# Missing everywhere is not an error: the command still runs, packaged with
# Sentry inert (see src/lib/sentry.ts and server/sentry.ts, both no-op on an
# empty DSN).

# FIRST, before anything can read a secret: kill xtrace.  Invoked as
# `bash -x scripts/with-sentry-dsn.sh ...`, or with xtrace inherited through
# an exported SHELLOPTS, every command substitution and assignment below
# would print the resolved DSN to stderr and into whatever terminal or CI
# log is capturing it.  The braces with stderr discarded hide the trace line
# that `set +x` itself would emit on its way out.
{ set +x; } 2>/dev/null
set +o xtrace
# xtrace carried in an exported SHELLOPTS comes back in every child shell,
# including the command this script execs, so drop the export attribute as
# well.  A no-op when neither name is exported.
export -n SHELLOPTS BASH_XTRACEFD 2>/dev/null || true

set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

HANDOFF_FILE="${BOTFLEET_SENTRY_HANDOFF:-$HOME/.secrets/botfleet-sentry.env}"

# Reads $1 from (in order) the current environment, Infisical, then the
# handoff file.  Prints the resolved value on stdout; prints nothing (and
# nothing else, ever) when unresolved.  Callers capture this with
# command substitution, so no other output may reach stdout here.
resolve_secret() {
  # Belt and braces: nothing between the top of this file and here may turn
  # tracing back on, and this is the function that touches the secret.
  { set +x; } 2>/dev/null

  local name="$1"
  local val="${!name:-}"

  if [[ -z "$val" ]] && command -v infisical >/dev/null 2>&1; then
    local project_id="${INFISICAL_PROJECT_ID:-}"
    if [[ -z "$project_id" ]] && command -v jq >/dev/null 2>&1 && [[ -f "$HOME/.botfleet/config.json" ]]; then
      project_id="$(jq -r '.infisical.projectId // empty' "$HOME/.botfleet/config.json" 2>/dev/null)"
    fi
    local args=(--plain --silent --telemetry=false --expand=false --env=prod --path=/)
    if [[ -n "$project_id" ]]; then
      args+=(--projectId="$project_id")
    fi
    val="$(infisical secrets get "$name" "${args[@]}" 2>/dev/null || true)"
  fi

  if [[ -z "$val" && -f "$HANDOFF_FILE" ]]; then
    # Only the value: awk matches the row by prefix and prints what follows
    # the `=`, so the complete `NAME=value` row is never produced as output
    # that a trace, a pipeline, or a stray `set -x` could echo.  First match
    # wins, exactly as `grep -m1` did.
    val="$(awk -v prefix="${name}=" \
      'index($0, prefix) == 1 { print substr($0, length(prefix) + 1); exit }' \
      "$HANDOFF_FILE")"
  fi

  printf '%s' "$val"
}

SENTRY_DSN="$(resolve_secret SENTRY_DSN)"
VITE_SENTRY_DSN="$(resolve_secret VITE_SENTRY_DSN)"

if [[ -z "$VITE_SENTRY_DSN" ]]; then
  VITE_SENTRY_DSN="$SENTRY_DSN"
fi
if [[ -z "$SENTRY_DSN" ]]; then
  SENTRY_DSN="$VITE_SENTRY_DSN"
fi

if [[ -z "$SENTRY_DSN" ]]; then
  echo "[with-sentry-dsn] no SENTRY_DSN found (checked env, Infisical, $HANDOFF_FILE); packaging with Sentry inert" >&2
fi

export SENTRY_DSN VITE_SENTRY_DSN

exec "$@"
