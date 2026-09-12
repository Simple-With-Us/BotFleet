import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizedRuntime, buildCompatibility, hashStaticUi, readPackagedBuildIdentity, readSourceBuildIdentity } from "./runtime-identity.mjs";
import { harnessOwnerProof } from "./harness-ownership.mjs";
import { probeHarness, resolvePackagedServer } from "./server-boot-probe.mjs";

const build = { app: "botfleet", sourceCommit: "a".repeat(40), sourceDirty: false, apiVersion: 1, version: "1.0.30", uiHash: "e".repeat(64) };
const owner = { version: 1, pid: 4242, port: 8799, nonce: "b".repeat(64) };

test("runtime diagnostics require the private nonce and never accept the public health proof", () => {
  assert.equal(authorizedRuntime(owner, `Bearer ${owner.nonce}`), true);
  for (const header of [undefined, "Bearer bad", `Bearer ${"c".repeat(64)}`, `Bearer ${harnessOwnerProof(owner, "d".repeat(64))}`]) {
    assert.equal(authorizedRuntime(owner, header), false);
  }
});

test("build/API compatibility uses bundled UI for changed or dirty source and rejects unknown API", () => {
  assert.equal(buildCompatibility(build, build), "matching");
  assert.equal(buildCompatibility(build, { ...build, sourceCommit: "c".repeat(40) }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, sourceDirty: true }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, uiHash: "f".repeat(64) }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, uiHash: null }), "bundled-ui");
  assert.equal(buildCompatibility(build, { ...build, apiVersion: 2 }), "incompatible");
  assert.equal(buildCompatibility(build, { ...build, sourceCommit: null }), "incompatible");
});

test("static identity changes when an asset changes even if index.html does not", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-ui-identity-"));
  try {
    assert.equal(hashStaticUi(root), null);
    writeFileSync(join(root, "index.html"), '<script src="app.js"></script>');
    writeFileSync(join(root, "app.js"), "one");
    const before = hashStaticUi(root);
    writeFileSync(join(root, "app.js"), "two");
    assert.notEqual(hashStaticUi(root), before);
    assert.equal(hashStaticUi(root), hashStaticUi(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source identity stays pinned after the checkout advances; packaged identity requires its own manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-build-identity-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.30" }));
    git("add", "."); git("commit", "-m", "initial");
    const pinned = readSourceBuildIdentity(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.31" }));
    assert.equal(readSourceBuildIdentity(root).sourceDirty, true);
    git("add", "."); git("commit", "-m", "next");
    assert.notEqual(readSourceBuildIdentity(root).sourceCommit, pinned.sourceCommit);
    assert.equal(pinned.version, "1.0.30");
    mkdirSync(join(root, "server"));
    assert.throws(() => readPackagedBuildIdentity(join(root, "server")));
    writeFileSync(join(root, "server", "build-identity.json"), JSON.stringify(pinned));
    assert.deepEqual(readPackagedBuildIdentity(join(root, "server")), pinned);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeFetch(runtime, { proof = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    if (url.endsWith("/api/health")) return { ok: true, json: async () => ({
      app: "botfleet", pid: owner.pid, static: true,
      ownerProof: proof ? harnessOwnerProof(owner, options.headers["x-botfleet-owner-challenge"]) : null,
    }) };
    assert.equal(options.headers.authorization, `Bearer ${owner.nonce}`);
    assert.equal(options.signal, calls[0].options.signal, "both requests share the same deadline");
    return { ok: status === 200, json: async () => runtime };
  };
  return { fetchImpl, calls };
}
const runtime = (patch = {}) => ({ ...build, pid: owner.pid, dataOwner: { pid: owner.pid, port: owner.port }, ...patch });

test("authenticated matching static build attaches; changed compatible build serves bundled UI", async () => {
  for (const changed of [false, true]) {
    const remote = runtime(changed ? { sourceCommit: "c".repeat(40) } : {});
    const fake = fakeFetch(remote);
    const result = await probeHarness({ port: owner.port, owner, expectedBuild: build, fetchImpl: fake.fetchImpl });
    assert.equal(result.kind, "botfleet");
    assert.equal(result.static, !changed);
    assert.equal(result.sourceCommit, remote.sourceCommit);
  }
});

test("wrong health proof never receives the private nonce", async () => {
  const fake = fakeFetch(runtime(), { proof: false });
  assert.equal((await probeHarness({ port: owner.port, owner, expectedBuild: build, fetchImpl: fake.fetchImpl })).kind, "unavailable");
  assert.equal(fake.calls.length, 1);
});

test("legacy/malformed/wrong-owner/incompatible runtime never permits another harness spawn", async () => {
  for (const [data, status] of [[runtime(), 404], [null, 200], [runtime({ pid: 999 }), 200], [runtime({ apiVersion: 2 }), 200]]) {
    const fake = fakeFetch(data, { status });
    const result = await resolvePackagedServer({
      ports: [8799, 18799], owner: () => owner, attempts: 1, attachSettleMs: 0,
      probe: (port, currentOwner) => probeHarness({ port, owner: currentOwner, expectedBuild: build, fetchImpl: fake.fetchImpl }),
      spawn: async () => { assert.fail("incompatible live owner must never permit a second process"); },
    });
    assert.equal(result.mode, "failed");
  }
});
