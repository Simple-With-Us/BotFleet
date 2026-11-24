// The worker half of the two-process placement fixture (BF-2559 T6b).
//
// This runs as its own operating-system process, beside the controller half
// and beside the producer that reads what both of them wrote down.  It pulls
// the assignment the controller offers, runs the job through the real runner
// backed adapter, and reports the result back over the same loopback socket.
//
// It reads no environment value:  the credential it presents comes from a
// private file the producer wrote, and the presented secret never appears in
// what this process writes down.
//
// Usage:
//   node server/testing/placement-worker-child.ts <fixture-config.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnJobProcess } from "../jobs/runner.ts";
import { PlacementReportSpool } from "../placement-report-spool.ts";
import { createPlacementWorkerJobs } from "../placement-worker-jobs.ts";
import { nodeHttpWorkerLink, PlacementWorkerClient } from "../placement-worker-client.ts";
import { PlacementWorkerRuntime, type PlacementWorkerClientLike } from "../placement-worker-runtime.ts";
import type { CapacitySample } from "../../shared/placement.ts";
import { readFixtureConfig, readFixtureCredential } from "./placement-two-process-config.ts";

/** What this process saw cross the process boundary. */
interface WorkerObservation {
  assignments: number;
  assignmentAccepted: boolean;
  jobId: string | null;
  leaseId: string | null;
  spawns: number;
}

/** A fixed capacity sample:  the fixture measures no real host. */
const SAMPLE: CapacitySample = {
  at: 1,
  cores: null,
  loadPerCore: null,
  ramTotalBytes: null,
  ramAvailableBytes: null,
  memoryPressure: null,
  memoryAvailablePercent: null,
  swapTotalBytes: null,
  swapUsedBytes: null,
  diskTotalBytes: null,
  diskFreeBytes: null,
  inodesTotal: null,
  inodesFree: null,
  dataVolume: null,
  rootDiskFreeBytes: null,
};

/** Read the controller's loopback port once it has published it. */
async function readControllerPort(path: string, deadline: number): Promise<number> {
  for (;;) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      // The controller publishes the port as one newline-terminated write,
      // so a read that catches the write mid-flight sees a truncated port
      // with no newline:  only a complete, in-range payload is a port, and
      // anything else retries until the deadline like a missing file.
      if (raw.endsWith("\n")) {
        const port = Number(raw.trim());
        if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
      }
    }
    if (Date.now() >= deadline) throw new Error("the controller never published its port");
    // The wait is short on purpose:  the producer starts this child right
    // after the controller is ready, so the wait is a moment, not a timeout
    // that has to expire.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: placement-worker-child.ts <fixture-config.json>");
  const config = readFixtureConfig(configPath);
  const credential = readFixtureCredential(config.credentialFile);

  const port = await readControllerPort(config.controllerReadyFile, Date.now() + config.timeoutMs);
  // The credential is passed on, not spelled out here:  the fixture file
  // holds the value, and this file only carries it to the client.
  const workerCredentialId = credential.credentialId;
  const workerSecret = credential.secret;
  const base = new PlacementWorkerClient({
    credential: { credentialId: workerCredentialId, secret: workerSecret },
    workerHostId: config.workerId,
    audience: config.controllerId,
    controller: { controllerId: config.controllerId, epoch: config.epoch },
    baseUrl: `http://127.0.0.1:${port}/`,
    fetchImpl: nodeHttpWorkerLink(),
  });

  // What crossed the process boundary, as this process saw it.
  const observed: WorkerObservation = {
    assignments: 0, assignmentAccepted: false, jobId: null, leaseId: null, spawns: 0,
  };
  const client: PlacementWorkerClientLike = {
    register: (req) => base.register(req),
    heartbeat: (req) => base.heartbeat(req),
    assignment: async () => {
      const outcome = await base.assignment();
      observed.assignments += 1;
      if (outcome.outcome === "accepted") observed.assignmentAccepted = true;
      return outcome;
    },
    payload: (req) => {
      observed.jobId = req.jobId;
      observed.leaseId = req.leaseId;
      return base.payload(req);
    },
    report: (message) => base.report(message),
    stopReceipt: (req) => base.stopReceipt(req),
  };

  const spool = new PlacementReportSpool(config.workerDir);
  const jobs = createPlacementWorkerJobs({
    dataDir: config.workerDir,
    cpuCores: () => 2,
    spawn: (spec) => {
      observed.spawns += 1;
      return spawnJobProcess(spec);
    },
  });
  const runtime = new PlacementWorkerRuntime({
    client,
    spool,
    hostId: config.workerId,
    capabilities: ["shell"],
    dataDir: config.workerDir,
    sampleProvider: () => ({ ...SAMPLE, at: Date.now() }),
    admissionProvider: () => ({ admit: true }),
    spawnJob: jobs.spawnJob,
    stopJob: jobs.stopJob,
    watchProcess: jobs.watchProcess,
    isProcessAlive: jobs.isProcessAlive,
    readExit: jobs.readExit,
  });

  // The runtime's own timers are unref'd on purpose, so a running job never
  // holds the harness open.  A standalone fixture child has nothing else to
  // keep its loop alive, and the job's own exit is observed through the
  // spawned child's exit event, so this child holds the loop open itself
  // until the job settles.
  //
  // The hold is cleared in a `finally`, so a failure on the way through
  // releases it too:  an interval that outlived the failure would keep this
  // child alive until the producer's deadline, long after the job that was
  // supposed to run had failed.
  const hold = setInterval(() => undefined, 200);
  try {
    const registration = await runtime.register();
    if (registration.outcome !== "accepted") {
      throw new Error(`the controller refused this worker's registration: ${registration.reason}`);
    }
    await runtime.tickHeartbeat();
    const pulled = await runtime.pullAssignment();
    if (!pulled.jobId) throw new Error("the controller offered this worker no assignment");
    await runtime.waitForJob(pulled.jobId);

    writeFileSync(config.workerSummaryFile, `${JSON.stringify({
      pid: process.pid,
      controllerId: config.controllerId,
      workerId: config.workerId,
      epoch: config.epoch,
      jobId: observed.jobId ?? pulled.jobId,
      leaseId: observed.leaseId,
      spawns: observed.spawns,
      registered: runtime.isRegistered(),
      pendingReports: spool.pending().length,
    }, null, 2)}\n`, { mode: 0o600 });
  } finally {
    clearInterval(hold);
  }
}

main().catch((error) => {
  console.error(`the placement worker child failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
