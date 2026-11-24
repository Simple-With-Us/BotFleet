// The controller half of the two-process placement fixture (BF-2559 T6b).
//
// This runs as its own operating-system process, beside the worker half and
// beside the producer that reads what both of them wrote down.  That is the
// point of the slice:  the placement decision is made here, the job is run
// there, and only a decision that crossed a process boundary can produce the
// receipt this run leaves behind.
//
// The controller owns the lease authority (the SQLite store and the payload
// spool), the worker routes, and the one job the fixture offers.  It never
// dials the worker:  the worker pulls, over a loopback socket.
//
// Usage:
//   node server/testing/placement-controller-child.ts <fixture-config.json>
//
// It reads no environment value and holds no credential:  the presented
// secret stays in the worker half, and only its digest reaches this file.
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import { PLACEMENT_WIRE_VERSION } from "../../shared/placement.ts";
import { PlacementLeaseService } from "../placement-leases.ts";
import { PlacementPayloadSpool } from "../placement-payloads.ts";
import { openPlacementStore } from "../placement-store.ts";
import { createWorkerRequestBoundary, type WorkerAuthorization } from "../placement-worker-auth.ts";
import { createWorkerTransport } from "../placement-worker-routes.ts";
import { readFixtureConfig } from "./placement-two-process-config.ts";

/** The statuses a lease settles into. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "lost"]);

/**
 * The body of one worker request, read as JSON.
 *
 * The worker boundary parses this JSON against the worker's own schema
 * before any field of it is read, and it is the boundary's own contract
 * that a body arrives unparsed.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- HTTP boundary: the worker boundary parses this JSON against the worker's own schema before any field of it is read
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("the worker body is not JSON"));
      }
    });
  });
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: placement-controller-child.ts <fixture-config.json>");
  const config = readFixtureConfig(configPath);

  const store = openPlacementStore(config.controllerDir, config.controllerId);
  const payloads = new PlacementPayloadSpool(config.controllerDir);
  const leases = new PlacementLeaseService({
    hostId: config.controllerId,
    controller: { controllerId: config.controllerId, epoch: config.epoch },
    store,
    payloads,
  });

  // The job is offered before the worker can reach the controller, so the
  // worker never pulls an empty queue and never has to ask twice.
  const command = `${config.nodePath} ${config.nonceScript} ${config.nonceDir} ${config.nonce}`;
  const enqueued = leases.enqueue({
    version: PLACEMENT_WIRE_VERSION,
    controllerId: config.controllerId,
    epoch: config.epoch,
    jobId: config.jobId,
    botId: "bot-fixture",
    threadId: "thread-fixture",
    command,
    cwd: config.nonceDir,
    timeoutMs: config.timeoutMs,
  });
  if (!enqueued.ok || !enqueued.reply.accepted) {
    throw new Error(`the fixture job was refused: ${enqueued.ok ? enqueued.reply.reason : enqueued.reason}`);
  }

  const record: WorkerAuthorization = {
    format: "botfleet-placement-worker",
    version: 1,
    credentialId: config.credentialId,
    revision: 1,
    hostId: config.workerId,
    audience: config.controllerId,
    role: "execution-worker",
    secretSha256: config.secretSha256,
    revoked: false,
    expiresAt: null,
  };
  const boundary = createWorkerRequestBoundary({
    audience: config.controllerId,
    source: { read: () => record },
    transport: createWorkerTransport(leases),
    readBody,
  });
  const server = createServer((req, res) => {
    void boundary(req, res).catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());

  // The ready file is the only signal the producer waits for:  it appears
  // after the job is queued and the socket is listening, so the worker never
  // starts against a controller that is not there yet.
  writeFileSync(config.controllerReadyFile, `${port}\n`, { mode: 0o600 });

  const deadline = Date.now() + config.timeoutMs;
  let job = leases.job(config.jobId);
  while (job && !TERMINAL_STATUSES.has(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = leases.job(config.jobId);
  }
  if (!job) throw new Error("the fixture job disappeared from the controller's own record");
  if (!TERMINAL_STATUSES.has(job.status)) {
    throw new Error(`the fixture job did not settle: ${job.status}`);
  }

  writeFileSync(config.controllerSummaryFile, `${JSON.stringify({
    pid: process.pid,
    controllerId: config.controllerId,
    workerId: config.workerId,
    epoch: config.epoch,
    port,
    jobId: config.jobId,
    leaseId: job.leaseId ?? null,
    status: job.status,
    reportStatus: job.report?.status ?? null,
    exitCode: job.report?.exitCode ?? null,
  }, null, 2)}\n`, { mode: 0o600 });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
}

main().catch((error) => {
  console.error(`the placement controller child failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
