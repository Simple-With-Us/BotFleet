import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_EVIDENCE, REQUIRED_ISSUES } from "./check-decommission-gates.mjs";
import { collectEvidenceBundle } from "./collect-decommission-evidence.mjs";
import { checkFinalEvidenceBundle, evidenceHash, MAX_EVIDENCE_FILE_BYTES, REQUIRED_CHECKS, REQUIRED_RECEIPTS, REQUIRED_SURFACES } from "./decommission-evidence-bundle.mjs";
import { HAND_RUN_PLACEMENT_EVIDENCE, REQUIRED_PLACEMENT_EVIDENCE } from "./check-placement-evidence.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = { sourceSha: "a".repeat(40), build: "202610010900", artifactSha256: "b".repeat(64) };
const hosts = [{ id: "mac:00000000-0000-4000-8000-000000000001", role: "mac" }, { id: "server:00000000-0000-4000-8000-000000000002", role: "server" }];
const onPosix = { skip: process.platform === "win32" ? "Private POSIX ownership cannot be proved on Windows" : false };

// Every accepted assertion below is deliberately synthetic, local to this
// test's private temporary directory, and never emitted as production proof.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bf-final-evidence-"));
  const put = (path, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, path), bytes, { mode: 0o600 });
    return { path, sha256: evidenceHash(bytes) };
  };
  const state = {
    issues: Object.fromEntries(REQUIRED_ISSUES.map(({ id }) => [id, "Done"])),
    evidence: Object.fromEntries(REQUIRED_EVIDENCE.map(({ id }) => [id, true])),
    macLocalHarness: { present: false, retained: { "deploy/linux-server/": "fixture retained Linux deployment" } },
  };
  const log = put("synthetic.log", Buffer.from("SYNTHETIC FIXTURE ONLY: this is not an owner statement or a runtime result\n"));
  const bundle = {
    version: 1, candidate, hosts, mode: "serverFirst", acceptanceOwner: "synthetic fixture owner", engines: ["fixture-engine"],
    state: put("state.json", state), receipts: {},
  };
  const receipts = {};
  const saveReceipt = (kind, receipt) => { receipts[kind] = receipt; bundle.receipts[kind] = put(`${kind}.json`, receipt); };
  for (const kind of REQUIRED_RECEIPTS) {
    let data;
    if (kind === "placement") {
      const run = put("placement/run.log", Buffer.from("SYNTHETIC PLACEMENT RUN\n"));
      const mac = put("placement/mac.json", { synthetic: true });
      const server = put("placement/server.json", { synthetic: true });
      const manifest = put("placement/manifest.json", {
        evidence: Object.fromEntries(REQUIRED_PLACEMENT_EVIDENCE.map((key) => [key, true])),
        handRun: Object.fromEntries(HAND_RUN_PLACEMENT_EVIDENCE.map((key) => [key, { at: "2026-10-01 9:00 AM", by: "synthetic fixture runner", log: "run.log" }])),
        inventory: { mac: "mac.json", server: "server.json" },
      });
      data = { manifest, artifacts: [run, mac, server] };
    } else if (["server-writer-soak", "no-mac-node-soak", "daily-driver"].includes(kind)) {
      const index = { "server-writer-soak": 1, "no-mac-node-soak": 2, "daily-driver": 3 }[kind];
      const startedAt = `2026-10-0${index}T00:00:00Z`;
      const endedAt = kind === "daily-driver" ? "2026-10-10T00:00:00Z" : `2026-10-0${index + 1}T00:00:00Z`;
      const segment = {
        startedAt, endedAt, log, continuity: "uninterrupted",
        selectedWriterHostId: hosts[1].id, controllerId: hosts[1].id, controllerEpoch: 3,
      };
      if (kind === "daily-driver") Object.assign(segment, { nativeApp: "signed-native-daily-driver", iosSession: "passed", openOnMac: "passed", processInventory: "recorded" });
      else Object.assign(segment, { macHarness: kind === "server-writer-soak" ? "loaded-unused" : "absent", surfaces: Object.fromEntries(REQUIRED_SURFACES.map((key) => [key, "passed"])) });
      if (kind === "server-writer-soak") Object.assign(segment, { inboundMessages: 1, serverSharedRoutineRuns: 1, macSharedRoutineRuns: 0 });
      data = { startedAt, endedAt, segments: [segment] };
    } else if (kind === "owner-acceptance") {
      data = { decision: "accepted", action: "delete-mac-local-node-source", dailyDriverAccepted: true };
    } else {
      const names = kind === "replay" ? ["engine:fixture-engine"] : REQUIRED_CHECKS[kind];
      data = { checks: names.map((name) => ({ name, exitCode: 0, artifact: log })) };
      if (kind === "signed-release") Object.assign(data, { bundleId: "app.botfleet.macos", teamId: "FIXTURE", designatedRequirement: "synthetic fixture requirement", previousBuild: "202609300900" });
      if (kind === "linux-retention") Object.assign(data, { maintainedSourceSha: candidate.sourceSha, rollbackSourceSha: "c".repeat(40), closureManifest: log });
      if (kind === "process-inventory") data.macHarness = "absent";
      if (kind === "change-plan") Object.assign(data, { jobs: ["fixture retirement job"], files: ["fixture deletion diff"], appCopies: ["fixture app replacement"] });
    }
    saveReceipt(kind, {
      version: 1, kind, candidate: structuredClone(candidate), mode: bundle.mode, hosts: structuredClone(hosts),
      provenance: { by: kind === "owner-acceptance" ? bundle.acceptanceOwner : "synthetic fixture runner", at: "2026-10-11T00:00:00Z", source: "https://example.invalid/synthetic-test-only", record: log }, data,
    });
  }
  const saveBundle = () => put("bundle.json", bundle);
  saveBundle();
  const check = (expected = candidate) => { saveBundle(); return checkFinalEvidenceBundle(join(root, "bundle.json"), { statePath: join(root, "state.json"), stateBytes: readFileSync(join(root, "state.json")), candidate: expected }); };
  const cli = (extra = []) => { saveBundle(); return spawnSync(process.execPath, [join(repo, "scripts/check-decommission-gates.mjs"), join(root, "state.json"), "--bundle", join(root, "bundle.json"), "--source-sha", candidate.sourceSha, "--build", candidate.build, "--artifact-sha256", candidate.artifactSha256, ...extra], { encoding: "utf8", timeout: 10_000 }); };
  return { root, put, bundle, receipts, saveReceipt, saveBundle, check, cli, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("the deletion CLI requires a complete bound packet and reports its limited proof", onPosix, () => {
  const f = fixture();
  try {
    assert.equal(f.check().ok, true);
    const result = f.cli();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /does not authenticate receipts or establish their truth/);
    assert.match(result.stdout, /Retained on purpose: deploy\/linux-server\//);
    assert.match(result.stdout, /Depends on the stack being deleted: mac-control\//);
    delete f.bundle.receipts.rollback;
    const blocked = f.cli();
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /rollback: missing-receipt/);
    assert.equal(f.cli(["--unknown", "x"]).status, 2);
  } finally { f.close(); }
});

test("missing, malformed, tampered and cross-candidate captures fail deterministically", onPosix, () => {
  for (const fault of ["missing", "malformed", "hash", "source", "build", "artifact", "mode", "host", "result", "provenance"]) {
    const f = fixture();
    try {
      const receipt = f.receipts.import;
      if (fault === "missing") unlinkSync(join(f.root, "import.json"));
      if (fault === "malformed") f.bundle.receipts.import = f.put("import.json", Buffer.from("malformed private input"));
      if (fault === "hash") f.put("import.json", { tampered: true });
      if (fault === "source") receipt.candidate.sourceSha = "d".repeat(40);
      if (fault === "build") receipt.candidate.build = "202610020900";
      if (fault === "artifact") receipt.candidate.artifactSha256 = "d".repeat(64);
      if (fault === "mode") receipt.mode = "macFirst";
      if (fault === "host") receipt.hosts[1].id = "server:00000000-0000-4000-8000-000000000003";
      if (fault === "result") receipt.data.checks[0].exitCode = 1;
      if (fault === "provenance") delete receipt.provenance.record;
      if (!["missing", "malformed", "hash"].includes(fault)) f.saveReceipt("import", receipt);
      assert.equal(f.check().ok, false, fault);
      assert.equal(f.cli().status, 1, fault);
      assert.equal(f.check().ok, false, "the same bytes must refuse again");
    } finally { f.close(); }
  }
  const f = fixture();
  try { assert.deepEqual(f.check({ ...candidate, sourceSha: "e".repeat(40) }).blockers, ["bundle: candidate-mismatch"]); }
  finally { f.close(); }
});

test("the actual placement artifact validator blocks all sixteen unasserted recipes", onPosix, () => {
  const f = fixture();
  try {
    const current = readFileSync(join(repo, "docs/verification/placement-evidence.json"));
    const receipt = f.receipts.placement;
    receipt.data.manifest = f.put("placement/manifest.json", current);
    f.saveReceipt("placement", receipt);
    const verdict = f.check();
    assert.equal(verdict.ok, false);
    for (const key of REQUIRED_PLACEMENT_EVIDENCE) assert.ok(verdict.blockers.includes(`placement: evidence ${key}: not asserted`));
    assert.equal(f.cli().status, 1);
    assert.ok(Object.values(JSON.parse(current).evidence).every((value) => value === false));
  } finally { f.close(); }
});

test("elapsed wall time alone cannot replace continuous, correctly ordered observation intervals", onPosix, () => {
  for (const fault of ["short", "gap", "overlap", "wrong-phase", "missing-surface", "unlogged", "writer", "order", "daily-driver", "owner", "owner-before-evidence", "future"]) {
    const f = fixture();
    try {
      const kind = fault === "daily-driver" ? "daily-driver" : fault.startsWith("owner") ? "owner-acceptance" : "no-mac-node-soak";
      const receipt = f.receipts[kind];
      if (fault === "short") receipt.data.endedAt = receipt.data.segments[0].endedAt = "2026-10-02T23:59:59Z";
      if (fault === "gap") receipt.data.segments[0].startedAt = "2026-10-02T00:00:01Z";
      if (fault === "overlap") receipt.data.segments.push(structuredClone(receipt.data.segments[0]));
      if (fault === "wrong-phase") receipt.data.segments[0].macHarness = "loaded-unused";
      if (fault === "missing-surface") delete receipt.data.segments[0].surfaces.webhooks;
      if (fault === "unlogged") receipt.data.segments[0].log = { path: "missing.log", sha256: "a".repeat(64) };
      if (fault === "writer") receipt.data.segments[0].selectedWriterHostId = "mac:00000000-0000-4000-8000-000000000099";
      if (fault === "order") receipt.data.startedAt = receipt.data.segments[0].startedAt = "2026-10-01T12:00:00Z";
      if (fault === "daily-driver") receipt.data.endedAt = receipt.data.segments[0].endedAt = "2026-10-09T23:59:59Z";
      if (fault === "owner") receipt.provenance.by = "fixture runner is not the owner";
      if (fault === "owner-before-evidence") receipt.provenance.at = "2026-10-01T00:00:00Z";
      if (fault === "future") receipt.provenance.at = "2999-10-11T00:00:00Z";
      f.saveReceipt(kind, receipt);
      assert.equal(f.check().ok, false, fault);
      assert.notEqual(f.cli().status, 0, fault);
    } finally { f.close(); }
  }
});

test("private bundle reads reject escaped, linked, shared and oversized artifacts", onPosix, () => {
  for (const fault of ["traversal", "absolute", "symlink", "directory-link", "hardlink", "oversize", "public-file", "public-root"]) {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "bf-external-evidence-"));
    try {
      const receipt = f.receipts.import;
      const file = join(f.root, "synthetic.log");
      const external = join(outside, "external.log");
      writeFileSync(external, "private external fixture", { mode: 0o600 });
      if (fault === "traversal") receipt.data.checks[0].artifact.path = "../external.log";
      if (fault === "absolute") receipt.data.checks[0].artifact.path = external;
      if (fault === "symlink") { unlinkSync(file); symlinkSync(external, file); }
      if (fault === "directory-link") { symlinkSync(outside, join(f.root, "linked")); receipt.data.checks[0].artifact.path = "linked/external.log"; }
      if (fault === "hardlink") { unlinkSync(file); linkSync(external, file); }
      if (fault === "oversize") writeFileSync(file, Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1));
      if (fault === "public-file") chmodSync(file, 0o644);
      if (fault === "public-root") chmodSync(f.root, 0o755);
      f.saveReceipt("import", receipt);
      assert.equal(f.check().ok, false, fault);
      assert.notEqual(f.cli().status, 0, fault);
    } finally { f.close(); rmSync(outside, { recursive: true, force: true }); }
  }
});

test("coverage rejects controller epoch regression and unfenced handoff while allowing an advanced handoff", onPosix, () => {
  for (const transition of ["regression", "unadvanced-handoff", "unknown-controller", "advanced-handoff"]) {
    const f = fixture();
    try {
      const receipt = f.receipts["no-mac-node-soak"];
      const first = receipt.data.segments[0];
      first.endedAt = "2026-10-02T12:00:00Z";
      first.controllerEpoch = 5;
      const next = { ...structuredClone(first), startedAt: first.endedAt, endedAt: receipt.data.endedAt };
      if (transition === "regression") next.controllerEpoch = 3;
      else { next.controllerId = hosts[0].id; next.controllerEpoch = transition === "advanced-handoff" ? 6 : 5; }
      if (transition === "unknown-controller") next.controllerId = "mac:00000000-0000-4000-8000-000000000099";
      receipt.data.segments.push(next);
      f.saveReceipt("no-mac-node-soak", receipt);
      assert.equal(f.check().ok, transition === "advanced-handoff", transition);
      assert.equal(f.cli().status, transition === "advanced-handoff" ? 0 : 1, transition);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const receipt = f.receipts["no-mac-node-soak"];
    receipt.data.segments[0].controllerEpoch = 2;
    f.saveReceipt("no-mac-node-soak", receipt);
    assert.ok(f.check().blockers.includes("soaks: controller-fence-regressed-or-unadvanced-handoff"));
  } finally { f.close(); }
});

test("seven-day native daily use permits a local-only Mac controller without server traffic assertions", onPosix, () => {
  const f = fixture();
  try {
    f.bundle.mode = "localOnly";
    for (const kind of REQUIRED_RECEIPTS) {
      const receipt = f.receipts[kind];
      receipt.mode = "localOnly";
      if (kind === "daily-driver") {
        receipt.data.segments[0].selectedWriterHostId = hosts[0].id;
        receipt.data.segments[0].controllerId = hosts[0].id;
      }
      f.saveReceipt(kind, receipt);
    }
    assert.equal(f.check().ok, true);
    assert.equal(f.cli().status, 0);
    const data = f.receipts["daily-driver"].data.segments[0];
    assert.equal(data.inboundMessages, undefined);
    assert.equal(data.macSharedRoutineRuns, undefined);
  } finally { f.close(); }
});

test("injected read-only collectors bind captures and refuse unredacted input", onPosix, async () => {
  const f = fixture();
  try {
    const request = { ...f.bundle, receipts: {} };
    let calls = 0;
    const readCapturedFile = (path) => readFileSync(join(f.root, path));
    const packet = await collectEvidenceBundle(request, { readCapturedFile, readers: { import: async (identity) => {
      calls += 1;
      assert.deepEqual(identity.candidate, candidate);
      return { receipt: readCapturedFile("import.json"), files: new Map([["synthetic.log", readCapturedFile("synthetic.log")]]) };
    } } });
    assert.equal(calls, 1);
    assert.ok(packet.bundle.receipts.import);
    assert.equal(packet.bundle.receipts["owner-acceptance"], undefined);
    assert.equal(packet.files.size, 3);
    const privateLog = Buffer.from("Authorization: Bearer SYNTHETIC_PRIVATE_VALUE_123456789\n");
    const receipt = structuredClone(f.receipts.import);
    const reference = { path: "synthetic.log", sha256: evidenceHash(privateLog) };
    receipt.provenance.record = reference;
    for (const check of receipt.data.checks) check.artifact = reference;
    await assert.rejects(collectEvidenceBundle(request, { readCapturedFile, readers: { import: async () => ({ receipt: Buffer.from(JSON.stringify(receipt)), files: new Map([["synthetic.log", privateLog]]) }) } }), /redacted UTF-8/);
  } finally { f.close(); }
});

test("collector defaults to a blocked read-only packet and never creates owner acceptance", onPosix, async () => {
  const f = fixture();
  try {
    const request = { ...f.bundle, receipts: {} };
    f.put("request.json", request);
    const packet = await collectEvidenceBundle(request, { readCapturedFile: (path) => readFileSync(join(f.root, path)) });
    assert.deepEqual(packet.missing, REQUIRED_RECEIPTS);
    assert.equal(packet.files.size, 1);
    assert.equal(packet.bundle.receipts["owner-acceptance"], undefined);
    await assert.rejects(collectEvidenceBundle(request, { readCapturedFile: () => { throw new Error("unexpected read"); }, readers: { "owner-acceptance": async () => { throw new Error("must not run"); } } }), /No collector may synthesize owner acceptance/);
    const preview = spawnSync(process.execPath, [join(repo, "scripts/collect-decommission-evidence.mjs"), join(f.root, "request.json")], { encoding: "utf8", timeout: 10_000 });
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).written, false);
    assert.equal(JSON.parse(preview.stdout).ownerAcceptance, "missing");
    const output = join(f.root, "prepared");
    const written = spawnSync(process.execPath, [join(repo, "scripts/collect-decommission-evidence.mjs"), join(f.root, "request.json"), "--out", output], { encoding: "utf8", timeout: 10_000 });
    assert.equal(written.status, 0, written.stderr);
    assert.ok(existsSync(join(output, "bundle.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(output, "bundle.json"))).receipts, {});
    assert.ok(Object.values(JSON.parse(readFileSync(join(repo, "docs/verification/placement-evidence.json"))).evidence).every((value) => value === false));
  } finally { f.close(); }
});
