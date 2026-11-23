// Emit the `server-writer-soak` or `no-mac-node-soak` receipt for the
// decommission evidence bundle (BF-2514 / BF-2515).
//
// `scripts/check-soak-24h.mjs` observes only the start and end bookends of the
// post-retirement window, while `docs/native-rewrite-single-writer-cutover.md`
// Step 4 (`soak-24h-server-writer`) and Step 6 / BF-2515 Step 2
// (`soak-24h-no-node`) require logged, contiguous >= 24-hour coverage segments
// validated against `scripts/decommission-evidence-bundle.mjs`.
//
// This script reads an operator-supplied soak observation JSON plus cited
// segment logs from the private capture directory, validates every segment
// log as redacted UTF-8 via `createEvidenceReader` and `redactSecretsInText`,
// enforces interval contiguity, writer host constraints, shared routine run
// bounds, surface statuses, controller-epoch handoff fences, and (for
// `no-mac-node-soak`) required ordering/fence and retired-harness checks
// against the prior `server-writer-soak` receipt and `process-inventory`
// receipt, and writes the schema-verified receipt atomically with mode 0600.
//
// What this script does NOT do:  it does not contact any live daemon, host, or
// launch agent, and it cannot authenticate that externally captured log bytes
// originated from production rather than a fixture.  It verifies structural
// binding, redaction cleanliness, hashes, and internal fence consistency.
//
// Usage:
//   node scripts/emit-soak-receipt.mjs --kind <server-writer-soak|no-mac-node-soak> \
//     --capture <capture-dir> --request <bundle-request.json> \
//     --observation <soak-observation.json> \
//     --provenance-record <file-in-capture-dir> \
//     --provenance-source <https-url> --provenance-by <who> \
//     --provenance-at <iso-8601-instant> \
//     [--prior-soak <server-writer-soak.receipt.json> --process-inventory <process-inventory.receipt.json> (required for no-mac-node-soak)]

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
  parseEvidenceReceipt, REQUIRED_CHECKS, REQUIRED_SURFACES,
} from "./decommission-evidence-bundle.mjs";
import { writeReceiptFile } from "./emit-process-inventory-receipt.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";

export const SOAK_RECEIPT_VERSION = 1;
export const SOAK_RECEIPT_KINDS = ["server-writer-soak", "no-mac-node-soak"];
export const SOAK_RECEIPT_FILES = {
  "server-writer-soak": "server-writer-soak.receipt.json",
  "no-mac-node-soak": "no-mac-node-soak.receipt.json",
};

const MIN_SOAK_DURATION_MS = 24 * 60 * 60_000;

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
const SurfaceOutcomeSchema = z.enum(["passed", "failed"]);
const SurfacesInputSchema = z.strictObject(
  Object.fromEntries(REQUIRED_SURFACES.map((surface) => [surface, SurfaceOutcomeSchema])),
);

const BaseSegmentInputSchema = {
  startedAt: InstantSchema,
  endedAt: InstantSchema,
  logPath: z.string().trim().min(1).max(2048),
  continuity: z.enum(["uninterrupted", "interrupted"]),
  selectedWriterHostId: HostIdSchema,
  controllerId: HostIdSchema,
  controllerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  surfaces: SurfacesInputSchema,
};

const ServerWriterSegmentInputSchema = z.strictObject({
  ...BaseSegmentInputSchema,
  macHarness: z.enum(["loaded-unused", "active", "absent"]),
  inboundMessages: z.number().int().nonnegative(),
  serverSharedRoutineRuns: z.number().int().nonnegative(),
  macSharedRoutineRuns: z.number().int().nonnegative(),
});

const NoNodeSegmentInputSchema = z.strictObject({
  ...BaseSegmentInputSchema,
  macHarness: z.enum(["absent", "loaded-unused", "active"]),
});

const ObservationSchemas = {
  "server-writer-soak": z.strictObject({
    startedAt: InstantSchema,
    endedAt: InstantSchema,
    segments: z.array(ServerWriterSegmentInputSchema).min(1).max(64),
  }),
  "no-mac-node-soak": z.strictObject({
    startedAt: InstantSchema,
    endedAt: InstantSchema,
    segments: z.array(NoNodeSegmentInputSchema).min(1).max(64),
  }),
};

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

/** Read a capture artifact via createEvidenceReader and ensure it is redacted UTF-8. */
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
  return {
    bytes,
    text,
    reference: { path: rel, sha256: evidenceHash(bytes) },
  };
}

/** Enforce controller fence monotonicity and epoch increment across controller handoffs. */
export function assertSoakControllerFence(previous, next, context = "segment handoff") {
  if (next.controllerEpoch < previous.controllerEpoch) {
    throw new Error(
      `${context}: controllerEpoch regressed from ${previous.controllerEpoch} to ${next.controllerEpoch}`,
    );
  }
  if (next.controllerId !== previous.controllerId && next.controllerEpoch <= previous.controllerEpoch) {
    throw new Error(
      `${context}: controller handoff ${previous.controllerId} -> ${next.controllerId} did not advance controllerEpoch (${previous.controllerEpoch} -> ${next.controllerEpoch})`,
    );
  }
}

/**
 * Emit `server-writer-soak.receipt.json` or `no-mac-node-soak.receipt.json` inside `captureDir`.
 *
 * Returns `{ receipt, reference, kind, elapsedMs, segmentCount }`.
 */
export function emitSoakReceipt({
  kind,
  captureDir,
  request,
  observationPath,
  observation: inlineObservation,
  provenance,
  priorSoakPath,
  processInventoryPath,
}) {
  if (!SOAK_RECEIPT_KINDS.includes(kind)) {
    throw new Error(`unsupported soak receipt kind: ${String(kind)}`);
  }
  if (kind === "server-writer-soak" && (priorSoakPath || processInventoryPath)) {
    throw new Error("--prior-soak and --process-inventory apply only to no-mac-node-soak");
  }
  if (kind === "no-mac-node-soak" && (!priorSoakPath || !processInventoryPath)) {
    throw new Error("--prior-soak and --process-inventory are required for no-mac-node-soak");
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
      throw new Error("missing soak observation: provide observation or observationPath");
    }
    rawObservation = readSafeJsonFile(parsedObservationPath.data, "soak observation");
  }
  const parsedObservation = ObservationSchemas[kind].safeParse(rawObservation);
  if (!parsedObservation.success) {
    const detail = parsedObservation.error.issues
      .map((issue) => `${issue.path.join(".") || "observation"}: ${issue.message}`)
      .join("; ");
    throw new Error(`soak observation does not match expected schema: ${detail}`);
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
  if (elapsedMs < MIN_SOAK_DURATION_MS) {
    throw new Error(
      `${kind} interval ran ${elapsedMs}ms, short of the ${MIN_SOAK_DURATION_MS}ms (24h) minimum`,
    );
  }
  if (provMs < endMs) {
    throw new Error(`provenance.at (${snapshotProvenance.at}) predates observation.endedAt (${observation.endedAt})`);
  }

  // Cross-receipt preconditions for `no-mac-node-soak`.
  let priorTailSegment;
  if (priorSoakPath) {
    const priorArtifact = readRedactedCaptureArtifact(reader, capture, priorSoakPath, "prior soak receipt");
    const priorReceipt = parseEvidenceReceipt("server-writer-soak", priorArtifact.bytes);
    assertReceiptBinding(priorReceipt, bundle);
    if (Date.parse(priorReceipt.data.endedAt) > startMs) {
      throw new Error(
        `server-writer-soak endedAt (${priorReceipt.data.endedAt}) must precede no-mac-node-soak startedAt (${observation.startedAt})`,
      );
    }
    priorTailSegment = priorReceipt.data.segments.at(-1);
  }

  if (processInventoryPath) {
    const invArtifact = readRedactedCaptureArtifact(reader, capture, processInventoryPath, "process-inventory receipt");
    const invReceipt = parseEvidenceReceipt("process-inventory", invArtifact.bytes);
    assertReceiptBinding(invReceipt, bundle);
    if (invReceipt.data.macHarness !== "absent") {
      throw new Error("process-inventory receipt must record macHarness: \"absent\"");
    }
    if (invReceipt.data.checks.length === 0) {
      throw new Error("process-inventory receipt has no checks");
    }
    if (invReceipt.data.checks.some((entry) => entry.exitCode !== 0)) {
      throw new Error("process-inventory receipt has failing checks");
    }
    for (const checkName of REQUIRED_CHECKS["process-inventory"]) {
      if (!invReceipt.data.checks.some((entry) => entry.name === checkName && entry.exitCode === 0)) {
        throw new Error(`process-inventory receipt is missing passing check "${checkName}"`);
      }
    }
    if (Date.parse(invReceipt.provenance.at) > startMs) {
      throw new Error(
        `process-inventory provenance.at (${invReceipt.provenance.at}) must precede no-mac-node-soak startedAt (${observation.startedAt})`,
      );
    }
  }

  const hostIds = new Set(bundle.hosts.map((host) => host.id));
  const validatedSegments = [];
  let cursorMs = startMs;
  let totalServerRoutineRuns = 0;
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
    for (const surface of REQUIRED_SURFACES) {
      if (span.surfaces[surface] !== "passed") {
        throw new Error(`segment[${index}] surface "${surface}" did not pass`);
      }
    }
    if (!span.selectedWriterHostId.startsWith("server:")) {
      throw new Error(
        `segment[${index}] selectedWriterHostId "${span.selectedWriterHostId}" must be a server: host for ${kind}`,
      );
    }
    const expectedWriterHostId = priorTailSegment
      ? priorTailSegment.selectedWriterHostId
      : validatedSegments[0]?.selectedWriterHostId;
    if (expectedWriterHostId !== undefined && span.selectedWriterHostId !== expectedWriterHostId) {
      throw new Error(
        `segment[${index}] selectedWriterHostId "${span.selectedWriterHostId}" must match "${expectedWriterHostId}"`,
      );
    }

    if (previousSegment) {
      assertSoakControllerFence(previousSegment, span, `segment[${index - 1}] -> segment[${index}]`);
    } else if (priorTailSegment) {
      assertSoakControllerFence(priorTailSegment, span, "server-writer-soak -> no-mac-node-soak");
    }

    const logArtifact = readRedactedCaptureArtifact(reader, capture, span.logPath, `segment[${index}] log`);

    if (kind === "server-writer-soak") {
      if (span.macHarness !== "loaded-unused") {
        throw new Error(`segment[${index}] macHarness must be "loaded-unused", got "${span.macHarness}"`);
      }
      if (span.inboundMessages <= 0) {
        throw new Error(`segment[${index}] inboundMessages must be positive, got ${span.inboundMessages}`);
      }
      if (span.macSharedRoutineRuns !== 0) {
        throw new Error(`segment[${index}] macSharedRoutineRuns must be 0, got ${span.macSharedRoutineRuns}`);
      }
      totalServerRoutineRuns += span.serverSharedRoutineRuns;
      validatedSegments.push({
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        log: logArtifact.reference,
        continuity: span.continuity,
        selectedWriterHostId: span.selectedWriterHostId,
        controllerId: span.controllerId,
        controllerEpoch: span.controllerEpoch,
        macHarness: span.macHarness,
        surfaces: span.surfaces,
        inboundMessages: span.inboundMessages,
        serverSharedRoutineRuns: span.serverSharedRoutineRuns,
        macSharedRoutineRuns: span.macSharedRoutineRuns,
      });
    } else {
      if (span.macHarness !== "absent") {
        throw new Error(`segment[${index}] macHarness must be "absent", got "${span.macHarness}"`);
      }
      validatedSegments.push({
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        log: logArtifact.reference,
        continuity: span.continuity,
        selectedWriterHostId: span.selectedWriterHostId,
        controllerId: span.controllerId,
        controllerEpoch: span.controllerEpoch,
        macHarness: span.macHarness,
        surfaces: span.surfaces,
      });
    }

    cursorMs = spanEndMs;
    previousSegment = span;
  }

  if (cursorMs !== endMs) {
    throw new Error(`${kind} segments ended at ${new Date(cursorMs).toISOString()}, expected ${observation.endedAt}`);
  }

  if (kind === "server-writer-soak") {
    const elapsedDays = elapsedMs / MIN_SOAK_DURATION_MS;
    if (totalServerRoutineRuns < Math.floor(elapsedDays) || totalServerRoutineRuns > Math.ceil(elapsedDays)) {
      throw new Error(
        `serverSharedRoutineRuns total ${totalServerRoutineRuns} outside expected [${Math.floor(elapsedDays)}, ${Math.ceil(elapsedDays)}] for ${elapsedDays.toFixed(2)} days`,
      );
    }
  }

  const receipt = {
    version: SOAK_RECEIPT_VERSION,
    kind,
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
  parseEvidenceReceipt(kind, receiptBytes);

  const fileName = SOAK_RECEIPT_FILES[kind];
  const receiptPath = join(capture, fileName);
  writeReceiptFile(receiptPath, receiptBytes);
  const reference = { path: fileName, sha256: evidenceHash(receiptBytes) };

  return {
    receipt,
    reference,
    kind,
    elapsedMs,
    segmentCount: validatedSegments.length,
  };
}

const KNOWN_FLAGS = new Set([
  "--kind",
  "--capture",
  "--request",
  "--observation",
  "--provenance-record",
  "--provenance-source",
  "--provenance-by",
  "--provenance-at",
  "--prior-soak",
  "--process-inventory",
]);

/** Parse CLI arguments strictly: refuse unknown flags, duplicate flags, or missing values. */
export function parseCliArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`duplicate flag: ${flag}`);
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag, next);
    i += 1;
  }
  const required = [
    "--kind",
    "--capture",
    "--request",
    "--observation",
    "--provenance-record",
    "--provenance-source",
    "--provenance-by",
    "--provenance-at",
  ];
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
    const result = emitSoakReceipt({
      kind: flags.get("--kind"),
      captureDir: flags.get("--capture"),
      request: validateBundleRequest(requestJson),
      observationPath: flags.get("--observation"),
      provenance: {
        by: flags.get("--provenance-by"),
        at: flags.get("--provenance-at"),
        source: flags.get("--provenance-source"),
        record: flags.get("--provenance-record"),
      },
      priorSoakPath: flags.get("--prior-soak"),
      processInventoryPath: flags.get("--process-inventory"),
    });
    const fileName = SOAK_RECEIPT_FILES[result.kind];
    console.log(JSON.stringify({
      emitted: [fileName],
      kind: result.kind,
      elapsedMs: result.elapsedMs,
      segmentCount: result.segmentCount,
      receipts: { [result.kind]: result.reference },
    }));
  } catch (error) {
    console.error(`emit-soak-receipt refused: ${error.message}`);
    process.exitCode = 2;
  }
}
