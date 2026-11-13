// Archive the Node store read-only, then rehearse its restore (BF-2515).
//
// The Phase 6 decommission gate asks for `final-import-parity`:  the final
// import parity report matches, the Node store is archived read-only, and the
// rollback has been rehearsed once.  The parity report has a producer on the
// Swift side (the importer); the other two had none, so the gate listed them
// as evidence a script could not observe and only a person could assert.
// This script is the missing producer for the archive and the rehearsal.
//
// What it does, in three steps:
//
//   archive   copies a Node store into a private capture directory, snapshots
//             its SQLite database consistently, redacts credential shapes out
//             of the text it copies, makes the copy read-only, and proves the
//             read-only claim by trying to write to it;
//   restore   copies the archive back into a scratch data root, verifies every
//             file against the archive's own hash manifest, and reports the
//             restored store's structural health;
//   receipt   emits the `rollback` receipt, and the `import` receipt when an
//             import parity report is supplied, in the exact shape
//             scripts/decommission-evidence-bundle.mjs validates.
//
// Why the database is snapshotted rather than copied.  The store's
// `messages.db` is a live WAL database.  Copying the file while the harness
// is writing to it produces an archive whose contents and journal disagree,
// and that archive cannot be restored: SQLite refuses to open it, or opens it
// with rows the journal does not know about.  So the database is snapshotted
// through SQLite's own online backup, which takes a consistent copy of a live
// database, and the `-wal` and `-shm` siblings are left out because the
// snapshot supersedes them.
//
// What this script does NOT do, stated plainly because a narrower claim is
// the honest one.  It does not verify that the Swift store holds the same
// data: that is the import parity report, and this script only carries it.
// It does not prove the restored store can serve bots: `restored-health`
// means the restored data root opens, parses and passes SQLite's own
// integrity check, which is a statement about the DATA, not about a running
// harness.  It does not delete, move, rename or modify the live store, and
// it never writes to the source: the only thing it touches in the source is
// a read.
//
// The credential rule.  An archive of the live store is a capture of
// everything the owner has, so it must not carry credentials into a packet.
// Three gates apply.  Files whose names mark them as credential stores are
// excluded outright.  Text files are redacted with the shared redactor, so
// the archive's text holds no credential.  A binary small enough to inspect
// is scanned too, and one that holds a recognizable credential is excluded
// rather than corrupted, because a corrupted binary is worse than an absent
// one.
//
// A fourth gate covers the files the redactor cannot handle.  A malformed
// JSON document or a truncated log line has no structure to walk and no key
// to read, so the only redaction available is the prose pass;  the result
// keeps no credential shape, but it may no longer parse.  Such a file is
// COUNTED as a redaction failure, the original text is never kept, and the
// capture does not certify itself clean while that count is above zero.
// The count travels in the archive report and it gates the receipt, so a
// capture that could not redact something cannot be presented as one that
// did.
//
// A binary above the redaction bound is copied byte for byte and its bytes
// are NOT inspected for credentials, because a file that large cannot be
// held in a string and a compressed pack file would hide a credential from
// a text scan anyway.  The manifest says which files those are.  This is a
// limit of the capture, stated rather than hidden:  the archive is a private
// copy of the owner's own store, it stays on the owner's machine, and the
// packet carries the manifest and the reports rather than the archive.  The
// collector refuses any captured file that is not redacted UTF-8, so nothing
// unreadable can reach the packet through the back door.
//
// The read-only proof only means something for an account that is not root.
// A root account writes through a read-only bit, so this script refuses to
// run as root rather than report a read-only archive it did not have.
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync,
  openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { redactSecrets, redactSecretsInText } from "../shared/redact.ts";
import { EvidenceBundleSchema } from "./decommission-evidence-bundle.mjs";

/** The marker every archive manifest this script writes carries. */
export const ARCHIVE_MARKER = "botfleet-node-store-archive";

/** The manifest format version. */
export const ARCHIVE_VERSION = 1;

/** The named checks this producer is allowed to report. */
export const CHECK_NAMES = {
  import: ["parity", "read-only-archive"],
  rollback: ["restore-rehearsal", "restored-health"],
};

/** The default capture ceiling: refuse rather than fill a disk. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** The default capture ceiling on file count. */
export const DEFAULT_MAX_FILES = 200_000;

/**
 * The largest file the evidence bundle will accept.  The bundle's reader
 * refuses anything over one mebibyte, so every report this producer hands to
 * the packet has to fit under it:  a store with eighteen thousand files
 * produces a manifest far larger than that, and a report that the collector
 * will refuse is worse than a report that is refused here.
 */
export const MAX_PACKET_BYTES = 1024 * 1024;

/** How many rows a bounded report carries before it summarizes the rest. */
export const MAX_REPORT_ROWS = 200;

/** How many bytes are scanned for credential shapes at a time. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** How much of the previous chunk is kept, so a split credential is still seen. */
const SCAN_OVERLAP_CHARS = 4096;

/** The SQLite file magic.  A file starting with it is a database, not a blob. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "latin1");

/**
 * Store-relative paths that are credential stores and are never archived.
 * A name is enough here: the file's contents are never read to decide.
 */
export const EXCLUDED_PATHS = [
  "config.json",
  "mcp-oauth-store.json",
  "mcp-oauth-store",
  "harness-owner.json",
  "control-hosts.json",
];

/** File names matching these are credential material wherever they sit. */
const EXCLUDED_NAME_PATTERNS = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)credentials?(\..*)?$/,
  /(^|\/)secrets?(\..*)?$/,
  /\.(pem|key|p12|pfx|asc)$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  // A plugin's own secret store.  The name does not begin with "secret", so
  // the pattern above does not catch it, and the values it holds are generic
  // webhook secrets with no recognizable prefix for the shape pass to find.
  /(^|\/)plugin-secrets\.json$/i,
  // Everything under a plugin's broker directory is plugin runtime state,
  // and a broker holds the credentials its plugins run with.
  /(^|\/)\.broker(\/|$)/,
];

/** Extensions treated as text for the redaction pass. */
const TEXT_EXTENSIONS = new Set([
  ".json", ".jsonl", ".ndjson", ".txt", ".log", ".md", ".yaml", ".yml", ".toml", ".csv", ".tsv",
]);

/** The hash of a byte string, hex. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file or directory that only its owner may read. */
export function isPrivateEntry(stat) {
  return Boolean(process.getuid) && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

/** The store root this host would use, following the app's own rule. */
export function resolveStoreRoot(env = process.env) {
  const override = env.OMB_DATA_DIR?.trim();
  return override ? override : join(homedir(), ".botfleet");
}

/** Why a path is excluded, or null when it is not excluded. */
export function exclusionReason(storeRelativePath) {
  if (EXCLUDED_PATHS.includes(storeRelativePath)) return "credential-store";
  for (const pattern of EXCLUDED_NAME_PATTERNS) {
    if (pattern.test(storeRelativePath)) return "credential-material";
  }
  return null;
}

/** A path is text when its extension says so, or when it holds no NUL byte. */
export function looksTextual(storeRelativePath, bytes) {
  if (TEXT_EXTENSIONS.has(storeRelativePath.slice(storeRelativePath.lastIndexOf(".")).toLowerCase())) return true;
  if (bytes.length === 0) return true;
  // A native scan, not an interpreted loop:  the store holds files up to the
  // redaction bound, and a per-byte loop over one of those is tens of
  // millions of interpreted iterations for a single decision.
  return !bytes.includes(0);
}

/** The read-only mode every archived file carries, and every archived directory. */
export const ARCHIVE_FILE_MODE = 0o444;
export const ARCHIVE_DIR_MODE = 0o555;

/**
 * The largest file the redactor is handed whole.  A file above this is
 * copied byte for byte instead, and the manifest says so: the store holds
 * corpora of hundreds of megabytes, and a string cannot hold one of those
 * without the process giving up first.
 */
export const MAX_REDACT_BYTES = 128 * 1024 * 1024;

/** How many bytes are read at a time when a file is hashed. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/** The first bytes of a file, for the magic check. */
export function readHeader(path, length) {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}

/**
 * The SHA-256 of a file, read in chunks.  A store holds files of hundreds of
 * megabytes, so hashing one by reading it whole is a memory spike this
 * script does not need to make.
 */
export function hashFile(path) {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    let read = 0;
    while ((read = readSync(handle, buffer, 0, HASH_CHUNK_BYTES, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

/**
 * Every regular file under a root, as store-relative POSIX paths, in a stable
 * order.  Symlinks and other non-regular entries are reported separately: a
 * symlink in the store could point anywhere, and following it would put
 * content in the archive that the store does not actually contain.
 */
export function listStoreFiles(root) {
  const files = [];
  const skipped = [];
  const walk = (directory, prefix) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const storeRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: storeRelative, reason: "symbolic-link" });
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute, storeRelative);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: storeRelative, reason: "not-a-regular-file" });
        continue;
      }
      files.push(storeRelative);
    }
  };
  walk(root, "");
  files.sort();
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

/** A directory that may hold evidence: 0700, owned by this account. */
export function assertPrivateDirectory(directory) {
  const stat = statSync(directory);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${directory}`);
  if (!isPrivateEntry(stat)) throw new Error(`directory is not private (0700, owner-only): ${directory}`);
}

/**
 * Count the credential shapes in a file, read in chunks.
 *
 * This is a REPORT, not a filter.  A binary cannot be redacted without
 * corrupting it, so a database snapshot is copied whole and this counts what
 * the copy carries.  The count goes in the manifest, which means the packet
 * says "the archive holds N credential shapes" instead of saying nothing.
 */
export function countCredentialMatches(path) {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
    let carry = "";
    let matches = 0;
    let read = 0;
    while ((read = readSync(handle, buffer, 0, SCAN_CHUNK_BYTES, null)) > 0) {
      const text = carry + buffer.subarray(0, read).toString("latin1");
      matches += countRedactions(redactSecretsInText(text));
      carry = text.slice(-SCAN_OVERLAP_CHARS);
    }
    return matches;
  } finally {
    closeSync(handle);
  }
}

/**
 * How many shapes the redactor changed.  The redactor reports a mask rather
 * than a count, so this compares the masked text against the original and
 * counts the masks.
 */
export function countRedactions(redactedText) {
  const matches = redactedText.match(/«redacted \d+ chars»/g);
  return matches ? matches.length : 0;
}

/**
 * Write a report that will travel in the evidence packet.  A report over the
 * bundle's own limit is refused here, where the reason can be said, rather
 * than at the collector, where the reason is "invalid or oversized".
 */
export function writeBoundedReport(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_PACKET_BYTES) {
    throw new Error(`report is ${bytes.length} bytes, over the ${MAX_PACKET_BYTES} the bundle accepts: ${path}`);
  }
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes.length;
}

/**
 * Keep every failure and a bounded sample of the successes.  A store with
 * eighteen thousand files produces eighteen thousand successful checks, and
 * a report that lists them all is a report the bundle will refuse.
 */
export function boundChecks(checks) {
  const failed = checks.filter((check) => !check.ok);
  const passed = checks.filter((check) => check.ok);
  return {
    failures: failed,
    passedCount: passed.length,
    passedSample: passed.slice(0, Math.max(0, MAX_REPORT_ROWS - failed.length)),
    truncated: passed.length > Math.max(0, MAX_REPORT_ROWS - failed.length),
  };
}

/**
 * Copy one store file into the archive, redacting it when it is text, and
 * snapshotting it when it is a SQLite database.  Returns the manifest row.
 *
 * Three shapes, and the store holds all three.  A SQLite database is
 * snapshotted through SQLite's own online backup, so the archive holds a
 * database that opens rather than a file that matches a torn one.  A text
 * file is redacted, because a credential in a text file is a credential the
 * archive would otherwise carry.  Everything else is copied byte for byte,
 * because the store holds corpora of hundreds of megabytes — a git pack is
 * not a file a redactor can be handed, and a file the redactor cannot be
 * handed is a file it must not pretend to have checked.
 */
/**
 * Redact a JSON value, walking into objects and arrays.
 *
 * The shared redactor is a prose redactor:  it knows what a credential
 * looks like, not what a JSON document looks like.  Handed a whole document
 * it will mask across a structural boundary —  an already-masked value and
 * the quote that closes it can disappear together — and the result is a file
 * that no longer parses.  So a structured file is redacted one value at a
 * time, and the structure is rebuilt around the masked values.
 *
 * The walk keeps the KEY in hand, which is the part that matters.  A value
 * under a secret-shaped name — "token", "password", "api_key" — is masked
 * whatever it looks like, because a generic password has no recognizable
 * prefix for a shape pass to find.  A walk that only ever saw the value
 * would walk straight past it.
 */
export function redactJsonValues(value) {
  return redactSecrets(value);
}

/**
 * Redact one line of a newline-delimited file, keeping the line parsable.
 *
 * The cheap path is tried first:  redact the line as text and check that it
 * still parses.  When it does not, the line is parsed and redacted value by
 * value instead.  When that does not work either, the line is malformed AND
 * it holds a credential shape, and the ORIGINAL TEXT IS NOT KEPT.  A line
 * this producer could not redact is a line it has no business writing into
 * the capture, so what is kept is the prose-redacted text —  which carries no
 * credential shape even where it no longer parses —  and the failure is
 * counted so the report says so instead of the file quietly holding a
 * credential.
 */
export function redactNdjsonLine(line) {
  const redacted = redactSecretsInText(line);
  if (redacted === line) return { text: line, changed: false, failed: false };
  try {
    JSON.parse(redacted);
    return { text: redacted, changed: true, failed: false };
  } catch {
    /* the whole-text redaction broke the line; try the structured path */
  }
  try {
    const parsed = JSON.parse(line);
    return { text: JSON.stringify(redactJsonValues(parsed)), changed: true, failed: false };
  } catch {
    return { text: redacted, changed: true, failed: true };
  }
}

/**
 * Redact a newline-delimited document, one line at a time.
 */
export function redactNdjsonText(text) {
  const lines = text.split("\n");
  let changed = 0;
  let failed = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    const result = redactNdjsonLine(line);
    if (result.failed) failed += 1;
    if (result.changed) changed += 1;
    return result.text;
  });
  return { text: out.join("\n"), changed, failed };
}

/**
 * Redact a JSON document, keeping it parsable.
 */
export function redactJsonText(text) {
  const redacted = redactSecretsInText(text);
  if (redacted === text) return { text, changed: false, failed: false };
  try {
    JSON.parse(redacted);
    return { text: redacted, changed: true, failed: false };
  } catch {
    /* the whole-text redaction broke the document; try the structured path */
  }
  try {
    const parsed = JSON.parse(text);
    return { text: JSON.stringify(redactJsonValues(parsed)), changed: true, failed: false };
  } catch {
    // The document is malformed and it holds a credential shape.  The
    // original is not kept:  the prose-redacted text is, and the failure is
    // counted rather than swallowed.
    return { text: redacted, changed: true, failed: true };
  }
}

/**
 * Redact a text file, keeping whatever structure it has.
 *
 * A JSON document and a newline-delimited log are redacted so that they
 * still parse afterwards.  Plain text is redacted as prose, because there is
 * no structure to break.
 */
export function redactTextFile(text, storeRelativePath) {
  const extension = storeRelativePath.slice(storeRelativePath.lastIndexOf(".")).toLowerCase();
  if (extension === ".json") return redactJsonText(text);
  if (extension === ".ndjson" || extension === ".jsonl") return redactNdjsonText(text);
  const redacted = redactSecretsInText(text);
  return { text: redacted, changed: redacted !== text, failed: false };
}

/**
 * Put a SQLite file into rollback-journal mode, and report the mode it ended
 * up in.
 *
 * A backup of a WAL database is still a WAL database, and a WAL database read
 * through a truly read-only connection wants a `-shm` sibling it cannot
 * create beside a read-only file.  The archive deliberately carries no
 * siblings:  the live database's `-wal` and `-shm` are excluded because the
 * snapshot supersedes them.  So a WAL snapshot inside the archive is a
 * snapshot nobody can open, and the Swift importer — which opens the source
 * read-only — could never read it.  Converting it out of WAL mode leaves a
 * database that opens on its own, with nothing beside it.
 */
export function convertOutOfWalMode(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    const row = database.prepare("PRAGMA journal_mode").get();
    return String(row?.journal_mode ?? "unknown");
  } finally {
    database.close();
  }
}

/**
 * Refuse a snapshot that is not in rollback-journal mode.
 *
 * A WAL snapshot cannot be read through a truly read-only connection without
 * a `-shm` sibling, and the archive carries no siblings on purpose.  So a
 * snapshot that stayed in WAL mode is a snapshot the importer cannot open,
 * and it is refused here rather than sealed and shipped.
 */
export function assertRollbackJournalMode(journalMode, path) {
  if (journalMode !== "delete") {
    throw new Error(`the SQLite snapshot is still in journal mode "${journalMode}": ${path}`);
  }
}

/**
 * Prove a SQLite file opens and answers a query.
 *
 * A file that cannot be opened is not evidence of anything, so the snapshot
 * is opened and asked a question before it is sealed.
 */
export function assertOpensReadOnly(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } finally {
    database.close();
  }
}

/**
 * Copy one store file into the archive, redacting it when it is text, and
 * snapshotting it when it is a SQLite database.  Returns the manifest row.
 *
 * Three shapes, and the store holds all three.  A SQLite database is
 * snapshotted through SQLite's own online backup, so the archive holds a
 * database that opens rather than a file that matches a torn one.  A text
 * file is redacted, because a credential in a text file is a credential the
 * archive would otherwise carry.  Everything else is copied byte for byte,
 * because the store holds corpora of hundreds of megabytes — a git pack is
 * not a file a redactor can be handed, and a file the redactor cannot be
 * handed is a file it must not pretend to have checked.
 */
async function captureFile(source, destination, storeRelativePath, { readOnly }) {
  const size = statSync(source).size;
  if (readHeader(source, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(database, destination);
    } finally {
      database.close();
    }
    // The snapshot has to open on its own, with nothing beside it, so it is
    // taken out of WAL mode, the mode it ended up in is ENFORCED, and the
    // sealed file is then opened and asked a question.  A snapshot that
    // stayed in WAL mode is a database the read-only importer cannot open,
    // so it is refused here rather than shipped.
    const journalMode = convertOutOfWalMode(destination);
    assertRollbackJournalMode(journalMode, destination);
    if (readOnly) chmodSync(destination, ARCHIVE_FILE_MODE);
    assertOpensReadOnly(destination);
    const credentialMatches = countCredentialMatches(destination);
    return {
      path: storeRelativePath,
      bytes: statSync(destination).size,
      sha256: hashFile(destination),
      mode: "0444",
      kind: "sqlite-snapshot",
      redacted: false,
      credentialMatches,
      journalMode,
      note: "the database is copied whole:  a binary cannot be redacted without corrupting it, and the credential shapes it holds are counted rather than removed.  It is taken out of WAL mode so that it opens read-only with nothing beside it.",
    };
  }
  if (size > MAX_REDACT_BYTES) {
    copyFileSync(source, destination);
    if (readOnly) chmodSync(destination, ARCHIVE_FILE_MODE);
    return {
      path: storeRelativePath,
      bytes: size,
      sha256: hashFile(destination),
      mode: "0444",
      kind: "binary",
      redacted: false,
      note: "copied byte for byte:  the file is above the redaction bound, so its bytes were not inspected for credentials",
    };
  }
  const bytes = readFileSync(source);
  if (looksTextual(storeRelativePath, bytes)) {
    const text = bytes.toString("utf8");
    const outcome = redactTextFile(text, storeRelativePath);
    const out = Buffer.from(outcome.text, "utf8");
    writeFileSync(destination, out, { mode: 0o600 });
    if (readOnly) chmodSync(destination, ARCHIVE_FILE_MODE);
    return {
      path: storeRelativePath,
      bytes: out.length,
      sha256: sha256(out),
      mode: "0444",
      kind: "text",
      redacted: outcome.changed,
      redactionFailures: outcome.failed,
    };
  }
  // A binary small enough to look at.  It is scanned for a recognizable
  // credential:  a binary that carries one is excluded rather than copied,
  // because redacting a binary would corrupt it.
  const asText = bytes.toString("latin1");
  if (redactSecretsInText(asText) !== asText) {
    return { excluded: true, path: storeRelativePath, reason: "credential-in-binary", bytes: bytes.length };
  }
  writeFileSync(destination, bytes, { mode: 0o600 });
  if (readOnly) chmodSync(destination, ARCHIVE_FILE_MODE);
  return {
    path: storeRelativePath,
    bytes: bytes.length,
    sha256: sha256(bytes),
    mode: "0444",
    kind: "binary",
    redacted: false,
  };
}

/**
 * Prove the archive is read-only by trying to write to one of its files.
 * An account that may write through the read-only bit (root) proves
 * nothing, so the caller refuses to run as root before reaching here.
 */
export function proveReadOnly(filePath) {
  try {
    const handle = openSync(filePath, "r+");
    closeSync(handle);
    return { ok: false, reason: "write-succeeded" };
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") return { ok: true, code: error.code };
    return { ok: false, reason: error.code ?? "unknown-error" };
  }
}

/**
 * Archive a store into a private capture directory.  The directory must not
 * exist yet: an archive that is written over an older one is not evidence of
 * what it claims.
 */
export async function archiveStore({ storeRoot, outDir, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES, capturedAt = new Date().toISOString() }) {
  if (process.getuid && process.getuid() === 0) {
    throw new Error("refusing to run as root: a read-only bit proves nothing for root");
  }
  const source = resolve(storeRoot);
  const target = resolve(outDir);
  if (existsSync(target)) throw new Error(`capture directory already exists: ${target}`);
  const parent = dirname(target);
  assertPrivateDirectory(parent);
  const { files, skipped } = listStoreFiles(source);
  if (files.length > maxFiles) throw new Error(`store holds ${files.length} files, above the ${maxFiles} ceiling`);

  mkdirSync(target, { mode: 0o700 });
  const tree = join(target, "tree");
  mkdirSync(tree, { mode: 0o700 });

  const manifestFiles = [];
  const excluded = skipped.map((entry) => ({ ...entry, bytes: 0 }));
  const snapshotOf = new Set();
  let totalBytes = 0;
  for (const storeRelative of files) {
    if (exclusionReason(storeRelative)) {
      const stat = statSync(join(source, storeRelative));
      excluded.push({ path: storeRelative, reason: exclusionReason(storeRelative), bytes: stat.size });
      continue;
    }
    // A WAL or shared-memory sibling of a database that was snapshotted is
    // superseded by the snapshot, and copying it would restore a journal
    // that belongs to a different snapshot.
    const withoutSuffix = storeRelative.replace(/-(wal|shm)$/, "");
    if (withoutSuffix !== storeRelative && snapshotOf.has(withoutSuffix)) {
      excluded.push({ path: storeRelative, reason: "superseded-by-snapshot", bytes: 0 });
      continue;
    }
    const destination = join(tree, ...storeRelative.split("/"));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const row = await captureFile(join(source, storeRelative), destination, storeRelative, { readOnly: true });
    if (row.excluded) {
      rmQuietly(destination);
      excluded.push({ path: row.path, reason: row.reason, bytes: row.bytes });
      continue;
    }
    if (row.kind === "sqlite-snapshot") snapshotOf.add(storeRelative);
    totalBytes += row.bytes;
    if (totalBytes > maxBytes) throw new Error(`archive exceeded the ${maxBytes} byte ceiling`);
    manifestFiles.push(row);
  }
  excluded.sort((a, b) => a.path.localeCompare(b.path));

  // Make the tree read-only from the deepest directory upwards, so the
  // directories are sealed after their contents are in place.
  const directories = [];
  const collectDirectories = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const child = join(directory, entry.name);
        collectDirectories(child);
        directories.push(child);
      }
    }
  };
  collectDirectories(tree);
  directories.push(tree);
  for (const directory of directories) chmodSync(directory, ARCHIVE_DIR_MODE);

  const probe = manifestFiles.length ? proveReadOnly(join(tree, ...manifestFiles[0].path.split("/"))) : { ok: false, reason: "empty-archive" };

  const redactionFailures = manifestFiles.reduce((sum, row) => sum + (row.redactionFailures ?? 0), 0);
  const redactionFailedFiles = manifestFiles.filter((row) => (row.redactionFailures ?? 0) > 0).length;
  const manifest = {
    marker: ARCHIVE_MARKER,
    version: ARCHIVE_VERSION,
    capturedAt,
    source,
    readOnlyProved: probe.ok,
    totals: { files: manifestFiles.length, bytes: totalBytes, excluded: excluded.length, redactionFailures },
    files: manifestFiles,
    excluded,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (redactSecretsInText(manifestBytes.toString("utf8")) !== manifestBytes.toString("utf8")) {
    throw new Error("refusing to write a manifest that carries a credential shape");
  }
  writeFileSync(join(target, "manifest.json"), manifestBytes, { mode: 0o600 });
  // The report is what travels in the packet.  The manifest itself names
  // every file, and a store with eighteen thousand files produces a manifest
  // far larger than the bundle will carry, so the report summarizes the
  // archive and binds the manifest by hash.
  const report = {
    marker: "botfleet-node-store-archive-report",
    version: ARCHIVE_VERSION,
    capturedAt,
    source,
    readOnlyProved: manifest.readOnlyProved,
    totals: manifest.totals,
    manifestSha256: sha256(manifestBytes),
    manifestBytes: manifestBytes.length,
    excluded: manifest.excluded.slice(0, MAX_REPORT_ROWS),
    excludedCount: manifest.excluded.length,
    excludedTruncated: manifest.excluded.length > MAX_REPORT_ROWS,
    credentialMatches: manifest.files.reduce((sum, row) => sum + (row.credentialMatches ?? 0), 0),
    redactionFailures,
    redactionFailedFiles,
    scope: "The archive is a private copy of the owner's own store, and it holds what the store holds.  The text in it is redacted;  a database snapshot is copied whole and the credential shapes it holds are counted here.  A file the redactor could not parse is counted as a redaction failure here rather than kept quietly, and the capture does not certify itself clean while that count is above zero.  This report travels in the packet;  the archive itself does not.",
  };
  writeBoundedReport(join(target, "archive-report.json"), report);
  return { manifest, report, outDir: target };
}

/** Remove a path, ignoring the failure that matters when it is already gone. */
function rmQuietly(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    /* the file was never created */
  }
}

/**
 * Resolve a manifest path inside a root, or null when it escapes.
 *
 * A manifest is a document this producer wrote, but a restore reads one from
 * disk, and a tampered one names a path with ".." in it.  Joined without a
 * check, such a path reads outside the archive tree and writes outside the
 * restore root, so every path is resolved and then required to stay inside
 * the root it was resolved against.
 */
export function resolveInside(root, storeRelativePath) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a manifest is untyped JSON, so the path it names has to be checked before it is split.
  if (typeof storeRelativePath !== "string" || !storeRelativePath) return null;
  if (isAbsolute(storeRelativePath)) return null;
  const segments = storeRelativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const base = resolve(root);
  const resolved = resolve(base, ...segments);
  const inside = relative(base, resolved);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  return resolved;
}

/**
 * Restore an archive into a scratch data root.  Every file is verified
 * against the archive's own manifest before it is copied, and the restored
 * copy is verified again after it is written, so a corrupt archive or a
 * truncated copy is caught rather than reported as a rehearsal.
 */
export function restoreArchive({ archiveDir, intoDir, restoredAt = new Date().toISOString() }) {
  const archive = resolve(archiveDir);
  const target = resolve(intoDir);
  assertPrivateDirectory(archive);
  const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));
  if (manifest.marker !== ARCHIVE_MARKER) throw new Error("not an archive manifest");
  const tree = join(archive, "tree");
  if (existsSync(target)) throw new Error(`restore root already exists: ${target}`);
  mkdirSync(target, { mode: 0o700 });

  const mismatches = [];
  let restoredBytes = 0;
  for (const row of manifest.files) {
    // A manifest names paths, and a tampered one names a path that leaves the
    // tree.  Both the read and the write are resolved against their root and
    // refused when they escape it.
    const from = resolveInside(tree, row.path);
    const to = resolveInside(target, row.path);
    if (!from || !to) {
      mismatches.push({ path: row.path, reason: "unsafe-manifest-path" });
      continue;
    }
    let archivedHash;
    try {
      archivedHash = hashFile(from);
    } catch (error) {
      // A missing or unreadable archive file is a mismatch, not a crash:  the
      // rehearsal has to finish and write a report that says so.
      mismatches.push({ path: row.path, reason: "archive-hash-mismatch", detail: error.code ?? "unreadable" });
      continue;
    }
    if (archivedHash !== row.sha256) {
      mismatches.push({ path: row.path, reason: "archive-hash-mismatch" });
      continue;
    }
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    // The restored store has to be usable, so it is writable; the archive
    // stays read-only.
    chmodSync(to, 0o644);
    if (hashFile(to) !== row.sha256) {
      mismatches.push({ path: row.path, reason: "restored-hash-mismatch" });
      continue;
    }
    restoredBytes += statSync(to).size;
  }

  const rehearsal = {
    marker: "botfleet-node-store-restore-report",
    version: ARCHIVE_VERSION,
    restoredAt,
    archive,
    into: target,
    expectedFiles: manifest.files.length,
    restoredFiles: manifest.files.length - mismatches.length,
    restoredBytes,
    mismatches,
    ok: mismatches.length === 0,
  };
  writeBoundedReport(join(archive, "restore-report.json"), {
    ...rehearsal,
    // A broken archive can fail every file, and a report that lists every
    // failure is a report the bundle will refuse.
    mismatches: rehearsal.mismatches.slice(0, MAX_REPORT_ROWS),
    mismatchCount: rehearsal.mismatches.length,
    mismatchesTruncated: rehearsal.mismatches.length > MAX_REPORT_ROWS,
  });
  return rehearsal;
}

/**
 * The structural health of a restored store.
 *
 * This is a statement about the RESTORE, not about the store:  a file that
 * was already unparsable in the source is not a restore failure, and a file
 * that parsed in the archive and does not parse in the restore is exactly a
 * restore failure.  The archive is the reference, because the archive is
 * what was restored.
 *
 * It is also not a statement about a running harness.  The database opens and
 * passes SQLite's own integrity check, the JSON stores parse, and the
 * newline-delimited logs parse line by line, and that is the whole of it.
 */
export function restoredHealth(restoreDir, { referenceDir } = {}) {
  const root = resolve(restoreDir);
  const reference = referenceDir ? resolve(referenceDir) : null;
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  /** Whether a file's content parses as the kind of file it claims to be. */
  const parses = (absolute, storeRelative) => {
    if (storeRelative.endsWith(".json")) {
      try {
        JSON.parse(readFileSync(absolute, "utf8"));
        return true;
      } catch {
        return false;
      }
    }
    if (storeRelative.endsWith(".ndjson") || storeRelative.endsWith(".jsonl")) {
      let text;
      try {
        text = readFileSync(absolute, "utf8");
      } catch {
        // A file that cannot be read is a file that does not parse.  A
        // transient deletion or a permission error must produce a verdict,
        // not a crash that leaves the restore without a report.
        return false;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
        } catch {
          return false;
        }
      }
      return true;
    }
    return true;
  };

  const databasePath = join(root, "messages.db");
  if (existsSync(databasePath)) {
    try {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const result = database.prepare("PRAGMA integrity_check").all();
        const verdict = result.length === 1 && result[0].integrity_check === "ok" ? "ok" : "failed";
        record("sqlite-integrity", verdict === "ok", verdict);
      } catch (error) {
        record("sqlite-integrity", false, error.message);
      } finally {
        // Closed on every path, so an integrity check that throws does not
        // leak the descriptor on a corrupt restore.
        try {
          database.close();
        } catch {
          /* the handle is already gone */
        }
      }
    } catch (error) {
      record("sqlite-integrity", false, error.message);
    }
  } else {
    record("sqlite-integrity", false, "messages.db is not in the restored store");
  }

  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const storeRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, storeRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const isStructured = storeRelative.endsWith(".json") || storeRelative.endsWith(".ndjson") || storeRelative.endsWith(".jsonl");
      if (!isStructured) continue;
      const parsesHere = parses(absolute, storeRelative);
      const parsesBefore = reference ? parses(join(reference, ...storeRelative.split("/")), storeRelative) : parsesHere;
      if (!parsesHere && !parsesBefore) {
        // The source was already unparsable, so the restore reproduced it
        // faithfully.  That is a fact about the store, not a failed restore.
        record(`${storeRelative.endsWith(".json") ? "json" : "ndjson"}:${storeRelative}`, true, "unparsable in the archive too");
        continue;
      }
      if (!parsesHere) {
        record(`${storeRelative.endsWith(".json") ? "json" : "ndjson"}:${storeRelative}`, false, "parses in the archive and does not parse in the restore");
        continue;
      }
      record(`${storeRelative.endsWith(".json") ? "json" : "ndjson"}:${storeRelative}`, true, "parsed");
    }
  };
  walk(root, "");

  // Every failure is kept and the successes are summarized:  a store with
  // eighteen thousand files produces eighteen thousand successful checks, and
  // a report that lists them all is a report the bundle will refuse.
  const bounded = boundChecks(checks);
  const health = {
    marker: "botfleet-node-store-restore-health",
    version: ARCHIVE_VERSION,
    checkedAt: new Date().toISOString(),
    scope: "The restored DATA root: the database opens and passes SQLite's integrity check, the JSON stores parse and the newline-delimited logs parse line by line.  This is not a harness health check and says nothing about a running bot.",
    checks: [...bounded.failures, ...bounded.passedSample],
    failureCount: bounded.failures.length,
    passedCount: bounded.passedCount,
    truncated: bounded.truncated,
    ok: bounded.failures.length === 0,
  };
  return health;
}

/** A hash reference to a file inside the capture directory. */
export function evidenceRef(captureDir, filePath) {
  const relativePath = relative(resolve(captureDir), resolve(filePath)).split(sep).join("/");
  if (!relativePath || relativePath.startsWith("..")) throw new Error(`artifact is not inside the capture directory: ${filePath}`);
  return { path: relativePath, sha256: sha256(readFileSync(filePath)) };
}

/**
 * The exit code a check earns, read from the artifact it points at.
 *
 * A receipt that says a check passed when the artifact says it failed is
 * worse than no receipt at all:  the bundle validator accepts a check whose
 * exit code is zero and whose artifact hashes correctly, so a hardcoded zero
 * would turn a failed rehearsal into evidence of a successful one.  So every
 * exit code here is read out of the report it describes, and a report that
 * cannot be read is a failure rather than a pass.
 */
export function checkExitCode(reportPath, readVerdict) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return 1;
  }
  try {
    return readVerdict(parsed) === true ? 0 : 1;
  } catch {
    return 1;
  }
}

/**
 * Validate a bundle request against the bundle's own schema.
 *
 * The request is untrusted input:  it is a file on disk, and an unvalidated
 * one lets a receipt carry a candidate, a mode or a host list that the
 * collector will refuse.  So it is checked against the same schema the
 * collector enforces, and a request that does not match is refused here,
 * where the reason can be said, rather than at the collector, where the
 * reason is "malformed-schema".
 */
export function validateBundleRequest(request) {
  const parsed = EvidenceBundleSchema.safeParse(request);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the bundle request does not match the contract: ${issues}`);
  }
  return parsed.data;
}

/**
 * Emit the `rollback` receipt, and the `import` receipt when an import
 * parity report is supplied.  The candidate, mode and hosts come from the
 * bundle request the operator prepared, so the receipt is bound to the same
 * candidate as the rest of the packet.
 */
export function emitReceipts({ captureDir, request, provenance, parityReportPath }) {
  const capture = resolve(captureDir);
  const bundle = validateBundleRequest(request);
  const receiptBase = {
    version: 1,
    candidate: bundle.candidate,
    mode: bundle.mode,
    hosts: bundle.hosts,
    provenance: {
      by: provenance.by,
      at: provenance.at,
      source: provenance.source,
      record: evidenceRef(capture, provenance.record),
    },
  };

  const rollbackChecks = [
    {
      name: "restore-rehearsal",
      exitCode: checkExitCode(join(capture, "restore-report.json"), (report) => report.ok),
      artifact: evidenceRef(capture, join(capture, "restore-report.json")),
    },
    {
      name: "restored-health",
      exitCode: checkExitCode(join(capture, "restore-health.json"), (report) => report.ok),
      artifact: evidenceRef(capture, join(capture, "restore-health.json")),
    },
  ];
  const rollback = { ...receiptBase, kind: "rollback", data: { checks: rollbackChecks } };
  writeFileSync(join(capture, "rollback.receipt.json"), `${JSON.stringify(rollback, null, 2)}\n`, { mode: 0o600 });

  if (!parityReportPath) return { rollback };
  const parity = evidenceRef(capture, parityReportPath);
  const importChecks = [
    {
      name: "parity",
      exitCode: checkExitCode(parityReportPath, (report) => report.isFullyVerified === true),
      artifact: parity,
    },
    {
      name: "read-only-archive",
      // The check says the archive is read-only AND that it carries nothing
      // this producer could not redact.  A capture with a redaction failure in
      // it does not earn this check:  the packet would then certify an
      // archive whose text may hold a credential the producer could not mask.
      exitCode: checkExitCode(join(capture, "archive-report.json"), (report) => report.readOnlyProved === true && report.redactionFailures === 0),
      artifact: evidenceRef(capture, join(capture, "archive-report.json")),
    },
  ];
  const importReceipt = { ...receiptBase, kind: "import", data: { checks: importChecks } };
  writeFileSync(join(capture, "import.receipt.json"), `${JSON.stringify(importReceipt, null, 2)}\n`, { mode: 0o600 });
  return { rollback, import: importReceipt };
}

/** A flag's value, or undefined. */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

let isEntry = false;
try {
  isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* imported */
}

if (isEntry) {
  const [command, ...args] = process.argv.slice(2);
  const fail = (message) => {
    console.error(`archive-node-store refused: ${message}`);
    process.exitCode = 2;
  };
  try {
    if (command === "archive") {
      const storeRoot = flagValue(args, "--store") ?? resolveStoreRoot();
      const outDir = flagValue(args, "--out");
      if (!outDir) throw new Error("--out <capture-directory> is required");
      const { manifest } = await archiveStore({ storeRoot, outDir });
      console.log(JSON.stringify({
        archived: true,
        outDir: resolve(outDir),
        files: manifest.totals.files,
        bytes: manifest.totals.bytes,
        excluded: manifest.totals.excluded,
        readOnlyProved: manifest.readOnlyProved,
      }));
    } else if (command === "restore") {
      const archiveDir = flagValue(args, "--archive");
      const intoDir = flagValue(args, "--into");
      if (!archiveDir || !intoDir) throw new Error("--archive <capture-directory> and --into <scratch-root> are required");
      const rehearsal = restoreArchive({ archiveDir, intoDir });
      const health = restoredHealth(intoDir, { referenceDir: join(resolve(archiveDir), "tree") });
      writeBoundedReport(join(resolve(archiveDir), "restore-health.json"), health);
      console.log(JSON.stringify({
        restored: rehearsal.ok,
        restoredFiles: rehearsal.restoredFiles,
        expectedFiles: rehearsal.expectedFiles,
        mismatches: rehearsal.mismatches.length,
        healthOk: health.ok,
      }));
      if (!rehearsal.ok || !health.ok) process.exitCode = 1;
    } else if (command === "receipt") {
      const captureDir = flagValue(args, "--capture");
      const requestPath = flagValue(args, "--request");
      const provenanceRecord = flagValue(args, "--provenance-record");
      const provenanceSource = flagValue(args, "--provenance-source");
      const provenanceBy = flagValue(args, "--provenance-by");
      if (!captureDir || !requestPath || !provenanceRecord || !provenanceSource || !provenanceBy) {
        throw new Error("--capture, --request, --provenance-record, --provenance-source and --provenance-by are required");
      }
      const request = validateBundleRequest(JSON.parse(readFileSync(requestPath, "utf8")));
      const parityReportPath = flagValue(args, "--parity-report");
      const emitted = emitReceipts({
        captureDir,
        request,
        provenance: {
          by: provenanceBy,
          at: flagValue(args, "--provenance-at") ?? new Date().toISOString(),
          source: provenanceSource,
          record: provenanceRecord,
        },
        parityReportPath,
      });
      console.log(JSON.stringify({ emitted: Object.keys(emitted) }));
    } else {
      console.error("usage: node scripts/archive-node-store.mjs archive --store <root> --out <dir>");
      console.error("       node scripts/archive-node-store.mjs restore --archive <dir> --into <scratch-root>");
      console.error("       node scripts/archive-node-store.mjs receipt --capture <dir> --request <request.json> --provenance-record <file> --provenance-source <https-url> --provenance-by <who> [--parity-report <file>]");
      process.exitCode = 2;
    }
  } catch (error) {
    fail(error.message);
  }
}
