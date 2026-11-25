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
// from the artifact it names.

// The report has to be the measurement of THIS packet's inventory.  The
// receipt's checks are named from `bundle.engines`, so a report that never
// covered an engine the packet names is not evidence about this packet:  it
// is a report about a different inventory, and it is refused rather than
// scored.  A report that covers more than the packet asks for is fine, since
// the packet may name a subset of what was measured.

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
// report, which travels in the packet as the check's artifact, and the
// contract asks for it:  a failing check that cannot say why it failed is a
// packet the operator cannot act on.  The corpus behind a measured engine is
// named for the same reason:  a verdict that does not say what was replayed
// against it is a verdict without a subject.
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

/** The longest a check name may be, which is the bundle's own text limit. */
export const CHECK_NAME_LIMIT = 2048;

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
/**
 * One engine's entry in the report.
 *
 * The probe writes more than the verdict.  For every engine it records
 * whether it could be measured at all, why it could not when it could not,
 * and the replay family whose corpus drove the run.  Those two strings are
 * what make the entry readable as evidence:  a failing check that cannot say
 * why it failed is a packet the operator cannot act on, and a verdict that
 * does not name the corpus it was measured against is a verdict without a
 * subject.  Each is optional in the report's own encoding, because the probe
 * omits the one that does not apply, so the contract asks for the right one
 * per case rather than for both.
 *
 * The family is not a list of names here.  Which engine id resolves to which
 * family is a fact of the Swift tree, derived there by the executable the
 * driver would launch, and writing that mapping down on this side would
 * create exactly the second vocabulary the runbook says must not exist.
 */
const ReplayEngineSchema = z.looseObject({
  engineId: z.string().min(1).max(2041),
  family: z.string().min(1).max(64).nullish(),
  measured: z.boolean(),
  unmeasuredReason: z.string().min(1).max(512).nullish(),
  fixtureCount: z.number().int().nonnegative(),
  passedCount: z.number().int().nonnegative(),
  isFullyVerified: z.boolean(),
});

const ReplayReportSchema = z.looseObject({
  version: z.literal(1),
  // The report is external input, so its lists are bounded:  the bundle's
  // own inventory names at most 32 engines, the probe reports one entry per
  // engine it asked about, and an unbounded list here would be walked once
  // per entry by the checks below.  An engine id is bounded so that the
  // check name the receipt writes for it, `engine:<id>`, fits the bundle's
  // own 2048-character check-name limit:  2041 characters of id plus the
  // prefix is exactly 2048.  A report naming a longer id is refused here
  // rather than producing a check name the bundle will not accept.
  requestedEngines: z.array(z.string().min(1).max(2041)).min(1).max(32),
  isFullyVerified: z.boolean(),
  engines: z.array(ReplayEngineSchema).min(1).max(32),
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
    // The probe names the family whose corpus drove a measured engine, and
    // the reason it could not measure one it did not.  One without the other
    // is a report the probe did not write, and a report the probe did not
    // write is not evidence that a replay held.
    if (entry.measured && !entry.family) {
      ctx.addIssue({
        code: "custom",
        path: [...where, "family"],
        message: `the engine "${entry.engineId}" was measured and names no family behind the run`,
      });
    }
    if (!entry.measured) {
      if (entry.family) {
        ctx.addIssue({
          code: "custom",
          path: [...where, "family"],
          message: `the engine "${entry.engineId}" was not measured and names the family "${entry.family}" anyway`,
        });
      }
      if (!entry.unmeasuredReason) {
        ctx.addIssue({
          code: "custom",
          path: [...where, "unmeasuredReason"],
          message: `the engine "${entry.engineId}" was not measured and gives no reason`,
        });
      }
    }
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
    // An engine that measured nothing did not hold:  the probe's own verdict
    // is "every fixture behind this engine passed" over a non-empty set, so
    // a fully verified engine with no fixture is a verdict the probe cannot
    // have written.
    if (entry.isFullyVerified && entry.fixtureCount === 0) {
      ctx.addIssue({
        code: "custom",
        path: where,
        message: `the engine "${entry.engineId}" says it held without measuring a fixture`,
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
 * The report has to have measured the inventory the packet names.
 *
 * The receipt's checks are named from the packet's own engine list, so a
 * report that measured a different list is not evidence about this packet:
 * every check would read a verdict out of a report that never mentions that
 * engine, and the packet would carry a receipt whose artifact is about
 * something else.  That is a refusal rather than a failing check, because a
 * report about a different inventory is not a replay that failed.
 *
 * A report that covers more than the packet asks for is fine:  the packet
 * may name a subset of what was measured, and the receipt names its checks
 * from the packet's list either way.
 */
export function assertInventoryCoverage(report, bundle) {
  const measured = new Set(report.requestedEngines);
  const missing = bundle.engines.filter((engine) => !measured.has(engine));
  if (missing.length > 0) {
    throw new Error(
      `the replay report does not cover the engine${missing.length === 1 ? "" : "s"} the packet names: ${missing.join(", ")}`,
    );
  }
}

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
  // A check name the bundle's own schema refuses is a receipt the bundle
  // will reject, so the bundle's engine id is checked against that limit
  // before anything is written.  It is checked before the report is read,
  // because it is a fact about the packet rather than about the report.
  bundle.engines.forEach((engine) => {
    const name = `engine:${engine}`;
    if (name.length > CHECK_NAME_LIMIT) {
      throw new Error(
        `the check name for the engine "${engine.slice(0, 32)}" is ${name.length} characters, which is over the bundle's check-name limit of ${CHECK_NAME_LIMIT}`,
      );
    }
  });

  const report = readReplayReport(reportPath);
  // The report has to have measured the inventory the packet names.
  assertInventoryCoverage(report, bundle);
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
