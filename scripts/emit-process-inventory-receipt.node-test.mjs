// Fixtures for the `process-inventory` receipt.
//
// The properties under test are the ones the bundle's authority rests on:  a
// check's exit code comes out of the file the check names, `macHarness:
// "absent"` is written only when the verdict observed a Mac with no harness
// on it, a verdict that cannot be an observation of a Mac is refused, and the
// receipt is the shape `scripts/decommission-evidence-bundle.mjs` validates.
// Each of those has a fixture that fails against a broken implementation, so
// a regression is a red test rather than a receipt that certifies a
// retirement nobody observed.
//
// Every verdict, inventory row and receipt below is synthetic and lives in a
// private temporary directory.  Nothing here runs `launchctl`, `ps` or
// `lsof`, and nothing contacts a harness:  the only process started is this
// repository's own producer script, which starts none itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { BOTFLEET_AGENTS, evaluatePostReboot } from "./check-post-reboot-node.mjs";
import { HAND_RUN_PLACEMENT_EVIDENCE, REQUIRED_PLACEMENT_EVIDENCE } from "./check-placement-evidence.mjs";
import {
  assertReceiptBinding,
  checkFinalEvidenceBundle,
  evidenceHash,
  MAX_EVIDENCE_FILE_BYTES,
  parseEvidenceReceipt,
  REQUIRED_CHECKS,
  REQUIRED_RECEIPTS,
  REQUIRED_SURFACES,
} from "./decommission-evidence-bundle.mjs";
import {
  emitProcessInventoryReceipt,
  harnessChecks,
  judgeInventoryRows,
  liveWording,
  parsePostRebootVerdict,
  PROCESS_INVENTORY_RECEIPT_FILE,
  readPostRebootVerdict,
  retiredMarker,
  writeReceiptFile,
} from "./emit-process-inventory-receipt.mjs";

const script = fileURLToPath(new URL("./emit-process-inventory-receipt.mjs", import.meta.url));
const onPosix = { skip: process.platform === "win32" ? "Private POSIX ownership cannot be proved on Windows" : false };

const directories = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A private temporary directory that is removed when the file's tests end. */
function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A request the receipt is bound to. */
function makeRequest() {
  return {
    version: 1,
    candidate: { sourceSha: "a".repeat(40), build: "202610010900", artifactSha256: "b".repeat(64) },
    mode: "serverFirst",
    hosts: [
      { id: "mac:00000000-0000-4000-8000-000000000001", role: "mac" },
      { id: "server:00000000-0000-4000-8000-000000000002", role: "server" },
    ],
    acceptanceOwner: "synthetic fixture owner",
    engines: ["fixture-engine"],
    state: { path: "state.json", sha256: "c".repeat(64) },
    receipts: {},
  };
}

/**
 * A verdict the reboot check would have printed on a Mac.
 *
 * The summary is computed by the check's own aggregator out of the details,
 * and the launchd probes are the ones that would have produced the loaded
 * agents, so the fixture is self-consistent unless a test overrides a field
 * to make it otherwise.
 */
function makeVerdict(details = {}, overrides = {}) {
  const computed = evaluatePostReboot({ processes: [], launchAgents: [], portListeners: [], gitFiles: [], probeErrors: [], ...details });
  const loaded = new Set(computed.details.launchAgents.map((agent) => agent.label));
  return {
    ok: computed.ok,
    failures: computed.failures,
    details: computed.details,
    platform: "darwin",
    launchDomain: { uid: 501, target: "gui/501", observed: true, skipped: false },
    launchProbes: BOTFLEET_AGENTS.map((label) => ({ label, loaded: loaded.has(label), running: loaded.has(label), skipped: false })),
    ...overrides,
  };
}

/** Inventory rows in the three table shapes the inventory files the harness under, all retired. */
const RETIRED_ROWS = `${[
  "| `app.botfleet.server` | **Retired 2026-10-04** (owner, BF-2514) | Was the always-on BotFleet harness on `127.0.0.1:8799`.  The server is the writer now. |",
  "| `~/apps/botfleet-server-start.sh` | **Retired 2026-10-04** (owner, BF-2514).  Was the wrapper the job ran;  removed with the job. |",
  "| `app.botfleet.server` via `~/apps/botfleet-server-start.sh` | Was an always-on LaunchAgent | None;  the job is gone | **Retired Oct 4, 2026** (BF-2514) |",
].join("\n")}\n`;

/** The same rows as the inventory holds them while the harness is still installed. */
const LIVE_ROWS = `${[
  "| `app.botfleet.server` | Always-on | The BotFleet harness on `127.0.0.1:8799`.  A loaded job keeps firing on its timer. |",
  "| `~/apps/botfleet-server-start.sh` | **Down** (verified Oct 28, 2026).  The harness this wrapper launches is held down. |",
].join("\n")}\n`;

/** Rows that talk about a retirement without recording one. */
const PLANNED_ROWS = `${[
  "| `app.botfleet.server` | Parked | Retirement plan:  to be retired at the BF-2514 cutover. |",
  "| `~/apps/botfleet-server-start.sh` | On-demand | Retired with the job once BF-2514 lands;  see the retirement plan. |",
].join("\n")}\n`;

const PROVENANCE = {
  by: "synthetic fixture runner",
  at: "2026-10-05T17:00:00.000Z",
  source: "https://example.invalid/synthetic-test-only",
};

/** A private capture directory holding a verdict, the captured rows and a provenance record. */
function makeCapture({ verdict = makeVerdict(), verdictText = `${JSON.stringify(verdict, null, 2)}\n`, rows = RETIRED_ROWS } = {}) {
  const captureDir = temporaryDirectory("process-inventory-capture-");
  writeFileSync(join(captureDir, "post-reboot-verdict.json"), verdictText, { mode: 0o600 });
  writeFileSync(join(captureDir, "inventory-rows.md"), rows, { mode: 0o600 });
  writeFileSync(join(captureDir, "provenance.txt"), "SYNTHETIC FIXTURE ONLY: this is not a runtime result\n", { mode: 0o600 });
  return captureDir;
}

function emit(captureDir, overrides = {}) {
  return emitProcessInventoryReceipt({
    captureDir,
    request: makeRequest(),
    verdictPath: join(captureDir, "post-reboot-verdict.json"),
    inventoryRowsPath: join(captureDir, "inventory-rows.md"),
    provenance: { ...PROVENANCE, record: join(captureDir, "provenance.txt") },
    ...overrides,
  });
}

function exitCodes(result) {
  return Object.fromEntries(result.checks.map((check) => [check.name, check.exitCode]));
}

function receiptExists(captureDir) {
  return existsSync(join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE));
}

/**
 * Put the emitted receipt into a complete packet and run the bundle's own
 * final check over it.  Every other receipt is a synthetic stand-in, the way
 * `decommission-evidence.node-test.mjs` builds them;  the `process-inventory`
 * receipt is the file the producer wrote, byte for byte.
 *
 * `reference` is the entry the request's `receipts` object carries for it:
 * the producer's own `reference`, or `null` for a request that does not name
 * the receipt at all.
 */
function finalBundleVerdict(captureDir, request, reference) {
  const put = (path, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    mkdirSync(dirname(join(captureDir, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(captureDir, path), bytes, { mode: 0o600 });
    return { path, sha256: evidenceHash(bytes) };
  };
  const log = put("synthetic.log", Buffer.from("SYNTHETIC FIXTURE ONLY: this is not an owner statement or a runtime result\n"));
  const serverHost = request.hosts[1].id;
  const bundle = { ...request, state: put("state.json", { synthetic: true }), receipts: {} };
  for (const kind of REQUIRED_RECEIPTS) {
    if (kind === "process-inventory") {
      if (reference !== null) {
        bundle.receipts[kind] = reference ?? {
          path: PROCESS_INVENTORY_RECEIPT_FILE,
          sha256: evidenceHash(readFileSync(join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE))),
        };
      }
      continue;
    }
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
      const segment = { startedAt, endedAt, log, continuity: "uninterrupted", selectedWriterHostId: serverHost, controllerId: serverHost, controllerEpoch: 3 };
      if (kind === "daily-driver") Object.assign(segment, { nativeApp: "signed-native-daily-driver", iosSession: "passed", openOnMac: "passed", processInventory: "recorded" });
      else Object.assign(segment, { macHarness: kind === "server-writer-soak" ? "loaded-unused" : "absent", surfaces: Object.fromEntries(REQUIRED_SURFACES.map((key) => [key, "passed"])) });
      if (kind === "server-writer-soak") Object.assign(segment, { inboundMessages: 1, serverSharedRoutineRuns: 1, macSharedRoutineRuns: 0 });
      data = { startedAt, endedAt, segments: [segment] };
    } else if (kind === "owner-acceptance") {
      data = { decision: "accepted", action: "delete-mac-local-node-source", dailyDriverAccepted: true };
    } else {
      const names = kind === "replay" ? request.engines.map((engine) => `engine:${engine}`) : REQUIRED_CHECKS[kind];
      data = { checks: names.map((name) => ({ name, exitCode: 0, artifact: log })) };
      if (kind === "signed-release") Object.assign(data, { bundleId: "app.botfleet.macos", teamId: "FIXTURE", designatedRequirement: "synthetic fixture requirement", previousBuild: "202609300900" });
      if (kind === "linux-retention") Object.assign(data, { maintainedSourceSha: request.candidate.sourceSha, rollbackSourceSha: "c".repeat(40), closureManifest: log });
      if (kind === "change-plan") Object.assign(data, { jobs: ["fixture retirement job"], files: ["fixture deletion diff"], appCopies: ["fixture app replacement"] });
    }
    bundle.receipts[kind] = put(`${kind}.json`, {
      version: 1, kind, candidate: request.candidate, mode: request.mode, hosts: request.hosts,
      provenance: { by: kind === "owner-acceptance" ? request.acceptanceOwner : "synthetic fixture runner", at: "2026-10-11T00:00:00Z", source: "https://example.invalid/synthetic-test-only", record: log },
      data,
    });
  }
  put("bundle.json", bundle);
  return checkFinalEvidenceBundle(join(captureDir, "bundle.json"), {
    statePath: join(captureDir, "state.json"),
    stateBytes: readFileSync(join(captureDir, "state.json")),
    candidate: request.candidate,
    now: Date.parse("2026-10-12T00:00:00Z"),
  });
}

test("a clean Mac verdict and retired rows earn four passing checks the bundle accepts", onPosix, () => {
  const request = makeRequest();
  const captureDir = makeCapture();

  const result = emit(captureDir);

  assert.equal(result.macHarness, "absent");
  assert.deepEqual(exitCodes(result), { processes: 0, launchd: 0, listeners: 0, "inventory-updated": 0 });
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.receipt.data.checks.map((check) => check.name), REQUIRED_CHECKS["process-inventory"]);

  // Each check cites the file its exit code was read from, bound by hash.
  const artifacts = Object.fromEntries(result.receipt.data.checks.map((check) => [check.name, check.artifact]));
  for (const name of ["processes", "launchd", "listeners"]) {
    assert.equal(artifacts[name].path, "post-reboot-verdict.json");
    assert.equal(artifacts[name].sha256, evidenceHash(readFileSync(join(captureDir, "post-reboot-verdict.json"))));
  }
  assert.equal(artifacts["inventory-updated"].path, "inventory-rows.md");
  assert.equal(artifacts["inventory-updated"].sha256, evidenceHash(readFileSync(join(captureDir, "inventory-rows.md"))));

  // The receipt is the shape the bundle validates, and it is bound to the
  // same candidate as the request.
  const parsed = parseEvidenceReceipt("process-inventory", readFileSync(join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE)));
  assert.doesNotThrow(() => assertReceiptBinding(parsed, request));
  assert.equal(parsed.data.macHarness, "absent");
  assert.equal(parsed.provenance.record.path, "provenance.txt");

  // The producer hands back the entry the request has to carry for it.
  assert.deepEqual(result.reference, {
    path: PROCESS_INVENTORY_RECEIPT_FILE,
    sha256: evidenceHash(readFileSync(join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE))),
  });

  // And a complete packet whose request carries that entry passes the
  // bundle's own final check.
  const verdict = finalBundleVerdict(captureDir, request, result.reference);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.ok, true);
});

test("a request that does not name the emitted receipt is blocked, so the producer's reference is the registration", onPosix, () => {
  // The collector reads only a receipt the request names by path and hash.
  // Without the entry the packet is refused whatever the receipt says, which
  // is why the producer prints it and the runbook says to merge it.
  const request = makeRequest();
  const captureDir = makeCapture();
  emit(captureDir);

  const unregistered = finalBundleVerdict(captureDir, request, null);
  assert.equal(unregistered.ok, false);
  assert.ok(unregistered.blockers.includes("process-inventory: missing-receipt"), unregistered.blockers.join("\n"));
});

test("the receipt is written owner-only", () => {
  const captureDir = makeCapture();
  emit(captureDir);
  assert.equal(statSync(join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE)).mode & 0o777, 0o600);
});

test("a lingering process fails `processes` and no receipt is written", () => {
  const captureDir = makeCapture({
    verdict: makeVerdict({ processes: [{ pid: "1234", user: "jay", command: "node /Users/jay/apps/botfleet-server/server/index.ts", identity: "node" }] }),
  });

  const result = emit(captureDir);

  assert.deepEqual(exitCodes(result), { processes: 1, launchd: 0, listeners: 0, "inventory-updated": 0 });
  assert.equal(result.macHarness, "present");
  assert.equal(result.receipt, null);
  assert.equal(result.reference, null);
  assert.equal(receiptExists(captureDir), false);
  assert.match(result.reasons.join("\n"), /processes: 1 BotFleet process/);
});

test("a loaded launch agent fails `launchd` and no receipt is written", () => {
  const captureDir = makeCapture({
    verdict: makeVerdict({ launchAgents: [{ label: "app.botfleet.server", running: true, details: "state = running" }] }),
  });

  const result = emit(captureDir);

  assert.deepEqual(exitCodes(result), { processes: 0, launchd: 1, listeners: 0, "inventory-updated": 0 });
  assert.equal(result.receipt, null);
  assert.equal(receiptExists(captureDir), false);
  assert.match(result.reasons.join("\n"), /launchd: still loaded: app\.botfleet\.server/);
});

test("a Node listener fails `listeners` and no receipt is written", () => {
  const captureDir = makeCapture({
    verdict: makeVerdict({ portListeners: [{ port: 8799, pid: "1234", command: "node", address: "127.0.0.1:8799", isNode: true }] }),
  });

  const result = emit(captureDir);

  assert.deepEqual(exitCodes(result), { processes: 0, launchd: 0, listeners: 1, "inventory-updated": 0 });
  assert.equal(result.receipt, null);
  assert.equal(receiptExists(captureDir), false);
  assert.match(result.reasons.join("\n"), /listeners: port 8799/);
});

test("a listener that is not Node, Electron or BotFleet does not fail `listeners`", () => {
  const captureDir = makeCapture({
    verdict: makeVerdict({ portListeners: [{ port: 8800, pid: "77", command: "python3", address: "127.0.0.1:8800", isNode: false }] }),
  });
  assert.deepEqual(exitCodes(emit(captureDir)), { processes: 0, launchd: 0, listeners: 0, "inventory-updated": 0 });
});

test("the native app listening on a watched port inherits the reboot check's failing verdict", () => {
  // The reboot check flags any listener whose command reads as Node, Electron
  // or BotFleet, and the producer does not loosen that.
  const captureDir = makeCapture({
    verdict: makeVerdict({ portListeners: [{ port: 8811, pid: "4322", command: "BotFleet", address: "127.0.0.1:8811", isNode: true }] }),
  });
  const result = emit(captureDir);
  assert.equal(exitCodes(result).listeners, 1);
  assert.equal(result.receipt, null);
});

test("a probe error fails all three harness checks", () => {
  const captureDir = makeCapture({
    verdict: makeVerdict({ probeErrors: ["ps aux probe failed: spawnSync ps ETIMEDOUT"] }),
  });

  const result = emit(captureDir);

  assert.deepEqual(exitCodes(result), { processes: 1, launchd: 1, listeners: 1, "inventory-updated": 0 });
  assert.equal(result.receipt, null);
  assert.equal(receiptExists(captureDir), false);
});

test("a dirty verdict removes the receipt an earlier clean run left behind", () => {
  const captureDir = makeCapture();
  emit(captureDir);
  assert.equal(receiptExists(captureDir), true);

  const dirty = makeVerdict({ launchAgents: [{ label: "app.botfleet.server", running: true, details: "state = running" }] });
  writeFileSync(join(captureDir, "post-reboot-verdict.json"), `${JSON.stringify(dirty, null, 2)}\n`, { mode: 0o600 });

  assert.equal(emit(captureDir).receipt, null);
  assert.equal(receiptExists(captureDir), false);
});

test("files listed by --check-git do not decide the harness checks", () => {
  // Before the Phase 6 deletion a `--check-git` verdict always lists files, so
  // its summary is failing while the three harness observations are clean.
  const verdict = makeVerdict({ gitFiles: ["server/index.ts", "electron/main.mjs"] });
  assert.equal(verdict.ok, false);
  const captureDir = makeCapture({ verdict });
  const result = emit(captureDir);
  assert.deepEqual(exitCodes(result), { processes: 0, launchd: 0, listeners: 0, "inventory-updated": 0 });
  assert.equal(result.macHarness, "absent");
});

test("a verdict taken off macOS is refused", () => {
  // Off macOS the reboot check skips every launchd probe, so this is the
  // verdict the server prints:  no agent loaded, and nothing observed.
  const linux = makeVerdict({}, {
    platform: "linux",
    launchDomain: { uid: 1001, target: null, observed: false, skipped: true },
    launchProbes: BOTFLEET_AGENTS.map((label) => ({ label, loaded: false, running: false, skipped: true })),
  });
  const captureDir = makeCapture({ verdict: linux });
  assert.throws(() => emit(captureDir), /taken on "linux" and not on macOS/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict with a skipped launchd probe is refused", () => {
  const verdict = makeVerdict();
  verdict.launchProbes[1].skipped = true;
  const captureDir = makeCapture({ verdict });
  assert.throws(() => emit(captureDir), /skipped the launchd probe for "app\.botfleet\.companion"/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict that does not probe every launch agent is refused", () => {
  const verdict = makeVerdict();
  verdict.launchProbes = verdict.launchProbes.filter((probe) => probe.label !== "app.botfleet.server");
  assert.throws(() => emit(makeCapture({ verdict })), /carries no launchd probe for "app\.botfleet\.server"/);
});

test("a verdict that probes one launch agent twice is refused", () => {
  const verdict = makeVerdict();
  verdict.launchProbes.push({ ...verdict.launchProbes[0] });
  assert.throws(() => emit(makeCapture({ verdict })), /probes the launch agent "app\.botfleet\.server" more than once/);
});

test("a verdict saved before the platform and the probes were printed is refused", () => {
  const legacy = makeVerdict();
  delete legacy.platform;
  delete legacy.launchDomain;
  delete legacy.launchProbes;
  const captureDir = makeCapture({ verdict: legacy });
  assert.throws(() => emit(captureDir), /does not match the contract/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict that does not say which launchd domain it asked is refused", () => {
  const verdict = makeVerdict();
  delete verdict.launchDomain;
  const captureDir = makeCapture({ verdict });
  assert.throws(() => emit(captureDir), /does not match the contract: launchDomain/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict whose launchd domain was not found is refused, though every agent reads as not loaded", () => {
  // The check ran over SSH with nobody logged in at the console.  launchd has
  // no `gui/501`, so every label answers "not found", no probe is skipped and
  // no probe errors:  the verdict is clean, and it observed nothing.
  const verdict = makeVerdict({}, { launchDomain: { uid: 501, target: "gui/501", observed: false, skipped: false } });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.launchProbes.every((probe) => !probe.loaded && !probe.skipped), true);
  const captureDir = makeCapture({ verdict });
  assert.throws(() => emit(captureDir), /could not find the launchd domain "gui\/501"/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict taken as root is refused, whatever launchd answered", () => {
  // Under sudo the probes ask `gui/0`, which is not where the owner's launch
  // agents live.  The refusal does not depend on whether that domain exists.
  for (const observed of [false, true]) {
    const verdict = makeVerdict({}, { launchDomain: { uid: 0, target: "gui/0", observed, skipped: false } });
    const captureDir = makeCapture({ verdict });
    assert.throws(() => emit(captureDir), /taken as root/);
    assert.equal(receiptExists(captureDir), false);
  }
});

test("a verdict whose launchd domain was skipped, or is not the user's own, is refused", () => {
  const skipped = makeVerdict({}, { launchDomain: { uid: 501, target: null, observed: false, skipped: true } });
  assert.throws(() => emit(makeCapture({ verdict: skipped })), /did not ask launchd for the user's GUI domain/);

  const elsewhere = makeVerdict({}, { launchDomain: { uid: 501, target: "system", observed: true, skipped: false } });
  assert.throws(() => emit(makeCapture({ verdict: elsewhere })), /asked the launchd domain "system", which is not the GUI domain of the user who ran it/);
});

test("a verdict whose ok contradicts its own details is refused", () => {
  const verdict = makeVerdict({ processes: [{ pid: "1234", user: "jay", command: "node server/index.ts", identity: "node" }] });
  const captureDir = makeCapture({ verdict: { ...verdict, ok: true, failures: [] } });
  assert.throws(() => emit(captureDir), /says ok is true and its own details recompute to false/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict whose failures are not the ones its details recompute to is refused", () => {
  const verdict = makeVerdict({ processes: [{ pid: "1234", user: "jay", command: "node server/index.ts", identity: "node" }] });
  const captureDir = makeCapture({ verdict: { ...verdict, failures: ["something else failed"] } });
  assert.throws(() => emit(captureDir), /failures are not the failures its own details recompute to/);
});

test("a listener whose stored flag contradicts its command is refused", () => {
  // The stored flag says the listener is not Node while its command is
  // `node`.  Read as stored, the verdict would be clean.
  const verdict = makeVerdict({ portListeners: [{ port: 8799, pid: "1234", command: "node", address: "127.0.0.1:8799", isNode: false }] });
  assert.equal(verdict.ok, true);
  const captureDir = makeCapture({ verdict });
  assert.throws(() => emit(captureDir), /flags the listener on port 8799 as not Node, which its own command contradicts/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict whose probes and loaded agents disagree is refused", () => {
  const verdict = makeVerdict();
  verdict.launchProbes[0].loaded = true;
  assert.throws(() => emit(makeCapture({ verdict })), /launchd probes and its loaded launch agents disagree about "app\.botfleet\.server"/);
});

test("a verdict that is not JSON is refused", () => {
  const captureDir = makeCapture({ verdictText: "Verdict: PASS\n" });
  assert.throws(() => emit(captureDir), /could not be read as JSON/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict that is missing is refused", () => {
  const captureDir = makeCapture();
  assert.throws(() => emit(captureDir, { verdictPath: join(captureDir, "absent.json") }), /post-reboot verdict could not be read/);
  assert.throws(() => readPostRebootVerdict(join(captureDir, "absent.json")), /post-reboot verdict could not be read/);
});

test("a verdict larger than the bundle reads is refused", () => {
  const verdict = makeVerdict();
  verdict.padding = "x".repeat(MAX_EVIDENCE_FILE_BYTES);
  const captureDir = makeCapture({ verdict });
  assert.throws(() => emit(captureDir), /over the bundle's file limit/);
  assert.equal(receiptExists(captureDir), false);
});

test("the harness checks fail closed on a verdict that never went through the boundary", () => {
  assert.deepEqual(harnessChecks({}), { processes: 1, launchd: 1, listeners: 1, reasons: ["the verdict carries no inspection details"] });
  // No platform and no probes:  the lists are empty and launchd was never observed.
  const unobserved = harnessChecks({ details: { processes: [], launchAgents: [], portListeners: [], probeErrors: [] } });
  assert.equal(unobserved.launchd, 1);
  // A launchd domain that was not found, or root's, fails `launchd` even when
  // every label reads as not loaded;  the same verdict with the owner's
  // domain observed passes it.
  const noDomain = harnessChecks(makeVerdict({}, { launchDomain: { uid: 501, target: "gui/501", observed: false, skipped: false } }));
  assert.deepEqual([noDomain.processes, noDomain.launchd, noDomain.listeners], [0, 1, 0]);
  const asRoot = harnessChecks(makeVerdict({}, { launchDomain: { uid: 0, target: "gui/0", observed: true, skipped: false } }));
  assert.equal(asRoot.launchd, 1);
  assert.equal(harnessChecks(makeVerdict()).launchd, 0);
  // A stored flag that hides a Node command is not trusted.
  const hidden = harnessChecks(makeVerdict({ portListeners: [{ port: 8799, pid: "1", command: "node", isNode: false }] }));
  assert.equal(hidden.listeners, 1);
  assert.deepEqual(parsePostRebootVerdict(Buffer.from(JSON.stringify(makeVerdict()))).details.processes, []);
});

test("rows that still describe a live job fail `inventory-updated` and the bundle refuses the receipt", onPosix, () => {
  const request = makeRequest();
  const captureDir = makeCapture({ rows: LIVE_ROWS });

  const result = emit(captureDir);

  // The harness is gone, so the receipt is honest and is written;  the
  // inventory has not caught up, so its check carries a failing code.
  assert.deepEqual(exitCodes(result), { processes: 0, launchd: 0, listeners: 0, "inventory-updated": 1 });
  assert.equal(result.macHarness, "absent");
  assert.equal(receiptExists(captureDir), true);
  assert.match(result.reasons.join("\n"), /inventory-updated: line 1 names app\.botfleet\.server and no cell after the name opens with "Retired" and a date/);
  assert.match(result.reasons.join("\n"), /inventory-updated: line 1 still says "always-on", "loaded" without the past-tense form/);

  const verdict = finalBundleVerdict(captureDir, request);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.blockers, ["process-inventory: command-did-not-pass"]);
});

test("rows that only mention a retirement plan fail `inventory-updated`", () => {
  const result = emit(makeCapture({ rows: PLANNED_ROWS }));
  assert.equal(exitCodes(result)["inventory-updated"], 1);
  assert.match(result.reasons.join("\n"), /line 1 names app\.botfleet\.server and no cell after the name opens with "Retired" and a date/);
  assert.match(result.reasons.join("\n"), /line 2 names botfleet-server-start\.sh and no cell after the name opens with "Retired" and a date/);
});

test("a name with no captured row fails `inventory-updated`", () => {
  const onlyTheJob = `${RETIRED_ROWS.split("\n")[0]}\n`;
  const result = emit(makeCapture({ rows: onlyTheJob }));
  assert.equal(exitCodes(result)["inventory-updated"], 1);
  assert.deepEqual(result.reasons, ["inventory-updated: no captured row names botfleet-server-start.sh"]);

  const empty = emit(makeCapture({ rows: "\n" }));
  assert.deepEqual(empty.reasons, [
    "inventory-updated: no captured row names app.botfleet.server",
    "inventory-updated: no captured row names botfleet-server-start.sh",
  ]);
});

test("a retired row that still carries live wording fails `inventory-updated`", () => {
  const rows = RETIRED_ROWS.replace("Was the always-on BotFleet harness", "The always-on BotFleet harness, still running");
  const verdict = judgeInventoryRows(rows, { capturedAt: PROVENANCE.at });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.reasons, ['line 1 still says "always-on", "running" without the past-tense form']);
});

test("a retirement dated after the capture, or on a day that does not exist, fails `inventory-updated`", () => {
  const future = judgeInventoryRows(RETIRED_ROWS.replaceAll("2026-10-04", "2026-12-01"), { capturedAt: PROVENANCE.at });
  assert.equal(future.ok, false);
  assert.match(future.reasons.join("\n"), /line 1 is retired on 2026-12-01, which is after 2026-10-05, the UTC date this receipt was captured on/);

  const impossible = judgeInventoryRows(RETIRED_ROWS.replaceAll("2026-10-04", "2026-02-30"), { capturedAt: PROVENANCE.at });
  assert.match(impossible.reasons.join("\n"), /line 1 opens a cell with "Retired" and a date that is not a real day/);
});

test("a retired row may carry the capture's UTC date and no later one", () => {
  // Captured late on Nov 20 on the owner's clock, which is already Nov 21 in
  // UTC.  The owner's date and the UTC date both pass.  The day after the UTC
  // date is in the future on every clock, and there is no day of slack for it.
  const capturedAt = "2026-11-20T23:30:00-06:00";
  const dated = (iso, written) => judgeInventoryRows(
    RETIRED_ROWS.replaceAll("2026-10-04", iso).replaceAll("Oct 4, 2026", written),
    { capturedAt },
  );
  assert.deepEqual(dated("2026-11-20", "Nov 20, 2026").reasons, []);
  assert.deepEqual(dated("2026-11-21", "Nov 21, 2026").reasons, []);

  const late = dated("2026-11-22", "Nov 22, 2026");
  assert.equal(late.ok, false);
  assert.deepEqual(late.reasons, [1, 2, 3].map((line) => `line ${line} is retired on 2026-11-22, which is after 2026-11-21, the UTC date this receipt was captured on`));
});

test("a line that is not a table row fails `inventory-updated`, and another job's row is noticed without being judged", () => {
  const prose = judgeInventoryRows(`Last inventory: app.botfleet.server retired.\n${RETIRED_ROWS}`, { capturedAt: PROVENANCE.at });
  assert.deepEqual(prose.reasons, ["line 1 is not a table row"]);

  // The watcher's row mentions the harness in its description and is not the
  // harness's row:  its first cell names another job.  It fails nothing, and
  // it is not passed over in silence either.
  const withNeighbour = `| Job | State | Notes |\n|---|---|---|\n| \`com.jay.mac-process-watch\` | every 120 s | Always-on restarter;  skips \`app.botfleet.server\`. |\n${RETIRED_ROWS}`;
  const verdict = judgeInventoryRows(withNeighbour, { capturedAt: PROVENANCE.at });
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.rows, 3);
  assert.deepEqual(verdict.notices, ["line 3 mentions app.botfleet.server outside its first cell, so it was not judged as a harness row"]);
});

test("a captured row that still describes a live harness under another first cell is reported to the operator", () => {
  // The inventory files the harness under more than one label.  A row whose
  // first cell is a port or an older label is not one of the two names, so it
  // is not judged;  the producer says which lines those are, by number only.
  const rows = `${RETIRED_ROWS}| 8799 | \`app.botfleet.server\` | Always-on, loaded and running |\n| \`com.jay.botfleet-server\` | Always-on | launchd runs \`~/apps/botfleet-server-start.sh\` for \`app.botfleet.server\` | **Up** |\n`;
  const verdict = judgeInventoryRows(rows, { capturedAt: PROVENANCE.at });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.rows, 3);
  assert.deepEqual(verdict.notices, [
    "line 4 mentions app.botfleet.server outside its first cell, so it was not judged as a harness row",
    "line 5 mentions app.botfleet.server and botfleet-server-start.sh outside its first cell, so it was not judged as a harness row",
  ]);
  // The notice carries the line number and the names, and none of the row's own words.
  assert.doesNotMatch(verdict.notices.join("\n"), /Always-on|loaded|running|8799|com\.jay/);

  // The notices reach the caller beside the receipt, and they fail no check.
  const result = emit(makeCapture({ rows }));
  assert.deepEqual(exitCodes(result), { processes: 0, launchd: 0, listeners: 0, "inventory-updated": 0 });
  assert.deepEqual(result.notices, verdict.notices);
  assert.deepEqual(emit(makeCapture()).notices, []);
});

test("the retired marker has to open the cell and carry a date", () => {
  assert.deepEqual(retiredMarker("**Retired 2026-10-19** (owner, AFC-363)"), { date: "2026-10-19" });
  assert.deepEqual(retiredMarker("Retired 2026-09-09 (MINIMAX)."), { date: "2026-09-09" });
  assert.deepEqual(retiredMarker("**Retired** on Tue, Nov 3, 2026"), { date: "2026-11-03" });
  assert.deepEqual(retiredMarker("Retired November 3, 2026"), { date: "2026-11-03" });
  assert.deepEqual(retiredMarker("Retired 2026-13-01"), { date: null });
  assert.deepEqual(retiredMarker("Retired Nov 31, 2026"), { date: null });
  assert.equal(retiredMarker("Retired"), null);
  assert.equal(retiredMarker("Retired at the Linear cutover (owner 2026-10-10)"), null);
  assert.equal(retiredMarker("Retirement plan: 2026-12-01"), null);
  assert.equal(retiredMarker("To be retired 2026-12-01"), null);
  assert.equal(retiredMarker("Always-on.  Retired 2026-10-19 and restored since."), null);
});

test("live wording is accepted only in the past-tense form", () => {
  assert.deepEqual(liveWording("Was the **always-on** harness.  No plist, not loaded, no longer running."), []);
  assert.deepEqual(liveWording("Unloaded with `launchctl bootout`;  had been running since October."), []);
  assert.deepEqual(liveWording("Always-on"), ["always-on"]);
  assert.deepEqual(liveWording("The job is **loaded** and has been running since October."), ["loaded", "running"]);
  assert.deepEqual(liveWording("Was loaded and running."), ["running"]);
});

test("the example rows in the cutover runbook are rows the producer accepts", () => {
  // The runbook tells the operator what to write, so its own example has to
  // pass.  The example is the runbook's only `markdown` fence.
  const runbook = readFileSync(new URL("../docs/native-rewrite-single-writer-cutover.md", import.meta.url), "utf8");
  const fences = [...runbook.matchAll(/^```markdown\n([\s\S]*?)\n```$/gm)];
  assert.equal(fences.length, 1, "the runbook should carry exactly one example of the accepted rows");
  const verdict = judgeInventoryRows(fences[0][1], { capturedAt: "2026-11-21T00:00:00Z" });
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.rows, 2);
});

test("rows written with the inventory's no-break sentence gaps are read the same way", () => {
  // The inventory's prose separates sentences with U+00A0 and a space.  The
  // character is written as an escape, so the line reads as what it does and
  // a formatter cannot turn it into a no-op without the diff showing it.
  const rows = RETIRED_ROWS.replaceAll(".  ", ".\u00A0 ").replaceAll("Retired 2026", "Retired\u00A02026");
  assert.notEqual(rows, RETIRED_ROWS);
  assert.ok(rows.includes("\u00A0"));
  assert.deepEqual(judgeInventoryRows(rows, { capturedAt: PROVENANCE.at }), { ok: true, reasons: [], rows: 3, notices: [] });
});

test("this file and the producer carry no raw no-break space", () => {
  // Code writes U+00A0 as an escape.  A raw one is invisible, and an editor
  // that normalises it changes what a string matches without changing how
  // the line looks.
  for (const name of ["./emit-process-inventory-receipt.mjs", "./emit-process-inventory-receipt.node-test.mjs"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    assert.equal(source.includes(String.fromCodePoint(0xA0)), false, `${name} carries a raw U+00A0`);
  }
});

test("a capture directory other people can read is refused", () => {
  const captureDir = makeCapture();
  chmodSync(captureDir, 0o755);
  assert.throws(() => emit(captureDir), /not private/);
  assert.equal(receiptExists(captureDir), false);
});

test("a verdict outside the capture directory is refused", () => {
  const captureDir = makeCapture();
  const outside = temporaryDirectory("process-inventory-outside-");
  const outsideVerdict = join(outside, "post-reboot-verdict.json");
  writeFileSync(outsideVerdict, JSON.stringify(makeVerdict()), { mode: 0o600 });

  assert.throws(() => emit(captureDir, { verdictPath: outsideVerdict }), /not inside the capture directory/);
  assert.equal(receiptExists(captureDir), false);
});

test("inventory rows outside the capture directory are refused", () => {
  const captureDir = makeCapture();
  const outside = temporaryDirectory("process-inventory-outside-");
  const outsideRows = join(outside, "inventory-rows.md");
  writeFileSync(outsideRows, RETIRED_ROWS, { mode: 0o600 });

  assert.throws(() => emit(captureDir, { inventoryRowsPath: outsideRows }), /not inside the capture directory/);
  assert.equal(receiptExists(captureDir), false);
});

test("inventory rows that are missing are refused", () => {
  const captureDir = makeCapture();
  assert.throws(() => emit(captureDir, { inventoryRowsPath: join(captureDir, "absent.md") }), /inventory rows could not be read/);
  assert.equal(receiptExists(captureDir), false);
});

test("a receipt whose provenance source is not an https URL is refused", () => {
  const captureDir = makeCapture();
  assert.throws(() => emit(captureDir, {
    provenance: { ...PROVENANCE, source: "http://example.invalid/notes", record: join(captureDir, "provenance.txt") },
  }), /must be an https URL/);
  assert.equal(receiptExists(captureDir), false);
});

test("a provenance instant that is not an ISO 8601 instant is refused", () => {
  const captureDir = makeCapture();
  for (const at of ["Nov 4, 2026 9:00 AM", "2026-10-05", undefined]) {
    assert.throws(() => emit(captureDir, {
      provenance: { ...PROVENANCE, at, record: join(captureDir, "provenance.txt") },
    }), /provenance instant must be an ISO 8601 date and time with an offset/);
  }
  assert.equal(receiptExists(captureDir), false);
});

test("a cited file whose name the bundle's reader does not accept is refused", () => {
  // The bundle's reader accepts a narrow set of path characters, so a cited
  // file whose name falls outside it could never be read back out of the
  // packet.
  const captureDir = makeCapture();
  writeFileSync(join(captureDir, "inventory rows.md"), RETIRED_ROWS, { mode: 0o600 });
  assert.throws(() => emit(captureDir, { inventoryRowsPath: join(captureDir, "inventory rows.md") }), /the inventory rows has a path the bundle's reader does not accept/);
  assert.equal(receiptExists(captureDir), false);
});

test("a receipt the bundle's schema would refuse is not written", () => {
  // The producer checks its own output against the bundle's schema, so a
  // provenance field the bundle rejects stops the receipt here.
  const captureDir = makeCapture();
  assert.throws(() => emit(captureDir, {
    provenance: { ...PROVENANCE, by: "   ", record: join(captureDir, "provenance.txt") },
  }), /would not match the bundle's schema/);
  assert.equal(receiptExists(captureDir), false);
});

// The bundle reads every cited file through `createEvidenceReader`, which
// refuses a link, a file with more than one name, and anything that is not
// owner-only.  The producer reads the same way.  Before it did, each of the
// fixtures below earned four zeros, a written receipt and exit 0, and the
// refusal only surfaced when the packet was collected.
const CITED_FILES = [
  { flag: "verdictPath", file: "post-reboot-verdict.json", what: "post-reboot verdict" },
  { flag: "inventoryRowsPath", file: "inventory-rows.md", what: "inventory rows" },
  { flag: "provenance", file: "provenance.txt", what: "provenance record" },
];

/** The `emit` overrides that point one cited file at another path. */
function citing(flag, path) {
  return flag === "provenance" ? { provenance: { ...PROVENANCE, record: path } } : { [flag]: path };
}

test("a cited file that is a symbolic link is refused, and nothing outside the capture directory is read through it", onPosix, () => {
  for (const { flag, file, what } of CITED_FILES) {
    const captureDir = makeCapture();
    const outside = temporaryDirectory("process-inventory-outside-");
    // A complete, clean file outside the capture directory, linked into it.
    writeFileSync(join(outside, file), readFileSync(join(captureDir, file)), { mode: 0o600 });
    symlinkSync(join(outside, file), join(captureDir, `linked-${file}`));

    assert.throws(() => emit(captureDir, citing(flag, join(captureDir, `linked-${file}`))), new RegExp(`the ${what} is a symbolic link`));
    assert.equal(receiptExists(captureDir), false);
  }
});

test("a cited file with a second name is refused", onPosix, () => {
  for (const { flag, file, what } of CITED_FILES) {
    const captureDir = makeCapture();
    linkSync(join(captureDir, file), join(captureDir, `second-name-${file}`));

    assert.throws(() => emit(captureDir, citing(flag, join(captureDir, file))), new RegExp(`the ${what} is not a plain file with a single name`));
    assert.equal(receiptExists(captureDir), false);
  }
});

test("a cited file other people can read is refused, inside a private capture directory", onPosix, () => {
  // The operator skipped `umask 077`:  the directory is 0700 and the file is 0644.
  for (const { flag, file, what } of CITED_FILES) {
    const captureDir = makeCapture();
    chmodSync(join(captureDir, file), 0o644);

    assert.throws(() => emit(captureDir, citing(flag, join(captureDir, file))), new RegExp(`the ${what} is not owner-only`));
    assert.equal(receiptExists(captureDir), false);
  }
});

test("a cited file reached through a folder that links out of the capture directory is refused", onPosix, () => {
  const captureDir = makeCapture();
  const outside = temporaryDirectory("process-inventory-outside-");
  writeFileSync(join(outside, "post-reboot-verdict.json"), JSON.stringify(makeVerdict()), { mode: 0o600 });
  symlinkSync(outside, join(captureDir, "elsewhere"));

  assert.throws(() => emit(captureDir, { verdictPath: join(captureDir, "elsewhere", "post-reboot-verdict.json") }), /post-reboot verdict is not inside the capture directory/);
  assert.equal(receiptExists(captureDir), false);
});

test("reading a saved verdict on its own follows the same rules", onPosix, () => {
  const captureDir = makeCapture();
  assert.equal(readPostRebootVerdict(join(captureDir, "post-reboot-verdict.json")).platform, "darwin");

  chmodSync(join(captureDir, "post-reboot-verdict.json"), 0o644);
  assert.throws(() => readPostRebootVerdict(join(captureDir, "post-reboot-verdict.json")), /post-reboot verdict is not owner-only/);

  assert.throws(() => readPostRebootVerdict(join(captureDir, "no-such-folder", "verdict.json")), /its folder is missing or is not private/);
});

test("a receipt path that is a link is refused rather than written through", () => {
  const captureDir = makeCapture();
  const elsewhere = temporaryDirectory("process-inventory-elsewhere-");
  writeFileSync(join(elsewhere, "target.json"), "{}\n", { mode: 0o600 });
  symlinkSync(join(elsewhere, "target.json"), join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE));

  assert.throws(() => emit(captureDir), /not a plain single-link file/);
  assert.equal(readFileSync(join(elsewhere, "target.json"), "utf8"), "{}\n");
});

// `emit` inspects the receipt path before it writes, and a path can change
// between that look and the write.  `writeReceiptFile` is the write itself, so
// these call it directly, with the path already holding what the inspection
// would have had to catch:  a link, a second name, a longer earlier receipt.
test("the receipt write refuses a link at the path and leaves its target alone", onPosix, () => {
  const captureDir = temporaryDirectory("process-inventory-write-");
  const elsewhere = temporaryDirectory("process-inventory-elsewhere-");
  writeFileSync(join(elsewhere, "target.json"), "untouched\n", { mode: 0o600 });
  const receiptPath = join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE);
  symlinkSync(join(elsewhere, "target.json"), receiptPath);

  assert.throws(() => writeReceiptFile(receiptPath, Buffer.from("{}\n")), /not a plain single-link file/);
  assert.equal(readFileSync(join(elsewhere, "target.json"), "utf8"), "untouched\n");
});

test("the receipt write refuses a file with a second name before it empties it", onPosix, () => {
  const captureDir = temporaryDirectory("process-inventory-write-");
  const elsewhere = temporaryDirectory("process-inventory-elsewhere-");
  writeFileSync(join(elsewhere, "target.json"), "untouched\n", { mode: 0o600 });
  const receiptPath = join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE);
  linkSync(join(elsewhere, "target.json"), receiptPath);

  assert.throws(() => writeReceiptFile(receiptPath, Buffer.from("{}\n")), /not a plain single-link file/);
  assert.equal(readFileSync(join(elsewhere, "target.json"), "utf8"), "untouched\n");
});

test("the receipt write replaces an earlier receipt whole and leaves it owner-only", onPosix, () => {
  const captureDir = temporaryDirectory("process-inventory-write-");
  const receiptPath = join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE);
  writeFileSync(receiptPath, `${"an earlier, longer receipt\n".repeat(20)}`, { mode: 0o644 });
  chmodSync(receiptPath, 0o644);

  writeReceiptFile(receiptPath, Buffer.from("{}\n"));

  assert.equal(readFileSync(receiptPath, "utf8"), "{}\n");
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
});

/** The producer's flags with their values, for a capture directory. */
function cliFlags(captureDir) {
  const requestPath = join(captureDir, "request.json");
  writeFileSync(requestPath, JSON.stringify(makeRequest()), { mode: 0o600 });
  return [
    ["--capture", captureDir],
    ["--request", requestPath],
    ["--verdict", join(captureDir, "post-reboot-verdict.json")],
    ["--inventory-rows", join(captureDir, "inventory-rows.md")],
    ["--provenance-record", join(captureDir, "provenance.txt")],
    ["--provenance-source", PROVENANCE.source],
    ["--provenance-by", PROVENANCE.by],
    ["--provenance-at", PROVENANCE.at],
  ];
}

/** Run the producer's CLI over a capture directory. */
function runCli(captureDir, extra = []) {
  return spawnSync(process.execPath, [script, ...cliFlags(captureDir).flat(), ...extra], { encoding: "utf8", timeout: 30_000 });
}

test("the CLI exits 0 with a receipt, 1 without one on a dirty verdict, and 2 on a refusal", () => {
  const clean = makeCapture();
  const passed = runCli(clean);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout).emitted, [PROCESS_INVENTORY_RECEIPT_FILE]);
  assert.equal(JSON.parse(passed.stdout).macHarness, "absent");
  assert.deepEqual(JSON.parse(passed.stdout).notices, []);
  assert.equal(receiptExists(clean), true);

  // A row the producer did not judge is named on the output, and the exit is still 0.
  const noticed = makeCapture({ rows: `${RETIRED_ROWS}| 8799 | \`app.botfleet.server\` | Always-on |\n` });
  const withNotice = runCli(noticed);
  assert.equal(withNotice.status, 0, withNotice.stderr);
  assert.deepEqual(JSON.parse(withNotice.stdout).notices, ["line 4 mentions app.botfleet.server outside its first cell, so it was not judged as a harness row"]);

  const dirty = makeCapture({
    verdict: makeVerdict({ launchAgents: [{ label: "app.botfleet.server", running: true, details: "state = running" }] }),
  });
  const failed = runCli(dirty);
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(JSON.parse(failed.stdout).emitted, []);
  assert.equal(JSON.parse(failed.stdout).macHarness, "present");
  assert.equal(receiptExists(dirty), false);

  const stale = makeCapture({ rows: LIVE_ROWS });
  const inventory = runCli(stale);
  assert.equal(inventory.status, 1, inventory.stderr);
  assert.deepEqual(JSON.parse(inventory.stdout).emitted, [PROCESS_INVENTORY_RECEIPT_FILE]);

  const linux = makeCapture({ verdict: makeVerdict({}, { platform: "linux" }) });
  const refused = runCli(linux);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /emit-process-inventory-receipt refused: the post-reboot verdict was taken on "linux"/);
  assert.equal(refused.stdout, "");
  assert.equal(receiptExists(linux), false);

  // A verdict the bundle's reader would refuse is a refusal here, not an exit 0.
  const readable = makeCapture();
  chmodSync(join(readable, "post-reboot-verdict.json"), 0o644);
  const loose = runCli(readable);
  assert.equal(loose.status, 2);
  assert.match(loose.stderr, /emit-process-inventory-receipt refused: the post-reboot verdict is not owner-only/);
  assert.equal(loose.stdout, "");
  assert.equal(receiptExists(readable), false);

  // So is a verdict whose launchd domain was not found.
  const noDomain = makeCapture({ verdict: makeVerdict({}, { launchDomain: { uid: 501, target: "gui/501", observed: false, skipped: false } }) });
  const unobserved = runCli(noDomain);
  assert.equal(unobserved.status, 2);
  assert.match(unobserved.stderr, /could not find the launchd domain "gui\/501"/);
  assert.equal(receiptExists(noDomain), false);
});

/** Run the CLI with every flag but one, and that one given without a value. */
function runCliWithoutValue(captureDir, flag) {
  const args = cliFlags(captureDir).flatMap(([name, value]) => (name === flag ? [name] : [name, value]));
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30_000 });
}

test("the CLI refuses a flag with no value, and does not read the next flag as its value", () => {
  // Every other flag is supplied, so the only thing wrong is the missing
  // value.  `--request` is followed by `--verdict`:  a guard that took the
  // next argument as the value would read the request from a file named
  // `--verdict` and fail with a different message, so the refusal has to name
  // `--request` as the missing flag and say nothing about reading a file.
  const followed = makeCapture();
  const request = runCliWithoutValue(followed, "--request");
  assert.equal(request.status, 2);
  assert.match(request.stderr, /emit-process-inventory-receipt refused: --request is required, each with a value/);
  assert.doesNotMatch(request.stderr, /could not be read/);
  assert.equal(request.stdout, "");
  assert.equal(receiptExists(followed), false);

  // The last flag on the line has nothing after it at all.
  const last = makeCapture();
  const trailing = runCliWithoutValue(last, "--provenance-at");
  assert.equal(trailing.status, 2);
  assert.match(trailing.stderr, /emit-process-inventory-receipt refused: --provenance-at is required, each with a value/);
  assert.equal(receiptExists(last), false);
});

test("the CLI has no default for the capture instant", () => {
  // The rows are judged against the capture's instant, so a run that was not
  // told it must not fall back to the moment the producer happens to run.
  const captureDir = makeCapture();
  const flags = cliFlags(captureDir).filter(([name]) => name !== "--provenance-at").flat();
  const proc = spawnSync(process.execPath, [script, ...flags], { encoding: "utf8", timeout: 30_000 });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /emit-process-inventory-receipt refused: --provenance-at is required, each with a value/);
  assert.equal(proc.stdout, "");
  assert.equal(receiptExists(captureDir), false);
});

test("the CLI prints the entry the bundle request has to carry for the receipt", () => {
  const captureDir = makeCapture();
  const passed = runCli(captureDir);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout).receipts, {
    "process-inventory": {
      path: PROCESS_INVENTORY_RECEIPT_FILE,
      sha256: evidenceHash(readFileSync(join(captureDir, PROCESS_INVENTORY_RECEIPT_FILE))),
    },
  });

  // With no receipt written there is nothing to register.
  const dirty = makeCapture({
    verdict: makeVerdict({ launchAgents: [{ label: "app.botfleet.server", running: true, details: "state = running" }] }),
  });
  const failed = runCli(dirty);
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(JSON.parse(failed.stdout).receipts, {});
});

test("`pnpm test` reaches this file, so CI runs these fixtures", () => {
  // A test file no script lists does not run in CI.  The chain is followed one
  // level, through the `pnpm test:<name>` scripts `pnpm test` calls, so the
  // assertion holds wherever in that chain the file is listed.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const steps = pkg.scripts.test.split("&&").map((step) => step.trim());
  const commands = steps.map((step) => pkg.scripts[step.replace(/^pnpm /, "")] ?? step);
  assert.ok(
    commands.some((command) => command.startsWith("node --test ") && command.split(/\s+/).includes("scripts/emit-process-inventory-receipt.node-test.mjs")),
    "no script reached by `pnpm test` runs scripts/emit-process-inventory-receipt.node-test.mjs",
  );
});

test("the CLI runs when the script is invoked through a symlink", () => {
  // Node's ESM loader resolves symlinks for `import.meta.url` and leaves
  // `process.argv[1]` as it was typed, so an entry check that compared the two
  // unresolved paths would look like an import and quietly do nothing.
  const directory = temporaryDirectory("process-inventory-link-");
  const link = join(directory, "emit-process-inventory-receipt.mjs");
  symlinkSync(script, link);

  const proc = spawnSync(process.execPath, [link], { encoding: "utf8", timeout: 30_000 });
  // The CLI refuses without its arguments and says so;  an import would print
  // nothing at all and exit zero.
  assert.match(proc.stderr, /emit-process-inventory-receipt refused/);
  assert.notEqual(proc.status, 0);
});
