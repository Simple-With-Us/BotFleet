import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cocoa's default release identity is bundle-id@marketing-version+build-number.
// This receipt proves exactly two things: the specific build finished App Store
// Connect processing (READY_FOR_BETA_TESTING / IN_BETA_TESTING) and the app has
// a live external TestFlight install path (an external group with testers or an
// enabled public link).  It is NOT proof that this build is assigned to the
// external group, that Beta App Review approved it, or that it is installed on
// any device: the ship job's standing-testers sync assigns the build after this
// receipt is emitted and logs the group-side membership verification.
//
// Hand-written boundary checks rather than zod, on purpose: hosted ios-ship
// runs this with plain `node` before any `pnpm install`, so `import "zod"`
// would fail with ERR_MODULE_NOT_FOUND and mark every successful upload as a
// receipt error.  Same reasoning as scripts/ios-fleet/asc-api.mjs.

const BUNDLE_ID = "app.botfleet.ios";
const READY_STATES = new Set(["IN_BETA_TESTING", "READY_FOR_BETA_TESTING"]);

// Owner rule, Oct 29 2026: CFBundleVersion is the Central Time merge stamp of
// the commit (YYYYMMDDHHMM, shared by iOS and Mac), and older builds used the
// repo commit count.  Both are positive integers with no leading zero.  This
// predicate is the ONLY definition of that contract: the zod ReceiptSchema in
// sentry-report-testflight.mjs imports it, so the hand-written parser and the
// schema cannot drift apart the way three separate literals did when #1251
// landed.
export const BUILD_NUMBER_PATTERN = /^[1-9]\d*$/;

// CFBundleShortVersionString is a plain X.Y.Z with no leading zeros.  Every app
// now ships the fixed marketing version 0.1.0 (CT stays on 1.1.2); the old
// /^1\.0\.\d+$/ literal rejected 0.1.0, so every BotFleet ship since the switch
// uploaded fine and then failed receipt verification.  Shared with the zod
// schema for the same no-drift reason as BUILD_NUMBER_PATTERN.
export const MARKETING_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Render a public identity value for an error message.  JSON.stringify keeps a
// newline or "::" from reaching the runner as a workflow command.  Only
// bundle ids, versions, build numbers, ASC ids and commit SHAs pass through
// here; the DSN and auth token are never read by this module.
function shown(value) {
  if (value === undefined) return "missing";
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  // JSON.stringify returns undefined for functions and symbols, and throws on
  // BigInt and cycles.  The String() fallback can carry raw CR/LF, so strip it.
  if (text === undefined) {
    try {
      text = String(value);
    } catch {
      text = "unprintable";
    }
    text = text.replace(/[\r\n]+/g, " ");
  }
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function failIfAny(problems, prefix) {
  if (problems.length > 0) throw new Error(`${prefix}: ${problems.join("; ")}`);
}

/* oxlint-disable anti-slop/no-runtime-typeof -- hand-written boundary parse; zod is not installed on the ios-ship runner (see comment above). */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return typeof value === "string";
}

export function parseReadyFile(value) {
  if (!isPlainObject(value)) throw new Error("Invalid TestFlight readiness file: not a JSON object");
  const problems = [];
  if (value.ok !== true) problems.push(`ok is ${shown(value.ok)}, expected true`);
  if (!isString(value.version) || !BUILD_NUMBER_PATTERN.test(value.version)) problems.push(`version ${shown(value.version)} is not a build number`);
  if (!isString(value.buildId) || !/^[A-Za-z0-9-]{1,64}$/.test(value.buildId)) problems.push(`buildId ${shown(value.buildId)} is not an App Store Connect id`);
  if (!READY_STATES.has(value.internalBuildState)) problems.push(`internalBuildState ${shown(value.internalBuildState)} is not ready for testing`);
  if (value.externalInstallPath !== true) problems.push(`externalInstallPath is ${shown(value.externalInstallPath)}, expected true`);
  failIfAny(problems, "Invalid TestFlight readiness file");
  return {
    ok: true,
    version: value.version,
    buildId: value.buildId,
    internalBuildState: value.internalBuildState,
    externalInstallPath: true,
  };
}

export function validateReceipt(receipt) {
  const strings = ["bundleId", "marketingVersion", "buildNumber", "sourceCommit", "ascBuildId", "state", "confirmedAt", "release"];
  if (!isPlainObject(receipt)) throw new Error("Invalid verified TestFlight receipt: not a JSON object");
  const problems = strings.filter((key) => !isString(receipt[key])).map((key) => `${key} ${shown(receipt[key])} is not a string`);
  failIfAny(problems, "Invalid verified TestFlight receipt");
  if (receipt.schema !== 1) problems.push(`schema ${shown(receipt.schema)}, expected 1`);
  if (receipt.milestone !== "testflight-processed") problems.push(`milestone ${shown(receipt.milestone)}, expected "testflight-processed"`);
  if (receipt.externalInstallPath !== true) problems.push(`externalInstallPath ${shown(receipt.externalInstallPath)}, expected true`);
  if (receipt.bundleId !== BUNDLE_ID) problems.push(`bundleId ${shown(receipt.bundleId)}, expected ${shown(BUNDLE_ID)}`);
  if (!MARKETING_VERSION_PATTERN.test(receipt.marketingVersion)) problems.push(`marketingVersion ${shown(receipt.marketingVersion)} is not X.Y.Z`);
  if (!BUILD_NUMBER_PATTERN.test(receipt.buildNumber)) problems.push(`buildNumber ${shown(receipt.buildNumber)} is not a positive integer`);
  if (!/^[a-f0-9]{40}$/.test(receipt.sourceCommit) || /^0+$/.test(receipt.sourceCommit)) problems.push(`sourceCommit ${shown(receipt.sourceCommit)} is not a commit SHA`);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(receipt.ascBuildId)) problems.push(`ascBuildId ${shown(receipt.ascBuildId)} is not an App Store Connect id`);
  if (!READY_STATES.has(receipt.state)) problems.push(`state ${shown(receipt.state)} is not ready for testing`);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.confirmedAt) || !Number.isFinite(Date.parse(receipt.confirmedAt))) {
    problems.push(`confirmedAt ${shown(receipt.confirmedAt)} is not an ISO timestamp`);
  }
  failIfAny(problems, "Invalid verified TestFlight receipt");
  const release = `${receipt.bundleId}@${receipt.marketingVersion}+${receipt.buildNumber}`;
  if (receipt.release !== release) throw new Error(`Receipt release identity mismatch: release ${shown(receipt.release)}, expected ${shown(release)}`);
  return {
    schema: 1,
    milestone: "testflight-processed",
    externalInstallPath: receipt.externalInstallPath,
    bundleId: receipt.bundleId,
    marketingVersion: receipt.marketingVersion,
    buildNumber: receipt.buildNumber,
    sourceCommit: receipt.sourceCommit,
    ascBuildId: receipt.ascBuildId,
    state: receipt.state,
    confirmedAt: receipt.confirmedAt,
    release: receipt.release,
  };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

export function createReceipt({ archive, readiness, sourceCommit, expectedCommit, bundleId, marketingVersion, buildNumber, now = new Date() }) {
  const ready = parseReadyFile(readiness);
  const pairs = [
    ["source commit (HEAD)", sourceCommit, "archived commit", expectedCommit],
    ["App Store Connect build", ready.version, "build number", buildNumber],
    ["archive CFBundleIdentifier", archive.bundleId, "bundle id", bundleId],
    ["archive CFBundleShortVersionString", archive.marketingVersion, "marketing version", marketingVersion],
    ["archive CFBundleVersion", archive.buildNumber, "build number", buildNumber],
  ];
  const problems = pairs.filter(([, got, , want]) => got !== want)
    .map(([gotName, got, wantName, want]) => `${gotName} ${shown(got)} != ${wantName} ${shown(want)}`);
  failIfAny(problems, "Archive, source commit, and confirmed App Store Connect build must agree");
  return validateReceipt({
    schema: 1, milestone: "testflight-processed", externalInstallPath: true, bundleId, marketingVersion, buildNumber,
    sourceCommit, ascBuildId: ready.buildId, state: ready.internalBuildState,
    confirmedAt: now.toISOString(), release: `${bundleId}@${marketingVersion}+${buildNumber}`,
  });
}

function main(env) {
  const plist = resolve(env.SENTRY_ARCHIVE_PATH, "Info.plist");
  // Read only these public identity fields, never the app's DSN or full plist.
  const field = (name) => {
    try {
      return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :ApplicationProperties:${name}`, plist], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      throw new Error(`Could not read ApplicationProperties:${name} from the archive Info.plist`);
    }
  };
  const archive = { bundleId: field("CFBundleIdentifier"), marketingVersion: field("CFBundleShortVersionString"), buildNumber: field("CFBundleVersion") };
  let sourceCommit;
  try {
    sourceCommit = execFileSync("git", ["-C", env.SENTRY_REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("Could not read HEAD from the ship checkout");
  }
  let text;
  try {
    text = readFileSync(env.SENTRY_READY_FILE, "utf8");
  } catch {
    throw new Error("Could not read the TestFlight readiness file (ensure-tf-ready.json)");
  }
  let readiness;
  try {
    readiness = JSON.parse(text);
  } catch {
    throw new Error("The TestFlight readiness file (ensure-tf-ready.json) is not valid JSON");
  }
  const receipt = createReceipt({ archive, readiness,
    sourceCommit, expectedCommit: env.SENTRY_ARCHIVE_COMMIT, bundleId: env.SENTRY_BUNDLE_ID,
    marketingVersion: env.SENTRY_MARKETING_VERSION, buildNumber: env.SENTRY_BUILD_NUMBER });
  appendFileSync(env.GITHUB_OUTPUT, `sentry_receipt=${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.env); }
  catch (error) {
    // Every message above names only public identity fields (see shown()), so
    // the reason is safe to print.  A non-Error throw still gets a generic line.
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`::error::Could not verify TestFlight release receipt; no Sentry deploy will be recorded.  The successful upload remains recorded by the ship gate.  Reason: ${reason}`);
    process.exitCode = 1;
  }
}
