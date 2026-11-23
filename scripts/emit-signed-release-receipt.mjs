/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// Emit the `signed-release` receipt for the decommission evidence bundle (BF-2692).
//
// The Phase 6 decommission gate's final bundle carries a `signed-release`
// receipt, and `docs/verification/native-final-evidence.md` says what it has
// to hold:  signing, notarization, stapling, one installed native copy, the
// exact Open on Mac target, the companion running without Electron, and an
// installed previous build updating through the native feed.  Nothing in the
// tree produced that receipt, so it could only be written by hand.
//
// This script reads an operator-supplied verification JSON plus the cited
// artifacts from the private capture directory, validates every artifact as
// redacted UTF-8 through `createEvidenceReader` and `redactSecretsInText`,
// requires every check the bundle names for this receipt kind, and writes the
// schema-verified receipt atomically with mode 0600.
//
// The exit codes are read out of the verification record, never asserted.  A
// receipt that says a check passed when the record says it failed is worse
// than no receipt at all:  the bundle validator accepts a check whose exit
// code is zero and whose artifact hashes correctly, so a hardcoded zero
// would turn a failed signing run into evidence of a successful one.
//
// What this script does NOT do:  it does not sign, notarize, staple, install
// or update anything, it does not contact Apple or GitHub, and it cannot
// authenticate that the captured bytes came from a real install rather than
// a fixture.  It verifies structural binding, redaction cleanliness, hashes
// and the check list the bundle itself requires.
//
// Usage:
//   node scripts/emit-signed-release-receipt.mjs --capture <capture-dir> \
//     --request <bundle-request.json> \
//     --verification <signed-release-verification.json> \
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
  assertReceiptBinding, createEvidenceReader, evidenceHash, MAX_EVIDENCE_FILE_BYTES,
  parseEvidenceReceipt, REQUIRED_CHECKS,
} from "./decommission-evidence-bundle.mjs";
import { writeReceiptFile } from "./emit-process-inventory-receipt.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";

export const SIGNED_RELEASE_RECEIPT_VERSION = 1;
export const SIGNED_RELEASE_RECEIPT_KIND = "signed-release";
export const SIGNED_RELEASE_RECEIPT_FILE = "signed-release.receipt.json";

/** The bundle id the native app carries, and the one this receipt names. */
export const NATIVE_BUNDLE_ID = "app.botfleet.macos";

/** The checks the bundle requires for this receipt kind, in the bundle's order. */
export const SIGNED_RELEASE_CHECKS = REQUIRED_CHECKS["signed-release"];

/** A build number is twelve digits, and the previous one is not this one. */
const BUILD_PATTERN = /^\d{12}$/;

/**
 * The verification record's shape, as far as the receipt reads it.
 *
 * The record is external input, so it is parsed at the boundary rather than
 * narrowed as it is used.  The receipt needs each check's name, its exit
 * code and the artifact it points at, and a record that does not carry them
 * is refused here, where the reason can be said.
 */
const VerificationSchema = z.strictObject({
  version: z.literal(1),
  bundleId: z.literal(NATIVE_BUNDLE_ID),
  teamId: z.string().trim().min(1).max(2048),
  designatedRequirement: z.string().trim().min(1).max(2048),
  previousBuild: z.string().regex(BUILD_PATTERN),
  checks: z.array(z.strictObject({
    name: z.string().trim().min(1).max(2048),
    exitCode: z.number().int(),
    artifactPath: z.string().trim().min(1).max(2048),
  })).min(1).max(64),
});

const InstantSchema = z.iso.datetime({ offset: true }).max(64);
const NonEmptyTextSchema = z.string().trim().min(1).max(2048);
const ProvenanceSourceSchema = z.url().max(2048).refine((value) => value.startsWith("https://"));
const ProvenanceInputSchema = z.strictObject({
  by: NonEmptyTextSchema,
  at: InstantSchema,
  source: ProvenanceSourceSchema,
  record: NonEmptyTextSchema,
});

/**
 * Resolve an operator-supplied capture file path into a relative path
 * inside the capture directory.
 */
function captureRelativePath(captureRoot, targetPath, label) {
  const parsed = NonEmptyTextSchema.safeParse(targetPath);
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
 * Read one bounded, non-symlink, single-link JSON file.
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
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed during read: ${filePath}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, len));
    return JSON.parse(text);
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
 * Read a capture artifact through the bundle's own reader and require it to
 * be redacted UTF-8.
 */
function readRedactedCaptureArtifact(reader, captureRoot, filePath, label) {
  const rel = captureRelativePath(captureRoot, filePath, label);
  const bytes = reader.read(rel);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 text: ${rel}`);
  }
  if (redactSecretsInText(text) !== text) {
    throw new Error(`${label} contains unredacted credentials: ${rel}`);
  }
  return { bytes, text, reference: { path: rel, sha256: evidenceHash(bytes) } };
}

/**
 * The printable text of a refusal, on one bounded line.
 */
function printable(value) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Emit the `signed-release` receipt.
 *
 * @returns {{receipt: object, reference: object, kind: string}}
 */
export function emitSignedReleaseReceipt({
  captureDir,
  request,
  verificationPath,
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

  const rawVerification = readSafeJsonFile(verificationPath, "signed-release verification");
  const parsedVerification = VerificationSchema.safeParse(rawVerification);
  if (!parsedVerification.success) {
    const detail = parsedVerification.error.issues
      .map((issue) => `${issue.path.join(".") || "verification"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the signed-release verification does not match the expected shape: ${detail}`);
  }
  const verification = parsedVerification.data;

  // The previous build has to be a different build from the candidate: an
  // update from a build to itself proves nothing.
  if (verification.previousBuild === bundle.candidate.build) {
    throw new Error(
      `the previous build "${verification.previousBuild}" is the candidate's own build, so it cannot evidence an update`,
    );
  }

  const reader = createEvidenceReader(capture);
  const provenanceRef = readRedactedCaptureArtifact(
    reader,
    capture,
    snapshotProvenance.record,
    "provenance record",
  ).reference;

  const checks = [];
  const seen = new Set();
  for (const entry of verification.checks) {
    if (seen.has(entry.name)) {
      throw new Error(`the verification names the check "${entry.name}" more than once`);
    }
    seen.add(entry.name);
    const artifact = readRedactedCaptureArtifact(
      reader,
      capture,
      entry.artifactPath,
      `check "${entry.name}" artifact`,
    );
    checks.push({ name: entry.name, exitCode: entry.exitCode, artifact: artifact.reference });
  }

  // Every check the bundle names for this receipt kind has to be present.
  // A missing check is not a passing check, and the bundle validator would
  // refuse the packet later; saying so here names it.
  const missing = SIGNED_RELEASE_CHECKS.filter((name) => !checks.some((check) => check.name === name));
  if (missing.length > 0) {
    throw new Error(`the signed-release verification is missing the checks: ${missing.join(", ")}`);
  }

  const receipt = {
    version: SIGNED_RELEASE_RECEIPT_VERSION,
    kind: SIGNED_RELEASE_RECEIPT_KIND,
    candidate: bundle.candidate,
    mode: bundle.mode,
    hosts: bundle.hosts,
    provenance: {
      by: snapshotProvenance.by,
      at: snapshotProvenance.at,
      source: snapshotProvenance.source,
      record: provenanceRef,
    },
    data: {
      checks,
      bundleId: verification.bundleId,
      teamId: verification.teamId,
      designatedRequirement: verification.designatedRequirement,
      previousBuild: verification.previousBuild,
    },
  };

  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    assertReceiptBinding(parseEvidenceReceipt(SIGNED_RELEASE_RECEIPT_KIND, receiptBytes), bundle);
  } catch (error) {
    throw new Error(`the receipt would not match the bundle's schema, so nothing was written: ${printable(error.message)}`);
  }

  const receiptPath = join(capture, SIGNED_RELEASE_RECEIPT_FILE);
  writeReceiptFile(receiptPath, receiptBytes);
  return {
    receipt,
    reference: { path: SIGNED_RELEASE_RECEIPT_FILE, sha256: evidenceHash(receiptBytes) },
    kind: SIGNED_RELEASE_RECEIPT_KIND,
  };
}

const KNOWN_FLAGS = new Set([
  "--capture",
  "--request",
  "--verification",
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
    if (!KNOWN_FLAGS.has(flag)) {
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
  const missing = [...KNOWN_FLAGS].filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`);
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
    const requestJson = readSafeJsonFile(flags.get("--request"), "bundle request");
    const result = emitSignedReleaseReceipt({
      captureDir: flags.get("--capture"),
      request: validateBundleRequest(requestJson),
      verificationPath: flags.get("--verification"),
      provenance: {
        by: flags.get("--provenance-by"),
        at: flags.get("--provenance-at"),
        source: flags.get("--provenance-source"),
        record: flags.get("--provenance-record"),
      },
    });
    console.log(JSON.stringify({
      emitted: [SIGNED_RELEASE_RECEIPT_FILE],
      kind: result.kind,
      receipts: { [result.kind]: result.reference },
    }));
  } catch (error) {
    console.error(`emit-signed-release-receipt refused: ${printable(error.message)}`);
    process.exitCode = 2;
  }
}
