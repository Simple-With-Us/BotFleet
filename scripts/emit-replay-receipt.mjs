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

// The report's summary is checked against the report's own details.  The probe
// computes that summary as "every engine the packet named was measured and
// held", so a report whose summary says one thing and whose per-engine
// verdicts say another did not come from the probe, and a report that did not
// come from the probe is not evidence that a replay held.  An engine's own
// counts are checked the same way:  a verdict that claims more fixtures
// passed than were run is refused rather than read as a pass.
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
import { readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
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
 *
 * The report's summary is checked against its own details here as well.  The
 * probe computes the summary as "every engine held", so a report whose
 * summary says one thing and whose per-engine verdicts say another is not a
 * report the probe wrote, and a report that was not written by the probe is
 * not evidence of a replay.  The same goes for an engine's own counts:  a
 * verdict that claims more fixtures passed than were run is refused rather
 * than read as a pass.
 */
const ReplayReportSchema = z.looseObject({
  version: z.literal(1),
  requestedEngines: z.array(z.string().min(1)).min(1),
  isFullyVerified: z.boolean(),
  engines: z.array(z.looseObject({
    engineId: z.string().min(1),
    measured: z.boolean(),
    fixtureCount: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    isFullyVerified: z.boolean(),
  })).min(1),
}).superRefine((report, ctx) => {
  // One engine id, one verdict.  The verdict is read by first match, so a
  // report that names the same engine twice could hide a failing verdict
  // behind a passing one, and the receipt would certify a replay that did
  // not hold.  The report is refused here instead.
  const seen = new Set();
  report.engines.forEach((entry, index) => {
    if (seen.has(entry.engineId)) {
      ctx.addIssue({
        code: "custom",
        path: ["engines", index, "engineId"],
        message: `the report names the engine "${entry.engineId}" more than once`,
      });
    }
    seen.add(entry.engineId);
  });

  // The same engine asked for twice is the same problem in the request
  // list:  the probe names one verdict per engine it asked about, so two
  // requests for one engine mean the report and the request disagree.
  const requested = new Set();
  report.requestedEngines.forEach((engineId, index) => {
    if (requested.has(engineId)) {
      ctx.addIssue({
        code: "custom",
        path: ["requestedEngines", index],
        message: `the report asks for the engine "${engineId}" more than once`,
      });
    }
    requested.add(engineId);
  });

  // The engines the report carries and the engines it says it asked for are
  // the same list.  An engine it asked for and carries no verdict for was
  // never replayed, and an engine it carries a verdict for it never asked
  // for is not part of this packet's inventory.
  report.requestedEngines.forEach((engineId, index) => {
    if (!seen.has(engineId)) {
      ctx.addIssue({
        code: "custom",
        path: ["requestedEngines", index],
        message: `the report asks for the engine "${engineId}" and carries no verdict for it`,
      });
    }
  });
  report.engines.forEach((entry, index) => {
    if (!requested.has(entry.engineId)) {
      ctx.addIssue({
        code: "custom",
        path: ["engines", index, "engineId"],
        message: `the report carries a verdict for the engine "${entry.engineId}" it did not ask for`,
      });
    }
  });

  // An engine's verdict has to agree with what it measured.
  report.engines.forEach((entry, index) => {
    const where = ["engines", index];
    if (entry.passedCount > entry.fixtureCount) {
      ctx.addIssue({
        code: "custom",
        path: where,
        message: `the engine "${entry.engineId}" passes ${entry.passedCount} of ${entry.fixtureCount} fixtures`,
      });
    }
    if (!entry.measured && (entry.fixtureCount > 0 || entry.passedCount > 0)) {
      ctx.addIssue({
        code: "custom",
        path: where,
        message: `the engine "${entry.engineId}" was not measured but carries ${entry.fixtureCount} fixture(s)`,
      });
    }
    if (entry.isFullyVerified && !entry.measured) {
      ctx.addIssue({
        code: "custom",
        path: where,
        message: `the engine "${entry.engineId}" says it held while it was not measured`,
      });
    }
    if (entry.isFullyVerified && entry.passedCount !== entry.fixtureCount) {
      ctx.addIssue({
        code: "custom",
        path: where,
        message: `the engine "${entry.engineId}" says it held while ${entry.passedCount} of ${entry.fixtureCount} fixtures passed`,
      });
    }
  });

  // And the summary has to agree with the verdicts it summarizes.
  const held = report.engines.filter((entry) => entry.isFullyVerified).length;
  if (report.isFullyVerified && held !== report.engines.length) {
    const failing = report.engines.find((entry) => !entry.isFullyVerified);
    ctx.addIssue({
      code: "custom",
      path: ["isFullyVerified"],
      message: `the report says every engine held and the engine "${failing.engineId}" did not`,
    });
  }
  if (!report.isFullyVerified && held === report.engines.length) {
    ctx.addIssue({
      code: "custom",
      path: ["isFullyVerified"],
      message: "the report says an engine did not hold and every engine it names held",
    });
  }
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
  const matches = report.engines.filter((item) => item.engineId === engineId);
  // Exactly one verdict, or none.  Two verdicts for one engine are refused
  // by the schema, so a second match here means the report never went
  // through the boundary, and a verdict that is ambiguous is not a pass.
  if (matches.length !== 1) return false;
  return matches[0].isFullyVerified === true;
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
  // `realpathSync`, not `resolve`:  Node's ESM loader resolves symlinks for
  // `import.meta.url` and leaves `process.argv[1]` as it was typed, so a
  // script invoked through a symlink would otherwise look like an import and
  // quietly do nothing.
  isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
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
