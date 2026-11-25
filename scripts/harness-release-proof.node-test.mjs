import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  holdRelease,
  isReleaseHeld,
  listReleases,
  promoteStaging,
  pruneReleases,
  releaseHold,
  releaseProofPath,
  stagingPath,
  swapCurrent,
  writeReleaseProof,
} from "./harness-release-store.mjs";
import {
  inspectPlacementRollbackCandidate,
  recheckPlacementRollbackCandidate,
} from "./placement-rollback-probe.mjs";
import { hashDependencyTree } from "./release-provenance.mjs";

// Every release here is GENERATED: a throwaway repository, exported and
// promoted into a throwaway release store.  A pass below is evidence that the
// store and the probe behave as specified against a generated fixture.  It is
// never evidence about a shipped or retained BotFleet artifact.

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const BUILD = "202611240001";

// The inspector refuses a runtime under a dot directory other than the
// application's own (a Node under ~/.nvm, ~/.volta or ~/.asdf), so a host that
// keeps its Node there runs these cases with a private copy of the same binary.
function privateNodeCopy(path) {
  const dir = mkdtempSync(join(tmpdir(), "bf-release-proof-node-"));
  const copy = join(dir, "node");
  copyFileSync(path, copy);
  chmodSync(copy, 0o755);
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return copy;
}
const HOST_NODE = realpathSync(process.execPath);
const NODE = HOST_NODE.split("/").some((part) => part.startsWith(".") && part.toLowerCase() !== ".botfleet")
  ? privateNodeCopy(HOST_NODE)
  : HOST_NODE;

async function store(t) {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-releases-"));
  t.after(() => {
    execFileSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  });
  return { env: { BOTFLEET_RELEASES_ROOT: dir, HOME: dir }, dir };
}

/** A staged tree that looks enough like a release for the store's purposes. */
async function stage(env, commit, marker) {
  const path = stagingPath(commit, env);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "marker.txt"), marker);
  return path;
}

/**
 * A generated candidate: a real commit, exported into a real release store.
 *
 * The source repository is a real one because the binding compares the
 * promoted tree against the commit it names, and a fixture that skipped that
 * comparison would prove nothing about the path that matters.
 */
async function makeCandidate(t) {
  const root = mkdtempSync(join(tmpdir(), "bf-release-proof-"));
  t.after(() => {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo");
  const env = { BOTFLEET_RELEASES_ROOT: join(root, "store") };
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(repo, "server"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "package.json"), '{"name":"botfleet","version":"0.1.0","type":"module"}\n');
  writeFileSync(join(repo, "server", "index.ts"), "export const ok = true;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "generated fixture candidate");
  const commit = git("rev-parse", "HEAD");
  const staging = stagingPath(commit, env);
  mkdirSync(staging, { recursive: true });
  execFileSync("git", ["-C", repo, "archive", "--format=tar", "--output", join(root, "tree.tar"), commit]);
  execFileSync("tar", ["-xf", join(root, "tree.tar"), "-C", staging]);
  const releaseRoot = realpathSync(await promoteStaging({ commit, env, version: "0.1.0", build: BUILD }));
  return { root, repo, commit, env, releaseRoot, build: BUILD };
}

/** The signed artifact: an ordinary file with ordinary bytes. */
function signedArtifact(root, name = "BotFleet.app.zip", text = "signed artifact bytes") {
  const path = join(root, name);
  writeFileSync(path, Buffer.from(text));
  return path;
}

test("a proof record and a hold marker live outside the promoted tree, and the tree does not move", async (t) => {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
    signedArtifactProvenance: { commit: fixture.commit, build: fixture.build },
  });
  assert.equal(inspected.status, "probe-required", JSON.stringify(inspected.blockers));

  const before = hashDependencyTree(fixture.releaseRoot);
  const beforeListing = readdirSync(fixture.releaseRoot).sort();

  const written = await writeReleaseProof({
    commit: fixture.commit,
    env: fixture.env,
    artifact: inspected.binding.signedArtifact,
    provenance: { commit: fixture.commit, build: fixture.build },
    tree: { fingerprint: inspected.binding.tree.fingerprint },
    runtime: inspected.binding.runtime,
    teardown: { exited: true, groupGone: true, portsClosed: true },
  });
  const held = await holdRelease({ commit: fixture.commit, env: fixture.env });

  // Both records are the STORE's own, beside `releases/` and never inside one.
  const storeRoot = fixture.env.BOTFLEET_RELEASES_ROOT;
  assert.ok(written.path.startsWith(join(storeRoot, "proofs")), written.path);
  assert.ok(held.path.startsWith(join(storeRoot, "holds")), held.path);
  assert.ok(!written.path.startsWith(fixture.releaseRoot), "the proof record must not be inside the promoted tree");
  assert.ok(!held.path.startsWith(fixture.releaseRoot), "the hold marker must not be inside the promoted tree");

  // The promoted tree is byte-identical to what was promoted.  A record
  // written inside it would change the very bytes a proof is about, and the
  // proof could never be re-verified.
  const after = hashDependencyTree(fixture.releaseRoot);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(readdirSync(fixture.releaseRoot).sort(), beforeListing);
});

test("the hold keeps an aged, non-live candidate beyond the keep budget", async (t) => {
  const { env } = await store(t);
  for (const commit of [A, B, C, D]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env, build: BUILD });
  }
  await swapCurrent({ commit: D, env });
  const now = Date.now() + 7 * 24 * 60 * 60 * 1000;

  // A is the oldest non-live release, so it is the only candidate once the two
  // newest non-live releases are kept as the previous generations.
  await holdRelease({ commit: A, env });
  const held = await pruneReleases({ env, keep: 2, minAgeMs: 24 * 60 * 60 * 1000, now, isHeldImpl: async () => false });
  assert.deepEqual(held.removed, [], "a held candidate is never a deletion");
  assert.ok(held.kept.some((entry) => entry.commit === A && entry.reason === "held-by-marker"), JSON.stringify(held.kept));
  assert.deepEqual(await listReleases(env), [A, B, C, D]);

  // The hold is a pause, not an exemption: once it is cleared the same tree is
  // pruned like any other.
  assert.equal(await releaseHold({ commit: A, env }), true);
  const released = await pruneReleases({ env, keep: 2, minAgeMs: 0, now, isHeldImpl: async () => false });
  assert.deepEqual(released.removed, [A]);
  assert.deepEqual(await listReleases(env), [B, C, D]);
});

test("a hold that arrives while the liveness probe runs still saves the release", async (t) => {
  const { env } = await store(t);
  for (const commit of [A, B, C, D]) {
    await stage(env, commit, commit);
    await promoteStaging({ commit, env, build: BUILD });
  }
  await swapCurrent({ commit: D, env });
  const now = Date.now() + 7 * 24 * 60 * 60 * 1000;

  // The hold arrives DURING the liveness probe: the probe answers "nothing is
  // running from it", and the marker lands in the same window.  A prune that
  // can lose a hold is not a prune that keeps what it was told to keep.
  const result = await pruneReleases({
    env,
    keep: 0,
    minAgeMs: 0,
    now,
    isHeldImpl: async () => {
      await holdRelease({ commit: A, env });
      return false;
    },
  });
  assert.ok(!result.removed.includes(A), "the held candidate must survive the race");
  assert.ok(result.kept.some((entry) => entry.commit === A && entry.reason === "held-by-marker"), JSON.stringify(result.kept));
});

test("the artifact digest, the tree fingerprint and the runtime digest are three records", async (t) => {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
    signedArtifactProvenance: { commit: fixture.commit, build: fixture.build },
  });
  assert.equal(inspected.status, "probe-required", JSON.stringify(inspected.blockers));

  const written = await writeReleaseProof({
    commit: fixture.commit,
    env: fixture.env,
    artifact: inspected.binding.signedArtifact,
    provenance: { commit: fixture.commit, build: fixture.build },
    tree: { fingerprint: inspected.binding.tree.fingerprint },
    runtime: inspected.binding.runtime,
    teardown: { exited: true, groupGone: true, portsClosed: true },
  });
  const proof = written.record;
  assert.equal(proof.artifact.sha256, inspected.binding.signedArtifact.sha256);
  assert.equal(proof.tree.fingerprint, inspected.binding.tree.fingerprint);
  assert.equal(proof.runtime.sha256, inspected.binding.runtime.sha256);
  assert.notEqual(proof.tree.fingerprint, proof.artifact.sha256, "the tree fingerprint is never the artifact digest");
  assert.notEqual(proof.runtime.sha256, proof.artifact.sha256, "the runtime digest is never the artifact digest");
});

test("a candidate whose artifact does not hash to the expected digest is refused by name", async (t) => {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
    signedArtifactSha256: "0".repeat(64),
    signedArtifactProvenance: { commit: fixture.commit, build: fixture.build },
  });
  assert.equal(inspected.status, "blocked");
  assert.ok(inspected.blockers.some((entry) => entry.code === "signed-artifact-digest-mismatch"), JSON.stringify(inspected.blockers));
});

test("a candidate that names a signed artifact without provenance is refused", async (t) => {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
  });
  assert.equal(inspected.status, "blocked");
  assert.ok(inspected.blockers.some((entry) => entry.code === "artifact-provenance-missing"), JSON.stringify(inspected.blockers));
});

test("a candidate whose artifact was produced from another commit is refused", async (t) => {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
    signedArtifactProvenance: { commit: B, build: fixture.build },
  });
  assert.equal(inspected.status, "blocked");
  assert.ok(inspected.blockers.some((entry) => entry.code === "artifact-commit-mismatch"), JSON.stringify(inspected.blockers));
});

test("a candidate whose artifact was produced from another build of this commit is refused", async (t) => {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
    signedArtifactProvenance: { commit: fixture.commit, build: "202601010000" },
  });
  assert.equal(inspected.status, "blocked");
  assert.ok(inspected.blockers.some((entry) => entry.code === "artifact-build-mismatch"), JSON.stringify(inspected.blockers));
});

/** A candidate with a proof record and a hold, ready to be rechecked. */
async function proved(t) {
  const fixture = await makeCandidate(t);
  const artifact = signedArtifact(fixture.root);
  const inspected = await inspectPlacementRollbackCandidate({
    kind: "release-store",
    releaseRoot: fixture.releaseRoot,
    sourceCommit: fixture.commit,
    sourceRepo: fixture.repo,
    runtimePath: NODE,
    signedArtifact: artifact,
    signedArtifactProvenance: { commit: fixture.commit, build: fixture.build },
  });
  assert.equal(inspected.status, "probe-required", JSON.stringify(inspected.blockers));
  await writeReleaseProof({
    commit: fixture.commit,
    env: fixture.env,
    artifact: inspected.binding.signedArtifact,
    provenance: { commit: fixture.commit, build: fixture.build },
    tree: { fingerprint: inspected.binding.tree.fingerprint },
    runtime: inspected.binding.runtime,
    teardown: { exited: true, groupGone: true, portsClosed: true },
  });
  await holdRelease({ commit: fixture.commit, env: fixture.env });
  return { ...fixture, artifact };
}

test("the recheck answers still-valid right after a proof and a hold", async (t) => {
  const fixture = await proved(t);
  const recheck = await recheckPlacementRollbackCandidate({ releaseRoot: fixture.releaseRoot });
  assert.equal(recheck.valid, true, JSON.stringify(recheck.reasons));
  assert.equal(recheck.status, "still-valid");
  assert.equal(recheck.observed.hold, true);
  assert.ok(recheck.proof, "the recheck reports the proof it re-verified");
});

test("the recheck names the reason when the signed artifact's bytes change", async (t) => {
  const fixture = await proved(t);
  writeFileSync(fixture.artifact, Buffer.from("different bytes entirely"));
  const recheck = await recheckPlacementRollbackCandidate({ releaseRoot: fixture.releaseRoot });
  assert.equal(recheck.valid, false);
  assert.ok(recheck.reasons.some((entry) => entry.code === "signed-artifact-changed"), JSON.stringify(recheck.reasons));
});

test("the recheck names the reason when the hold is cleared", async (t) => {
  const fixture = await proved(t);
  assert.equal(await releaseHold({ commit: fixture.commit, env: fixture.env }), true);
  const recheck = await recheckPlacementRollbackCandidate({ releaseRoot: fixture.releaseRoot });
  assert.equal(recheck.valid, false);
  assert.ok(recheck.reasons.some((entry) => entry.code === "hold-marker-missing"), JSON.stringify(recheck.reasons));
});

test("the recheck names the reason when the release tree changes", async (t) => {
  const fixture = await proved(t);
  chmodSync(fixture.releaseRoot, 0o755);
  writeFileSync(join(fixture.releaseRoot, "extra.txt"), "a file the commit never had\n");
  const recheck = await recheckPlacementRollbackCandidate({ releaseRoot: fixture.releaseRoot });
  assert.equal(recheck.valid, false);
  assert.ok(recheck.reasons.some((entry) => entry.code === "tree-fingerprint-changed"), JSON.stringify(recheck.reasons));
});

test("the recheck of a release with no proof names the reason", async (t) => {
  const fixture = await makeCandidate(t);
  const recheck = await recheckPlacementRollbackCandidate({ releaseRoot: fixture.releaseRoot });
  assert.equal(recheck.valid, false);
  assert.ok(recheck.reasons.some((entry) => entry.code === "release-proof-missing"), JSON.stringify(recheck.reasons));
});

test("a hold marker is the store's own record and never a file inside a release", async (t) => {
  const { env } = await store(t);
  await stage(env, A, "payload");
  await promoteStaging({ commit: A, env, build: BUILD });
  const held = await holdRelease({ commit: A, env });
  assert.equal(await isReleaseHeld(A, env), true);
  assert.ok(held.path.startsWith(join(env.BOTFLEET_RELEASES_ROOT, "holds")));
  assert.ok(!held.path.startsWith(join(env.BOTFLEET_RELEASES_ROOT, "releases")));
  assert.ok(!readdirSync(join(env.BOTFLEET_RELEASES_ROOT, "releases", A)).includes("hold.json"));
  assert.equal(releaseProofPath(A, env).startsWith(join(env.BOTFLEET_RELEASES_ROOT, "releases")), false);
});
