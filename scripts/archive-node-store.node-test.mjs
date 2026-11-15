// Fixtures for the Node store archive and its restore rehearsal.
//
// The properties under test are the ones a rollback depends on:  the archive
// holds a database that opens, the copy is genuinely read-only, credentials
// never reach the capture, a tampered archive is caught instead of restored,
// and the receipts this producer emits are the shape the bundle validator
// accepts.  Each of those has a fixture that fails against a broken
// implementation, so a regression is a red test rather than a bad archive
// nobody notices until a rollback.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ARCHIVE_MARKER,
  MAX_PACKET_BYTES,
  assertRollbackJournalMode,
  archiveStore,
  emitReceipts,
  exclusionReason,
  importParityVerdict,
  looksTextual,
  proveReadOnly,
  resolveInside,
  resolveStoreRoot,
  restoredHealth,
  restoreArchive,
  sha256,
  validateBundleRequest,
  writeBoundedReport,
} from "./archive-node-store.mjs";
import { parseEvidenceReceipt } from "./decommission-evidence-bundle.mjs";

const ROOT_IS_ROOT = Boolean(process.getuid) && process.getuid() === 0;

/** A credential shape the shared redactor recognizes. */
const TOKEN = "sk-ant-api03-" + "A".repeat(48);

/** A private scratch directory, which is what the archive requires. */
function privateScratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A synthetic store with one of everything the archiver has to decide about:
 * a text store carrying a credential, a credential store by name, a live
 * SQLite database, a newline-delimited log, a binary carrying a credential,
 * and a symlink out of the tree.
 */
function makeStore() {
  const root = privateScratch("store-");
  mkdirSync(join(root, "events"), { recursive: true });
  writeFileSync(join(root, "bots.json"), JSON.stringify({ bots: [{ id: "1", token: TOKEN }] }, null, 2));
  writeFileSync(join(root, "config.json"), JSON.stringify({ provider: "x", apiKey: TOKEN }));
  writeFileSync(join(root, "events", "turn-1.ndjson"), '{"kind":"turn","id":"1"}\n{"kind":"delta","id":"1"}\n');
  writeFileSync(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  writeFileSync(join(root, "payload.bin"), Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(TOKEN), Buffer.from([0x02])]));
  const database = new DatabaseSync(join(root, "messages.db"));
  database.exec("CREATE TABLE messages (id INTEGER, body TEXT)");
  database.prepare("INSERT INTO messages (id, body) VALUES (?, ?)").run(1, "hello");
  database.close();
  symlinkSync("/etc/passwd", join(root, "escape"));
  return root;
}

/**
 * An import parity report the probe would have written:  every surface
 * matched, nothing was dropped, nothing is outstanding, and the report's own
 * flags say so.
 */
function makeParityReport(overrides = {}) {
  return {
    sourceBotCount: 3,
    targetBotCount: 3,
    sourceThreadCount: 12,
    targetThreadCount: 12,
    sourceMessageCount: 232142,
    targetMessageCount: 232142,
    sourceRoutineCount: 5,
    targetRoutineCount: 5,
    sourceRoutineRunCount: 41,
    targetRoutineRunCount: 41,
    sourceRoutineRequestReceiptCount: 7,
    targetRoutineRequestReceiptCount: 7,
    sourceWebhookCount: 2,
    targetWebhookCount: 2,
    sourceWebhookDeliveryCount: 9,
    targetWebhookDeliveryCount: 9,
    sourceWebhookDeliveryLedgerCount: 6,
    targetWebhookDeliveryLedgerCount: 6,
    sourceMessageMetadataPreservedCount: 18,
    sourceMessageMetadataPreservedFields: ["parentId"],
    sourceMessageMetadataPreservedDigestSHA256: "f".repeat(64),
    sourceMessageMetadataDroppedCount: 0,
    routineRequestReceipts: [],
    perThreadMessageCountsMatch: true,
    orphanedMessageCount: 0,
    sourceBodyDigestSHA256: "d".repeat(64),
    targetBodyDigestSHA256: "d".repeat(64),
    newlyInsertedMessages: 0,
    mismatches: [],
    warnings: [],
    isParityVerified: true,
    isFullyVerified: true,
    ...overrides,
  };
}

/** A request the receipts are bound to. */
function makeRequest() {
  return {
    version: 1,
    candidate: { sourceSha: "a".repeat(40), build: "202611040715", artifactSha256: "b".repeat(64) },
    mode: "serverFirst",
    hosts: [
      { id: `mac:${"1".repeat(8)}-${"2".repeat(4)}-${"3".repeat(4)}-${"4".repeat(4)}-${"5".repeat(12)}`, role: "mac" },
      { id: `server:${"6".repeat(8)}-${"7".repeat(4)}-${"8".repeat(4)}-${"9".repeat(4)}-${"a".repeat(12)}`, role: "server" },
    ],
    acceptanceOwner: "Jay Wedgeworth",
    engines: ["claude"],
    state: { path: "state.json", sha256: "c".repeat(64) },
    receipts: {},
  };
}

test("the archive keeps a consistent snapshot of a live database, not a torn copy", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { manifest } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const row = manifest.files.find((entry) => entry.path === "messages.db");
  assert.ok(row, "the database is in the archive");
  assert.equal(row.kind, "sqlite-snapshot");

  const archived = join(parent, "capture", "tree", "messages.db");
  const database = new DatabaseSync(archived, { readOnly: true });
  const rows = database.prepare("SELECT body FROM messages").all();
  const integrity = database.prepare("PRAGMA integrity_check").all();
  database.close();
  assert.deepEqual(rows.map((row) => row.body), ["hello"]);
  assert.deepEqual(integrity.map((row) => row.integrity_check), ["ok"]);
});

test("the archive never carries a credential, and names what it left out", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { manifest, outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const archivedText = readFileSync(join(outDir, "tree", "bots.json"), "utf8");
  assert.ok(!archivedText.includes(TOKEN), "the token is not in the archived store");
  assert.equal(manifest.files.find((entry) => entry.path === "bots.json").redacted, true);

  const excluded = new Map(manifest.excluded.map((entry) => [entry.path, entry.reason]));
  assert.equal(excluded.get("config.json"), "credential-store");
  assert.equal(excluded.get("payload.bin"), "credential-in-binary");
  assert.equal(excluded.get("escape"), "symbolic-link");
});

test("the archived copy is read-only, and the proof is a real write attempt", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { manifest, outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  assert.equal(manifest.readOnlyProved, true);
  const archived = join(outDir, "tree", "bots.json");
  assert.equal(statSync(archived).mode & 0o777, 0o444);
  assert.equal(proveReadOnly(archived).ok, true);
});

test("the restore reproduces every file the manifest names", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  const rehearsal = restoreArchive({ archiveDir: outDir, intoDir: join(parent, "restored") });

  assert.equal(rehearsal.ok, true);
  assert.deepEqual(rehearsal.mismatches, []);
  assert.equal(rehearsal.restoredFiles, rehearsal.expectedFiles);
  const restored = readFileSync(join(parent, "restored", "bots.json"), "utf8");
  assert.ok(!restored.includes(TOKEN), "the restored store carries no credential either");
});

test("a tampered archive is caught rather than restored", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  chmodSync(join(outDir, "tree"), 0o755);
  chmodSync(join(outDir, "tree", "bots.json"), 0o644);
  writeFileSync(join(outDir, "tree", "bots.json"), "{\"bots\":[{\"id\":\"tampered\"}]}");

  const rehearsal = restoreArchive({ archiveDir: outDir, intoDir: join(parent, "restored") });
  assert.equal(rehearsal.ok, false);
  assert.equal(rehearsal.mismatches[0].path, "bots.json");
  assert.equal(rehearsal.mismatches[0].reason, "archive-hash-mismatch");
});

test("the restored store reports its own structural health", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  restoreArchive({ archiveDir: outDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"));

  assert.equal(health.ok, true, JSON.stringify(health.checks.filter((check) => !check.ok)));
  const sqlite = health.checks.find((check) => check.name === "sqlite-integrity");
  assert.equal(sqlite.ok, true);
  assert.ok(health.checks.some((check) => check.name === "json:bots.json" && check.ok));
  assert.ok(health.checks.some((check) => check.name.startsWith("ndjson:events/turn-1.ndjson") && check.ok));
});

test("the archive refuses to write over an older capture", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  await assert.rejects(
    () => archiveStore({ storeRoot: store, outDir: join(parent, "capture") }),
    /already exists/,
  );
});

test("the archive refuses a capture directory that is not private", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = mkdtempSync(join(tmpdir(), "loose-"));
  chmodSync(parent, 0o755);
  await assert.rejects(
    () => archiveStore({ storeRoot: store, outDir: join(parent, "capture") }),
    /not private/,
  );
});

test("the rollback receipt is the shape the bundle validator accepts", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"));
  writeFileSync(join(captureDir, "restore-health.json"), `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(captureDir, "provenance.txt"), "captured on the server by the MM seat\n", { mode: 0o600 });

  const emitted = emitReceipts({
    captureDir,
    request: makeRequest(),
    provenance: {
      by: "MM",
      at: new Date().toISOString(),
      source: "https://example.invalid/capture",
      record: join(captureDir, "provenance.txt"),
    },
  });
  const bytes = readFileSync(join(captureDir, "rollback.receipt.json"));
  const receipt = parseEvidenceReceipt("rollback", bytes);
  assert.equal(receipt.kind, "rollback");
  assert.deepEqual(receipt.data.checks.map((check) => check.name).sort(), ["restore-rehearsal", "restored-health"]);
  assert.ok(receipt.data.checks.every((check) => check.exitCode === 0));
  assert.ok(emitted.rollback);
});

test("the import receipt is refused without a parity report and carries one with it", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"));
  writeFileSync(join(captureDir, "restore-health.json"), `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(captureDir, "provenance.txt"), "captured on the server by the MM seat\n", { mode: 0o600 });

  const provenance = {
    by: "MM",
    at: new Date().toISOString(),
    source: "https://example.invalid/capture",
    record: join(captureDir, "provenance.txt"),
  };

  const withoutParity = emitReceipts({ captureDir, request: makeRequest(), provenance });
  assert.equal(withoutParity.import, undefined, "no import receipt without a parity report");

  writeFileSync(join(captureDir, "import-parity.json"), `${JSON.stringify(makeParityReport(), null, 2)}\n`, { mode: 0o600 });
  const withParity = emitReceipts({
    captureDir,
    request: makeRequest(),
    provenance,
    parityReportPath: join(captureDir, "import-parity.json"),
  });
  const receipt = parseEvidenceReceipt("import", readFileSync(join(captureDir, "import.receipt.json")));
  assert.deepEqual(receipt.data.checks.map((check) => check.name).sort(), ["parity", "read-only-archive"]);
  assert.ok(withParity.import);
});

test("a parity report whose details agree earns a passing parity check", () => {
  const verdict = importParityVerdict(makeParityReport());
  assert.equal(verdict.isParityVerified, true);
  assert.equal(verdict.isFullyVerified, true);
  assert.deepEqual(verdict.problems, []);
});

test("a parity report that says it was verified while a surface disagrees fails closed", () => {
  // Each of these is a report that claims parity while one of the surfaces
  // the verdict is computed from says otherwise.
  const cases = [
    ["the message count disagrees", { sourceMessageCount: 232142, targetMessageCount: 232141 }],
    ["the bot count disagrees", { sourceBotCount: 3, targetBotCount: 2 }],
    ["the webhook delivery ledger count disagrees", { sourceWebhookDeliveryLedgerCount: 6, targetWebhookDeliveryLedgerCount: 5 }],
    ["the body digests differ", { targetBodyDigestSHA256: "e".repeat(64) }],
    ["the per-thread counts do not match", { perThreadMessageCountsMatch: false }],
    ["there are orphaned messages", { orphanedMessageCount: 3 }],
    ["the report names a mismatch", { mismatches: ["message count 232142 != 232141"] }],
  ];
  for (const [name, override] of cases) {
    const verdict = importParityVerdict(makeParityReport(override));
    assert.equal(verdict.isFullyVerified, false, name);
    assert.ok(verdict.problems.length > 0, name);
  }
});

test("a parity report whose own flags disagree with its details fails closed", () => {
  // The details hold, so the report's own false is the lie.
  const claimsFalse = importParityVerdict(makeParityReport({ isParityVerified: false }));
  assert.equal(claimsFalse.isParityVerified, false);
  assert.equal(claimsFalse.isFullyVerified, false);
  assert.match(claimsFalse.problems.join("; "), /isParityVerified/);

  // The details do not hold, so the report's own true is the lie.
  const claimsTrue = importParityVerdict(makeParityReport({
    sourceMessageCount: 232142,
    targetMessageCount: 232141,
    isFullyVerified: true,
  }));
  assert.equal(claimsTrue.isFullyVerified, false);
  assert.match(claimsTrue.problems.join("; "), /isFullyVerified/);
});

test("a parity report missing a field the verdict is computed from fails closed", () => {
  const report = makeParityReport();
  delete report.targetBodyDigestSHA256;
  const verdict = importParityVerdict(report);
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /targetBodyDigestSHA256/);
});

test("a parity report with a warning is not fully verified, and says so honestly", () => {
  // A warning is a known gap, so the report is parity-verified but not
  // fully verified, and it declares exactly that.
  const warned = importParityVerdict(makeParityReport({
    warnings: ["2 manual bot snooze(s) name a bot not in bots.json"],
    isFullyVerified: false,
  }));
  assert.equal(warned.isParityVerified, true);
  assert.equal(warned.isFullyVerified, false);

  // The same report that claims to be fully verified contradicts itself.
  const lying = importParityVerdict(makeParityReport({
    warnings: ["2 manual bot snooze(s) name a bot not in bots.json"],
  }));
  assert.equal(lying.isFullyVerified, false);
  assert.match(lying.problems.join("; "), /warning/);
});

test("a parity report that dropped metadata and named no warning contradicts itself", () => {
  const verdict = importParityVerdict(makeParityReport({ sourceMessageMetadataDroppedCount: 4 }));
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /dropped message/);
});

test("a parity report whose body digests are not digests fails closed", () => {
  // The importer writes a SHA-256 as 64 hexadecimal characters, so two
  // matching strings that are not digests are not evidence that the bodies
  // matched, and a report like that did not come from the importer.
  const verdict = importParityVerdict(makeParityReport({
    sourceBodyDigestSHA256: "x",
    targetBodyDigestSHA256: "x",
  }));
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /BodyDigestSHA256/);
});

test("a parity report that omits the dropped-metadata count fails closed", () => {
  // The importer always writes the count, so a report without it did not
  // come from the importer, and without it the dropped-metadata
  // contradiction cannot be checked at all.
  const report = makeParityReport();
  delete report.sourceMessageMetadataDroppedCount;
  const verdict = importParityVerdict(report);
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /sourceMessageMetadataDroppedCount/);
});

test("a parity report carrying an unbounded mismatch list fails closed", () => {
  // The lists are external input, so they are bounded at the boundary:  a
  // report carrying a million of them is not a report the importer wrote.
  const verdict = importParityVerdict(makeParityReport({
    mismatches: Array.from({ length: 1001 }, (_, index) => `mismatch ${index}`),
  }));
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /mismatches/);
});

test("a parity report carrying an unbounded warning list fails closed", () => {
  // The list is bounded even though its entries are not:  a report carrying
  // a thousand and one warnings is not a report the importer wrote.
  const verdict = importParityVerdict(makeParityReport({
    warnings: Array.from({ length: 1001 }, (_, index) => `warning ${index}`),
    isFullyVerified: false,
  }));
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /warnings/);
});

test("a parity report with a long warning still decodes", () => {
  // The importer joins the user-controlled metadata key names into one
  // warning, so no fixed length can be called valid for it, and a report
  // whose warning is long is a report the importer wrote.
  const verdict = importParityVerdict(makeParityReport({
    warnings: ["2 source message(s) carry JSON metadata the importer could not preserve (fields: " + "k".repeat(600) + ")"],
    isFullyVerified: false,
  }));
  assert.equal(verdict.isParityVerified, true);
  assert.equal(verdict.isFullyVerified, false);
  assert.match(verdict.problems.join("; "), /warning/);
  assert.doesNotMatch(verdict.problems.join("; "), /does not match the contract/);
});

test("a parity report that is not an object fails closed", () => {
  assert.equal(importParityVerdict(null).isFullyVerified, false);
  assert.equal(importParityVerdict([]).isFullyVerified, false);
  assert.equal(importParityVerdict("verified").isFullyVerified, false);
});

test("a parity report that contradicts itself earns a failing parity check in the receipt", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  writeBoundedReport(join(captureDir, "restore-health.json"), restoredHealth(join(parent, "restored")));
  writeFileSync(join(captureDir, "provenance.txt"), "captured on the server by the MM seat\n", { mode: 0o600 });
  // The report says it was verified, and its own message count says
  // otherwise.  The flag alone would have earned a passing check.
  writeFileSync(
    join(captureDir, "import-parity.json"),
    `${JSON.stringify(makeParityReport({ sourceMessageCount: 232142, targetMessageCount: 232141 }), null, 2)}\n`,
    { mode: 0o600 },
  );

  emitReceipts({
    captureDir,
    request: makeRequest(),
    provenance: {
      by: "MM",
      at: new Date().toISOString(),
      source: "https://example.invalid/capture",
      record: join(captureDir, "provenance.txt"),
    },
    parityReportPath: join(captureDir, "import-parity.json"),
  });
  const receipt = parseEvidenceReceipt("import", readFileSync(join(captureDir, "import.receipt.json")));
  const codes = Object.fromEntries(receipt.data.checks.map((check) => [check.name, check.exitCode]));
  assert.equal(codes["parity"], 1, "a report that contradicts itself does not certify parity");
});

test("the store root follows the app's own rule", () => {
  assert.equal(resolveStoreRoot({ OMB_DATA_DIR: "  " }), resolveStoreRoot({}));
  assert.equal(resolveStoreRoot({ OMB_DATA_DIR: "/srv/data" }), "/srv/data");
});

test("exclusion and text decisions are made on names and shapes, not on contents", () => {
  assert.equal(exclusionReason("config.json"), "credential-store");
  assert.equal(exclusionReason("nested/.env.local"), "credential-material");
  assert.equal(exclusionReason("keys/server.pem"), "credential-material");
  assert.equal(exclusionReason("bots.json"), null);
  assert.equal(looksTextual("bots.json", Buffer.from("{}")), true);
  assert.equal(looksTextual("blob.bin", Buffer.from([0, 1, 2])), false);
  // The NUL test is a native scan, so a large file is decided in one call
  // rather than a million interpreted iterations.
  assert.equal(looksTextual("big.bin", Buffer.alloc(1024 * 1024, 0x41)), true);
  assert.equal(looksTextual("big.bin", Buffer.alloc(1024 * 1024)), false);
});

test("a plugin's secret store and broker directory are excluded", () => {
  assert.equal(exclusionReason("plugins/.broker/linear/plugin-secrets.json"), "credential-material");
  assert.equal(exclusionReason("nested/plugin-secrets.json"), "credential-material");
  assert.equal(exclusionReason("plugins/.broker/linear/state.json"), "credential-material");
  assert.equal(exclusionReason("server/plugin-secrets.ts"), null, "a source file that shares the name is not a credential store");
});

test("a manifest path is resolved inside its root, or refused", () => {
  assert.equal(resolveInside("/tmp/example", "a/b.txt"), "/tmp/example/a/b.txt");
  assert.equal(resolveInside("/tmp/example", "../escape"), null);
  assert.equal(resolveInside("/tmp/example", "a/../../escape"), null);
  assert.equal(resolveInside("/tmp/example", "/etc/passwd"), null);
  assert.equal(resolveInside("/tmp/example", ""), null);
  assert.equal(resolveInside("/tmp/example", "a//b"), null);
});

test("a request that does not match the bundle contract is refused", () => {
  assert.doesNotThrow(() => validateBundleRequest(makeRequest()));
  assert.throws(() => validateBundleRequest({ candidate: "not a candidate" }), /does not match the contract/);
  assert.throws(() => validateBundleRequest({ ...makeRequest(), mode: "whenever" }), /does not match the contract/);
  assert.throws(() => validateBundleRequest({ ...makeRequest(), unexpected: true }), /does not match the contract/);
});

test("a file that was already unparsable in the source is not a restore failure", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  // A scratch file the store happens to hold empty, and a fixture that is
  // deliberately not strict JSONL:  both are unparsable in the source, so a
  // faithful restore reproduces them and the restore is still healthy.
  writeFileSync(join(store, "scratch.json"), "");
  writeFileSync(join(store, "weird.jsonl"), "not json at all\n{\"ok\":true}\n");

  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"), { referenceDir: join(captureDir, "tree") });

  assert.equal(health.ok, true, JSON.stringify(health.checks.filter((check) => !check.ok)));
});

test("a file that parses in the archive and not in the restore is a restore failure", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });

  // Corrupt the RESTORED copy, leaving the archive alone.
  chmodSync(join(parent, "restored", "bots.json"), 0o644);
  writeFileSync(join(parent, "restored", "bots.json"), "{ this is not json");

  const health = restoredHealth(join(parent, "restored"), { referenceDir: join(captureDir, "tree") });
  assert.equal(health.ok, false);
  const failure = health.checks.find((check) => !check.ok);
  assert.equal(failure.name, "json:bots.json");
  assert.match(failure.detail, /archive/);
});

test("the manifest carries the archive marker and hashes every file it names", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.marker, ARCHIVE_MARKER);
  for (const row of manifest.files) {
    const bytes = readFileSync(join(outDir, "tree", ...row.path.split("/")));
    assert.equal(sha256(bytes), row.sha256, `${row.path} hashes as the manifest says`);
  }
});

test("the redaction keeps a JSON document and an ndjson log parsable", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  // A value the harness had already masked, next to a live credential:  the
  // shared redactor re-masks the first one, and a naive whole-text redaction
  // takes the closing quote with it and the document stops parsing.
  writeFileSync(join(store, "already-masked.json"), JSON.stringify({
    note: `re-arm «redacted 11 chars»\n\nBut careful`,
    key: TOKEN,
  }));
  writeFileSync(join(store, "already-masked.ndjson"),
    `{"note":"re-arm «redacted 11 chars»\\n\\nBut careful","key":"${TOKEN}"}\n`);

  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const document = JSON.parse(readFileSync(join(outDir, "tree", "already-masked.json"), "utf8"));
  assert.ok(document.note.includes("«redacted 11 chars»"), "the already-masked value survives");
  assert.ok(!document.note.includes(TOKEN), "the live credential does not");
  assert.ok(!document.key.includes(TOKEN), "the credential field is masked");

  const lines = readFileSync(join(outDir, "tree", "already-masked.ndjson"), "utf8").split("\n").filter((line) => line.trim());
  for (const line of lines) JSON.parse(line);
});

test("the archived database opens read-only on its own, with nothing beside it", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  // The live store's database is in WAL mode, and a backup of a WAL database
  // is still a WAL database.  Read through a truly read-only connection a
  // WAL database wants a -shm sibling it cannot create beside a read-only
  // file, and the archive deliberately carries no siblings:  the live
  // database's -wal and -shm are excluded because the snapshot supersedes
  // them.  So the snapshot is taken out of WAL mode, and the Swift importer,
  // which opens the source read-only, can read it.
  const database = new DatabaseSync(join(store, "messages.db"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE wal_probe (id INTEGER)");
  database.prepare("INSERT INTO wal_probe (id) VALUES (1)").run();
  database.close();

  const parent = privateScratch("capture-");
  const { manifest, outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const snapshot = join(outDir, "tree", "messages.db");
  assert.equal(existsSync(`${snapshot}-wal`), false, "no wal sibling is carried");
  assert.equal(existsSync(`${snapshot}-shm`), false, "no shm sibling is carried");
  const opened = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const mode = opened.prepare("PRAGMA journal_mode").get();
    assert.equal(mode.journal_mode, "delete", "the snapshot is not in WAL mode");
    assert.equal(opened.prepare("SELECT count(*) AS n FROM wal_probe").get().n, 1, "the rows came through");
  } finally {
    opened.close();
  }
  const row = manifest.files.find((entry) => entry.path === "messages.db");
  assert.equal(row.journalMode, "delete", "the manifest says which journal mode the snapshot is in");
});

test("a snapshot that stayed in WAL mode is refused, not sealed", () => {
  // The enforcement is the point:  a WAL snapshot is a database the read-only
  // importer cannot open, so it must never be sealed and shipped.
  assert.throws(() => assertRollbackJournalMode("wal", "/tmp/x.sqlite"), /journal mode "wal"/);
  assert.throws(() => assertRollbackJournalMode("memory", "/tmp/x.sqlite"), /journal mode "memory"/);
  assert.doesNotThrow(() => assertRollbackJournalMode("delete", "/tmp/x.sqlite"));
});

test("a credential inside the database is counted in the manifest, not hidden", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const database = new DatabaseSync(join(store, "messages.db"));
  database.exec("CREATE TABLE notes (body TEXT)");
  database.prepare("INSERT INTO notes (body) VALUES (?)").run(`the key is ${TOKEN}`);
  database.close();

  const parent = privateScratch("capture-");
  const { manifest, outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  const row = manifest.files.find((entry) => entry.path === "messages.db");
  assert.ok(row.credentialMatches > 0, "the manifest counts the credential shapes the snapshot holds");
  const report = JSON.parse(readFileSync(join(outDir, "archive-report.json"), "utf8"));
  assert.ok(report.credentialMatches > 0, "the report that travels counts them too");
});

test("a report that would not fit in the bundle is refused here", () => {
  const parent = privateScratch("capture-");
  const target = join(parent, "too-big.json");
  assert.throws(() => writeBoundedReport(target, { blob: "x".repeat(MAX_PACKET_BYTES + 10) }), /over the/);
  const ok = writeBoundedReport(target, { blob: "x".repeat(10) });
  assert.ok(ok > 0);
});

test("the archive report binds the manifest by hash and stays inside the limit", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  const report = JSON.parse(readFileSync(join(outDir, "archive-report.json"), "utf8"));
  const manifestBytes = readFileSync(join(outDir, "manifest.json"));
  assert.equal(report.manifestSha256, sha256(manifestBytes));
  assert.equal(report.readOnlyProved, true);
  assert.ok(statSync(join(outDir, "archive-report.json")).size <= MAX_PACKET_BYTES);
});

test("a failed rehearsal earns a failing exit code, not a passing one", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  const rehearsal = restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"));
  writeBoundedReport(join(captureDir, "restore-health.json"), health);
  writeFileSync(join(captureDir, "provenance.txt"), "captured on the server by the MM seat\n", { mode: 0o600 });

  // Break the archive after the rehearsal, so the report says the rehearsal
  // failed and the receipt has to say so too.
  const broken = { ...rehearsal, ok: false, mismatches: [{ path: "bots.json", reason: "archive-hash-mismatch" }] };
  writeBoundedReport(join(captureDir, "restore-report.json"), broken);
  writeBoundedReport(join(captureDir, "restore-health.json"), { ...health, ok: false });

  emitReceipts({
    captureDir,
    request: makeRequest(),
    provenance: {
      by: "MM",
      at: new Date().toISOString(),
      source: "https://example.invalid/capture",
      record: join(captureDir, "provenance.txt"),
    },
  });
  const receipt = parseEvidenceReceipt("rollback", readFileSync(join(captureDir, "rollback.receipt.json")));
  const codes = Object.fromEntries(receipt.data.checks.map((check) => [check.name, check.exitCode]));
  assert.equal(codes["restore-rehearsal"], 1);
  assert.equal(codes["restored-health"], 1);
});

test("a parity report that does not say it is verified earns a failing exit code", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"));
  writeBoundedReport(join(captureDir, "restore-health.json"), health);
  writeFileSync(join(captureDir, "provenance.txt"), "captured on the server by the MM seat\n", { mode: 0o600 });
  writeFileSync(join(captureDir, "import-parity.json"), '{"isFullyVerified":false}\n', { mode: 0o600 });

  emitReceipts({
    captureDir,
    request: makeRequest(),
    provenance: {
      by: "MM",
      at: new Date().toISOString(),
      source: "https://example.invalid/capture",
      record: join(captureDir, "provenance.txt"),
    },
    parityReportPath: join(captureDir, "import-parity.json"),
  });
  const receipt = parseEvidenceReceipt("import", readFileSync(join(captureDir, "import.receipt.json")));
  const codes = Object.fromEntries(receipt.data.checks.map((check) => [check.name, check.exitCode]));
  assert.equal(codes["parity"], 1);
  assert.equal(codes["read-only-archive"], 0);
});

test("a line the redactor cannot parse is counted, and its credential is not kept", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  // A truncated log line that still holds a credential shape.  The line has
  // no structure to walk and no key to read, so the prose pass is the only
  // redaction available:  the credential goes, the line stays broken, and the
  // failure is counted rather than swallowed.
  writeFileSync(join(store, "events", "broken.ndjson"), `{"kind":"turn","key":"${TOKEN}"\n`);

  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const archived = readFileSync(join(outDir, "tree", "events", "broken.ndjson"), "utf8");
  assert.ok(!archived.includes(TOKEN), "the raw credential never reaches the capture");
  const report = JSON.parse(readFileSync(join(outDir, "archive-report.json"), "utf8"));
  assert.ok(report.redactionFailures > 0, "the failure is counted in the report that travels");
  assert.ok(report.redactionFailedFiles > 0, "the file it came from is counted too");
});

test("a value under a secret-shaped key is masked even with no credential shape", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  // "hunter2" has no prefix for a shape pass to find:  only the KEY says it
  // is a credential, so the redaction has to keep the key in hand.
  writeFileSync(join(store, "account.json"), JSON.stringify({ user: "jay", password: "hunter2-correct-horse" }));

  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const document = JSON.parse(readFileSync(join(outDir, "tree", "account.json"), "utf8"));
  assert.equal(document.user, "jay", "an ordinary value survives");
  assert.notEqual(document.password, "hunter2-correct-horse", "the password does not");
});

test("a capture with a redaction failure does not certify itself clean", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  writeFileSync(join(store, "events", "broken.ndjson"), `{"kind":"turn","key":"${TOKEN}"\n`);
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  const health = restoredHealth(join(parent, "restored"));
  writeBoundedReport(join(captureDir, "restore-health.json"), health);
  writeFileSync(join(captureDir, "provenance.txt"), "captured on the server by the MM seat\n", { mode: 0o600 });
  writeFileSync(join(captureDir, "import-parity.json"), `${JSON.stringify(makeParityReport(), null, 2)}\n`, { mode: 0o600 });

  emitReceipts({
    captureDir,
    request: makeRequest(),
    provenance: {
      by: "MM",
      at: new Date().toISOString(),
      source: "https://example.invalid/capture",
      record: join(captureDir, "provenance.txt"),
    },
    parityReportPath: join(captureDir, "import-parity.json"),
  });
  const receipt = parseEvidenceReceipt("import", readFileSync(join(captureDir, "import.receipt.json")));
  const codes = Object.fromEntries(receipt.data.checks.map((check) => [check.name, check.exitCode]));
  assert.equal(codes["parity"], 0, "the parity report is still its own verdict");
  assert.equal(codes["read-only-archive"], 1, "but the archive does not certify itself clean");
});

test("a manifest that names a path outside the tree is refused, not written", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });

  // Tamper with the manifest:  a row that climbs out of the tree.
  const manifestPath = join(captureDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({
    path: "../../escaped.txt",
    bytes: 4,
    sha256: sha256(Buffer.from("evil")),
    mode: "0444",
    kind: "text",
    redacted: false,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const rehearsal = restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  assert.equal(rehearsal.ok, false, "the rehearsal refuses the escaped path");
  assert.ok(rehearsal.mismatches.some((row) => row.reason === "unsafe-manifest-path"));
  assert.ok(!existsSync(join(parent, "escaped.txt")), "nothing was written outside the restore root");
});

test("a manifest that names a file the archive does not hold is a mismatch, not a crash", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });

  const manifestPath = join(captureDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({
    path: "gone.txt",
    bytes: 4,
    sha256: sha256(Buffer.from("gone")),
    mode: "0444",
    kind: "text",
    redacted: false,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const rehearsal = restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });
  assert.equal(rehearsal.ok, false);
  const row = rehearsal.mismatches.find((entry) => entry.path === "gone.txt");
  assert.ok(row, "the missing file is a mismatch row");
  assert.equal(row.reason, "archive-hash-mismatch");
});

test("a structured file the health check cannot read is a verdict, not a crash", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });

  // The restored log is unreadable underneath the health check.
  chmodSync(join(parent, "restored", "events", "turn-1.ndjson"), 0o000);

  const health = restoredHealth(join(parent, "restored"), { referenceDir: join(captureDir, "tree") });
  assert.equal(health.ok, false);
  const failure = health.checks.find((check) => !check.ok);
  assert.equal(failure.name, "ndjson:events/turn-1.ndjson");
});

test("a database that fails its integrity check is a verdict, and its handle is closed", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStore();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  restoreArchive({ archiveDir: captureDir, intoDir: join(parent, "restored") });

  // A file that is not a database at all, in the place the database goes.
  chmodSync(join(parent, "restored", "messages.db"), 0o644);
  writeFileSync(join(parent, "restored", "messages.db"), "this is not a database");

  const health = restoredHealth(join(parent, "restored"), { referenceDir: join(captureDir, "tree") });
  assert.equal(health.ok, false);
  const failure = health.checks.find((check) => check.name === "sqlite-integrity");
  assert.equal(failure.ok, false);
});
