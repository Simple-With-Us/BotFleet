/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// Emit the `daily-driver` receipt for the decommission evidence bundle (BF-2692).
//
// The Phase 6 decommission gate's final bundle carries a `daily-driver`
// receipt, and `docs/verification/native-final-evidence.md` says what it has
// to hold:  a separate seven-day observation of signed native daily use, with
// an iOS session, Open on Mac and the process inventory observed, covered end
// to end by logged segments that run without a gap.  The seven-day sign-off
// itself is the owner's, under the Electron inventory's existing rule.
// Nothing in the tree produced that receipt, so it could only be written by
// hand.
//
// This script reads an operator-supplied observation JSON plus cited
// segment logs from the private capture directory, validates every segment
// log as redacted UTF-8 via `createEvidenceReader` and `redactSecretsInText`,
// enforces interval contiguity, the seven-day minimum, host binding,
// controller-epoch handoff fences and the four observations a segment has to
// record, and writes the schema-verified receipt atomically with mode 0600.
//
// The interval rules are the soak producer's (`scripts/emit-soak-receipt.mjs`),
// and the controller fence is that script's own function.  The writer rules
// are not.  A soak is about the server being the single writer, so its
// segments have to name a `server:` host, carry the functional surfaces and
// stay inside the shared routine run bounds.  A local-only native Mac
// controller does not need server traffic or zero Mac routine runs to satisfy
// daily use, so none of that is read here:  the selected writer may be either
// host the packet names, and it is one host for the whole observation.
//
// What this script does NOT do:  it does not contact any live daemon, host, or
// launch agent, and it cannot authenticate that externally captured log bytes
// originated from production rather than a fixture, or that whoever wrote an
// observation watched it happen.  It verifies structural binding, redaction
// cleanliness, hashes, and internal fence consistency.
//
// Usage:
//   node scripts/emit-daily-driver-receipt.mjs --capture <capture-dir> \
//     --request <bundle-request.json> \
//     --observation <daily-driver-observation.json> \
//     --provenance-record <file-in-capture-dir> \
//     --provenance-source <https-url> --provenance-by <who> \
//     --provenance-at <iso-8601-instant>

import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HOST_ID_PATTERN } from "../shared/placement.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { validateBundleRequest } from "./archive-node-store.mjs";
import {
  assertReceiptBinding, createEvidenceReader, evidenceHash, MAX_EVIDENCE_FILE_BYTES,
  parseEvidenceReceipt,
} from "./decommission-evidence-bundle.mjs";
import { writeReceiptFile } from "./emit-process-inventory-receipt.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";
import { assertSoakControllerFence } from "./emit-soak-receipt.mjs";

export const DAILY_DRIVER_RECEIPT_VERSION = 1;
export const DAILY_DRIVER_RECEIPT_KIND = "daily-driver";
export const DAILY_DRIVER_RECEIPT_FILE = "daily-driver.receipt.json";

/** The shortest observation the bundle accepts for the daily driver: seven whole days. */
export const MIN_DAILY_DRIVER_DURATION_MS = 7 * 24 * 60 * 60_000;

/**
 * The four observations a segment has to record, in the bundle's own words.
 * The receipt writes these values and no others, so a segment is emitted
 * only when the observation JSON records all four.
 */
export const DAILY_DRIVER_OBSERVATIONS = {
  nativeApp: "signed-native-daily-driver",
  iosSession: "passed",
  openOnMac: "passed",
  processInventory: "recorded",
};

const InstantSchema = z.iso.datetime({ offset: true }).max(64);
const NonEmptyTextSchema = z.string().trim().min(1).max(2048);
const ProvenanceSourceSchema = z.url().max(2048).refine((value) => value.startsWith("https://"));
const ProvenanceInputSchema = z.strictObject({
  by: NonEmptyTextSchema,
  at: InstantSchema,
  source: ProvenanceSourceSchema,
  record: NonEmptyTextSchema,
});
const HostIdSchema = z.string().max(256).regex(HOST_ID_PATTERN);

/**
 * One segment as the observation JSON records it.
 *
 * Each observation is an enum whose first value is the one the receipt
 * requires, so a segment that did not hold is refused with the value that was
 * seen rather than with a schema error about a literal.
 */
const DailyDriverSegmentInputSchema = z.strictObject({
  startedAt: InstantSchema,
  endedAt: InstantSchema,
  logPath: z.string().trim().min(1).max(2048),
  continuity: z.enum(["uninterrupted", "interrupted"]),
  selectedWriterHostId: HostIdSchema,
  controllerId: HostIdSchema,
  controllerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nativeApp: z.enum(["signed-native-daily-driver", "unsigned-native-build", "electron-shell"]),
  iosSession: z.enum(["passed", "failed"]),
  openOnMac: z.enum(["passed", "failed"]),
  processInventory: z.enum(["recorded", "not-recorded"]),
});

const DailyDriverObservationSchema = z.strictObject({
  startedAt: InstantSchema,
  endedAt: InstantSchema,
  segments: z.array(DailyDriverSegmentInputSchema).min(1).max(64),
});

/** Resolve an operator-supplied capture file path into a relative path inside captureDir. */
function captureRelativePath(captureRoot, targetPath, label) {
  const parsedPath = NonEmptyTextSchema.safeParse(targetPath);
  if (!parsedPath.success) throw new Error(`missing ${label} path`);
  const raw = parsedPath.data;
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

/** Read one bounded, non-symlink, single-link JSON file (e.g. request or observation). */
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
      || listedAfter.dev !== after.dev
      || listedAfter.ino !== after.ino
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
      throw new Error(`${label} must not be a symbolic link: ${filePath}`, { cause: error });
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

/**
 * Say why the bundle's reader refused a file, next to the reader's own code.
 * The code is what a test or a log grep can hold on to;  the words are for
 * the operator.
 */
function readerRefusal(error) {
  switch (error?.message) {
    case "malformed-schema":
      return "its path has characters the bundle's reader does not accept, which are letters, digits, dots, dashes, underscores and slashes";
    case "evidence-path-not-private":
      return "it is a symbolic link, or it or a folder above it is not owner-only";
    case "evidence-path-link":
      return "it is reached through a link";
    case "evidence-not-single-link-file":
      return "it is not a plain file with a single name";
    case "evidence-file-too-large":
      return `it is over the bundle's file limit of ${MAX_EVIDENCE_FILE_BYTES} bytes`;
    case "evidence-file-changed":
    case "bundle-directory-changed":
      return "it changed while it was being read";
    case "too-many-evidence-files":
      return "the capture directory holds more files than the bundle reads";
    case "evidence-bundle-too-large":
      return "the capture directory holds more bytes than the bundle reads";
    default:
      return error?.code === "ENOENT" ? "it is missing" : "it could not be read";
  }
}

/** Read a capture artifact via createEvidenceReader and ensure it is redacted UTF-8. */
function readRedactedCaptureArtifact(reader, captureRoot, filePath, label) {
  const rel = captureRelativePath(captureRoot, filePath, label);
  let bytes;
  try {
    bytes = reader.read(rel);
  } catch (error) {
    const code = error?.message === "malformed-schema" || String(error?.message ?? "").startsWith("evidence-")
      || String(error?.message ?? "").startsWith("bundle-") || error?.message === "too-many-evidence-files"
      ? error.message
      : error?.code ?? "unreadable";
    throw new Error(`${label} is not a file the bundle will read (${code}: ${readerRefusal(error)}): ${rel}`, { cause: error });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 text: ${rel}`);
  }
  if (redactSecretsInText(text) !== text) {
    throw new Error(`${label} contains unredacted credentials: ${rel}`);
  }
  return {
    bytes,
    text,
    reference: { path: rel, sha256: evidenceHash(bytes) },
  };
}

/**
 * Text quoted in a refusal, with every control and line-separator character
 * written as its code point.
 *
 * A refusal quotes what it refused, and that is not this script's text:  a
 * path, a host id, a value out of the observation JSON.  Printed as it
 * stands, a newline in it would forge a line in a captured log.
 */
function printable(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
}

/**
 * Emit `daily-driver.receipt.json` inside `captureDir`.
 *
 * Returns `{ receipt, reference, kind, elapsedMs, segmentCount }`.
 */
export function emitDailyDriverReceipt({
  kind,
  captureDir,
  request,
  observationPath,
  observation: inlineObservation,
  provenance,
}) {
  if (kind !== undefined && kind !== DAILY_DRIVER_RECEIPT_KIND) {
    throw new Error(`unsupported receipt kind: ${String(kind)}`);
  }
  const parsedCaptureDir = NonEmptyTextSchema.safeParse(captureDir);
  if (!parsedCaptureDir.success) {
    throw new Error("missing captureDir");
  }
  const capture = realpathSync(resolve(parsedCaptureDir.data));
  assertPrivateCaptureDir(capture);
  const bundle = validateBundleRequest(request);

  const parsedProvenance = ProvenanceInputSchema.safeParse(provenance);
  if (!parsedProvenance.success) {
    if (parsedProvenance.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
      throw new Error("the provenance object contains unrecognized fields");
    }
    const fields = new Set(parsedProvenance.error.issues.map((issue) => String(issue.path[0] ?? "")));
    if (fields.has("source")) throw new Error("the provenance source must be an https URL");
    if (fields.has("at")) throw new Error("the provenance instant must be an ISO 8601 date and time with an offset");
    throw new Error("the provenance --provenance-by and --provenance-record values must be non-empty");
  }
  const snapshotProvenance = parsedProvenance.data;

  let rawObservation;
  if (inlineObservation !== undefined) {
    rawObservation = inlineObservation;
  } else {
    const parsedObservationPath = NonEmptyTextSchema.safeParse(observationPath);
    if (!parsedObservationPath.success) {
      throw new Error("missing daily-driver observation: provide observation or observationPath");
    }
    rawObservation = readSafeJsonFile(parsedObservationPath.data, "daily-driver observation");
  }
  const parsedObservation = DailyDriverObservationSchema.safeParse(rawObservation);
  if (!parsedObservation.success) {
    const detail = parsedObservation.error.issues
      .map((issue) => `${issue.path.join(".") || "observation"}: ${issue.message}`)
      .join("; ");
    throw new Error(`daily-driver observation does not match expected schema: ${detail}`);
  }
  const observation = parsedObservation.data;

  const reader = createEvidenceReader(capture);
  const provenanceRef = readRedactedCaptureArtifact(
    reader,
    capture,
    snapshotProvenance.record,
    "provenance record",
  ).reference;

  const startMs = Date.parse(observation.startedAt);
  const endMs = Date.parse(observation.endedAt);
  const provMs = Date.parse(snapshotProvenance.at);
  const elapsedMs = endMs - startMs;
  if (elapsedMs < MIN_DAILY_DRIVER_DURATION_MS) {
    throw new Error(
      `daily-driver interval ran ${elapsedMs}ms, short of the ${MIN_DAILY_DRIVER_DURATION_MS}ms (7d) minimum`,
    );
  }
  if (provMs < endMs) {
    throw new Error(`provenance.at (${snapshotProvenance.at}) predates observation.endedAt (${observation.endedAt})`);
  }

  const hostIds = new Set(bundle.hosts.map((host) => host.id));
  const validatedSegments = [];
  let cursorMs = startMs;
  let previousSegment;

  for (let index = 0; index < observation.segments.length; index += 1) {
    const span = observation.segments[index];
    const spanStartMs = Date.parse(span.startedAt);
    const spanEndMs = Date.parse(span.endedAt);

    if (spanStartMs !== cursorMs || spanEndMs <= cursorMs || spanEndMs > endMs) {
      throw new Error(`segment[${index}] has coverage gap or overlap (${span.startedAt}..${span.endedAt})`);
    }
    if (span.continuity !== "uninterrupted") {
      throw new Error(`segment[${index}] continuity is "${span.continuity}", expected "uninterrupted"`);
    }
    if (!hostIds.has(span.selectedWriterHostId)) {
      throw new Error(`segment[${index}] selectedWriterHostId "${span.selectedWriterHostId}" is not in bundle hosts`);
    }
    if (!hostIds.has(span.controllerId)) {
      throw new Error(`segment[${index}] controllerId "${span.controllerId}" is not in bundle hosts`);
    }
    // One observation follows one writer.  The soak producer holds its
    // segments to the same writer, and a receipt bound to one packet mode
    // cannot describe seven days that changed hands halfway through.
    const expectedWriterHostId = validatedSegments[0]?.selectedWriterHostId;
    if (expectedWriterHostId !== undefined && span.selectedWriterHostId !== expectedWriterHostId) {
      throw new Error(
        `segment[${index}] selectedWriterHostId "${span.selectedWriterHostId}" must match "${expectedWriterHostId}"`,
      );
    }

    if (previousSegment) {
      assertSoakControllerFence(previousSegment, span, `segment[${index - 1}] -> segment[${index}]`);
    }

    const logArtifact = readRedactedCaptureArtifact(reader, capture, span.logPath, `segment[${index}] log`);

    // One log covers one segment.  The same file named twice would let one
    // capture stand in for every interval, so a path that is already on a
    // validated segment is a refusal rather than a second citation.
    if (validatedSegments.some((segment) => segment.log.path === logArtifact.reference.path)) {
      throw new Error(`segment[${index}] log "${printable(span.logPath)}" is already cited by an earlier segment`);
    }

    for (const [field, expected] of Object.entries(DAILY_DRIVER_OBSERVATIONS)) {
      if (span[field] !== expected) {
        throw new Error(`segment[${index}] ${field} is "${span[field]}", expected "${expected}"`);
      }
    }
    validatedSegments.push({
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      log: logArtifact.reference,
      continuity: span.continuity,
      selectedWriterHostId: span.selectedWriterHostId,
      controllerId: span.controllerId,
      controllerEpoch: span.controllerEpoch,
      ...DAILY_DRIVER_OBSERVATIONS,
    });

    cursorMs = spanEndMs;
    previousSegment = span;
  }

  if (cursorMs !== endMs) {
    throw new Error(`daily-driver segments ended at ${new Date(cursorMs).toISOString()}, expected ${observation.endedAt}`);
  }

  const receipt = {
    version: DAILY_DRIVER_RECEIPT_VERSION,
    kind: DAILY_DRIVER_RECEIPT_KIND,
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
      startedAt: observation.startedAt,
      endedAt: observation.endedAt,
      segments: validatedSegments,
    },
  };

  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    assertReceiptBinding(parseEvidenceReceipt(DAILY_DRIVER_RECEIPT_KIND, receiptBytes), bundle);
  } catch (error) {
    throw new Error(`the receipt would not match the bundle's schema, so nothing was written: ${printable(error.message)}`);
  }

  const fileName = DAILY_DRIVER_RECEIPT_FILE;
  const receiptPath = join(capture, fileName);
  writeReceiptFile(receiptPath, receiptBytes);
  const reference = { path: fileName, sha256: evidenceHash(receiptBytes) };

  return {
    receipt,
    reference,
    kind: DAILY_DRIVER_RECEIPT_KIND,
    elapsedMs,
    segmentCount: validatedSegments.length,
  };
}

const KNOWN_FLAGS = new Set([
  "--capture",
  "--request",
  "--observation",
  "--provenance-record",
  "--provenance-source",
  "--provenance-by",
  "--provenance-at",
]);

/** Parse CLI arguments strictly: refuse unknown flags, duplicate flags, or missing values. */
export function parseCliArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    // A programmatic caller can hand over anything;  a non-string entry is
    // the documented refusal, not a TypeError from a method the value does
    // not have.
    const flag = String(args[i] ?? "");
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`unknown argument: ${printable(flag)}`);
    }
    if (values.has(flag)) {
      throw new Error(`duplicate flag: ${printable(flag)}`);
    }
    const rawNext = args[i + 1];
    const next = rawNext === undefined || rawNext === null ? "" : String(rawNext);
    if (next === "" || next.startsWith("--")) {
      throw new Error(`missing value for ${printable(flag)}`);
    }
    values.set(flag, next);
    i += 1;
  }
  const required = [...KNOWN_FLAGS];
  const missing = required.filter((flag) => !values.has(flag));
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
    const result = emitDailyDriverReceipt({
      captureDir: flags.get("--capture"),
      request: validateBundleRequest(requestJson),
      observationPath: flags.get("--observation"),
      provenance: {
        by: flags.get("--provenance-by"),
        at: flags.get("--provenance-at"),
        source: flags.get("--provenance-source"),
        record: flags.get("--provenance-record"),
      },
    });
    console.log(JSON.stringify({
      emitted: [DAILY_DRIVER_RECEIPT_FILE],
      kind: result.kind,
      elapsedMs: result.elapsedMs,
      segmentCount: result.segmentCount,
      receipts: { [result.kind]: result.reference },
    }));
  } catch (error) {
    console.error(`emit-daily-driver-receipt refused: ${printable(error.message)}`);
    process.exitCode = 2;
  }
}
