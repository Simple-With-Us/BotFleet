import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { archiveStore, emitReceipts, restoreArchive, restoredHealth } from "./archive-node-store.mjs";
import { evaluatePostReboot } from "./check-post-reboot-node.mjs";
import { captureRebootVerdict, soakVerdict, STATE_MARKER, STATE_VERSION, validateState } from "./check-soak-24h.mjs";
import { collectEvidenceBundle } from "./collect-decommission-evidence.mjs";
import {
  checkFinalEvidenceBundle, evidenceHash, REQUIRED_CHECKS, REQUIRED_RECEIPTS, REQUIRED_SURFACES,
} from "./decommission-evidence-bundle.mjs";
import { emitProcessInventoryReceipt } from "./emit-process-inventory-receipt.mjs";
import {
  assertSoakControllerFence, emitSoakReceipt, SOAK_RECEIPT_FILES,
} from "./emit-soak-receipt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT_SOAK_CLI = join(HERE, "emit-soak-receipt.mjs");
const SCRIPT_TMP_PARENT = "/tmp";

const CANDIDATE = {
  sourceSha: "a".repeat(40),
  build: "202611220101",
  artifactSha256: "b".repeat(64),
};

const MAC_HOST_ID = "mac:11111111-1111-4111-8111-111111111111";
const SERVER_HOST_ID = "server:22222222-2222-4222-8222-222222222222";

const HOSTS = [
  { id: MAC_HOST_ID, role: "mac" },
  { id: SERVER_HOST_ID, role: "server" },
];

const PASSED_SURFACES = Object.fromEntries(REQUIRED_SURFACES.map((surface) => [surface, "passed"]));

function makePrivateDir(prefix = "bf-2514-soak-") {
  const dir = mkdtempSync(join(SCRIPT_TMP_PARENT, prefix));
  chmodSync(dir, 0o700);
  return dir;
}

function removePrivateTree(root) {
  if (!existsSync(root)) return;
  const walk = (entryPath) => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(entryPath, 0o700);
      for (const name of readdirSync(entryPath)) walk(join(entryPath, name));
    } else if (stat.isFile()) {
      chmodSync(entryPath, 0o600);
    }
  };
  walk(root);
  rmSync(root, { recursive: true, force: true });
}

function writePrivateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return Buffer.from(content);
}

function makeBaseBundleRequest(stateBytes) {
  return {
    version: 1,
    candidate: CANDIDATE,
    mode: "serverFirst",
    hosts: HOSTS,
    acceptanceOwner: "Jay Wedgeworth",
    engines: ["claude"],
    state: {
      path: "state.json",
      sha256: evidenceHash(stateBytes),
    },
    receipts: {},
  };
}

function validInventoryRows() {
  return [
    "| `app.botfleet.server` | **Retired 2026-11-22** (owner, BF-2514: server is the single writer) | Was always-on while it existed; wrapper and plist backed up. |",
    "| `~/apps/botfleet-server-start.sh` | **Retired 2026-11-22** (owner, BF-2514). | Was loaded and was running under `app.botfleet.server`. |",
  ].join("\n") + "\n";
}

function cleanMacVerdict() {
  return {
    ok: true,
    checkedAt: "2026-11-23T00:05:00Z",
    platform: "darwin",
    launchDomain: { uid: 501, target: "gui/501", observed: true, skipped: false },
    launchProbes: [
      { label: "app.botfleet.server", loaded: false, running: false, skipped: false },
      { label: "app.botfleet.companion", loaded: false, running: false, skipped: false },
      { label: "com.jay.botfleet-server", loaded: false, running: false, skipped: false },
      { label: "com.jay.botfleet-companion", loaded: false, running: false, skipped: false },
    ],
    failures: [],
    details: {
      launchAgents: [],
      portListeners: [],
      processes: [],
      gitFiles: [],
      probeErrors: [],
    },
  };
}

function writeServerSoakFixtures(captureDir, request, {
  startIso = "2026-11-21T00:00:00Z",
  midIso = "2026-11-21T12:00:00Z",
  endIso = "2026-11-22T00:00:00Z",
  provenanceIso = "2026-11-22T00:05:00Z",
  controllerEpoch1 = 1,
  controllerEpoch2 = 2,
  controllerId2 = "server:22222222-2222-4222-8222-222222222222",
  logText1 = "2026-11-21T00:00:00Z server soak segment 1 healthy\n",
  logText2 = "2026-11-21T12:00:00Z server soak segment 2 healthy\n",
} = {}) {
  writePrivateFile(join(captureDir, "server-seg-1.log"), logText1);
  writePrivateFile(join(captureDir, "server-seg-2.log"), logText2);
  writePrivateFile(join(captureDir, "server-soak-prov.txt"), "BF-2514 Step 4 isolated soak capture\n");
  const observation = {
    startedAt: startIso,
    endedAt: endIso,
    segments: [
      {
        startedAt: startIso,
        endedAt: midIso,
        logPath: "server-seg-1.log",
        continuity: "uninterrupted",
        selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
        controllerId: "mac:11111111-1111-4111-8111-111111111111",
        controllerEpoch: controllerEpoch1,
        macHarness: "loaded-unused",
        surfaces: PASSED_SURFACES,
        inboundMessages: 42,
        serverSharedRoutineRuns: 1,
        macSharedRoutineRuns: 0,
      },
      {
        startedAt: midIso,
        endedAt: endIso,
        logPath: "server-seg-2.log",
        continuity: "uninterrupted",
        selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
        controllerId: controllerId2,
        controllerEpoch: controllerEpoch2,
        macHarness: "loaded-unused",
        surfaces: PASSED_SURFACES,
        inboundMessages: 58,
        serverSharedRoutineRuns: 0,
        macSharedRoutineRuns: 0,
      },
    ],
  };
  const observationPath = join(captureDir, "server-soak-observation.json");
  writePrivateFile(observationPath, JSON.stringify(observation, null, 2));
  const requestPath = join(captureDir, "request.json");
  writePrivateFile(requestPath, JSON.stringify(request, null, 2));
  return {
    observationPath,
    requestPath,
    provenance: {
      by: "BF-2514 Test Harness",
      at: provenanceIso,
      source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
      record: "server-soak-prov.txt",
    },
  };
}

test("emits server-writer-soak and no-mac-node-soak receipts that bind into an evidence bundle", async () => {
  const captureDir = makePrivateDir();
  try {
    const stateBytes = writePrivateFile(join(captureDir, "state.json"), JSON.stringify({ step: "bf-2514-prep" }));
    const request = makeBaseBundleRequest(stateBytes);

    const serverFixtures = writeServerSoakFixtures(captureDir, request);
    const serverResult = emitSoakReceipt({
      kind: "server-writer-soak",
      captureDir,
      request,
      observationPath: serverFixtures.observationPath,
      provenance: serverFixtures.provenance,
    });
    assert.equal(serverResult.kind, "server-writer-soak");
    assert.equal(serverResult.segmentCount, 2);
    assert.equal(serverResult.receipt.data.segments[0].macHarness, "loaded-unused");
    request.receipts["server-writer-soak"] = serverResult.reference;

    // Step 5/6 process inventory receipt (isolated fixture, zero live launchd/services).
    writePrivateFile(join(captureDir, "post-reboot-verdict.json"), JSON.stringify(cleanMacVerdict()));
    writePrivateFile(join(captureDir, "inventory-rows.md"), validInventoryRows());
    writePrivateFile(join(captureDir, "inv-prov.txt"), "isolated step 6 verdict capture\n");
    const invResult = emitProcessInventoryReceipt({
      captureDir,
      request,
      verdictPath: join(captureDir, "post-reboot-verdict.json"),
      inventoryRowsPath: join(captureDir, "inventory-rows.md"),
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-11-23T00:10:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: join(captureDir, "inv-prov.txt"),
      },
    });
    assert.equal(invResult.macHarness, "absent");
    assert.ok(invResult.reference);
    request.receipts["process-inventory"] = invResult.reference;

    writePrivateFile(join(captureDir, "no-node-seg-1.log"), "2026-11-23T01:00:00Z macHarness absent verified\n");
    writePrivateFile(join(captureDir, "no-node-prov.txt"), "BF-2515 no-mac-node soak capture\n");
    const noNodeObsPath = join(captureDir, "no-node-observation.json");
    writePrivateFile(noNodeObsPath, JSON.stringify({
      startedAt: "2026-11-23T00:30:00Z",
      endedAt: "2026-11-24T00:30:00Z",
      segments: [
        {
          startedAt: "2026-11-23T00:30:00Z",
          endedAt: "2026-11-24T00:30:00Z",
          logPath: "no-node-seg-1.log",
          continuity: "uninterrupted",
          selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
          controllerId: "server:22222222-2222-4222-8222-222222222222",
          controllerEpoch: 2,
          macHarness: "absent",
          surfaces: PASSED_SURFACES,
        },
      ],
    }));

    const noNodeResult = emitSoakReceipt({
      kind: "no-mac-node-soak",
      captureDir,
      request,
      observationPath: noNodeObsPath,
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-11-24T00:35:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: "no-node-prov.txt",
      },
      priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
      processInventoryPath: "process-inventory.receipt.json",
    });
    assert.equal(noNodeResult.kind, "no-mac-node-soak");
    request.receipts["no-mac-node-soak"] = noNodeResult.reference;

    const collected = await collectEvidenceBundle(request, {
      readCapturedFile: (relPath) => readFileSync(join(captureDir, relPath)),
    });
    assert.ok(!collected.missing.includes("server-writer-soak"));
    assert.ok(!collected.missing.includes("no-mac-node-soak"));
    assert.ok(!collected.missing.includes("process-inventory"));
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("rejects soak interval violations, unredacted credentials, non-private capture artifacts, and fence regressions", () => {
  const captureDir = makePrivateDir();
  try {
    const stateBytes = writePrivateFile(join(captureDir, "state.json"), "{}");
    const request = makeBaseBundleRequest(stateBytes);

    // 1. Short (<24h) interval
    const shortFixtures = writeServerSoakFixtures(captureDir, request, {
      endIso: "2026-11-21T23:59:59Z",
      provenanceIso: "2026-11-22T00:05:00Z",
    });
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observationPath: shortFixtures.observationPath,
        provenance: shortFixtures.provenance,
      }),
      /short of the/,
    );
    assert.equal(existsSync(join(captureDir, SOAK_RECEIPT_FILES["server-writer-soak"])), false);

    // 2. Unredacted credential in segment log (generic placeholder exercising BEARER redaction check)
    const secretFixtures = writeServerSoakFixtures(captureDir, request, {
      logText1: "Authorization: Bearer fixture-placeholder-token-value\n",
    });
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observationPath: secretFixtures.observationPath,
        provenance: secretFixtures.provenance,
      }),
      /unredacted credentials/,
    );

    // 3. Regressed controllerEpoch on handoff
    const regressedFixtures = writeServerSoakFixtures(captureDir, request, {
      controllerEpoch1: 3,
      controllerEpoch2: 3,
      controllerId2: "server:22222222-2222-4222-8222-222222222222",
    });
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observationPath: regressedFixtures.observationPath,
        provenance: regressedFixtures.provenance,
      }),
      /did not advance controllerEpoch/,
    );

    // 4. Hardlinked log artifact refused by createEvidenceReader
    const validFixtures = writeServerSoakFixtures(captureDir, request);
    const hardlinkAlias = join(captureDir, "server-seg-1-alias.log");
    linkSync(join(captureDir, "server-seg-1.log"), hardlinkAlias);
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observationPath: validFixtures.observationPath,
        provenance: validFixtures.provenance,
      }),
      /evidence-not-single-link-file|evidence-file-changed/,
    );
    rmSync(hardlinkAlias);

    // 5. Symlinked log artifact refused
    const outsideDir = makePrivateDir("bf-2514-outside-");
    try {
      writePrivateFile(join(outsideDir, "outside.log"), "outside log\n");
      rmSync(join(captureDir, "server-seg-2.log"));
      symlinkSync(join(outsideDir, "outside.log"), join(captureDir, "server-seg-2.log"));
      assert.throws(
        () => emitSoakReceipt({
          kind: "server-writer-soak",
          captureDir,
          request,
          observationPath: validFixtures.observationPath,
          provenance: validFixtures.provenance,
        }),
        /evidence-path-not-private/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("rejects server-writer host mismatch, shared routine mismatch, and non-preceding no-mac-node soak", () => {
  const captureDir = makePrivateDir();
  try {
    const stateBytes = writePrivateFile(join(captureDir, "state.json"), "{}");
    const request = makeBaseBundleRequest(stateBytes);

    // First emit a valid server-writer-soak receipt (epoch ends at 2, endedAt 2026-11-22T00:00:00Z).
    const valid = writeServerSoakFixtures(captureDir, request);
    emitSoakReceipt({
      kind: "server-writer-soak",
      captureDir,
      request,
      observationPath: valid.observationPath,
      provenance: valid.provenance,
    });

    // Reject Mac selectedWriterHostId on server-writer-soak and mid-soak writer changes.
    const macWriterObs = JSON.parse(readFileSync(valid.observationPath, "utf8"));
    macWriterObs.segments[0].selectedWriterHostId = "mac:11111111-1111-4111-8111-111111111111";
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observation: macWriterObs,
        provenance: valid.provenance,
      }),
      /must be a server: host/,
    );
    const flapWriterObs = JSON.parse(readFileSync(valid.observationPath, "utf8"));
    flapWriterObs.segments[1].selectedWriterHostId = "mac:11111111-1111-4111-8111-111111111111";
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observation: flapWriterObs,
        provenance: valid.provenance,
      }),
      /must be a server: host/,
    );

    // Reject macSharedRoutineRuns > 0.
    const dualRoutineObs = JSON.parse(readFileSync(valid.observationPath, "utf8"));
    dualRoutineObs.segments[0].macSharedRoutineRuns = 1;
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observation: dualRoutineObs,
        provenance: valid.provenance,
      }),
      /macSharedRoutineRuns must be 0/,
    );

    // Reject zero total serverSharedRoutineRuns for 24h window.
    const zeroRoutineObs = JSON.parse(readFileSync(valid.observationPath, "utf8"));
    zeroRoutineObs.segments[0].serverSharedRoutineRuns = 0;
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observation: zeroRoutineObs,
        provenance: valid.provenance,
      }),
      /serverSharedRoutineRuns total 0/,
    );

    // Reject missing --prior-soak or --process-inventory when emitting no-mac-node-soak.
    writePrivateFile(join(captureDir, "no-node.log"), "clean no-node log\n");
    writePrivateFile(join(captureDir, "no-node-prov.txt"), "prov\n");
    writePrivateFile(join(captureDir, "post-reboot-verdict.json"), JSON.stringify(cleanMacVerdict()));
    writePrivateFile(join(captureDir, "inventory-rows.md"), validInventoryRows());
    writePrivateFile(join(captureDir, "inv-prov.txt"), "inventory prov\n");
    emitProcessInventoryReceipt({
      captureDir,
      request,
      verdictPath: join(captureDir, "post-reboot-verdict.json"),
      inventoryRowsPath: join(captureDir, "inventory-rows.md"),
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-11-22T00:10:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: join(captureDir, "inv-prov.txt"),
      },
    });

    const overlapNoNodeObs = {
      startedAt: "2026-11-21T23:00:00Z",
      endedAt: "2026-11-22T23:00:00Z",
      segments: [{
        startedAt: "2026-11-21T23:00:00Z",
        endedAt: "2026-11-22T23:00:00Z",
        logPath: "no-node.log",
        continuity: "uninterrupted",
        selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
        controllerId: "server:22222222-2222-4222-8222-222222222222",
        controllerEpoch: 2,
        macHarness: "absent",
        surfaces: PASSED_SURFACES,
      }],
    };
    const noNodeProv = {
      by: "BF-2514 Test Harness",
      at: "2026-11-22T23:05:00Z",
      source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
      record: "no-node-prov.txt",
    };

    assert.throws(
      () => emitSoakReceipt({
        kind: "no-mac-node-soak",
        captureDir,
        request,
        observation: overlapNoNodeObs,
        provenance: noNodeProv,
        priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
      }),
      /--prior-soak and --process-inventory are required/,
    );

    // Reject no-mac-node-soak overlapping before server-writer-soak ended.
    assert.throws(
      () => emitSoakReceipt({
        kind: "no-mac-node-soak",
        captureDir,
        request,
        observation: overlapNoNodeObs,
        provenance: noNodeProv,
        priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
        processInventoryPath: "process-inventory.receipt.json",
      }),
      /must precede no-mac-node-soak/,
    );

    // Reject Mac selectedWriterHostId on no-mac-node-soak.
    const noNodeMacWriterObs = {
      startedAt: "2026-11-22T00:30:00Z",
      endedAt: "2026-11-23T00:30:00Z",
      segments: [{
        startedAt: "2026-11-22T00:30:00Z",
        endedAt: "2026-11-23T00:30:00Z",
        logPath: "no-node.log",
        continuity: "uninterrupted",
        selectedWriterHostId: "mac:11111111-1111-4111-8111-111111111111",
        controllerId: "server:22222222-2222-4222-8222-222222222222",
        controllerEpoch: 2,
        macHarness: "absent",
        surfaces: PASSED_SURFACES,
      }],
    };
    assert.throws(
      () => emitSoakReceipt({
        kind: "no-mac-node-soak",
        captureDir,
        request,
        observation: noNodeMacWriterObs,
        provenance: { ...noNodeProv, at: "2026-11-23T00:35:00Z" },
        priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
        processInventoryPath: "process-inventory.receipt.json",
      }),
      /must be a server: host/,
    );

    // Reject a process-inventory receipt missing required checks.
    const partialInv = JSON.parse(readFileSync(join(captureDir, "process-inventory.receipt.json"), "utf8"));
    partialInv.data.checks = [partialInv.data.checks[0]];
    writePrivateFile(join(captureDir, "partial-inventory.receipt.json"), JSON.stringify(partialInv));
    assert.throws(
      () => emitSoakReceipt({
        kind: "no-mac-node-soak",
        captureDir,
        request,
        observation: {
          startedAt: "2026-11-22T00:30:00Z",
          endedAt: "2026-11-23T00:30:00Z",
          segments: [{
            startedAt: "2026-11-22T00:30:00Z",
            endedAt: "2026-11-23T00:30:00Z",
            logPath: "no-node.log",
            continuity: "uninterrupted",
            selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
            controllerId: "server:22222222-2222-4222-8222-222222222222",
            controllerEpoch: 2,
            macHarness: "absent",
            surfaces: PASSED_SURFACES,
          }],
        },
        provenance: { ...noNodeProv, at: "2026-11-23T00:35:00Z" },
        priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
        processInventoryPath: "partial-inventory.receipt.json",
      }),
      /missing passing check/,
    );

    // Accept an absolute logPath passing through a symlinked parent alias (like macOS /var -> /private/var).
    const aliasBase = mkdtempSync(join(SCRIPT_TMP_PARENT, "bf-2514-alias-"));
    try {
      const aliasCapture = join(aliasBase, "capture-link");
      symlinkSync(captureDir, aliasCapture);
      const aliasResult = emitSoakReceipt({
        kind: "no-mac-node-soak",
        captureDir,
        request,
        observation: {
          startedAt: "2026-11-22T00:30:00Z",
          endedAt: "2026-11-23T00:30:00Z",
          segments: [{
            startedAt: "2026-11-22T00:30:00Z",
            endedAt: "2026-11-23T00:30:00Z",
            logPath: join(aliasCapture, "no-node.log"),
            continuity: "uninterrupted",
            selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
            controllerId: "server:22222222-2222-4222-8222-222222222222",
            controllerEpoch: 2,
            macHarness: "absent",
            surfaces: PASSED_SURFACES,
          }],
        },
        provenance: {
          ...noNodeProv,
          at: "2026-11-23T00:35:00Z",
        },
        priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
        processInventoryPath: "process-inventory.receipt.json",
      });
      assert.equal(aliasResult.receipt.data.segments[0].log.path, "no-node.log");
    } finally {
      rmSync(aliasBase, { recursive: true, force: true });
    }

    // Accept an in-capture file whose name starts with `..` (not a parent-directory escape).
    writePrivateFile(join(captureDir, "..data.log"), "clean leading-dotdot filename\n");
    const dotdotResult = emitSoakReceipt({
      kind: "no-mac-node-soak",
      captureDir,
      request,
      observation: {
        startedAt: "2026-11-22T00:30:00Z",
        endedAt: "2026-11-23T00:30:00Z",
        segments: [{
          startedAt: "2026-11-22T00:30:00Z",
          endedAt: "2026-11-23T00:30:00Z",
          logPath: "..data.log",
          continuity: "uninterrupted",
          selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
          controllerId: "server:22222222-2222-4222-8222-222222222222",
          controllerEpoch: 2,
          macHarness: "absent",
          surfaces: PASSED_SURFACES,
        }],
      },
      provenance: {
        ...noNodeProv,
        at: "2026-11-23T00:35:00Z",
      },
      priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
      processInventoryPath: "process-inventory.receipt.json",
    });
    assert.equal(dotdotResult.receipt.data.segments[0].log.path, "..data.log");

    // Reject unknown fields in provenance and oversized host IDs.
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observationPath: valid.observationPath,
        provenance: { ...valid.provenance, extraField: "unexpected" },
      }),
      /unrecognized fields/,
    );
    const oversizedHostObs = JSON.parse(readFileSync(valid.observationPath, "utf8"));
    oversizedHostObs.segments[0].selectedWriterHostId = `server:${"a".repeat(300)}`;
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observation: oversizedHostObs,
        provenance: valid.provenance,
      }),
      /does not match expected schema/,
    );
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        observationPath: valid.observationPath,
        provenance: { ...valid.provenance, at: `2026-11-22T00:05:00.${"0".repeat(80)}Z` },
      }),
      /ISO 8601 date and time/,
    );
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        captureDir,
        request,
        provenance: valid.provenance,
      }),
      /missing soak observation/,
    );
    assert.throws(
      () => emitSoakReceipt({
        kind: "server-writer-soak",
        request,
        observationPath: valid.observationPath,
        provenance: valid.provenance,
      }),
      /missing captureDir/,
    );

    // Also verify assertSoakControllerFence helper blocks epoch rollback directly.
    assert.throws(
      () => assertSoakControllerFence(
        { controllerId: "server:22222222-2222-4222-8222-222222222222", controllerEpoch: 5 },
        { controllerId: "mac:11111111-1111-4111-8111-111111111111", controllerEpoch: 5 },
      ),
      /did not advance controllerEpoch/,
    );
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("CLI runs end-to-end and refuses unknown or server-writer cross-flags", () => {
  const captureDir = makePrivateDir();
  try {
    const stateBytes = writePrivateFile(join(captureDir, "state.json"), "{}");
    const request = makeBaseBundleRequest(stateBytes);
    const valid = writeServerSoakFixtures(captureDir, request);

    const okRun = spawnSync(process.execPath, [
      EMIT_SOAK_CLI,
      "--kind", "server-writer-soak",
      "--capture", captureDir,
      "--request", valid.requestPath,
      "--observation", valid.observationPath,
      "--provenance-record", "server-soak-prov.txt",
      "--provenance-source", valid.provenance.source,
      "--provenance-by", valid.provenance.by,
      "--provenance-at", valid.provenance.at,
    ], { encoding: "utf8" });
    assert.equal(okRun.status, 0, okRun.stderr);
    const out = JSON.parse(okRun.stdout);
    assert.equal(out.kind, "server-writer-soak");
    assert.deepEqual(out.emitted, ["server-writer-soak.receipt.json"]);
    assert.ok(out.receipts["server-writer-soak"].sha256);

    const badFlagRun = spawnSync(process.execPath, [
      EMIT_SOAK_CLI,
      "--kind", "server-writer-soak",
      "--capture", captureDir,
      "--request", valid.requestPath,
      "--observation", valid.observationPath,
      "--provenance-record", "server-soak-prov.txt",
      "--provenance-source", valid.provenance.source,
      "--provenance-by", valid.provenance.by,
      "--provenance-at", valid.provenance.at,
      "--prior-soak", "server-writer-soak.receipt.json",
    ], { encoding: "utf8" });
    assert.equal(badFlagRun.status, 2);
    assert.match(badFlagRun.stderr, /apply only to no-mac-node-soak/);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("BF-2514 isolated single-writer, archive/restore rollback, and final bundle gate exercise fail-closed paths", async () => {
  const workDir = makePrivateDir("bf-2514-e2e-");
  try {
    // 1. Isolated Node store archive -> tamper check -> restore rehearsal -> rollback receipt.
    const storeDir = join(workDir, "store");
    const archiveDir = join(workDir, "archive");
    const restoreDir = join(workDir, "restored");
    const captureDir = join(workDir, "capture");
    mkdirSync(storeDir, { mode: 0o700 });
    mkdirSync(captureDir, { mode: 0o700 });
    chmodSync(storeDir, 0o700);
    chmodSync(captureDir, 0o700);

    writePrivateFile(join(storeDir, "routines.json"), JSON.stringify({ routines: [{ id: "6d74f498", enabled: true }] }));
    writePrivateFile(join(storeDir, "runtime.log"), "2026-11-22T00:00:00Z isolated store ready\n");
    const db = new DatabaseSync(join(storeDir, "messages.db"));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages (body) VALUES ('ok');");
    db.close();
    chmodSync(join(storeDir, "messages.db"), 0o600);

    const archResult = await archiveStore({
      storeRoot: storeDir,
      outDir: archiveDir,
      capturedAt: "2026-11-23T00:02:00Z",
    });
    assert.equal(archResult.report.readOnlyProved, true);
    assert.equal(archResult.report.redactionFailures, 0);

    const restored = restoreArchive({
      archiveDir,
      intoDir: restoreDir,
      restoredAt: "2026-11-23T00:03:00Z",
    });
    assert.equal(restored.ok, true);
    const health = restoredHealth(restoreDir, { referenceDir: storeDir });
    assert.equal(health.ok, true);

    writePrivateFile(join(captureDir, "restore-report.json"), JSON.stringify(restored, null, 2));
    writePrivateFile(join(captureDir, "restore-health.json"), JSON.stringify(health, null, 2));
    writePrivateFile(join(captureDir, "rollback-prov.txt"), "isolated rollback rehearsal record\n");

    const gateState = { step: "bf-2514-bf-2515-isolated-gate" };
    const statePath = join(captureDir, "state.json");
    const stateBytes = writePrivateFile(statePath, JSON.stringify(gateState));
    const request = makeBaseBundleRequest(stateBytes);

    emitReceipts({
      captureDir,
      request,
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-11-23T00:05:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: join(captureDir, "rollback-prov.txt"),
      },
    });
    request.receipts.rollback = {
      path: "rollback.receipt.json",
      sha256: evidenceHash(readFileSync(join(captureDir, "rollback.receipt.json"))),
    };

    // 2. Bookend soak helper from check-soak-24h.mjs validates clean 24h ends.
    const soakStart = captureRebootVerdict(() => ({
      status: 0, stdout: JSON.stringify(cleanMacVerdict()), stderr: "",
    }), Date.parse("2026-11-23T00:30:00Z"));
    assert.equal(validateState({ marker: STATE_MARKER, version: STATE_VERSION, ...soakStart }), null);
    const soakEnd = captureRebootVerdict(() => ({
      status: 0, stdout: JSON.stringify(cleanMacVerdict()), stderr: "",
    }), Date.parse("2026-11-24T00:30:00Z"));
    assert.equal(soakVerdict(soakStart, soakEnd, Date.parse("2026-11-24T00:30:00Z")).ok, true);

    // 3. Emit real process-inventory, server-writer-soak, and no-mac-node-soak receipts.
    writePrivateFile(join(captureDir, "post-reboot-verdict.json"), JSON.stringify(cleanMacVerdict()));
    writePrivateFile(join(captureDir, "inventory-rows.md"), validInventoryRows());
    writePrivateFile(join(captureDir, "inv-prov.txt"), "step 6 inventory capture\n");
    const invResult = emitProcessInventoryReceipt({
      captureDir,
      request,
      verdictPath: join(captureDir, "post-reboot-verdict.json"),
      inventoryRowsPath: join(captureDir, "inventory-rows.md"),
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-11-23T00:10:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: join(captureDir, "inv-prov.txt"),
      },
    });
    request.receipts["process-inventory"] = invResult.reference;

    const srvFixtures = writeServerSoakFixtures(captureDir, request);
    request.receipts["server-writer-soak"] = emitSoakReceipt({
      kind: "server-writer-soak",
      captureDir,
      request,
      observationPath: srvFixtures.observationPath,
      provenance: srvFixtures.provenance,
    }).reference;

    writePrivateFile(join(captureDir, "no-node.log"), "24h no-node isolated soak healthy\n");
    writePrivateFile(join(captureDir, "no-node-prov.txt"), "no-node soak provenance\n");
    request.receipts["no-mac-node-soak"] = emitSoakReceipt({
      kind: "no-mac-node-soak",
      captureDir,
      request,
      observation: {
        startedAt: "2026-11-23T00:30:00Z",
        endedAt: "2026-11-24T00:30:00Z",
        segments: [{
          startedAt: "2026-11-23T00:30:00Z",
          endedAt: "2026-11-24T00:30:00Z",
          logPath: "no-node.log",
          continuity: "uninterrupted",
          selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
          controllerId: "server:22222222-2222-4222-8222-222222222222",
          controllerEpoch: 2,
          macHarness: "absent",
          surfaces: PASSED_SURFACES,
        }],
      },
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-11-24T00:35:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: "no-node-prov.txt",
      },
      priorSoakPath: SOAK_RECEIPT_FILES["server-writer-soak"],
      processInventoryPath: "process-inventory.receipt.json",
    }).reference;

    // Fill the non-BF-2514 receipts in the isolated fixture packet so checkFinalEvidenceBundle runs end-to-end.
    const stubArtifact = { path: "stub-artifact.txt", sha256: evidenceHash(writePrivateFile(join(captureDir, "stub-artifact.txt"), "fixture artifact\n")) };
    const baseHeader = (at) => ({
      version: 1,
      candidate: CANDIDATE,
      mode: "serverFirst",
      hosts: HOSTS,
      provenance: {
        by: "BF-2514 Test Harness",
        at,
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: stubArtifact,
      },
    });
    const emitOther = (kind, data, at = "2026-11-24T01:00:00Z") => {
      const file = `${kind}.receipt.json`;
      const bytes = writePrivateFile(join(captureDir, file), JSON.stringify({ ...baseHeader(at), kind, data }, null, 2));
      request.receipts[kind] = { path: file, sha256: evidenceHash(bytes) };
    };
    const manifestObj = { version: 1, target: "test", files: [] };
    const manifestBytes = writePrivateFile(join(captureDir, "placement-manifest.json"), JSON.stringify(manifestObj));
    emitOther("placement", {
      manifest: { path: "placement-manifest.json", sha256: evidenceHash(manifestBytes) },
      artifacts: [],
    });
    emitOther("import", {
      checks: REQUIRED_CHECKS.import.map((name) => ({ name, exitCode: 0, artifact: stubArtifact })),
    });
    emitOther("replay", { checks: [{ name: "engine:claude", exitCode: 0, artifact: stubArtifact }] });
    emitOther("signed-release", {
      checks: REQUIRED_CHECKS["signed-release"].map((name) => ({ name, exitCode: 0, artifact: stubArtifact })),
      bundleId: "app.botfleet.macos",
      teamId: "TEAM123456",
      designatedRequirement: "identifier \"app.botfleet.macos\"",
      previousBuild: "202611200101",
    });
    emitOther("linux-retention", {
      checks: REQUIRED_CHECKS["linux-retention"].map((name) => ({ name, exitCode: 0, artifact: stubArtifact })),
      maintainedSourceSha: "c".repeat(40),
      rollbackSourceSha: "d".repeat(40),
      closureManifest: stubArtifact,
    });
    emitOther("control-disposition", {
      checks: REQUIRED_CHECKS["control-disposition"].map((name) => ({ name, exitCode: 0, artifact: stubArtifact })),
    });
    emitOther("change-plan", {
      checks: REQUIRED_CHECKS["change-plan"].map((name) => ({ name, exitCode: 0, artifact: stubArtifact })),
      jobs: ["app.botfleet.server"],
      files: ["scripts/launchd/app.botfleet.server.plist"],
      appCopies: ["/Applications/BotFleet.app"],
    });
    emitOther("daily-driver", {
      startedAt: "2026-11-24T01:00:00Z",
      endedAt: "2026-12-01T01:00:00Z",
      segments: [{
        startedAt: "2026-11-24T01:00:00Z",
        endedAt: "2026-12-01T01:00:00Z",
        log: stubArtifact,
        continuity: "uninterrupted",
        selectedWriterHostId: "server:22222222-2222-4222-8222-222222222222",
        controllerId: "server:22222222-2222-4222-8222-222222222222",
        controllerEpoch: 2,
        nativeApp: "signed-native-daily-driver",
        iosSession: "passed",
        openOnMac: "passed",
        processInventory: "recorded",
      }],
    }, "2026-12-01T01:05:00Z");
    const acceptHeader = baseHeader("2026-12-02T00:00:00Z");
    acceptHeader.provenance.by = "Jay Wedgeworth";
    const acceptBytes = writePrivateFile(join(captureDir, "owner-acceptance.receipt.json"), JSON.stringify({
      ...acceptHeader,
      kind: "owner-acceptance",
      data: { decision: "accepted", action: "delete-mac-local-node-source", dailyDriverAccepted: true },
    }));
    request.receipts["owner-acceptance"] = { path: "owner-acceptance.receipt.json", sha256: evidenceHash(acceptBytes) };

    const bundlePath = join(captureDir, "bundle.json");
    writePrivateFile(bundlePath, JSON.stringify(request, null, 2));

    // Only placement lacks full real manifest files in this non-placement fixture, so check specifically
    // that NONE of server-writer-soak, no-mac-node-soak, process-inventory, rollback, import, or soaks report blockers.
    assert.deepEqual(Object.keys(request.receipts).sort(), [...REQUIRED_RECEIPTS].sort());
    const verdict = checkFinalEvidenceBundle(bundlePath, {
      statePath,
      stateBytes,
      candidate: CANDIDATE,
      now: Date.parse("2026-12-02T00:05:00Z"),
    });
    const bf2514Blockers = verdict.blockers.filter((entry) =>
      entry.startsWith("server-writer-soak:")
      || entry.startsWith("no-mac-node-soak:")
      || entry.startsWith("process-inventory:")
      || entry.startsWith("rollback:")
      || entry.startsWith("import:")
      || entry.startsWith("soaks:")
    );
    assert.deepEqual(bf2514Blockers, []);

    // 4. Simulate incomplete retirement / rollback: process-inventory removes stale receipt when server agent reappears.
    const rolledBackVerdict = cleanMacVerdict();
    rolledBackVerdict.launchProbes[0] = { label: "app.botfleet.server", loaded: true, running: true, skipped: false };
    rolledBackVerdict.details.launchAgents = [{ label: "app.botfleet.server", loaded: true, running: true }];
    const recomputed = evaluatePostReboot(rolledBackVerdict.details);
    rolledBackVerdict.ok = recomputed.ok;
    rolledBackVerdict.failures = recomputed.failures;
    writePrivateFile(join(captureDir, "rolled-back-verdict.json"), JSON.stringify(rolledBackVerdict));
    const rollbackInv = emitProcessInventoryReceipt({
      captureDir,
      request,
      verdictPath: join(captureDir, "rolled-back-verdict.json"),
      inventoryRowsPath: join(captureDir, "inventory-rows.md"),
      provenance: {
        by: "BF-2514 Test Harness",
        at: "2026-12-02T00:10:00Z",
        source: "https://github.com/Simple-With-Us/BotFleet/issues/2514",
        record: join(captureDir, "inv-prov.txt"),
      },
    });
    assert.equal(rollbackInv.macHarness, "present");
    assert.equal(rollbackInv.receipt, null);
    assert.equal(existsSync(join(captureDir, "process-inventory.receipt.json")), false);
  } finally {
    removePrivateTree(workDir);
  }
});
