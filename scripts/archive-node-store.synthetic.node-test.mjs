/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in the prose comments of this module. */
// The synthetic proof for the Node store archive producer (BF-2515).
//
// The producer's own test file proves that each piece of the capture behaves.
// This file proves the thing the pieces exist for:  a store inside a stated
// pair of ceilings is captured, a store above either ceiling is refused
// before any output exists, ordinary attachments are kept, the manifest
// hashes the archived bytes, and a restore into scratch reproduces what was
// captured.
//
// Every fixture here is built in a temporary directory.  Nothing in this file
// reads, copies or hashes a real store on any host, so the proof never runs
// against the owner's own data and never needs a purge, a service change or
// a deployment to be true.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  archiveStore,
  estimateCaptureBytes,
  exclusionReason,
  hashFile,
  parseCeilingFlag,
  restoredHealth,
  restoreArchive,
} from "./archive-node-store.mjs";


const ROOT_IS_ROOT = Boolean(process.getuid) && process.getuid() === 0;

/** The archive command, run as a child process so its own refusal is the thing under test. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "archive-node-store.mjs");

/** The candidate ceilings this proof states on the command line. */
const CANDIDATE_MAX_FILES = 64;
const CANDIDATE_MAX_BYTES = 65536;

/** A binary attachment, named the way the app names one. */
const PNG_NAME = "11111111-1111-4111-8111-111111111111.png";

/** A real one-pixel PNG, so the attachment holds the bytes a real upload holds. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A text attachment, named the way the app names one. */
const TEXT_NAME = "22222222-2222-4222-8222-222222222222.txt";

/** A private scratch directory, which is what the archive requires. */
function privateScratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Run the archive command as a child process.
 *
 * The store is always named explicitly, so the real store on this host is
 * never the one under test.
 */
function runArchiveCli(args) {
  return spawnSync(process.execPath, [CLI, "archive", ...args], { encoding: "utf8" });
}

/**
 * A synthetic store with the files the capture has to decide about:  a live
 * database, a text store, a newline-delimited log, a binary attachment and a
 * text attachment, beside a credential store and a credential file.
 */
function makeSyntheticStore() {
  const root = privateScratch("synthetic-store-");
  mkdirSync(join(root, "attachments"), { recursive: true });
  mkdirSync(join(root, "events"), { recursive: true });
  const database = new DatabaseSync(join(root, "messages.db"));
  database.exec("CREATE TABLE messages (id INTEGER, body TEXT)");
  database.prepare("INSERT INTO messages (id, body) VALUES (?, ?)").run(1, "hello");
  database.close();
  writeFileSync(join(root, "bots.json"), `${JSON.stringify({ bots: [{ id: "1", name: "one" }] }, null, 2)}\n`);
  writeFileSync(join(root, "events", "turn-1.ndjson"), '{"kind":"turn","id":"1"}\n{"kind":"delta","id":"1"}\n');
  writeFileSync(join(root, "attachments", PNG_NAME), PNG_BYTES);
  writeFileSync(join(root, "attachments", TEXT_NAME), "an ordinary text attachment\n");
  writeFileSync(join(root, "config.json"), `${JSON.stringify({ provider: "x" }, null, 2)}\n`);
  writeFileSync(join(root, ".env"), "API_TOKEN=fake\n");
  return root;
}

/**
 * Capture the synthetic store through the command, with the candidate
 * ceilings named on the command line.
 *
 * The ceilings in force are the ones the command reports back, so the proof
 * never runs against a different pair than the one it states.
 */
function captureWithCandidateCeilings() {
  const store = makeSyntheticStore();
  const parent = privateScratch("synthetic-capture-");
  const captureDir = join(parent, "capture");
  const result = runArchiveCli([
    "--store", store,
    "--out", captureDir,
    "--max-files", String(CANDIDATE_MAX_FILES),
    "--max-bytes", String(CANDIDATE_MAX_BYTES),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const manifest = JSON.parse(readFileSync(join(captureDir, "manifest.json"), "utf8"));
  return { store, parent, captureDir, manifest, summary };
}

/** Every regular file under a root, as store-relative POSIX paths. */
function listFiles(root, prefix = "") {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    const storeRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...listFiles(absolute, storeRelative));
      continue;
    }
    if (entry.isFile()) found.push(storeRelative);
  }
  return found.sort();
}

test("the ceiling flags name the candidate pair this proof uses", () => {
  assert.equal(parseCeilingFlag(["--max-files", String(CANDIDATE_MAX_FILES)], "--max-files"), CANDIDATE_MAX_FILES);
  assert.equal(parseCeilingFlag([`--max-bytes=${CANDIDATE_MAX_BYTES}`], "--max-bytes"), CANDIDATE_MAX_BYTES);
});

test("a store inside the candidate ceilings is captured by the command that names them", { skip: ROOT_IS_ROOT }, () => {
  const { summary, manifest } = captureWithCandidateCeilings();
  assert.equal(summary.archived, true);
  assert.equal(summary.maxFiles, CANDIDATE_MAX_FILES, "the file ceiling in force is the one the operator named");
  assert.equal(summary.maxBytes, CANDIDATE_MAX_BYTES, "the byte ceiling in force is the one the operator named");
  assert.equal(summary.files, manifest.files.length);
  assert.ok(summary.files > 0);
  assert.equal(manifest.totals.files, manifest.files.length);
  assert.ok(manifest.totals.bytes > 0);
});

test("the plain command captures the store, attachments and all, with no ceiling flags", { skip: ROOT_IS_ROOT }, () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("synthetic-default-");
  const captureDir = join(parent, "capture");
  const result = runArchiveCli(["--store", store, "--out", captureDir]);
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.maxFiles, DEFAULT_MAX_FILES, "the plain command uses the shipped file ceiling");
  assert.equal(summary.maxBytes, DEFAULT_MAX_BYTES, "the plain command uses the shipped byte ceiling");
  const manifest = JSON.parse(readFileSync(join(captureDir, "manifest.json"), "utf8"));
  assert.ok(manifest.files.some((row) => row.path === `attachments/${PNG_NAME}`), "the binary attachment is in the capture");
});

test("a store above the file-count ceiling is refused before any output exists", { skip: ROOT_IS_ROOT }, () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("synthetic-files-");
  const captureDir = join(parent, "capture");
  const result = runArchiveCli(["--store", store, "--out", captureDir, "--max-files", "3"]);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /store holds \d+ files, above the 3 ceiling/, "the refusal names the measured size and the ceiling");
  assert.ok(!existsSync(captureDir), "no capture directory is left behind");
  assert.deepEqual(readdirSync(parent), [], "no partial tree, manifest or report is left behind");
});

test("a store above the byte ceiling is refused before any output exists", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("synthetic-bytes-");
  const captureDir = join(parent, "capture");
  const result = runArchiveCli(["--store", store, "--out", captureDir, "--max-bytes", "64"]);

  const estimate = estimateCaptureBytes(store, listFiles(store));
  assert.ok(estimate.bytes > 64, "the store is above the ceiling this proof names");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, new RegExp(`store holds ${estimate.bytes} bytes, above the 64 byte ceiling`), "the refusal names the pre-flight estimate and the ceiling");
  assert.doesNotMatch(result.stderr, /archive reached/, "the refusal came from the pre-flight estimate, not from a copy that had already begun");
  assert.ok(!existsSync(captureDir), "no capture directory is left behind");
  assert.deepEqual(readdirSync(parent), [], "no partial tree, manifest or report is left behind");

  // The function path refuses the same way, and leaves nothing behind either.
  const functionCapture = join(parent, "capture-function");
  await assert.rejects(
    () => archiveStore({ storeRoot: store, outDir: functionCapture, maxBytes: 64 }),
    new RegExp(`store holds ${estimate.bytes} bytes, above the 64 byte ceiling`),
  );
  assert.ok(!existsSync(functionCapture), "the function path leaves no capture directory behind");
});

test("the pre-flight estimate counts the files the capture would copy", { skip: ROOT_IS_ROOT }, () => {
  const store = makeSyntheticStore();
  const files = listFiles(store);
  const estimate = estimateCaptureBytes(store, files);
  const copyable = files.filter((path) => exclusionReason(path) === null);
  assert.equal(estimate.files, copyable.length, "the credential files are not counted");
  assert.ok(estimate.bytes > 0);
  assert.ok(estimate.bytes <= files.reduce((sum, path) => sum + statSync(join(store, path)).size, 0), "the estimate is no larger than the whole store");
});

test("a binary attachment is archived, not skipped", { skip: ROOT_IS_ROOT }, () => {
  const { captureDir, manifest } = captureWithCandidateCeilings();
  const row = manifest.files.find((entry) => entry.path === `attachments/${PNG_NAME}`);
  assert.ok(row, "the binary attachment is in the capture");
  assert.equal(row.kind, "binary");
  assert.deepEqual(readFileSync(join(captureDir, "tree", "attachments", PNG_NAME)), PNG_BYTES, "the attachment is archived byte for byte");

  const text = manifest.files.find((entry) => entry.path === `attachments/${TEXT_NAME}`);
  assert.ok(text, "the text attachment is in the capture");
  assert.equal(text.kind, "text");
});

test("the exclusion rules keep credential material out and keep ordinary attachments in", { skip: ROOT_IS_ROOT }, () => {
  assert.equal(exclusionReason(`attachments/${PNG_NAME}`), null, "a binary attachment is not credential material");
  assert.equal(exclusionReason(`attachments/${TEXT_NAME}`), null, "a text attachment is not credential material");
  assert.equal(exclusionReason("config.json"), "credential-store");
  assert.equal(exclusionReason(".env"), "credential-material");
  assert.equal(exclusionReason("nested/.env.local"), "credential-material");
  assert.equal(exclusionReason("server.key"), "credential-material");

  const { captureDir, manifest } = captureWithCandidateCeilings();
  const excluded = new Map(manifest.excluded.map((entry) => [entry.path, entry.reason]));
  assert.equal(excluded.get("config.json"), "credential-store");
  assert.equal(excluded.get(".env"), "credential-material");
  assert.ok(!excluded.has(`attachments/${PNG_NAME}`), "the binary attachment is not excluded");
  assert.ok(existsSync(join(captureDir, "tree", "attachments", PNG_NAME)), "the binary attachment is archived");
});

test("every file the manifest names is in the archive and hashes to its manifest row", { skip: ROOT_IS_ROOT }, () => {
  const { captureDir, manifest } = captureWithCandidateCeilings();
  assert.ok(manifest.files.length > 0);
  for (const row of manifest.files) {
    const archived = join(captureDir, "tree", ...row.path.split("/"));
    assert.ok(existsSync(archived), `${row.path} is in the archive`);
    assert.equal(hashFile(archived), row.sha256, `${row.path} hashes to its manifest row`);
  }
});

test("the restore into scratch reproduces the captured store, file for file and hash for hash", { skip: ROOT_IS_ROOT }, () => {
  const { parent, captureDir, manifest } = captureWithCandidateCeilings();
  const restoredDir = join(parent, "restored");
  const rehearsal = restoreArchive({ archiveDir: captureDir, intoDir: restoredDir });

  assert.equal(rehearsal.ok, true);
  assert.deepEqual(rehearsal.mismatches, []);
  assert.equal(rehearsal.restoredFiles, manifest.files.length);
  assert.deepEqual(listFiles(restoredDir), manifest.files.map((row) => row.path).sort(), "the restored file set is the captured file set");
  for (const row of manifest.files) {
    const restored = join(restoredDir, ...row.path.split("/"));
    assert.equal(hashFile(restored), row.sha256, `${row.path} restores to its manifest hash`);
  }
});

test("every file the capture copied verbatim comes back byte for byte", { skip: ROOT_IS_ROOT }, () => {
  const { store, parent, captureDir, manifest } = captureWithCandidateCeilings();
  const restoredDir = join(parent, "restored");
  restoreArchive({ archiveDir: captureDir, intoDir: restoredDir });

  const verbatim = manifest.files.filter((row) => row.kind === "binary" || (row.kind === "text" && row.redacted === false));
  assert.ok(verbatim.length > 0);
  for (const row of verbatim) {
    const source = join(store, ...row.path.split("/"));
    const restored = join(restoredDir, ...row.path.split("/"));
    assert.equal(hashFile(restored), hashFile(source), `${row.path} matches the source byte for byte`);
  }
  assert.ok(manifest.files.some((row) => row.kind === "sqlite-snapshot"), "the database was snapshotted rather than copied");
});

test("the restored store passes its own health check against the source", { skip: ROOT_IS_ROOT }, () => {
  const { store, parent, captureDir } = captureWithCandidateCeilings();
  const restoredDir = join(parent, "restored");
  restoreArchive({ archiveDir: captureDir, intoDir: restoredDir });

  const health = restoredHealth(restoredDir, { referenceDir: store });
  assert.equal(health.ok, true, JSON.stringify(health.checks.filter((check) => !check.ok)));
  const sqlite = health.checks.find((check) => check.name === "sqlite-integrity");
  assert.equal(sqlite.ok, true);
});

test("a capture that fails part way leaves no capture directory behind", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  // A file that claims to be a database and is not one:  the snapshot fails,
  // and the capture directory exists by then.
  writeFileSync(
    join(store, "messages.db"),
    Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.from("not a database at all")]),
  );
  const parent = privateScratch("synthetic-failure-");
  const captureDir = join(parent, "capture");

  await assert.rejects(() => archiveStore({ storeRoot: store, outDir: captureDir }));
  assert.ok(!existsSync(captureDir), "the failed capture left no capture directory behind");
  assert.deepEqual(readdirSync(parent), [], "no partial tree, manifest or report is left behind");
});

/* oxlint-enable eslint/no-irregular-whitespace */
