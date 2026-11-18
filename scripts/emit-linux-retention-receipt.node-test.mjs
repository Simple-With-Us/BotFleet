// Fixtures for the `linux-retention` receipt.
//
// The properties under test are the ones the bundle's authority rests on:  a
// check's exit code comes out of the trace of the result the check names, a
// step the fixture did not record is never a pass, a result that contradicts
// itself or the closure receipts is refused with nothing written, and the
// receipt is the shape `scripts/decommission-evidence-bundle.mjs` validates,
// citing only files that bundle's own reader accepts.  Each of those has a
// fixture that fails against a broken implementation, so a regression is a
// red test rather than a receipt that certifies a run nobody made.
//
// Every result and closure receipt here is synthetic and lives in a temporary
// private directory.  One test runs the retained fixture itself, over a
// throwaway repository and with stub adapters that start nothing, so that the
// traces the producer reads are ones the fixture wrote.  No service is
// started and no gate state is read or written.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURE_ACTIONS, linuxFixturePlan, runLinuxClosureFixture } from "../deploy/linux-server/retained-fixture.mjs";
import {
  collectLinuxClosure, discoverLinuxRetention, immutableGitSource, LINUX_ENTRY_POINTS, LINUX_REQUIRED_INPUTS, RETENTION_POLICY_PATH,
} from "./linux-retained-source.mjs";
import {
  assertReceiptBinding, createEvidenceReader, evidenceHash, MAX_EVIDENCE_FILE_BYTES, parseEvidenceReceipt, readEvidenceRef,
  receiptReferences, REQUIRED_CHECKS,
} from "./decommission-evidence-bundle.mjs";
import {
  emitLinuxRetentionReceipt, LINUX_RETENTION_RECEIPT_FILE, parseRetainedRunResult, RETENTION_PRESERVATION, retentionVerdicts,
} from "./emit-linux-retention-receipt.mjs";

const CANDIDATE_SHA = "c".repeat(40);
const PRIOR_SHA = "d".repeat(40);
const SOURCES = { candidate: CANDIDATE_SHA, prior: PRIOR_SHA };
const SCRIPT = fileURLToPath(new URL("./emit-linux-retention-receipt.mjs", import.meta.url));

/** A request the receipt is bound to, for a packet whose candidate is the given source. */
function makeRequest(sourceSha = CANDIDATE_SHA) {
  return {
    version: 1,
    candidate: { sourceSha, build: "202611170715", artifactSha256: "b".repeat(64) },
    mode: "serverFirst",
    hosts: [
      { id: `mac:${"1".repeat(8)}-${"2".repeat(4)}-${"3".repeat(4)}-${"4".repeat(4)}-${"5".repeat(12)}`, role: "mac" },
      { id: `server:${"6".repeat(8)}-${"7".repeat(4)}-${"8".repeat(4)}-${"9".repeat(4)}-${"a".repeat(12)}`, role: "server" },
    ],
    acceptanceOwner: "Jay Wedgeworth",
    engines: ["claude"],
    state: { path: "state.json", sha256: "c".repeat(64) },
    receipts: {},
  };
}

/** A closure receipt the collector would have written for one source. */
function makeClosure(sourceSha, fileCount = 1) {
  return {
    version: 1,
    sourceSha,
    policySourceSha: sourceSha,
    policyPath: "deploy/linux-server/retained-source.json",
    maintainedRef: "main",
    policySha256: "e".repeat(64),
    toolchain: {
      nodeVersion: "24.4.1",
      packageManager: "pnpm@12.20.0",
      lockSha256: "1".repeat(64),
      workspaceSha256: "2".repeat(64),
      installCompilerSha256: "3".repeat(64),
    },
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `server/retained-${String(index).padStart(5, "0")}.ts`,
      blob: "f".repeat(40),
      sha256: "4".repeat(64),
      mode: "100644",
    })),
  };
}

/** A step the fixture records after its adapter returned success. */
function step(action, slot, evidence = {}) {
  return { action, slot, sourceSha: SOURCES[slot], evidence };
}

const REFUSED = { action: "candidate-refused", reason: "An isolated fixture phase did not complete safely" };

/** The ten steps of the fixture's main sequence, in the order it writes them. */
function mainSteps() {
  return [
    step("installDependencies", "prior", { executable: "/usr/bin/pnpm", joined: true }),
    step("buildUi", "prior", { uiHash: "5".repeat(64) }),
    step("start", "prior", { sourceSha: PRIOR_SHA, pid: 4101, httpPort: 41001, webhookPort: 41002, uiPort: 41003 }),
    step("health", "prior", { sourceSha: PRIOR_SHA, pid: 4101, version: "0.1.0" }),
    step("stop", "prior", { pid: 4101, joined: true }),
    step("installDependencies", "candidate", { executable: "/usr/bin/pnpm", joined: true }),
    step("buildUi", "candidate", { uiHash: "6".repeat(64) }),
    step("start", "candidate", { sourceSha: CANDIDATE_SHA, pid: 4202, httpPort: 42001, webhookPort: 42002, uiPort: 42003 }),
    step("health", "candidate", { sourceSha: CANDIDATE_SHA, pid: 4202, version: "0.1.0" }),
    step("stop", "candidate", { pid: 4202, joined: true }),
  ];
}

/** The three steps of the rollback, in the order the fixture writes them. */
function rollbackSteps() {
  return [
    step("start", "prior", { sourceSha: PRIOR_SHA, pid: 4303 }),
    step("health", "prior", { sourceSha: PRIOR_SHA, pid: 4303, version: "0.1.0" }),
    step("stop", "prior", { pid: 4303, joined: true }),
  ];
}

/** A result the fixture would have written;  the summary follows the trace unless overridden. */
function makeResult(trace = [...mainSteps(), ...rollbackSteps()], overrides = {}) {
  const count = (action, slot) => trace.filter((item) => item.action === action && item.slot === slot).length;
  return {
    executed: true,
    proof: "isolated-source-fixture-only",
    candidateHealthy: count("health", "candidate") > 0,
    rollbackHealthy: count("health", "prior") >= 2,
    cleanupFailures: [],
    preservation: RETENTION_PRESERVATION,
    trace,
    ...overrides,
  };
}

/**
 * A private capture directory holding a result, both closure receipts and a
 * provenance record.  `raw` replaces a file's text outright, for a file that
 * is not JSON at all.
 */
function makeCapture({ result = makeResult(), candidate = makeClosure(CANDIDATE_SHA), prior = makeClosure(PRIOR_SHA), raw = {} } = {}) {
  const captureDir = mkdtempSync(join(tmpdir(), "linux-retention-capture-"));
  const files = {
    "actual-source-runtime-result.json": `${JSON.stringify(result, null, 2)}\n`,
    "candidate-closure.json": `${JSON.stringify(candidate, null, 2)}\n`,
    "prior-closure.json": `${JSON.stringify(prior, null, 2)}\n`,
    "provenance.txt": "the retained run was made on the fixture host\n",
    ...raw,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(captureDir, name), text, { mode: 0o600 });
  return captureDir;
}

const PROVENANCE = {
  by: "Jay Wedgeworth",
  at: "2026-11-17T05:15:00.000Z",
  source: "https://simplewithus.zulipchat.com/#narrow/stream/agents",
};

/** Emit against a capture directory, with any argument replaced. */
function emit(captureDir, overrides = {}) {
  return emitLinuxRetentionReceipt({
    captureDir,
    request: makeRequest(),
    resultPath: join(captureDir, "actual-source-runtime-result.json"),
    candidateClosurePath: join(captureDir, "candidate-closure.json"),
    priorClosurePath: join(captureDir, "prior-closure.json"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
    ...overrides,
  });
}

/** The exit codes of a receipt, by check name. */
function exitCodes(receipt) {
  return Object.fromEntries(receipt.data.checks.map((check) => [check.name, check.exitCode]));
}

/** A refusal says why and leaves no receipt behind. */
function assertRefused(captureDir, pattern, overrides) {
  assert.throws(() => emit(captureDir, overrides), pattern);
  assert.equal(existsSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)), false);
}

test("a complete run earns the four passing checks the bundle names", () => {
  const captureDir = makeCapture();
  const receipt = emit(captureDir);

  assert.equal(receipt.kind, "linux-retention");
  assert.deepEqual(receipt.data.checks.map((check) => check.name), REQUIRED_CHECKS["linux-retention"]);
  assert.deepEqual(receipt.data.checks.map((check) => check.exitCode), [0, 0, 0, 0]);

  // The pinned sources are the ones the closure receipts name, and the
  // closure manifest is the candidate's closure receipt, bound by hash.
  assert.equal(receipt.data.maintainedSourceSha, CANDIDATE_SHA);
  assert.equal(receipt.data.rollbackSourceSha, PRIOR_SHA);
  assert.deepEqual(receipt.data.closureManifest, {
    path: "candidate-closure.json",
    sha256: evidenceHash(readFileSync(join(captureDir, "candidate-closure.json"))),
  });

  // Every check cites the result its exit code was read out of.
  const resultReference = {
    path: "actual-source-runtime-result.json",
    sha256: evidenceHash(readFileSync(join(captureDir, "actual-source-runtime-result.json"))),
  };
  for (const check of receipt.data.checks) assert.deepEqual(check.artifact, resultReference);

  // The receipt on disk is the shape the bundle validates, it is bound to
  // the same candidate as the request, and the bundle's own reader accepts
  // the receipt and every file it cites.
  const reader = createEvidenceReader(captureDir);
  const parsed = parseEvidenceReceipt("linux-retention", reader.read(LINUX_RETENTION_RECEIPT_FILE));
  assert.deepEqual(parsed, receipt);
  assert.doesNotThrow(() => assertReceiptBinding(parsed, makeRequest()));
  assert.equal(parsed.provenance.record.path, "provenance.txt");
  for (const reference of receiptReferences(parsed)) assert.doesNotThrow(() => readEvidenceRef(reader, reference));
});

test("the receipt carries no preservation claim", () => {
  const captureDir = makeCapture();
  emit(captureDir);
  const text = readFileSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE), "utf8");
  assert.doesNotMatch(text, /preservation/i);
});

test("a candidate that was never healthy fails the update and keeps the rollback it earned", () => {
  // The fixture stops the candidate, records the refusal and still rehearses
  // the rollback to the prior.
  const main = mainSteps();
  const trace = [...main.slice(0, 8), main[9], REFUSED, ...rollbackSteps()];
  const captureDir = makeCapture({ result: makeResult(trace) });

  const receipt = emit(captureDir);
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 0, "install-start": 0, update: 1, rollback: 0 });
  // An honest failure still writes its receipt, and the bundle refuses the
  // failing code.
  const parsed = parseEvidenceReceipt("linux-retention", readFileSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)));
  assert.equal(parsed.data.checks.find((check) => check.name === "update").exitCode, 1);
});

test("a refused rollback fails the rollback", () => {
  const rollback = rollbackSteps();
  const trace = [...mainSteps(), rollback[0], { action: "rollback-refused" }, rollback[2]];
  const receipt = emit(makeCapture({ result: makeResult(trace) }));
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 0, "install-start": 0, update: 0, rollback: 1 });
});

test("a prior that never started fails every check, because the candidate was never reached", () => {
  // The prior's start failed, the fixture confirmed its stop and went no
  // further:  no candidate step exists and no rollback was attempted.
  const main = mainSteps();
  const trace = [main[0], main[1], REFUSED, main[4]];
  const receipt = emit(makeCapture({ result: makeResult(trace) }));
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 1, "install-start": 1, update: 1, rollback: 1 });
});

test("a run that materialized nothing fails every check", () => {
  const receipt = emit(makeCapture({ result: makeResult([REFUSED]) }));
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 1, "install-start": 1, update: 1, rollback: 1 });
});

test("a candidate that failed before it started leaves the prior's own checks standing", () => {
  // The candidate's build failed:  the prior was installed, started and
  // healthy, the candidate was never built, and the fixture rehearsed a
  // restart of the prior that is not a rollback from any candidate.
  const main = mainSteps();
  const trace = [...main.slice(0, 6), REFUSED, ...rollbackSteps()];
  const result = makeResult(trace);
  assert.equal(result.rollbackHealthy, true);
  const receipt = emit(makeCapture({ result }));
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 1, "install-start": 0, update: 1, rollback: 1 });
});

test("a fixture process left behind fails the rollback", () => {
  // The rollback was healthy and its own stop was never confirmed, so the
  // fixture reports the prior as a cleanup failure and writes no stop step.
  const trace = [...mainSteps(), ...rollbackSteps().slice(0, 2)];
  const receipt = emit(makeCapture({ result: makeResult(trace, { cleanupFailures: ["prior"] }) }));
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 0, "install-start": 0, update: 0, rollback: 1 });
});

test("a cleanup failure fails the rollback even beside a complete trace", () => {
  const verdicts = retentionVerdicts(makeResult(undefined, { cleanupFailures: ["adapter-processes"] }));
  assert.deepEqual(verdicts, { "clean-export-build": true, "install-start": true, update: true, rollback: false });
});

test("a phase the fixture refused fails the update even when the candidate was healthy", () => {
  // The candidate was healthy and its first stop failed:  the fixture
  // records the refusal, retries the stop and rehearses the rollback.
  const main = mainSteps();
  const trace = [...main.slice(0, 9), REFUSED, main[9], ...rollbackSteps()];
  const result = makeResult(trace);
  assert.equal(result.candidateHealthy, true);
  const receipt = emit(makeCapture({ result }));
  assert.deepEqual(exitCodes(receipt), { "clean-export-build": 0, "install-start": 0, update: 1, rollback: 0 });
});

test("a step is read from where the fixture writes it, so a step out of order is never a pass", () => {
  const main = mainSteps();

  // The candidate's health step after its stop is not a health check of a
  // running candidate.
  const lateHealth = [...main.slice(0, 8), main[9], main[8], ...rollbackSteps()];
  assert.equal(retentionVerdicts(makeResult(lateHealth)).update, false);

  // A candidate that started while the prior was never stopped is not an
  // update from a single known writer.
  const priorNeverStopped = [...main.slice(0, 4), ...main.slice(5), ...rollbackSteps()];
  const verdicts = retentionVerdicts(makeResult(priorNeverStopped));
  assert.equal(verdicts["install-start"], true);
  assert.equal(verdicts["clean-export-build"], false);
  assert.equal(verdicts.update, false);
  assert.equal(verdicts.rollback, false);

  // A prior that was healthy before the candidate stopped did not roll back
  // from it.
  const rollback = rollbackSteps();
  const earlyRollback = [...main.slice(0, 9), rollback[0], rollback[1], main[9], rollback[2]];
  assert.equal(retentionVerdicts(makeResult(earlyRollback)).rollback, false);

  // Anything the fixture wrote after the rollback's stop means the run did
  // not end with the rollback.
  const trailing = [...main, ...rollbackSteps(), main[7]];
  assert.equal(retentionVerdicts(makeResult(trailing)).rollback, false);

  // The same trace in the fixture's order holds.
  assert.deepEqual(retentionVerdicts(makeResult()), { "clean-export-build": true, "install-start": true, update: true, rollback: true });
});

test("a step the fixture never writes between the candidate's start and its stop fails the update and the rollback", () => {
  const main = mainSteps();
  const rollback = rollbackSteps();
  const built = { "clean-export-build": true, "install-start": true, update: false, rollback: false };

  // The prior started and was healthy while the candidate was still up, and
  // the candidate was stopped afterwards:  two writers at once, followed by
  // the three rollback steps and a summary that agrees with the trace.
  const twoWriters = makeResult([...main.slice(0, 9), rollback[0], rollback[1], main[9], ...rollback]);
  assert.equal(twoWriters.candidateHealthy, true);
  assert.equal(twoWriters.rollbackHealthy, true);
  assert.deepEqual(retentionVerdicts(twoWriters), built);
  assert.deepEqual(exitCodes(emit(makeCapture({ result: twoWriters }))), { "clean-export-build": 0, "install-start": 0, update: 1, rollback: 1 });

  // A second start of the candidate before its stop.
  assert.deepEqual(retentionVerdicts(makeResult([...main.slice(0, 9), main[7], main[9], ...rollback])), built);

  // As many extra steps as the result's contract allows.
  const padded = [...main.slice(0, 9), ...Array.from({ length: 19 }, () => main[8]), main[9], ...rollback];
  assert.equal(padded.length, 32);
  assert.deepEqual(retentionVerdicts(makeResult(padded)), built);

  // An extra step after the candidate's stop and before the rollback leaves
  // the update the fixture's own and still is not a rollback.
  assert.deepEqual(
    retentionVerdicts(makeResult([...main, main[9], ...rollback])),
    { "clean-export-build": true, "install-start": true, update: true, rollback: false },
  );

  // Two refusal markers are not something one run writes.
  assert.deepEqual(retentionVerdicts(makeResult([...main.slice(0, 8), REFUSED, REFUSED, main[9], ...rollback])), built);
});

test("every order the fixture writes a built candidate's run in is read as that run", () => {
  const main = mainSteps();
  const rollback = rollbackSteps();
  const read = (candidateRun) => retentionVerdicts(makeResult([...main.slice(0, 7), ...candidateRun, ...rollback]));
  const refusedThenRolledBack = { "clean-export-build": true, "install-start": true, update: false, rollback: true };

  // The candidate held.
  assert.deepEqual(read([main[7], main[8], main[9]]), { "clean-export-build": true, "install-start": true, update: true, rollback: true });
  // The candidate was healthy, its first stop failed and its second was confirmed.
  assert.deepEqual(read([main[7], main[8], REFUSED, main[9]]), refusedThenRolledBack);
  // The candidate's health step failed and its stop was confirmed.
  assert.deepEqual(read([main[7], main[9], REFUSED]), refusedThenRolledBack);
  // The health step and the first stop failed and the second stop was confirmed.
  assert.deepEqual(read([main[7], REFUSED, main[9]]), refusedThenRolledBack);
  // The candidate's start failed and its stop was confirmed.
  assert.deepEqual(read([REFUSED, main[9]]), refusedThenRolledBack);

  // A candidate that was never confirmed stopped has no rollback after it.
  assert.equal(read([main[7], main[8]]).rollback, false);
  assert.equal(read([main[7], REFUSED]).rollback, false);
  assert.equal(read([REFUSED]).rollback, false);
});

test("a result whose summary says the candidate was healthy without a health step is refused", () => {
  const main = mainSteps();
  const trace = [...main.slice(0, 8), main[9], REFUSED, ...rollbackSteps()];
  const captureDir = makeCapture({ result: makeResult(trace, { candidateHealthy: true }) });
  assertRefused(captureDir, /says the candidate was healthy and the trace carries no candidate health step/);
});

test("a result whose summary says the candidate was not healthy beside a health step is refused", () => {
  const captureDir = makeCapture({ result: makeResult(undefined, { candidateHealthy: false }) });
  assertRefused(captureDir, /says the candidate was not healthy and the trace carries a candidate health step/);
});

test("a result whose summary says the rollback was healthy without a second prior health step is refused", () => {
  const rollback = rollbackSteps();
  const trace = [...mainSteps(), rollback[0], { action: "rollback-refused" }, rollback[2]];
  const captureDir = makeCapture({ result: makeResult(trace, { rollbackHealthy: true }) });
  assertRefused(captureDir, /says the rollback was healthy and the trace carries no second prior health step/);
});

test("a result whose summary says the rollback was not healthy beside a second prior health step is refused", () => {
  const captureDir = makeCapture({ result: makeResult(undefined, { rollbackHealthy: false }) });
  assertRefused(captureDir, /says the rollback was not healthy and the trace carries a second prior health step/);
});

test("a result that says the rollback was both healthy and refused is refused", () => {
  const trace = [...mainSteps(), ...rollbackSteps(), { action: "rollback-refused" }];
  const captureDir = makeCapture({ result: makeResult(trace) });
  assertRefused(captureDir, /says the rollback was healthy and the trace says the rollback was refused/);
});

test("a plan is refused, because it records no run", () => {
  // The shape `retained-actual-run.mjs --plan` prints.
  const plan = {
    executed: false,
    proof: "isolated-source-fixture-only",
    preservation: "not-established",
    current: { sourceSha: CANDIDATE_SHA, files: 1 },
    prior: { sourceSha: PRIOR_SHA, files: 1 },
    phases: ["export-both", "install-and-build-prior", "prior-start-health", "install-and-build-candidate", "candidate-update-health", "prior-rollback-health"],
  };
  assertRefused(makeCapture({ result: plan }), /is a plan and not an executed run/);
});

test("a result that claims preservation is refused", () => {
  const captureDir = makeCapture({ result: makeResult(undefined, { preservation: "established" }) });
  assertRefused(captureDir, /does not match the contract: preservation/);
});

test("a result carrying a field the fixture does not write is refused", () => {
  const captureDir = makeCapture({ result: makeResult(undefined, { verified: true }) });
  assertRefused(captureDir, /does not match the contract/);
});

test("a trace naming a step the fixture does not record is refused", () => {
  const trace = [...mainSteps(), ...rollbackSteps()];
  trace[8] = { ...trace[8], action: "smoke" };
  const captureDir = makeCapture({ result: makeResult(trace, { candidateHealthy: false }) });
  assertRefused(captureDir, /does not match the contract/);
});

test("a result that cannot be read as JSON is refused", () => {
  assertRefused(makeCapture({ raw: { "actual-source-runtime-result.json": "{ not json" } }), /the retained-run result could not be read as JSON/);
  assert.throws(() => parseRetainedRunResult(Buffer.from("null")), /does not match the contract/);
});

test("a step that ran a source other than its slot's closure receipt is refused", () => {
  const trace = [...mainSteps(), ...rollbackSteps()];
  trace[6] = { ...trace[6], sourceSha: "9".repeat(40) };
  const captureDir = makeCapture({ result: makeResult(trace) });
  assertRefused(captureDir, /the candidate buildUi step ran a source other than the one the candidate closure receipt names/);
});

test("closure receipts for a different run than the result are refused", () => {
  // The result is from the run of CANDIDATE over PRIOR;  the prior closure
  // receipt handed over is for some third source.
  const captureDir = makeCapture({ prior: makeClosure("9".repeat(40)) });
  assertRefused(captureDir, /the prior installDependencies step ran a source other than the one the prior closure receipt names/);
});

test("a step whose own observation names another source is refused", () => {
  const trace = [...mainSteps(), ...rollbackSteps()];
  trace[8] = step("health", "candidate", { sourceSha: PRIOR_SHA, pid: 4202 });
  const captureDir = makeCapture({ result: makeResult(trace) });
  assertRefused(captureDir, /the candidate health step observed a source other than the one it ran/);
});

test("a candidate and a prior that are the same source are refused", () => {
  const captureDir = makeCapture({ prior: makeClosure(CANDIDATE_SHA) });
  assertRefused(captureDir, /name the same source, and a rollback needs a distinct prior/);
});

test("a candidate closure receipt for a source other than the packet's candidate is refused", () => {
  // The bundle's identity check compares the receipt's candidate to the
  // request's and never looks at the source the receipt pins, so a complete,
  // consistent run of some other source would otherwise certify this packet.
  const captureDir = makeCapture();
  const otherCandidate = "a".repeat(40);
  assertRefused(
    captureDir,
    new RegExp(`the candidate closure receipt names source ${CANDIDATE_SHA} and the bundle request's candidate is source ${otherCandidate}`),
    { request: makeRequest(otherCandidate) },
  );

  // The same capture, bound to its own candidate, is emitted.
  assert.equal(emit(captureDir).data.maintainedSourceSha, CANDIDATE_SHA);
});

test("a result reporting a proof the fixture does not report is refused", () => {
  const captureDir = makeCapture({ result: makeResult(undefined, { proof: "production-acceptance" }) });
  assertRefused(captureDir, /reports the proof "production-acceptance" and the fixture reports "isolated-source-fixture-only"/);
});

test("a closure receipt that does not match its contract is refused", () => {
  const candidate = makeClosure(CANDIDATE_SHA);
  delete candidate.toolchain;
  assertRefused(makeCapture({ candidate }), /the candidate closure receipt does not match the contract/);
  assertRefused(makeCapture({ raw: { "prior-closure.json": "[" } }), /the prior closure receipt could not be read as JSON/);
});

test("a capture directory other people can read is refused", () => {
  const captureDir = makeCapture();
  chmodSync(captureDir, 0o755);
  assertRefused(captureDir, /not private/);
});

test("an artifact outside the capture directory is refused", () => {
  const captureDir = makeCapture();
  const outside = makeCapture();
  assertRefused(captureDir, /not inside the capture directory/, { resultPath: join(outside, "actual-source-runtime-result.json") });
  assertRefused(captureDir, /not inside the capture directory/, { candidateClosurePath: join(outside, "candidate-closure.json") });
  assertRefused(captureDir, /not inside the capture directory/, { priorClosurePath: join(outside, "prior-closure.json") });
  assertRefused(captureDir, /not inside the capture directory/, { provenance: { ...PROVENANCE, record: join(outside, "provenance.txt") } });
});

test("a capture directory and its files spelled through different symlinked aliases are the same directory", () => {
  // macOS reaches its temp folder as both `/var/...` and `/private/var/...`.
  // The bundle's reader roots at the real path, so the references have to be
  // measured from it too, or a legitimate capture is refused as "not inside
  // the capture directory" for the way an operator spelled it.
  const real = makeCapture();
  const aliasParent = mkdtempSync(join(tmpdir(), "linux-retention-alias-"));
  const alias = join(aliasParent, "capture-alias");
  symlinkSync(real, alias);
  const inReal = (name) => join(real, name);
  const inAlias = (name) => join(alias, name);

  // The directory through the alias, every file through the real path.
  const throughAlias = emit(alias, {
    resultPath: inReal("actual-source-runtime-result.json"),
    candidateClosurePath: inReal("candidate-closure.json"),
    priorClosurePath: inReal("prior-closure.json"),
    provenance: { ...PROVENANCE, record: inReal("provenance.txt") },
  });
  assert.deepEqual(throughAlias.data.closureManifest.path, "candidate-closure.json");
  assert.equal(throughAlias.provenance.record.path, "provenance.txt");
  assert.deepEqual(exitCodes(throughAlias), { "clean-export-build": 0, "install-start": 0, update: 0, rollback: 0 });

  // The directory by its real path, every file through the alias.
  const throughReal = emit(real, {
    resultPath: inAlias("actual-source-runtime-result.json"),
    candidateClosurePath: inAlias("candidate-closure.json"),
    priorClosurePath: inAlias("prior-closure.json"),
    provenance: { ...PROVENANCE, record: inAlias("provenance.txt") },
  });
  assert.deepEqual(throughReal, throughAlias);

  // The receipt is the same one however the directory was spelled, and the
  // bundle's reader accepts it and every file it cites.
  const reader = createEvidenceReader(real);
  const parsed = parseEvidenceReceipt("linux-retention", reader.read(LINUX_RETENTION_RECEIPT_FILE));
  for (const reference of receiptReferences(parsed)) assert.doesNotThrow(() => readEvidenceRef(reader, reference));

  // A symlink as a file's own name is still not that file, aliased directory or not.
  symlinkSync(inReal("prior-closure.json"), inReal("prior-link.json"));
  assert.throws(
    () => emit(alias, { priorClosurePath: inAlias("prior-link.json") }),
    /the prior closure receipt is not a file the evidence bundle will read/,
  );
});

test("a closure manifest larger than the bundle reads is refused with its size", () => {
  // A closure receipt may be four times the size the bundle reads of one
  // file, so a valid receipt can still be one the bundle refuses.
  const candidate = makeClosure(CANDIDATE_SHA, 6000);
  const captureDir = makeCapture({ candidate });
  const size = statSync(join(captureDir, "candidate-closure.json")).size;
  assert.ok(size > MAX_EVIDENCE_FILE_BYTES);
  assertRefused(captureDir, new RegExp(`the candidate closure receipt is ${size} bytes and the evidence bundle reads at most ${MAX_EVIDENCE_FILE_BYTES} bytes`));
});

test("a cited file other people can read is refused, because the bundle would refuse it", () => {
  const captureDir = makeCapture();
  chmodSync(join(captureDir, "actual-source-runtime-result.json"), 0o644);
  assertRefused(captureDir, /the retained-run result is not a file the evidence bundle will read \(evidence-path-not-private\)/);
});

test("a hard-linked cited file is refused, because the bundle would refuse it", () => {
  const captureDir = makeCapture();
  linkSync(join(captureDir, "candidate-closure.json"), join(captureDir, "candidate-closure-copy.json"));
  assertRefused(captureDir, /the candidate closure receipt is not a file the evidence bundle will read \(evidence-not-single-link-file\)/);
});

test("a symlinked cited file is refused, because the bundle would refuse it", () => {
  const captureDir = makeCapture();
  symlinkSync(join(captureDir, "prior-closure.json"), join(captureDir, "prior-link.json"));
  assertRefused(captureDir, /the prior closure receipt is not a file the evidence bundle will read/, { priorClosurePath: join(captureDir, "prior-link.json") });
});

test("a cited file that is missing, or is not a regular file, is refused", () => {
  const captureDir = makeCapture();
  assertRefused(captureDir, /the retained-run result could not be read/, { resultPath: join(captureDir, "absent.json") });
  mkdirSync(join(captureDir, "nested"), { mode: 0o700 });
  assertRefused(captureDir, /the retained-run result is not a regular file/, { resultPath: join(captureDir, "nested") });
});

test("a cited file whose name the bundle cannot reference is refused", () => {
  // The bundle's references allow letters, digits and `_ . / -` in a path,
  // so a receipt citing any other name would be refused for its shape.
  const captureDir = makeCapture();
  const spaced = join(captureDir, "prior closure.json");
  copyFileSync(join(captureDir, "prior-closure.json"), spaced);
  chmodSync(spaced, 0o600);
  assertRefused(captureDir, /the prior closure receipt is not a file the evidence bundle will read \(malformed-schema\)/, { priorClosurePath: spaced });
});

test("a cited file in a private folder inside the capture directory is accepted", () => {
  const captureDir = makeCapture();
  mkdirSync(join(captureDir, "closures"), { mode: 0o700 });
  // `mkdirSync` applies its mode through the umask, so the mode is set again.
  chmodSync(join(captureDir, "closures"), 0o700);
  const nested = join(captureDir, "closures", "candidate.json");
  copyFileSync(join(captureDir, "candidate-closure.json"), nested);
  chmodSync(nested, 0o600);
  const receipt = emit(captureDir, { candidateClosurePath: nested });
  assert.equal(receipt.data.closureManifest.path, "closures/candidate.json");
});

test("a receipt whose provenance source is not an https URL is refused", () => {
  const captureDir = makeCapture();
  assertRefused(captureDir, /must be an https URL/, {
    provenance: { ...PROVENANCE, source: "http://example.com/notes", record: join(captureDir, "provenance.txt") },
  });
});

test("a provenance the bundle's schema refuses is refused before anything is written", () => {
  const captureDir = makeCapture();
  assertRefused(captureDir, /is not one the evidence bundle accepts \(malformed-schema\)/, {
    provenance: { ...PROVENANCE, at: "yesterday", record: join(captureDir, "provenance.txt") },
  });
});

test("the receipt is written owner-only as a new single-link file", () => {
  const captureDir = makeCapture();
  const receiptPath = join(captureDir, LINUX_RETENTION_RECEIPT_FILE);
  // A receipt already there, hard-linked and readable by others, is replaced
  // rather than written through.
  writeFileSync(receiptPath, "stale\n", { mode: 0o644 });
  chmodSync(receiptPath, 0o644);
  linkSync(receiptPath, join(captureDir, "stale-link.json"));

  emit(captureDir);

  const stat = lstatSync(receiptPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  assert.equal(readFileSync(join(captureDir, "stale-link.json"), "utf8"), "stale\n");
});

test("the receipt replaces a symlink left under its name instead of writing through it", () => {
  const captureDir = makeCapture();
  const elsewhere = join(mkdtempSync(join(tmpdir(), "linux-retention-elsewhere-")), "target.json");
  writeFileSync(elsewhere, "untouched\n", { mode: 0o600 });
  symlinkSync(elsewhere, join(captureDir, LINUX_RETENTION_RECEIPT_FILE));

  emit(captureDir);

  assert.equal(lstatSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)).isSymbolicLink(), false);
  assert.equal(readFileSync(elsewhere, "utf8"), "untouched\n");
});

test("the receipt this command writes is never one of its own inputs", () => {
  // Cited as the provenance record, the receipt already there would be hashed
  // and then replaced, and the bundle would find a hash that matches nothing.
  const captureDir = makeCapture();
  emit(captureDir);
  const receiptPath = join(captureDir, LINUX_RETENTION_RECEIPT_FILE);
  const before = readFileSync(receiptPath);

  assert.throws(
    () => emit(captureDir, { provenance: { ...PROVENANCE, record: receiptPath } }),
    /the provenance record is the receipt this command writes, and a receipt cannot cite the file it replaces/,
  );
  // Another spelling of the same name is the same file.
  assert.throws(
    () => emit(captureDir, { provenance: { ...PROVENANCE, record: `${captureDir}/./${LINUX_RETENTION_RECEIPT_FILE}` } }),
    /the provenance record is the receipt this command writes/,
  );
  assert.throws(() => emit(captureDir, { resultPath: receiptPath }), /the retained-run result is the receipt this command writes/);
  assert.throws(() => emit(captureDir, { candidateClosurePath: receiptPath }), /the candidate closure receipt is the receipt this command writes/);
  assert.throws(() => emit(captureDir, { priorClosurePath: receiptPath }), /the prior closure receipt is the receipt this command writes/);

  // The receipt from the first run is untouched, and the bundle's reader
  // still accepts it and every file it cites.
  assert.deepEqual(readFileSync(receiptPath), before);
  const reader = createEvidenceReader(captureDir);
  const parsed = parseEvidenceReceipt("linux-retention", reader.read(LINUX_RETENTION_RECEIPT_FILE));
  for (const reference of receiptReferences(parsed)) assert.doesNotThrow(() => readEvidenceRef(reader, reference));
});

test("the vocabulary the producer reads is the fixture's and the bundle's own", () => {
  // The producer reads its steps by name and by position, and its check
  // names from the bundle.  A change to either list has to be re-read here
  // before the producer can be trusted with it.
  assert.deepEqual(FIXTURE_ACTIONS, ["installDependencies", "buildUi", "start", "health", "stop"]);
  assert.deepEqual(REQUIRED_CHECKS["linux-retention"], ["clean-export-build", "install-start", "update", "rollback"]);
  assert.deepEqual(Object.keys(retentionVerdicts(makeResult())), REQUIRED_CHECKS["linux-retention"]);
  const plan = linuxFixturePlan(makeClosure(CANDIDATE_SHA), makeClosure(PRIOR_SHA));
  assert.equal(plan.proof, makeResult().proof);
  assert.deepEqual(plan.phases, [
    "export-both", "install-and-build-prior", "prior-start-health",
    "install-and-build-candidate", "candidate-update-health", "prior-rollback-health",
  ]);
});

const server = `import { createServer } from "node:http";
import { value } from "../shared/value.ts";
import "./proxy-paths.ts";
const server = createServer((request, response) => response.end(JSON.stringify({ value })));
server.listen(0, "127.0.0.1", () => process.send?.({ port: server.address().port }));
setTimeout(() => process.exit(0), 15000).unref();
`;

/**
 * A throwaway Git repository holding two commits of a synthetic source, and
 * the closure receipts the collector writes for them.  It is built the way
 * `deploy/linux-server/retained-source.node-test.mjs` builds its own, and
 * has no remote, credential, account or service configuration.
 */
async function sourceFixture() {
  // The fixture refuses a linked root, and macOS links its temp folder through /private.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "linux-retention-fixture-")));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const put = (path, content) => {
    mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, path), content, { mode: 0o644 });
  };
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Synthetic source fixture");
    return git("rev-parse", "HEAD");
  };
  for (const path of [...LINUX_ENTRY_POINTS.map(([entry]) => entry), ...LINUX_REQUIRED_INPUTS]) put(path, path.endsWith(".json") ? "{}" : "");
  put("server/index.ts", server);
  put("server/proxy-paths.ts", 'function resolveProxy(name) { return name; } export const SPAWNED_PROXIES = { fixture: resolveProxy("fixture-proxy") };');
  put("server/fixture-proxy.ts", "export const fixture = true;");
  put("shared/value.ts", 'export const value = "prior";');
  put("deploy/linux-server/owner-gate.mjs", 'export { allowed } from "../../electron/infisical-read.mjs";');
  put("electron/infisical-read.mjs", "export const allowed = true;");
  put("electron/main.mjs", 'throw new Error("unretained Mac application must never load");');
  put("src/main.tsx", 'export { ui } from "./ui.js";');
  put("src/ui.ts", "export const ui = true;");
  put("public/retained.txt", "synthetic UI asset");
  put("package.json", JSON.stringify({ name: "synthetic-linux-fixture", version: "0.1.0", type: "module", packageManager: "pnpm@12.16.1" }));
  put("deploy/linux-server/common.sh", 'NODE_VERSION="${NODE_VERSION:-24.18.0}"\n');
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put("pnpm-workspace.yaml", "packages: ['.']\n");
  git("init", "-q");
  const basis = commit();
  put(RETENTION_POLICY_PATH, JSON.stringify(await discoverLinuxRetention(immutableGitSource(source, basis))));
  const prior = commit();
  put("shared/value.ts", 'export const value = "candidate";');
  const candidate = commit();
  return {
    root,
    source,
    prior,
    candidate,
    previous: await collectLinuxClosure(immutableGitSource(source, prior)),
    current: await collectLinuxClosure(immutableGitSource(source, candidate)),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Stub adapters for the fixture that start nothing.  A call fails when its
 * `action:slot:n` is listed, `n` counting that action's calls for that slot
 * from one, and the evidence a call returns is the shape the fixture bounds.
 */
function stubAdapters({ failures = [], cleanupOk = true } = {}) {
  const calls = new Map();
  const failing = new Set(failures);
  const adapter = (action, evidence) => async ({ slot, sourceSha }) => {
    const key = `${action}:${slot}`;
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (failing.has(`${key}:${count}`)) return { ok: false };
    return { ok: true, ...evidence(sourceSha, 4000 + count) };
  };
  return {
    installDependencies: adapter("installDependencies", () => ({ executable: "/usr/bin/pnpm", joined: true })),
    buildUi: adapter("buildUi", () => ({ uiHash: "5".repeat(64) })),
    start: adapter("start", (sourceSha, pid) => ({ sourceSha, pid, httpPort: 41001, webhookPort: 41002, uiPort: 41003 })),
    health: adapter("health", (sourceSha, pid) => ({ sourceSha, pid, version: "0.1.0" })),
    stop: adapter("stop", (_sourceSha, pid) => ({ pid, joined: true })),
    cleanup: async () => ({ ok: cleanupOk }),
  };
}

/** A trace as the order of its steps, so a test names the order the fixture writes. */
const stepOrder = (trace) => trace.map((item) => (item.slot === undefined ? item.action : `${item.action}:${item.slot}`));

test("the traces the fixture itself writes are read as the runs they record", { skip: process.platform === "win32" ? "private capture modes need POSIX" : false }, async () => {
  // Every other trace here is written by hand in the order this producer
  // assumes the fixture writes it.  These are written by the fixture, over a
  // real two-commit source, so a change to the fixture's step order makes
  // this test red instead of making the producer misread every real run.
  const f = await sourceFixture();
  try {
    const priorSteps = ["installDependencies:prior", "buildUi:prior", "start:prior", "health:prior", "stop:prior"];
    const candidateBuilt = ["installDependencies:candidate", "buildUi:candidate"];
    const rollback = ["start:prior", "health:prior", "stop:prior"];
    const main = [...priorSteps, ...candidateBuilt, "start:candidate", "health:candidate", "stop:candidate"];
    const pass = { "clean-export-build": 0, "install-start": 0, update: 0, rollback: 0 };
    const scenarios = [
      { name: "every step succeeds", order: [...main, ...rollback], codes: pass },
      {
        name: "the candidate's health step fails",
        failures: ["health:candidate:1"],
        order: [...priorSteps, ...candidateBuilt, "start:candidate", "stop:candidate", "candidate-refused", ...rollback],
        codes: { ...pass, update: 1 },
      },
      {
        name: "the candidate's first stop fails",
        failures: ["stop:candidate:1"],
        order: [...priorSteps, ...candidateBuilt, "start:candidate", "health:candidate", "candidate-refused", "stop:candidate", ...rollback],
        codes: { ...pass, update: 1 },
      },
      {
        name: "the candidate's start fails",
        failures: ["start:candidate:1"],
        order: [...priorSteps, ...candidateBuilt, "candidate-refused", "stop:candidate", ...rollback],
        codes: { ...pass, update: 1 },
      },
      {
        name: "the rollback's health step fails",
        failures: ["health:prior:2"],
        order: [...main, "start:prior", "rollback-refused", "stop:prior"],
        codes: { ...pass, rollback: 1 },
      },
      {
        name: "a fixture process is left behind",
        cleanupOk: false,
        order: main,
        codes: { ...pass, rollback: 1 },
      },
      {
        name: "the prior's start fails",
        failures: ["start:prior:1"],
        order: ["installDependencies:prior", "buildUi:prior", "candidate-refused", "stop:prior"],
        codes: { "clean-export-build": 1, "install-start": 1, update: 1, rollback: 1 },
      },
    ];

    let run = 0;
    for (const { name, failures, cleanupOk, order, codes } of scenarios) {
      const result = await runLinuxClosureFixture({
        repo: f.source,
        candidate: f.current,
        prior: f.previous,
        output: join(f.root, `run-${run += 1}`),
        execute: true,
        adapters: stubAdapters({ failures, cleanupOk }),
      });
      assert.deepEqual(stepOrder(result.trace), order, `${name}: the order the fixture writes`);

      const captureDir = makeCapture({ result, candidate: f.current, prior: f.previous });
      const receipt = emit(captureDir, { request: makeRequest(f.candidate) });
      assert.deepEqual(exitCodes(receipt), codes, name);
      assert.equal(receipt.data.maintainedSourceSha, f.candidate);
      assert.equal(receipt.data.rollbackSourceSha, f.prior);
    }
  } finally {
    f.close();
  }
});

/** The complete command line for a capture directory, as flag-and-value pairs. */
function cliPairs(captureDir) {
  const requestPath = join(captureDir, "request.json");
  writeFileSync(requestPath, JSON.stringify(makeRequest()), { mode: 0o600 });
  return [
    ["--capture", captureDir],
    ["--request", requestPath],
    ["--result", join(captureDir, "actual-source-runtime-result.json")],
    ["--candidate-closure", join(captureDir, "candidate-closure.json")],
    ["--prior-closure", join(captureDir, "prior-closure.json")],
    ["--provenance-record", join(captureDir, "provenance.txt")],
    ["--provenance-source", PROVENANCE.source],
    ["--provenance-by", PROVENANCE.by],
    ["--provenance-at", PROVENANCE.at],
  ];
}

/**
 * Run the CLI with an exact argument list.  The time limit turns a command
 * that waits on its input into a failed test instead of a hung one.
 */
function spawnCli(argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", timeout: 60_000 });
}

/**
 * Run the CLI against a capture directory.  `change` receives the complete
 * command line as pairs and returns the pairs to run, so a test names exactly
 * the one thing it takes away or replaces.
 */
function runCli(captureDir, change = (pairs) => pairs) {
  return spawnCli(change(cliPairs(captureDir)).flat());
}

/** A refused command says why on one line, prints no result and leaves no receipt. */
function assertCliRefused(proc, captureDir, pattern) {
  assert.equal(proc.status, 2, proc.stderr);
  assert.match(proc.stderr, pattern);
  assert.equal(proc.stderr.trimEnd().includes("\n"), false);
  assert.equal(proc.stdout, "");
  assert.equal(existsSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)), false);
}

test("the CLI exits zero for a complete run and prints the checks it wrote", () => {
  const captureDir = makeCapture();
  const proc = runCli(captureDir);
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout), {
    emitted: [LINUX_RETENTION_RECEIPT_FILE],
    checks: REQUIRED_CHECKS["linux-retention"].map((name) => ({ name, exitCode: 0 })),
  });
  const parsed = parseEvidenceReceipt("linux-retention", readFileSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)));
  assert.equal(parsed.provenance.at, PROVENANCE.at);
});

test("the CLI exits one for an honest failure and still writes the failing receipt", () => {
  const rollback = rollbackSteps();
  const trace = [...mainSteps(), rollback[0], { action: "rollback-refused" }, rollback[2]];
  const captureDir = makeCapture({ result: makeResult(trace) });
  const proc = runCli(captureDir);
  assert.equal(proc.status, 1, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout).checks.at(-1), { name: "rollback", exitCode: 1 });
  assert.equal(existsSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)), true);
});

test("the CLI exits two for a refusal and writes nothing", () => {
  const captureDir = makeCapture({ result: makeResult(undefined, { rollbackHealthy: false }) });
  const proc = runCli(captureDir);
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /emit-linux-retention-receipt refused: the retained-run result does not match the contract/);
  assert.equal(proc.stdout, "");
  assert.equal(existsSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)), false);
});

test("the CLI refuses a required flag that is missing its value", () => {
  // The command line is complete except for one value, so nothing but that
  // value can be what the command refuses.  Read loosely, `--provenance-by`
  // would take the next flag as its value and the receipt would say it was
  // made by "--provenance-at".
  const captureDir = makeCapture();
  const proc = runCli(captureDir, (pairs) => pairs.map(([flag, value]) => (flag === "--provenance-by" ? [flag] : [flag, value])));
  assertCliRefused(proc, captureDir, /refused: --provenance-by needs a value$/m);

  // The last flag on the line, with nothing after it.
  const last = makeCapture();
  const trailing = runCli(last, (pairs) => [...pairs.filter(([flag]) => flag !== "--provenance-by" && flag !== "--provenance-at"), ["--provenance-by"]]);
  assertCliRefused(trailing, last, /refused: --provenance-by needs a value$/m);
});

test("the CLI refuses a required flag that is absent", () => {
  const captureDir = makeCapture();
  const proc = runCli(captureDir, (pairs) => pairs.filter(([flag]) => flag !== "--prior-closure"));
  assertCliRefused(proc, captureDir, /--capture, --request, .* and --provenance-by are required/);
});

test("the CLI refuses --provenance-at without a value instead of stamping the current time", () => {
  // `--provenance-at $RUN_AT` with the variable unset leaves the flag with no
  // value, or with the next flag as one.  The bundle orders receipts by this
  // time, so the command does not guess it.
  const followed = makeCapture();
  const beforeAnother = runCli(followed, (pairs) => [
    ...pairs.filter(([flag]) => flag !== "--provenance-at" && flag !== "--provenance-by"),
    ["--provenance-at"],
    ["--provenance-by", PROVENANCE.by],
  ]);
  assertCliRefused(beforeAnother, followed, /refused: --provenance-at needs a value$/m);

  const ending = makeCapture();
  const atTheEnd = runCli(ending, (pairs) => [...pairs.filter(([flag]) => flag !== "--provenance-at"), ["--provenance-at"]]);
  assertCliRefused(atTheEnd, ending, /refused: --provenance-at needs a value$/m);

  const blank = makeCapture();
  const empty = runCli(blank, (pairs) => pairs.map(([flag, value]) => (flag === "--provenance-at" ? [flag, ""] : [flag, value])));
  assertCliRefused(empty, blank, /refused: --provenance-at needs a value$/m);
});

test("the CLI stamps the current time only when --provenance-at is absent", () => {
  const captureDir = makeCapture();
  const before = Date.now();
  const proc = runCli(captureDir, (pairs) => pairs.filter(([flag]) => flag !== "--provenance-at"));
  const after = Date.now();
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = parseEvidenceReceipt("linux-retention", readFileSync(join(captureDir, LINUX_RETENTION_RECEIPT_FILE)));
  const stamped = Date.parse(parsed.provenance.at);
  assert.ok(stamped >= before && stamped <= after, parsed.provenance.at);
});

test("the CLI refuses an argument it does not read, so a misspelled flag is never ignored", () => {
  const misspelled = makeCapture();
  const proc = runCli(misspelled, (pairs) => pairs.map(([flag, value]) => (flag === "--provenance-at" ? ["--provenance-att", value] : [flag, value])));
  assertCliRefused(proc, misspelled, /refused: "--provenance-att" is not an argument this command reads/);

  // A value with no flag in front of it is not read either.
  const stray = makeCapture();
  const positional = runCli(stray, (pairs) => [...pairs, ["leftover"]]);
  assertCliRefused(positional, stray, /refused: "leftover" is not an argument this command reads/);
});

test("the CLI refuses a flag given twice", () => {
  const captureDir = makeCapture();
  const proc = runCli(captureDir, (pairs) => [...pairs, ["--provenance-at", "2026-11-18T05:15:00.000Z"]]);
  assertCliRefused(proc, captureDir, /refused: --provenance-at is given more than once$/m);
});

test("a refusal prints text from the result as one bounded line of printable characters", () => {
  // The proof label is the result's own text.  An escape sequence in it must
  // not reach the terminal and a line break must not forge a second line.
  // Beside the escape, the line break and the bidirectional override, the
  // three Unicode line terminators:  NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR.
  const unprintable = ["\n", "\u001b", "\u009b", "\u202e", "\u0085", "\u2028", "\u2029"];
  const clean = (text) => unprintable.every((character) => !text.includes(character));

  const hostile = makeCapture({
    result: makeResult(undefined, { proof: "\u001b[2JPASSED\nok\u009b0m\u202e\u0085\u2028\u2029" }),
  });
  const proof = runCli(hostile);
  assertCliRefused(proof, hostile, /reports the proof "\\u\{1b\}\[2JPASSED\\u\{a\}ok\\u\{9b\}0m\\u\{202e\}\\u\{85\}\\u\{2028\}\\u\{2029\}"/);
  assert.equal(clean(proof.stderr.trimEnd()), true);

  // The name of a field the fixture does not write is the result's text too,
  // and it may be nearly as long as the file.
  const key = `${"k".repeat(5000)}\nforged: ok\u001b[2J`;
  const noisy = makeCapture({ result: makeResult(undefined, { [key]: true }) });
  const field = runCli(noisy);
  assertCliRefused(field, noisy, /the retained-run result does not match the contract: .*k{1000}/);
  assert.equal(clean(field.stderr.trimEnd()), true);
  assert.ok(field.stderr.length < 2400, `stderr is ${field.stderr.length} characters`);

  // The same holds for a caller of the module, which prints the message itself.
  assert.throws(() => emit(noisy), (error) => error.message.length < 2400 && clean(error.message));
  assert.throws(() => emit(hostile), (error) => clean(error.message));

  // A path is the operator's own text, and a refusal that repeats it is
  // printed the same way.
  const named = makeCapture();
  const path = runCli(named, (pairs) => pairs.map(([flag, value]) => (flag === "--result" ? [flag, join(named, "absent\nforged: ok.json")] : [flag, value])));
  assertCliRefused(path, named, /the retained-run result could not be read: .*absent\\u\{a\}forged: ok\.json$/m);
});

test("a refusal tells text that spells an escape apart from a character that was escaped", () => {
  // A label that literally reads `\u{1b}` is not an ESC.  Printed alike, the
  // two would be indistinguishable in a captured refusal log.
  const spelled = makeCapture({ result: makeResult(undefined, { proof: "\\u{1b}[2J" }) });
  const literal = runCli(spelled);
  assertCliRefused(literal, spelled, /reports the proof "\\\\u\{1b\}\[2J" and the fixture reports/);

  const real = makeCapture({ result: makeResult(undefined, { proof: "\u001b[2J" }) });
  const escaped = runCli(real);
  assertCliRefused(escaped, real, /reports the proof "\\u\{1b\}\[2J" and the fixture reports/);
  assert.notEqual(literal.stderr.split("the proof")[1], escaped.stderr.split("the proof")[1]);

  // A backslash in a path is doubled once, and the refusal line does not
  // double it again on its way to the terminal.
  const named = makeCapture();
  const path = runCli(named, (pairs) => pairs.map(([flag, value]) => (flag === "--result" ? [flag, join(named, "back\\slash\nabsent.json")] : [flag, value])));
  assertCliRefused(path, named, /the retained-run result could not be read: .*back\\\\slash\\u\{a\}absent\.json$/m);
});

test("a caller of the module gets paths that are as printable as the CLI prints them", () => {
  // The CLI's last step cleans up a refusal line, but a caller of the module
  // prints the message itself, so the text is made printable where it is quoted.
  const clean = (text) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text);
  const captureDir = makeCapture();
  const hostile = (name) => join(captureDir, `${name}\n\u001b[2J\u2028forged.json`);

  assert.throws(() => emit(captureDir, { resultPath: hostile("absent") }), (error) => {
    assert.match(error.message, /the retained-run result could not be read: .*absent\\u\{a\}\\u\{1b\}\[2J\\u\{2028\}forged\.json$/);
    return clean(error.message);
  });

  // A file that is there but is not inside the capture directory, and one the
  // bundle's reader refuses, both quote the path the same way.
  const outside = makeCapture();
  const stray = join(outside, "stray\u001b[2J.json");
  writeFileSync(stray, "{}\n", { mode: 0o600 });
  assert.throws(() => emit(captureDir, { priorClosurePath: stray }), (error) => {
    assert.match(error.message, /not inside the capture directory: .*stray\\u\{1b\}\[2J\.json$/);
    return clean(error.message);
  });

  const unreadable = join(captureDir, "open\u001b[2J.json");
  copyFileSync(join(captureDir, "prior-closure.json"), unreadable);
  chmodSync(unreadable, 0o644);
  assert.throws(() => emit(captureDir, { priorClosurePath: unreadable }), (error) => {
    assert.match(error.message, /the prior closure receipt is not a file the evidence bundle will read \(.*\): .*open\\u\{1b\}\[2J\.json$/);
    return clean(error.message);
  });

  // The capture directory's own path is quoted the same way.
  assert.throws(() => emit(join(captureDir, "absent\u001b[2J")), (error) => clean(error.message));
});

test("the CLI refuses a bundle request that is a symlink or has other links", (t) => {
  // The request is read from an open handle that is checked, so it is the
  // file the path names and not one a link has put in its place.
  const linked = makeCapture();
  const target = join(linked, "request-target.json");
  writeFileSync(target, JSON.stringify(makeRequest()), { mode: 0o600 });
  const link = join(linked, "request-link.json");
  symlinkSync(target, link);
  const asSymlink = runCli(linked, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, link] : [flag, value])));
  assertCliRefused(asSymlink, linked, /refused: the bundle request is a symbolic link, and a request is read only as the file it is: /);

  const hard = makeCapture();
  const request = join(hard, "request-hard.json");
  writeFileSync(request, JSON.stringify(makeRequest()), { mode: 0o600 });
  linkSync(request, join(hard, "request-hard-copy.json"));
  const asHardLink = runCli(hard, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, request] : [flag, value])));
  assertCliRefused(asHardLink, hard, /refused: the bundle request has 2 links, and a request is read only as a single-link file: /);

  // A directory reached through a symlink is not the file's own name, so a
  // request in it is still read.
  const through = makeCapture();
  const outer = mkdtempSync(join(tmpdir(), "linux-retention-request-"));
  const alias = join(outer, "alias");
  symlinkSync(through, alias);
  const aliased = runCli(through, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, join(alias, "request.json")] : [flag, value])));
  assert.equal(aliased.status, 0, aliased.stderr);
  t.diagnostic("a request in a symlinked directory is read");
});

test("the CLI refuses a bundle request that is not a bounded regular file", (t) => {
  const directory = makeCapture();
  const asDirectory = runCli(directory, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, directory] : [flag, value])));
  assertCliRefused(asDirectory, directory, /refused: the bundle request is not a regular file: /);

  const absent = makeCapture();
  const missing = runCli(absent, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, join(absent, "absent.json")] : [flag, value])));
  assertCliRefused(missing, absent, /refused: the bundle request could not be read: /);

  const large = makeCapture();
  const oversized = join(large, "oversized-request.json");
  writeFileSync(oversized, " ".repeat(MAX_EVIDENCE_FILE_BYTES + 1), { mode: 0o600 });
  const tooLarge = runCli(large, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, oversized] : [flag, value])));
  assertCliRefused(tooLarge, large, new RegExp(`refused: the bundle request is ${MAX_EVIDENCE_FILE_BYTES + 1} bytes and at most ${MAX_EVIDENCE_FILE_BYTES} bytes of one are read: `));

  const garbled = makeCapture();
  const notJson = join(garbled, "garbled-request.json");
  writeFileSync(notJson, "{ not json", { mode: 0o600 });
  const unreadable = runCli(garbled, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, notJson] : [flag, value])));
  assertCliRefused(unreadable, garbled, /refused: the bundle request could not be read as JSON: /);

  // A pipe nobody writes to:  a command that read it would wait until the
  // time limit killed it, and its status would not be 2.
  const piped = makeCapture();
  const pipe = join(piped, "request.pipe");
  if (spawnSync("mkfifo", ["-m", "600", pipe]).status !== 0) {
    t.diagnostic("mkfifo is not available here, so the pipe case did not run");
    return;
  }
  const asPipe = runCli(piped, (pairs) => pairs.map(([flag, value]) => (flag === "--request" ? [flag, pipe] : [flag, value])));
  assertCliRefused(asPipe, piped, /refused: the bundle request is not a regular file: /);
});

test("the CLI runs when the script is invoked through a symlink", () => {
  // Node's ESM loader resolves symlinks for `import.meta.url` and leaves
  // `process.argv[1]` as it was typed, so an entry check that compared the two
  // unresolved paths would look like an import and quietly do nothing.
  const directory = mkdtempSync(join(tmpdir(), "linux-retention-link-"));
  const link = join(directory, "emit-linux-retention-receipt.mjs");
  symlinkSync(SCRIPT, link);

  const proc = spawnSync(process.execPath, [link], { encoding: "utf8" });
  // The CLI refuses without its arguments and says so;  an import would print
  // nothing at all and exit zero.
  assert.match(proc.stderr, /emit-linux-retention-receipt refused/);
  assert.notEqual(proc.status, 0);
});
