/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// The thirteen-receipt evidence packet, assembled in a fixture (BF-2692).
//
// The decommission gate's final CLI wants a packet with every receipt, bound
// to one candidate, and it refuses a packet that is missing any of them.
// Nothing in the tree could assemble that packet, because three of the
// receipt kinds had no producer at all.
//
// This file assembles one in a temporary private directory, from synthetic
// artifacts and synthetic receipts, and runs the real validator over it.  It
// proves that the packet shape the gate wants is reachable, and that the
// validator accepts a complete one and refuses an incomplete one.
//
// It proves nothing about a real install.  Every artifact is a fixture, the
// receipts are written by hand here because the collector refuses to
// synthesize owner acceptance by design, and the whole directory is removed
// when the test ends.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkFinalEvidenceBundle,
  evidenceHash,
  REQUIRED_RECEIPTS,
} from "./decommission-evidence-bundle.mjs";
import {
  HAND_RUN_PLACEMENT_EVIDENCE,
  REQUIRED_PLACEMENT_EVIDENCE,
} from "./check-placement-evidence.mjs";

const CANDIDATE = {
  sourceSha: "a".repeat(40),
  build: "202611230101",
  artifactSha256: "b".repeat(64),
};
const HOSTS = [
  { id: "mac:11111111-2222-3333-4444-555555555555", role: "mac" },
  { id: "server:66666666-7777-8888-9999-aaaaaaaaaaaa", role: "server" },
];
const MODE = "serverFirst";
const OWNER = "Fixture Owner";
const PROVENANCE_AT = "2026-11-23T06:00:00.000Z";

/**
 * A private fixture directory.
 */
function privateDir() {
  const root = mkdtempSync(join(tmpdir(), "bf-packet-"));
  chmodSync(root, 0o700);
  return root;
}

/**
 * Write one artifact into the fixture and return its reference.
 */
function artifact(root, name, content) {
  writeFileSync(join(root, name), content, { mode: 0o600 });
  return { path: name, sha256: evidenceHash(Buffer.from(content, "utf8")) };
}

/**
 * The provenance every receipt in the fixture carries.
 */
function provenance(root) {
  return {
    by: OWNER,
    at: PROVENANCE_AT,
    source: "https://example.com/fixture",
    record: artifact(root, "provenance.txt", "recorded by the fixture reviewer\n"),
  };
}

/**
 * One check per name, each pointing at its own artifact.
 *
 * The artifact path is a plain file name:  the bundle's own path rule allows
 * letters, digits, dots, slashes, underscores and dashes, and a check NAME
 * may hold a colon where a path may not.
 */
function checks(root, names) {
  return names.map((name) => {
    const file = `${name.replace(/[^A-Za-z0-9_.-]/g, "-")}.txt`;
    return {
      name,
      exitCode: 0,
      artifact: artifact(root, file, `${name} evidence\n`),
    };
  });
}

/**
 * The artifacts the placement manifest names, as the receipt's list.
 */
function placementArtifacts() {
  const artifacts = [];
  for (const key of HAND_RUN_PLACEMENT_EVIDENCE) {
    artifacts.push({
      path: `placement-${key}.log`,
      sha256: evidenceHash(Buffer.from(`${key} hand run\n`, "utf8")),
    });
  }
  for (const host of ["server", "mac"]) {
    artifacts.push({
      path: `placement-inventory-${host}.json`,
      sha256: evidenceHash(Buffer.from("{}\n", "utf8")),
    });
  }
  return artifacts;
}

/**
 * The placement evidence manifest the placement receipt carries.
 *
 * The sixteen recipes are asserted here because this is a fixture:  the
 * packet's shape is what is being proved, and every artifact it names is a
 * synthetic file in a temporary directory that the test removes.  A real
 * packet carries the receipts the owner's runs produced.
 */
function placementManifest(root) {
  const evidence = {};
  for (const key of REQUIRED_PLACEMENT_EVIDENCE) evidence[key] = true;
  const handRun = {};
  for (const key of HAND_RUN_PLACEMENT_EVIDENCE) {
    const file = `placement-${key}.log`;
    artifact(root, file, `${key} hand run\n`);
    handRun[key] = { at: "2026-11-02 9:15 AM", by: "Fixture Reviewer", log: file };
  }
  artifact(root, "placement-inventory-server.json", "{}\n");
  artifact(root, "placement-inventory-mac.json", "{}\n");
  const manifest = {
    evidence,
    handRun,
    inventory: {
      server: "placement-inventory-server.json",
      mac: "placement-inventory-mac.json",
    },
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, "placement-evidence.json"), text, { mode: 0o600 });
  return { path: "placement-evidence.json", sha256: evidenceHash(Buffer.from(text, "utf8")) };
}

/**
 * The observation a soak or the daily driver records.
 */
function observation(startIso, endIso, hostId, extra = {}) {
  return {
    startedAt: startIso,
    endedAt: endIso,
    segments: [{
      startedAt: startIso,
      endedAt: endIso,
      log: { path: "segment.log", sha256: evidenceHash(Buffer.from("segment log\n", "utf8")) },
      continuity: "uninterrupted",
      selectedWriterHostId: hostId,
      controllerId: hostId,
      controllerEpoch: 1,
      ...extra,
    }],
  };
}

/**
 * Assemble the whole packet in a fixture directory.
 *
 * @param {{skip?: string}} [options] the receipt kind to leave out, so the
 *   validator's refusal can be observed.
 */
function assemblePacket(options = {}) {
  const root = privateDir();
  writeFileSync(join(root, "segment.log"), "segment log\n", { mode: 0o600 });
  const prov = provenance(root);
  const stateText = `${JSON.stringify({ inventoryClean: true }, null, 2)}\n`;
  writeFileSync(join(root, "state.json"), stateText, { mode: 0o600 });
  const state = { path: "state.json", sha256: evidenceHash(Buffer.from(stateText, "utf8")) };

  const day = 24 * 60 * 60 * 1000;
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();

  const receipts = {
    placement: {
      version: 1,
      kind: "placement",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: {
        manifest: placementManifest(root),
        // Every artifact the manifest names is listed here, so the bundle
        // can bind each one by hash.
        artifacts: placementArtifacts(),
      },
    },
    import: {
      version: 1,
      kind: "import",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: { checks: checks(root, ["parity", "read-only-archive"]) },
    },
    replay: {
      version: 1,
      kind: "replay",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: { checks: checks(root, ["engine:claude"]) },
    },
    rollback: {
      version: 1,
      kind: "rollback",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: { checks: checks(root, ["restore-rehearsal", "restored-health"]) },
    },
    "signed-release": {
      version: 1,
      kind: "signed-release",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: {
        checks: checks(root, [
          "codesign", "notarization", "staple", "installed-previous-build-update",
          "one-native-copy", "open-on-mac-target", "companion-without-electron",
        ]),
        bundleId: "app.botfleet.macos",
        teamId: "CC8UTF7ATG",
        designatedRequirement: "identifier \"app.botfleet.macos\"",
        previousBuild: "202611220101",
      },
    },
    "linux-retention": {
      version: 1,
      kind: "linux-retention",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: {
        checks: checks(root, ["clean-export-build", "install-start", "update", "rollback"]),
        maintainedSourceSha: CANDIDATE.sourceSha,
        rollbackSourceSha: "d".repeat(40),
        closureManifest: artifact(root, "closure-manifest.json", "{}\n"),
      },
    },
    "process-inventory": {
      version: 1,
      kind: "process-inventory",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: {
        checks: checks(root, ["processes", "launchd", "listeners", "inventory-updated"]),
        macHarness: "absent",
      },
    },
    "control-disposition": {
      version: 1,
      kind: "control-disposition",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: {
        checks: checks(root, ["owner-decision", "landed-implementation", "muster-disposition"]),
      },
    },
    "change-plan": {
      version: 1,
      kind: "change-plan",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: {
        checks: checks(root, [
          "deletion-diff", "before-after-plan", "routine-webhook-disposition", "precise-rollback",
        ]),
        jobs: ["botfleet-server.service"],
        files: ["server/index.ts"],
        appCopies: ["BotFleet.app"],
      },
    },
    "server-writer-soak": {
      version: 1,
      kind: "server-writer-soak",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: observation(iso(base), iso(base + day), HOSTS[1].id, {
        macHarness: "loaded-unused",
        surfaces: {
          bots: "passed",
          routines: "passed",
          webhooks: "passed",
          zulip: "passed",
          linear: "passed",
          "ios-push": "passed",
        },
        inboundMessages: 1,
        serverSharedRoutineRuns: 1,
        macSharedRoutineRuns: 0,
      }),
    },
    "no-mac-node-soak": {
      version: 1,
      kind: "no-mac-node-soak",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: observation(iso(base + day), iso(base + 2 * day), HOSTS[1].id, {
        macHarness: "absent",
        surfaces: {
          bots: "passed",
          routines: "passed",
          webhooks: "passed",
          zulip: "passed",
          linear: "passed",
          "ios-push": "passed",
        },
      }),
    },
    "daily-driver": {
      version: 1,
      kind: "daily-driver",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: observation(iso(base), iso(base + 7 * day), HOSTS[0].id, {
        nativeApp: "signed-native-daily-driver",
        iosSession: "passed",
        openOnMac: "passed",
        processInventory: "recorded",
      }),
    },
    "owner-acceptance": {
      version: 1,
      kind: "owner-acceptance",
      candidate: CANDIDATE,
      mode: MODE,
      hosts: HOSTS,
      provenance: prov,
      data: { decision: "accepted", action: "delete-mac-local-node-source", dailyDriverAccepted: true },
    },
  };

  const bundle = {
    version: 1,
    candidate: CANDIDATE,
    mode: MODE,
    hosts: HOSTS,
    acceptanceOwner: OWNER,
    engines: ["claude"],
    state,
    receipts: {},
  };
  for (const kind of REQUIRED_RECEIPTS) {
    if (kind === options.skip) continue;
    const receipt = receipts[kind];
    const name = `${kind}.receipt.json`;
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    writeFileSync(join(root, name), text, { mode: 0o600 });
    bundle.receipts[kind] = { path: name, sha256: evidenceHash(Buffer.from(text, "utf8")) };
  }

  const bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
  writeFileSync(join(root, "bundle.json"), bundleText, { mode: 0o600 });
  return { root, bundlePath: join(root, "bundle.json"), statePath: join(root, "state.json"), stateBytes: Buffer.from(stateText, "utf8") };
}

test("a complete thirteen-receipt packet passes the final gate", () => {
  const fixture = assemblePacket();
  try {
    const verdict = checkFinalEvidenceBundle(fixture.bundlePath, {
      statePath: fixture.statePath,
      stateBytes: fixture.stateBytes,
      candidate: CANDIDATE,
      now: Date.parse("2026-11-24T00:00:00.000Z"),
    });
    assert.equal(verdict.ok, true, verdict.blockers.join("; "));
    assert.deepEqual(verdict.blockers, []);
    assert.equal(REQUIRED_RECEIPTS.length, 13);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a packet missing one receipt is refused, and the refusal names the kind", () => {
  const fixture = assemblePacket({ skip: "daily-driver" });
  try {
    const verdict = checkFinalEvidenceBundle(fixture.bundlePath, {
      statePath: fixture.statePath,
      stateBytes: fixture.stateBytes,
      candidate: CANDIDATE,
      now: Date.parse("2026-11-24T00:00:00.000Z"),
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.blockers.some((blocker) => blocker.includes("daily-driver")), verdict.blockers.join("; "));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a packet whose candidate differs from the gate's is refused", () => {
  const fixture = assemblePacket();
  try {
    const verdict = checkFinalEvidenceBundle(fixture.bundlePath, {
      statePath: fixture.statePath,
      stateBytes: fixture.stateBytes,
      candidate: { ...CANDIDATE, build: "202611240101" },
      now: Date.parse("2026-11-24T00:00:00.000Z"),
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.blockers.some((blocker) => blocker.includes("candidate")), verdict.blockers.join("; "));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a packet whose state file does not match is refused", () => {
  const fixture = assemblePacket();
  try {
    const verdict = checkFinalEvidenceBundle(fixture.bundlePath, {
      statePath: fixture.statePath,
      stateBytes: Buffer.from("{}\n", "utf8"),
      candidate: CANDIDATE,
      now: Date.parse("2026-11-24T00:00:00.000Z"),
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.blockers.some((blocker) => blocker.includes("state")), verdict.blockers.join("; "));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the fixture packet is written into a private directory and removed with it", () => {
  const fixture = assemblePacket();
  try {
    const bundle = JSON.parse(readFileSync(fixture.bundlePath, "utf8"));
    assert.equal(Object.keys(bundle.receipts).length, REQUIRED_RECEIPTS.length);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
