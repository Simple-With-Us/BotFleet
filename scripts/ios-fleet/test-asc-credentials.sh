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
    /^fs_get\(\) \{/ || /^asc_temp_root\(\) \{/ || /^asc_tmp_dir\(\) \{/ || /^asc_upload_block\(\) \{/ || /^key_label\(\) \{/ || /^key_issuer_label\(\) \{/ || /^asc_resolve_diagnostic_credential\(\) \{/ || /^load_secrets\(\) \{/ || /^cleanup_asc_tmp\(\) \{/ { grab = 1 }
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
  echo 'ASC_DIAG_KEY_ID=""'
  echo 'ASC_DIAG_ISSUER_ID=""'
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

# 2n. A rejected credential is named by its SOURCE, its KEY ID and its
#     ISSUER ID, and by NOTHING taken out of the key.  There is no masked
#     preview of a private-key body anywhere:  every byte of that body is
#     secret, so a slice of it may never be printed, and it could not even
#     identify the credential -- two different keys share a first eight and a
#     last four, while the key id and the issuer id say exactly which one it
#     is.  The blob reaches the child through a PATH, so no byte of it is
#     ever an argument of a process.
ci_body="SYNTHETICciBODY00000000000000000000000000000000000tail"
# The armor is assembled from parts, the way case 11 does it:  a literal
# PEM BEGIN header naming the key type, written out in full next to a body,
# reads as a private key to gitleaks' private-key rule, and the repo's
# allowlist for this file does not cover this fixture because its marker is
# SYNTHETICciBODY, which the allowlist's SYNTHETIC[A-Z]{4,} pattern does not
# match.
ci_kind="PRIVATE"" KEY"
ci_pem="-----BEGIN ${ci_kind}-----"$'\n'"${ci_body}"$'\n'"-----END ${ci_kind}-----"
printf '%s' "$ci_pem" | base64 | tr -d '\n' > "${tmp}/ci.b64"
ci_mask="$(printf '%s...%s' "${ci_body:0:8}" "${ci_body:$((${#ci_body}-4))}")"
# The guard below has to search for a prefix the blob REALLY carries:  the
# base64 of the PEM armor begins "LS0tLS1C", so a needle like "LS0tLS0t"
# could never match the artifact it is meant to detect, and the assertion
# could never fire.
ci_b64_head="$(cut -c1-24 "${tmp}/ci.b64")"
ci_out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_P8 -u ASC_KEY_PATH \
  -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID -u APPLE_API_KEY_P8_BASE64 \
  ASC_TEST_B64="${tmp}/ci.b64" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  APPLE_API_KEY_ID=BADKEY00001
  APPLE_API_ISSUER_ID=bad-issuer
  APPLE_API_KEY_P8_BASE64="$(cat "$ASC_TEST_B64")"
  load_secrets
' 2>&1)"
case "$ci_out" in
  *"source APPLE_API_KEY_P8_BASE64, key id BADKEY00001, issuer id bad-issuer"*) ;;
  *) fail "the CI credential was not named by its source, key id and issuer id" ;;
esac
case "$ci_out" in
  *"preview "*) fail "a rejected credential was previewed" ;;
esac
case "$ci_out" in
  *"${ci_b64_head}"*) fail "the CI log carried the base64 blob" ;;
esac
unset ci_body ci_pem ci_mask ci_b64_head ci_kind ci_out

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
#    would put it in the process arguments of every child.  The patterns are
#    matched against the file with its line continuations joined, so a value
#    that sits on the next line is still found.
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
# The rejected credential is identified by its source and its two PUBLIC
# labels, the key id and the issuer id, and by nothing taken from the key:
# every byte of a private-key body is secret, whether or not its armor was
# stripped.
case "$cred_log" in
  *"source Infisical /asc, key id ABCDE12345, issuer id issuer-synthetic"*) ;;
  *) fail "a broken credential did not name its source, key id and issuer id" ;;
esac
# There is no masked preview of a private-key body at all, so NOT ONE byte
# of the key may reach the log -- not the mask, not the armor, not a
# fragment.
key_body="$(sed '1d;$d' "${tmp}/asc.p8")"
key_body="${key_body//[[:space:]]/}"
mask="$(printf '%s...%s' "${key_body:0:8}" "${key_body:$((${#key_body}-4))}")"
case "$cred_log" in
  *"$mask"*) fail "a rejected credential carried the masked key body" ;;
esac
unset mask
# No byte run of the key may appear in the log beyond that mask.  Every
# 6-character window of the body is checked with bash pattern matching, so no
# byte of the key ever reaches the argument list of a process, where another
# user could read it through ps.
if [[ "$cred_log" == *"PRIVATE KEY"* ]]; then
  fail "a broken credential printed the key armor"
fi
for ((i = 0; i + 6 <= ${#key_body}; i++)); do
  if [[ "$cred_log" == *"${key_body:i:6}"* ]]; then
    fail "a broken credential printed a fragment of the key body"
  fi
done
unset key_body i

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

# 9. A key id is printed only when it looks like one.  A missing id says so,
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

# 10. Every caller reads asc_temp_root's refusal.  An inline "$(asc_temp_root)/"
#     expansion turns the refused root into a path that names "/", and under
#     errexit a bare assignment ends the run before the owner handoff.
if grep -nE '\$\(asc_temp_root\)[^"]|"\$\(asc_temp_root\)/' "${here}/ship-testflight.sh" >&2; then
  fail "ship-testflight.sh expands asc_temp_root inline instead of reading its status"
fi
grep -cE '="\$\(asc_temp_root\)" \|\| \{' "${here}/ship-testflight.sh" | grep -qx 5 \
  || fail "expected the five asc_temp_root callers to read its status"
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

# 11. Every rejection diagnostic names the source, the key id and the failure
#     class, and no fragment of the key.  Each source is fed a synthetic value
#     the validator refuses (status 3), with a well-formed, a missing and an
#     unrecognized key id.  The armor is assembled from parts, so the
#     synthetic PEM never looks like a committed private key to a scanner.
pem_kind="PRIVATE"" KEY"
syn_body="SYNTHETICbodyAAAAqqqqBBBBrrrrCCCCssssDDDDttttEEEEuuuuFFFFvvvvGGGG"
syn_pem="-----BEGIN ${pem_kind}-----"$'\n'"${syn_body}"$'\n'"-----END ${pem_kind}-----"
check_diag() {  # <label> <log> <expected substring>
  local label="$1" out="$2" want="$3" i mask
  [[ "$out" == *"$want"* ]] || fail "${label}: diagnostic did not say: ${want}"
  [[ "$out" != *"PRIVATE KEY"* ]] || fail "${label}: diagnostic carried the key armor"
  #  The diagnostic carries NO masked preview of the key:  every byte of a
  #  private-key body is secret, so not one byte of it may reach the log.
  mask="$(printf '%s...%s' "${syn_body:0:8}" "${syn_body:$((${#syn_body}-4))}")"
  [[ "$out" != *"$mask"* ]] || fail "${label}: diagnostic carried the masked key body"
  for ((i = 0; i + 6 <= ${#syn_body}; i++)); do
    [[ "$out" != *"${syn_body:i:6}"* ]] || fail "${label}: diagnostic carried a fragment of the key body"
  done
}
mkdir -p "${tmp}/bin-val3"
cat > "${tmp}/bin-val3/node" <<WRAP
#!/usr/bin/env bash
if [[ "\${1:-}" == *asc-key.mjs && "\${2:-}" == validate ]]; then cat >/dev/null; exit 3; fi
exec "$real_node" "\$@"
WRAP
chmod 700 "${tmp}/bin-val3/node"
run_diag() {  # env assignments..., then load_secrets with the refusing validator
  # The credential travels in the CHILD's environment, never in the
  # arguments of a process:  an argument is readable by every process on the
  # machine through ps.
  (
    unset APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_KEY_P8_BASE64 \
          ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 ASC_KEY_PATH
    local a
    for a in "$@"; do export "$a"; done
    env PATH="${tmp}/bin-val3:${PATH}" bash -c '
    source "'"$funcs"'"
    FLEET_SECRETS_BIN="'"${tmp}"'/no-vault"
    load_secrets
    echo "class=${ASC_AUTH_FAILURE:-none}"
  ' 2>&1
  )
}
for kid in ABCDE12345 "" "bad id"; do
  case "$kid" in ABCDE12345) want_id=ABCDE12345 ;; "") want_id=missing ;; *) want_id=unrecognized ;; esac
  out="$(run_diag APPLE_API_KEY_ID="$kid" APPLE_API_ISSUER_ID=issuer-synthetic APPLE_API_KEY_P8_BASE64="$syn_pem")"
  # An empty APPLE_API_KEY_ID skips that source entirely, so only the
  # well-formed and unrecognized ids reach its rejection.
  if [[ -n "$kid" ]]; then
    check_diag "APPLE_API_KEY_P8_BASE64 id=${want_id}" "$out" "(source APPLE_API_KEY_P8_BASE64, key id ${want_id}"
    check_diag "APPLE_API_KEY_P8_BASE64 class" "$out" "class=credential"
  fi
  out="$(run_diag ASC_KEY_ID="$kid" ASC_ISSUER_ID=issuer-synthetic ASC_KEY_P8="$syn_pem")"
  if [[ -n "$kid" ]]; then
    check_diag "ASC_KEY_P8 id=${want_id}" "$out" "does not hold a PEM private key; ignoring it (source ASC_KEY_P8, key id ${want_id}"
    check_diag "ASC_KEY_P8 class" "$out" "class=credential"
  else
    check_diag "ASC_KEY_P8 without id" "$out" "set without ASC_KEY_ID and ASC_ISSUER_ID; ignoring it (source ASC_KEY_P8, key id missing"
  fi
done
unset kid want_id out syn_pem syn_body pem_kind

# 12. The diagnostic identity of a rejected credential mirrors the CLIENT's
#     source selection:  a source counts only when its whole trio is present
#     and its key decodes to a PEM, so the diagnostic never names a key the
#     client skipped.  The preview is the fleet's masked preview of the key
#     BODY, and it is taken only from material the ENVIRONMENT already holds:
#     a diagnostic never causes a secret read from the vault.
run_diag_identity() {  # env assignments..., then the resolver
  # The credential travels in the CHILD's environment, never in the
  # arguments of a process:  an argument is readable by every process on the
  # machine through ps.  The names this call does not set are cleared first,
  # so one call can never see the previous call's credential, and the
  # clearing happens in a subshell so the test's own environment is intact.
  (
    unset APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_KEY_P8_BASE64 \
          ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 ASC_KEY_PATH
    local a
    for a in "$@"; do export "$a"; done
    env FLEET_SECRETS_BIN="${tmp}/fleet-secrets" bash -c '
    source "'"$funcs"'"
    asc_resolve_diagnostic_credential
    printf "id=%s\nissuer=%s\n" "$ASC_DIAG_KEY_ID" "$ASC_DIAG_ISSUER_ID"
    # The argv block is DELIMITED, and it is not a single line:  a command
    # line can carry more than one physical line, so the guard that reads it
    # must scan the whole block and not only its first line.
    printf "argv-begin\n"
    ps -o args= -p $$ 2>/dev/null || true
    printf "argv-end\n"
  ' 2>&1
  )
}
real_body="$(sed '1d;$d' "${tmp}/asc.p8")"
real_body="${real_body//[[:space:]]/}"
real_mask="$(printf '%s...%s' "${real_body:0:8}" "${real_body:$((${#real_body}-4))}")"
real_b64="$(base64 < "${tmp}/asc.p8" | tr -d '\n')"

out="$(run_diag_identity APPLE_API_KEY_ID=CIKEY00001 APPLE_API_ISSUER_ID=issuer-synthetic APPLE_API_KEY_P8_BASE64="$real_b64")"
[[ "$out" == *"id=CIKEY00001"* ]] || fail "the CI key id was not named"
[[ "$out" == *"issuer=issuer-synthetic"* ]] || fail "the CI issuer id was not named"
[[ "$out" != *"$real_mask"* ]] || fail "the CI diagnostic carried the masked key body"
out="$(run_diag_identity ASC_KEY_ID=ENVKEY00002 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_P8="$(cat "${tmp}/asc.p8")")"
[[ "$out" == *"id=ENVKEY00002"* ]] || fail "the environment key id was not named"
[[ "$out" == *"issuer=issuer-synthetic"* ]] || fail "the environment issuer id was not named"
[[ "$out" != *"$real_mask"* ]] || fail "the environment diagnostic carried the masked key body"
# The credential reaches the child in its ENVIRONMENT, so the child's own
# arguments must not carry a byte of it:  an argument is readable by every
# process on the machine through ps.  The guard below covers the process
# that starts the child; this one covers the child itself.
case "$out" in
  *"argv-begin"*"argv-end"*) ;;
  *) fail "the diagnostic child did not report its own arguments" ;;
esac
# The WHOLE delimited block is scanned:  a credential on any later physical
# line of the argv must not slip past this guard.
argv_block="$(printf '%s\n' "$out" | awk '/^argv-begin$/{f=1;next} /^argv-end$/{f=0} f')"
[[ "$argv_block" != *"$real_body"* ]] || fail "the credential reached the diagnostic child in its command arguments"

# A half-set trio is skipped by the client, so the diagnostic must not name
# it:  the key id comes from the client's last source instead.
out="$(run_diag_identity APPLE_API_KEY_ID=CIKEY00001)"
[[ "$out" != *"CIKEY00001"* ]] || fail "a half-set trio was named"
[[ "$out" == *"id=ABCDE12345"* ]] || fail "the fallback key id was not named"
# A trio whose key does not decode is skipped by the client too.
out="$(run_diag_identity APPLE_API_KEY_ID=CIKEY00001 APPLE_API_ISSUER_ID=issuer-synthetic APPLE_API_KEY_P8_BASE64="not-base64-at-all")"
[[ "$out" != *"CIKEY00001"* ]] || fail "a key that does not decode was named"

# The client SKIPS an unusable CI trio and goes on to the environment trio,
# so the diagnostic has to do the same:  it must not stop at the CI source,
# and it must name the environment credential the client went on to use.
out="$(run_diag_identity APPLE_API_KEY_ID=CIKEY00001 APPLE_API_ISSUER_ID=issuer-synthetic APPLE_API_KEY_P8_BASE64="not-base64-at-all" \
  ASC_KEY_ID=ENVKEY00002 ASC_ISSUER_ID=issuer-synthetic ASC_KEY_P8="$(cat "${tmp}/asc.p8")")"
[[ "$out" != *"CIKEY00001"* ]] || fail "an unusable CI trio was named"
[[ "$out" == *"id=ENVKEY00002"* ]] || fail "the environment key id was not named after the CI trio was skipped"
[[ "$out" == *"issuer=issuer-synthetic"* ]] || fail "the environment issuer id was not named after the CI trio was skipped"
[[ "$out" != *"$real_mask"* ]] || fail "the environment diagnostic carried the masked key body after the CI trio was skipped"

# A diagnostic never causes a secret read:  the vault is asked for the KEY
# ID, which is a public label, and never for the key material.
: > "$FAKE_LOG"
out="$(run_diag_identity)"
[[ "$out" == *"id=ABCDE12345"* ]] || fail "the vault key id was not named"
[[ "$out" == *"issuer=issuer-synthetic"* ]] || fail "the vault issuer id was not named"
[[ "$out" != *"preview"* ]] || fail "a preview was invented"
if grep -q "ASC_KEY_P8 /asc" "$FAKE_LOG"; then
  fail "the diagnostic read the key material from the vault"
fi
grep -q "ASC_KEY_ID /asc" "$FAKE_LOG" || fail "the diagnostic did not read the vault key id"
unset out real_body real_mask real_b64

# The version helpers run inside command substitutions, where load_secrets
# would write a temp key whose cleanup trap dies with the subshell.  They must
# check for a credential instead.
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

echo "ok: ASC credential resolution (environment first, then Infisical, a named path ignored, temp key removed)"
