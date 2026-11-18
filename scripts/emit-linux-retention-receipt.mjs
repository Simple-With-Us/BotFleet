// Emit the `linux-retention` receipt for the decommission evidence bundle (BF-2633).
//
// The Phase 6 decommission gate asks for `linux-server-preservation`:  the
// Linux deployment has to keep building, starting, updating and rolling back
// from the source that survives the Mac-side deletion.  The bundle's
// `linux-retention` receipt names four checks for that -- `clean-export-build`,
// `install-start`, `update` and `rollback` -- beside the maintained and the
// rollback source SHA and a hashed closure manifest, and nothing in the tree
// produced that receipt, so it could only ever be written by hand.
//
// The producer of the measurement is `deploy/linux-server/retained-fixture.mjs`
// (driven by `retained-actual-run.mjs --execute`):  it materializes a known
// prior source and a candidate source, installs, builds, starts and checks the
// prior, does the same for the candidate, and rehearses the rollback to the
// prior.  It writes `actual-source-runtime-result.json`.  This script is the
// other half:  it reads that result and the two closure receipts the run was
// made from, and emits the receipt the bundle validates.
//
// The vocabulary is not this script's to pick.  The check names come from the
// bundle's own `REQUIRED_CHECKS`, and the step names, the step evidence and
// the proof label come from the fixture that wrote the trace.
//
// The exit codes are read out of the trace, never asserted.  The fixture
// records a step only when its adapter returned success, and it writes its
// steps in one fixed order, so each check is read from the position the
// fixture writes it at.  A step that is missing, or that sits where the
// fixture could not have written it, earns a failing code rather than a
// passing one, and so does a run that left a fixture process behind.
//
// The result's summary is checked against the result's own trace.  The fixture
// sets `candidateHealthy` and `rollbackHealthy` from the same calls that write
// the health steps, so a result whose summary says one thing and whose trace
// says another did not come from the fixture, and it is refused rather than
// read.  The trace is checked against the closure receipts the same way:  a
// step that ran a source other than the one its slot's receipt names is a
// result from a different run.
//
// What this receipt is not:  it cannot authenticate the run.  A result from
// the toy adapters in the fixture's own tests has the same shape as a result
// from the actual adapters, so the receipt says only that the result it names
// is internally consistent and what that result records.  It never asserts
// `linux-server-preservation`;  that stays a human assertion in the gate
// state.
//
// Usage:
//   node scripts/emit-linux-retention-receipt.mjs --capture <capture-dir> \
//     --request <bundle-request.json> \
//     --result <actual-source-runtime-result.json> \
//     --candidate-closure <candidate-closure-receipt.json> \
//     --prior-closure <prior-closure-receipt.json> \
//     --provenance-record <file-in-capture-dir> \
//     --provenance-source <https-url> --provenance-by <who> \
//     [--provenance-at <iso-8601-instant>]
//
// Every argument is one of those flags, given once and followed by its value.
// Anything else on the command line is refused, so a flag that lost its value
// or was misspelled never falls back to a default.
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { evidenceSchema, FIXTURE_ACTIONS, linuxFixturePlan } from "../deploy/linux-server/retained-fixture.mjs";
import { evidenceRef, validateBundleRequest } from "./archive-node-store.mjs";
import {
  assertReceiptBinding, createEvidenceReader, evidenceHash, MAX_EVIDENCE_FILE_BYTES, parseEvidenceReceipt, REQUIRED_CHECKS,
} from "./decommission-evidence-bundle.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";
import { ClosureReceiptSchema } from "./linux-retained-source.mjs";

export const LINUX_RETENTION_RECEIPT_VERSION = 1;
export const LINUX_RETENTION_RECEIPT_FILE = "linux-retention.receipt.json";

/** The two sources a run compares:  the known prior and the candidate. */
export const RETENTION_SLOTS = ["prior", "candidate"];

/**
 * What the fixture says about preservation after an executed run.
 *
 * The fixture never claims preservation, and a result that claims anything
 * else was not written by it.  The receipt carries no preservation field at
 * all, so this is the only place the claim could have entered.
 */
export const RETENTION_PRESERVATION = "external-runtime-acceptance-still-required";

const sourceSha = z.string().regex(/^[0-9a-f]{40}$/);

/** A step the fixture records after its adapter returned success. */
const completedStep = z.strictObject({
  action: z.enum(FIXTURE_ACTIONS),
  slot: z.enum(RETENTION_SLOTS),
  sourceSha,
  evidence: evidenceSchema,
});

/** The marker the fixture writes when a phase before the rollback did not complete. */
const candidateRefused = z.strictObject({
  action: z.literal("candidate-refused"),
  reason: z.string().min(1).max(512),
});

/** The marker the fixture writes when the rollback's start or health did not complete. */
const rollbackRefused = z.strictObject({ action: z.literal("rollback-refused") });

/**
 * The result's shape, exactly as the fixture writes it.
 *
 * The result is external input, so it is parsed at the boundary and it is
 * parsed strictly:  the fixture writes these seven fields and no others, and
 * a result carrying a field this script does not read is a result this script
 * cannot vouch for.  The lists are bounded too, well above anything the
 * fixture writes:  one run is its ten main steps, its three rollback steps
 * and at most a marker or a retried stop beside them.
 *
 * `executed` has to be true.  A plan carries the same proof label and none
 * of the observations, so it is refused by name before it can be read as a
 * run in which every step is missing.
 */
export const RetainedRunResultSchema = z.strictObject({
  executed: z.literal(true),
  proof: z.string().min(1).max(128),
  candidateHealthy: z.boolean(),
  rollbackHealthy: z.boolean(),
  cleanupFailures: z.array(z.enum([...RETENTION_SLOTS, "adapter-processes"])).max(8),
  preservation: z.literal(RETENTION_PRESERVATION),
  trace: z.array(z.union([completedStep, candidateRefused, rollbackRefused])).max(32),
}).superRefine((result, ctx) => {
  const count = (action, slot) => result.trace
    .filter((step) => step.action === action && step.slot === slot).length;

  // A step's own observation of the source has to be the source the step ran.
  // The fixture refuses the step otherwise, so a trace that carries the
  // disagreement was not written by it.
  result.trace.forEach((step, index) => {
    if (step.evidence?.sourceSha !== undefined && step.evidence.sourceSha !== step.sourceSha) {
      ctx.addIssue({
        code: "custom",
        path: ["trace", index, "evidence", "sourceSha"],
        message: `the ${step.slot} ${step.action} step observed a source other than the one it ran`,
      });
    }
  });

  // The fixture sets `candidateHealthy` in the same statement that records
  // the candidate's health step, so the two cannot disagree.
  const candidateHealth = count("health", "candidate");
  if (result.candidateHealthy && candidateHealth === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["candidateHealthy"],
      message: "the result says the candidate was healthy and the trace carries no candidate health step",
    });
  }
  if (!result.candidateHealthy && candidateHealth > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["candidateHealthy"],
      message: "the result says the candidate was not healthy and the trace carries a candidate health step",
    });
  }

  // The prior is checked twice:  once before the candidate and once as the
  // rollback.  The fixture sets `rollbackHealthy` when the second check is
  // recorded and at no other time.
  const priorHealth = count("health", "prior");
  if (result.rollbackHealthy && priorHealth < 2) {
    ctx.addIssue({
      code: "custom",
      path: ["rollbackHealthy"],
      message: "the result says the rollback was healthy and the trace carries no second prior health step",
    });
  }
  if (!result.rollbackHealthy && priorHealth >= 2) {
    ctx.addIssue({
      code: "custom",
      path: ["rollbackHealthy"],
      message: "the result says the rollback was not healthy and the trace carries a second prior health step",
    });
  }
  if (result.rollbackHealthy && result.trace.some((step) => step.action === "rollback-refused")) {
    ctx.addIssue({
      code: "custom",
      path: ["rollbackHealthy"],
      message: "the result says the rollback was healthy and the trace says the rollback was refused",
    });
  }
});

/** The provenance source has to be an https URL, because the receipt says where the run came from. */
const ProvenanceSourceSchema = z.string().startsWith("https://");

/** The most of a failed parse's issues that a refusal repeats. */
const MAX_ISSUE_TEXT = 2000;

/** The most of one refusal that reaches the terminal. */
const MAX_REFUSAL_TEXT = 4000;

/**
 * Text that came from a file or from the command line, made safe to print.
 *
 * A refusal quotes what it refused, and what it refused is not this script's
 * text:  a result's proof label, the name of a field the fixture does not
 * write, a path.  Printed as it stands, a control character in it would reach
 * the operator's terminal or forge a line in a captured log.  So every
 * control, format and line-separator character is written as its code point,
 * and the text is cut at a limit, because a field name may be as long as the
 * file it came from.
 */
function printable(text, limit) {
  // A backslash is written as two first, so the escape form of a control
  // character can only have come from this function:  file text that spells
  // out `\u{1b}` is printed as `\\u{1b}`, and a real ESC as `\u{1b}`.
  return bounded(escapeControls(text.replace(/\\/gu, "\\\\")), limit);
}

/** Every control, format and line-separator character written as its code point. */
function escapeControls(text) {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16)}}`,
  );
}

function bounded(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** The most of a path, or of an error that quotes one, that a refusal repeats. */
const MAX_PATH_TEXT = 1024;

/** A path, or an error's text, as it is quoted in a refusal. */
function shown(text) {
  return printable(String(text), MAX_PATH_TEXT);
}

/** The issues of a failed parse, as one bounded line. */
function issueText(error, root) {
  const text = error.issues
    .map((issue) => `${issue.path.join(".") || root}: ${issue.message}`)
    .join("; ");
  return printable(text, MAX_ISSUE_TEXT);
}

/**
 * Read the fixture's result out of bytes already hashed, and refuse a result
 * that cannot be read.
 *
 * A result that is malformed is a producer failure rather than a check
 * failure:  there is no trace to read, so no honest exit code can be derived
 * from it, and a receipt built on it would be a guess.
 */
export function parseRetainedRunResult(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the retained-run result could not be read as JSON");
  }
  if (parsed?.executed === false) {
    throw new Error("the retained-run result is a plan and not an executed run, so it is evidence of no check");
  }
  const result = RetainedRunResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`the retained-run result does not match the contract: ${issueText(result.error, "result")}`);
  }
  return result.data;
}

/** Where the fixture writes the candidate's start, once the candidate is built. */
const CANDIDATE_START = 7;

/**
 * The candidate's run as the fixture wrote it when the candidate held:  it
 * started, was healthy and stopped, with nothing between those steps.
 */
const CANDIDATE_HELD = ["start", "health", "stop"];

/**
 * Every way the fixture can write a built candidate's run and still leave it
 * confirmed stopped, from the candidate's start on.
 *
 * The fixture stops the candidate whether or not its health step held, writes
 * its one refusal marker when a step failed, and stops a candidate it could
 * not stop the first time once more.  These are all the orders that produces,
 * and no order begins another, so a trace matches at most one.  A trace that
 * carries any other step here (a second start, a prior step while the
 * candidate was still up) is not one the fixture wrote, and it matches none.
 */
const CANDIDATE_RUNS = [
  CANDIDATE_HELD,
  // The first stop failed and the second was confirmed.
  ["start", "health", "candidate-refused", "stop"],
  // The health step failed and the stop was confirmed.
  ["start", "stop", "candidate-refused"],
  // The health step and the first stop failed and the second stop was confirmed.
  ["start", "candidate-refused", "stop"],
  // The start failed and the stop was confirmed.
  ["candidate-refused", "stop"],
];

/**
 * Whether the result's trace shows each check held.
 *
 * The fixture writes its successful steps in one order and stops its main
 * sequence at the first step that fails:
 *
 *   0 install prior      5 install candidate
 *   1 build prior        6 build candidate
 *   2 start prior        7 start candidate
 *   3 health prior       8 health candidate
 *   4 stop prior         9 stop candidate
 *
 * and then, once every fixture process is confirmed stopped, the rollback:
 * start prior, health prior, stop prior.  So a check is read from the
 * positions the fixture writes its steps at, and a step found anywhere else
 * is not that step.
 *
 * - `clean-export-build`:  both slots installed their dependencies and built
 *   the UI.  The fixture materializes both sources before its first step, so
 *   a trace that reaches the prior's install had both materialized.
 * - `install-start`:  the prior was installed, built, started and healthy,
 *   before any candidate step.
 * - `update`:  the prior was then stopped, and the candidate was installed,
 *   built, started, healthy and stopped, with nothing between those steps
 *   and no phase refused.
 * - `rollback`:  directly after the candidate's run ended with the candidate
 *   confirmed stopped, the prior started again, was healthy and stopped, as
 *   the last thing the run did, with no rollback refused and no fixture
 *   process left behind.
 *
 * A cleanup failure fails `rollback`.  The fixture joins its cleanup before
 * the rollback may start, and a rollback whose own stop was not confirmed did
 * not end with one known writer.
 */
export function retentionVerdicts(result) {
  const { trace } = result;
  const at = (index, action, slot) => {
    const step = trace[index];
    return step !== undefined && step.action === action && step.slot === slot;
  };
  const marked = (action) => trace.some((step) => step.action === action);

  const priorBuilt = at(0, "installDependencies", "prior") && at(1, "buildUi", "prior");
  const priorHealthy = priorBuilt && at(2, "start", "prior") && at(3, "health", "prior");
  const priorStopped = priorHealthy && at(4, "stop", "prior");
  const candidateBuilt = priorStopped && at(5, "installDependencies", "candidate") && at(6, "buildUi", "candidate");

  // The candidate's run is read as a whole, from the one place the fixture
  // starts it.  Looking for the candidate's stop wherever it happens to be
  // would let any number of steps the fixture never writes sit between the
  // candidate's start and its stop, and both checks would still pass.
  const wrote = (index, action) => (action === "candidate-refused"
    ? trace[index]?.action === action
    : at(index, action, "candidate"));
  const candidateRun = candidateBuilt
    ? CANDIDATE_RUNS.find((run) => run.every((action, offset) => wrote(CANDIDATE_START + offset, action)))
    : undefined;

  // The rollback is the three steps directly after the candidate's run, and
  // the end of the trace.
  const rollbackStart = CANDIDATE_START + (candidateRun?.length ?? 0);
  const rolledBack = candidateRun !== undefined
    && at(rollbackStart, "start", "prior")
    && at(rollbackStart + 1, "health", "prior")
    && at(rollbackStart + 2, "stop", "prior")
    && trace.length === rollbackStart + 3;

  return {
    "clean-export-build": priorBuilt && candidateBuilt,
    "install-start": priorHealthy,
    update: candidateRun === CANDIDATE_HELD && !marked("candidate-refused"),
    rollback: rolledBack && !marked("rollback-refused") && result.cleanupFailures.length === 0,
  };
}

/**
 * Open the capture directory through the bundle's own reader.
 *
 * Every file the receipt cites is read through it, so a file the receipt
 * names is a file the bundle will read:  owned by this account, with no group
 * or other access, a single-link regular file reached through no symlink, and
 * no larger than the bundle's per-file limit.
 */
function openCapture(capture) {
  try {
    return createEvidenceReader(capture);
  } catch (error) {
    throw new Error(`the capture directory is not one the evidence bundle will read (${shown(error.message)}): ${shown(capture)}`);
  }
}

/**
 * A hash reference to a file inside the capture directory, with the exact
 * bytes the hash was taken over.
 *
 * The bytes are read once, through the bundle's reader, and everything this
 * script derives from the file is derived from those bytes.  The size is
 * checked first so that an oversized file is refused with its size and the
 * limit, instead of as a receipt the bundle rejects later.
 *
 * The receipt this script writes is never an input to it.  The reference
 * would be hashed over the receipt that is there now, the new receipt would
 * then replace that file, and the bundle would find a hash that matches
 * nothing.  The file is compared by identity, not by name, so another
 * spelling of the same name is refused as well.
 *
 * `capture` is the capture directory's real path, the root the bundle's
 * reader holds, and the reference is computed against the file's directory
 * resolved the same way.  A directory reached through a symlinked alias, on
 * either side, is then the same directory to both.  Only the directory is
 * resolved:  a symlink as the file's own name stays one and the reader
 * refuses it.
 */
function citeEvidence(reader, capture, filePath, what) {
  const named = shown(filePath);
  let stat;
  let located;
  try {
    const absolute = resolve(filePath);
    stat = statSync(absolute);
    located = join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    throw new Error(`${what} could not be read: ${named}`);
  }
  // Only a regular file is hashed:  reading a pipe or a device to hash it
  // could wait forever or never end.
  if (!stat.isFile()) {
    throw new Error(`${what} is not a regular file: ${named}`);
  }
  const written = lstatSync(join(capture, LINUX_RETENTION_RECEIPT_FILE), { throwIfNoEntry: false });
  if (written !== undefined && written.dev === stat.dev && written.ino === stat.ino) {
    throw new Error(`${what} is the receipt this command writes, and a receipt cannot cite the file it replaces: ${named}`);
  }
  if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(
      `${what} is ${stat.size} bytes and the evidence bundle reads at most ${MAX_EVIDENCE_FILE_BYTES} bytes of one file, so a receipt citing it would be refused: ${named}`,
    );
  }
  let reference;
  try {
    reference = evidenceRef(capture, located);
  } catch (error) {
    // The reference names the path it refused, so its text is quoted the same way.
    throw new Error(shown(error.message));
  }
  let bytes;
  try {
    bytes = reader.read(reference.path);
  } catch (error) {
    throw new Error(`${what} is not a file the evidence bundle will read (${shown(error.message)}): ${named}`);
  }
  if (evidenceHash(bytes) !== reference.sha256) {
    throw new Error(`${what} changed while it was being read: ${named}`);
  }
  return { reference, bytes };
}

/** Read one closure receipt out of bytes already hashed. */
function parseClosureReceipt(bytes, slot) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`the ${slot} closure receipt could not be read as JSON`);
  }
  const result = ClosureReceiptSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`the ${slot} closure receipt does not match the contract: ${issueText(result.error, "receipt")}`);
  }
  return result.data;
}

/**
 * Emit the `linux-retention` receipt.
 *
 * The candidate, mode and hosts come from the bundle request the operator
 * prepared, so the receipt is bound to the same candidate as the rest of the
 * packet.  The maintained source is the one the candidate closure receipt
 * names, and it has to be the request's candidate source;  the rollback
 * source is the one the prior closure receipt names.  Neither is taken from
 * the command line.
 *
 * Nothing is written unless every input was read, agreed with the others and
 * produced a receipt the bundle's own schema accepts.
 */
export function emitLinuxRetentionReceipt({ captureDir, request, provenance, resultPath, candidateClosurePath, priorClosurePath }) {
  const requested = resolve(captureDir);
  let capture;
  try {
    assertPrivateCaptureDir(requested);
    // The capture directory's real path is the root everything below is
    // measured from, as it is for the bundle's reader.
    capture = realpathSync(requested);
  } catch (error) {
    // The message names the directory, which is the operator's own text.
    throw new Error(shown(error.message));
  }
  const bundle = validateBundleRequest(request);
  const source = ProvenanceSourceSchema.safeParse(provenance?.source);
  if (!source.success) {
    throw new Error("the provenance source must be an https URL");
  }

  const reader = openCapture(capture);
  const resultFile = citeEvidence(reader, capture, resultPath, "the retained-run result");
  const candidateFile = citeEvidence(reader, capture, candidateClosurePath, "the candidate closure receipt");
  const priorFile = citeEvidence(reader, capture, priorClosurePath, "the prior closure receipt");
  const recordFile = citeEvidence(reader, capture, provenance.record, "the provenance record");

  const result = parseRetainedRunResult(resultFile.bytes);
  const closures = {
    candidate: parseClosureReceipt(candidateFile.bytes, "candidate"),
    prior: parseClosureReceipt(priorFile.bytes, "prior"),
  };
  if (closures.candidate.sourceSha === closures.prior.sourceSha) {
    throw new Error("the candidate and the prior closure receipts name the same source, and a rollback needs a distinct prior");
  }
  // The receipt is bound to the packet's candidate by the bundle's identity
  // check, and that check does not look at the source the receipt pins.  So
  // the candidate closure receipt has to be for the packet's own source:
  // otherwise a run of some other source would certify this candidate.
  if (closures.candidate.sourceSha !== bundle.candidate.sourceSha) {
    throw new Error(
      `the candidate closure receipt names source ${closures.candidate.sourceSha} and the bundle request's candidate is source ${bundle.candidate.sourceSha}, so the run is not of the candidate this packet deploys`,
    );
  }

  // The plan the fixture makes for these two receipts carries the proof
  // label an executed run reports, so the label is the fixture's to name.
  const plan = linuxFixturePlan(closures.candidate, closures.prior);
  if (result.proof !== plan.proof) {
    throw new Error(`the retained-run result reports the proof "${printable(result.proof, 64)}" and the fixture reports "${plan.proof}"`);
  }

  // Every step ran the source its slot's closure receipt names.  A step that
  // ran another source belongs to a run made from other receipts, and the
  // receipt would pin a source the run never built.
  for (const step of result.trace) {
    if (step.slot !== undefined && step.sourceSha !== closures[step.slot].sourceSha) {
      throw new Error(`the ${step.slot} ${step.action} step ran a source other than the one the ${step.slot} closure receipt names`);
    }
  }

  // The check names are the bundle's own.  A name this script has no verdict
  // for earns a failing code, so a check the bundle adds later is never
  // certified by a producer that does not measure it.
  const verdicts = retentionVerdicts(result);
  const checks = REQUIRED_CHECKS["linux-retention"].map((name) => ({
    name,
    exitCode: verdicts[name] === true ? 0 : 1,
    artifact: resultFile.reference,
  }));

  const receipt = {
    version: LINUX_RETENTION_RECEIPT_VERSION,
    kind: "linux-retention",
    candidate: bundle.candidate,
    mode: bundle.mode,
    hosts: bundle.hosts,
    provenance: {
      by: provenance.by,
      at: provenance.at,
      source: provenance.source,
      record: recordFile.reference,
    },
    data: {
      checks,
      maintainedSourceSha: closures.candidate.sourceSha,
      rollbackSourceSha: closures.prior.sourceSha,
      closureManifest: candidateFile.reference,
    },
  };

  // The receipt is checked against the bundle's own schema before it is
  // written, so this script never leaves behind a receipt the bundle refuses
  // for its shape.
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    assertReceiptBinding(parseEvidenceReceipt("linux-retention", Buffer.from(body)), bundle);
  } catch (error) {
    throw new Error(`the receipt is not one the evidence bundle accepts (${shown(error.message)}); check who the provenance is by and its timestamp`);
  }

  // The receipt is written beside its final name and renamed into place, so
  // it is always a new single-link file:  the bundle's reader refuses a
  // hard-linked file, and a write in place would keep the links of a receipt
  // already there and would follow a symlink left under that name.
  const receiptPath = join(capture, LINUX_RETENTION_RECEIPT_FILE);
  const pendingPath = `${receiptPath}.${process.pid}.pending`;
  writeFileSync(pendingPath, body, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(pendingPath, 0o600);
    renameSync(pendingPath, receiptPath);
  } catch (error) {
    rmSync(pendingPath, { force: true });
    throw error;
  }
  return receipt;
}

const REQUIRED_FLAGS = [
  "--capture", "--request", "--result", "--candidate-closure", "--prior-closure",
  "--provenance-record", "--provenance-source", "--provenance-by",
];

/** The one flag that may be left out:  the receipt is then stamped with the time it was emitted. */
const PROVENANCE_AT_FLAG = "--provenance-at";

/**
 * The command line, as a value for each flag.
 *
 * The command line is read as pairs and every pair has to be a flag this
 * script reads, given once, with a value that is not itself a flag.  Reading
 * each flag wherever it happens to stand would let a flag that lost its value
 * take the next flag as one, and would let a misspelled `--provenance-at` be
 * ignored and the receipt stamped with the wrong time.  The bundle orders
 * receipts by that time, so a default is used only when the flag is absent.
 */
function parseFlags(args) {
  const known = [...REQUIRED_FLAGS, PROVENANCE_AT_FLAG];
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!known.includes(flag)) {
      throw new Error(`"${shown(flag)}" is not an argument this command reads; it reads ${known.join(", ")}, each followed by its value`);
    }
    if (flags.has(flag)) {
      throw new Error(`${flag} is given more than once`);
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    flags.set(flag, value);
  }
  if (REQUIRED_FLAGS.some((flag) => !flags.has(flag))) {
    throw new Error(`${REQUIRED_FLAGS.slice(0, -1).join(", ")} and ${REQUIRED_FLAGS.at(-1)} are required`);
  }
  return flags;
}

/**
 * Read the bundle request the operator names.
 *
 * The request is the one input the receipt does not cite, so it is not read
 * through the bundle's reader and it may live outside the capture directory.
 * It is held to the rule the cited files get all the same, and the bundle
 * reader's handle checks:  it is opened without waiting and without following
 * a symlink as its own name, and the open handle is read only when it is a
 * regular single-link file, still the file the path names, no larger than the
 * bundle reads of one file.  A pipe or a device named by mistake is refused
 * instead of being waited on or read without end, and a link swapped in under
 * the name is never the file that is read.
 */
function readBundleRequest(requestPath) {
  const named = shown(requestPath);
  let descriptor;
  try {
    descriptor = openSync(requestPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(`the bundle request is a symbolic link, and a request is read only as the file it is: ${named}`);
    }
    throw new Error(`the bundle request could not be read: ${named}`);
  }
  let bytes;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`the bundle request is not a regular file: ${named}`);
    }
    if (stat.nlink !== 1) {
      throw new Error(`the bundle request has ${stat.nlink} links, and a request is read only as a single-link file: ${named}`);
    }
    const listed = lstatSync(requestPath, { throwIfNoEntry: false });
    if (listed === undefined || listed.isSymbolicLink() || listed.dev !== stat.dev || listed.ino !== stat.ino) {
      throw new Error(`the bundle request is no longer the file its path names: ${named}`);
    }
    if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error(`the bundle request is ${stat.size} bytes and at most ${MAX_EVIDENCE_FILE_BYTES} bytes of one are read: ${named}`);
    }
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`the bundle request could not be read as JSON: ${named}`);
  }
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
  // A refusal repeats text from the files and the arguments it refused, so
  // it reaches the terminal as one bounded line of printable characters.
  const fail = (message) => {
    // Text from the files and the arguments was already written as printable
    // where it was quoted;  anything still carrying a control character is
    // written as its code point here, without doubling a backslash again.
    console.error(`emit-linux-retention-receipt refused: ${bounded(escapeControls(message), MAX_REFUSAL_TEXT)}`);
    process.exitCode = 2;
  };
  try {
    const flags = parseFlags(args);
    const receipt = emitLinuxRetentionReceipt({
      captureDir: flags.get("--capture"),
      request: readBundleRequest(flags.get("--request")),
      resultPath: resolve(flags.get("--result")),
      candidateClosurePath: resolve(flags.get("--candidate-closure")),
      priorClosurePath: resolve(flags.get("--prior-closure")),
      provenance: {
        by: flags.get("--provenance-by"),
        at: flags.get(PROVENANCE_AT_FLAG) ?? new Date().toISOString(),
        source: flags.get("--provenance-source"),
        record: resolve(flags.get("--provenance-record")),
      },
    });
    console.log(JSON.stringify({
      emitted: [LINUX_RETENTION_RECEIPT_FILE],
      checks: receipt.data.checks.map((check) => ({ name: check.name, exitCode: check.exitCode })),
    }));
    if (receipt.data.checks.some((check) => check.exitCode !== 0)) process.exitCode = 1;
  } catch (error) {
    fail(error.message);
  }
}
