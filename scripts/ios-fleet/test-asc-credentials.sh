#!/usr/bin/env bash
# OPS-1102: the App Store Connect credential comes from the STORE, and from
# nowhere else.
#
# The client (asc-api.mjs) resolves the credential through this consumer's own
# named account -- the shared scoped reader, Infisical Fleet-OPS /asc -- or
# through the read-only service token a hosted job binds, and writes it to the
# 0600 staging file the Apple tools read.  The environment carries no copy of
# the credential:  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, APPLE_API_KEY_ID,
# APPLE_API_ISSUER_ID and APPLE_API_KEY_P8_BASE64 are never a source, and a
# named ASC_KEY_PATH is not a source either (Kody rule 42 on the CodeCaps PR
# #271 review:  a path on disk is not an approved secret source).
#
# This test drives load_secrets with a FAKE reader and throwaway keys generated
# here at test time.  No network, no real secrets, and no committed key.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/ship-testflight.sh"
tmp="$(mktemp -d)"
# The throwaway HOME lives inside the temp dir, so the cleanup has to run with
# the real HOME in place:  a trash helper that protects the home directory
# refuses to remove a parent of it.
real_home="${HOME}"
trap 'HOME="$real_home" rm -rf "$tmp"' EXIT
export HOME="${tmp}/home"
export TMPDIR="${tmp}/tmp"
mkdir -p "$HOME" "$TMPDIR"

fail() { echo "FAIL: $*" >&2; exit 1; }

# A throwaway key pair, generated here and never committed.  The client parses
# a PEM before it accepts it, so a fake envelope is not a key.
gen_pem() {
  node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }))'
}
gen_pem > "${tmp}/asc.p8"
gen_pem > "${tmp}/other.p8"
chmod 600 "${tmp}/asc.p8" "${tmp}/other.p8"

# Fake reader: prints synthetic values, records the folders it was asked for.
# BotFleet has one Infisical folder (/asc) and no per-key folder.
# The reader is a Python program, because the helper runs it with `python3 -I`.
cat > "${tmp}/infisical-scoped.py" <<'FAKE'
import os, sys
args = sys.argv[1:]
if not args or args[0] != "get":
    sys.exit(2)
name = args[1]
folder = args[args.index("--folder") + 1]
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(name + " " + folder + "\n")
if folder == "/asc" and name == "ASC_KEY_ID":
    sys.stdout.write("ABCDE12345\n")
elif folder == "/asc" and name == "ASC_ISSUER_ID":
    sys.stdout.write("issuer-synthetic\n")
elif folder == "/asc" and name == "ASC_KEY_P8":
    with open(os.environ["FAKE_ASC_PEM"]) as fh:
        sys.stdout.write(fh.read())
else:
    sys.exit(3)
FAKE
chmod +x "${tmp}/infisical-scoped.py"
export FAKE_LOG="${tmp}/fake.log"
export FAKE_ASC_PEM="${tmp}/asc.p8"
: > "$FAKE_LOG"

# A vault that is always closed.  A case that wants NO credential points
# FLEET_INFISICAL_READER at this stub and not at a path that does not exist:
# a path that does not exist lets the installed reader answer, and a test has
# no business reading the owner's vault.
cat > "${tmp}/no-vault" <<'VAULT'
import sys
sys.exit(4)
VAULT
chmod 700 "${tmp}/no-vault"

extract() {
  awk '
    /^fs_get\(\) \{/ || /^asc_temp_root\(\) \{/ || /^asc_tmp_dir\(\) \{/ || /^asc_upload_block\(\) \{/ || /^key_label\(\) \{/ || /^key_issuer_label\(\) \{/ || /^asc_resolve_diagnostic_credential\(\) \{/ || /^load_secrets\(\) \{/ || /^cleanup_asc_tmp\(\) \{/ { grab = 1 }
    grab { print }
    grab && /^\}/ { grab = 0 }
  ' "$script"
}

# The comparison tool.  It answers through the exit code only, so a
# credential is never expanded into the shell, where a trace would show it.
#
#   samefile <a> <b>      the two files hold the same key
#   differentfile <a> <b> the two files hold different keys
#
# The credential reaches the Apple tools through a PATH, so it is never an
# argument of a process and never appears in a command line.
cat > "${tmp}/compare.cjs" <<'CJS'
const fs = require("fs");
const mode = process.argv[2];
const first = process.argv[3];
const second = process.argv[4];
const read = (path) => fs.readFileSync(path, "utf8").trim();
const equal = second ? read(first) === read(second) : true;
const wantsDifferent = mode === "different" || mode === "differentfile";
process.exit(wantsDifferent ? (equal ? 1 : 0) : (equal ? 0 : 1));
CJS

funcs="${tmp}/funcs.sh"
{
  echo 'log() { echo "[ios-ship] $*"; }'
  echo 'logerr() { echo "[ios-ship] $*" >&2; }'
  echo 'ASC_TMP_DIR=""'
  echo 'ASC_DIAG_KEY_ID=""'
  echo 'ASC_DIAG_ISSUER_ID=""'
  printf '. "%s"\n' "${here}/../lib/fleet-infisical-read.sh"
  # The client reads the store through the same reader, so the seam has to
  # reach it as well:  an exported name is inherited by the client process.
  echo "export FLEET_INFISICAL_READER=\"${tmp}/infisical-scoped.py\""
  echo 'export FLEET_INFISICAL_ASC_ACCOUNT="fixture-asc-ro"'
  echo 'ASC_SECRET_ACCOUNT="fixture-asc-ro"'
  echo 'ASC_SECRET_FOLDER="/asc"'
  echo 'ASC_NODE="${IOS_FLEET_NODE:-node}"'
  echo "FLEET_DIR=\"${here}\""
  echo "ASC_COMPARE_TOOL=\"${tmp}/compare.cjs\""
  cat <<'FUNCS'
same_file_as_file() {
  node "$ASC_COMPARE_TOOL" samefile "$1" "$2"
}
different_file_from_file() {
  node "$ASC_COMPARE_TOOL" differentfile "$1" "$2"
}
FUNCS
  extract
} > "$funcs"
grep -q '^load_secrets()' "$funcs" || fail "load_secrets not found in ship-testflight.sh"
grep -q '^fs_get()' "$funcs" || fail "fs_get not found in ship-testflight.sh"

# 1. The store is the only source.  The client resolves the credential through
#    this consumer's own named account, writes it to the 0600 staging file the
#    Apple tools read, and the material never enters the environment.
: > "$FAKE_LOG"
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  -u INFISICAL_TOKEN -u INFISICAL_PROJECT_ID bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key ]]
  [[ "$ASC_KEY_ID" == ABCDE12345 && "$ASC_ISSUER_ID" == issuer-synthetic ]]
  [[ -f "$ASC_KEY_PATH" ]]
  mode="$(stat -c %a "$ASC_KEY_PATH" 2>/dev/null || stat -f %Lp "$ASC_KEY_PATH")"
  [[ "$mode" == 600 ]]
  [[ "$API_PRIVATE_KEYS_DIR" == "$ASC_TMP_DIR" ]]
  # The environment carries no copy of the credential:  the material is not
  # in it, and it never was.
  [[ -z "${ASC_KEY_P8:-}" ]]
  # The staged file holds the key the STORE holds, and it is the only copy.
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  echo "$ASC_KEY_PATH"
  cleanup_asc_tmp
  [[ ! -e "$ASC_KEY_PATH" ]]
')" || fail "the credential did not resolve from the store"
staged_path="$(printf '%s\n' "$out" | tail -1)"
[[ -n "$staged_path" ]] || fail "load_secrets printed no staged key path"
[[ ! -e "$staged_path" ]] || fail "temp key file survived cleanup"
grep -q '^ASC_KEY_ID /asc$' "$FAKE_LOG" || fail "did not ask the store /asc for the key id"
grep -q '^ASC_ISSUER_ID /asc$' "$FAKE_LOG" || fail "did not ask the store /asc for the issuer id"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask the store /asc for the key"

# 2. The environment is never a source.  A complete credential in the
#    environment does not displace the reviewed grant, and every name the
#    environment carried is cleared before anything is read.
: > "$FAKE_LOG"
out="$(ASC_KEY_ID=ENVKEY0001 ASC_ISSUER_ID=env-issuer ASC_KEY_P8="$(<"${tmp}/other.p8")" \
  APPLE_API_KEY_ID=CIKEY00001 APPLE_API_ISSUER_ID=ci-issuer \
  APPLE_API_KEY_P8_BASE64="$(base64 < "${tmp}/other.p8" | tr -d '\n')" \
  env -u INFISICAL_TOKEN -u INFISICAL_PROJECT_ID bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key ]]
  # The store wins:  a hand-set value never displaces the reviewed grant.
  [[ "$ASC_KEY_ID" == ABCDE12345 && "$ASC_ISSUER_ID" == issuer-synthetic ]]
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  # The environment carries no copy of the credential any more.
  [[ -z "${ASC_KEY_P8:-}" ]]
  [[ -z "${APPLE_API_KEY_ID:-}" ]]
  [[ -z "${APPLE_API_ISSUER_ID:-}" ]]
  [[ -z "${APPLE_API_KEY_P8_BASE64:-}" ]]
  cleanup_asc_tmp
')" || fail "the environment was used as a credential source"

# 3. A named ASC_KEY_PATH is not a credential source at all:  it is ignored,
#    the run says so, and the credential comes from the store.  A file somebody
#    names can never decide which key signs the upload.
: > "$FAKE_LOG"
cp "${tmp}/other.p8" "${tmp}/named-file.p8"
chmod 600 "${tmp}/named-file.p8"
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_PATH="${tmp}/named-file.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  # The credential is the one the store holds, never the named file.
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  cleanup_asc_tmp
')" || fail "a named key file was used as the credential"
case "$out" in
  *"ASC_KEY_PATH is not a credential source"*) ;;
  *) fail "the run did not say that it ignored the named path: ${out}" ;;
esac
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "the store was not consulted for the credential"

# 4. No credential at all still classifies as missing, so the owner handoff
#    for a missing key stays on that path.  An inherited ASC_KEY_PATH does not
#    survive the failed resolution:  the path is cleared, so nothing
#    downstream can pick it up and hand xcodebuild a credential this run
#    never resolved.
: > "$FAKE_LOG"
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_PATH="${tmp}/named-file.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  # The store holds nothing for this run:  the reader refuses every read.
  export FLEET_INFISICAL_READER="'"${tmp}"'/no-vault"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == missing ]]
  [[ "$(asc_upload_block)" == missing ]]
  # The named path is gone:  nothing downstream can pick it up.
  [[ -z "${ASC_KEY_PATH:-}" ]]
')" || fail "a missing credential was not classified as missing"

# 5. The client classifies its own failures, and the shell keeps them apart:
#    1 is no credential, 2 is a staging path that could not be used, 3 is a
#    credential the Apple tools cannot use, and anything else is the client
#    itself failing, which classifies neither the credential nor the path.
mkdir -p "${tmp}/stub-client"
cat > "${tmp}/stub-client/asc-api.mjs" <<'STUB'
process.exit(Number(process.env.STUB_CLIENT_RC || 1));
STUB
for pair in "1:missing" "2:staging" "3:credential" "9:writer"; do
  rc="${pair%%:*}"
  want="${pair##*:}"
  out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
    -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
    STUB_CLIENT_RC="$rc" bash -c '
    set -euo pipefail
    source "'"$funcs"'"
    FLEET_DIR="'"${tmp}"'/stub-client"
    load_secrets
    [[ "$AUTH_MODE" == none ]]
    [[ "$ASC_AUTH_FAILURE" == "'"$want"'" ]]
    [[ "$(asc_upload_block)" == "'"$want"'" ]]
  ')" || fail "the client status ${rc} was not classified as ${want}"
done

# 6. A store value that is not a PEM private key is a credential failure, not
#    a missing key:  the key exists, and the value that came back cannot be
#    used to sign an upload.
printf '%s' "not a private key at all" > "${tmp}/not-a-key.pem"
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  FAKE_ASC_PEM="${tmp}/not-a-key.pem" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == credential ]]
  [[ "$(asc_upload_block)" == credential ]]
')" || fail "a store value that is not a PEM was not classified as a credential failure"

# 7. The diagnostic reads the public labels and never the key material:  a
#    diagnostic must not cause a secret read.
: > "$FAKE_LOG"
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  asc_resolve_diagnostic_credential
  printf "id=%s\nissuer=%s\n" "$ASC_DIAG_KEY_ID" "$ASC_DIAG_ISSUER_ID"
')" || fail "the diagnostic did not run"
[[ "$out" == *"id=ABCDE12345"* ]] || fail "the store key id was not named"
[[ "$out" == *"issuer=issuer-synthetic"* ]] || fail "the store issuer id was not named"
grep -q '^ASC_KEY_ID /asc$' "$FAKE_LOG" || fail "the diagnostic did not read the store key id"
if grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG"; then
  fail "the diagnostic read the key material from the store"
fi

# 8. A key id is printed only when it looks like one.  A missing id says so,
#    and an id that holds anything else (a line break, a control character,
#    or a value as long as a key) is reported as unrecognized, so a mis-set id
#    can never carry a key or a forged log line into the log.
# shellcheck source=/dev/null
lbl() { ( source "$funcs"; key_label "$1" ); }
[[ "$(lbl ABCDE12345)" == ABCDE12345 ]] || fail "a well-formed key id was not printed"
[[ "$(lbl "")" == missing ]] || fail "a missing key id was not reported as missing"
for bad in "ABC"$'\n'"DEF" "ABC"$'\302\205'"DEF" "ABC"$'\342\200\250'"DEF" "ABC"$'\033'"DEF" \
    "ABC DEF" "$(printf 'A%.0s' {1..33})" "$(printf 'B%.0s' {1..48})"; do
  for loc in C en_US.UTF-8; do
    got="$(LC_ALL="$loc" lbl "$bad" 2>/dev/null)"
    [[ "$got" == unrecognized ]] || fail "a malformed key id was not reported as unrecognized under LC_ALL=${loc}"
  done
done
unset bad got loc

# 9. The credential never travels in a command argument.  The staged copy
#    reaches the Apple tools through a PATH, so no byte of it is ever an
#    argument of a process, where another user could read it through ps.
argv="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  ps -o args= -p $$ 2>/dev/null || true
')"
key_body="$(sed '1d;$d' "${tmp}/asc.p8")"
key_body="${key_body//[[:space:]]/}"
[[ "$argv" != *"$key_body"* ]] || fail "the credential reached the child in its command arguments"
unset key_body argv

# 10. Neither this test nor the ship script passes a credential to `env`,
#     which would put it in the process arguments of every child.  The
#     patterns are matched against the file with its line continuations
#     joined, so a value that sits on the next line is still found.
for f in "$0" "$script" "${here}/test-ship-seq.sh"; do
  [[ -f "$f" ]] || continue
  # The continuations are joined with awk and not with perl:  a runner
  # without perl must still run this guard, and must not abort the suite
  # before a single case has run.
  flat="$(awk '
    {
      if (pending != "") { line = pending " " $0 } else { line = $0 }
      if (line ~ /\\$/) { sub(/\\$/, "", line); pending = line }
      else { print line; pending = "" }
    }
    END { if (pending != "") print pending }
  ' "$f")"
  if printf '%s' "$flat" | grep -qE '(^|[[:space:]])env [^|\n]*ASC_KEY_P8='; then
    fail "$(basename "$f") passes a credential through env arguments"
  fi
  # A caller's assignments must never be handed to env as arguments either:
  # the names arrive one NAME=VALUE at a time, and every one of them is then
  # a process argument of the env that starts the child.
  if printf '%s' "$flat" | grep -qE '(^|[[:space:]])env [^|\n]*"\$@"'; then
    fail "$(basename "$f") hands a caller's assignments to env"
  fi
done
unset flat

# 11. Nothing is created under the old secrets folder or ~/.appstoreconnect.
[[ ! -e "${HOME}/.secrets" ]] || fail "created the old secrets folder"
[[ ! -e "${HOME}/.appstoreconnect" ]] || fail "created ~/.appstoreconnect"

# 12. The script text itself does not treat a named path as the credential:
#     it says so, and it never tests a named path for existence.
if ! grep -q 'ASC_KEY_PATH is not a credential source' "$script"; then
  fail "ship-testflight.sh does not say that it ignores a named path"
fi
if grep -nE '\-f "\$\{?ASC_KEY_PATH' "$script" >/dev/null; then
  fail "ship-testflight.sh still tests a named path for the credential"
fi

# 13. macOS TMPDIR ends in a slash.  The staged path still has to be normal,
#     the run still cleans it up, and a missing TMPDIR uses /tmp the same way.
path_is_normal() {
  node -e 'const p=require("path").posix; const s=process.argv[1]; process.exit(p.normalize(s)===s ? 0 : 1)' "$1"
}

# The TMPDIR the run sees is a PATH, not a credential, so it can travel in
# the environment of the env that starts the child.  It is never handed to
# env as a caller's argument list:  an argument is readable by every process
# on the machine through ps, and the house rule is that a credential never
# rides in one.
stage_from_tmpdir() {
  local label="$1" tmpdir="$2"
  local env_args=()
  if [[ "$tmpdir" == "unset" ]]; then
    env_args=(-u TMPDIR)
  else
    env_args=(TMPDIR="$tmpdir")
  fi
  local out
  out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
    -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
    "${env_args[@]}" bash -c '
    set -euo pipefail
    source "'"$funcs"'"
    load_secrets
    [[ "$AUTH_MODE" == api_key ]]
    [[ -z "${ASC_AUTH_FAILURE:-}" ]]
    [[ "$ASC_KEY_PATH" != *//* ]]
    echo "$ASC_KEY_PATH"
    cleanup_asc_tmp
    [[ ! -e "$ASC_KEY_PATH" ]]
  ')" || fail "$label"
  local staged
  staged="$(printf '%s\n' "$out" | tail -1)"
  path_is_normal "$staged" || fail "$label staged a path that is not normal: $staged"
  [[ ! -e "$staged" ]] || fail "$label left the staged key behind"
}

mkdir -p "${tmp}/slash-tmp"
stage_from_tmpdir "trailing-slash TMPDIR" "${tmp}/slash-tmp/"
stage_from_tmpdir "TMPDIR without a trailing slash" "${tmp}/tmp"
stage_from_tmpdir "unset TMPDIR" unset
# A root-level TMPDIR is "/" and nothing else.  Every trailing slash is
# stripped, so the root becomes empty and the join adds exactly one slash:
# "//asc-key.XXXXXX" is the doubled slash the staging check refuses.  The
# directory that lands on is the root of the filesystem, which a normal user
# cannot write, so the run must report a path failure and not crash.
root_log="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  TMPDIR="/" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == staging ]]
  [[ "$(asc_upload_block)" == staging ]]
')" || fail "a root TMPDIR was not classified as a path failure"
case "$root_log" in
  *"no App Store Connect API key"*) fail "a root TMPDIR was reported as a missing key: ${root_log}" ;;
esac
# The refusal has to hold for a user who CAN write to the root of the
# filesystem, so it is asserted on the helper itself and not on whether
# mktemp happened to fail.  A root TMPDIR strips down to nothing, and
# nothing is not a directory:  the root of the filesystem is refused
# instead of being turned into a path a key could be staged in.
root_rc="$(TMPDIR=/ bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  if asc_temp_root >/dev/null 2>&1; then echo "rc=0"; else echo "rc=$?"; fi
')"
[[ "$root_rc" == "rc=1" ]] || fail "a root TMPDIR was not refused by asc_temp_root (${root_rc})"
# A doubled trailing slash is not the root, so it strips down to the real
# directory and the key stages there.
stage_from_tmpdir "double-slash TMPDIR" "${tmp}//"

# 14. The version helpers run inside command substitutions, where load_secrets
#     would write a temp key whose cleanup trap dies with the subshell.  They
#     must check for a credential instead.
for fn in asc_next_shared_build asc_max_build_this_platform asc_released_store_version; do
  body="$(awk -v f="$fn" '$0 ~ "^"f"\\(\\) \\{" {g=1} g {print} g && /^}/ {exit}' "$script")"
  [[ -n "$body" ]] || fail "could not read ${fn}"
  if grep -v '^[[:space:]]*#' <<<"$body" | grep -q 'load_secrets'; then
    fail "${fn} calls load_secrets inside a command substitution (leaks the temp key dir)"
  fi
  grep -q 'asc_credential_available' <<<"$body" || fail "${fn} does not check for a credential"
done

# The released-version helper keeps the client's reason and its auth status:
# a discarded stderr or a flattened status 4 hides a credential fault behind
# a generic "cannot read the released version".
body="$(awk '/^asc_released_store_version\(\) \{/ {g=1} g {print} g && /^}/ {exit}' "$script")"
if grep -v '^[[:space:]]*#' <<<"$body" | grep -q '2>/dev/null'; then
  fail "asc_released_store_version discards the client's stderr"
fi
grep -q 'return 4' <<<"$body" || fail "asc_released_store_version does not preserve the auth status 4"
grep -q 'released-store-version:\*' <<<"$body" || fail "asc_released_store_version does not log the client's reason"
if grep -q 'asc_released_store_version "\$ASC_PLATFORM" 2>/dev/null' "$script"; then
  fail "the fixed-version caller discards the released-version reason"
fi
unset body

echo "ok: ASC credential resolution (the store only, the environment ignored, a named path ignored, temp key removed)"
