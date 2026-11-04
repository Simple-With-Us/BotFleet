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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ARCHIVE_MARKER,
  MAX_PACKET_BYTES,
  archiveStore,
  emitReceipts,
  exclusionReason,
  looksTextual,
  proveReadOnly,
  resolveStoreRoot,
  restoredHealth,
  restoreArchive,
  sha256,
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

  writeFileSync(join(captureDir, "import-parity.json"), '{"isFullyVerified":true}\n', { mode: 0o600 });
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
