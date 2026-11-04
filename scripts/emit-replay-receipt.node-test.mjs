// Fixtures for the `replay` receipt.
//
// The properties under test are the ones the bundle's authority rests on:  a
// check's exit code comes out of the report the check names, an engine the
// report does not cover is never a pass, and the receipt is the shape
// `scripts/decommission-evidence-bundle.mjs` validates.  Each of those has a
// fixture that fails against a broken implementation, so a regression is a
// red test rather than a receipt that certifies a replay nobody ran.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitReplayReceipt, readReplayReport, replayVerdict } from "./emit-replay-receipt.mjs";
import { assertReceiptBinding, parseEvidenceReceipt } from "./decommission-evidence-bundle.mjs";

/** A request the receipt is bound to. */
function makeRequest(engines = ["claude", "grok-acp"]) {
  return {
    version: 1,
    candidate: { sourceSha: "a".repeat(40), build: "202611040715", artifactSha256: "b".repeat(64) },
    mode: "serverFirst",
    hosts: [
      { id: `mac:${"1".repeat(8)}-${"2".repeat(4)}-${"3".repeat(4)}-${"4".repeat(4)}-${"5".repeat(12)}`, role: "mac" },
      { id: `server:${"6".repeat(8)}-${"7".repeat(4)}-${"8".repeat(4)}-${"9".repeat(4)}-${"a".repeat(12)}`, role: "server" },
    ],
    acceptanceOwner: "Jay Wedgeworth",
    engines,
    state: { path: "state.json", sha256: "c".repeat(64) },
    receipts: {},
  };
}

/** A replay report the probe would have written. */
function makeReport(engines) {
  return {
    version: 1,
    requestedEngines: engines.map((entry) => entry.engineId),
    isFullyVerified: engines.every((entry) => entry.isFullyVerified),
    engines,
  };
}

/** A private capture directory holding a report and a provenance record. */
function makeCapture(report) {
  const captureDir = mkdtempSync(join(tmpdir(), "replay-capture-"));
  writeFileSync(join(captureDir, "replay-parity.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(captureDir, "provenance.txt"), "the replay ran on the Mac\n", { mode: 0o600 });
  return captureDir;
}

const PROVENANCE = {
  by: "Jay Wedgeworth",
  at: "2026-11-04T05:15:00.000Z",
  source: "https://simplewithus.zulipchat.com/#narrow/stream/agents",
};

test("a report that says every engine held earns a passing check per engine", () => {
  const request = makeRequest();
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
    { engineId: "grok-acp", family: "grok", measured: true, isFullyVerified: true, fixtureCount: 27, passedCount: 27 },
  ]));

  const receipt = emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  });

  assert.equal(receipt.kind, "replay");
  assert.deepEqual(receipt.data.checks.map((check) => check.name), ["engine:claude", "engine:grok-acp"]);
  assert.deepEqual(receipt.data.checks.map((check) => check.exitCode), [0, 0]);

  // The receipt is the shape the bundle validates, and it is bound to the
  // same candidate as the request.
  const parsed = parseEvidenceReceipt("replay", readFileSync(join(captureDir, "replay.receipt.json")));
  assert.doesNotThrow(() => assertReceiptBinding(parsed, request));
  assert.equal(parsed.provenance.record.path, "provenance.txt");
});

test("the exit code is read out of the report the check names, not asserted", () => {
  const request = makeRequest(["claude"]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: false, fixtureCount: 20, passedCount: 19 },
  ]));

  const receipt = emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  });

  assert.equal(receipt.data.checks[0].exitCode, 1);
  // The artifact the check names is the report, bound by hash.
  assert.equal(receipt.data.checks[0].artifact.path, "replay-parity.json");
  assert.match(receipt.data.checks[0].artifact.sha256, /^[0-9a-f]{64}$/);
});

test("an engine the report never covered earns a failing code, never a passing one", () => {
  const request = makeRequest(["claude", "cursor"]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ]));

  const receipt = emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  });

  assert.deepEqual(receipt.data.checks.map((check) => check.name), ["engine:claude", "engine:cursor"]);
  assert.deepEqual(receipt.data.checks.map((check) => check.exitCode), [0, 1]);
});

test("an engine the probe could not measure earns a failing code", () => {
  const report = makeReport([
    { engineId: "opencode", family: null, measured: false, unmeasuredReason: "no replay family drives this engine", isFullyVerified: false, fixtureCount: 0, passedCount: 0 },
  ]);
  assert.equal(replayVerdict(report, "opencode"), false);
});

test("a report that cannot be read is refused rather than turned into a verdict", () => {
  assert.throws(() => readReplayReport("/nonexistent/replay-parity.json"), /could not be read as JSON/);
});

test("a report with no engines list is refused", () => {
  const captureDir = mkdtempSync(join(tmpdir(), "replay-capture-"));
  writeFileSync(join(captureDir, "replay-parity.json"), JSON.stringify({ version: 1 }), { mode: 0o600 });
  assert.throws(() => readReplayReport(join(captureDir, "replay-parity.json")), /no `engines` list/);
});

test("a report whose engine entry names no verdict is refused", () => {
  const captureDir = mkdtempSync(join(tmpdir(), "replay-capture-"));
  writeFileSync(join(captureDir, "replay-parity.json"), JSON.stringify({ version: 1, engines: [{ engineId: "claude" }] }), { mode: 0o600 });
  assert.throws(() => readReplayReport(join(captureDir, "replay-parity.json")), /names no verdict/);
});

test("a capture directory other people can read is refused", () => {
  const request = makeRequest(["claude"]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ]));
  chmodSync(captureDir, 0o755);

  assert.throws(() => emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  }), /not private/);
});

test("a receipt whose provenance source is not an https URL is refused", () => {
  const request = makeRequest(["claude"]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ]));

  assert.throws(() => emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, source: "http://example.com/notes", record: join(captureDir, "provenance.txt") },
  }), /must be an https URL/);
});

test("the receipt is written owner-only", () => {
  const request = makeRequest(["claude"]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ]));
  emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  });

  const mode = statSync(join(captureDir, "replay.receipt.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("an artifact outside the capture directory is refused", () => {
  const request = makeRequest(["claude"]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ]));
  const outside = mkdtempSync(join(tmpdir(), "replay-outside-"));
  const outsideReport = join(outside, "replay-parity.json");
  writeFileSync(outsideReport, JSON.stringify(makeReport([])), { mode: 0o600 });

  assert.throws(() => emitReplayReceipt({
    captureDir,
    request,
    reportPath: outsideReport,
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  }), /not inside the capture directory/);
});
