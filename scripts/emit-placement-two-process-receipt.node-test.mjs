// The two-process placement fixture receipt, proven offline (BF-2559 T6b).
//
// The fixture runs two separate operating-system processes, so this file
// runs the fixture once and then says what the receipt it produced proves
// and what it does not.  Everything here is offline:  a temporary private
// directory, free loopback ports, and no live host, no App Store Connect
// account, no real bot and no harness on port 8799.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  emitPlacementTwoProcessReceipt,
  PlacementTwoProcessReceiptSchema,
  PLACEMENT_TWO_PROCESS_RECEIPT_FILE,
} from "./emit-placement-two-process-receipt.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");

/** A private directory, as the receipt's output directory has to be. */
function privateDir() {
  const root = mkdtempSync(join(tmpdir(), "bf-t6b-receipt-"));
  chmodSync(root, 0o700);
  return root;
}

const outDir = privateDir();
after(() => {
  rmSync(outDir, { recursive: true, force: true });
});

let produced = null;

/** Run the fixture once:  the two child processes cost real time. */
async function fixture() {
  if (!produced) produced = await emitPlacementTwoProcessReceipt({ outDir });
  return produced;
}

test("the two-process fixture leaves a receipt that says it is a fixture receipt", async () => {
  const result = await fixture();
  const parsed = PlacementTwoProcessReceiptSchema.safeParse(result.receipt);
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join("; "));

  const receipt = result.receipt;
  assert.equal(receipt.evidenceClass, "fixture");
  assert.equal(receipt.hostedProof, false);
  assert.equal(receipt.scope.liveHost, false);
  assert.equal(receipt.scope.appStoreConnect, false);
  assert.equal(receipt.scope.harnessPort8799, false);
  assert.equal(receipt.scope.realBot, false);
  assert.ok(receipt.doesNotProve.some((line) => line.includes("not hosted proof")), receipt.doesNotProve.join("; "));
  assert.ok(receipt.doesNotProve.some((line) => line.includes("sixteen placement recipes")), receipt.doesNotProve.join("; "));
});

test("the decision was made in one process and executed in another", async () => {
  const receipt = (await fixture()).receipt;
  const pids = [
    receipt.processes.controllerPid,
    receipt.processes.workerPid,
    receipt.processes.producerPid,
    receipt.processes.jobPid,
  ];
  assert.equal(new Set(pids).size, pids.length, `the fixture processes share a pid: ${pids.join(", ")}`);
  assert.equal(receipt.processes.separateOperatingSystemProcesses, true);
  assert.equal(receipt.processes.controllerHost, "127.0.0.1");

  // The lease the controller issued is the lease the worker held:  it crossed
  // the process boundary and came back the same.
  const controller = JSON.parse(readFileSync(join(outDir, "placement-two-process.controller-summary.json"), "utf8"));
  const worker = JSON.parse(readFileSync(join(outDir, "placement-two-process.worker-summary.json"), "utf8"));
  assert.equal(controller.leaseId, receipt.decision.leaseId);
  assert.equal(worker.leaseId, receipt.decision.leaseId);
  assert.equal(controller.jobId, worker.jobId);
  assert.equal(controller.jobId, receipt.decision.jobId);
  assert.equal(controller.epoch, worker.epoch);

  // One job process, one nonce file, one settled report.
  assert.equal(receipt.decision.spawns, 1);
  assert.equal(receipt.decision.nonceRuns, 1);
  assert.equal(receipt.decision.controllerStatus, "completed");
  assert.equal(receipt.decision.reportStatus, "completed");
  assert.equal(receipt.decision.exitCode, 0);
  assert.equal(worker.pendingReports, 0);
});

test("the receipt carries the credential as a digest and never as a value", async () => {
  const result = await fixture();
  const secret = Buffer.from(result.facts.secret, "utf8");
  assert.equal(secret.length, 64);

  const receiptBytes = readFileSync(join(outDir, PLACEMENT_TWO_PROCESS_RECEIPT_FILE));
  assert.equal(receiptBytes.includes(secret), false, "the receipt carries the credential value");
  for (const artifact of result.artifacts) {
    const bytes = readFileSync(join(outDir, artifact.path));
    assert.equal(bytes.includes(secret), false, `${artifact.path} carries the credential value`);
  }

  const digest = createHash("sha256").update(result.facts.secret, "utf8").digest("hex");
  assert.equal(result.receipt.credential.secretSha256, digest);
  assert.equal(result.receipt.credential.valueIncluded, false);
  assert.equal(result.receipt.credential.store, "fixture:worker-credential");
  assert.equal(result.receipt.credential.grant, "execution-worker");
  assert.equal(result.receipt.credential.scope, result.receipt.decision.controllerId);
});

test("the receipt schema refuses a receipt that claims to be hosted proof", async () => {
  const receipt = (await fixture()).receipt;
  const claimed = { ...receipt, hostedProof: true };
  assert.equal(PlacementTwoProcessReceiptSchema.safeParse(claimed).success, false);

  const relabelled = { ...receipt, evidenceClass: "hosted" };
  assert.equal(PlacementTwoProcessReceiptSchema.safeParse(relabelled).success, false);

  const extra = { ...receipt, surprise: true };
  assert.equal(PlacementTwoProcessReceiptSchema.safeParse(extra).success, false);
});

test("every artifact is hash-bound and lives inside the private output directory", async () => {
  const result = await fixture();
  const root = resolve(outDir);
  for (const artifact of result.artifacts) {
    const path = join(root, artifact.path);
    assert.ok(path.startsWith(`${root}/`), `${artifact.path} leaves the output directory`);
    assert.equal(existsSync(path), true);
    const entry = statSync(path);
    assert.equal(entry.mode & 0o077, 0, `${artifact.path} is not owner-only`);
    const bytes = readFileSync(path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
  const receiptEntry = statSync(join(outDir, PLACEMENT_TWO_PROCESS_RECEIPT_FILE));
  assert.equal(receiptEntry.mode & 0o077, 0, "the receipt is not owner-only");
});

test("the producer refuses an output directory that is not private, and writes nothing", async () => {
  const openDir = mkdtempSync(join(tmpdir(), "bf-t6b-open-"));
  chmodSync(openDir, 0o755);
  try {
    await assert.rejects(
      () => emitPlacementTwoProcessReceipt({ outDir: openDir }),
      /not private/,
    );
    assert.deepEqual(readdirSync(openDir), []);
  } finally {
    rmSync(openDir, { recursive: true, force: true });
  }
});

test("the producer and the two child processes read no environment value", () => {
  for (const relative of [
    "scripts/emit-placement-two-process-receipt.mjs",
    "server/testing/placement-controller-child.ts",
    "server/testing/placement-worker-child.ts",
    "server/testing/placement-two-process-config.ts",
  ]) {
    const source = readFileSync(join(repoRoot, relative), "utf8");
    assert.equal(source.includes("process.env"), false, `${relative} reads the environment`);
  }
});
