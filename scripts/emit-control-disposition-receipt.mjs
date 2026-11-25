/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// Emit the `control-disposition` receipt for the decommission evidence bundle (BF-2701).
//
// The gate requires this receipt before `mac-control/` may be retired with
// Electron (BF-2485), and the bundle defines it as three checks:
// `owner-decision`, `landed-implementation` and `muster-disposition`.  Nothing
// in the tree produced it, so it could only be written by hand.
//
// The exit codes of the first two are never taken from the operator.  They are
// read out of the verdict `scripts/check-control-disposition.mjs` measured
// against the candidate's own commit, and this script computes each summary
// again from the verdict's details.  A verdict whose summary says one thing and
// whose details say another did not come from that check, and it is refused.
// A receipt that says a check passed when the tree says it did not is worse
// than no receipt at all.
//
// The third check is the owner's attestation of the fleet-administration
// half, which no tree can state.  It holds when every item the ruling moved out
// of the product has a disposition and an https source, and when it is
// attested by the person the bundle names as its acceptance owner.  What this
// script cannot establish is that the person wrote it: like every other
// producer here, it reads saved files.
//
// The three artifacts the receipt cites are written by this script out of what
// it judged, so the bytes that are hashed are the bytes that were judged.  They
// are read back through the bundle's own reader, which refuses a link, a file
// with more than one name and anything that is not owner-only.  An artifact
// that would hold an unredacted credential is refused before anything is
// written.
//
// Nothing is written unless all three checks hold.  A receipt with a failing
// check is one the bundle refuses.  A refusal also leaves a receipt from an
// earlier good run as it is, because a broken input today says nothing against
// evidence that was measured against the same commit.
//
// What this script does NOT do: it does not retire anything, run a job, read a
// data directory or contact a network, and it cannot say the controls work.
//
// Usage:
//   node scripts/emit-control-disposition-receipt.mjs --capture <capture-dir> \
//     --request <bundle-request.json> \
//     --verdict <control-disposition-verdict.json> \
//     --attestation <muster-disposition-attestation.json> \
//     --provenance-record <file-in-capture-dir> \
//     --provenance-source <https-url> --provenance-by <who> \
//     --provenance-at <iso-8601-instant>
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { redactSecretsInText } from "../shared/redact.ts";
import { validateBundleRequest } from "./archive-node-store.mjs";
import {
  CONTROL_DISPOSITION_VERDICT_KIND, CONTROL_DISPOSITION_VERDICT_VERSION, FLEET_ADMIN_ITEMS, PRODUCT_CONTROLS, RULING,
  summarizeControlDisposition, writeOwnerOnly,
} from "./check-control-disposition.mjs";
import {
  assertReceiptBinding, createEvidenceReader, evidenceHash, MAX_EVIDENCE_FILE_BYTES,
  parseEvidenceReceipt, REQUIRED_CHECKS,
} from "./decommission-evidence-bundle.mjs";
import { writeReceiptFile } from "./emit-process-inventory-receipt.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";

export const CONTROL_DISPOSITION_RECEIPT_VERSION = 1;
export const CONTROL_DISPOSITION_RECEIPT_KIND = "control-disposition";
export const CONTROL_DISPOSITION_RECEIPT_FILE = "control-disposition.receipt.json";

/** The checks the bundle requires for this receipt kind, in the bundle's order. */
export const CONTROL_DISPOSITION_CHECKS = REQUIRED_CHECKS[CONTROL_DISPOSITION_RECEIPT_KIND];

/** The one artifact each check cites, by check name. */
export const CONTROL_DISPOSITION_ARTIFACTS = Object.freeze({
  "owner-decision": "control-disposition.owner-decision.json",
  "landed-implementation": "control-disposition.landed-implementation.json",
  "muster-disposition": "control-disposition.muster-disposition.json",
});

const text = z.string().trim().min(1).max(2048);
const httpsUrl = z.url().max(2048).refine((value) => value.startsWith("https://"));
const missing = z.array(z.string().trim().min(1).max(512)).max(64);

/**
 * The verdict's shape, as far as the receipt reads it.
 *
 * It is external input, so it is parsed at the boundary. What the receipt
 * holds the verdict to beyond this shape is not a matter of shape and is
 * checked apart from it: the commit, the ruling, the list of controls, and
 * whether each summary follows from the verdict's own details.
 */
const VerdictSchema = z.strictObject({
  version: z.literal(CONTROL_DISPOSITION_VERDICT_VERSION),
  kind: z.literal(CONTROL_DISPOSITION_VERDICT_KIND),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  ruling: z.strictObject({ document: text, decision: text, found: z.boolean(), missing }),
  controls: z.array(z.strictObject({ id: text, label: text, landed: z.boolean(), missing })).max(64),
  checks: z.record(z.string(), z.strictObject({ ok: z.boolean(), exitCode: z.number().int() })),
});

/**
 * The owner's attestation of the fleet-administration half.
 *
 * `items` has to name every item the ruling moved out of the product, each
 * once, with where it went and an https record of that. `attestedBy` has to be
 * the bundle's acceptance owner, which is checked against the bundle and so is
 * not a shape rule.
 */
export const MusterDispositionAttestationSchema = z.strictObject({
  version: z.literal(1),
  decision: text,
  items: z.array(z.strictObject({ id: text, disposition: text, evidence: httpsUrl })).min(1).max(16)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "an item is named more than once"),
  attestedBy: text,
  attestedAt: z.iso.datetime({ offset: true }),
  source: httpsUrl,
});

const ProvenanceInputSchema = z.strictObject({
  by: text,
  at: z.iso.datetime({ offset: true }),
  source: httpsUrl,
  record: text,
});

/**
 * Read one bounded, single-link JSON file this user owns.
 */
function readSafeJsonFile(filePath, label) {
  const target = resolve(filePath);
  const entry = lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`${label} must be a regular single-link file: ${filePath}`);
  }
  if (process.getuid && entry.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user: ${filePath}`);
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new Error(`${label} changed during read: ${filePath}`);
    }
    if (opened.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error(`${label} exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${filePath}`);
    }
    const buf = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    if (len > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error(`${label} exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${filePath}`);
    }
    const after = fstatSync(fd);
    const listedAfter = lstatSync(target);
    if (
      listedAfter.isSymbolicLink()
      || listedAfter.nlink !== 1
      || !listedAfter.isFile()
      || listedAfter.uid !== entry.uid
      || listedAfter.dev !== after.dev
      || listedAfter.ino !== after.ino
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed during read: ${filePath}`);
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, len));
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} is not valid JSON: ${filePath}`, { cause: error });
    }
    if (error?.code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link: ${filePath}`);
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve an operator-supplied capture file path into a relative path inside
 * the capture directory.
 */
function captureRelativePath(captureRoot, targetPath, label) {
  const parsed = text.safeParse(targetPath);
  if (!parsed.success) throw new Error(`missing ${label} path`);
  const raw = parsed.data;
  let absolute;
  if (isAbsolute(raw)) {
    const unresolved = resolve(raw);
    let canonicalDir;
    try {
      canonicalDir = realpathSync(dirname(unresolved));
    } catch {
      throw new Error(`${label} must live inside the capture directory: ${targetPath}`);
    }
    absolute = join(canonicalDir, basename(unresolved));
  } else {
    absolute = resolve(captureRoot, raw);
  }
  const rel = relative(captureRoot, absolute);
  if (
    !rel
    || rel === "."
    || rel === ".."
    || rel.startsWith("../")
    || rel.startsWith("..\\")
    || isAbsolute(rel)
  ) {
    throw new Error(`${label} must live inside the capture directory: ${targetPath}`);
  }
  return rel.split(sep).join("/");
}

/**
 * The printable text of a refusal, on one bounded line.
 */
function printable(value) {
  const line = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`)
    .trim();
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

/**
 * Hold the verdict to what it has to be about, and say why it does not hold.
 *
 * Throws when the verdict cannot be this receipt's verdict at all: another
 * commit, another ruling, a control the ruling does not name, one left out, or
 * a summary that does not follow from its own details. Returns the two
 * summaries the details state, whether or not they hold.
 */
function judgeVerdict(verdict, bundle) {
  if (verdict.sourceSha !== bundle.candidate.sourceSha) {
    throw new Error(
      `the verdict was taken against ${verdict.sourceSha}, and the bundle's candidate is ${bundle.candidate.sourceSha}`,
    );
  }
  if (verdict.ruling.document !== RULING.document || verdict.ruling.decision !== RULING.decision) {
    throw new Error("the verdict is not about the ruling that split BotFleet Control");
  }
  const named = new Map(PRODUCT_CONTROLS.map((entry) => [entry.id, entry.label]));
  const seen = new Set();
  for (const entry of verdict.controls) {
    if (!named.has(entry.id)) throw new Error(`the verdict names a control the ruling does not: ${entry.id}`);
    if (seen.has(entry.id)) throw new Error(`the verdict names the control "${entry.id}" more than once`);
    if (entry.label !== named.get(entry.id)) throw new Error(`the verdict names the control "${entry.id}" under another label`);
    seen.add(entry.id);
  }
  const leftOut = [...named.keys()].filter((id) => !seen.has(id));
  if (leftOut.length > 0) throw new Error(`the verdict says nothing about the controls: ${leftOut.join(", ")}`);

  const stated = summarizeControlDisposition(verdict);
  for (const name of Object.keys(stated)) {
    if (JSON.stringify(verdict.checks[name]) !== JSON.stringify(stated[name])) {
      throw new Error(`the verdict's summary for ${name} does not follow from its own details, so it did not come from the check`);
    }
  }
  return stated;
}

/**
 * Hold the attestation to naming the whole fleet-administration half, and to
 * being the acceptance owner's.
 *
 * Returns the reasons it does not hold, which is an empty list when it does.
 */
export function judgeMusterDisposition(attestation, bundle) {
  const reasons = [];
  const known = new Set(FLEET_ADMIN_ITEMS.map((item) => item.id));
  for (const item of attestation.items) {
    if (!known.has(item.id)) reasons.push(`the attestation names an item the ruling does not move out of the product: ${item.id}`);
  }
  const dispositioned = new Set(attestation.items.map((item) => item.id));
  for (const item of FLEET_ADMIN_ITEMS.filter(({ id }) => !dispositioned.has(id))) {
    reasons.push(`muster-disposition does not hold, nothing is said about: ${item.label}`);
  }
  if (attestation.attestedBy !== bundle.acceptanceOwner) {
    reasons.push(
      `muster-disposition is attested by ${attestation.attestedBy}, and the bundle's acceptance owner is ${bundle.acceptanceOwner}`,
    );
  }
  return reasons;
}

/** Serialize one artifact exactly as it is hashed and cited. */
function artifactBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Emit the `control-disposition` receipt.
 *
 * @returns {{receipt: object, reference: object, kind: string}}
 */
export function emitControlDispositionReceipt({
  captureDir,
  request,
  verdictPath,
  attestationPath,
  provenance,
}) {
  const capture = realpathSync(resolve(captureDir));
  assertPrivateCaptureDir(capture);
  const bundle = validateBundleRequest(request);

  const parsedProvenance = ProvenanceInputSchema.safeParse(provenance);
  if (!parsedProvenance.success) {
    const fields = new Set(parsedProvenance.error.issues.map((issue) => String(issue.path[0] ?? "")));
    if (fields.has("source")) throw new Error("the provenance source must be an https URL");
    if (fields.has("at")) throw new Error("the provenance instant must be an ISO 8601 date and time with an offset");
    throw new Error("the provenance --provenance-by and --provenance-record values must be non-empty");
  }
  const snapshotProvenance = parsedProvenance.data;

  const rawVerdict = readSafeJsonFile(verdictPath, "control-disposition verdict");
  const parsedVerdict = VerdictSchema.safeParse(rawVerdict);
  if (!parsedVerdict.success) {
    const detail = parsedVerdict.error.issues
      .map((issue) => `${issue.path.join(".") || "verdict"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the verdict does not match the expected shape: ${detail}`);
  }
  const verdict = parsedVerdict.data;
  const stated = judgeVerdict(verdict, bundle);

  const rawAttestation = readSafeJsonFile(attestationPath, "muster-disposition attestation");
  const parsedAttestation = MusterDispositionAttestationSchema.safeParse(rawAttestation);
  if (!parsedAttestation.success) {
    const detail = parsedAttestation.error.issues
      .map((issue) => `${issue.path.join(".") || "attestation"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the attestation does not match the expected shape: ${detail}`);
  }
  const attestation = parsedAttestation.data;

  // The reasons are given in the receipt's own order, so the first one named
  // is the first check the bundle reads.
  const reasons = [];
  if (!stated["owner-decision"].ok) {
    reasons.push(`owner-decision does not hold: ${verdict.ruling.missing.join("; ") || "the ruling is not recorded"}`);
  }
  for (const entry of verdict.controls.filter((control) => !control.landed)) {
    reasons.push(`landed-implementation does not hold, ${entry.id}: ${entry.missing.join("; ") || "not landed"}`);
  }
  reasons.push(...judgeMusterDisposition(attestation, bundle));
  if (reasons.length > 0) {
    throw new Error(`nothing was written, because ${reasons.join(". ")}.`);
  }

  const labels = new Map(FLEET_ADMIN_ITEMS.map((item) => [item.id, item.label]));
  const artifacts = {
    "owner-decision": {
      version: 1,
      kind: "control-disposition.owner-decision",
      sourceSha: verdict.sourceSha,
      ruling: verdict.ruling,
    },
    "landed-implementation": {
      version: 1,
      kind: "control-disposition.landed-implementation",
      sourceSha: verdict.sourceSha,
      controls: verdict.controls,
    },
    "muster-disposition": {
      version: 1,
      kind: "control-disposition.muster-disposition",
      items: attestation.items.map(({ id, disposition, evidence }) => ({ id, label: labels.get(id), disposition, evidence })),
      decision: attestation.decision,
      attestedBy: attestation.attestedBy,
      attestedAt: attestation.attestedAt,
      source: attestation.source,
    },
  };

  // Nothing is written until everything that can be judged has been.  An
  // artifact that would hold a credential is refused here, before a copy of
  // it can be left behind.
  const reader = createEvidenceReader(capture);
  const provenanceRecord = captureRelativePath(capture, snapshotProvenance.record, "provenance record");
  const provenanceBytes = reader.read(provenanceRecord);
  let provenanceText;
  try {
    provenanceText = new TextDecoder("utf-8", { fatal: true }).decode(provenanceBytes);
  } catch {
    throw new Error(`the provenance record must be valid UTF-8 text: ${provenanceRecord}`);
  }
  if (redactSecretsInText(provenanceText) !== provenanceText) {
    throw new Error(`the provenance record contains unredacted credentials: ${provenanceRecord}`);
  }

  const artifactsToWrite = new Map();
  const references = {};
  for (const name of CONTROL_DISPOSITION_CHECKS) {
    const bytes = artifactBytes(artifacts[name]);
    let body;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`the ${name} artifact is not valid UTF-8 text, so nothing was written`);
    }
    if (redactSecretsInText(body) !== body) {
      throw new Error(`the ${name} artifact contains unredacted credentials, so nothing was written`);
    }
    const path = CONTROL_DISPOSITION_ARTIFACTS[name];
    artifactsToWrite.set(path, bytes);
    references[name] = { path, sha256: evidenceHash(bytes) };
  }

  const checks = CONTROL_DISPOSITION_CHECKS.map((name) => ({
    name,
    exitCode: name === "muster-disposition" ? 0 : stated[name].exitCode,
    artifact: references[name],
  }));
  if (checks.some((check) => check.exitCode !== 0)) {
    throw new Error("a check did not hold, so nothing was written");
  }

  const receipt = {
    version: CONTROL_DISPOSITION_RECEIPT_VERSION,
    kind: CONTROL_DISPOSITION_RECEIPT_KIND,
    candidate: bundle.candidate,
    mode: bundle.mode,
    hosts: bundle.hosts,
    provenance: {
      by: snapshotProvenance.by,
      at: snapshotProvenance.at,
      source: snapshotProvenance.source,
      record: { path: provenanceRecord, sha256: evidenceHash(provenanceBytes) },
    },
    data: { checks },
  };

  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    assertReceiptBinding(parseEvidenceReceipt(CONTROL_DISPOSITION_RECEIPT_KIND, receiptBytes), bundle);
  } catch (error) {
    throw new Error(`the receipt would not match the bundle's schema, so nothing was written: ${printable(error.message)}`);
  }

  for (const [path, bytes] of artifactsToWrite) writeOwnerOnly(join(capture, path), bytes);
  // Read back through the bundle's own reader: the producer never cites a
  // file the bundle would refuse, and the hash in the receipt is the hash of
  // the bytes that are on disk.
  for (const [path, bytes] of artifactsToWrite) {
    if (!reader.read(path).equals(bytes)) {
      throw new Error(`the ${path} artifact changed between being written and being read back, so no receipt was written`);
    }
  }

  writeReceiptFile(join(capture, CONTROL_DISPOSITION_RECEIPT_FILE), receiptBytes);
  return {
    receipt,
    reference: { path: CONTROL_DISPOSITION_RECEIPT_FILE, sha256: evidenceHash(receiptBytes) },
    kind: CONTROL_DISPOSITION_RECEIPT_KIND,
  };
}

const KNOWN_FLAGS = Object.freeze([
  "--capture",
  "--request",
  "--verdict",
  "--attestation",
  "--provenance-record",
  "--provenance-source",
  "--provenance-by",
  "--provenance-at",
]);

/** Parse CLI arguments strictly: refuse unknown flags, duplicate flags, or missing values. */
export function parseCliArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const flag = String(args[i]);
    if (!KNOWN_FLAGS.includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`duplicate flag: ${flag}`);
    }
    const next = args[i + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag, String(next));
    i += 1;
  }
  const missingFlags = KNOWN_FLAGS.filter((flag) => !values.has(flag));
  if (missingFlags.length > 0) {
    throw new Error(`${missingFlags.join(", ")} ${missingFlags.length === 1 ? "is" : "are"} required`);
  }
  return values;
}

let isEntry = false;
try {
  isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* imported */
}

if (isEntry) {
  try {
    const flags = parseCliArgs(process.argv.slice(2));
    const result = emitControlDispositionReceipt({
      captureDir: flags.get("--capture"),
      request: validateBundleRequest(readSafeJsonFile(flags.get("--request"), "bundle request")),
      verdictPath: flags.get("--verdict"),
      attestationPath: flags.get("--attestation"),
      provenance: {
        by: flags.get("--provenance-by"),
        at: flags.get("--provenance-at"),
        source: flags.get("--provenance-source"),
        record: flags.get("--provenance-record"),
      },
    });
    console.log(JSON.stringify({
      emitted: [CONTROL_DISPOSITION_RECEIPT_FILE],
      kind: result.kind,
      receipts: { [result.kind]: result.reference },
    }));
  } catch (error) {
    console.error(`emit-control-disposition-receipt refused: ${printable(error.message)}`);
    process.exitCode = 2;
  }
}
