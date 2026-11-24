// Emit the placement two-process fixture receipt (BF-2559 T6b).
//
// The placement transport slices left the two-process fixture running inside
// one test process:  the controller, the fault proxy, the worker runtime and
// the real job runner all lived in the same process, so a receipt built from
// that run could not tell a decision that crossed a process boundary from a
// decision two functions made in the same address space.
//
// This producer runs the two halves as two separate operating-system
// processes.  The controller process owns the lease authority and decides;
// the worker process pulls the assignment over a loopback socket, runs the
// job through the real runner backed adapter and reports the result back.
// The producer reads what each of them wrote down and refuses to write a
// receipt unless the three processes are distinct and the job ran exactly
// once.
//
// What the receipt is:  a fixture receipt.  It is labelled as one in its own
// fields, it says in plain words that it is not hosted proof, and no live
// host, no App Store Connect account, no real bot and no harness on port
// 8799 took part in producing it.  It asserts none of the sixteen placement
// recipes and it grants no permission to activate.
//
// What the receipt carries:  no secret value and no environment value.  The
// one secret in the fixture, the worker credential, appears as the digest
// the controller checked the presented secret against, with the store it came
// from, the grant it carries and the scope it covers named beside it.  This
// producer reads no environment value at all and performs no secret lookup
// on any path.
//
// Usage:
//   node scripts/emit-placement-two-process-receipt.mjs --out <private-dir>
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { spawnDetached, waitForExit } from "../server/testing/cleanup.ts";
import { nonceRuns } from "../server/testing/two-process.ts";
import {
  readControllerSummary,
  readWorkerSummary,
  writeFixtureConfig,
  writeFixtureCredential,
} from "../server/testing/placement-two-process-config.ts";
import { writeReceiptFile } from "./emit-process-inventory-receipt.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";

export const PLACEMENT_TWO_PROCESS_RECEIPT_VERSION = 1;
export const PLACEMENT_TWO_PROCESS_RECEIPT_KIND = "placement-two-process-fixture";
export const PLACEMENT_TWO_PROCESS_RECEIPT_FILE = "placement-two-process-fixture.receipt.json";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROLLER_ENTRY = join(repoRoot, "server", "testing", "placement-controller-child.ts");
const WORKER_ENTRY = join(repoRoot, "server", "testing", "placement-worker-child.ts");
const NONCE_SCRIPT = join(repoRoot, "server", "testing", "nonce-job.mjs");

const HOST_ID_PATTERN = /^(mac|server):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const ArtifactSchema = z.strictObject({
  role: z.string().min(1).max(64),
  path: z.string().min(1).max(240).regex(/^[A-Za-z0-9_.-]+$/),
  sha256: z.string().regex(DIGEST_PATTERN),
});

/**
 * The receipt this producer writes.
 *
 * `evidenceClass` and `hostedProof` are literals on purpose:  a receipt that
 * claimed to be hosted proof would fail this schema rather than be written,
 * and the scope fields say in the receipt itself that no live host, no App
 * Store Connect account, no real bot and no harness on port 8799 took part.
 */
export const PlacementTwoProcessReceiptSchema = z.strictObject({
  version: z.literal(PLACEMENT_TWO_PROCESS_RECEIPT_VERSION),
  kind: z.literal(PLACEMENT_TWO_PROCESS_RECEIPT_KIND),
  evidenceClass: z.literal("fixture"),
  hostedProof: z.literal(false),
  scope: z.strictObject({
    liveHost: z.literal(false),
    appStoreConnect: z.literal(false),
    harnessPort8799: z.literal(false),
    realBot: z.literal(false),
  }),
  processes: z.strictObject({
    controllerPid: z.number().int().positive(),
    workerPid: z.number().int().positive(),
    producerPid: z.number().int().positive(),
    jobPid: z.number().int().positive(),
    separateOperatingSystemProcesses: z.literal(true),
    controllerHost: z.literal("127.0.0.1"),
    controllerPort: z.number().int().positive(),
  }),
  credential: z.strictObject({
    store: z.string().min(1).max(256),
    grant: z.string().min(1).max(256),
    scope: z.string().min(1).max(256),
    secretSha256: z.string().regex(DIGEST_PATTERN),
    valueIncluded: z.literal(false),
  }),
  decision: z.strictObject({
    jobId: z.string().min(1).max(128),
    leaseId: z.string().min(1).max(128),
    controllerId: z.string().regex(HOST_ID_PATTERN),
    workerId: z.string().regex(HOST_ID_PATTERN),
    epoch: z.number().int().nonnegative(),
    controllerStatus: z.literal("completed"),
    reportStatus: z.literal("completed"),
    exitCode: z.literal(0),
    spawns: z.literal(1),
    nonceRuns: z.literal(1),
  }),
  artifacts: z.array(ArtifactSchema).min(1).max(16),
  proves: z.array(z.string().min(1).max(512)).min(1).max(16),
  doesNotProve: z.array(z.string().min(1).max(512)).min(1).max(16),
});

/**
 * The printable text of a refusal, on one bounded line.
 */
function printable(value) {
  const text = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`)
    .trim();
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

/**
 * Sleep for a moment, without a timer that would hold the process open.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The environment a fixture child runs in.
 *
 * It is built here and nowhere else:  the producer reads no environment
 * value, and the child inherits nothing of the operator's own environment.
 */
function childEnv(fixtureRoot) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: fixtureRoot,
    TMPDIR: fixtureRoot,
  };
}

/**
 * Start one fixture child and keep what it says on its error stream.
 */
function startChild(entry, configPath, fixtureRoot) {
  const child = spawnDetached(process.execPath, ["--experimental-strip-types", entry, configPath], {
    cwd: fixtureRoot,
    env: childEnv(fixtureRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (part) => {
    if (stderr.length < 8192) stderr += part.toString("utf8");
  });
  child.stdout?.resume();
  return { child, stderr: () => stderr };
}

/**
 * Wait for a file a child writes, or for the child to fail.
 */
async function waitForFile(path, deadline, label, child, stderr) {
  for (;;) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the ${label} child exited with ${child.exitCode ?? child.signalCode}: ${printable(stderr())}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`the ${label} child never finished: ${printable(stderr())}`);
    }
    await sleep(25);
  }
}

/**
 * Run the two-process fixture once and report what it observed.
 *
 * The producer is a third process:  it holds no lease, runs no job and
 * decides nothing.  It only reads what the other two wrote down.
 */
export async function runTwoProcessFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "bf-placement-t6b-"));
  chmodSync(fixtureRoot, 0o700);
  const controllerDir = join(fixtureRoot, "controller");
  const workerDir = join(fixtureRoot, "worker");
  const nonceDir = join(fixtureRoot, "nonce");
  mkdirSync(controllerDir, { recursive: true, mode: 0o700 });
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  mkdirSync(nonceDir, { recursive: true, mode: 0o700 });

  const nonce = "t6b-two-process";
  const controllerId = `server:${randomUUID()}`;
  const workerId = `mac:${randomUUID()}`;
  const credentialId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const secretSha256 = createHash("sha256").update(secret, "utf8").digest("hex");
  const jobId = `job-${randomUUID()}`;
  const epoch = 0;
  const timeoutMs = 60_000;

  const credentialFile = join(fixtureRoot, "worker-credential.json");
  const configFile = join(fixtureRoot, "fixture-config.json");
  const controllerReadyFile = join(fixtureRoot, "controller.port");
  const controllerSummaryFile = join(fixtureRoot, "controller-summary.json");
  const workerSummaryFile = join(fixtureRoot, "worker-summary.json");

  writeFixtureCredential(credentialFile, { credentialId, secret });
  writeFixtureConfig(configFile, {
    version: 1,
    controllerId,
    workerId,
    epoch,
    credentialId,
    secretSha256,
    controllerDir,
    workerDir,
    nonceDir,
    nonce,
    jobId,
    nodePath: process.execPath,
    nonceScript: NONCE_SCRIPT,
    credentialFile,
    controllerReadyFile,
    controllerSummaryFile,
    workerSummaryFile,
    timeoutMs,
  });

  const deadline = Date.now() + timeoutMs;
  const controller = startChild(CONTROLLER_ENTRY, configFile, fixtureRoot);
  let worker = null;
  try {
    await waitForFile(controllerReadyFile, deadline, "controller", controller.child, controller.stderr);
    worker = startChild(WORKER_ENTRY, configFile, fixtureRoot);
    await waitForFile(workerSummaryFile, deadline, "worker", worker.child, worker.stderr);
    await waitForFile(controllerSummaryFile, deadline, "controller", controller.child, controller.stderr);

    const controllerSummary = readControllerSummary(controllerSummaryFile);
    const workerSummary = readWorkerSummary(workerSummaryFile);
    const runs = nonceRuns(nonceDir, nonce);
    const nonceFiles = readdirSync(nonceDir).filter((name) => name.startsWith(`${nonce}.`));

    return {
      controllerId,
      workerId,
      credentialId,
      // The fixture's own secret, in memory only:  the receipt carries the
      // digest and never this value.
      secret,
      secretSha256,
      jobId,
      epoch,
      nonce,
      nonceFiles,
      controllerSummary,
      workerSummary,
      jobPids: runs,
      controllerSummaryText: readFileSync(controllerSummaryFile, "utf8"),
      workerSummaryText: readFileSync(workerSummaryFile, "utf8"),
      nonceText: nonceFiles.map((name) => `${name}\n${readFileSync(join(nonceDir, name), "utf8")}`).join(""),
    };
  } finally {
    if (worker) await waitForExit(worker.child, { signal: "SIGTERM" });
    await waitForExit(controller.child, { signal: "SIGTERM" });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

/**
 * Refuse the run unless the fixture really did what the receipt claims.
 *
 * A receipt that says a check passed when the fixture says it failed is
 * worse than no receipt at all, so every one of these is read out of the two
 * summaries and the nonce directory rather than asserted here.
 */
function assertFixtureFacts(facts) {
  const controller = facts.controllerSummary;
  const worker = facts.workerSummary;
  const problems = [];
  if (controller.pid === worker.pid) problems.push("the controller and the worker ran in one process");
  if (controller.pid === process.pid) problems.push("the controller ran inside the producer");
  if (worker.pid === process.pid) problems.push("the worker ran inside the producer");
  if (controller.jobId !== worker.jobId) problems.push("the two processes disagree about the job");
  if (!controller.leaseId || controller.leaseId !== worker.leaseId) {
    problems.push("the lease the worker held is not the lease the controller issued");
  }
  if (controller.status !== "completed") problems.push(`the controller settled the job as ${controller.status}`);
  if (controller.reportStatus !== "completed") problems.push(`the controller recorded the report as ${controller.reportStatus}`);
  if (controller.exitCode !== 0) problems.push(`the job exited with ${controller.exitCode}`);
  if (worker.spawns !== 1) problems.push(`the worker started ${worker.spawns} job processes`);
  if (facts.jobPids.length !== 1) problems.push(`the job left ${facts.jobPids.length} nonce files`);
  if (facts.nonceFiles.length !== facts.jobPids.length) {
    problems.push(`the nonce directory holds ${facts.nonceFiles.length} files and the job ran ${facts.jobPids.length} times`);
  }
  if (worker.pendingReports !== 0) problems.push(`the worker still holds ${worker.pendingReports} undelivered reports`);
  if (controller.epoch !== worker.epoch) problems.push("the two processes disagree about the controller epoch");
  if (facts.jobPids.length === 1 && (facts.jobPids[0] === worker.pid || facts.jobPids[0] === controller.pid)) {
    problems.push("the job ran inside one of the fixture processes");
  }
  if (problems.length > 0) {
    throw new Error(`the two-process fixture did not hold: ${problems.join("; ")}`);
  }
}

/**
 * Write one evidence artifact into the private output directory.
 */
function writeArtifact(outDir, role, name, text) {
  writeFileSync(join(outDir, name), text, { mode: 0o600 });
  return { role, path: name, sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") };
}

/**
 * Emit the placement two-process fixture receipt.
 */
export async function emitPlacementTwoProcessReceipt({ outDir }) {
  const out = resolve(outDir);
  assertPrivateCaptureDir(out);

  const facts = await runTwoProcessFixture();
  assertFixtureFacts(facts);

  const artifacts = [
    writeArtifact(out, "controller-summary", "placement-two-process.controller-summary.json", facts.controllerSummaryText),
    writeArtifact(out, "worker-summary", "placement-two-process.worker-summary.json", facts.workerSummaryText),
    writeArtifact(out, "nonce-run", "placement-two-process.nonce-run.txt", facts.nonceText),
  ];

  const receipt = {
    version: PLACEMENT_TWO_PROCESS_RECEIPT_VERSION,
    kind: PLACEMENT_TWO_PROCESS_RECEIPT_KIND,
    evidenceClass: "fixture",
    hostedProof: false,
    scope: {
      liveHost: false,
      appStoreConnect: false,
      harnessPort8799: false,
      realBot: false,
    },
    processes: {
      controllerPid: facts.controllerSummary.pid,
      workerPid: facts.workerSummary.pid,
      producerPid: process.pid,
      jobPid: facts.jobPids[0],
      separateOperatingSystemProcesses: true,
      controllerHost: "127.0.0.1",
      controllerPort: facts.controllerSummary.port,
    },
    credential: {
      store: "fixture:worker-credential",
      grant: "execution-worker",
      scope: facts.controllerId,
      secretSha256: facts.secretSha256,
      valueIncluded: false,
    },
    decision: {
      jobId: facts.jobId,
      leaseId: facts.controllerSummary.leaseId,
      controllerId: facts.controllerId,
      workerId: facts.workerId,
      epoch: facts.epoch,
      controllerStatus: "completed",
      reportStatus: "completed",
      exitCode: 0,
      spawns: facts.workerSummary.spawns,
      nonceRuns: facts.jobPids.length,
    },
    artifacts,
    proves: [
      "the controller decided the placement in one operating-system process and the worker executed it in another",
      "the job id, the lease id and the controller epoch crossed the process boundary over a loopback socket",
      "the job ran in a third process, exactly once, and left exactly one nonce file",
      "the terminal report settled the lease exactly once, and the worker holds no undelivered report",
    ],
    doesNotProve: [
      "a fixture receipt is not hosted proof",
      "no live host, no App Store Connect account, no real bot and no harness on port 8799 took part in this run",
      "none of the sixteen placement recipes is asserted by this receipt",
      "this receipt grants no permission to activate placement",
    ],
  };

  const parsed = PlacementTwoProcessReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new Error(`the receipt does not match its own schema, so nothing was written: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.message}`).join("; ")}`);
  }

  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeReceiptFile(join(out, PLACEMENT_TWO_PROCESS_RECEIPT_FILE), receiptBytes);
  return {
    receipt,
    artifacts,
    // The fixture's own facts, in memory only.  They carry the secret this
    // run generated, and the receipt above never carries it, so a caller
    // can check that for itself without the secret ever reaching a file.
    facts,
    reference: {
      path: PLACEMENT_TWO_PROCESS_RECEIPT_FILE,
      sha256: createHash("sha256").update(receiptBytes).digest("hex"),
    },
    kind: PLACEMENT_TWO_PROCESS_RECEIPT_KIND,
  };
}

const KNOWN_FLAGS = new Set(["--out"]);

/** Parse CLI arguments strictly:  refuse unknown flags, duplicate flags, or missing values. */
export function parseCliArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const flag = String(args[i]);
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    const next = args[i + 1];
    if (next === undefined || String(next).startsWith("--")) throw new Error(`missing value for ${flag}`);
    values.set(flag, String(next));
    i += 1;
  }
  const missing = [...KNOWN_FLAGS].filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`);
  }
  return values;
}

let isEntry = false;
try {
  isEntry = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
} catch {
  /* imported */
}

if (isEntry) {
  try {
    const flags = parseCliArgs(process.argv.slice(2));
    const result = await emitPlacementTwoProcessReceipt({ outDir: flags.get("--out") });
    console.log(JSON.stringify({
      emitted: [result.reference.path, ...result.artifacts.map((artifact) => artifact.path)],
      kind: result.kind,
      receipt: result.reference,
    }));
  } catch (error) {
    console.error(`emit-placement-two-process-receipt refused: ${printable(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 2;
  }
}
