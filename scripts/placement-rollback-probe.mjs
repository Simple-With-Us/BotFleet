// Static inspector and isolated fixture probe for ONE explicitly selected
// placement rollback candidate (BF-2632).
//
// WHY THIS EXISTS.  The read-only rollback bridge (server/placement-readonly.ts)
// is proven against the source tree.  That says nothing about a retained
// artifact: a release directory can drift from the commit it names, a shipped
// runtime can lack `node:sqlite`, and a later prune can replace the generation
// an earlier check looked at.  This module answers one narrow question about
// one named directory and one named runtime, and it never answers "go".
//
// WHAT IT DOES NOT DO.  It never activates, builds, downloads, stages,
// promotes, swaps, prunes or migrates anything, and it never looks for a
// candidate: it inspects exactly the paths it was handed.  Every result
// carries `activationAllowed: false`.  The release manifest is read and never
// written; the proof receipt is a separate file in a directory the caller
// names outside the release.
//
// TWO ENTRY POINTS, AND ONLY ONE CAN SAY "VERIFIED".
//   inspectPlacementRollbackCandidate   static.  Returns "blocked" or
//                                       "probe-required".  Nothing is executed.
//   runPlacementRollbackFixtureProbe    recomputes the same binding itself,
//                                       boots the candidate with the selected
//                                       runtime in a new temporary HOME, runs
//                                       the legacy-then-normalized recipe, tears
//                                       the child down by process group and
//                                       rechecks the binding.  It is the only
//                                       path that can return "fixture-verified".
// Neither reads a report, a status or a flag from its caller: a result is
// built only from evidence this module gathered in the same call.
//
// "fixture-verified" means the isolated fixture recipe passed for the bytes
// that were bound.  It is not a shipped-runtime pass for anything other than
// those bytes, and it grants no authority to migrate, enable a mode, update
// authentication or prune another rollback generation.
//
// Node built-ins and existing repository .mjs only: this module must stay
// importable where no node_modules exists beside it.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validBuildIdentity } from "../electron/runtime-identity.mjs";
import { isReleaseDirectory, validateReleaseManifest } from "./harness-release-store.mjs";
import { hashDependencyTree, verifyReleaseAgainstCommit } from "./release-provenance.mjs";
import { readSourceBuildIdentity } from "./source-build-identity.mjs";

const execFileAsync = promisify(execFile);

/** Bumped whenever a recipe step is added, removed or changed in meaning. */
export const PLACEMENT_ROLLBACK_RECIPE_VERSION = 1;
/** The only normalized ledger schema this recipe knows how to exercise. */
export const PLACEMENT_ROLLBACK_SCHEMA = "normalized-v1";
export const PLACEMENT_ROLLBACK_RECEIPT_VERSION = 1;
/** The only candidate kind this unit binds.  Every other kind is blocked. */
export const RELEASE_STORE_KIND = "release-store";

/**
 * How a release-store harness is launched: the exact argument list of
 * scripts/botfleet-server-start.sh (`exec "$NODE" --experimental-strip-types
 * server/index.ts`, from the release root).  The probe uses the candidate's
 * own launch shape so a development Node cannot stand in for the selected
 * runtime.
 */
export const RELEASE_STORE_LAUNCH_ARGUMENTS = Object.freeze(["--experimental-strip-types", "server/index.ts"]);

/**
 * The container-runtime lockdown a harness child must carry.  These mirror
 * `containerRuntimeLockdownEnv()` in server/container-runtime-guard.ts, which
 * is TypeScript and so cannot be imported here; the probe's own test pins the
 * two copies together.
 */
export const CONTAINER_LOCKDOWN_ENV = Object.freeze({
  BOTFLEET_DISABLE_CONTAINER_RUNTIME: "1",
  DOCKER_HOST: "unix:///nonexistent.sock",
  CONTAINER_HOST: "unix:///nonexistent.sock",
});

const FULL_COMMIT = /^[a-f0-9]{40}$/;
// shared/placement.ts HOST_ID_PATTERN; TypeScript, so restated.
const HOST_ID_PATTERN = /^(mac|server):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_NONCE = /^[a-f0-9]{64}$/;
const MANIFEST = ".botfleet-release.json";
const LOG_TAIL_BYTES = 16 * 1024;
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The generated ledger fixture.  The identifiers and epochs are the ones the
 * reviewed source recipe in server/placement-controller-epochs.test.ts uses:
 * a nonzero legacy fence, a normalized fence above it, and a later fence the
 * fixture writer commits while the candidate is running.
 */
const FIXTURE = Object.freeze({
  hostId: "server:11111111-1111-4111-8111-111111111111",
  nextId: "mac:22222222-2222-4222-8222-222222222222",
  legacyEpoch: 5,
  normalizedEpoch: 7,
  advancedEpoch: 9,
  oldLeaseEpoch: 3,
});

/** The ten placement actions of PLACEMENT_LEASE_ACTIONS that the source recipe posts. */
const PLACEMENT_POST_ACTIONS = Object.freeze([
  "register", "heartbeat", "claim", "dispatch", "stop", "release", "release-controller", "takeover", "enqueue", "report",
]);

const DEFAULT_TIMEOUTS = Object.freeze({
  bootMs: 60_000,
  requestMs: 5_000,
  stopGraceMs: 5_000,
  // The source recipe waits out the boot-recovery delay before it compares
  // saved evidence, so recovery that WOULD consume it has had time to run.
  settleMs: 3_000,
  convergeMs: 10_000,
  writerMs: 60_000,
});

/**
 * The two waits that are recipe steps rather than deadlines: they give the
 * candidate time to DO something the recipe then looks for (delayed boot
 * recovery; whatever it writes on a polite shutdown).  Shortening either one
 * hides behaviour, so a caller can lengthen them and never shorten them.  The
 * other four are deadlines: a shorter one can only block a run sooner.
 */
const FLOORED_WAITS = Object.freeze(["settleMs", "stopGraceMs"]);
/** Above this a wait is a mistake, and near 2^31 ms Node's timer overflows to 1 ms. */
const MAX_WAIT_MS = 10 * 60_000;

/**
 * The waits one run uses.  An override is honoured only when it is a finite
 * number of milliseconds between the wait's floor and MAX_WAIT_MS; anything
 * else leaves the recipe default in place and is named in `ignored`, so a
 * receipt shows both the waits that applied and the ones that were refused.
 */
function recipeTimeouts(overrides) {
  const timeouts = { ...DEFAULT_TIMEOUTS };
  const ignored = [];
  if (isRecord(overrides)) {
    for (const name of Object.keys(DEFAULT_TIMEOUTS)) {
      const value = overrides[name];
      if (value === undefined) continue;
      const floor = FLOORED_WAITS.includes(name) ? DEFAULT_TIMEOUTS[name] : 0;
      if (Number.isFinite(value) && value >= floor && value <= MAX_WAIT_MS) timeouts[name] = value;
      else ignored.push(name);
    }
  }
  return { timeouts, ignored };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isText = (value) => value === String(value) && value.length > 0;
const isRecord = (value) => value !== null && Object(value) === value && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function blocker(code, detail, phase) {
  return phase ? { code, detail: String(detail), phase } : { code, detail: String(detail) };
}

function describe(error) {
  return error?.message || String(error);
}

function deepFreeze(value) {
  if (isRecord(value) || Array.isArray(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Key-sorted JSON, so a digest does not depend on property order. */
function canonicalJson(value) {
  if (value instanceof Uint8Array) return JSON.stringify(`bytes:${Buffer.from(value).toString("hex")}`);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function lstatOrNull(path) {
  try {
    return { stat: lstatSync(path) };
  } catch (error) {
    return { error };
  }
}

/** A path with every link in it resolved, or the plain resolved path when it does not exist. */
function physicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const MACH_O_MAGIC = Object.freeze([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, // thin, either byte order
  0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca, // universal
]);

/** "elf", "mach-o", or null for anything the kernel would not load by itself. */
function nativeExecutableFormat(head) {
  if (head.length < 4) return null;
  const magic = head.readUInt32BE(0);
  if (magic === 0x7f454c46) return "elf";
  return MACH_O_MAGIC.includes(magic) ? "mach-o" : null;
}

/**
 * sha256 of one native executable, opened without following a link and
 * checked to be the same inode that was inspected.
 *
 * The runtime is bound by its PHYSICAL path: links in the parent directories
 * are resolved once, here, and the resolved path is what gets hashed, recorded
 * and later started, so repointing a link afterwards cannot change which file
 * the binding names.  A link as the last component is refused rather than
 * resolved: the caller names the binary, not a pointer to it.
 *
 * Only an ELF or Mach-O file is accepted.  An interpreter script would bind
 * the few bytes of the script while a different, unbound program (whatever its
 * `#!` line names) actually ran the candidate.  Shared libraries the binary
 * loads at run time are outside this fingerprint.
 */
function fingerprintRuntime(named) {
  let path;
  try {
    path = join(realpathSync(dirname(named)), basename(named));
  } catch (error) {
    return { blocker: blocker(error?.code === "ENOENT" ? "runtime-missing" : "runtime-unreadable", `${named}: ${describe(error)}`) };
  }
  const seen = lstatOrNull(path);
  if (seen.error) {
    return { blocker: blocker(seen.error.code === "ENOENT" ? "runtime-missing" : "runtime-unreadable", `${path}: ${describe(seen.error)}`) };
  }
  if (seen.stat.isSymbolicLink()) {
    return { blocker: blocker("runtime-symlink", `${path} is a symbolic link; name the physical runtime binary`) };
  }
  if (!seen.stat.isFile()) return { blocker: blocker("runtime-not-file", `${path} is not a regular file`) };
  if ((seen.stat.mode & 0o111) === 0) return { blocker: blocker("runtime-not-executable", `${path} has no executable bit`) };
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (opened.dev !== seen.stat.dev || opened.ino !== seen.stat.ino) {
      return { blocker: blocker("runtime-unreadable", `${path} changed while it was being opened`) };
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    let format = null;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      if (bytes === 0) {
        format = nativeExecutableFormat(chunk.subarray(0, read));
        if (format === null) {
          const script = read >= 2 && chunk[0] === 0x23 && chunk[1] === 0x21;
          return { blocker: blocker("runtime-not-binary", `${path} is ${script ? "an interpreter script" : "not an ELF or Mach-O executable"}; name the runtime binary itself, so the bytes that run the candidate are the bytes that are bound`) };
        }
      }
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
    if (format === null) return { blocker: blocker("runtime-not-binary", `${path} is empty`) };
    return { runtime: { path, format, sha256: hash.digest("hex"), bytes } };
  } catch (error) {
    return { blocker: blocker("runtime-unreadable", `${path}: ${describe(error)}`) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The text of one regular, singly linked file, read through a handle that was
 * opened without following a link and that is the very inode `listed` (an
 * lstat of the same path) describes.  A file swapped for a link or another
 * file between the listing and the open, or one with another hard link, is a
 * `problem` and never a read.
 */
function readListedRegularFile(path, listed) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== listed.dev || opened.ino !== listed.ino) {
      return { problem: `${path} changed while it was being opened, or has another hard link` };
    }
    return { text: readFileSync(fd, "utf8") };
  } catch (error) {
    return { problem: `${path}: ${describe(error)}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Credential and login directories a candidate path may never name or lead
 * into.  This restates PROTECTED_WRITE_PARTS in server/tool-policy.ts (that
 * file is TypeScript and imports zod, so this module cannot); the probe's own
 * test pins the two lists together.  It deliberately does NOT refuse every dot
 * directory the way that file's isProtectedPath does: the release store's own
 * default home is ~/.botfleet, so a release root there is the normal case.
 */
export const PROTECTED_PATH_PARTS = Object.freeze([
  "/.ssh/", "/.secrets/", "/.gnupg/", "/.aws/", "/.config/gh/", "/Library/LaunchAgents/", "/Library/LaunchDaemons/",
]);

function namesProtectedPlace(path) {
  // macOS volumes are case-insensitive by default, so compare folded.
  const folded = `${path}/`.toLowerCase();
  return PROTECTED_PATH_PARTS.some((part) => folded.includes(part.toLowerCase()));
}

/**
 * A blocker when `path` names a protected place, leads into one through any
 * link, or is a link that leads nowhere (where it was meant to land is then
 * unknown); null otherwise.  A path that does not exist at all is left to the
 * later steps, which report it as missing.
 */
function protectedPathBlocker(label, path) {
  const named = resolve(path);
  if (namesProtectedPlace(named)) return blocker("candidate-path-protected", `${label} ${named} names a credential or login directory`);
  let real;
  try {
    real = realpathSync(named);
  } catch {
    return lstatOrNull(named).stat?.isSymbolicLink()
      ? blocker("candidate-path-dangling-link", `${label} ${named} is a link that does not resolve, so where it leads is unknown`)
      : null;
  }
  if (namesProtectedPlace(real)) return blocker("candidate-path-protected", `${label} ${named} leads into a credential or login directory (${real})`);
  return null;
}

/**
 * Run one SYNCHRONOUS action with some environment variables set (a string)
 * or removed (null), and put the previous values back afterwards.  The
 * provenance and identity modules start git with this process's environment,
 * so this is how the probe pins what they see without changing them.
 */
function withEnvironment(changes, action) {
  const saved = Object.keys(changes).map((name) => [name, process.env[name]]);
  try {
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    return action();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * A commit id binds its tree only while git answers with the object that id
 * hashes.  A `refs/replace/<commit>` entry in the named repository makes git
 * answer with a DIFFERENT commit's tree under the expected id: local-only
 * state that no fetch shows and no history rewrite is needed for.  Every git
 * read the binding depends on therefore runs with replacement turned off.
 */
const GIT_OBJECTS_AS_HASHED = Object.freeze({ GIT_NO_REPLACE_OBJECTS: "1" });

/**
 * The build identity of a release root, bound to the caller's explicit
 * repository.  `readSourceBuildIdentity` takes its repository candidates from
 * the environment, so the explicit one is put first for the length of this
 * synchronous call and the previous values are restored afterwards.  The
 * selected repository has already verified this release by the time this
 * runs, so the first candidate answers and no other location is consulted.
 */
function readBoundIdentity(root, sourceRepo, referenceDeps) {
  return withEnvironment({
    ...GIT_OBJECTS_AS_HASHED,
    BOTFLEET_PROVENANCE_REPO: sourceRepo,
    BOTFLEET_CHECKOUT: null,
    BOTFLEET_PROVENANCE_DEPS: referenceDeps || null,
  }, () => readSourceBuildIdentity(root));
}

function provenanceBlocker(verdict) {
  if (verdict.reason === "drift") return blocker("artifact-drift", verdict.detail);
  if (verdict.reason === "repo-unavailable") return blocker("source-repo-unavailable", verdict.detail);
  if (verdict.reason === "commit-missing") return blocker("source-commit-missing", verdict.detail);
  if (verdict.reason === "unverifiable") return blocker("dependencies-unverifiable", verdict.detail);
  return blocker("provenance-unverifiable", verdict.detail ?? verdict.reason ?? "release provenance returned no reason");
}

/**
 * Bind one candidate to its verified provenance and content inventory.
 *
 * Returns `{ kind, blockers, binding, bindingDigest, physical }`.  A blocked
 * binding carries no binding at all: a partial one could be mistaken for a
 * verified one.  Only the named fields of `candidate` are read; anything else
 * a caller attaches (a report, a status, a flag) is not evidence and is not
 * looked at.
 */
async function bindCandidate(candidate, { platform = process.platform } = {}) {
  const refused = (kind, ...blockers) => ({ kind, blockers, binding: null, bindingDigest: null, physical: null });
  if (!isRecord(candidate)) return refused(null, blocker("candidate-invalid", "a candidate is an object naming a kind, a release root, a source commit, a source repository and a runtime path"));
  const kind = isText(candidate.kind) ? candidate.kind : null;
  if (kind === null) {
    return refused(null, blocker("candidate-kind-missing", `name the candidate kind explicitly; this unit binds "${RELEASE_STORE_KIND}"`));
  }
  if (kind === "signed-bundle") {
    // Mac signature and packaged-runtime checks need the supported platform
    // and the selected bundle.  Off darwin that capability does not exist; on
    // darwin this unit still has no bundle binding.  Either way it is a named
    // missing proof, never a reason to accept something weaker.
    if (platform !== "darwin") {
      return refused(kind, blocker("signed-bundle-platform-unavailable", `missing proof: Mac code signature and packaged runtime identity can only be checked on darwin; this host is ${platform}`));
    }
    return refused(kind, blocker("signed-bundle-binding-unimplemented", "missing proof: this unit binds release-store candidates only; a signed bundle needs the existing bundle validation contract, which is not wired here"));
  }
  if (kind !== RELEASE_STORE_KIND) {
    return refused(kind, blocker("candidate-kind-unsupported", `"${kind}" is not a candidate kind this unit binds; only "${RELEASE_STORE_KIND}" is implemented`));
  }

  const { releaseRoot, sourceCommit, sourceRepo, runtimePath, referenceDeps } = candidate;
  if (!isText(releaseRoot) || !isAbsolute(releaseRoot)) {
    return refused(kind, blocker("release-root-invalid", "releaseRoot must be an absolute path to one release directory"));
  }
  if (!isText(sourceCommit) || !FULL_COMMIT.test(sourceCommit)) {
    return refused(kind, blocker("source-commit-invalid", "sourceCommit must be the full 40-character commit the release is expected to hold"));
  }
  if (!isText(sourceRepo) || !isAbsolute(sourceRepo)) {
    return refused(kind, blocker("source-repo-invalid", "sourceRepo must be an absolute path to the repository that holds the expected commit"));
  }
  if (!isText(runtimePath) || !isAbsolute(runtimePath)) {
    return refused(kind, blocker("runtime-path-invalid", "runtimePath must be an absolute path to the runtime binary the release ships with"));
  }
  if (referenceDeps !== undefined && referenceDeps !== null && (!isText(referenceDeps) || !isAbsolute(referenceDeps))) {
    return refused(kind, blocker("reference-deps-invalid", "referenceDeps, when given, must be an absolute path to a trusted dependency reference tree"));
  }

  // Before anything is read, hashed, handed to git or started: none of the
  // four named paths may name or lead into a credential or login directory.
  for (const [label, named] of [["releaseRoot", releaseRoot], ["sourceRepo", sourceRepo], ["runtimePath", runtimePath], ["referenceDeps", referenceDeps]]) {
    if (!isText(named)) continue;
    const protectedPath = protectedPathBlocker(label, named);
    if (protectedPath) return refused(kind, protectedPath);
  }

  const selected = resolve(releaseRoot);
  const seen = lstatOrNull(selected);
  if (seen.error) {
    return refused(kind, blocker(seen.error.code === "ENOENT" ? "artifact-missing" : "artifact-unreadable", `${selected}: ${describe(seen.error)}`));
  }
  // A symlink is not a stable identity for a tree whose contents are being
  // compared (the release store's own rule): the caller resolves the pointer
  // and names the physical release.
  if (seen.stat.isSymbolicLink()) {
    return refused(kind, blocker("release-root-symlink", `${selected} is a symbolic link; name the physical release directory`));
  }
  if (!seen.stat.isDirectory()) return refused(kind, blocker("artifact-not-directory", `${selected} is not a directory`));
  let physicalRoot;
  try {
    physicalRoot = realpathSync(selected);
  } catch (error) {
    return refused(kind, blocker("artifact-unreadable", `${selected}: ${describe(error)}`));
  }
  if (basename(physicalRoot) !== sourceCommit) {
    return refused(kind, blocker("commit-mismatch", `the release directory is named ${basename(physicalRoot)}, not the expected commit ${sourceCommit}`));
  }

  const manifestSeen = lstatOrNull(join(physicalRoot, MANIFEST));
  if (manifestSeen.error || !manifestSeen.stat.isFile()) {
    return refused(kind, blocker("release-manifest-invalid", `${physicalRoot} has no regular ${MANIFEST}`));
  }
  if (!await isReleaseDirectory(physicalRoot)) {
    return refused(kind, blocker("release-manifest-invalid", `${physicalRoot} does not carry a manifest the release store accepts`));
  }
  // The manifest is read through a handle opened without following a link and
  // checked to be the very file that was just listed, so bytes other than the
  // regular release file cannot be validated in its place.
  const manifestText = readListedRegularFile(join(physicalRoot, MANIFEST), manifestSeen.stat);
  let manifest = null;
  if (manifestText.text !== undefined) {
    try {
      manifest = validateReleaseManifest(JSON.parse(manifestText.text));
    } catch {
      manifest = null;
    }
  }
  if (manifest === null) {
    return refused(kind, blocker("release-manifest-invalid", manifestText.problem ?? `${physicalRoot} does not carry a manifest the release store accepts`));
  }
  if (manifest.commit !== sourceCommit) {
    return refused(kind, blocker("commit-mismatch", `the release manifest names ${manifest.commit}, not the expected commit ${sourceCommit}`));
  }

  // The repository and the reference tree are the external half of the
  // binding, so the binding names the physical ones that vouched: a receipt
  // must show WHICH repository answered for the commit.
  const repository = physicalPath(sourceRepo);
  const reference = isText(referenceDeps) ? physicalPath(referenceDeps) : null;

  const blockers = [];
  let verdict;
  try {
    verdict = withEnvironment(GIT_OBJECTS_AS_HASHED, () => verifyReleaseAgainstCommit({
      releaseRoot: physicalRoot, commit: sourceCommit, repo: repository, referenceDeps: reference,
    }));
  } catch (error) {
    verdict = { ok: false, reason: "provenance-unverifiable", detail: describe(error) };
  }
  if (!verdict.ok) return refused(kind, provenanceBlocker(verdict));
  if (verdict.dependencies !== "verified" && verdict.dependencies !== "absent") {
    blockers.push(blocker("dependencies-unverified", "the release carries node_modules and no trusted reference tree was named, so its executable dependency bytes are unknown"));
  }

  let buildIdentity = null;
  try {
    buildIdentity = readBoundIdentity(physicalRoot, repository, reference);
  } catch (error) {
    blockers.push(blocker("identity-invalid", describe(error)));
  }
  if (buildIdentity !== null) {
    if (!validBuildIdentity(buildIdentity)) blockers.push(blocker("identity-invalid", "the release does not report a valid BotFleet build identity"));
    else if (buildIdentity.sourceCommit !== sourceCommit) blockers.push(blocker("identity-mismatch", `the release identifies as ${buildIdentity.sourceCommit}, not the expected commit ${sourceCommit}`));
    else if (buildIdentity.sourceDirty !== false) blockers.push(blocker("identity-dirty", "the release build identity is dirty: its bytes are not proven to be the expected commit with verified dependencies"));
  }

  // The whole physical tree, manifest and dependencies included, hashed with
  // the provenance module's own walker: regular file bytes, executable bits
  // and symlink TARGET TEXT in sorted order, with every link confined to the
  // release root.  No link is followed out of the tree.
  let artifact = null;
  try {
    const tree = hashDependencyTree(physicalRoot);
    if (tree.linkProblems.length) blockers.push(blocker("artifact-link-escape", tree.linkProblems.slice(0, 5).join("; ")));
    else artifact = { algorithm: "sha256", fingerprint: tree.fingerprint, files: tree.files };
  } catch (error) {
    blockers.push(blocker("artifact-unreadable", describe(error)));
  }

  const runtime = fingerprintRuntime(resolve(runtimePath));
  if (runtime.blocker) blockers.push(runtime.blocker);

  if (blockers.length) return refused(kind, ...blockers);
  const binding = {
    kind,
    releaseRoot: physicalRoot,
    sourceCommit,
    source: { repository, referenceDeps: reference },
    manifest: { ...manifest },
    buildIdentity,
    provenance: { checked: verdict.checked, dependencies: verdict.dependencies, depsFingerprint: verdict.depsFingerprint },
    artifact,
    runtime: runtime.runtime,
  };
  let physical;
  try {
    const now = lstatSync(physicalRoot);
    physical = { dev: String(now.dev), ino: String(now.ino) };
  } catch (error) {
    return refused(kind, blocker("artifact-unreadable", `${physicalRoot}: ${describe(error)}`));
  }
  return { kind, blockers: [], binding, bindingDigest: sha256(canonicalJson(binding)), physical };
}

/**
 * Statically inspect one explicitly selected candidate.
 *
 * `candidate` names `kind` ("release-store"), `releaseRoot` (the physical
 * release directory), `sourceCommit` (the commit it is expected to hold),
 * `sourceRepo` (the repository whose tree objects are the external binding),
 * `runtimePath` (the physical runtime binary) and, when the release carries
 * node_modules, `referenceDeps` (a trusted reference tree).
 *
 * The answer is "blocked" or "probe-required" and nothing else: static
 * inspection executes nothing, so it cannot know whether the pair is
 * compatible.  `activationAllowed` is always false.
 */
export async function inspectPlacementRollbackCandidate(candidate, { platform } = {}) {
  const bound = await bindCandidate(candidate, { platform });
  const blocked = bound.blockers.length > 0;
  return deepFreeze({
    status: blocked ? "blocked" : "probe-required",
    activationAllowed: false,
    kind: bound.kind,
    blockers: bound.blockers,
    binding: blocked ? null : bound.binding,
    bindingDigest: blocked ? null : bound.bindingDigest,
  });
}

// ---------------------------------------------------------------------------
// Fixture probe
// ---------------------------------------------------------------------------

/** Unwinds the recipe to teardown; carries the blocker that stopped it. */
class ProbeBlocked extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ProbeBlocked";
    this.blocker = blocker(code, detail);
  }
}

function bindOnce(port) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(null));
    probe.listen(port, "127.0.0.1", () => {
      const bound = probe.address()?.port ?? null;
      probe.close(() => resolvePort(bound));
    });
  });
}

/**
 * A loopback port whose successor is free too: the harness opens its webhook
 * receiver one above itself.  A probe, not a reservation, exactly as
 * server/testing/ports.ts describes.
 */
async function freeLoopbackPortPair() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = await bindOnce(0);
    if (port !== null && port < 65_535 && await bindOnce(port + 1) !== null) return port;
  }
  throw new ProbeBlocked("loopback-ports-unavailable", "no free loopback port pair was found");
}

/** True when something accepts a connection there.  A timeout counts as open. */
function portOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (open) => { socket.destroy(); resolveOpen(open); };
    socket.setTimeout(500, () => settle(true));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function httpRequest(base, path, { method = "GET", headers = {}, body, timeoutMs }) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, init);
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    /* the group is already gone */
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means a member exists that this user cannot signal: still alive.
    return error?.code === "EPERM";
  }
}

// Candidate process groups that are running right now.  The recipe's own
// `finally` ends a candidate on every ordinary path, but it never runs when
// this process is interrupted or exits mid-probe, and the candidate sits in
// its own process group precisely so a terminal's Ctrl-C does not reach it.
// The guard below is the exit sweep of server/testing/cleanup.ts, plus the
// signals a cancelled run actually receives.  BOTFLEET_TEST_PARENT_PID is not
// enough for this: only a candidate that carries the parent watchdog acts on
// it, and a retained artifact older than that watchdog does not.
const liveCandidateGroups = new Set();
const INTERRUPTING_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const interruptHandlers = new Map();
let exitSweepInstalled = false;

function killLiveCandidateGroups() {
  for (const pid of liveCandidateGroups) signalGroup(pid, "SIGKILL");
}

function releaseInterruptHandlers() {
  for (const [signal, handler] of interruptHandlers) process.removeListener(signal, handler);
  interruptHandlers.clear();
}

function trackCandidateGroup(pid) {
  if (!exitSweepInstalled) {
    exitSweepInstalled = true;
    process.on("exit", killLiveCandidateGroups);
  }
  if (liveCandidateGroups.size === 0) {
    // Installed only while a candidate is alive, so importing this module
    // never changes how its host process answers a signal.
    for (const signal of INTERRUPTING_SIGNALS) {
      const handler = () => {
        killLiveCandidateGroups();
        releaseInterruptHandlers();
        // Hand the signal back.  A host with its own listener has already
        // been called for this delivery; with none left the default action
        // has to be asked for again, or the interrupt would be swallowed.
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      };
      interruptHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  liveCandidateGroups.add(pid);
}

function untrackCandidateGroup(pid) {
  liveCandidateGroups.delete(pid);
  if (liveCandidateGroups.size === 0) releaseInterruptHandlers();
}

function childEnvironment({ home, port }) {
  const env = {
    HOME: home,
    USERPROFILE: home,
    TZ: "America/Chicago",
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
    ...CONTAINER_LOCKDOWN_ENV,
    // server/test-parent-watchdog.ts: the child ends itself if this process
    // disappears before it can send a signal.
    BOTFLEET_TEST_CHILD: "1",
    BOTFLEET_TEST_PARENT_PID: String(process.pid),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  return env;
}

/**
 * Start the candidate as the leader of its own process group, with its output
 * in files rather than pipes: a descendant that outlives the leader cannot
 * hold this process open, and the logs survive the child.
 */
function launchCandidate({ binding, home, port, tempRoot, stage }) {
  const stdoutPath = join(tempRoot, `${stage}.stdout.log`);
  const stderrPath = join(tempRoot, `${stage}.stderr.log`);
  const out = openSync(stdoutPath, "w", 0o600);
  const err = openSync(stderrPath, "w", 0o600);
  const run = { stage, child: null, done: false, exited: null, stdoutPath, stderrPath };
  try {
    run.child = spawn(binding.runtime.path, [...RELEASE_STORE_LAUNCH_ARGUMENTS], {
      cwd: binding.releaseRoot,
      detached: true,
      env: childEnvironment({ home, port }),
      stdio: ["ignore", out, err],
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  if (run.child.pid) trackCandidateGroup(run.child.pid);
  run.exited = new Promise((resolveExit) => {
    const finish = () => { run.done = true; resolveExit(); };
    run.child.once("exit", finish);
    run.child.once("error", finish);
  });
  return run;
}

async function waitReady(run, base, timeouts) {
  const deadline = Date.now() + timeouts.bootMs;
  for (;;) {
    if (run.done) return "exited";
    if (Date.now() >= deadline) return "timeout";
    let answer = null;
    try {
      answer = await httpRequest(base, "/api/health", { timeoutMs: Math.min(timeouts.requestMs, 1_000) });
    } catch {
      answer = null;
    }
    if (answer !== null) {
      // Any answer proves somebody owns the port.  Only this child's own
      // identity counts; anything else is a foreign owner, never a pass.
      if (answer.status !== 200 || answer.json?.app !== "botfleet" || answer.json.pid !== run.child.pid) return "foreign-owner";
      if (answer.json.ready !== false && answer.json.booting !== true) return "ready";
    }
    await sleep(100);
  }
}

/**
 * End the candidate's whole process group and prove it is gone: the bounded
 * teardown of server/testing/cleanup.ts (polite signal, grace, SIGKILL, keep
 * waiting), plus the two checks that make "gone" a fact rather than a hope —
 * no member of the group remains, and neither loopback port still answers.
 * A descendant that left the group and kept a port is an incomplete teardown.
 */
async function stopCandidate(run, port, timeouts) {
  const pid = run.child?.pid;
  if (pid) {
    signalGroup(pid, "SIGTERM");
    await Promise.race([run.exited, sleep(timeouts.stopGraceMs)]);
    if (!run.done || groupAlive(pid)) {
      signalGroup(pid, "SIGKILL");
      await Promise.race([run.exited, sleep(2_000)]);
    }
    for (let waited = 0; waited < 2_000 && groupAlive(pid); waited += 50) await sleep(50);
  } else {
    await Promise.race([run.exited, sleep(1_000)]);
  }
  let portsClosed = false;
  for (let waited = 0; waited <= 2_000; waited += 100) {
    if (!await portOpen(port) && !await portOpen(port + 1)) {
      portsClosed = true;
      break;
    }
    await sleep(100);
  }
  // The bounded teardown has done everything it can, SIGKILL included, so the
  // interrupt guard has nothing further to add for this group.
  if (pid) untrackCandidateGroup(pid);
  return { exited: run.done, groupGone: !pid || !groupAlive(pid), portsClosed };
}

function logTail(path) {
  try {
    const bytes = readFileSync(path);
    const tail = bytes.subarray(Math.max(0, bytes.length - LOG_TAIL_BYTES)).toString("utf8");
    // The owner nonce is a 64-hex secret of the throwaway home.  Nothing
    // should print it, and a receipt must not carry it if something did.
    return tail.replaceAll(/[a-f0-9]{64}/g, "[redacted-64-hex]");
  } catch {
    return "";
  }
}

function fixtureWriterScript() {
  const store = pathToFileURL(join(TOOL_ROOT, "server", "placement-store.ts")).href;
  return `
import { commandDigest, openPlacementStore, placementFingerprint } from ${JSON.stringify(store)};
const fixture = ${JSON.stringify(FIXTURE)};
const dataDir = process.argv[1];
const action = process.argv[2];
const store = openPlacementStore(dataDir, fixture.hostId);
try {
  if (action === "prepare") {
    store.transaction((state) => {
      state.controller = { controllerId: fixture.nextId, epoch: fixture.normalizedEpoch };
      state.reconcile = true;
      for (const [jobId, status] of [["held", "worker-unreachable"], ["settled", "completed"], ["released", "queued"]]) {
        const metadata = { jobId, botId: "fixture-bot", threadId: "fixture-thread", cwd: dataDir, timeoutMs: 1000, payloadDigest: commandDigest("no executable payload exists") };
        const job = { ...metadata, fingerprint: placementFingerprint(metadata), status, queuedAt: 1 };
        if (status === "queued") {
          state.jobs.push(job);
          state.leases.push({ controllerId: fixture.hostId, epoch: fixture.oldLeaseEpoch, host: fixture.hostId, jobId, leaseId: "released-lease", state: "released", revocationId: "fixture-verified-never-started" });
        } else {
          const leaseId = jobId + "-lease";
          const leased = { ...job, host: fixture.hostId, leaseId, ranAfterTakeover: true };
          state.jobs.push(status === "completed" ? { ...leased, report: { status, exitCode: 0, signal: null, endedAt: 2 } } : leased);
          state.leases.push({ controllerId: fixture.hostId, epoch: fixture.oldLeaseEpoch, host: fixture.hostId, jobId, leaseId, state: status === "completed" ? "settled" : "active" });
          if (status === "worker-unreachable") state.pendingStops.push({ hostId: fixture.hostId, leaseId });
        }
      }
    });
  } else if (action === "advance") {
    store.transactionScope({ active: true }, (state) => {
      state.controller = { controllerId: fixture.hostId, epoch: fixture.advancedEpoch };
    });
  } else {
    throw new Error("unknown fixture action");
  }
  process.stdout.write(JSON.stringify({ controller: store.readAll().controller }));
} finally {
  store.close();
}
`;
}

/**
 * Run the reviewed migration helper (server/placement-store.ts) in a child of
 * this process's own Node.  The fixture writer is this tool's reviewed source,
 * not the candidate: the candidate is the READER under test, and it never
 * prepares or advances the ledger it is judged against.
 */
async function writeFixture(dataDir, home, action, timeouts) {
  const env = { HOME: home, USERPROFILE: home };
  if (process.env.PATH) env.PATH = process.env.PATH;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [
      "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", fixtureWriterScript(), dataDir, action,
    ], { cwd: TOOL_ROOT, env, timeout: timeouts.writerMs, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    throw new ProbeBlocked("fixture-writer-failed", `the normalized fixture could not be ${action === "prepare" ? "prepared" : "advanced"} by this tool's migration helper: ${String(error?.stderr || describe(error)).trim().split("\n").slice(-3).join(" | ")}`);
  }
  try {
    return JSON.parse(stdout).controller;
  } catch {
    throw new ProbeBlocked("fixture-writer-failed", `the fixture writer returned no controller for ${action}`);
  }
}

function fileDigest(path) {
  // An absent WAL and an empty one both hold no committed frame, and a
  // read-only reader may create the empty file, so both hash as empty.
  try {
    return sha256(readFileSync(path));
  } catch (error) {
    if (error?.code === "ENOENT") return sha256(Buffer.alloc(0));
    throw error;
  }
}

/**
 * The ledger as this process sees it through its own read-only connection:
 * a canonical digest of the schema and every row of every table, the header
 * the candidate must report, and the bytes of the authoritative files.  The
 * `-shm` sidecar is SQLite's shared-memory coordination file and is not
 * authoritative, so it is not compared.
 */
async function snapshotLedger(dataDir) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(dataDir, "placement.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    try {
      const userVersion = db.prepare("PRAGMA user_version").get()?.user_version;
      const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
      const tables = {};
      for (const entry of schema) {
        if (entry.type !== "table") continue;
        const name = String(entry.name);
        tables[name] = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map((row) => canonicalJson({ ...row })).sort();
      }
      const meta = JSON.parse(String(db.prepare("SELECT json FROM placement_meta WHERE id = 1").get()?.json));
      const header = JSON.parse(String(db.prepare("SELECT json FROM placement_state WHERE id = 1").get()?.json));
      const tombstones = db.prepare("SELECT state, count(*) AS total FROM placement_lease_tombstones GROUP BY state").all();
      const count = (state) => Number(tombstones.find((row) => row.state === state)?.total ?? 0);
      return {
        digest: sha256(canonicalJson({ userVersion, schema: schema.map((row) => ({ ...row })), tables })),
        schema: meta?.storage ?? null,
        phase: meta?.phase ?? null,
        controller: { controllerId: header?.controller?.controllerId ?? null, epoch: header?.controller?.epoch ?? null },
        reconcile: header?.reconcile === true,
        released: count("released"),
        settled: count("settled"),
        pendingStops: Number(db.prepare("SELECT count(*) AS total FROM placement_pending_stops").get()?.total ?? 0),
        files: {
          database: fileDigest(path),
          wal: fileDigest(`${path}-wal`),
          marker: fileDigest(join(dataDir, "placement-controller.json")),
        },
      };
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

async function ledgerOrBlock(dataDir) {
  try {
    return await snapshotLedger(dataDir);
  } catch (error) {
    throw new ProbeBlocked("ledger-unreadable", `the fixture ledger could not be read back: ${describe(error)}`);
  }
}

function requireUnchangedLedger(before, after, when) {
  if (after.digest !== before.digest) {
    throw new ProbeBlocked("ledger-digest-changed", `the canonical logical ledger digest changed ${when}`);
  }
  const changed = Object.keys(before.files).filter((name) => after.files[name] !== before.files[name]);
  if (changed.length) throw new ProbeBlocked("ledger-bytes-changed", `authoritative ${changed.join(", ")} bytes changed ${when}`);
}

function sameController(actual, expected) {
  return actual?.controllerId === expected.controllerId && actual?.epoch === expected.epoch;
}

function readStrictLegacyPair(dataDir) {
  const value = JSON.parse(readFileSync(join(dataDir, "placement-controller.json"), "utf8"));
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "controllerId,epoch" ||
      !isText(value.controllerId) || !HOST_ID_PATTERN.test(value.controllerId) ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw new Error("not a strict legacy controller epoch pair");
  }
  return value;
}

function validateReceiptDirectory(receiptDir, releaseRoot) {
  if (!isText(receiptDir) || !isAbsolute(receiptDir)) return blocker("receipt-directory-invalid", "receiptDir must be an absolute path to an existing directory outside the release");
  const seen = lstatOrNull(receiptDir);
  if (seen.error || seen.stat.isSymbolicLink() || !seen.stat.isDirectory()) {
    return blocker("receipt-directory-invalid", `${receiptDir} is not an existing physical directory`);
  }
  if (isText(releaseRoot)) {
    let receiptReal;
    let releaseReal;
    try {
      receiptReal = realpathSync(receiptDir);
      releaseReal = realpathSync(releaseRoot);
    } catch {
      return null; // the release itself is judged by the binding
    }
    if (receiptReal === releaseReal || receiptReal.startsWith(`${releaseReal}${sep}`)) {
      return blocker("receipt-directory-invalid", "the proof receipt is kept apart from the release: receiptDir is inside the release directory");
    }
  }
  return null;
}

function writeReceipt(receiptDir, receipt) {
  const commit = receipt.candidate?.sourceCommit?.slice(0, 12) ?? "unbound";
  const stamp = receipt.finishedAt.replaceAll(/[^0-9TZ]/g, "");
  const path = join(receiptDir, `placement-rollback-probe-${commit}-${stamp}-${randomBytes(4).toString("hex")}.json`);
  // Exclusive create: a receipt never overwrites another receipt.
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

/** The exact request the source recipe's ten-POST refusal loop sends. */
function placementBody(fence) {
  return {
    version: "1", controllerId: fence.controllerId, epoch: fence.epoch, hostId: FIXTURE.hostId,
    leases: ["held-lease"], admission: { admit: true },
    sample: {
      at: 1, cores: null, loadPerCore: null, ramTotalBytes: null, ramAvailableBytes: null,
      memoryPressure: null, memoryAvailablePercent: null, swapTotalBytes: null, swapUsedBytes: null,
      diskTotalBytes: null, diskFreeBytes: null, inodesTotal: null, inodesFree: null,
      dataVolume: null, rootDiskFreeBytes: null,
    },
  };
}

/**
 * Every placement POST must refuse without allocation or acknowledgement.
 * Beyond the generic loop this names the cases the plan calls out: terminal
 * report replay, released-lease dispatch, a stale fence, registration and
 * heartbeat.  The command string is deliberately not an executable.
 */
async function requirePlacementRefusals(base, fence, dataDir, timeouts, label) {
  const generic = placementBody(fence);
  const stale = { ...generic, controllerId: FIXTURE.hostId, epoch: FIXTURE.oldLeaseEpoch };
  const cases = PLACEMENT_POST_ACTIONS.map((action) => ({ name: action, action, body: generic }));
  cases.push(
    { name: "stale-claim", action: "claim", body: { ...stale, jobId: "released" } },
    { name: "stale-enqueue", action: "enqueue", body: { ...stale, jobId: "probe-new", botId: "fixture-bot", threadId: "fixture-thread", command: "placement-rollback-probe-no-payload", cwd: dataDir, timeoutMs: 1000 } },
    { name: "released-lease-dispatch", action: "dispatch", body: { ...generic, lease: { controllerId: FIXTURE.hostId, epoch: FIXTURE.oldLeaseEpoch, leaseId: "released-lease", jobId: "released", host: FIXTURE.hostId }, command: "placement-rollback-probe-no-payload", cwd: dataDir, timeoutMs: 1000 } },
    { name: "terminal-report-replay", action: "report", body: { ...generic, jobId: "settled", leaseId: "settled-lease", status: "completed", exitCode: 0, signal: null, endedAt: 2 } },
  );
  for (const entry of cases) {
    let answer;
    try {
      answer = await httpRequest(base, `/api/placement/${entry.action}`, { method: "POST", body: entry.body, timeoutMs: timeouts.requestMs });
    } catch (error) {
      throw new ProbeBlocked("placement-post-unanswered", `${label} ${entry.name}: ${describe(error)}`);
    }
    if (answer.status !== 503 || answer.json?.accepted === true) {
      throw new ProbeBlocked("placement-post-not-refused", `${label} ${entry.name} answered ${answer.status}${answer.json?.accepted === true ? " and acknowledged the request" : ""}; a rollback build must refuse it with 503`);
    }
  }
  return cases.length;
}

/**
 * A value the candidate answered with, shown in a blocker.  The candidate is
 * the party under judgement, so neither the size nor the shape of what it
 * sends is trusted: a scalar is shown, a long string is cut, and anything
 * structured is named rather than copied into the receipt.
 */
function echoed(value) {
  if (value === null || value === undefined) return "null";
  if (value === String(value)) return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
  if (Number.isFinite(value) || value === true || value === false) return String(value);
  return "[non-scalar]";
}

async function requireIdentity(base, expected, timeouts, code) {
  let answer;
  try {
    answer = await httpRequest(base, "/api/placement/identity", { timeoutMs: timeouts.requestMs });
  } catch (error) {
    throw new ProbeBlocked(code, `placement identity did not answer: ${describe(error)}`);
  }
  if (answer.status !== 200 || !sameController(answer.json, expected)) {
    throw new ProbeBlocked(code, `placement identity answered ${answer.status} with controllerId ${echoed(answer.json?.controllerId)} at epoch ${echoed(answer.json?.epoch)}; the stored fence is ${JSON.stringify(expected)}`);
  }
}

/**
 * Exercise one selected candidate/runtime pair against generated fixtures.
 *
 * `options.receiptDir` (required) is an existing directory outside the
 * release; the receipt is written there and nowhere else.  `options.onPhase`
 * is an observer called at named points of the recipe; its return value is
 * ignored and a throw blocks the run.  `options.timeouts` may lengthen the
 * recipe's waits and shorten its deadlines (see `recipeTimeouts`); the waits
 * that applied and any override that was refused are recorded in the receipt.
 *
 * Returns "blocked" or "fixture-verified", always with
 * `activationAllowed: false`.  The binding is recomputed here before anything
 * runs and again after the child is gone; a result is never taken from the
 * caller.
 */
export async function runPlacementRollbackFixtureProbe(candidate, options = {}) {
  const { receiptDir, onPhase, platform } = isRecord(options) ? options : {};
  const { timeouts, ignored: ignoredTimeoutOverrides } = recipeTimeouts(isRecord(options) ? options.timeouts : undefined);
  const startedAt = new Date().toISOString();
  const blockers = [];
  const outcomes = [];
  const logs = {};
  const ledger = {};
  let retainedTempRoot = null;
  let recheck = null;
  const record = (step, detail) => { outcomes.push({ step, ok: true, detail }); };
  const observe = async (phase, context) => {
    if (onPhase === undefined) return;
    try {
      await onPhase({ phase, ...context });
    } catch (error) {
      throw new ProbeBlocked("observer-failed", `the ${phase} observer threw: ${describe(error)}`);
    }
  };

  const receiptProblem = validateReceiptDirectory(receiptDir, isRecord(candidate) ? candidate.releaseRoot : undefined);
  const bound = await bindCandidate(candidate, { platform });
  blockers.push(...bound.blockers);
  if (receiptProblem) blockers.push(receiptProblem);
  if (blockers.length === 0 && process.platform !== "darwin" && process.platform !== "linux") {
    blockers.push(blocker("fixture-platform-unsupported", `normalized placement storage is supported on darwin and linux only; this host is ${process.platform}`));
  }

  if (blockers.length === 0) {
    const { binding } = bound;
    let tempRoot = null;
    let run = null;
    let port = null;
    let teardownComplete = true;
    const stop = async (stage) => {
      if (run === null) return;
      const current = run;
      run = null;
      const stopped = await stopCandidate(current, port, timeouts);
      logs[current.stage] = { stdout: logTail(current.stdoutPath), stderr: logTail(current.stderrPath) };
      if (!stopped.exited || !stopped.groupGone || !stopped.portsClosed) {
        teardownComplete = false;
        throw new ProbeBlocked("child-cleanup-incomplete", `${stage}: after the bounded process-group teardown the child ${stopped.exited ? "exited" : "did not exit"}, its group is ${stopped.groupGone ? "gone" : "still present"} and its loopback ports are ${stopped.portsClosed ? "closed" : "still answering"}`);
      }
      record(`${current.stage}-teardown`, "process group gone and both loopback ports closed");
    };
    const boot = async (stage, failure) => {
      run = launchCandidate({ binding, home: join(tempRoot, "home"), port, tempRoot, stage });
      const state = await waitReady(run, `http://127.0.0.1:${port}`, timeouts);
      if (state !== "ready") {
        throw new ProbeBlocked(failure, `the candidate did not become ready with the selected runtime (${state})`);
      }
      return run.child.pid;
    };
    try {
      tempRoot = mkdtempSync(join(tmpdir(), "bf-rollback-probe-"));
      chmodSync(tempRoot, 0o700);
      const home = join(tempRoot, "home");
      const dataDir = join(home, ".botfleet");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
      chmodSync(dataDir, 0o700);
      // One unknown provider driver: nothing in this home can reach a provider.
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }), { mode: 0o600 });
      const legacyPair = { controllerId: FIXTURE.hostId, epoch: FIXTURE.legacyEpoch };
      const markerPath = join(dataDir, "placement-controller.json");
      writeFileSync(markerPath, `${JSON.stringify(legacyPair)}\n`, { mode: 0o600 });
      chmodSync(markerPath, 0o600);
      port = await freeLoopbackPortPair();
      const base = `http://127.0.0.1:${port}`;

      // 1. Strict legacy epoch fixture: the pair stays rollback-readable and
      //    no SQLite authority or payload namespace appears.
      await boot("legacy", "legacy-boot-failed");
      await observe("legacy-booted", { dataDir, port, pid: run.child.pid });
      await requireIdentity(base, legacyPair, timeouts, "legacy-identity-mismatch");
      let stored;
      try {
        stored = readStrictLegacyPair(dataDir);
      } catch (error) {
        throw new ProbeBlocked("legacy-pair-not-readable", `the legacy controller file is no longer a strict epoch pair: ${describe(error)}`);
      }
      if (!sameController(stored, legacyPair)) throw new ProbeBlocked("legacy-pair-not-readable", "the legacy controller file no longer holds the seeded fence");
      for (const name of ["placement.sqlite", "placement-payloads"]) {
        if (existsSync(join(dataDir, name))) throw new ProbeBlocked("legacy-authority-created", `${name} appeared under a legacy epoch fixture`);
      }
      record("legacy-readable", "identity reported the seeded legacy fence; no SQLite authority or payload namespace was created");
      await stop("legacy stage");

      // 2. Normalized fixture, prepared by the reviewed migration helper
      //    after the legacy child is completely gone.
      const prepared = await writeFixture(dataDir, home, "prepare", timeouts);
      const normalizedPair = { controllerId: FIXTURE.nextId, epoch: FIXTURE.normalizedEpoch };
      const before = await ledgerOrBlock(dataDir);
      if (!sameController(prepared, normalizedPair) || !sameController(before.controller, normalizedPair) ||
          before.schema !== PLACEMENT_ROLLBACK_SCHEMA || before.phase !== "active" || !before.reconcile ||
          before.released < 1 || before.settled < 1 || before.pendingStops < 1) {
        throw new ProbeBlocked("fixture-preparation-incomplete", "the prepared ledger does not hold the fence, reconciliation state, settled report, pending stop and released-lease tombstone the recipe requires");
      }
      ledger.prepared = before;
      const saved = {
        "pending-update-resume.json": JSON.stringify({ interruptedRuns: [{ id: "preserve-me" }], interruptedBots: [] }),
        "interrupted-turns.json": JSON.stringify({ version: 1, recordedAt: 1, turns: [{ botId: "held-bot", threadId: "held-thread", at: 1, reason: "shutdown" }], failures: [] }),
      };
      for (const [name, text] of Object.entries(saved)) writeFileSync(join(dataDir, name), text, { mode: 0o600 });
      const requireSavedEvidence = (when) => {
        for (const [name, text] of Object.entries(saved)) {
          let now = null;
          try {
            now = readFileSync(join(dataDir, name), "utf8");
          } catch {
            now = null;
          }
          if (now !== text) throw new ProbeBlocked("saved-evidence-changed", `${name} was consumed or rewritten ${when}`);
        }
        if (existsSync(join(dataDir, "placement-payloads"))) throw new ProbeBlocked("payload-namespace-created", `a payload spool appeared ${when}`);
      };
      record("normalized-prepared", `schema ${before.schema}; fence ${normalizedPair.controllerId} at epoch ${normalizedPair.epoch}`);
      await observe("normalized-prepared", { dataDir, port });

      // 3. The candidate reads the stored fence and refuses every placement POST.
      const pid = await boot("normalized", "normalized-boot-failed");
      await observe("normalized-booted", { dataDir, port, pid });
      await requireIdentity(base, normalizedPair, timeouts, "normalized-identity-mismatch");
      record("normalized-identity", "identity reported the stored fence");
      let companion;
      try {
        companion = await httpRequest(base, "/api/placement/heartbeat", { method: "POST", headers: { "x-botfleet-companion": "1" }, body: {}, timeoutMs: timeouts.requestMs });
      } catch (error) {
        throw new ProbeBlocked("companion-not-refused", describe(error));
      }
      if (companion.status !== 403) throw new ProbeBlocked("companion-not-refused", `a companion placement request answered ${companion.status}, not 403`);
      const refused = await requirePlacementRefusals(base, normalizedPair, dataDir, timeouts, "at the stored fence");
      record("placement-posts-refused", `${refused} placement POSTs refused with 503 at the stored fence`);

      // 4. The hold cannot be released, and nothing mutating is admitted.
      let nonce = null;
      try {
        nonce = JSON.parse(readFileSync(join(dataDir, "harness-owner.json"), "utf8"))?.nonce;
      } catch {
        nonce = null;
      }
      if (!isText(nonce) || !OWNER_NONCE.test(nonce)) throw new ProbeBlocked("owner-record-missing", "the candidate wrote no owner record to authenticate the lifecycle routes with");
      const authorization = { authorization: `Bearer ${nonce}` };
      for (const method of ["POST", "DELETE"]) {
        let answer;
        try {
          answer = await httpRequest(base, "/api/runtime/quiesce?force=1", { method, headers: authorization, timeoutMs: timeouts.requestMs });
        } catch (error) {
          throw new ProbeBlocked("hold-released", `${method} quiesce: ${describe(error)}`);
        }
        if (answer.status !== 200 || answer.json?.placementReadOnly !== true || answer.json?.quiescing !== true) {
          throw new ProbeBlocked("hold-released", `${method} /api/runtime/quiesce answered ${answer.status} without the read-only hold`);
        }
      }
      for (const [name, path, headers] of [["application mutation", "/api/bots", {}], ["updater run", "/api/update/run", authorization]]) {
        let answer;
        try {
          answer = await httpRequest(base, path, { method: "POST", headers, body: {}, timeoutMs: timeouts.requestMs });
        } catch (error) {
          throw new ProbeBlocked("mutation-not-refused", `${name}: ${describe(error)}`);
        }
        if (answer.status !== 503) throw new ProbeBlocked("mutation-not-refused", `${name} answered ${answer.status}, not 503`);
      }
      record("hold-kept", "quiesce POST and DELETE kept the read-only hold; application mutation and updater run refused");

      // 5. Passive: after the recovery delay the saved evidence, the logical
      //    ledger and the authoritative bytes are exactly what they were.
      await sleep(timeouts.settleMs);
      requireSavedEvidence("while the candidate ran against the stored fence");
      requireUnchangedLedger(before, await ledgerOrBlock(dataDir), "while the candidate ran against the stored fence");
      record("ledger-unchanged", "logical digest and database, WAL and marker bytes unchanged");

      // 6. The fixture writer deliberately commits a newer fence; the SAME
      //    child converges on it without a restart.
      const advancedPair = { controllerId: FIXTURE.hostId, epoch: FIXTURE.advancedEpoch };
      const advancedBy = await writeFixture(dataDir, home, "advance", timeouts);
      const advanced = await ledgerOrBlock(dataDir);
      if (!sameController(advancedBy, advancedPair) || !sameController(advanced.controller, advancedPair) || advanced.digest === before.digest) {
        throw new ProbeBlocked("fixture-preparation-incomplete", "the fixture writer did not commit the newer fence");
      }
      ledger.advanced = advanced;
      const convergeBy = Date.now() + timeouts.convergeMs;
      for (;;) {
        try {
          await requireIdentity(base, advancedPair, timeouts, "identity-not-converged");
          break;
        } catch (error) {
          if (Date.now() >= convergeBy || run.done) throw error;
          await sleep(100);
        }
      }
      if (run.done || run.child.pid !== pid) throw new ProbeBlocked("identity-not-converged", "the candidate did not stay up across the newer fence");
      record("identity-converged", `identity converged on epoch ${advancedPair.epoch} without a restart`);
      const staleRefused = await requirePlacementRefusals(base, normalizedPair, dataDir, timeouts, "at the now-stale fence");
      record("stale-requests-refused", `${staleRefused} placement POSTs refused with 503 at the now-stale fence`);
      requireSavedEvidence("after the newer fence");
      requireUnchangedLedger(advanced, await ledgerOrBlock(dataDir), "after the fixture writer's own commit");

      // 7. Stop the child completely, then look once more.
      await observe("before-teardown", { dataDir, port, pid });
      await stop("normalized stage");
      requireSavedEvidence("after teardown");
      requireUnchangedLedger(advanced, await ledgerOrBlock(dataDir), "across teardown");
      record("ledger-unchanged-after-teardown", "logical digest and database, WAL and marker bytes unchanged across teardown");

      // 8. Start it once more against the fence it converged on.  A build
      //    that reports the newer fence while it runs and then regresses, or
      //    rewrites the ledger, on its NEXT boot is not rollback-compatible,
      //    and nothing before this step would notice.
      const restartedPid = await boot("restarted", "restart-boot-failed");
      await observe("restarted-booted", { dataDir, port, pid: restartedPid });
      await requireIdentity(base, advancedPair, timeouts, "restart-identity-mismatch");
      requireSavedEvidence("after a restart at the newer fence");
      requireUnchangedLedger(advanced, await ledgerOrBlock(dataDir), "after a restart at the newer fence");
      await stop("restarted stage");
      requireSavedEvidence("after the restarted child was stopped");
      requireUnchangedLedger(advanced, await ledgerOrBlock(dataDir), "across the restarted child's teardown");
      record("restart-kept-fence", `a restarted child reported epoch ${advancedPair.epoch} and left the saved evidence and the ledger unchanged`);
    } catch (error) {
      blockers.push(error instanceof ProbeBlocked ? error.blocker : blocker("probe-failed", describe(error)));
    } finally {
      try {
        await stop("cleanup");
      } catch (error) {
        blockers.push(error instanceof ProbeBlocked ? error.blocker : blocker("child-cleanup-incomplete", describe(error)));
      }
    }

    // 9. Recheck.  The bytes that ran must still be the bytes that were
    //    bound, in the same physical directory: a generation replaced under
    //    the probe is not the generation the probe exercised.
    try {
      await observe("before-recheck", { releaseRoot: binding.releaseRoot, runtimePath: binding.runtime.path });
    } catch (error) {
      blockers.push(error instanceof ProbeBlocked ? error.blocker : blocker("observer-failed", describe(error)));
    }
    const again = await bindCandidate(candidate, { platform });
    for (const entry of again.blockers) blockers.push(blocker(entry.code, entry.detail, "recheck"));
    if (again.blockers.length === 0) {
      recheck = { bindingDigest: again.bindingDigest, physical: again.physical };
      if (again.physical.dev !== bound.physical.dev || again.physical.ino !== bound.physical.ino) {
        blockers.push(blocker("retained-generation-replaced", "the release directory is no longer the physical directory that was bound before the probe", "recheck"));
      }
      if (again.binding.runtime.sha256 !== binding.runtime.sha256 || again.binding.runtime.bytes !== binding.runtime.bytes) {
        blockers.push(blocker("runtime-changed", "the runtime binary's bytes changed during the probe", "recheck"));
      }
      if (again.binding.artifact.fingerprint !== binding.artifact.fingerprint) {
        blockers.push(blocker("artifact-changed", "the release content inventory changed during the probe", "recheck"));
      }
      if (again.bindingDigest !== bound.bindingDigest && !blockers.some((entry) => entry.phase === "recheck")) {
        blockers.push(blocker("binding-changed", "the candidate binding changed during the probe", "recheck"));
      }
    }
    if (blockers.length === 0) record("binding-rechecked", "artifact, runtime and physical release unchanged after execution");

    if (tempRoot !== null) {
      if (!teardownComplete) {
        // A child that may still be running keeps its home: deleting it under
        // a live process would destroy the evidence an operator needs to find it.
        retainedTempRoot = tempRoot;
      } else {
        // The candidate under judgement wrote this home, so it also decides
        // whether it can be removed (one read-only directory is enough to
        // refuse).  That must end in a result and a receipt like every other
        // late step, never in an exception that discards both.
        try {
          rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch (error) {
          retainedTempRoot = tempRoot;
          blockers.push(blocker("temp-home-not-removed", `the throwaway home ${tempRoot} could not be removed and is left in place: ${describe(error)}`));
        }
      }
    }
  }

  const status = blockers.length === 0 ? "fixture-verified" : "blocked";
  const result = {
    receiptVersion: PLACEMENT_ROLLBACK_RECEIPT_VERSION,
    receiptKind: "placement-rollback-fixture-probe",
    status,
    activationAllowed: false,
    scope: "Isolated fixture recipe evidence for the bound release and runtime bytes only.  It grants no authority to migrate, enable a mode, update authentication or prune a rollback generation.",
    recipeVersion: PLACEMENT_ROLLBACK_RECIPE_VERSION,
    schema: PLACEMENT_ROLLBACK_SCHEMA,
    kind: bound.kind,
    candidate: bound.blockers.length === 0 ? bound.binding : null,
    bindingDigest: bound.blockers.length === 0 ? bound.bindingDigest : null,
    physical: bound.blockers.length === 0 ? bound.physical : null,
    recheck,
    blockers,
    outcomes,
    ledger,
    timeouts,
    ignoredTimeoutOverrides,
    tool: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt,
    finishedAt: new Date().toISOString(),
    retainedTempRoot,
  };
  let receiptPath = null;
  if (!receiptProblem) {
    try {
      receiptPath = writeReceipt(receiptDir, { ...result, logs });
      // Reading it back is the proof it exists as a regular file of its own.
      if (!statSync(receiptPath).isFile()) throw new Error("the receipt is not a regular file");
    } catch (error) {
      receiptPath = null;
      result.status = "blocked";
      result.blockers.push(blocker("receipt-not-written", describe(error)));
    }
  }
  return deepFreeze({ ...result, receiptPath });
}
