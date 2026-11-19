#!/usr/bin/env node
// The real native host package smoke.
//
// The fixtures in native-host-artifact.node-test.mjs prove the identity logic against synthetic
// binaries.  This script proves the product path instead:  the checkout is packaged by the product's
// own packager (scripts/package-native-host.mjs), the archive it wrote is opened again, and the
// packaged executable is asked for its own identity with --identity.  The answer has to match the
// receipt the packager wrote, field for field.
//
// What it proves:
//   - the real packager produces a real archive from the committed source, not a fixture;
//   - the packaged executable reports the code identifier, the source commit and the build number
//     that the receipt claims, on the architecture this Mac runs;
//   - the artifact is the unsigned development one, and it says so:  NOT DISTRIBUTABLE.
//
// What it never does:  it installs nothing, signs nothing, notarizes nothing, starts nothing, reads
// no Keychain item, touches no service credential and publishes nothing.  Everything happens in a
// temporary directory that is removed when the run ends.
//
// Usage: node scripts/native-host-package-smoke.mjs [--repo-root <path>] [--keep]
//
// The build number is the commit's own Central stamp (YYYYMMDDHHMM), the same shape the shared
// release build uses, so the receipt carries a build that identifies the commit it came from.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { HOST_CODE_ID, sha256 } from "./native-host-artifact.mjs";
import { committerDateFor, mergeStampFor } from "./mac-release-version.mjs";

// The identity fields the packaged executable and the receipt must agree on, in the order the
// packager writes them.  The list is derived from the packager's own identity construction in the
// test, so it cannot drift away from what the product writes.
export const IDENTITY_KEYS = [
  "schemaVersion",
  "codeIdentifier",
  "sourceCommit",
  "build",
  "marketingVersion",
  "capabilities",
  "distribution",
  "sourceDirty",
];

// The receipt is written by another process, so it is parsed at the boundary and every field the
// smoke reads is checked there.  A receipt that does not match this shape is refused, not repaired.
export const IdentitySchema = z.object({
  schemaVersion: z.literal(1),
  codeIdentifier: z.literal(HOST_CODE_ID),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  build: z.string().regex(/^[0-9]{12}$/),
  marketingVersion: z.literal("0.1.0"),
  capabilities: z.array(z.string()),
  distribution: z.enum(["unsigned-development", "developer-id"]),
  sourceDirty: z.boolean(),
});

export const ReceiptSchema = z.object({
  artifact: z.string().min(1),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  binarySha256: z.string().regex(/^[0-9a-f]{64}$/),
  architectures: z.array(z.string()),
  distributable: z.boolean(),
  notice: z.string(),
  signatureVerified: z.boolean(),
  identity: IdentitySchema,
});

// The packager builds the host twice (arm64 and x86_64) from a clean export of the committed source,
// so a cold run is a long one.  The budget is generous on purpose:  a refusal from the packager is
// worth more than a timeout.
const PACKAGE_TIMEOUT_MS = 45 * 60 * 1000;

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
}

/** The build number for one commit:  its Central stamp, twelve digits. */
export function nativeHostSmokeBuildNumber(repoRoot, sha = "HEAD") {
  return mergeStampFor(committerDateFor(repoRoot, sha));
}

/** Node's architecture name is not the Mach-O slice name. */
export function hostArchitecture(arch = process.arch) {
  return arch === "x64" ? "x86_64" : arch;
}

/**
 * What is wrong with an unsigned receipt, as a list of sentences.
 *
 * The list is empty when the receipt says what an unsigned development package must say.
 */
export function receiptProblems(receipt, expected = {}) {
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };
  if (receipt === null || receipt === undefined) return ["the packager wrote no receipt"];
  need(receipt.distributable === false, "the receipt does not say the artifact is not distributable");
  need(
    receipt.notice === "NOT DISTRIBUTABLE",
    `the receipt notice is ${String(receipt.notice)}, not NOT DISTRIBUTABLE`,
  );
  need(
    String(receipt.artifact ?? "").endsWith("-UNSIGNED.zip"),
    `the artifact is ${String(receipt.artifact)}, which is not the unsigned archive`,
  );
  need(
    receipt.identity?.distribution === "unsigned-development",
    `the receipt distribution is ${String(receipt.identity?.distribution)}, not unsigned-development`,
  );
  need(
    Array.isArray(receipt.architectures) && receipt.architectures.includes("arm64"),
    "the artifact carries no arm64 slice",
  );
  need(receipt.signatureVerified === false, "the receipt says the signature was verified");
  if (expected.source) {
    need(
      receipt.identity?.sourceCommit === expected.source,
      `the receipt says source ${String(receipt.identity?.sourceCommit)}, not ${expected.source}`,
    );
  }
  if (expected.build) {
    need(
      receipt.identity?.build === expected.build,
      `the receipt says build ${String(receipt.identity?.build)}, not ${expected.build}`,
    );
  }
  return problems;
}

/**
 * What differs between the identity the receipt claims and the identity the packaged executable
 * reports, as a list of sentences.  The list is empty when they agree.
 *
 * A field that is missing on either side is a difference:  two sides that both say nothing have not
 * agreed about anything, and the field-for-field claim would be false.
 */
export function identityProblems(expected, actual) {
  const problems = [];
  if (expected === null || expected === undefined) return ["the receipt carries no identity"];
  for (const key of IDENTITY_KEYS) {
    const expectedHasKey = Object.prototype.hasOwnProperty.call(expected, key);
    const actualHasKey =
      actual !== null &&
      actual !== undefined &&
      Object.prototype.hasOwnProperty.call(actual, key);
    const claimed = expectedHasKey ? expected[key] : undefined;
    const reported = actualHasKey ? actual[key] : undefined;
    if (!expectedHasKey || !actualHasKey || JSON.stringify(claimed) !== JSON.stringify(reported)) {
      problems.push(
        `identity ${key} differs:  the receipt says ${JSON.stringify(claimed)}, ` +
          `the packaged executable says ${JSON.stringify(reported)}`,
      );
    }
  }
  return problems;
}

/**
 * Run the smoke.
 *
 * The result is a report:  `status` is "passed", "failed" or "skipped", `problems` holds every
 * reason it did not pass, and `receipt` holds what the packager wrote when it got that far.  A host
 * that is not macOS skips with a reason, because the package cannot be built anywhere else.
 */
export function runNativeHostPackageSmoke({
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  run = defaultRun,
  keep = false,
  build = null,
} = {}) {
  if (platform !== "darwin") {
    return {
      status: "skipped",
      problems: [],
      reason: `the native host package smoke needs macOS;  this host is ${platform}`,
    };
  }
  const root = resolve(repoRoot);
  const work = mkdtempSync(join(tmpdir(), "botfleet-native-host-smoke-"));
  const problems = [];
  let receipt = null;
  let packed = null;
  try {
    const source = run("git", ["-C", root, "rev-parse", "HEAD"]).trim();
    const buildNumber = build === null ? nativeHostSmokeBuildNumber(root) : String(build);
    const output = join(work, "package");
    packed = run(
      process.execPath,
      [
        join(root, "scripts", "package-native-host.mjs"),
        "--repo-root",
        root,
        "--output",
        output,
        "--build",
        buildNumber,
        "--unsigned-dev",
      ],
      { timeout: PACKAGE_TIMEOUT_MS, cwd: root },
    );
    const receiptPath = join(output, "artifact.json");
    if (!existsSync(receiptPath)) {
      problems.push(`the packager wrote no receipt at ${receiptPath}`);
    } else {
      let raw = null;
      try {
        raw = JSON.parse(readFileSync(receiptPath, "utf8"));
      } catch (error) {
        problems.push(`the receipt at ${receiptPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (raw !== null) {
        const parsed = ReceiptSchema.safeParse(raw);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.message}`)
            .join("; ");
          problems.push(`the receipt does not match the expected shape: ${detail}`);
        } else {
          receipt = parsed.data;
        }
      }
    }
    problems.push(...receiptProblems(receipt, { source, build: buildNumber }));
    if (receipt !== null) {
      const archive = join(output, receipt.artifact);
      if (!existsSync(archive)) {
        problems.push(`the packager named an artifact that is not there: ${receipt.artifact}`);
      } else {
        // The proof comes before the use.  The archive, and the executable inside it, are compared
        // with the receipt first, and the executable is run only when both comparisons succeed, so
        // the bytes that report an identity are already the bytes the receipt names.
        const archiveDigest = sha256(readFileSync(archive));
        const archiveMatches = archiveDigest === receipt.artifactSha256;
        if (!archiveMatches) {
          problems.push(
            `the archive hashes to ${archiveDigest}, not the ${receipt.artifactSha256} the receipt names`,
          );
        }
        const unpacked = join(work, "unpacked");
        run("/usr/bin/ditto", ["-x", "-k", archive, unpacked], { timeout: PACKAGE_TIMEOUT_MS });
        const executable = join(unpacked, "payload", "bin", HOST_CODE_ID);
        if (!existsSync(executable)) {
          problems.push(`the archive carries no executable at ${executable}`);
        } else {
          const binaryDigest = sha256(readFileSync(executable));
          const binaryMatches = binaryDigest === receipt.binarySha256;
          if (!binaryMatches) {
            problems.push(
              `the unpacked executable hashes to ${binaryDigest}, not the ${receipt.binarySha256} the receipt names`,
            );
          }
          if (archiveMatches && binaryMatches) {
            let reported = null;
            try {
              reported = JSON.parse(run(executable, ["--identity"], { timeout: 120_000 }));
            } catch (error) {
              problems.push(
                `the packaged executable did not report an identity: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            if (reported !== null) {
              const parsed = IdentitySchema.safeParse(reported);
              if (!parsed.success) {
                problems.push("the packaged executable reported an identity that does not match the expected shape");
              } else {
                problems.push(...identityProblems(receipt.identity, parsed.data));
              }
            }
          }
        }
        const host = hostArchitecture();
        if (receipt.architectures && !receipt.architectures.includes(host)) {
          problems.push(
            `the artifact carries ${receipt.architectures.join(", ")}, not the ${host} this host runs`,
          );
        }
      }
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
  return {
    status: problems.length === 0 ? "passed" : "failed",
    problems,
    receipt,
    work: keep ? work : null,
    packed: packed === null ? null : String(packed).trim(),
  };
}

function isEntryModule() {
  try {
    // Both sides are resolved through realpath:  a symlinked invocation (the /var -> /private/var
    // case) would otherwise compare two different strings and skip the work entirely.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const args = process.argv.slice(2);
  let repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let keep = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--keep") {
      keep = true;
      continue;
    }
    if (args[index] === "--repo-root" && args[index + 1]) {
      repoRoot = resolve(args[++index]);
      continue;
    }
    console.error("usage: node scripts/native-host-package-smoke.mjs [--repo-root <path>] [--keep]");
    process.exit(2);
  }
  const report = runNativeHostPackageSmoke({ repoRoot, keep });
  if (report.status === "skipped") {
    console.log(`SKIPPED: ${report.reason}`);
    process.exit(0);
  }
  if (report.status === "failed") {
    console.error("FAIL: the native host package smoke did not pass:");
    for (const problem of report.problems) console.error(`  - ${problem}`);
    if (report.work) console.error(`the artifacts were kept at ${report.work}`);
    process.exit(1);
  }
  console.log(
    `PASS: ${report.receipt.artifact}, build ${report.receipt.identity.build}, ` +
      `source ${report.receipt.identity.sourceCommit.slice(0, 12)}, ` +
      `${report.receipt.architectures.join("+")}, ${report.receipt.notice}.`,
  );
}
