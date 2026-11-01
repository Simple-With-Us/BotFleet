#!/usr/bin/env node
/**
 * Read-only fleet TestFlight build-state audit for the GB-Compiler q6hr fleet check.  It reads App Store Connect state for every fleet app and checks it against the fleet TestFlight policy, so the q6hr check does not have to dig through ship-run logs.  It only ever issues GET requests:  the request layer refuses any other method before a request is made.
 *
 * Policy checked per app:
 *   (a) the marketing version is the expected one (0.1.0, except Congress.Trade at 1.1.2).  An app whose approved App Store version is above the expected one keeps that version and is reported as "kept approved X", not as a violation.
 *   (b) the latest TestFlight build number is a 12-digit Central Time timestamp, YYYYMMDDHHMM.
 *   (c) the iOS and macOS builds of the same release share one build number.  This applies only to apps that ship both platforms through App Store Connect.
 *   (d) build numbers only increase, so the latest uploaded build is the highest one seen.
 *   (e) the latest build finished processing, so its processingState is VALID.  PROCESSING, FAILED and INVALID are reported as violations.
 *   (f) with --repo-heads, the latest build equals the repo HEAD committer date stamp (Central Time, YYYYMMDDHHMM) or the highest earlier build plus one, which is the rebuild case in shared-build.mjs.
 *
 * Usage:
 *   node scripts/ios-fleet/fleet-tf-audit.mjs [--config <file>] [--json] [--repo-heads <file>]
 *
 * --config defaults to fleet-tf-audit.apps.json beside this script.  --repo-heads takes a JSON object that maps an app name to the committer date (ISO string) of that repo's main HEAD.  Credentials come from asc-api.mjs (environment or Infisical through fleet-secrets) and are never printed.  Exit 0 means every app passes, 1 means at least one policy violation, and 2 means an auth or network error stopped the audit.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ascAllRows, ascErrorText, createAscApi } from "./asc-api.mjs";

// An auth or network failure.  The CLI maps it to exit 2, apart from policy violations at exit 1.
export class AuditError extends Error {}

// Wrap an api(method, path, body) client so only GET can ever leave this script.  A non-GET call is refused before the wrapped client runs, so no request is made.
export function createReadOnlyApi(api) {
  return async function readOnlyApi(method, path, body) {
    if (String(method).toUpperCase() !== "GET") {
      throw new Error(`refused non-GET request: ${method} ${path}`);
    }
    return api("GET", path, body);
  };
}

// Dotted numeric version compare.  Returns a negative number, 0, or a positive number.
export function compareVersions(a, b) {
  const x = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const y = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// A build number is a Central Time timestamp when it is 12 digits that name a real calendar minute, YYYYMMDDHHMM.  The calendar check is timezone-free:  the digits either name a real date and time or they do not.
export function isTimestampBuild(value) {
  const v = String(value ?? "");
  if (!/^\d{12}$/.test(v)) return false;
  const year = Number(v.slice(0, 4));
  const month = Number(v.slice(4, 6));
  const day = Number(v.slice(6, 8));
  const hour = Number(v.slice(8, 10));
  const minute = Number(v.slice(10, 12));
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    && d.getUTCHours() === hour && d.getUTCMinutes() === minute;
}

// The numeric key a build number compares by:  its first dotted component as a BigInt, or null when it is not numeric.  This matches shared-build.mjs, so a dotted legacy build still orders sanely.
export function buildNumberKey(value) {
  const first = String(value ?? "").split(".")[0];
  return /^[0-9]+$/.test(first) ? BigInt(first) : null;
}

// The committer-date stamp of an ISO date string in America/Chicago, as YYYYMMDDHHMM.  Intl applies the CDT and CST offsets, so no offset table lives here.
export function centralStamp(iso) {
  const when = new Date(String(iso));
  if (Number.isNaN(when.getTime())) throw new AuditError(`repo-heads: not a valid date: ${iso}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(when);
  const byType = {};
  for (const p of parts) byType[p.type] = p.value;
  return `${byType.year}${byType.month}${byType.day}${byType.hour}${byType.minute}`;
}

// App Store version states that mean the version was approved and released.  This mirrors the released-store-version command in asc-api.mjs, so the two readers agree on what "approved" means.
const RELEASED_STATES = new Set([
  "READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION",
  "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE", "PREORDER_READY_FOR_SALE",
  "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "ACCEPTED",
  "PENDING_CONTRACT", "WAITING_FOR_EXPORT_COMPLIANCE",
  "PROCESSING_FOR_DISTRIBUTION", "PROCESSING_FOR_APP_STORE"
]);

// The highest approved (released) App Store version in appStoreVersions rows for one platform, or "" when none is approved.
export function highestApprovedVersion(rows, platform) {
  let best = "";
  for (const row of rows || []) {
    const a = row?.attributes || {};
    if (platform && a.platform && a.platform !== platform) continue;
    if (!a.versionString) continue;
    const states = [a.appVersionState, a.appStoreState].filter(Boolean);
    if (!states.some((s) => RELEASED_STATES.has(s))) continue;
    if (!best || compareVersions(a.versionString, best) > 0) best = a.versionString;
  }
  return best;
}

// Pure policy check for one app.  buildsByPlatform maps "IOS" and "MAC_OS" to build records sorted newest first, each {version, uploadedDate, processingState, marketingVersion, platform}.  approvedByPlatform maps a platform to its highest approved App Store version, and repoHeadStamp is the HEAD stamp from centralStamp or null.  Returns {platforms, violations, notes, repoHead}:  the audit fetches, this decides, so a test can drive it with stub rows.
export function checkAppBuilds({ expectedMarketingVersion, buildsByPlatform, approvedByPlatform = {}, repoHeadStamp = null }) {
  const violations = [];
  const notes = [];
  const platforms = {};
  const present = Object.keys(buildsByPlatform || {}).filter((p) => (buildsByPlatform[p] || []).length > 0);
  if (present.length === 0) {
    return { platforms, violations: ["no builds found"], notes, repoHead: undefined };
  }
  for (const platform of present) {
    const builds = buildsByPlatform[platform];
    const latest = builds[0];
    let highest = null;
    let highestVersion = "";
    for (const b of builds) {
      const key = buildNumberKey(b.version);
      if (key !== null && (highest === null || key > highest)) {
        highest = key;
        highestVersion = String(b.version);
      }
    }
    const approved = approvedByPlatform[platform] || "";
    platforms[platform] = {
      marketingVersion: latest.marketingVersion || "",
      latestBuild: String(latest.version ?? ""),
      processingState: latest.processingState || "",
      uploadedDate: latest.uploadedDate || "",
      highestBuild: highestVersion,
      approvedVersion: approved
    };
    // (a) Marketing version.  An approved version above the expected one is kept, not flagged.
    if (latest.marketingVersion !== expectedMarketingVersion) {
      if (approved && compareVersions(approved, expectedMarketingVersion) > 0 && latest.marketingVersion === approved) {
        const kept = `kept approved ${approved}`;
        if (!notes.includes(kept)) notes.push(kept);
      } else {
        violations.push(`${platform} marketing version ${latest.marketingVersion || "?"} != expected ${expectedMarketingVersion}`);
      }
    }
    // (b) Latest build number shape.
    if (!isTimestampBuild(latest.version)) {
      violations.push(`${platform} build ${latest.version} is not a 12-digit YYYYMMDDHHMM timestamp`);
    }
    // (d) Build numbers only increase.
    const latestKey = buildNumberKey(latest.version);
    if (latestKey !== null && highest !== null && highest > latestKey) {
      violations.push(`${platform} latest build ${latest.version} is not the highest (${highestVersion} seen)`);
    }
    // (e) Processing finished cleanly.
    if (latest.processingState !== "VALID") {
      violations.push(`${platform} latest build processingState ${latest.processingState || "?"} != VALID`);
    }
  }
  // (c) One release, one build number across platforms.
  const ios = (buildsByPlatform.IOS || [])[0];
  const mac = (buildsByPlatform.MAC_OS || [])[0];
  if (ios && mac && String(ios.version) !== String(mac.version)) {
    violations.push(`iOS/macOS build mismatch: IOS ${ios.version} vs MAC_OS ${mac.version}`);
  }
  // (f) Repo HEAD stamp.  The expected build is the stamp itself, or one above the highest earlier build when the stamp was already taken by an earlier ship of the same commit.
  let repoHead;
  if (repoHeadStamp) {
    const all = present.flatMap((p) => buildsByPlatform[p]);
    const latestOverall = all.reduce((a, b) => (String(b.uploadedDate || "") > String(a.uploadedDate || "") ? b : a));
    const latestVersion = String(latestOverall.version);
    let highestEarlier = null;
    for (const b of all) {
      if (String(b.version) === latestVersion) continue;
      const key = buildNumberKey(b.version);
      if (key !== null && (highestEarlier === null || key > highestEarlier)) highestEarlier = key;
    }
    const plusOne = highestEarlier === null ? null : String(highestEarlier + 1n);
    if (latestVersion === repoHeadStamp) {
      repoHead = { stamp: repoHeadStamp, match: "stamp" };
      notes.push(`repo-head: latest build matches HEAD stamp ${repoHeadStamp}`);
    } else if (plusOne !== null && latestVersion === plusOne) {
      repoHead = { stamp: repoHeadStamp, match: "highest+1" };
      notes.push(`repo-head: latest build is highest+1 (${latestVersion})`);
    } else {
      repoHead = { stamp: repoHeadStamp, match: "mismatch" };
      violations.push(`repo-head mismatch: latest build ${latestVersion} != HEAD stamp ${repoHeadStamp}${plusOne ? ` or highest+1 ${plusOne}` : ""}`);
    }
  }
  return { platforms, violations, notes, repoHead };
}

// Read one App Store Connect app record:  its latest builds with marketing version and platform, plus its App Store versions.  A rejected key or a failed query is an AuditError, because the audit cannot trust a partial read.  A bundle with no exact record resolves to {notFound: true} and the caller reports it as a violation.
async function fetchAscApp({ api, bundleId }) {
  const appsRes = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=50`);
  if (appsRes.status === 401 || appsRes.status === 403) {
    throw new AuditError(`App Store Connect rejected the API key (HTTP ${appsRes.status})`);
  }
  if (!appsRes.ok) throw new AuditError(`apps query failed for ${bundleId}: ${ascErrorText(appsRes)}`);
  // filter[bundleId] is a prefix match on Apple's side, so exact-match the bundle id here.
  const app = (appsRes.parsed?.data || []).find((a) => a?.attributes?.bundleId === bundleId);
  if (!app) return { notFound: true, builds: [], storeRows: [] };
  const buildsRes = await api("GET",
    `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=10&include=preReleaseVersion`);
  if (!buildsRes.ok) throw new AuditError(`builds query failed for ${bundleId}: ${ascErrorText(buildsRes)}`);
  const trainById = new Map();
  for (const inc of buildsRes.parsed?.included || []) {
    if (inc?.type === "preReleaseVersions") trainById.set(inc.id, inc.attributes || {});
  }
  const builds = (buildsRes.parsed?.data || []).map((b) => {
    const train = trainById.get(b?.relationships?.preReleaseVersion?.data?.id) || {};
    return {
      version: b?.attributes?.version ?? "",
      uploadedDate: b?.attributes?.uploadedDate || "",
      processingState: b?.attributes?.processingState || "",
      marketingVersion: train.version || "",
      platform: train.platform || ""
    };
  });
  const store = await ascAllRows({ api, url: `/v1/apps/${app.id}/appStoreVersions?limit=200` });
  if (!store.ok) throw new AuditError(`appStoreVersions query failed for ${bundleId}: ${store.error}`);
  return { notFound: false, builds, storeRows: store.rows };
}

// Audit one config entry.  Distinct bundle ids are resolved as distinct records and their builds are grouped by the platform App Store Connect reports, so a multiplatform record and a paired macOS record take the same path.  A record that only serves one platform still contributes that platform's builds exactly as returned.
export async function auditApp({ api, entry, repoHead }) {
  const readOnly = createReadOnlyApi(api);
  const bundleIds = entry.bundleIds || (entry.bundleId ? { IOS: entry.bundleId } : {});
  const buildsByPlatform = {};
  const storeRows = [];
  const fetchViolations = [];
  for (const bundleId of [...new Set(Object.values(bundleIds).filter(Boolean))]) {
    const found = await fetchAscApp({ api: readOnly, bundleId });
    if (found.notFound) {
      fetchViolations.push(`no App Store Connect app found for bundle ${bundleId}`);
      continue;
    }
    storeRows.push(...found.storeRows);
    for (const b of found.builds) {
      const platform = b.platform || "IOS";
      (buildsByPlatform[platform] ??= []).push(b);
    }
  }
  // Each list arrived newest first per record.  A stable re-sort by uploadedDate keeps that order across records and platforms.
  for (const list of Object.values(buildsByPlatform)) {
    list.sort((a, b) => String(b.uploadedDate || "").localeCompare(String(a.uploadedDate || "")));
  }
  const approvedByPlatform = {};
  for (const platform of Object.keys(buildsByPlatform)) {
    approvedByPlatform[platform] = highestApprovedVersion(storeRows, platform);
  }
  const checked = checkAppBuilds({
    expectedMarketingVersion: entry.expectedMarketingVersion,
    buildsByPlatform,
    approvedByPlatform,
    repoHeadStamp: repoHead ? centralStamp(repoHead) : null
  });
  const violations = [...fetchViolations, ...(fetchViolations.length && checked.violations[0] === "no builds found" ? [] : checked.violations)];
  const allBuilds = Object.values(buildsByPlatform).flat()
    .sort((a, b) => String(b.uploadedDate || "").localeCompare(String(a.uploadedDate || "")));
  const headline = allBuilds[0];
  const result = {
    app: entry.app,
    expectedMarketingVersion: entry.expectedMarketingVersion,
    bundleIds,
    platforms: checked.platforms,
    platformList: Object.keys(checked.platforms),
    marketingVersion: headline?.marketingVersion || "",
    latestBuild: headline ? String(headline.version) : "",
    state: headline?.processingState || "",
    violations,
    notes: checked.notes,
    pass: violations.length === 0
  };
  if (checked.repoHead) result.repoHead = checked.repoHead;
  return result;
}

// Audit every config entry in order.  Sequential reads keep the audit gentle on the App Store Connect rate limit, and the roster is small.
export async function auditFleet({ api, entries, repoHeads = {} }) {
  const results = [];
  for (const entry of entries || []) {
    results.push(await auditApp({ api, entry, repoHead: repoHeads?.[entry.app] }));
  }
  return results;
}

// One line per app:  app, platform(s), marketing version, latest build, state, then PASS or the violations.  Notes ride at the end in parentheses, so "kept approved X" and the repo-head verdict stay on the same line.
export function formatLine(result) {
  const platforms = result.platformList?.length ? result.platformList.join("+") : "-";
  const ios = result.platforms?.IOS;
  const mac = result.platforms?.MAC_OS;
  const build = ios && mac && ios.latestBuild !== mac.latestBuild
    ? `IOS ${ios.latestBuild}/MAC_OS ${mac.latestBuild}`
    : (result.latestBuild || "-");
  const verdict = result.pass ? "PASS" : `FAIL: ${result.violations.join("; ")}`;
  const notes = result.notes?.length ? ` (${result.notes.join("; ")})` : "";
  return `${result.app} ${platforms} v${result.marketingVersion || "-"} build ${build} ${result.state || "-"} ${verdict}${notes}`;
}

function parseArgs(argv) {
  const out = { config: "", json: false, repoHeads: "", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--config" && argv[i + 1]) out.config = argv[++i];
    else if (arg === "--repo-heads" && argv[i + 1]) out.repoHeads = argv[++i];
    else throw new AuditError(`unknown or incomplete argument: ${arg}`);
  }
  return out;
}

const USAGE = "Usage: node scripts/ios-fleet/fleet-tf-audit.mjs [--config <file>] [--json] [--repo-heads <file>]";

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`fleet-tf-audit: ${err.message}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const configPath = args.config || join(dirname(fileURLToPath(import.meta.url)), "fleet-tf-audit.apps.json");
  let entries;
  let repoHeads = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    entries = Array.isArray(parsed) ? parsed : parsed.apps;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("config holds no apps array");
    if (args.repoHeads) repoHeads = JSON.parse(readFileSync(args.repoHeads, "utf8"));
  } catch (err) {
    console.error(`fleet-tf-audit: could not read config: ${err.message}`);
    process.exit(2);
  }
  const client = createAscApi();
  if (!client.ok) {
    console.error(`fleet-tf-audit: ${client.error}`);
    process.exit(2);
  }
  let results;
  try {
    results = await auditFleet({ api: client.api, entries, repoHeads });
  } catch (err) {
    // Auth, HTTP and network failures land here.  Only the message is printed:  it never carries key material or the token.
    console.error(`fleet-tf-audit: ${err?.message || err}`);
    process.exit(2);
  }
  if (args.json) {
    console.log(JSON.stringify({ ok: results.every((r) => r.pass), apps: results }, null, 2));
  } else {
    for (const result of results) console.log(formatLine(result));
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

// Run only when invoked as a script, so a test can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`fleet-tf-audit: ${err?.message || err}`);
    process.exit(2);
  });
}
