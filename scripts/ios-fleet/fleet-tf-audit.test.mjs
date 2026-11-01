import test from "node:test";
import assert from "node:assert/strict";

import {
  auditFleet,
  centralStamp,
  createReadOnlyApi,
  formatLine,
  isTimestampBuild
} from "./fleet-tf-audit.mjs";

// Fully offline:  the fake api(method, path) below stands in for the App Store Connect client from asc-api.mjs.  It records every method it sees, so a test can prove the audit only ever sends GET.
function makeFake(records) {
  const calls = [];
  const byAppId = new Map();
  for (const [bundleId, spec] of Object.entries(records)) byAppId.set(`app-${bundleId}`, spec);
  const ok = (parsed) => ({ status: 200, ok: true, parsed, text: JSON.stringify(parsed) });
  async function api(method, path) {
    calls.push({ method, path });
    const url = new URL(path, "https://api.appstoreconnect.apple.com");
    if (url.pathname === "/v1/apps") {
      const bundleId = url.searchParams.get("filter[bundleId]");
      const data = records[bundleId]
        ? [{ id: `app-${bundleId}`, type: "apps", attributes: { bundleId } }]
        : [];
      return ok({ data, links: {} });
    }
    if (url.pathname === "/v1/builds") {
      const spec = byAppId.get(url.searchParams.get("filter[app]")) || { builds: [] };
      const included = [];
      const seenTrain = new Set();
      const data = (spec.builds || []).map((b, i) => {
        const trainId = `train-${b.platform || "IOS"}-${b.marketing || "0.1.0"}`;
        if (!seenTrain.has(trainId)) {
          seenTrain.add(trainId);
          included.push({
            id: trainId, type: "preReleaseVersions",
            attributes: { version: b.marketing || "0.1.0", platform: b.platform || "IOS" }
          });
        }
        return {
          id: `build-${i}`, type: "builds",
          attributes: {
            version: b.version,
            uploadedDate: b.uploadedDate,
            processingState: b.state || "VALID"
          },
          relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: trainId } } }
        };
      });
      return ok({ data, included, links: {} });
    }
    const store = url.pathname.match(/^\/v1\/apps\/(.+)\/appStoreVersions$/);
    if (store) {
      const spec = byAppId.get(store[1]) || {};
      const data = (spec.store || []).map((s, i) => ({
        id: `store-${i}`, type: "appStoreVersions",
        attributes: {
          versionString: s.version,
          platform: s.platform || "IOS",
          appStoreState: s.state || "READY_FOR_SALE"
        }
      }));
      return ok({ data, links: {} });
    }
    return { status: 404, ok: false, parsed: { errors: [{ code: "NOT_FOUND", detail: url.pathname }] }, text: "" };
  }
  return { api, calls };
}

const entry = (over = {}) => ({
  app: "TestApp",
  expectedMarketingVersion: "0.1.0",
  bundleIds: { IOS: "com.example.test" },
  ...over
});
const B = (version, uploadedDate, over = {}) => ({ version, uploadedDate, ...over });
const good = [
  B("202610291200", "2026-10-29T17:05:00Z"),
  B("202610281200", "2026-10-28T17:05:00Z")
];

test("all-pass: expected marketing, timestamp build, highest, VALID", async () => {
  const { api, calls } = makeFake({ "com.example.test": { builds: good } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, true);
  assert.deepEqual(r.violations, []);
  assert.equal(r.marketingVersion, "0.1.0");
  assert.equal(r.latestBuild, "202610291200");
  assert.equal(r.state, "VALID");
  assert.match(formatLine(r), /PASS/);
  assert.ok(calls.length > 0 && calls.every((c) => c.method === "GET"), "audit must only issue GET");
});

test("wrong marketing version is a violation", async () => {
  const builds = [B("202610291200", "2026-10-29T17:05:00Z", { marketing: "1.0.2" })];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /marketing version 1\.0\.2 != expected 0\.1\.0/.test(v)), r.violations.join(" | "));
});

test("an approved App Store version above the expected one is kept, not flagged", async () => {
  const builds = [B("202610291200", "2026-10-29T17:05:00Z", { marketing: "1.2.0" })];
  const store = [{ version: "1.2.0" }];
  const { api } = makeFake({ "com.example.test": { builds, store } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, true);
  assert.ok(r.notes.includes("kept approved 1.2.0"), r.notes.join(" | "));
  assert.match(formatLine(r), /kept approved 1\.2\.0/);
});

test("non-timestamp build number is a violation", async () => {
  const builds = [B("42", "2026-10-29T17:05:00Z")];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /build 42 is not a 12-digit/.test(v)), r.violations.join(" | "));
});

test("iOS/macOS build mismatch is a violation", async () => {
  const builds = [
    B("202610291200", "2026-10-29T17:05:00Z", { platform: "IOS" }),
    B("202610291159", "2026-10-29T17:04:00Z", { platform: "MAC_OS" })
  ];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, false);
  assert.deepEqual(r.platformList.sort(), ["IOS", "MAC_OS"]);
  assert.ok(r.violations.some((v) => /iOS\/macOS build mismatch: IOS 202610291200 vs MAC_OS 202610291159/.test(v)), r.violations.join(" | "));
});

test("latest uploaded build that is not the highest is a violation", async () => {
  const builds = [
    B("202610291200", "2026-10-29T17:05:00Z"),
    B("202610291300", "2026-10-28T17:05:00Z")
  ];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /latest build 202610291200 is not the highest \(202610291300 seen\)/.test(v)), r.violations.join(" | "));
});

test("PROCESSING latest build is a violation", async () => {
  const builds = [B("202610291200", "2026-10-29T17:05:00Z", { state: "PROCESSING" })];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()] });
  assert.equal(r.pass, false);
  assert.equal(r.state, "PROCESSING");
  assert.ok(r.violations.some((v) => /processingState PROCESSING != VALID/.test(v)), r.violations.join(" | "));
});

test("non-GET requests are refused before the request layer runs", async () => {
  const { api, calls } = makeFake({});
  const readOnly = createReadOnlyApi(api);
  await assert.rejects(readOnly("POST", "/v1/apps", "{}"), /refused non-GET request: POST/);
  await assert.rejects(readOnly("DELETE", "/v1/builds/1"), /refused non-GET request: DELETE/);
  assert.deepEqual(calls, []);
});

test("repo-heads: latest build equal to the HEAD Central Time stamp passes", async () => {
  // 2026-10-29T17:00:00Z is 12:00 in America/Chicago (CDT, UTC-5).
  const { api } = makeFake({ "com.example.test": { builds: good } });
  const [r] = await auditFleet({ api, entries: [entry()], repoHeads: { TestApp: "2026-10-29T17:00:00.000Z" } });
  assert.equal(r.pass, true);
  assert.deepEqual(r.repoHead, { stamp: "202610291200", match: "stamp" });
});

test("repo-heads: latest build at highest+1 passes (the rebuild case)", async () => {
  const builds = [
    B("202610291201", "2026-10-29T18:05:00Z"),
    B("202610291200", "2026-10-29T17:05:00Z"),
    B("202610281200", "2026-10-28T17:05:00Z")
  ];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()], repoHeads: { TestApp: "2026-10-29T17:00:00.000Z" } });
  assert.equal(r.pass, true);
  assert.deepEqual(r.repoHead, { stamp: "202610291200", match: "highest+1" });
});

test("repo-heads: a build that matches neither the stamp nor highest+1 is a violation", async () => {
  const builds = [
    B("202610291205", "2026-10-29T18:05:00Z"),
    B("202610291200", "2026-10-29T17:05:00Z")
  ];
  const { api } = makeFake({ "com.example.test": { builds } });
  const [r] = await auditFleet({ api, entries: [entry()], repoHeads: { TestApp: "2026-10-29T17:00:00.000Z" } });
  assert.equal(r.pass, false);
  assert.equal(r.repoHead?.match, "mismatch");
  assert.ok(r.violations.some((v) => /repo-head mismatch/.test(v)), r.violations.join(" | "));
});

test("centralStamp applies the CST offset and isTimestampBuild checks the calendar", () => {
  // 2026-01-15T18:30:00Z is 12:30 in America/Chicago (CST, UTC-6).
  assert.equal(centralStamp("2026-01-15T18:30:00.000Z"), "202601151230");
  assert.equal(isTimestampBuild("202610291200"), true);
  assert.equal(isTimestampBuild("202613011200"), false);
  assert.equal(isTimestampBuild("202610291260"), false);
  assert.equal(isTimestampBuild("20261029120"), false);
});
