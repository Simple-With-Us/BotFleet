// Emit the `replay` receipt for the decommission evidence bundle (BF-2647).
//
// The Phase 6 decommission gate asks for `replay-parity`:  each engine's
// recorded turns must replay through the native `EngineDriver` with the same
// ordered `TurnEvent` kinds the Node harness recorded.  The bundle's `replay`
// receipt names one check per engine -- `engine:<id>`, for every id in the
// packet's own `engines` list -- and nothing in the tree produced those
// checks, so the receipt could only ever be asserted by a person.
//
// The producer of the measurement is the Swift side:  `ios/Scripts/
// EngineReplayParityProbe` replays the corpus and writes a report.  This
// script is the other half:  it reads that report and emits the receipt the
// bundle validates.
//
// The vocabulary is not this script's to pick either.  The bundle derives its
// check names from `bundle.engines`, so the receipt names its checks from the
// same list:  one `engine:<id>` per engine the packet names, in the packet's
// order.
//
// The exit codes are read out of the report, never asserted.  A receipt that
// says a check passed when the report says it failed is worse than no receipt
// at all:  the bundle validator accepts a check whose exit code is zero and
// whose artifact hashes correctly, so a hardcoded zero would turn a failed
// replay into evidence of a successful one.  So every exit code here comes
// from the artifact it names, and an engine the report does not cover earns a
// failing code rather than a passing one.
//
// An engine the packet names that no replay family drives earns the same
// failing code, because the probe cannot measure it.  The reason is in the
// report, which travels in the packet as the check's artifact.
//
// Usage:
//   node scripts/emit-replay-receipt.mjs --capture <capture-dir> \
//     --request <bundle-request.json> --report <replay-parity.json> \
//     --provenance-record <file-in-capture-dir> \
//     --provenance-source <https-url> --provenance-by <who>
import { readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evidenceRef, validateBundleRequest } from "./archive-node-store.mjs";

export const REPLAY_RECEIPT_VERSION = 1;
export const REPLAY_RECEIPT_FILE = "replay.receipt.json";

/**
 * The report's shape, as far as the receipt reads it.
 *
 * The report is the probe's own output and it is parsed at the boundary
 * rather than narrowed as it is used:  the receipt needs the engine id and
 * the verdict, and a report that does not carry them is refused here, where
 * the reason can be said, instead of being read loosely and turned into an
 * exit code.
 */
const ReplayReportSchema = z.looseObject({
  version: z.literal(1),
  requestedEngines: z.array(z.string()),
  isFullyVerified: z.boolean(),
  engines: z.array(z.looseObject({
    engineId: z.string(),
    isFullyVerified: z.boolean(),
  })),
});

/** The provenance source has to be an https URL, because the receipt says where the run came from. */
const ProvenanceSourceSchema = z.string().startsWith("https://");

/**
 * Whether the report says the engine held.
 *
 * The report is the probe's own output, and this reads the verdict out of
 * it.  An engine the report does not mention at all is NOT a pass:  it was
 * never measured, and a receipt that certified it would be certifying an
 * engine nobody replayed.
 */
export function replayVerdict(report, engineId) {
  const entry = report.engines.find((item) => item.engineId === engineId);
  return entry !== undefined && entry.isFullyVerified;
}

/**
 * Read the probe's report and refuse a report that cannot be read.
 *
 * A report that is missing or malformed is a producer failure rather than a
 * check failure:  there is no verdict to read, so no honest exit code can be
 * derived from it, and a receipt built on it would be a guess.
 */
export function readReplayReport(reportPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    throw new Error(`the replay report could not be read as JSON: ${reportPath}`);
  }
  const result = ReplayReportSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the replay report does not match the contract: ${issues}`);
  }
  return result.data;
}

/**
 * A capture directory has to be private, because the bundle's reader refuses
 * a directory other people can read.
 */
export function assertPrivateCaptureDir(captureDir) {
  const stat = statSync(captureDir);
  if (!stat.isDirectory()) throw new Error(`the capture directory is not a directory: ${captureDir}`);
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`the capture directory is not private (mode ${mode.toString(8)}): ${captureDir}`);
  }
}

/**
 * Emit the `replay` receipt.
 *
 * The candidate, mode and hosts come from the bundle request the operator
 * prepared, so the receipt is bound to the same candidate as the rest of the
 * packet and cannot disagree with the packet about which engines are in
 * scope.
 */
export function emitReplayReceipt({ captureDir, request, provenance, reportPath }) {
  const capture = resolve(captureDir);
  assertPrivateCaptureDir(capture);
  const bundle = validateBundleRequest(request);
  const source = ProvenanceSourceSchema.safeParse(provenance?.source);
  if (!source.success) {
    throw new Error("the provenance source must be an https URL");
  }
  const report = readReplayReport(reportPath);
  const reportReference = evidenceRef(capture, reportPath);

  const checks = bundle.engines.map((engine) => ({
    name: `engine:${engine}`,
    exitCode: replayVerdict(report, engine) ? 0 : 1,
    artifact: reportReference,
  }));

  const receipt = {
    version: REPLAY_RECEIPT_VERSION,
    kind: "replay",
    candidate: bundle.candidate,
    mode: bundle.mode,
    hosts: bundle.hosts,
    provenance: {
      by: provenance.by,
      at: provenance.at,
      source: provenance.source,
      record: evidenceRef(capture, provenance.record),
    },
    data: { checks },
  };

  const receiptPath = join(capture, REPLAY_RECEIPT_FILE);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  // `writeFileSync` only applies the mode when it creates the file, so the
  // mode is set again for the case where a receipt was already there.
  chmodSync(receiptPath, 0o600);
  return receipt;
}

/** A flag's value, or undefined. */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

let isEntry = false;
try {
  isEntry = resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
} catch {
  /* imported */
}

if (isEntry) {
  const args = process.argv.slice(2);
  const fail = (message) => {
    console.error(`emit-replay-receipt refused: ${message}`);
    process.exitCode = 2;
  };
  try {
    const captureDir = flagValue(args, "--capture");
    const requestPath = flagValue(args, "--request");
    const reportPath = flagValue(args, "--report");
    const provenanceRecord = flagValue(args, "--provenance-record");
    const provenanceSource = flagValue(args, "--provenance-source");
    const provenanceBy = flagValue(args, "--provenance-by");
    if (!captureDir || !requestPath || !reportPath || !provenanceRecord || !provenanceSource || !provenanceBy) {
      throw new Error("--capture, --request, --report, --provenance-record, --provenance-source and --provenance-by are required");
    }
    const request = validateBundleRequest(JSON.parse(readFileSync(requestPath, "utf8")));
    const receipt = emitReplayReceipt({
      captureDir,
      request,
      reportPath: resolve(reportPath),
      provenance: {
        by: provenanceBy,
        at: flagValue(args, "--provenance-at") ?? new Date().toISOString(),
        source: provenanceSource,
        record: provenanceRecord,
      },
    });
    console.log(JSON.stringify({
      emitted: [REPLAY_RECEIPT_FILE],
      checks: receipt.data.checks.map((check) => ({ name: check.name, exitCode: check.exitCode })),
    }));
    if (receipt.data.checks.some((check) => check.exitCode !== 0)) process.exitCode = 1;
  } catch (error) {
    fail(error.message);
  }
}
