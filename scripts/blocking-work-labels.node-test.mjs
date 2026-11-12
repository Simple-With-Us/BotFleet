import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The stop path refuses with labels from BLOCKING_WORK_LABELS, falling back
// to the raw counter name when a kind has no label. That fallback is silent:
// a new runtimeWorkCounts key would surface as "1 routineRuns" instead of
// "1 routine run" and nothing would notice. This test pins the two maps in
// lockstep so a label can never go missing or stale.
test("every blocking-work counter has a label", () => {
  const source = readFileSync(join(ROOT, "server/index.ts"), "utf8").replace(/\r\n/g, "\n");

  // The counters: keys of the object runtimeWorkCounts returns. It has two
  // return shapes — the boot placeholder `{ boot: 1 }` and the real counts.
  const bootReturn = source.match(/return \{ boot: 1 \};/);
  assert.ok(bootReturn, "runtimeWorkCounts must keep the pre-boot placeholder");
  const countsMatch = source.match(/const pendingRoundCount =[\s\S]*?return \{([\s\S]*?)\n  \};/);
  assert.ok(countsMatch, "runtimeWorkCounts must return its counts object");
  const counterKeys = ["boot", ...[...countsMatch[1].matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1])];
  assert.ok(counterKeys.length > 1, "the counts object parse must find the counter keys");

  // The labels.
  const labelsMatch = source.match(/const BLOCKING_WORK_LABELS: BlockingWorkLabels = \{([\s\S]*?)\n\};/);
  assert.ok(labelsMatch, "BLOCKING_WORK_LABELS must be declared");
  const labelKeys = [...labelsMatch[1].matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
  assert.ok(labelKeys.length > 0, "the labels object parse must find the label keys");

  assert.deepEqual(
    counterKeys.filter((key) => !labelKeys.includes(key)),
    [],
    "every runtimeWorkCounts key must have a BLOCKING_WORK_LABELS entry",
  );
  assert.deepEqual(
    labelKeys.filter((key) => !counterKeys.includes(key)),
    [],
    "every BLOCKING_WORK_LABELS entry must label a real runtimeWorkCounts key",
  );
});
