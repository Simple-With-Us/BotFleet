// The node side of the import parity report shape pin (BF-2648).
//
// `ios/Tests/CompanionCoreTests/StoreImportParityReportContractTests.swift`
// pins the key names of the Swift `StoreImportParityReport` to one synthetic,
// fully verified report, `ios/Tests/CompanionCoreTests/Fixtures/
// import-parity-report.json`.  This file reads the same fixture on the node
// side, so the Swift report and the node verdict that reads it are held to one
// shared example instead of agreeing by convention:  a key renamed on either
// side fails a test on its own side.
//
// The schema `importParityVerdict` decodes the report with is not exported, so
// the key lists below are literal.  The required list is checked against the
// verdict itself, key by key, rather than trusted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importParityVerdict } from "./archive-node-store.mjs";

const GOLDEN_PARITY_REPORT_URL = new URL(
  "../ios/Tests/CompanionCoreTests/Fixtures/import-parity-report.json",
  import.meta.url,
);

/** True for a parsed JSON object, and false for null, an array or a scalar. */
function isJsonObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Parse the fixture text and refuse a shape the tests below would trip over.
 * A fixture that is not an object, or whose receipts are not an array of
 * objects, fails here as a named assertion rather than as a `TypeError` raised
 * from an unrelated line of a later test.
 */
function parseGoldenParityReport(text) {
  const report = JSON.parse(text);
  assert.ok(isJsonObject(report), "the pinned parity report must be one JSON object");
  assert.ok(
    Array.isArray(report.routineRequestReceipts),
    "the pinned parity report must carry routineRequestReceipts as an array",
  );
  for (const receipt of report.routineRequestReceipts) {
    assert.ok(isJsonObject(receipt), "every pinned routine request receipt must be one JSON object");
  }
  return report;
}

function readGoldenParityReport() {
  return parseGoldenParityReport(readFileSync(GOLDEN_PARITY_REPORT_URL, "utf8"));
}

/** Every key `StoreImportParityReport` writes, as the Swift contract test pins them. */
const SWIFT_REPORT_KEYS = [
  "isFullyVerified",
  "isParityVerified",
  "mismatches",
  "newlyInsertedMessages",
  "orphanedMessageCount",
  "perThreadMessageCountsMatch",
  "routineRequestReceipts",
  "sourceBodyDigestSHA256",
  "sourceBotCount",
  "sourceMessageCount",
  "sourceMessageMetadataDroppedCount",
  "sourceMessageMetadataPreservedCount",
  "sourceMessageMetadataPreservedDigestSHA256",
  "sourceMessageMetadataPreservedFields",
  "sourceRoutineCount",
  "sourceRoutineRequestReceiptCount",
  "sourceRoutineRunCount",
  "sourceThreadCount",
  "sourceWebhookCount",
  "sourceWebhookDeliveryCount",
  "sourceWebhookDeliveryLedgerCount",
  "targetBodyDigestSHA256",
  "targetBotCount",
  "targetMessageCount",
  "targetRoutineCount",
  "targetRoutineRequestReceiptCount",
  "targetRoutineRunCount",
  "targetThreadCount",
  "targetWebhookCount",
  "targetWebhookDeliveryCount",
  "targetWebhookDeliveryLedgerCount",
  "warnings",
];

/** The keys the node schema requires:  the verdict fails closed without any one of them. */
const NODE_REQUIRED_KEYS = [
  "isFullyVerified",
  "isParityVerified",
  "mismatches",
  "orphanedMessageCount",
  "perThreadMessageCountsMatch",
  "sourceBodyDigestSHA256",
  "sourceBotCount",
  "sourceMessageCount",
  "sourceMessageMetadataDroppedCount",
  "sourceRoutineCount",
  "sourceRoutineRequestReceiptCount",
  "sourceRoutineRunCount",
  "sourceThreadCount",
  "sourceWebhookCount",
  "sourceWebhookDeliveryCount",
  "sourceWebhookDeliveryLedgerCount",
  "targetBodyDigestSHA256",
  "targetBotCount",
  "targetMessageCount",
  "targetRoutineCount",
  "targetRoutineRequestReceiptCount",
  "targetRoutineRunCount",
  "targetThreadCount",
  "targetWebhookCount",
  "targetWebhookDeliveryCount",
  "targetWebhookDeliveryLedgerCount",
  "warnings",
];

test("a malformed fixture fails as a named assertion, not as a TypeError in a later test", () => {
  for (const text of [
    "null",
    "[]",
    "7",
    "{}",
    '{"routineRequestReceipts":null}',
    '{"routineRequestReceipts":{}}',
    '{"routineRequestReceipts":[null]}',
    '{"routineRequestReceipts":[[]]}',
  ]) {
    assert.throws(() => parseGoldenParityReport(text), assert.AssertionError, text);
  }
  assert.deepEqual(parseGoldenParityReport('{"routineRequestReceipts":[]}'), { routineRequestReceipts: [] });
});

test("the report the Swift contract test pins earns a passing parity check", () => {
  const verdict = importParityVerdict(readGoldenParityReport());
  assert.equal(verdict.isParityVerified, true);
  assert.equal(verdict.isFullyVerified, true);
  assert.deepEqual(verdict.problems, []);
});

test("the pinned report has exactly the keys the Swift report writes", () => {
  // The schema is a loose object and the verdict reads only some of the keys,
  // so a key the Swift report renamed would still earn a passing verdict.  The
  // key set is compared directly instead.
  assert.deepEqual(Object.keys(readGoldenParityReport()).sort(), [...SWIFT_REPORT_KEYS].sort());
});

test("the keys the verdict requires are exactly the keys whose absence it refuses", () => {
  // Derived from the verdict rather than from its schema, which is not
  // exported:  take each key out of the pinned report in turn and see whether
  // the verdict still passes.  A key the Swift report renamed is a key that is
  // missing from the node side's point of view, so every required key has to
  // be one the pinned report carries under that exact name.
  const golden = readGoldenParityReport();
  const refused = Object.keys(golden)
    .filter((key) => {
      const without = structuredClone(golden);
      delete without[key];
      return importParityVerdict(without).isFullyVerified !== true;
    })
    .sort();
  assert.deepEqual(refused, [...NODE_REQUIRED_KEYS].sort());
  for (const key of NODE_REQUIRED_KEYS) {
    assert.ok(SWIFT_REPORT_KEYS.includes(key), `${key} is required by the verdict but is not a key the Swift report writes`);
  }
});

test("the pinned report carries every key of a routine request receipt", () => {
  // `RoutineRequestReceiptRecord` on the Swift side:  the nine keys the
  // importer writes for each receipt, none of which the node schema reads.
  const golden = readGoldenParityReport();
  assert.equal(golden.routineRequestReceipts.length, 1);
  assert.deepEqual(Object.keys(golden.routineRequestReceipts[0]).sort(), [
    "action",
    "appliedAt",
    "botId",
    "fingerprint",
    "fingerprintVersion",
    "messageId",
    "requestId",
    "resultId",
    "threadId",
  ]);
});
