// Fixtures for the `replay` receipt.
//
// The properties under test are the ones the bundle's authority rests on:  a
// check's exit code comes out of the report the check names, an engine the
// report does not cover is never a pass, and the receipt is the shape
// `scripts/decommission-evidence-bundle.mjs` validates.  Each of those has a
// fixture that fails against a broken implementation, so a regression is a
// red test rather than a receipt that certifies a replay nobody ran.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.throws(() => readReplayReport(join(captureDir, "replay-parity.json")), /does not match the contract/);
});

test("a report whose engine entry names no verdict is refused", () => {
  const captureDir = mkdtempSync(join(tmpdir(), "replay-capture-"));
  writeFileSync(join(captureDir, "replay-parity.json"), JSON.stringify({ version: 1, engines: [{ engineId: "claude" }] }), { mode: 0o600 });
  assert.throws(() => readReplayReport(join(captureDir, "replay-parity.json")), /does not match the contract/);
});

test("a report that names the same engine twice is refused, so a failing verdict cannot hide", () => {
  const captureDir = mkdtempSync(join(tmpdir(), "replay-capture-"));
  const report = {
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: false,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 19, isFullyVerified: false },
    ],
  };
  writeFileSync(join(captureDir, "replay-parity.json"), JSON.stringify(report), { mode: 0o600 });
  assert.throws(
    () => readReplayReport(join(captureDir, "replay-parity.json")),
    /names the engine "claude" more than once/,
  );
});

test("a verdict that is ambiguous is not a pass", () => {
  // The report never went through the boundary, so the duplicate is still
  // there.  Two verdicts for one engine are not a verdict.
  const report = {
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: false,
    engines: [
      { engineId: "claude", isFullyVerified: true },
      { engineId: "claude", isFullyVerified: false },
    ],
  };
  assert.equal(replayVerdict(report, "claude"), false);
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
  writeFileSync(outsideReport, JSON.stringify(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ])), { mode: 0o600 });

  assert.throws(() => emitReplayReceipt({
    captureDir,
    request,
    reportPath: outsideReport,
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  }), /not inside the capture directory/);
});

/**
 * A report the boundary refuses, written to a file and read back.
 *
 * The refusal is the point of these fixtures:  a report that contradicts
 * itself is refused where the reason can be said, rather than read loosely
 * and turned into an exit code.
 */
function writeReport(report) {
  const captureDir = mkdtempSync(join(tmpdir(), "replay-refused-"));
  const path = join(captureDir, "replay-parity.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return path;
}

test("a report whose summary says every engine held while an engine did not is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude", "grok-acp"],
    isFullyVerified: true,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
      { engineId: "grok-acp", measured: true, fixtureCount: 27, passedCount: 26, isFullyVerified: false },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the report says every engine held and the engine "grok-acp" did not/,
  );
});

test("a report whose summary says an engine did not hold while every engine held is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: false,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the report says an engine did not hold and every engine it names held/,
  );
});

test("a report that asks for an engine it carries no verdict for is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude", "grok-acp"],
    isFullyVerified: false,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the report asks for the engine "grok-acp" and carries no verdict for it/,
  );
});

test("a report that carries a verdict for an engine it did not ask for is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: false,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
      { engineId: "grok-acp", measured: true, fixtureCount: 27, passedCount: 27, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the report carries a verdict for the engine "grok-acp" it did not ask for/,
  );
});

test("a report that asks for the same engine twice is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude", "claude"],
    isFullyVerified: false,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the report asks for the engine "claude" more than once/,
  );
});

test("an engine that claims more fixtures passed than it ran is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: true,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 21, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the engine "claude" passes 21 of 20 fixtures/,
  );
});

test("an engine that says it held while it was not measured is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["opencode"],
    isFullyVerified: true,
    engines: [
      { engineId: "opencode", measured: false, fixtureCount: 0, passedCount: 0, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the engine "opencode" says it held while it was not measured/,
  );
});

test("an engine that says it held while a fixture did not pass is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: true,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 20, passedCount: 19, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the engine "claude" says it held while 19 of 20 fixtures passed/,
  );
});

test("an engine that says it held without measuring a fixture is refused", () => {
  // The probe's verdict is "every fixture behind this engine passed" over a
  // non-empty set, so a fully verified engine with no fixture is a verdict
  // the probe cannot have written.
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: true,
    engines: [
      { engineId: "claude", measured: true, fixtureCount: 0, passedCount: 0, isFullyVerified: true },
    ],
  });
  assert.throws(
    () => readReplayReport(path),
    /the engine "claude" says it held without measuring a fixture/,
  );
});

test("a report carrying more engines than the bundle inventory holds is refused", () => {
  // The report is external input, so its list is bounded:  the bundle names
  // at most 32 engines, and the probe reports one entry per engine.
  const engines = Array.from({ length: 33 }, (_, index) => ({
    engineId: `engine-${index}`,
    measured: true,
    fixtureCount: 1,
    passedCount: 1,
    isFullyVerified: true,
  }));
  const path = writeReport({
    version: 1,
    requestedEngines: engines.map((entry) => entry.engineId),
    isFullyVerified: true,
    engines,
  });
  assert.throws(() => readReplayReport(path), /does not match the contract/);
});

test("a report naming an engine id as long as a check name allows still decodes", () => {
  // The receipt names its check `engine:<id>` and the bundle bounds a check
  // name at 2048 characters, so an id of 2041 is the longest one that can
  // still be named.
  const engineId = "e".repeat(2041);
  const path = writeReport({
    version: 1,
    requestedEngines: [engineId],
    isFullyVerified: true,
    engines: [
      { engineId, measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
    ],
  });
  const report = readReplayReport(path);
  assert.equal(report.engines.length, 1);
  assert.equal(replayVerdict(report, engineId), true);
});

test("a report naming an engine id longer than a check name allows is refused", () => {
  const engineId = "e".repeat(2042);
  const path = writeReport({
    version: 1,
    requestedEngines: [engineId],
    isFullyVerified: true,
    engines: [
      { engineId, measured: true, fixtureCount: 20, passedCount: 20, isFullyVerified: true },
    ],
  });
  assert.throws(() => readReplayReport(path), /does not match the contract/);
});

test("a bundle naming an engine the check name cannot hold is refused", () => {
  // The bundle's own engine id is over the limit the check name has, so the
  // receipt would be one the bundle refuses.  Nothing is written.  The
  // report covers the other engine only, which is the path that reaches the
  // guard:  a report that covered this engine could not have decoded.
  const engine = "e".repeat(2048);
  const request = makeRequest(["claude", engine]);
  const captureDir = makeCapture(makeReport([
    { engineId: "claude", family: "claude", measured: true, isFullyVerified: true, fixtureCount: 20, passedCount: 20 },
  ]));

  assert.throws(() => emitReplayReceipt({
    captureDir,
    request,
    reportPath: join(captureDir, "replay-parity.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
  }), /over the bundle's check-name limit/);
});

test("an engine entry that carries no measurement is refused", () => {
  const path = writeReport({
    version: 1,
    requestedEngines: ["claude"],
    isFullyVerified: true,
    engines: [
      { engineId: "claude", isFullyVerified: true },
    ],
  });
  assert.throws(() => readReplayReport(path), /does not match the contract/);
});

test("a report with no engines at all is refused", () => {
  const path = writeReport({ version: 1, requestedEngines: [], isFullyVerified: true, engines: [] });
  assert.throws(() => readReplayReport(path), /does not match the contract/);
});

test("the CLI runs when the script is invoked through a symlink", () => {
  // Node's ESM loader resolves symlinks for `import.meta.url` and leaves
  // `process.argv[1]` as it was typed, so an entry check that compared the two
  // unresolved paths would look like an import and quietly do nothing.
  const directory = mkdtempSync(join(tmpdir(), "replay-link-"));
  const link = join(directory, "emit-replay-receipt.mjs");
  symlinkSync(fileURLToPath(new URL("./emit-replay-receipt.mjs", import.meta.url)), link);

  const proc = spawnSync(process.execPath, [link], { encoding: "utf8" });
  // The CLI refuses without its arguments and says so;  an import would print
  // nothing at all and exit zero.
  assert.match(proc.stderr, /emit-replay-receipt refused/);
  assert.notEqual(proc.status, 0);
});
