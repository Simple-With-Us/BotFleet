# Scoped Infisical reads for BotFleet, through the shared reader.
#
# The `fleet-secrets` command is retired fleet-wide. Every BotFleet read goes
# through `infisical-scoped.py`, the reader AFC installs at
# `~/apps/infisical-scoped/infisical-scoped.py`, and every read names the
# consumer's own service-token account. There is no other route:  no shared
# machine identity, no cached copy and no second reader.
#
# Source this file, then call:
#
#   value="$(fleet_secret_get NAME FOLDER ACCOUNT)"
#
# The value reaches stdout and nothing else does. Errors go to stderr and
# never carry a value:  the reader names the reason, not the secret.
#
# Exit codes:
#   0  the read worked and the value is on stdout
#   2  the command line was wrong
#   3  the name is absent from that folder
#   4  the read was refused, or no reader is installed
#
# A host with no reader and no token fails closed with 4:  the read is
# refused, never hung and never answered from somewhere else.

# The reader path, in the order the reader is looked for:  the test seam
# first, then the installed copy. Prints the path; it never runs the reader.
fleet_secret_reader() {
  if [ -n "${FLEET_INFISICAL_READER:-}" ]; then
    printf '%s' "$FLEET_INFISICAL_READER"
    return 0
  fi
  printf '%s' "${HOME}/apps/infisical-scoped/infisical-scoped.py"
}

# fleet_secret_get NAME FOLDER ACCOUNT [PROJECT]
#
# PROJECT defaults to fleet-ops, which is the project every BotFleet read
# belongs to. An empty ACCOUNT is refused before the reader runs:  the reader
# looks one account up in its own table, and a folder that table does not
# carry is refused rather than read with somebody else's token.
fleet_secret_get() {
  if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "fleet-secret-get: usage: fleet_secret_get NAME FOLDER ACCOUNT [PROJECT]" >&2
    return 2
  fi
  _name="$1"
  _folder="$2"
  _account="$3"
  _project="${4:-fleet-ops}"

  if [ -z "$_name" ] || [ -z "$_folder" ]; then
    echo "fleet-secret-get: a name and a folder are required" >&2
    return 2
  fi
  if [ -z "$_account" ]; then
    echo "fleet-secret-get: no scoped Infisical account is configured for $_name ($_folder)" >&2
    return 4
  fi

  _reader="$(fleet_secret_reader)"
  if [ ! -f "$_reader" ]; then
    echo "fleet-secret-get: the scoped reader is not installed at $_reader" >&2
    return 4
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "fleet-secret-get: python3 is not on PATH, so the scoped reader cannot run" >&2
    return 4
  fi

  # `-I` keeps the reader isolated from the caller's PYTHONPATH and from the
  # current directory, so an unrelated file cannot stand in for the reader.
  python3 -I "$_reader" get "$_name" --folder "$_folder" --project "$_project" --account "$_account"
  _status=$?
  return "$_status"
}
