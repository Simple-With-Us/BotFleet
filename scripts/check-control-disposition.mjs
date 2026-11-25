/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// Check what a source tree states about the `control-disposition` evidence (BF-2701).
//
// The decommission gate's `control-disposition` receipt has three checks:
// `owner-decision`, `landed-implementation` and `muster-disposition`
// (`scripts/decommission-evidence-bundle.mjs`).  Two of them are facts about
// the tree, and this script measures both against one commit of a checkout:
// the ruling that split BotFleet Control is recorded, and the native app
// carries every control that ruling moved into it.
//
// The third is a person's attestation about the fleet-administration half.
// Nothing in a tree can state it, so it is not measured here and it is not in
// the verdict.  `scripts/emit-control-disposition-receipt.mjs` reads it from
// the attestation record the owner gives it.
//
// Everything is read from the commit with `git grep`, and never from the
// working tree.  A checkout can hold uncommitted edits, and evidence about a
// commit has to come from that commit.  A control is a list of requirements,
// and a requirement is met when a path prefix holds at least one file that
// carries its needle at that commit.
//
// The verdict's summary is computed out of its own details, and the emitter
// computes it again, so a verdict whose summary says one thing and whose
// details say another did not come from this check and is refused there.
//
// What this script does NOT do: it cannot say the controls work.  A marker in
// the tree says the code that carries a control is there.  Whether it starts a
// server, stops one or writes a policy is what the tests under `ios/` and the
// installed-route check (BF-2527) say.  It runs nothing, touches no launchd job,
// reads no data directory and contacts no network.
//
// Usage:
//   node scripts/check-control-disposition.mjs --source <checkout> --commit <sha> \
//     [--out <verdict.json>]
//
// The exit status is 0 when both checks hold and 1 when either does not.  The
// verdict is printed either way, and written to `--out` when it is given.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROL_DISPOSITION_VERDICT_VERSION = 1;
export const CONTROL_DISPOSITION_VERDICT_KIND = "control-disposition-verdict";

/** A commit is named by the forty hexadecimal characters the bundle's own candidate carries. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The ruling that decided where BotFleet Control's surface goes, and the
 * strings that identify it in the tree.
 *
 * The second needle is the Zulip message the ruling was relayed as. The
 * option's name alone also appears in the list of options the document offers,
 * so it cannot by itself tell the ruling from the question.
 */
export const RULING = Object.freeze({
  document: "docs/plans/2026-10-29-botfleet-control-after-node.md",
  decision: "Option C",
  needles: Object.freeze(["Option C", "636105146"]),
});

function requirement(under, needle) {
  return Object.freeze({ under, needle });
}

function control(id, label, requirements) {
  return Object.freeze({ id, label, requirements: Object.freeze(requirements) });
}

/**
 * Every control the ruling moved into the native app, and where the tree
 * carries each one.
 *
 * A control is listed once, with every requirement it needs. The library half
 * is under `ios/Sources/CompanionCore` and the half the person uses is under
 * `ios/MacApp`, and most controls need both: a client nothing calls is not a
 * control. The list is what the emitter holds a verdict to, so a control added
 * here is a control every later verdict has to account for.
 */
export const PRODUCT_CONTROLS = Object.freeze([
  control("harness-status", "Harness status, with the bot count and the work in flight", [
    requirement("ios/Sources/CompanionCore", "/api/system/control"),
    requirement("ios/MacApp", "controlStatus"),
  ]),
  control("fenced-stop", "A server stop that refuses while work is active", [
    requirement("ios/Sources/CompanionCore", "/api/system/control/stop"),
    requirement("ios/MacApp", "shutDownServerAndLocalVM"),
  ]),
  control("fenced-start", "A server start on request", [
    requirement("ios/Sources/CompanionCore", '"kickstart"'),
    requirement("ios/MacApp", "startServerAndSettle"),
  ]),
  control("startup-policy", "Start Server At Login", [
    requirement("ios/Sources/CompanionCore", "startup-disabled.marker"),
    requirement("ios/MacApp", "setStartsAtLogin"),
  ]),
  control("shared-local-vm", "The shared Local VM's start and stop", [
    requirement("ios/Sources/CompanionCore", "/api/system/control/vms/start"),
    requirement("ios/Sources/CompanionCore", "/api/system/control/vms/stop"),
    requirement("ios/MacApp", "stopLocalVMs"),
  ]),
  control("saved-servers", "The saved servers list", [
    requirement("ios/Sources/CompanionCore", "struct HostRecord"),
    requirement("ios/MacApp", "MacServersSettings"),
  ]),
  control("saved-servers-import", "The one-time import of the saved servers BotFleet Control held", [
    requirement("ios/Sources/CompanionCore", "control-hosts.json"),
  ]),
  control("lifecycle-surface", "The Lifecycle section that carries the rest", [
    requirement("ios/MacApp", "MacLifecycleSettingsView"),
  ]),
]);

/**
 * The fleet-administration half the ruling moved out of the BotFleet product,
 * named one item at a time.
 *
 * Where each of these goes is the owner's attestation and nothing in the tree
 * can state it. The attestation has to name each one, so a disposition that is
 * silent about one of them is not a disposition of the half.
 */
export const FLEET_ADMIN_ITEMS = Object.freeze([
  Object.freeze({ id: "fleet-services-list", label: "The twelve-row fleet services list" }),
  Object.freeze({ id: "pm2-rows", label: "The pm2 rows" }),
  Object.freeze({ id: "process-and-port-monitor", label: "The process and port monitor with orphan kill" }),
  Object.freeze({ id: "remote-vm-providers", label: "The remote VM providers" }),
]);

/** The commit a checkout names, resolved to its full identifier. */
function resolveCommit(checkout, commit) {
  const named = spawnSync(
    "git",
    ["-C", checkout, "rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`],
    { encoding: "utf8" },
  );
  if (named.status !== 0) {
    throw new Error(`the commit could not be resolved in ${checkout}: ${commit}`);
  }
  const sourceSha = named.stdout.trim();
  if (!FULL_SHA.test(sourceSha)) {
    throw new Error(`the checkout names commits in a form the bundle's candidate cannot carry: ${sourceSha}`);
  }
  return sourceSha;
}

/**
 * Whether a path prefix holds a file that carries a needle at the commit.
 *
 * `git grep` exits 0 when it found the needle, 1 when it did not, and
 * anything else means it could not be asked. Only the first two are an
 * answer, so the third is passed up instead of being read as "not there".
 */
function carries(checkout, sourceSha, { under, needle }) {
  const asked = spawnSync(
    "git",
    ["-C", checkout, "grep", "-l", "-F", "-e", needle, sourceSha, "--", under],
    { encoding: "utf8" },
  );
  if (asked.status === 0) return true;
  if (asked.status === 1) return false;
  throw new Error(`git grep could not be asked about "${under}" at ${sourceSha}: ${asked.stderr.trim()}`);
}

function missingRequirement({ under, needle }) {
  return `nothing under "${under}" carries ${needle}`;
}

/**
 * The two summaries a verdict's own details state, computed from them.
 *
 * A landed implementation is every control in `PRODUCT_CONTROLS`, each listed
 * exactly once and each with nothing missing. A verdict that lists fewer says
 * nothing about the ones it leaves out, so it does not pass.
 */
export function summarizeControlDisposition(verdict) {
  const rulingHolds = verdict.ruling.found === true && verdict.ruling.missing.length === 0;
  const listed = new Set(verdict.controls.map((entry) => entry.id));
  const complete = PRODUCT_CONTROLS.every(({ id }) => listed.has(id))
    && listed.size === PRODUCT_CONTROLS.length;
  const landed = complete
    && verdict.controls.every((entry) => entry.landed === true && entry.missing.length === 0);
  return {
    "owner-decision": { ok: rulingHolds, exitCode: rulingHolds ? 0 : 1 },
    "landed-implementation": { ok: landed, exitCode: landed ? 0 : 1 },
  };
}

/**
 * Measure both checks against one commit of a checkout.
 *
 * @returns the verdict:  the commit it was taken against, what was looked
 *   for and what was missing, and the two summaries those details state.
 */
export function checkControlDisposition({ source, commit }) {
  const checkout = realpathSync(resolve(source));
  const sourceSha = resolveCommit(checkout, commit);
  const rulingMissing = RULING.needles
    .filter((needle) => !carries(checkout, sourceSha, { under: RULING.document, needle }))
    .map((needle) => missingRequirement({ under: RULING.document, needle }));
  const ruling = {
    document: RULING.document,
    decision: RULING.decision,
    found: rulingMissing.length === 0,
    missing: rulingMissing,
  };
  const controls = PRODUCT_CONTROLS.map((entry) => {
    const missing = entry.requirements
      .filter((need) => !carries(checkout, sourceSha, need))
      .map(missingRequirement);
    return { id: entry.id, label: entry.label, landed: missing.length === 0, missing };
  });
  const details = { ruling, controls };
  return {
    version: CONTROL_DISPOSITION_VERDICT_VERSION,
    kind: CONTROL_DISPOSITION_VERDICT_KIND,
    sourceSha,
    ...details,
    checks: summarizeControlDisposition(details),
  };
}

/** Write a file owner-only, through a handle that is set owner-only before anything is written. */
export function writeOwnerOnly(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

const KNOWN_FLAGS = Object.freeze(["--source", "--commit", "--out"]);

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
  const missing = KNOWN_FLAGS.filter((flag) => flag !== "--out" && !values.has(flag));
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
    const verdict = checkControlDisposition({ source: flags.get("--source"), commit: flags.get("--commit") });
    const bytes = `${JSON.stringify(verdict, null, 2)}\n`;
    process.stdout.write(bytes);
    if (flags.has("--out")) writeOwnerOnly(resolve(flags.get("--out")), bytes);
    if (!Object.values(verdict.checks).every((check) => check.ok)) process.exitCode = 1;
  } catch (error) {
    //  A refusal stays one line for every parser, and no byte from git's own
    //  error text can forge one.
    const reason = String(error.message).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
    process.stderr.write(`check-control-disposition refused: ${reason}\n`);
    process.exitCode = 2;
  }
}
