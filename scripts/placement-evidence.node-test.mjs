import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HAND_RUN_PLACEMENT_EVIDENCE, REQUIRED_PLACEMENT_EVIDENCE, PlacementEvidenceSchema, checkPlacementEvidenceFile, evaluatePlacementEvidence } from "./check-placement-evidence.mjs";

function complete() {
  return {
    evidence: Object.fromEntries(REQUIRED_PLACEMENT_EVIDENCE.map((key) => [key, true])),
    handRun: Object.fromEntries(HAND_RUN_PLACEMENT_EVIDENCE.map((key) => [key, { at: "2026-10-30 3:15 PM", by: "fixture runner", log: "run.log" }])),
    inventory: { server: "inventory.json", mac: "inventory.json" },
  };
}

test("all sixteen recipes require explicit assertions", () => {
  assert.equal(REQUIRED_PLACEMENT_EVIDENCE.length, 16);
  assert.equal(evaluatePlacementEvidence(complete()).ok, true);
  for (const key of REQUIRED_PLACEMENT_EVIDENCE) {
    const state = complete();
    delete state.evidence[key];
    assert.deepEqual(evaluatePlacementEvidence(state).blockers, [`evidence ${key}: not asserted`]);
    state.evidence[key] = false;
    assert.equal(evaluatePlacementEvidence(state).ok, false);
  }
  assert.equal(evaluatePlacementEvidence({}).ok, false);
});

test("strict schema rejects typos, truthy strings, malformed records and non-owner-clock times", () => {
  for (const raw of [
    { evidnce: {} }, { evidence: { "typo": true } }, { evidence: { "inventory-recorded": "true" } },
    { inventory: { server: "", mac: "x" } }, { inventory: { server: "x", extra: "x" } },
    { handRun: { typo: {} } },
    { handRun: { "other-apps-unchanged": { at: "15:15 UTC", by: "x", log: "x" } } },
    { handRun: { "other-apps-unchanged": { at: "3:15 PM", by: "", log: "x" } } },
    { handRun: { "other-apps-unchanged": { at: "3:15 PM", by: "x", log: "x", approved: true } } },
  ]) assert.equal(PlacementEvidenceSchema.safeParse(raw).success, false, JSON.stringify(raw));
});

test("a hand assertion cannot omit its runner, time and log record", () => {
  for (const key of HAND_RUN_PLACEMENT_EVIDENCE) {
    const state = complete();
    delete state.handRun[key];
    assert.match(evaluatePlacementEvidence(state).blockers[0], /^handRun /);
  }
});

test("both host inventories are required before numeric defaults", () => {
  for (const host of ["server", "mac"]) {
    const state = complete();
    delete state.inventory[host];
    assert.match(evaluatePlacementEvidence(state).blockers[0], /numeric defaults must wait/);
  }
});

test("artifact references resolve beside the state file and must be readable files", () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-placement-evidence-"));
  try {
    const path = join(dir, "placement-evidence.json");
    writeFileSync(path, JSON.stringify(complete()));
    assert.equal(checkPlacementEvidenceFile(path).ok, false);
    writeFileSync(join(dir, "run.log"), "fixture evidence\n");
    writeFileSync(join(dir, "inventory.json"), "{}\n");
    assert.equal(checkPlacementEvidenceFile(path).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
