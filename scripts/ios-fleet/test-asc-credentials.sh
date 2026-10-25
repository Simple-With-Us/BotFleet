#!/usr/bin/env bash
# AFC-459: ship-testflight.sh resolves the App Store Connect credential from
# the environment first, then from Infisical through fleet-secrets, and never
# from a path on disk.
#
# 2026-10-21 (Kody rule 42 on the CodeCaps PR #271 review): the private key is
# handed over in the environment, never as a path the node client reads.  The
# shell layer owns the credential, so this test drives load_secrets with a
# FAKE fleet-secrets binary and throwaway keys generated here at test time.
# No network, no real secrets, and no committed key.
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

# Fake fleet-secrets: prints synthetic values, records the folders it was asked
# for.  BotFleet has one Infisical folder (/asc) and no per-key folder.
cat > "${tmp}/fleet-secrets" <<'FAKE'
#!/usr/bin/env bash
[[ "$1" == get ]] || exit 2
name="$2"; folder="$4"
echo "${name} ${folder}" >> "${FAKE_LOG}"
case "${folder}:${name}" in
  /asc:ASC_KEY_ID) printf 'ABCDE12345\n' ;;
  /asc:ASC_ISSUER_ID) printf 'issuer-synthetic\n' ;;
  /asc:ASC_KEY_P8) cat "${FAKE_ASC_PEM}" ;;
  *) exit 3 ;;
esac
FAKE
chmod +x "${tmp}/fleet-secrets"
export FAKE_LOG="${tmp}/fake.log"
export FAKE_ASC_PEM="${tmp}/asc.p8"
: > "$FAKE_LOG"

# A vault that is always closed.  fs_get falls back to whatever
# fleet-secrets is on the PATH when the configured binary is not executable,
# so a case that wants NO credential points FLEET_SECRETS_BIN at this
# executable stub and not at a path that does not exist:  a path that does
# not exist lets the real fleet-secrets answer, and a test has no business
# reading the owner's vault.
cat > "${tmp}/no-vault" <<'VAULT'
#!/usr/bin/env bash
exit 2
VAULT
chmod 700 "${tmp}/no-vault"

extract() {
  awk '
    /^fs_get\(\) \{/ || /^asc_temp_root\(\) \{/ || /^asc_tmp_dir\(\) \{/ || /^asc_upload_block\(\) \{/ || /^key_preview\(\) \{/ || /^load_secrets\(\) \{/ || /^cleanup_asc_tmp\(\) \{/ { grab = 1 }
    grab { print }
    grab && /^\}/ { grab = 0 }
  ' "$script"
}

# The comparison tool.  It answers through the exit code only, so a
# credential is never expanded into the shell, where a trace would show it.
#
#   envsame <file>       ASC_KEY_P8 in the environment equals the file
#   envdifferent <file>  ASC_KEY_P8 in the environment differs from the file
#   samefile <a> <b>     the two files hold the same key
#   differentfile <a> <b> the two files hold different keys
#
# The credential reaches the tool through the ENVIRONMENT it already lives in,
# so it is never an argument of a process and never appears in a command line.
cat > "${tmp}/compare.cjs" <<'CJS'
const fs = require("fs");
const mode = process.argv[2];
const first = process.argv[3];
const second = process.argv[4];
const value = process.env.VALUE_TO_COMPARE || "";
const env = process.env.ASC_KEY_P8 || "";
const read = (path) => fs.readFileSync(path, "utf8").trim();
let equal;
if (mode === "envsame" || mode === "envdifferent") {
  equal = env.trim() === read(first);
} else {
  equal = second ? read(first) === read(second) : value.trim() === read(first);
}
const wantsDifferent = mode === "different" || mode === "differentfile" || mode === "envdifferent";
process.exit(wantsDifferent ? (equal ? 1 : 0) : (equal ? 0 : 1));
CJS

funcs="${tmp}/funcs.sh"
{
  echo 'log() { echo "[ios-ship] $*"; }'
  echo 'logerr() { echo "[ios-ship] $*" >&2; }'
  echo 'ASC_TMP_DIR=""'
  echo "FLEET_SECRETS_BIN=\"${tmp}/fleet-secrets\""
  echo "FLEET_DIR=\"${here}\""
  echo "ASC_COMPARE_TOOL=\"${tmp}/compare.cjs\""
  cat <<'FUNCS'
same_env_as_file() {
  node "$ASC_COMPARE_TOOL" envsame "$1"
}
different_env_from_file() {
  node "$ASC_COMPARE_TOOL" envdifferent "$1"
}
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

# 1. Nothing in the environment:  the credential comes from Infisical and the
#    key is staged in a 0600 temp file that the run cleans up.
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key ]]
  [[ "$ASC_KEY_ID" == ABCDE12345 && "$ASC_ISSUER_ID" == issuer-synthetic ]]
  [[ -f "$ASC_KEY_PATH" ]]
  mode="$(stat -c %a "$ASC_KEY_PATH" 2>/dev/null || stat -f %Lp "$ASC_KEY_PATH")"
  [[ "$mode" == 600 ]]
  [[ "$API_PRIVATE_KEYS_DIR" == "$ASC_TMP_DIR" ]]
  # The staged file holds the /asc key, and the client takes the key from the
  # environment.  Neither comparison prints a value.
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  same_env_as_file "'"$tmp"'/asc.p8"
  echo "$ASC_KEY_PATH"
  cleanup_asc_tmp
  [[ ! -e "$ASC_KEY_PATH" ]]
')" || fail "load_secrets from Infisical"
staged_path="$(printf '%s\n' "$out" | tail -1)"
[[ -n "$staged_path" ]] || fail "load_secrets printed no staged key path"
[[ ! -e "$staged_path" ]] || fail "temp key file survived cleanup"
grep -q '^ASC_KEY_ID /asc$' "$FAKE_LOG" || fail "did not ask Infisical /asc for the key id"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask Infisical /asc for the key"

# 2. The environment wins over a named key file.  A disk credential never
#    overrides the environment (Kody rule 42 on the CodeCaps PR #271 review):
#    a stale or foreign value in an operator's shell would sign the upload
#    with the wrong key.
: > "$FAKE_LOG"
cp "${tmp}/asc.p8" "${tmp}/named-key.p8"
chmod 600 "${tmp}/named-key.p8"
#  The key is assigned in front of `env`, so it reaches the child through the
#  environment and never through a process argument, where a listing would
#  show it.
ASC_KEY_P8="$(<"${tmp}/other.p8")" \
  env -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ENVKEY0001 ASC_ISSUER_ID=env-issuer ASC_KEY_PATH="${tmp}/named-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ENVKEY0001 ]]
  # The environment key is the credential in play, and the named file is not.
  same_env_as_file "'"$tmp"'/other.p8"
  different_env_from_file "'"$tmp"'/named-key.p8"
' || fail "a named key file overrode the environment"
[[ ! -s "$FAKE_LOG" ]] || fail "fleet-secrets was called although the environment was complete"

# 2a. A named ASC_KEY_PATH is not a credential source at all:  it is ignored,
# and the credential comes from Infisical.  A file somebody names can never
# decide which key signs the upload.
: > "$FAKE_LOG"
cp "${tmp}/other.p8" "${tmp}/named-file.p8"
chmod 600 "${tmp}/named-file.p8"
env -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_PATH="${tmp}/named-file.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  # The credential is the /asc one from Infisical, never the named file.
  same_env_as_file "'"$tmp"'/asc.p8"
  different_env_from_file "'"$tmp"'/named-file.p8"
  cleanup_asc_tmp
' || fail "a named key file was used as the credential"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "fleet-secrets was not consulted for the credential"

# 2b. The run says that it ignored the named path, so an operator can see why
#     the file they named is not the credential in play.
: > "$FAKE_LOG"
log_out="$(env -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_PATH="${tmp}/named-file.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
')" || fail "load_secrets with a named path"
case "$log_out" in
  *"ASC_KEY_PATH is not a credential source"*) ;;
  *) fail "the run did not say that it ignored the named path: ${log_out}" ;;
esac

# The scanner that finds a command substitution which runs the key reader.
#
# It walks the file and matches the closing parenthesis of every
# substitution, so a capture is found whatever shape it has:  with or without
# a `||` after it, written on one line or across several, and with a nested
# substitution inside it.  The scan is exact, so the script as it stands is
# not flagged by a shape it does not have.
cat > "${tmp}/find-key-capture.cjs" <<'SCAN'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const offenders = [];
const lineOf = (index) => text.slice(0, index).split("\n").length;
let depth = 0;
let start = 0;
let quote = null;
for (let i = 0; i < text.length; i += 1) {
  const c = text[i];
  if (quote === "'") {
    //  Single quotes are literal in bash, so nothing inside them is a
    //  substitution.
    if (c === quote) quote = null;
    continue;
  }
  if (c === "\\") { i += 1; continue; }
  if (c === "`") {
    const end = text.indexOf("`", i + 1);
    if (end === -1) break;
    if (text.slice(i, end + 1).includes("asc-key.mjs")) offenders.push(lineOf(i));
    i = end;
    continue;
  }
  if (quote === "\"") {
    if (c === quote) { quote = null; continue; }
    if (c === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i); if (end !== -1) { i = end; continue; } }
    if (c === "$" && text[i + 1] === "(") { depth += 1; if (depth === 1) start = i; i += 1; continue; }
    if (c === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0 && text.slice(start, i + 1).includes("asc-key.mjs")) offenders.push(lineOf(start));
    }
    continue;
  }
  if (c === "$" && text[i + 1] === "{") { const end = text.indexOf("}", i); if (end !== -1) { i = end; continue; } }
  if (c === "#") {
    //  A comment runs to the end of the line, and an apostrophe in it is an
    //  apostrophe, not the start of a quoted string.
    const end = text.indexOf("\n", i);
    i = end === -1 ? text.length : end;
    continue;
  }
  if (c === "\"" || c === "'") { quote = c; continue; }
  if (c === "$" && text[i + 1] === "(") { depth += 1; if (depth === 1) start = i; i += 1; continue; }
  if (c === ")" && depth > 0) {
    depth -= 1;
    if (depth === 0 && text.slice(start, i + 1).includes("asc-key.mjs")) offenders.push(lineOf(start));
  }
}
if (offenders.length) {
  console.error("the key reader is captured into a variable at line(s) " + offenders.join(", "));
  process.exit(1);
}
SCAN

# 2c. A staged key file is never read into a variable:  the shell that owns it
#     only ever holds its path.
if ! node "${tmp}/find-key-capture.cjs" "$script"; then
  fail "ship-testflight.sh reads the key material into a variable"
fi

# 2d. The guard has teeth:  a capture in every shape is caught, and the ship
#     script as it stands is not flagged.
for shape in plain plain-with-or split-across-lines nested; do
  cp "$script" "${tmp}/mutated.sh"
  case "$shape" in
    plain)
      printf '%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" validate <<< "$ASC_KEY_P8")"' >> "${tmp}/mutated.sh" ;;
    plain-with-or)
      printf '%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" validate <<< "$ASC_KEY_P8")" || rc=$?' >> "${tmp}/mutated.sh" ;;
    split-across-lines)
      printf '%s\n%s\n' 'key="$(node "${FLEET_DIR}/asc-key.mjs" \' '  validate <<< "$ASC_KEY_P8")"' >> "${tmp}/mutated.sh" ;;
    nested)
      printf '%s\n' 'key="$(cd "$(dirname "$0")"; node "${FLEET_DIR}/asc-key.mjs" validate <<< "$ASC_KEY_P8")"' >> "${tmp}/mutated.sh" ;;
  esac
  if node "${tmp}/find-key-capture.cjs" "${tmp}/mutated.sh" >/dev/null 2>&1; then
    fail "the capture guard did not catch a ${shape} capture"
  fi
done

# 2e. An ambient ASC_KEY_P8 that is not a PEM private key is ignored, and the
#     run fails closed rather than signing with something that is not a key.
: > "$FAKE_LOG"
env -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_P8="not a private key at all" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "an ASC_KEY_P8 that is not a key was adopted"

# 2f. An ambient ASC_KEY_P8 without a key id is ignored:  the key id, the
#     issuer and the key belong together.
: > "$FAKE_LOG"
ASC_KEY_P8="$(<"${tmp}/other.p8")" \
  env -u ASC_KEY_ID -u ASC_ISSUER_ID -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  same_env_as_file "'"$tmp"'/asc.p8"
' || fail "an ASC_KEY_P8 without a key id was adopted"

# 2g. An env key id that is NOT the /asc one never gets the /asc key:  its own
#     .p8 is not in Infisical for BotFleet, so the run fails closed.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=OTHERKEY01 ASC_ISSUER_ID=issuer-other bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "an env key id different from /asc was given the /asc key"
if grep -q '^ASC_KEY_P8 ' "$FAKE_LOG"; then fail "asked /asc for a key that belongs to another key id"; fi

# 2h. An env key id equal to the /asc one uses the /asc key.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_ISSUER_ID -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ABCDE12345 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  same_file_as_file "$ASC_KEY_PATH" "'"$tmp"'/asc.p8"
  cleanup_asc_tmp
' || fail "env key id equal to /asc was not served from /asc"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask /asc ASC_KEY_P8"

# 2i. An env key id with no key material anywhere fails closed.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "missing key material did not fail closed"

# 2j. A named ASC_KEY_PATH that names nothing is ignored the same way:  the
#     credential comes from Infisical, and the named path is never read.
: > "$FAKE_LOG"
env -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_PATH="${tmp}/no-such-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  same_env_as_file "'"$tmp"'/asc.p8"
  cleanup_asc_tmp
' || fail "a named key file that names nothing broke the run"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "fleet-secrets was not consulted for the credential"

# 2k. An inherited ASC_KEY_PATH does not survive a failed resolution:  the
#     path is cleared, so nothing downstream can pick it up and hand xcodebuild
#     a credential this run never resolved.
: > "$FAKE_LOG"
env -u ASC_KEY_P8 -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_PATH="${tmp}/named-file.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  # The named path is gone:  nothing downstream can pick it up.
  [[ -z "${ASC_KEY_PATH:-}" ]]
' || fail "an inherited ASC_KEY_PATH survived a failed resolution"

# 2l. An ASC_KEY_P8 that is not a private key is removed from the environment,
#     so the client never resolves a credential the shell layer refused.
: > "$FAKE_LOG"
env -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_P8="not a private key at all" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ -z "${ASC_KEY_P8:-}" ]]
' || fail "an unusable ASC_KEY_P8 stayed in the environment"

# 2m. The same for the APPLE_API_* trio:  the client looks for those names
#     first, so an unusable one has to be removed rather than left behind.
#     The credential is then the one Infisical holds, and the client sees it.
: > "$FAKE_LOG"
env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_P8 -u ASC_KEY_PATH \
  APPLE_API_KEY_ID=BADKEY00001 APPLE_API_ISSUER_ID=bad-issuer \
  APPLE_API_KEY_P8_BASE64="not a private key at all" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key ]]
  # The credential is the /asc one, not the unusable APPLE_API_* one.
  same_env_as_file "'"$tmp"'/asc.p8"
  [[ -z "${APPLE_API_KEY_P8_BASE64:-}" ]]
  [[ -z "${APPLE_API_KEY_ID:-}" ]]
  [[ -z "${APPLE_API_ISSUER_ID:-}" ]]
' || fail "an unusable APPLE_API_* trio stayed in the environment"

# 3. The credential never travels in a command argument.  The secret reaches
#    the child through the environment, so its own argv must not carry it.
argv="$(ASC_KEY_P8="$(<"${tmp}/other.p8")" \
  env -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ENVKEY0005 ASC_ISSUER_ID=env-issuer bash -c '
  set -euo pipefail
  ps -o args= -p $$ 2>/dev/null || true
')"
pem="$(<"${tmp}/other.p8")"
[[ "$argv" != *"$pem"* ]] || fail "the credential reached the child in its command arguments"

# 4. Neither this test nor the ship script passes a credential to `env`, which
#    would put it in the process arguments of every child.
for f in "$0" "$script"; do
  if grep -nE '(^|[[:space:]])env [^|]*ASC_KEY_P8=' "$f" >/dev/null; then
    fail "$(basename "$f") passes a credential through env arguments"
  fi
done

# 5. Nothing is created under the old secrets folder or ~/.appstoreconnect.
[[ ! -e "${HOME}/.secrets" ]] || fail "created the old secrets folder"
[[ ! -e "${HOME}/.appstoreconnect" ]] || fail "created ~/.appstoreconnect"

# 6. The script text itself no longer treats a named path as the credential:
#    it says so, and it never tests a named path for existence.
if ! grep -q 'ASC_KEY_PATH is not a credential source' "$script"; then
  fail "ship-testflight.sh does not say that it ignores a named path"
fi
if grep -nE '\-f "\$\{?ASC_KEY_PATH' "$script" >/dev/null; then
  fail "ship-testflight.sh still tests a named path for the credential"
fi

# 7. macOS TMPDIR ends in a slash.  The staged path still has to be normal,
#    the run still cleans it up, and a missing TMPDIR uses /tmp the same way.
path_is_normal() {
  node -e 'const p=require("path").posix; const s=process.argv[1]; process.exit(p.normalize(s)===s ? 0 : 1)' "$1"
}

stage_from_tmpdir() {
  local label="$1"
  shift
  local out
  out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
    -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
    "$@" bash -c '
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
stage_from_tmpdir "trailing-slash TMPDIR" TMPDIR="${tmp}/slash-tmp/"
stage_from_tmpdir "TMPDIR without a trailing slash" TMPDIR="${tmp}/tmp"
stage_from_tmpdir "unset TMPDIR" -u TMPDIR
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
stage_from_tmpdir "double-slash TMPDIR" TMPDIR="${tmp}//"

# 8. A staging refusal is not a missing credential.  The key resolves, the
#    writer refuses the path, and the upload block says staging.  The writer
#    exits 2 for that:  a path that could not be used.
real_node="$(command -v node)"
mkdir -p "${tmp}/bin"
cat > "${tmp}/bin/node" <<WRAP
#!/usr/bin/env bash
if [[ "\${1:-}" == *asc-key.mjs && "\${2:-}" == write ]]; then
  echo "asc-key: the staged key path is not a normal path" >&2
  exit 2
fi
exec "$real_node" "\$@"
WRAP
chmod 700 "${tmp}/bin/node"
stage_log="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  PATH="${tmp}/bin:${PATH}" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == staging ]]
  [[ "$(asc_upload_block)" == staging ]]
')" || fail "a path refusal was classified as a missing key"
case "$stage_log" in
  *"the credential was resolved and the staging path was refused"*) ;;
  *) fail "a path refusal did not say the credential was resolved: ${stage_log}" ;;
esac
case "$stage_log" in
  *"no App Store Connect API key"*) fail "a path refusal was reported as a missing key" ;;
esac

# 8b. A credential the writer refuses is not a path refusal either.  The
#     writer exits 3 for a value that is not a usable PEM private key, and
#     the run has to say THAT rather than pointing at the staging path or at
#     a key that has to be created:  the key exists, the value is broken.
mkdir -p "${tmp}/bin-cred"
cat > "${tmp}/bin-cred/node" <<WRAP
#!/usr/bin/env bash
if [[ "\${1:-}" == *asc-key.mjs && "\${2:-}" == write ]]; then
  echo "asc-key: the value is not a PEM private key" >&2
  exit 3
fi
exec "$real_node" "\$@"
WRAP
chmod 700 "${tmp}/bin-cred/node"
cred_log="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  PATH="${tmp}/bin-cred:${PATH}" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == credential ]]
  [[ "$(asc_upload_block)" == credential ]]
')" || fail "a broken credential was classified as a path refusal"
# The captured log is never echoed into a failure message:  it can hold the
# key itself, and a failure message is a sink like any other.
case "$cred_log" in
  *"the credential was resolved but it is not a usable PEM private key"*) ;;
  *) fail "a broken credential did not say so" ;;
esac
case "$cred_log" in
  *"the staging path was refused"*) fail "a broken credential was reported as a path refusal" ;;
esac
case "$cred_log" in
  *"no App Store Connect API key"*) fail "a broken credential was reported as a missing key" ;;
esac
# The rejected credential is identified by its public label, the key id, and
# by a MASKED PREVIEW of the key:  the first eight and the last four
# characters with the middle elided.  That is the fleet's canonical mask,
# and it is what lets an owner tell one rejected key from another without
# the key ever being printed.
case "$cred_log" in
  *"key id ABCDE12345"*) ;;
  *) fail "a broken credential did not name the key id" ;;
esac
case "$cred_log" in
  *"preview "*) ;;
  *) fail "a broken credential did not carry a masked preview" ;;
esac
# The preview is a mask and not the key:  neither the PEM armor nor any
# slice of the key body may appear in the log.  The slice is matched with
# bash pattern matching, so no byte of the key ever reaches the argument
# list of a process, where another user could read it through ps.
if [[ "$cred_log" == *"BEGIN PRIVATE KEY"* ]]; then
  fail "a broken credential printed the key itself"
fi
key_slice="$(sed -n '2p' "${tmp}/asc.p8" | cut -c1-12)"
if [[ "$cred_log" == *"$key_slice"* ]]; then
  fail "a broken credential printed a slice of the key body"
fi
unset key_slice

# 8c. The two failures are told apart by the writer's exit code, not by the
#     text of its message.  A staging failure is 2 and a credential failure
#     is 3, so the writer itself has to keep them apart.
cred_rc=0
printf 'not a private key' | node "${here}/asc-key.mjs" write "${tmp}/not-a-key.p8" >/dev/null 2>&1 || cred_rc=$?
[[ "$cred_rc" -eq 3 ]] || fail "a value that is not a key did not exit 3 (got ${cred_rc})"
stage_rc=0
node "${here}/asc-key.mjs" write "${tmp}/not-normal//key.p8" <<< "$(cat "${tmp}/asc.p8")" >/dev/null 2>&1 || stage_rc=$?
[[ "$stage_rc" -eq 2 ]] || fail "a refused staging path did not exit 2 (got ${stage_rc})"

# 8d. A writer that fails without classifying anything is neither a broken
#     credential nor a refused path.  The writer exits 1 for its own usage
#     error and node uses 1 for an uncaught exception, so a crash must not
#     be reported as a broken key:  that would send the owner to re-export a
#     key that is fine.
mkdir -p "${tmp}/bin-writer"
cat > "${tmp}/bin-writer/node" <<WRAP
#!/usr/bin/env bash
if [[ "\${1:-}" == *asc-key.mjs && "\${2:-}" == write ]]; then
  echo "asc-key: internal error" >&2
  exit 1
fi
exec "$real_node" "\$@"
WRAP
chmod 700 "${tmp}/bin-writer/node"
writer_log="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  PATH="${tmp}/bin-writer:${PATH}" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == writer ]]
  [[ "$(asc_upload_block)" == writer ]]
')" || fail "a writer crash was classified as a credential or a path failure"
case "$writer_log" in
  *"the key writer failed with status"*) ;;
  *) fail "a writer crash did not say the writer failed: ${writer_log}" ;;
esac
case "$writer_log" in
  *"is not a usable PEM private key"*) fail "a writer crash was reported as a broken key: ${writer_log}" ;;
esac
case "$writer_log" in
  *"the staging path was refused"*) fail "a writer crash was reported as a path refusal: ${writer_log}" ;;
esac
case "$writer_log" in
  *"no App Store Connect API key"*) fail "a writer crash was reported as a missing key: ${writer_log}" ;;
esac

# 8e. A credential that is resolved and then rejected by the earlier validate
#     check is a credential failure, not a missing key.  The key exists; the
#     value that came back cannot be used.
validate_log="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_P8="not a private key" \
  bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  # The sourced file points at the fake fleet-secrets.  Point it at nothing
  # after that, so the rejected ambient value is the only credential there
  # is and no other source can rescue the run.
  FLEET_SECRETS_BIN="'"${tmp}"'/no-vault"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == credential ]]
  [[ "$(asc_upload_block)" == credential ]]
')" || fail "a credential rejected by validate was classified as a missing key"
case "$validate_log" in
  *"no App Store Connect API key"*) fail "a rejected credential was reported as a missing key: ${validate_log}" ;;
esac

# 8f. A validator that fails without classifying anything is not a broken
#     credential.  asc-key.mjs exits 3 for a value that is not a PEM and
#     1 for its own crash, and node uses 1 for an uncaught exception, so a
#     crash must not be reported as a bad key:  that would send the owner
#     to re-export a key that is perfectly fine.
mkdir -p "${tmp}/bin-validator"
cat > "${tmp}/bin-validator/node" <<WRAP
#!/usr/bin/env bash
if [[ "\${1:-}" == *asc-key.mjs && "\${2:-}" == validate ]]; then
  echo "asc-key: internal error" >&2
  exit 1
fi
exec "$real_node" "\$@"
WRAP
chmod 700 "${tmp}/bin-validator/node"
validator_log="$(env -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_KEY_ID=ABCDE12345 ASC_ISSUER_ID=issuer-synthetic \
  PATH="${tmp}/bin-validator:${PATH}" ASC_TEST_PEM="${tmp}/asc.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  # The sourced file points at the fake fleet-secrets.  Point it at nothing
  # after that, so the only credential in the run is the one the ambient
  # ASC_KEY_P8 carries.
  FLEET_SECRETS_BIN="'"${tmp}"'/no-vault"
  # The credential reaches the run through the environment it belongs in, so
  # no byte of the key is ever an argument of a process.
  ASC_KEY_P8="$(cat "$ASC_TEST_PEM")"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ "$ASC_AUTH_FAILURE" == writer ]]
  [[ "$(asc_upload_block)" == writer ]]
')" || fail "a validator crash was classified as a credential failure"
case "$validator_log" in
  *"the key validator failed with status"*) ;;
  *) fail "a validator crash did not say the validator failed" ;;
esac
case "$validator_log" in
  *"is not a usable PEM private key"*) fail "a validator crash was reported as a broken key" ;;
esac

# 9. No credential at all still classifies as missing, so the owner handoff
#    for a missing key stays on that path.
env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  # The sourced file points at the fake fleet-secrets.  Point it at nothing
  # after that, so this case really has no credential.
  FLEET_SECRETS_BIN="'"${tmp}"'/no-vault"
  load_secrets
  [[ "$AUTH_MODE" == none ]]
  [[ -z "${ASC_AUTH_FAILURE:-}" ]]
  [[ "$(asc_upload_block)" == missing ]]
' || fail "a missing credential was not classified as missing"

# 9. A preview never carries a line break.  NEL, LS and PS are withheld by
#    their UTF-8 bytes whatever the locale, and so is any other control
#    character, so a rejected value cannot inject a log line.
for term in $'\302\205' $'\342\200\250' $'\342\200\251'; do
  for loc in C en_US.UTF-8; do
    got="$(LC_ALL="$loc" bash -c 'source "'"$funcs"'"; key_preview "$1"' _ "AAAAAAAAAAAAAAAA${term}BBBBBBBBBBBBBBBB" 2>/dev/null)"
    case "$got" in
      *"$term"*) fail "a Unicode line terminator survived key_preview under LC_ALL=${loc}" ;;
      "[withheld: line terminator]") ;;
      *) fail "a value with a Unicode line terminator was not withheld under LC_ALL=${loc}: ${got}" ;;
    esac
  done
done
got="$(bash -c 'source "'"$funcs"'"; key_preview "$1"' _ "AAAAAAAAAAAAAAAA"$'\033'"BBBBBBBBBBBBBBBB")"
[[ "$got" == "[withheld: control character]" ]] || fail "a control character was not withheld by key_preview: ${got}"

# 10. Every caller reads asc_temp_root's refusal.  An inline "$(asc_temp_root)/"
#     expansion turns the refused root into a path that names "/", and under
#     errexit a bare assignment ends the run before the owner handoff.
if grep -nE '\$\(asc_temp_root\)[^"]|"\$\(asc_temp_root\)/' "${here}/ship-testflight.sh" >&2; then
  fail "ship-testflight.sh expands asc_temp_root inline instead of reading its status"
fi
grep -cE '="\$\(asc_temp_root\)" \|\| \{' "${here}/ship-testflight.sh" | grep -qx 4 \
  || fail "expected the four asc_temp_root callers to read its status"
#     No mktemp may build its path from TMPDIR directly:  every temp file
#     goes through asc_temp_root, so a root TMPDIR is refused everywhere.
if grep -nE 'mktemp[^#]*\$\{TMPDIR' "${here}/ship-testflight.sh" >&2; then
  fail "ship-testflight.sh builds a mktemp path from TMPDIR instead of asc_temp_root"
fi
# The run-level caller ends with the owner-handoff status 3 and a log line,
# not with a silent errexit status 1.
out_rc="$(TMPDIR=/ bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  log() { echo "[ios-ship] $*"; }
  '"$(awk '/^SHIP_TMP_ROOT="\$\(asc_temp_root\)" \|\| \{/,/^\}/' "${here}/ship-testflight.sh")"'
  echo "not reached"
' 2>&1; echo "rc=$?")"
case "$out_rc" in
  *"Ship blocked: TMPDIR resolves to the filesystem root"*"rc=3") ;;
  *) fail "a root TMPDIR did not end the run with the owner-handoff status: ${out_rc}" ;;
esac

# 11. A PEM is masked over its base64 body, not its armor.  The armor is the
#     same on every key, so two different keys have to give two different
#     previews, and no preview may carry the armor.  The values are synthetic,
#     and key_preview runs in a subshell, so they never reach a process argv.
pem_a=$'-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgSYNTHETICaaaa\nSYNTHETICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111\n-----END PRIVATE KEY-----\n'
pem_b=$'-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgSYNTHETICbbbb\nSYNTHETICBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222\n-----END PRIVATE KEY-----\n'
# shellcheck source=/dev/null
prev_a="$( source "$funcs"; key_preview "$pem_a" )"
# shellcheck source=/dev/null
prev_b="$( source "$funcs"; key_preview "$pem_b" )"
unset pem_a pem_b
[[ "$prev_a" != "$prev_b" ]] || fail "two different keys gave the same preview: ${prev_a}"
case "${prev_a}${prev_b}" in
  *BEGIN*|*END*|*-----*) fail "a preview carried the PEM armor: ${prev_a} / ${prev_b}" ;;
esac
[[ "$prev_a" == "MIGTAgEA...1111" ]] || fail "a PEM preview was not first-eight/last-four of its body: ${prev_a}"
unset prev_a prev_b
# shellcheck source=/dev/null
prev_raw="$( source "$funcs"; key_preview "not-a-pem-but-long-enough-to-mask-9999" )"
[[ "$prev_raw" == "not-a-pe...9999" ]] || fail "a value without armor was not masked as itself: ${prev_raw}"
unset prev_raw

echo "ok: ASC credential resolution (environment first, then Infisical, a named path ignored, temp key removed)"
