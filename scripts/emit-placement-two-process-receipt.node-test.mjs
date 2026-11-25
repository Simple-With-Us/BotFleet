// The two-process placement fixture receipt, proven offline (BF-2559 T6b).
//
// The fixture runs two separate operating-system processes, so this file
// runs the fixture once and then says what the receipt it produced proves
// and what it does not.  Everything here is offline:  a temporary private
// directory, free loopback ports, and no live host, no App Store Connect
// account, no real bot and no harness on port 8799.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { Agent, createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  emitPlacementTwoProcessReceipt,
  PlacementTwoProcessReceiptSchema,
  PLACEMENT_TWO_PROCESS_RECEIPT_FILE,
} from "./emit-placement-two-process-receipt.mjs";
import { quoteShellSegment, writeFixtureConfig, writeFixtureCredential } from "../server/testing/placement-two-process-config.ts";
import {
  closeWorkerServer,
  listenOnLoopback,
  MAX_WORKER_BODY_BYTES,
  readWorkerBody,
} from "../server/testing/placement-worker-link.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");

/** A wait, so a test can tell a hang from a wait. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A server that answers one request and reports how the body read.
 *
 * The outcome settles as `resolved` or `rejected: <message>`, so a test can
 * say which one happened and a body that never settles is a failure the test
 * can see.
 */
function bodyServer() {
  let settle;
  const outcome = new Promise((resolve) => { settle = resolve; });
  const server = createServer((req, res) => {
    void readWorkerBody(req).then(
      (body) => { settle("resolved"); res.end(JSON.stringify(body)); },
      (error) => { settle(`rejected: ${error.message}`); res.destroy(); },
    );
  });
  return { server, outcome };
}

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

test("the job ran a path that carries a space, so the command's segments are quoted", async () => {
  const result = await fixture();
  assert.ok(result.facts.nonceDir.includes(" "), `the fixture used a path with no space in it: ${result.facts.nonceDir}`);
  assert.equal(result.receipt.decision.nonceRuns, 1);
  assert.equal(result.receipt.decision.exitCode, 0);
  assert.equal(result.receipt.decision.spawns, 1);
});

test("a shell segment is quoted so a path with a space stays one word", () => {
  assert.equal(quoteShellSegment("/tmp/a b/c"), "'/tmp/a b/c'");
  assert.equal(quoteShellSegment("it's"), "'it'\\''s'");
  assert.equal(quoteShellSegment("plain"), "'plain'");
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

test("a worker body that arrives whole is read and parsed", async () => {
  const { server, outcome } = bodyServer();
  const port = await listenOnLoopback(server);
  try {
  const answer = await new Promise((resolve) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/",
      headers: { "content-type": "application/json" },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (part) => { text += part; });
      response.on("end", () => resolve(text));
    });
    request.on("error", () => resolve(""));
    request.end(JSON.stringify({ jobId: "job-1", count: 2 }));
  });
  assert.deepEqual(JSON.parse(answer), { jobId: "job-1", count: 2 });
  assert.equal(await Promise.race([outcome, delay(3000).then(() => "hung")]), "resolved");
  } finally {
    await closeWorkerServer(server);
  }
});

test("a worker body over the cap is refused rather than buffered", async () => {
  const { server, outcome } = bodyServer();
  const port = await listenOnLoopback(server);
  try {
  const size = MAX_WORKER_BODY_BYTES + 1024;
  await new Promise((resolve) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/",
      headers: { "content-length": String(size) },
    }, (response) => { response.resume(); response.on("end", resolve); });
    request.on("error", resolve);
    request.end(Buffer.alloc(size, 0x61));
  });
  const settled = await Promise.race([outcome, delay(3000).then(() => "hung")]);
  assert.notEqual(settled, "hung", "the worker body promise never settled");
  assert.match(settled, /^rejected: /);
  assert.match(settled, /too large/);
  } finally {
    await closeWorkerServer(server);
  }
});

test("an interrupted worker body is refused rather than waited on", async () => {
  const { server, outcome } = bodyServer();
  const port = await listenOnLoopback(server);
  const arrived = new Promise((resolve) => server.once("request", () => resolve()));
  try {
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/",
    headers: { "content-length": "4096" },
  });
  request.on("error", () => {});
  request.write("partial");
  await arrived;
  request.destroy();
  const settled = await Promise.race([outcome, delay(3000).then(() => "hung")]);
  assert.notEqual(settled, "hung", "the worker body promise never settled");
  assert.match(settled, /^rejected: /);
  } finally {
    await closeWorkerServer(server);
  }
});

test("a listen that cannot bind settles instead of waiting", async () => {
  const first = createServer();
  const port = await listenOnLoopback(first);
  const second = createServer();
  try {
  const settled = await Promise.race([
    listenOnLoopback(second, port).then(() => "resolved", (error) => `rejected: ${error.code ?? error.message}`),
    delay(3000).then(() => "hung"),
  ]);
  assert.notEqual(settled, "hung", "the listen promise never settled");
  assert.match(settled, /^rejected: /);
  } finally {
    await closeWorkerServer(first);
  }
});

test("a server with a request still in flight still closes", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("partial");
    // The response is never finished, so this request is still in flight
    // when the server is closed.
  });
  const port = await listenOnLoopback(server);
  const agent = new Agent({ keepAlive: true });
  try {
    await new Promise((resolve) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "/", agent }, (response) => {
        response.once("data", () => resolve());
      });
      request.on("error", resolve);
      request.end();
    });
    const settled = await Promise.race([
      closeWorkerServer(server).then(() => "closed", (error) => `failed: ${error.message}`),
      delay(3000).then(() => "hung"),
    ]);
    assert.equal(settled, "closed", "the server never closed with a request still in flight");
  } finally {
    agent.destroy();
    await closeWorkerServer(server);
  }
});

test("a server with an idle keep-alive connection open still closes", async () => {
  const server = createServer((req, res) => { res.end("ok"); });
  const port = await listenOnLoopback(server);
  const agent = new Agent({ keepAlive: true });
  try {
  await new Promise((resolve) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/", agent }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", resolve);
    request.end();
  });
  const settled = await Promise.race([
    closeWorkerServer(server).then(() => "closed", (error) => `failed: ${error.message}`),
    delay(3000).then(() => "hung"),
  ]);
  assert.equal(settled, "closed", "the server never closed with a connection still open");
  } finally {
    agent.destroy();
    await closeWorkerServer(server);
  }
});

test("a worker that is refused releases its keep-alive and exits instead of hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "bf-t6b-refused-"));
  chmodSync(root, 0o700);
  const controllerDir = join(root, "controller");
  const workerDir = join(root, "worker");
  const nonceDir = join(root, "nonce dir");
  mkdirSync(controllerDir, { recursive: true, mode: 0o700 });
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  mkdirSync(nonceDir, { recursive: true, mode: 0o700 });

  const credentialId = randomUUID();
  // The controller holds the digest of one secret and the worker presents
  // another, so the controller refuses the worker's registration.
  writeFixtureCredential(join(root, "worker-credential.json"), { credentialId, secret: "a".repeat(64) });
  const configFile = join(root, "fixture-config.json");
  writeFixtureConfig(configFile, {
    version: 1,
    controllerId: `server:${randomUUID()}`,
    workerId: `mac:${randomUUID()}`,
    epoch: 0,
    credentialId,
    secretSha256: createHash("sha256").update("b".repeat(64), "utf8").digest("hex"),
    controllerDir,
    workerDir,
    nonceDir,
    nonce: "t6b-refused",
    jobId: `job-${randomUUID()}`,
    nodePath: process.execPath,
    nonceScript: join(repoRoot, "server", "testing", "nonce-job.mjs"),
    credentialFile: join(root, "worker-credential.json"),
    controllerReadyFile: join(root, "controller.port"),
    controllerSummaryFile: join(root, "controller-summary.json"),
    workerSummaryFile: join(root, "worker-summary.json"),
    timeoutMs: 30_000,
  });

  const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: root, TMPDIR: root };
  const controller = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "server", "testing", "placement-controller-child.ts"), configFile], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  controller.stdout.resume();
  controller.stderr.resume();
  try {
    const ready = join(root, "controller.port");
    const deadline = Date.now() + 20_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("the controller never published its port");
      await delay(25);
    }

    const worker = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "server", "testing", "placement-worker-child.ts"), configFile], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.resume();
    let stderr = "";
    worker.stderr.on("data", (part) => { stderr += part.toString("utf8"); });
    const exit = await Promise.race([
      new Promise((resolve) => worker.on("exit", (code) => resolve(code))),
      delay(15_000).then(() => "hung"),
    ]);
    assert.notEqual(exit, "hung", "the worker child never exited after it was refused");
    assert.equal(exit, 2, `the worker child exited with ${exit} instead of the refusal code: ${stderr.slice(0, 400)}`);
    assert.match(stderr, /refused this worker's registration/, "the worker child did not report the refusal");
    assert.equal(existsSync(join(root, "worker-summary.json")), false, "a refused worker wrote a summary");
  } finally {
    controller.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("the producer and the two child processes read no environment value", () => {
  for (const relative of [
    "scripts/emit-placement-two-process-receipt.mjs",
    "server/testing/placement-controller-child.ts",
    "server/testing/placement-worker-child.ts",
    "server/testing/placement-two-process-config.ts",
    "server/testing/placement-worker-link.ts",
  ]) {
    const source = readFileSync(join(repoRoot, relative), "utf8");
    assert.equal(source.includes("process.env"), false, `${relative} reads the environment`);
  }
});
