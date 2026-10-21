// The App Store Connect private key:  how it is validated, how it is staged
// for the Apple tools, and how the client takes it.
//
// The private key is a secret, and the approved secret sources are the
// process environment, a captured `fleet-secrets get NAME` and bootstrap-only
// Keychain credentials.  A path on disk is not one of them, so the node client
// never reads a key file.  This module is the part of that handoff the shell
// layer needs:  it validates a PEM and it stages the key for the Apple tools
// that have no other way to take one.
//
// THE STAGED COPY IS THE ONE FILE THAT MAY EXIST, and it is deliberately
// narrow.  `altool` and `xcodebuild -authenticationKeyPath` take a key file
// and nothing else, so the shell layer has to write one, and this module is
// where that write happens.  The copy is:
//
//   - short-lived:  it lives in a staging directory the run removes on exit;
//   - owner-only:  the file is mode 600, and the writer refuses a target whose
//     parent directory is not owner-only, so a credential can never land in a
//     shared or durable place;
//   - never read back as a credential:  the credential comes from the
//     environment or from fleet-secrets, and the staged file is a
//     materialisation for the Apple tools, nothing more.
//
// A key on stdout is a key in a log, in a CI transcript and in whatever
// captures that output next.  So `validate` reports the STATUS of a key and
// never the key itself, and the key reaches a consumer through the process
// environment:  never in an argument, never on stdout, never in a log line.
//
// WHAT THE ENVIRONMENT IS NOT (2026-10-21, audit on PR #271):
// The key is not in argv, not on stdout and not in a log line, and a child
// is given an allowlist of variables instead of a copy of the parent's
// environment.  The environment of a process is still readable by another
// process of the same user on this platform:  `ps eww` and `ps -E` show it,
// and the PEM envelope is in the listing of the key-bearing child.  So the
// handoff keeps the key out of the places a process listing is read for (the
// command line) and out of every log, and it does not claim more than that.
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, ftruncateSync, fchmodSync, writeSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { posix } from "node:path";

// A private key is a few kilobytes.  Anything larger is not one.
const MAX_KEY_BYTES = 64 * 1024;

// Normalizes a PEM private key and refuses anything that is not one.
//
// The envelope alone is not enough: a truncated key, an armored block or a
// mangled export carries the envelope and still fails to parse, and an
// unparsable key that reaches the signer comes back as a raw stack trace
// instead of a credential error.  So the key is parsed before it is accepted.
//
// Returns the normalized PEM, or null when the value is not a private key.
export function normalizePrivateKey(value) {
  const pem = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!pem) return null;
  if (pem.length > MAX_KEY_BYTES) return null;
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pem)) return null;
  try {
    createPrivateKey(pem);
  } catch {
    return null;
  }
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}

// Directories and files a credential may never be written to:  credentials,
// shell start-up files, and anything that runs at login.  This is the house
// list from server/tool-policy.ts, so a key file and a routine's own file are
// refused by the same rules.
const PROTECTED_WRITE_PARTS = ["/.ssh/", "/.secrets/", "/.gnupg/", "/.aws/", "/.config/gh/", "/Library/LaunchAgents/", "/Library/LaunchDaemons/"];

/** True for a dotfile, a file in a dot directory, or anything under a
 *  credential or login directory.  macOS volumes are case-insensitive by
 *  default, so the comparison is folded. */
function isProtectedPath(path) {
  if (path.split("/").some((part) => part.startsWith("."))) return true;
  const folded = `${path}/`.toLowerCase();
  return PROTECTED_WRITE_PARTS.some((part) => folded.includes(part.toLowerCase()));
}

/** How many links one path may pass through before it counts as a loop. */
const MAX_LINK_HOPS = 40;

/** Where `path` really lands, walked one component at a time from the root.
 *  Only links the operating system owns (owner root:  macOS's `/tmp`, `/var`
 *  and `/etc`) are followed.  Once a component does not exist yet, the rest is
 *  appended as it is:  nothing below a missing directory can redirect.  Null
 *  when the path runs through any other link (a user-level process, one of a
 *  routine's own commands or a checked-out repository could have planted it,
 *  so it may point anywhere, protected or not), through a link loop, or
 *  through something it cannot read, and when it names an existing file that
 *  has another hard link (another name for the same file, possibly in a
 *  protected place).
 *
 *  This is the house root-owned-link policy from
 *  server/drivers/acp/allowlist.ts. */
function resolvedLocation(path) {
  const pending = path.split("/").filter(Boolean);
  let current = "/";
  let hops = 0;
  let last = null;
  while (pending.length > 0) {
    const next = posix.join(current, pending.shift());
    try {
      last = lstatSync(next);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      return missing ? posix.join(next, ...pending) : null;
    }
    if (last.isSymbolicLink()) {
      if (last.uid !== 0 || ++hops > MAX_LINK_HOPS) return null;
      let target;
      try {
        target = readlinkSync(next);
      } catch {
        return null;
      }
      pending.unshift(...posix.resolve(current, target).split("/").filter(Boolean));
      current = "/";
      continue;
    }
    current = next;
  }
  if (last?.isFile() && last.nlink > 1) return null;
  return current;
}

/** Whether a directory is one only the owner may enter.  The staged key
 *  lives in such a directory, so the copy of the credential is not reachable
 *  by anyone else, and a file another user could replace cannot be written
 *  under it. */
function isOwnerOnlyDirectory(path) {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    return (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** The target the staged key may be written to, or the reason it may not.
 *
 *  A staged key is written into an owner-only staging directory, so the
 *  target has to be a clean absolute path, its directory has to be owner-only,
 *  and where the path really lands has to be outside every protected place
 *  and must not run through a link the operating system does not own. */
export function resolveStagingTarget(keyPath) {
  //  The boundary parses the input into a path, and the checks below branch
  //  on what a path may be:  absolute, normal, in an owner-only directory,
  //  and nowhere protected.
  const target = String(keyPath ?? "");
  if (!target.startsWith("/")) {
    return { error: "the staged key path has to be an absolute path" };
  }
  if (posix.normalize(target) !== target) {
    return { error: "the staged key path is not a normal path" };
  }
  const dir = posix.dirname(target);
  if (!isOwnerOnlyDirectory(dir)) {
    return { error: `the staging directory ${dir} is not owner-only` };
  }
  const real = resolvedLocation(target);
  if (real === null) {
    return { error: "the staged key path runs through a link that is not owned by the system" };
  }
  if (isProtectedPath(real) || isProtectedPath(target)) {
    return { error: "the staged key path names a protected place" };
  }
  return { path: target, real };
}

/** Writes the key to the staging file the Apple tools read.
 *
 *  The file is opened without following a link at the last component and
 *  without truncating before the handle is checked, so a path that was
 *  swapped for a symlink cannot redirect the key and a file that was swapped
 *  for a hard link cannot receive it.  The handle is then verified against
 *  where the path resolves to now, the file is truncated on the verified
 *  handle, written, and set to mode 600 whatever it was before.
 *
 *  Returns { pem } when the key was written, and { error } for every other
 *  outcome.  The key is never printed. */
export function writePrivateKeyFile(keyPath, value) {
  const pem = normalizePrivateKey(value);
  if (!pem) {
    return { error: "the value is not a PEM private key" };
  }
  const target = resolveStagingTarget(keyPath);
  if (target.error) {
    return { error: target.error };
  }
  let fd;
  try {
    //  O_NOFOLLOW:  the kernel refuses a link at the file itself.  No
    //  O_TRUNC:  nothing is truncated before the handle has been checked.
    fd = openSync(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error && error.code === "ELOOP") {
      return { error: `the staged key path ${keyPath} is a symbolic link, which is not written` };
    }
    return { error: `the staged key file ${keyPath} could not be opened` };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      return { error: `the staged key file ${keyPath} is not a regular file with one link` };
    }
    //  Where the path lands now has to be the file this handle is on:  a
    //  link or a directory swapped in between the checks and the open makes
    //  the device and inode differ, and the handle is refused.
    const real = resolvedLocation(target.path);
    if (real === null || isProtectedPath(real)) {
      return { error: `the staged key path ${keyPath} no longer resolves to a usable place` };
    }
    try {
      const now = lstatSync(real);
      if (now.dev !== opened.dev || now.ino !== opened.ino) {
        return { error: `the staged key path ${keyPath} was swapped while it was opened` };
      }
    } catch {
      return { error: `the staged key file ${keyPath} could not be verified` };
    }
    ftruncateSync(fd, 0);
    writeSync(fd, pem);
    //  The mode is enforced on the handle, so an existing file keeps no
    //  permissions of its own.
    fchmodSync(fd, 0o600);
    return { pem };
  } catch {
    return { error: `the staged key file ${keyPath} could not be written` };
  } finally {
    closeSync(fd);
  }
}

// The variables the App Store Connect client needs from the environment.
//
// The child's environment is an allowlist, never a copy of the parent's:  a
// wholesale copy hands every credential on the operator's machine to the
// child, including the ones that have nothing to do with App Store Connect.
// These are the variables the client reads (see resolveCredential in
// asc-api.mjs), plus PATH and HOME, which it needs to find fleet-secrets and
// to reach the bootstrap Keychain.
export const CLIENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "ASC_API_BASE",
  "ASC_REQUEST_TIMEOUT_MS",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_P8_BASE64",
  "FLEET_SECRETS_BIN",
  "FLEET_SECRETS"
];

// Builds the environment a child of the key handoff runs with.
//
// Only the allowlisted variables cross over, and the key is added
// separately:  it goes in as ASC_KEY_P8 and in no other variable.
export function clientEnvironment(env = process.env, extra = {}) {
  const child = {};
  for (const name of CLIENT_ENV_ALLOWLIST) {
    const value = env[name];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the child env boundary: only a string can go into a child's environment, and a non-string value would throw there instead of here.
    if (typeof value === "string" && value.length > 0) child[name] = value;
  }
  return { ...child, ...extra };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "validate") {
    const pem = normalizePrivateKey(await readStdin());
    if (!pem) {
      console.error("asc-key: the value is not a PEM private key");
      return 1;
    }
    //  The key is not printed here either:  see the module header.
    console.log("asc-key: the value is a PEM private key");
    return 0;
  }
  if (command === "write") {
    if (!target) {
      console.error("asc-key: usage: asc-key.mjs write <path>");
      return 1;
    }
    //  The target is checked before the key is read:  a path that names a
    //  protected place is refused without the key ever arriving.
    const staging = resolveStagingTarget(target);
    if (staging.error) {
      console.error(`asc-key: ${staging.error}`);
      return 1;
    }
    const written = writePrivateKeyFile(target, await readStdin());
    if (written.error) {
      console.error(`asc-key: ${written.error}`);
      return 1;
    }
    return 0;
  }
  console.error("asc-key: usage: asc-key.mjs validate | write <path>");
  return 1;
}

// The entrypoint check compares the folded basename, because macOS volumes are
// case-insensitive by default:  a differently cased path is the same file,
// and a longer name that ends with it is not.
if (process.argv[1] && posix.basename(process.argv[1]).toLowerCase() === "asc-key.mjs") {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      //  A rejection here is a bug in this module, not a credential error.
      //  The message is logged and the exit code is nonzero; nothing about
      //  the key is printed.
      console.error(`asc-key: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
