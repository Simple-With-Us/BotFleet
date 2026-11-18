import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { promoteStaging, stagingPath, validateReleaseManifest } from "./harness-release-store.mjs";
import {
  CONTAINER_LOCKDOWN_ENV,
  PLACEMENT_ROLLBACK_RECIPE_VERSION,
  PLACEMENT_ROLLBACK_SCHEMA,
  PROTECTED_PATH_PARTS,
  RELEASE_STORE_LAUNCH_ARGUMENTS,
  inspectPlacementRollbackCandidate,
  openWithoutFollowing,
  runPlacementRollbackFixtureProbe,
} from "./placement-rollback-probe.mjs";

// Every candidate here is GENERATED: a few files committed to a throwaway
// repository, exported and promoted into a throwaway release store.  A pass
// below is evidence that the inspector and the recipe behave as specified
// against a generated fixture.  It is never evidence about a shipped or
// retained BotFleet artifact.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSIX_ONLY = process.platform === "win32"
  ? "process groups, release-store fixtures and normalized placement storage are POSIX-only"
  : false;
const NODE = realpathSync(process.execPath);
// Only a deadline is shortened here.  The recovery wait and the stop grace are
// recipe steps a caller cannot shorten, so every case that reaches the passive
// comparison pays the full recovery wait, exactly as a real run does.
const FAST = Object.freeze({ bootMs: 30_000 });
const RECIPE_SETTLE_MS = 3_000;
const RECIPE_STOP_GRACE_MS = 5_000;
// A directory only its owner can enter stops an unprivileged removal.  Root
// ignores the mode, so the case that depends on it cannot run as root.
const AS_ROOT = process.getuid?.() === 0;
const HOST = "server:11111111-1111-4111-8111-111111111111";
const ALLOWED_STATUS = new Set(["blocked", "probe-required", "fixture-verified"]);

/**
 * The generated candidate's `server/index.ts`: a small self-contained stand-in
 * for the read-only bridge's HTTP surface, plain JavaScript in a .ts file so
 * the release-store launch shape runs it unchanged.  `variant` selects one
 * deliberate fault; "bridge" has none.
 */
function fixtureServerSource(variant) {
  return `import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

const VARIANT = ${JSON.stringify(variant)};
const HOST = ${JSON.stringify(HOST)};
const home = process.env.HOME;
const dataDir = join(home, ".botfleet");
const port = Number(process.env.OMB_PORT);
const markerPath = join(dataDir, "placement-controller.json");
const normalized = JSON.parse(readFileSync(markerPath, "utf8")).format === "botfleet-placement-sqlite";
if (normalized && VARIANT === "strict-old-reader") {
  console.error("placement-controller is invalid; preserve it and restore the controller epoch before starting");
  process.exit(1);
}
if (VARIANT === "locks-home" && !existsSync(join(home, "locked"))) {
  // Something the candidate leaves behind that its judge cannot delete.
  mkdirSync(join(home, "locked"));
  writeFileSync(join(home, "locked", "file"), "x");
  chmodSync(join(home, "locked"), 0o500);
}
let normalizedBoots = 0;
if (normalized) {
  const counter = join(home, "normalized-boots");
  normalizedBoots = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  writeFileSync(counter, String(normalizedBoots));
}
if (normalized && VARIANT === "late-recovery") {
  // What boot recovery would do: consume saved evidence well after boot.
  setTimeout(() => { try { unlinkSync(join(dataDir, "pending-update-resume.json")); } catch { /* already gone */ } }, 2000);
}
let db = null;
let DatabaseSync = null;
if (normalized) {
  ({ DatabaseSync } = await import("node:sqlite"));
  db = new DatabaseSync(join(dataDir, "placement.sqlite"), { readOnly: VARIANT !== "ledger-writer" });
}
function controller() {
  if (db === null) {
    const pair = JSON.parse(readFileSync(markerPath, "utf8"));
    return { controllerId: pair.controllerId, epoch: pair.epoch };
  }
  const stored = JSON.parse(db.prepare("SELECT json FROM placement_state WHERE id = 1").get().json).controller;
  // Correct while it runs, wrong after its next boot.
  if (VARIANT === "forgets-fence-on-restart" && normalizedBoots > 1) return { controllerId: stored.controllerId, epoch: 7 };
  return stored;
}
if (VARIANT === "escaped-grandchild") {
  const webhook = Number(process.env.OMB_WEBHOOK_PORT);
  const script = "require('node:http').createServer((q, s) => s.end('x')).listen(" + webhook + ", '127.0.0.1'); setTimeout(() => process.exit(0), 30000);";
  const escaped = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  writeFileSync(join(home, "grandchild.pid"), String(escaped.pid));
  escaped.unref();
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: webhook });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const nonce = randomBytes(32).toString("hex");
writeFileSync(join(dataDir, "harness-owner.json"), JSON.stringify({ nonce, pid: process.pid, port }), { mode: 0o600 });
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    // Only a plain object is a body; anything else reads as an empty one.
    req.on("end", () => {
      try {
        const parsed = JSON.parse(text || "{}");
        resolve(Object(parsed) === parsed && !Array.isArray(parsed) ? parsed : {});
      } catch { resolve({}); }
    });
  });
}
createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const companion = req.headers["x-botfleet-companion"] !== undefined;
  if (req.method === "GET" && path === "/api/health") return send(res, 200, { app: "botfleet", pid: process.pid, ready: true });
  if (req.method === "GET" && path === "/api/placement/identity") {
    if (companion) return send(res, 403, { error: "forbidden" });
    // An answer whose size and shape the probe must not copy into its receipt.
    if (VARIANT === "identity-flood") return send(res, 200, { hostId: HOST, version: "1", controllerId: "x".repeat(100000), epoch: { toString: null, valueOf: null } });
    try { return send(res, 200, { hostId: HOST, version: "1", ...controller() }); }
    catch { return send(res, 503, { error: "unavailable" }); }
  }
  if (req.method === "POST" && path.startsWith("/api/placement/")) {
    if (companion) return send(res, 403, { error: "forbidden" });
    const action = path.slice("/api/placement/".length);
    const body = await readBody(req);
    if (VARIANT === "accepts-stale" && action === "claim" && Number.isSafeInteger(body.epoch) && body.epoch < controller().epoch) return send(res, 200, { accepted: true });
    if (VARIANT === "accepts-released-dispatch" && action === "dispatch" && body.lease?.leaseId === "released-lease") {
      return send(res, 200, { accepted: true, leaseId: "released-lease" });
    }
    if (VARIANT === "ledger-writer" && action === "heartbeat") {
      db.prepare("UPDATE placement_state SET json = ? WHERE id = 1").run(JSON.stringify({ controller: controller(), reconcile: false }));
    }
    if (VARIANT === "marker-rewriter" && action === "heartbeat") writeFileSync(markerPath, readFileSync(markerPath, "utf8") + "\\n");
    if (VARIANT === "database-rewriter" && action === "heartbeat") {
      // No row and no schema entry changes: only a header field of the main
      // database file, folded in by a checkpoint that leaves the WAL empty.
      const writer = new DatabaseSync(join(dataDir, "placement.sqlite"));
      writer.exec("PRAGMA application_id = 20261117; PRAGMA wal_checkpoint(TRUNCATE)");
      writer.close();
    }
    if (VARIANT === "wal-appender" && action === "heartbeat") {
      // Bytes SQLite does not accept as a frame, so no reader sees a change.
      appendFileSync(join(dataDir, "placement.sqlite-wal"), Buffer.alloc(64, 7));
    }
    return send(res, 503, { error: "held" });
  }
  if ((req.method === "POST" || req.method === "DELETE") && path === "/api/runtime/quiesce") {
    if (req.headers.authorization !== "Bearer " + nonce) return send(res, 401, { error: "unauthorized" });
    return send(res, 200, { placementReadOnly: normalized, quiescing: !(VARIANT === "releases-hold" && req.method === "DELETE") });
  }
  if (req.method === "POST") return send(res, 503, { error: "held" });
  return send(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1");
`;
}

/**
 * A real repository, a real export and a real promotion into a temporary
 * release store: the binding's whole claim is byte-equality with git's
 * objects and the store's own manifest, so faking either would test the fake.
 * The store root is always the temporary directory, never the default.
 */
async function makeCandidate(t, { variant = "bridge", files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bf-rollback-probe-test-"));
  t.after(() => {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  const receipts = join(root, "receipts");
  const env = { BOTFLEET_RELEASES_ROOT: join(root, "store") };
  mkdirSync(repo);
  mkdirSync(receipts);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  const tree = {
    "package.json": '{"name":"botfleet","version":"0.1.0","type":"module"}\n',
    "server/index.ts": fixtureServerSource(variant),
    ...files,
  };
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "generated fixture candidate");
  const commit = git("rev-parse", "HEAD");
  const staging = stagingPath(commit, env);
  mkdirSync(staging, { recursive: true });
  execFileSync("git", ["-C", repo, "archive", "--format=tar", "--output", join(root, "tree.tar"), commit]);
  execFileSync("tar", ["-xf", join(root, "tree.tar"), "-C", staging]);
  const releaseRoot = realpathSync(await promoteStaging({ commit, env }));
  return {
    root, repo, receipts, commit, releaseRoot,
    candidate: { kind: "release-store", releaseRoot, sourceCommit: commit, sourceRepo: repo, runtimePath: NODE },
  };
}

/**
 * A runtime whose bytes a test can change: a private copy of this Node.  It
 * has to be a real binary, because the binding refuses an interpreter script.
 */
function copiedRuntime(root, name = "fixture-runtime") {
  const path = join(root, name);
  copyFileSync(NODE, path);
  chmodSync(path, 0o755);
  return path;
}

/** What the binding must refuse: a script whose `#!` line names the real runtime. */
function scriptRuntime(root) {
  const path = join(root, "script-runtime");
  writeFileSync(path, `#!/bin/sh\nexec '${NODE}' "$@"\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** True when something accepts a loopback connection on `port`. */
function portAnswers(port) {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (open) => { socket.destroy(); resolveOpen(open); };
    socket.setTimeout(500, () => settle(true));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function assertNeverActivates(result) {
  assert.equal(result.activationAllowed, false);
  assert.ok(ALLOWED_STATUS.has(result.status), result.status);
  assert.ok(Object.isFrozen(result));
  assert.ok(Array.isArray(result.blockers));
  assert.equal(result.status === "blocked", result.blockers.length > 0);
}

function codes(result) {
  return result.blockers.map((entry) => entry.code);
}

function probe(fixture, options = {}) {
  return runPlacementRollbackFixtureProbe(fixture.candidate, { receiptDir: fixture.receipts, timeouts: FAST, ...options });
}

function onlyReceipt(fixture) {
  const names = readdirSync(fixture.receipts);
  assert.equal(names.length, 1, names.join(", "));
  return join(fixture.receipts, names[0]);
}

test("a clean generated release needs a probe and is never called verified by inspection", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const manifestBefore = readFileSync(join(fixture.releaseRoot, ".botfleet-release.json"));
  const result = await inspectPlacementRollbackCandidate(fixture.candidate);
  assertNeverActivates(result);
  assert.equal(result.status, "probe-required");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.binding.releaseRoot, fixture.releaseRoot);
  assert.equal(result.binding.sourceCommit, fixture.commit);
  assert.equal(result.binding.buildIdentity.sourceCommit, fixture.commit);
  assert.equal(result.binding.buildIdentity.sourceDirty, false);
  assert.equal(result.binding.provenance.dependencies, "absent");
  assert.match(result.binding.artifact.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.binding.runtime.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.binding.runtime.bytes, statSync(NODE).size);
  assert.equal(result.binding.runtime.path, NODE);
  assert.match(result.binding.runtime.format, /^(elf|mach-o)$/);
  // The binding names the physical repository that vouched for the commit.
  assert.deepEqual(result.binding.source, { repository: realpathSync(fixture.repo), referenceDeps: null });
  assert.match(result.bindingDigest, /^[a-f0-9]{64}$/);
  // Inspection is repeatable and leaves the strict manifest exactly as it was.
  assert.equal((await inspectPlacementRollbackCandidate(fixture.candidate)).bindingDigest, result.bindingDigest);
  assert.deepEqual(readFileSync(join(fixture.releaseRoot, ".botfleet-release.json")), manifestBefore);
  assert.notEqual(validateReleaseManifest(JSON.parse(manifestBefore.toString("utf8"))), null);
});

test("a missing artifact is blocked, and so is a symlink standing in for one", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const gone = join(dirname(fixture.releaseRoot), "f".repeat(40));
  const missing = await inspectPlacementRollbackCandidate({ ...fixture.candidate, releaseRoot: gone, sourceCommit: "f".repeat(40) });
  assertNeverActivates(missing);
  assert.deepEqual(codes(missing), ["artifact-missing"]);
  assert.equal(missing.binding, null);

  const pointer = join(fixture.root, "current");
  symlinkSync(fixture.releaseRoot, pointer);
  const linked = await inspectPlacementRollbackCandidate({ ...fixture.candidate, releaseRoot: pointer });
  assertNeverActivates(linked);
  assert.deepEqual(codes(linked), ["release-root-symlink"]);

  const noManifest = join(fixture.root, fixture.commit);
  mkdirSync(noManifest);
  const bare = await inspectPlacementRollbackCandidate({ ...fixture.candidate, releaseRoot: noManifest });
  assert.deepEqual(codes(bare), ["release-manifest-invalid"]);
});

test("a commit that does not match the release name, the manifest or the repository is blocked", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const other = await makeCandidate(t, { files: { "notes.txt": "a different generation\n" } });

  const wrongExpectation = await inspectPlacementRollbackCandidate({ ...fixture.candidate, sourceCommit: other.commit });
  assertNeverActivates(wrongExpectation);
  assert.deepEqual(codes(wrongExpectation), ["commit-mismatch"]);

  // The directory name says one commit and the manifest inside says another.
  const disguised = join(fixture.root, "disguised", other.commit);
  mkdirSync(dirname(disguised));
  execFileSync("cp", ["-Rp", fixture.releaseRoot, disguised]);
  const copied = await inspectPlacementRollbackCandidate({ ...fixture.candidate, releaseRoot: disguised, sourceCommit: other.commit, sourceRepo: other.repo });
  assert.deepEqual(codes(copied), ["commit-mismatch"]);

  // A repository that does not hold the commit cannot vouch for it.
  const unknownRepo = await inspectPlacementRollbackCandidate({ ...fixture.candidate, sourceRepo: other.repo });
  assert.deepEqual(codes(unknownRepo), ["source-commit-missing"]);

  for (const sourceCommit of [undefined, "", "main", fixture.commit.slice(0, 12)]) {
    assert.deepEqual(codes(await inspectPlacementRollbackCandidate({ ...fixture.candidate, sourceCommit })), ["source-commit-invalid"]);
  }
});

test("a dirty identity is blocked: unverified dependency bytes never read as clean", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  execFileSync("chmod", ["u+w", fixture.releaseRoot]);
  mkdirSync(join(fixture.releaseRoot, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(fixture.releaseRoot, "node_modules", "left-pad", "index.js"), "module.exports = () => '';\n");
  const result = await inspectPlacementRollbackCandidate(fixture.candidate);
  assertNeverActivates(result);
  assert.deepEqual(codes(result).sort(), ["dependencies-unverified", "identity-dirty"]);
  assert.equal(result.binding, null);

  // A trusted reference tree with the same dependency bytes makes it clean
  // again; a reference that differs is drift.
  const reference = join(fixture.root, "reference");
  mkdirSync(join(reference, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(reference, "node_modules", "left-pad", "index.js"), "module.exports = () => '';\n");
  const verified = await inspectPlacementRollbackCandidate({ ...fixture.candidate, referenceDeps: reference });
  assert.equal(verified.status, "probe-required");
  assert.equal(verified.binding.provenance.dependencies, "verified");
  assert.equal(verified.binding.source.referenceDeps, realpathSync(reference));
  writeFileSync(join(reference, "node_modules", "left-pad", "index.js"), "module.exports = () => 'x';\n");
  assert.deepEqual(codes(await inspectPlacementRollbackCandidate({ ...fixture.candidate, referenceDeps: reference })), ["artifact-drift"]);
});

test("changed artifact bytes are blocked as drift, whether edited, added or removed", { skip: POSIX_ONLY }, async (t) => {
  for (const change of ["edit", "add", "remove"]) {
    const fixture = await makeCandidate(t);
    execFileSync("chmod", ["-R", "u+w", fixture.releaseRoot]);
    if (change === "edit") appendFileSync(join(fixture.releaseRoot, "server", "index.ts"), "// edited after promotion\n");
    if (change === "add") writeFileSync(join(fixture.releaseRoot, "server", "planted.ts"), "export {};\n");
    if (change === "remove") rmSync(join(fixture.releaseRoot, "package.json"));
    const result = await inspectPlacementRollbackCandidate(fixture.candidate);
    assertNeverActivates(result);
    assert.deepEqual(codes(result), ["artifact-drift"], change);
  }
});

test("the runtime is bound by its bytes, and a missing, linked, scripted or non-executable one is blocked", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const runtimePath = copiedRuntime(fixture.root);
  const first = await inspectPlacementRollbackCandidate({ ...fixture.candidate, runtimePath });
  assert.equal(first.status, "probe-required");
  appendFileSync(runtimePath, "one changed byte\n");
  const second = await inspectPlacementRollbackCandidate({ ...fixture.candidate, runtimePath });
  assert.equal(second.status, "probe-required");
  assert.notEqual(second.binding.runtime.sha256, first.binding.runtime.sha256);
  assert.notEqual(second.bindingDigest, first.bindingDigest);
  assert.equal(second.binding.artifact.fingerprint, first.binding.artifact.fingerprint);

  // A runtime reached through a linked DIRECTORY is bound by where it really
  // is, so repointing the link later cannot change which file was named.
  const realDir = join(realpathSync(fixture.root), "runtime-v1");
  mkdirSync(realDir);
  renameSync(runtimePath, join(realDir, "node"));
  symlinkSync(realDir, join(fixture.root, "runtime-current"));
  const throughLink = await inspectPlacementRollbackCandidate({ ...fixture.candidate, runtimePath: join(fixture.root, "runtime-current", "node") });
  assert.equal(throughLink.status, "probe-required");
  assert.equal(throughLink.binding.runtime.path, join(realDir, "node"));
  assert.equal(throughLink.binding.runtime.sha256, second.binding.runtime.sha256);

  const physical = join(realDir, "node");
  const link = join(fixture.root, "runtime-link");
  symlinkSync(physical, link);
  const empty = join(fixture.root, "empty-runtime");
  writeFileSync(empty, "", { mode: 0o755 });
  chmodSync(empty, 0o755);
  chmodSync(physical, 0o644);
  // Another name for the same bytes: the hash would not be the hash of what runs.
  const hardLinked = copiedRuntime(fixture.root, "hard-linked-runtime");
  linkSync(hardLinked, join(fixture.root, "second-name-for-runtime"));
  const cases = [
    [join(fixture.root, "no-such-runtime"), "runtime-missing"],
    [join(fixture.root, "no-such-directory", "node"), "runtime-missing"],
    [link, "runtime-symlink"],
    [fixture.root, "runtime-not-file"],
    [physical, "runtime-not-executable"],
    // The script's own bytes would be bound while a different program ran.
    [scriptRuntime(fixture.root), "runtime-not-binary"],
    [empty, "runtime-not-binary"],
    [hardLinked, "runtime-hard-linked"],
    ["node", "runtime-path-invalid"],
  ];
  for (const [path, code] of cases) {
    const result = await inspectPlacementRollbackCandidate({ ...fixture.candidate, runtimePath: path });
    assertNeverActivates(result);
    assert.deepEqual(codes(result), [code]);
  }
});

test("a file is opened without following a link in its last component, or not at all", { skip: POSIX_ONLY }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "bf-rollback-probe-nofollow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  const link = join(root, "link");
  writeFileSync(real, "bytes");
  symlinkSync(real, link);
  const fd = openWithoutFollowing(real);
  closeSync(fd);
  // The link is refused by the open itself, which is what a swap between the
  // listing and the open meets; the inspector's earlier lstat cannot be raced.
  assert.throws(() => openWithoutFollowing(link), { code: "ELOOP" });
});

test("a candidate path that names or leads into a credential or login directory is blocked before it is read", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const root = realpathSync(fixture.root);
  const blockedFor = async (overrides, code, detail) => {
    const result = await inspectPlacementRollbackCandidate({ ...fixture.candidate, ...overrides });
    assertNeverActivates(result);
    assert.deepEqual(codes(result), [code], JSON.stringify(overrides));
    assert.match(result.blockers[0].detail, detail);
  };

  // A release root that sits under a credential directory, even a valid one.
  const credentials = join(root, ".ssh");
  mkdirSync(credentials);
  const inside = join(credentials, fixture.commit);
  execFileSync("cp", ["-Rp", fixture.releaseRoot, inside]);
  await blockedFor({ releaseRoot: inside }, "candidate-path-protected", /^releaseRoot .* names a credential or login directory$/);
  await blockedFor({ referenceDeps: credentials }, "candidate-path-protected", /^referenceDeps /);

  // An innocent name that is a link into one: the repository and the runtime.
  const aws = join(root, ".aws");
  mkdirSync(aws);
  copyFileSync(NODE, join(aws, "node"));
  chmodSync(join(aws, "node"), 0o755);
  const innocent = join(root, "innocent");
  symlinkSync(aws, innocent);
  await blockedFor({ runtimePath: join(innocent, "node") }, "candidate-path-protected", /^runtimePath .* leads into a credential or login directory/);
  await blockedFor({ sourceRepo: innocent }, "candidate-path-protected", /^sourceRepo .* leads into a credential or login directory/);

  // A link that leads nowhere says nothing about where it was meant to land.
  const dangling = join(root, "dangling");
  symlinkSync(join(root, "no-such-target"), dangling);
  await blockedFor({ sourceRepo: dangling }, "candidate-path-dangling-link", /^sourceRepo .* does not resolve/);

  // Only credential and login places are refused: the release store's own
  // default home is a dot directory, and a release root there is ordinary.
  const store = join(root, ".botfleet", "releases", fixture.commit);
  mkdirSync(dirname(store), { recursive: true });
  execFileSync("cp", ["-Rp", fixture.releaseRoot, store]);
  const ordinary = await inspectPlacementRollbackCandidate({ ...fixture.candidate, releaseRoot: store });
  assertNeverActivates(ordinary);
  assert.deepEqual(ordinary.blockers, []);
  assert.equal(ordinary.status, "probe-required");
});

test("a release manifest with another hard link is not read", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  linkSync(join(fixture.releaseRoot, ".botfleet-release.json"), join(fixture.root, "second-name.json"));
  const result = await inspectPlacementRollbackCandidate(fixture.candidate);
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["release-manifest-invalid"]);
  assert.match(result.blockers[0].detail, /another hard link/);
  assert.equal(result.binding, null);
});

test("a signed-bundle candidate off darwin is blocked with a named missing proof, and no other kind is bound", async () => {
  const bundle = { kind: "signed-bundle", releaseRoot: "/Applications/BotFleet.app", sourceCommit: "a".repeat(40), runtimePath: "/Applications/BotFleet.app/Contents/MacOS/BotFleet" };
  const offDarwin = await inspectPlacementRollbackCandidate(bundle, { platform: "linux" });
  assertNeverActivates(offDarwin);
  assert.deepEqual(codes(offDarwin), ["signed-bundle-platform-unavailable"]);
  assert.match(offDarwin.blockers[0].detail, /missing proof: Mac code signature and packaged runtime identity/);
  assert.equal(offDarwin.kind, "signed-bundle");

  // On darwin the proof is still missing in this unit: named, never waived.
  const onDarwin = await inspectPlacementRollbackCandidate(bundle, { platform: "darwin" });
  assert.deepEqual(codes(onDarwin), ["signed-bundle-binding-unimplemented"]);
  assert.match(onDarwin.blockers[0].detail, /missing proof/);

  assert.deepEqual(codes(await inspectPlacementRollbackCandidate({ ...bundle, kind: "linux-retained-source" })), ["candidate-kind-unsupported"]);
  assert.deepEqual(codes(await inspectPlacementRollbackCandidate({ ...bundle, kind: undefined })), ["candidate-kind-missing"]);
});

test("every result has activationAllowed false, and an externally supplied verified report is ignored", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const claimed = { status: "fixture-verified", activationAllowed: true, blockers: [], receiptPath: "/tmp/claimed.json" };

  // Nothing a caller attaches changes what inspection finds for itself.
  const plain = await inspectPlacementRollbackCandidate(fixture.candidate);
  const dressed = await inspectPlacementRollbackCandidate({ ...fixture.candidate, ...claimed, report: claimed, verified: true });
  assert.deepEqual(dressed, plain);
  assert.equal(dressed.status, "probe-required");

  const gone = { ...fixture.candidate, releaseRoot: join(dirname(fixture.releaseRoot), "e".repeat(40)), sourceCommit: "e".repeat(40) };
  const refused = await runPlacementRollbackFixtureProbe({ ...gone, ...claimed, report: claimed }, {
    receiptDir: fixture.receipts, timeouts: FAST, report: claimed, status: "fixture-verified", activationAllowed: true,
  });
  assertNeverActivates(refused);
  assert.equal(refused.status, "blocked");
  assert.deepEqual(codes(refused), ["artifact-missing"]);
  assert.deepEqual(refused.outcomes, []);
  const receipt = JSON.parse(readFileSync(onlyReceipt(fixture), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.activationAllowed, false);

  for (const input of [undefined, null, "release", 7, [], {}, { kind: "release-store" }, { kind: "signed-bundle" }, { kind: "release-store", releaseRoot: "relative/path" }]) {
    const inspected = await inspectPlacementRollbackCandidate(input);
    assertNeverActivates(inspected);
    assert.equal(inspected.status, "blocked");
    const probed = await runPlacementRollbackFixtureProbe(input, { receiptDir: join(fixture.root, "no-such-directory") });
    assertNeverActivates(probed);
    assert.equal(probed.status, "blocked");
    assert.equal(probed.receiptPath, null);
    assert.ok(codes(probed).includes("receipt-directory-invalid"));
  }
});

test("the receipt is kept apart from the release, and a probe with nowhere to write one does not run", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  for (const receiptDir of [fixture.releaseRoot, join(fixture.releaseRoot, "server"), undefined, "receipts"]) {
    const result = await runPlacementRollbackFixtureProbe(fixture.candidate, { receiptDir, timeouts: FAST });
    assertNeverActivates(result);
    assert.deepEqual(codes(result), ["receipt-directory-invalid"]);
    assert.equal(result.receiptPath, null);
    assert.deepEqual(result.outcomes, []);
  }
  assert.deepEqual(readdirSync(fixture.releaseRoot).sort(), [".botfleet-release.json", "package.json", "server"]);
  assert.deepEqual(readdirSync(fixture.receipts), []);
});

test("the generated normalized fixture passes the recipe, with the ledger unchanged and a separate receipt", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const manifestPath = join(fixture.releaseRoot, ".botfleet-release.json");
  const manifestBefore = readFileSync(manifestPath);
  const inspected = await inspectPlacementRollbackCandidate(fixture.candidate);
  const phases = [];
  let home = null;
  let nonce = null;
  const result = await probe(fixture, {
    onPhase: (event) => {
      phases.push(event.phase);
      if (event.dataDir) home = dirname(event.dataDir);
      if (event.phase === "normalized-booted") nonce = JSON.parse(readFileSync(join(event.dataDir, "harness-owner.json"), "utf8")).nonce;
    },
  });
  assertNeverActivates(result);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.status, "fixture-verified");
  assert.equal(result.recipeVersion, PLACEMENT_ROLLBACK_RECIPE_VERSION);
  assert.equal(result.schema, PLACEMENT_ROLLBACK_SCHEMA);
  assert.deepEqual(phases, ["legacy-booted", "normalized-prepared", "normalized-booted", "before-teardown", "restarted-booted", "before-recheck"]);
  assert.deepEqual(result.outcomes.map((entry) => entry.step), [
    "legacy-readable", "legacy-teardown", "normalized-prepared", "normalized-identity", "placement-posts-refused", "hold-kept",
    "ledger-unchanged", "identity-converged", "stale-requests-refused", "normalized-teardown", "ledger-unchanged-after-teardown",
    "restarted-teardown", "restart-kept-fence", "binding-rechecked",
  ]);
  // The waits that applied are the recipe's own, and nothing was refused.
  assert.equal(result.timeouts.settleMs, RECIPE_SETTLE_MS);
  assert.equal(result.timeouts.stopGraceMs, RECIPE_STOP_GRACE_MS);
  assert.equal(result.timeouts.bootMs, FAST.bootMs);
  assert.deepEqual(result.ignoredTimeoutOverrides, []);

  // The probe bound the same bytes the inspector did, and they are unchanged.
  assert.equal(result.bindingDigest, inspected.bindingDigest);
  assert.equal(result.recheck.bindingDigest, inspected.bindingDigest);
  assert.deepEqual(result.recheck.physical, result.physical);
  assert.equal((await inspectPlacementRollbackCandidate(fixture.candidate)).bindingDigest, inspected.bindingDigest);

  // The ledger: the writer's deliberate commit is the only change.
  assert.equal(result.ledger.prepared.schema, "normalized-v1");
  assert.deepEqual(result.ledger.prepared.controller, { controllerId: "mac:22222222-2222-4222-8222-222222222222", epoch: 7 });
  assert.deepEqual(result.ledger.advanced.controller, { controllerId: HOST, epoch: 9 });
  assert.notEqual(result.ledger.advanced.digest, result.ledger.prepared.digest);
  assert.equal(result.ledger.advanced.files.marker, result.ledger.prepared.files.marker);
  assert.ok(result.ledger.prepared.released >= 1 && result.ledger.prepared.settled >= 1 && result.ledger.prepared.pendingStops >= 1);

  // The receipt is its own private file beside nothing in the release.
  const receiptPath = onlyReceipt(fixture);
  assert.equal(result.receiptPath, receiptPath);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.status, "fixture-verified");
  assert.equal(receipt.activationAllowed, false);
  assert.equal(receipt.receiptKind, "placement-rollback-fixture-probe");
  assert.equal(receipt.candidate.releaseRoot, fixture.releaseRoot);
  assert.equal(receipt.candidate.sourceCommit, fixture.commit);
  assert.equal(receipt.candidate.buildIdentity.sourceDirty, false);
  assert.equal(receipt.candidate.artifact.fingerprint, inspected.binding.artifact.fingerprint);
  assert.equal(receipt.candidate.runtime.sha256, inspected.binding.runtime.sha256);
  assert.equal(receipt.schema, "normalized-v1");
  assert.equal(receipt.recipeVersion, 1);
  assert.match(receipt.scope, /grants no authority/);
  assert.deepEqual(Object.keys(receipt.logs).sort(), ["legacy", "normalized", "restarted"]);
  assert.equal(receipt.candidate.source.repository, realpathSync(fixture.repo));
  assert.deepEqual(receipt.ignoredTimeoutOverrides, []);
  // The throwaway home's owner secret authenticated the lifecycle routes and
  // appears nowhere in the receipt or the returned result.
  assert.match(nonce, /^[a-f0-9]{64}$/);
  assert.ok(!readFileSync(receiptPath, "utf8").includes(nonce));
  assert.ok(!JSON.stringify(result).includes(nonce));

  // The strict manifest gained no field and no byte; the release holds
  // nothing new; the throwaway home is gone.
  assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  assert.deepEqual(Object.keys(JSON.parse(manifestBefore.toString("utf8"))).sort(), ["commit", "node", "platform", "promotedAt", "schemaVersion", "version"]);
  assert.deepEqual(readdirSync(fixture.releaseRoot).sort(), [".botfleet-release.json", "package.json", "server"]);
  assert.equal(result.retainedTempRoot, null);
  assert.ok(home !== null && !existsSync(home));
});

test("a strict old reader is a negative fixture: it cannot open the normalized marker and is blocked", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t, { variant: "strict-old-reader" });
  const result = await probe(fixture);
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["normalized-boot-failed"]);
  // It was rollback-readable while the ledger was still legacy JSON.
  assert.deepEqual(result.outcomes.map((entry) => entry.step), ["legacy-readable", "legacy-teardown", "normalized-prepared", "normalized-teardown"]);
  const receipt = JSON.parse(readFileSync(onlyReceipt(fixture), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.logs.normalized.stderr, /placement-controller is invalid/);
});

test("a candidate that acknowledges a stale request or a released-lease dispatch is blocked", { skip: POSIX_ONLY }, async (t) => {
  for (const [variant, named] of [["accepts-stale", /stale-claim answered 200 and acknowledged/], ["accepts-released-dispatch", /released-lease-dispatch answered 200 and acknowledged/]]) {
    const fixture = await makeCandidate(t, { variant });
    const result = await probe(fixture);
    assertNeverActivates(result);
    assert.deepEqual(codes(result), ["placement-post-not-refused"], variant);
    assert.match(result.blockers[0].detail, named);
  }
});

test("an identity answer of any size or shape is blocked without being copied into the receipt", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t, { variant: "identity-flood" });
  const result = await probe(fixture);
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["legacy-identity-mismatch"]);
  assert.ok(result.blockers[0].detail.length < 400, String(result.blockers[0].detail.length));
  assert.match(result.blockers[0].detail, /\[non-scalar\]/);
  assert.match(result.blockers[0].detail, /controllerId "x{80}\.\.\."/);
  assert.ok(readFileSync(onlyReceipt(fixture), "utf8").length < 100_000);
});

test("a candidate that releases the hold on DELETE is blocked", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t, { variant: "releases-hold" });
  const result = await probe(fixture);
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["hold-released"]);
});

test("a changed logical ledger digest or changed authoritative bytes are blocked", { skip: POSIX_ONLY }, async (t) => {
  // The last two change no row and no schema entry, so the logical digest
  // cannot see them: only the byte comparison of that one file can.
  const variants = [
    ["ledger-writer", "ledger-digest-changed", /logical ledger digest changed/],
    ["marker-rewriter", "ledger-bytes-changed", /^authoritative marker bytes changed/],
    ["database-rewriter", "ledger-bytes-changed", /^authoritative database bytes changed/],
    ["wal-appender", "ledger-bytes-changed", /^authoritative wal bytes changed/],
  ];
  for (const [variant, code, detail] of variants) {
    const fixture = await makeCandidate(t, { variant });
    const result = await probe(fixture);
    assertNeverActivates(result);
    assert.deepEqual(codes(result), [code], variant);
    assert.match(result.blockers[0].detail, detail, variant);
  }
});

test("a candidate that forgets the newer fence on its next boot is blocked by the restart step", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t, { variant: "forgets-fence-on-restart" });
  const result = await probe(fixture);
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["restart-identity-mismatch"]);
  // Everything up to the restart passed: only the second normalized boot is wrong.
  const steps = result.outcomes.map((entry) => entry.step);
  assert.ok(steps.includes("identity-converged") && steps.includes("ledger-unchanged-after-teardown"), steps.join(", "));
  assert.ok(!steps.includes("restart-kept-fence"));
  assert.equal(result.retainedTempRoot, null);
});

test("a caller cannot shorten the recovery wait or the stop grace, and an overflowing wait is refused", { skip: POSIX_ONLY }, async (t) => {
  // This candidate consumes saved evidence two seconds after boot.  With the
  // recovery wait cut to nothing the comparison would run first and pass.
  const fixture = await makeCandidate(t, { variant: "late-recovery" });
  // 1e12 ms overflows Node's timer, which then fires after one millisecond.
  for (const settleMs of [0, 1e12]) {
    const result = await probe(fixture, { timeouts: { settleMs, stopGraceMs: 0 } });
    assertNeverActivates(result);
    assert.deepEqual(codes(result), ["saved-evidence-changed"], String(settleMs));
    assert.equal(result.timeouts.settleMs, RECIPE_SETTLE_MS);
    assert.equal(result.timeouts.stopGraceMs, RECIPE_STOP_GRACE_MS);
    assert.deepEqual(result.ignoredTimeoutOverrides, ["stopGraceMs", "settleMs"]);
  }
  const receipts = readdirSync(fixture.receipts).map((name) => JSON.parse(readFileSync(join(fixture.receipts, name), "utf8")));
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) assert.deepEqual(receipt.ignoredTimeoutOverrides, ["stopGraceMs", "settleMs"]);

  // A longer wait and a shorter deadline are both honoured.  The candidate
  // here is absent, so nothing runs: only the recorded waits are read.
  const gone = { ...fixture.candidate, releaseRoot: join(dirname(fixture.releaseRoot), "d".repeat(40)), sourceCommit: "d".repeat(40) };
  const adjusted = await runPlacementRollbackFixtureProbe(gone, {
    receiptDir: fixture.receipts, timeouts: { settleMs: RECIPE_SETTLE_MS + 1_000, bootMs: 10, requestMs: "5", convergeMs: -1, writerMs: Number.NaN },
  });
  assert.equal(adjusted.timeouts.settleMs, RECIPE_SETTLE_MS + 1_000);
  assert.equal(adjusted.timeouts.bootMs, 10);
  assert.deepEqual(adjusted.ignoredTimeoutOverrides, ["requestMs", "convergeMs", "writerMs"]);
});

test("a replace ref in the named repository cannot make other bytes bind as the expected commit", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const pinBefore = process.env.GIT_NO_REPLACE_OBJECTS;
  const git = (...args) => execFileSync("git", ["-C", fixture.repo, ...args], { encoding: "utf8" });
  const reviewed = readFileSync(join(fixture.repo, "server", "index.ts"), "utf8");
  const other = `${reviewed}// not the reviewed commit\n`;
  writeFileSync(join(fixture.repo, "server", "index.ts"), other);
  git("commit", "-q", "-am", "a different tree");
  git("replace", fixture.commit, git("rev-parse", "HEAD").trim());
  // The trap is armed: asked for the expected commit, git now hands back the
  // other commit's bytes, with nothing in history or on a remote to show it.
  assert.equal(git("show", `${fixture.commit}:server/index.ts`), other);

  // The release still holds the reviewed bytes, and still binds.
  const honest = await inspectPlacementRollbackCandidate(fixture.candidate);
  assert.equal(honest.status, "probe-required");
  assert.equal(honest.binding.source.repository, realpathSync(fixture.repo));

  // The other commit's bytes under the expected commit's name are drift.
  execFileSync("chmod", ["-R", "u+w", fixture.releaseRoot]);
  writeFileSync(join(fixture.releaseRoot, "server", "index.ts"), other);
  const swapped = await inspectPlacementRollbackCandidate(fixture.candidate);
  assertNeverActivates(swapped);
  assert.deepEqual(codes(swapped), ["artifact-drift"]);
  assert.equal(swapped.binding, null);
  // The pin lasts for the binding's own git reads and no longer.
  assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, pinBefore);
});

test("artifact bytes changed during the probe are caught by the recheck", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const result = await probe(fixture, {
    onPhase: ({ phase }) => {
      if (phase !== "before-recheck") return;
      execFileSync("chmod", ["-R", "u+w", fixture.releaseRoot]);
      appendFileSync(join(fixture.releaseRoot, "server", "index.ts"), "// edited while the probe ran\n");
    },
  });
  assertNeverActivates(result);
  assert.deepEqual(result.blockers.map((entry) => [entry.code, entry.phase]), [["artifact-drift", "recheck"]]);
  assert.equal(result.recheck, null);
});

test("runtime bytes changed during the probe are caught by the recheck", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const runtimePath = copiedRuntime(realpathSync(fixture.root));
  fixture.candidate = { ...fixture.candidate, runtimePath };
  const result = await probe(fixture, {
    onPhase: ({ phase }) => { if (phase === "before-recheck") appendFileSync(runtimePath, "changed while the probe ran\n"); },
  });
  assertNeverActivates(result);
  assert.deepEqual(result.blockers.map((entry) => [entry.code, entry.phase]), [["runtime-changed", "recheck"]]);
});

test("a retained generation replaced between the probe and the recheck is blocked even when its bytes match", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const result = await probe(fixture, {
    onPhase: ({ phase }) => {
      if (phase !== "before-recheck") return;
      const moved = `${fixture.releaseRoot}.replaced`;
      renameSync(fixture.releaseRoot, moved);
      execFileSync("cp", ["-Rp", moved, fixture.releaseRoot]);
    },
  });
  assertNeverActivates(result);
  assert.deepEqual(result.blockers.map((entry) => [entry.code, entry.phase]), [["retained-generation-replaced", "recheck"]]);
  // Byte-identical content: only the physical directory differs.
  assert.equal(result.recheck.bindingDigest, result.bindingDigest);
  assert.notDeepEqual(result.recheck.physical, result.physical);
});

test("a child that leaves a descendant holding a loopback port is an incomplete teardown, and is blocked", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t, { variant: "escaped-grandchild" });
  let escaped = null;
  t.after(() => {
    if (escaped !== null) {
      try { process.kill(escaped, "SIGKILL"); } catch { /* it already ended itself */ }
    }
  });
  const result = await probe(fixture, {
    onPhase: ({ phase, dataDir }) => {
      if (phase === "legacy-booted") escaped = Number(readFileSync(join(dirname(dataDir), "grandchild.pid"), "utf8"));
    },
  });
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["child-cleanup-incomplete"]);
  assert.match(result.blockers[0].detail, /loopback ports are still answering/);
  // The home of a child that may still be running is kept for the operator.
  assert.ok(result.retainedTempRoot !== null && existsSync(result.retainedTempRoot));
  assert.ok(Number.isInteger(escaped) && escaped > 0);
  process.kill(escaped, "SIGKILL");
  rmSync(result.retainedTempRoot, { recursive: true, force: true });
  const receipt = JSON.parse(readFileSync(onlyReceipt(fixture), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.retainedTempRoot, result.retainedTempRoot);
});

test("a throwaway home the candidate made undeletable ends in a blocked result and a receipt, not an exception", { skip: POSIX_ONLY || (AS_ROOT ? "root can remove a directory whatever its mode" : false) }, async (t) => {
  const fixture = await makeCandidate(t, { variant: "locks-home" });
  let kept = null;
  t.after(() => {
    if (kept === null || !basename(kept).startsWith("bf-rollback-probe-")) return;
    execFileSync("chmod", ["-R", "u+w", kept]);
    rmSync(kept, { recursive: true, force: true });
  });
  const result = await probe(fixture, { onPhase: ({ dataDir }) => { if (dataDir) kept = dirname(dirname(dataDir)); } });
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["temp-home-not-removed"]);
  // The whole recipe passed first, so nothing gathered along the way is lost.
  const steps = result.outcomes.map((entry) => entry.step);
  assert.ok(steps.includes("restart-kept-fence") && steps.includes("binding-rechecked"), steps.join(", "));
  // The home is reported, still there, and named in the receipt.
  assert.equal(result.retainedTempRoot, kept);
  assert.ok(existsSync(join(kept, "home", "locked", "file")));
  const receipt = JSON.parse(readFileSync(onlyReceipt(fixture), "utf8"));
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.retainedTempRoot, kept);
  assert.deepEqual(receipt.blockers.map((entry) => entry.code), ["temp-home-not-removed"]);
  assert.deepEqual(Object.keys(receipt.logs).sort(), ["legacy", "normalized", "restarted"]);
});

test("interrupting the probing process ends the candidate's process group", { skip: POSIX_ONLY }, async (t) => {
  // The generated candidate carries no parent watchdog, like a retained
  // artifact older than that watchdog: nothing but the probe's own interrupt
  // guard stands between a cancelled run and an orphan holding both ports.
  const fixture = await makeCandidate(t);
  const notePath = join(fixture.root, "candidate.json");
  const driverPath = join(fixture.root, "driver.mjs");
  writeFileSync(driverPath, `import { writeFileSync } from "node:fs";
import { runPlacementRollbackFixtureProbe } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "scripts", "placement-rollback-probe.mjs")).href)};
const { candidate, receiptDir, notePath } = JSON.parse(process.argv[2]);
await runPlacementRollbackFixtureProbe(candidate, {
  receiptDir,
  onPhase: async ({ phase, pid, port, dataDir }) => {
    if (phase !== "normalized-booted") return;
    writeFileSync(notePath, JSON.stringify({ pid, port, dataDir }));
    // Hold the probe mid-recipe until the signal arrives.
    await new Promise(() => { setInterval(() => {}, 1_000); });
  },
});
`);
  const driver = spawn(process.execPath, [driverPath, JSON.stringify({ candidate: fixture.candidate, receiptDir: fixture.receipts, notePath })], { stdio: "ignore" });
  const driverExit = new Promise((resolveExit) => { driver.once("exit", (code, signal) => resolveExit({ code, signal })); });
  let note = null;
  t.after(() => {
    try { driver.kill("SIGKILL"); } catch { /* already gone */ }
    if (note === null) return;
    try { process.kill(-note.pid, "SIGKILL"); } catch { /* the group is already gone */ }
    const tempRoot = dirname(dirname(note.dataDir));
    if (basename(tempRoot).startsWith("bf-rollback-probe-")) rmSync(tempRoot, { recursive: true, force: true });
  });
  for (let waited = 0; waited < 30_000 && !existsSync(notePath) && driver.exitCode === null && driver.signalCode === null; waited += 50) {
    await new Promise((resolveWait) => { setTimeout(resolveWait, 50); });
  }
  assert.ok(existsSync(notePath), "the driver never reached the normalized stage");
  note = JSON.parse(readFileSync(notePath, "utf8"));
  assert.ok(await portAnswers(note.port), "the candidate should be serving before the interrupt");

  driver.kill("SIGTERM");
  // The guard hands the signal back, so the driver still dies of it.
  assert.deepEqual(await driverExit, { code: null, signal: "SIGTERM" });
  let serving = true;
  for (let waited = 0; waited < 5_000 && serving; waited += 100) {
    serving = await portAnswers(note.port);
    if (serving) await new Promise((resolveWait) => { setTimeout(resolveWait, 100); });
  }
  assert.equal(serving, false, "the candidate outlived the interrupted probe and still holds its port");
});

test("an observer that throws blocks the run instead of being skipped", { skip: POSIX_ONLY }, async (t) => {
  const fixture = await makeCandidate(t);
  const result = await probe(fixture, { onPhase: ({ phase }) => { if (phase === "normalized-booted") throw new Error("observer fault"); } });
  assertNeverActivates(result);
  assert.deepEqual(codes(result), ["observer-failed"]);
  assert.equal(result.retainedTempRoot, null);
});

test("the restated launch shape, lockdown environment and action list match their sources", () => {
  const launcher = readFileSync(join(REPO_ROOT, "scripts", "botfleet-server-start.sh"), "utf8");
  assert.ok(launcher.includes(`exec "$NODE" ${RELEASE_STORE_LAUNCH_ARGUMENTS.join(" ")}\n`));

  const guard = readFileSync(join(REPO_ROOT, "server", "container-runtime-guard.ts"), "utf8");
  assert.deepEqual(Object.keys(CONTAINER_LOCKDOWN_ENV).sort(), ["BOTFLEET_DISABLE_CONTAINER_RUNTIME", "CONTAINER_HOST", "DOCKER_HOST"]);
  assert.ok(guard.includes(`CONTAINER_RUNTIME_DISABLED_ENV = "BOTFLEET_DISABLE_CONTAINER_RUNTIME"`));
  assert.ok(guard.includes(`UNREACHABLE_RUNTIME_SOCKET = "${CONTAINER_LOCKDOWN_ENV.DOCKER_HOST}"`));
  assert.equal(CONTAINER_LOCKDOWN_ENV.CONTAINER_HOST, CONTAINER_LOCKDOWN_ENV.DOCKER_HOST);
  assert.equal(CONTAINER_LOCKDOWN_ENV.BOTFLEET_DISABLE_CONTAINER_RUNTIME, "1");
  const lockdown = guard.slice(guard.indexOf("export function containerRuntimeLockdownEnv()"));
  for (const line of ['[CONTAINER_RUNTIME_DISABLED_ENV]: "1"', "DOCKER_HOST: UNREACHABLE_RUNTIME_SOCKET", "CONTAINER_HOST: UNREACHABLE_RUNTIME_SOCKET"]) {
    assert.ok(lockdown.includes(line), line);
  }

  // The credential and login directories are the ones the routine policy
  // refuses to write, restated because that file is TypeScript.
  const policy = readFileSync(join(REPO_ROOT, "server", "tool-policy.ts"), "utf8");
  const declaredParts = policy.slice(policy.indexOf("const PROTECTED_WRITE_PARTS = ["));
  const policyParts = [...declaredParts.slice(0, declaredParts.indexOf("];")).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(policyParts.length > 0);
  assert.deepEqual([...PROTECTED_PATH_PARTS], policyParts);

  const probeSource = readFileSync(join(REPO_ROOT, "scripts", "placement-rollback-probe.mjs"), "utf8");
  // The behavior is shown by the open test above.  These pin its wiring: no
  // `?? 0` fallback for a platform that lacks O_NOFOLLOW, the helper's one
  // direct open carries the flag, and every handle on a listed path comes
  // from the helper, whatever the variable is called.
  assert.ok(!probeSource.includes("O_NOFOLLOW ?? 0"));
  const directOpens = [...probeSource.matchAll(/\bopenSync\s*\(([^)]*)\)/g)].map((match) => match[1]);
  assert.equal(directOpens.filter((args) => !/^\w+Path, "w", /.test(args)).length, 1);
  assert.ok(directOpens.some((args) => /constants\.O_RDONLY \| noFollow\b/.test(args)));
  assert.equal(probeSource.match(/=\s*openWithoutFollowing\(/g).length, 2);
  const leases = readFileSync(join(REPO_ROOT, "server", "placement-leases.ts"), "utf8");
  const declared = leases.slice(leases.indexOf("export const PLACEMENT_LEASE_ACTIONS"));
  const actions = [...declared.slice(0, declared.indexOf("];")).matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(actions.length, 10);
  const restated = probeSource.slice(probeSource.indexOf("const PLACEMENT_POST_ACTIONS"));
  assert.deepEqual([...restated.slice(0, restated.indexOf("]);")).matchAll(/"([a-z-]+)"/g)].map((match) => match[1]), actions);

  // The tool reads the release manifest and never writes one, and it calls no
  // store operation that stages, promotes, swaps or prunes.
  for (const forbidden of ["stageRelease", "promoteStaging", "swapCurrent", "pruneReleases", "discardRelease"]) {
    assert.ok(!probeSource.includes(forbidden), forbidden);
  }
});
