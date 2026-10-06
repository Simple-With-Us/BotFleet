import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cocoa's default release identity is bundle-id@marketing-version+build-number.
// This receipt proves TestFlight availability, not installation on a device.
export function validateReceipt(receipt) {
  const strings = ["bundleId", "marketingVersion", "buildNumber", "sourceCommit", "ascBuildId", "state", "confirmedAt", "release"];
  if (receipt?.schema !== 1 || strings.some((key) => typeof receipt[key] !== "string") || receipt.milestone !== "testflight-ready" ||
      receipt.bundleId !== "app.botfleet" ||
      !/^1\.0\.\d+$/.test(receipt.marketingVersion ?? "") ||
      !/^\d{12}$/.test(receipt.buildNumber ?? "") ||
      !/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? "") ||
      /^0+$/.test(receipt.sourceCommit) ||
      !/^[A-Za-z0-9-]{1,64}$/.test(receipt.ascBuildId ?? "") ||
      !["IN_BETA_TESTING", "READY_FOR_BETA_TESTING"].includes(receipt.state) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.confirmedAt ?? "") ||
      !Number.isFinite(Date.parse(receipt.confirmedAt))) {
    throw new Error("Invalid verified TestFlight receipt");
  }
  const release = `${receipt.bundleId}@${receipt.marketingVersion}+${receipt.buildNumber}`;
  if (receipt.release !== release) throw new Error("Receipt release identity mismatch");
  return receipt;
}

export function createReceipt({ archive, readiness, sourceCommit, expectedCommit, bundleId, marketingVersion, buildNumber, now = new Date() }) {
  if (sourceCommit !== expectedCommit || readiness?.ok !== true || readiness.version !== buildNumber ||
      archive.bundleId !== bundleId || archive.marketingVersion !== marketingVersion ||
      archive.buildNumber !== buildNumber) {
    throw new Error("Archive, source commit, and confirmed App Store Connect build must agree");
  }
  return validateReceipt({
    schema: 1, milestone: "testflight-ready", bundleId, marketingVersion, buildNumber,
    sourceCommit, ascBuildId: readiness.buildId, state: readiness.internalBuildState,
    confirmedAt: now.toISOString(), release: `${bundleId}@${marketingVersion}+${buildNumber}`,
  });
}

function main(env) {
  const plist = resolve(env.SENTRY_ARCHIVE_PATH, "Info.plist");
  // Read only these public identity fields, never the app's DSN or full plist.
  const field = (name) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :ApplicationProperties:${name}`, plist], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const archive = { bundleId: field("CFBundleIdentifier"), marketingVersion: field("CFBundleShortVersionString"), buildNumber: field("CFBundleVersion") };
  const sourceCommit = execFileSync("git", ["-C", env.SENTRY_REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const receipt = createReceipt({ archive, readiness: JSON.parse(readFileSync(env.SENTRY_READY_FILE, "utf8")),
    sourceCommit, expectedCommit: env.SENTRY_ARCHIVE_COMMIT, bundleId: env.SENTRY_BUNDLE_ID,
    marketingVersion: env.SENTRY_MARKETING_VERSION, buildNumber: env.SENTRY_BUILD_NUMBER });
  appendFileSync(env.GITHUB_OUTPUT, `sentry_receipt=${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.env); }
  catch { console.error("::error::Could not verify TestFlight release receipt; no Sentry deploy will be recorded.  The successful upload remains recorded by the ship gate."); process.exitCode = 1; }
}
