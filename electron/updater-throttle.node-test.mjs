// node:test coverage for the 6-hour auto-update throttle and the Mac
// app-bundle fingerprint.  These are pure helpers that live in
// updater-throttle.mjs so they can be exercised without an `electron`
// runtime — updater.mjs itself imports the same module.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_CHECK_FAILURE_BACKOFF_MS,
  AUTO_CHECK_FAILURE_STREAK_THRESHOLD,
  AUTO_CHECK_THROTTLE_MS,
  classifyAutoCheckError,
  isAutoCheckBackoffActive,
  macAppFingerprint,
  nextAutoCheckFailureStreak,
  nextAutoUpdateRecord,
  readAutoUpdateConfig,
  recordAutomaticCheck,
  shouldRunAutomaticCheck,
} from "./updater-throttle.mjs";

test("shouldRunAutomaticCheck allows the first run when no lastCheckMs is recorded", () => {
  assert.equal(shouldRunAutomaticCheck({ enabled: true }), true);
  assert.equal(shouldRunAutomaticCheck({ enabled: true, lastCheckMs: undefined }), true);
  assert.equal(shouldRunAutomaticCheck({ enabled: true, lastCheckMs: -1 }), true);
  assert.equal(shouldRunAutomaticCheck({ enabled: true, lastCheckMs: Number.NaN }), true);
});

test("shouldRunAutomaticCheck blocks a run inside the 6-hour window", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - 1 }, now),
    false,
  );
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - AUTO_CHECK_THROTTLE_MS + 1 }, now),
    false,
  );
});

test("shouldRunAutomaticCheck allows a run after the 6-hour window elapses", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - AUTO_CHECK_THROTTLE_MS }, now),
    true,
  );
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - (AUTO_CHECK_THROTTLE_MS + 60_000) }, now),
    true,
  );
});

test("shouldRunAutomaticCheck refuses to run when the toggle is off", () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldRunAutomaticCheck({ enabled: false, lastCheckMs: now - 30_000 }, now), false);
  assert.equal(shouldRunAutomaticCheck({ enabled: undefined }, now), false);
});

// A changed Mac bundle fingerprint is the "out-of-band reinstall" signal
// nextAutoUpdateRecord stores every cycle (see the tests below) but that,
// before this fix, nothing ever compared against the running app -- so a
// reinstall between checks never bypassed the 6-hour window. Both branches:
// same fingerprint stays throttled, a changed one checks immediately.
test("shouldRunAutomaticCheck stays throttled inside the window when the fingerprint has not changed", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck(
      {
        enabled: true,
        lastCheckMs: now - 30_000,
        lastAppFingerprint: "202609041230:abcdef123456",
        currentFingerprint: "202609041230:abcdef123456",
      },
      now,
    ),
    false,
  );
});

test("shouldRunAutomaticCheck bypasses the 6-hour window when the fingerprint has changed", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck(
      {
        enabled: true,
        // well inside the throttle window -- only the fingerprint mismatch
        // should be why this returns true
        lastCheckMs: now - 30_000,
        lastAppFingerprint: "202609041230:abcdef123456",
        currentFingerprint: "202609051115:different000",
      },
      now,
    ),
    true,
  );
});

test("shouldRunAutomaticCheck ignores the fingerprint fields when either side is missing", () => {
  const now = 1_700_000_000_000;
  // no lastAppFingerprint on record yet (pre-upgrade config, or the bundle
  // could not be read the first time) -- falls back to the plain throttle
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - 30_000, currentFingerprint: "new" }, now),
    false,
  );
  // platform can't compute a fingerprint right now (non-darwin, or the
  // bundle is missing) -- same fallback
  assert.equal(
    shouldRunAutomaticCheck(
      { enabled: true, lastCheckMs: now - 30_000, lastAppFingerprint: "old" },
      now,
    ),
    false,
  );
});

test("AUTO_CHECK_THROTTLE_MS is the documented 6-hour window", () => {
  assert.equal(AUTO_CHECK_THROTTLE_MS, 6 * 60 * 60 * 1000);
});

test("readAutoUpdateConfig returns an empty object on a missing or invalid file", () => {
  const missing = readAutoUpdateConfig("/nonexistent/path/config.json");
  assert.deepEqual(missing, {});
  // The harness's test-floor guard forbids mutating the real config; the
  // empty-object default is what a fresh install would see.
});

test("macAppFingerprint returns null on a non-darwin platform", () => {
  const result = macAppFingerprint({ platform: "linux" });
  assert.equal(result, null);
});

test("macAppFingerprint reads CFBundleVersion and hashes the executable's size+mtime", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>202609041230</string>
</dict>
</plist>`;
  // The function uses node:path's join to compose the Info.plist and exec
  // paths, so on Windows the separator is a backslash and a hard-coded
  // forward-slash string would never match.  Build the expected paths
  // through the same join so the mock stays portable across platforms.
  const bundle = "/Applications/BotFleet.app";
  const infoPlist = join(bundle, "Contents", "Info.plist");
  const execPath = join(bundle, "Contents", "MacOS", "BotFleet");
  const result = macAppFingerprint({
    platform: "darwin",
    candidates: [bundle],
    execPath,
    readVersion: () => "202609041230",
    readFileSync: () => Buffer.from(plist, "utf8"),
    statSync: () => ({ size: 12345, mtimeMs: 1700000000000 }),
    existsSync: (p) => p === infoPlist || p === execPath,
  });
  assert.ok(result);
  assert.equal(result?.startsWith("202609041230:"), true);
  // the hash half is deterministic for the same size+mtime
  assert.equal(result, "202609041230:74f040039bcb");
});

test("macAppFingerprint returns null when the bundle is not installed", () => {
  const result = macAppFingerprint({
    platform: "darwin",
    candidates: ["/Applications/BotFleet.app"],
    execPath: "/Applications/BotFleet.app/Contents/MacOS/BotFleet",
    existsSync: () => false,
  });
  assert.equal(result, null);
});

// Regression: the default exec path used to be hardcoded to the first
// (system-wide) candidate regardless of which bundle Info.plist actually
// came from. A user-local install (~/Applications/BotFleet.app, which
// `candidates` already lists as a fallback) would then always hash a
// nonexistent -- or an unrelated system-wide -- executable, so a local
// rebuild that kept the same CFBundleVersion could never be told apart
// from the previous run for that install. This exercises the DEFAULT
// execPath derivation (no explicit `execPath` override) against the
// second candidate to prove it now follows the bundle Info.plist matched.
test("macAppFingerprint hashes the executable from the SAME bundle Info.plist matched, not a hardcoded system path", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>202609041230</string>
</dict>
</plist>`;
  const systemBundle = "/Applications/BotFleet.app";
  const userBundle = "/Users/operator/Applications/BotFleet.app";
  const systemInfoPlist = join(systemBundle, "Contents", "Info.plist");
  const userInfoPlist = join(userBundle, "Contents", "Info.plist");
  const userExecPath = join(userBundle, "Contents", "MacOS", "BotFleet");
  // No `execPath` override here -- this is exactly what a real boot does:
  // only `candidates` are supplied, so the function must derive execPath
  // itself from whichever candidate's Info.plist it found.
  const result = macAppFingerprint({
    platform: "darwin",
    candidates: [systemBundle, userBundle],
    readVersion: () => "202609041230",
    readFileSync: () => Buffer.from(plist, "utf8"),
    // Only the user-local bundle exists on disk -- the system-wide
    // candidate is absent, so resolution must fall through to the second
    // candidate for BOTH the Info.plist read and the exec-path default.
    existsSync: (p) => p === userInfoPlist || p === userExecPath,
    statSync: (p) => {
      assert.equal(p, userExecPath, "must stat the executable under the matched (user) bundle, not the system one");
      return { size: 999, mtimeMs: 1700000000000 };
    },
  });
  assert.ok(result);
  assert.equal(result, "202609041230:" + createHash("sha1").update("999:1700000000000").digest("hex").slice(0, 12));
});

// Round 2 of review on the fix above: fixing WHICH bundle's executable gets
// hashed (the one Info.plist matched) still leaves a second bug when TWO
// installs coexist on the same Mac -- a fresh drag-install into
// ~/Applications alongside an old /Applications copy, say. The static
// candidate order checks /Applications first, so it would fingerprint that
// dormant copy even while the user is actually running the ~/Applications
// one. This exercises the real default-candidates path (no `candidates`
// override) with BOTH bundles present on disk, and only `processExecPath`
// (the process.execPath override) pointing at the user-local one, to prove
// the running bundle wins the race regardless of list order.
test("macAppFingerprint prefers the bundle the process is actually running from over a static candidate order", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>202609041230</string>
</dict>
</plist>`;
  const systemBundle = "/Applications/BotFleet.app";
  const userBundle = "/Users/operator/Applications/BotFleet.app";
  const systemInfoPlist = join(systemBundle, "Contents", "Info.plist");
  const userInfoPlist = join(userBundle, "Contents", "Info.plist");
  const userExecPath = join(userBundle, "Contents", "MacOS", "BotFleet");
  const result = macAppFingerprint({
    platform: "darwin",
    home: "/Users/operator",
    processExecPath: userExecPath,
    readVersion: () => "202609041230",
    readFileSync: () => Buffer.from(plist, "utf8"),
    // both bundles are "installed" -- the static list alone would pick the
    // system-wide one first
    existsSync: (p) => p === systemInfoPlist || p === userInfoPlist || p === userExecPath,
    statSync: (p) => {
      assert.equal(
        p,
        userExecPath,
        "must stat the executable under the RUNNING (user-local) bundle, not the system one that happens to come first",
      );
      return { size: 777, mtimeMs: 1700000000000 };
    },
  });
  assert.ok(result);
  assert.equal(result, "202609041230:" + createHash("sha1").update("777:1700000000000").digest("hex").slice(0, 12));
});

test("macAppFingerprint falls back to the static candidate list when process.execPath is not a recognizable app bundle", () => {
  // A dev/unpackaged run (or any execPath that doesn't parse as
  // .../Contents/MacOS/<name>) must not throw or silently misbehave --
  // it just has nothing to prefer, so the static list still applies.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>202609041230</string>
</dict>
</plist>`;
  const bundle = "/Applications/BotFleet.app";
  const infoPlist = join(bundle, "Contents", "Info.plist");
  const execPath = join(bundle, "Contents", "MacOS", "BotFleet");
  const result = macAppFingerprint({
    platform: "darwin",
    home: "/Users/operator",
    processExecPath: "/usr/local/bin/node",
    readVersion: () => "202609041230",
    readFileSync: () => Buffer.from(plist, "utf8"),
    existsSync: (p) => p === infoPlist || p === execPath,
    statSync: () => ({ size: 111, mtimeMs: 1700000000000 }),
  });
  assert.ok(result);
  assert.equal(result, "202609041230:" + createHash("sha1").update("111:1700000000000").digest("hex").slice(0, 12));
});

test("nextAutoUpdateRecord stamps lastCheckMs and preserves enabled", () => {
  const now = 1_700_000_000_000;
  const next = nextAutoUpdateRecord({ enabled: true, lastAppFingerprint: "old" }, { nowMs: now, fingerprint: "new" });
  assert.equal(next.enabled, true);
  assert.equal(next.lastCheckMs, now);
  assert.equal(next.lastAppFingerprint, "new");
});

test("nextAutoUpdateRecord omits the fingerprint when the bundle is not present", () => {
  const now = 1_700_000_000_000;
  const next = nextAutoUpdateRecord({ enabled: false }, {
    nowMs: now,
    fingerprint: null,
  });
  assert.equal(next.enabled, false);
  assert.equal(next.lastCheckMs, now);
  assert.equal(next.lastAppFingerprint, undefined);
});

test("nextAutoUpdateRecord omits the fingerprint on a non-darwin host", () => {
  // The test runner runs on the same Mac as the bundled app, so the
  // default fingerprint helper would happily return a real one.  Force
  // the no-bundle path by passing an explicit null fingerprint, which
  // is what the helper does on Linux/Windows.
  const now = 1_700_000_000_000;
  const next = nextAutoUpdateRecord({ enabled: true }, { nowMs: now, fingerprint: null });
  assert.equal(next.enabled, true);
  assert.equal(next.lastCheckMs, now);
  assert.equal(next.lastAppFingerprint, undefined);
});

// `recordAutomaticCheck` is the read-modify-write updater.mjs's
// recordSuccessfulAutoCheck() delegates to.  It used to stop at
// `appendFileSync(path, "")` -- a no-op touch -- so lastCheckMs never
// reached disk and the 6-hour throttle never engaged.  It now goes through
// the cross-process config lock (config-file-lock.mjs, which has its own
// race coverage) and writes only the check record: `enabled` belongs to
// the harness, which persists the Settings toggle through PUT /api/config.
test("recordAutomaticCheck persists lastCheckMs to a fresh config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-throttle-"));
  const configPath = join(dir, "config.json");
  const before = Date.now();
  try {
    recordAutomaticCheck(configPath, { fingerprint: "202609041230:abcdef123456" });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(typeof onDisk.autoUpdate.lastCheckMs, "number");
    assert.ok(onDisk.autoUpdate.lastCheckMs >= before);
    assert.equal(onDisk.autoUpdate.lastAppFingerprint, "202609041230:abcdef123456");
    assert.equal("enabled" in onDisk.autoUpdate, false, "the toggle is the harness's to write");
    assert.equal(readAutoUpdateConfig(configPath).lastCheckMs, onDisk.autoUpdate.lastCheckMs);
    assert.equal(existsSync(`${configPath}.lock`), false, "lock released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordAutomaticCheck merges into an existing config without disturbing other sections or the toggle", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-throttle-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        ingress: { publicUrl: "https://example.test/hook" },
        autoUpdate: { enabled: false, lastCheckMs: 1_600_000_000_000, lastAppFingerprint: "old" },
      }),
    );
    recordAutomaticCheck(configPath, { fingerprint: "new-fingerprint" });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.ingress, { publicUrl: "https://example.test/hook" });
    // Before this fix Electron wrote its own in-memory `enabled` here, so a
    // toggle the user had just switched off could flip back on.
    assert.equal(onDisk.autoUpdate.enabled, false);
    assert.ok(onDisk.autoUpdate.lastCheckMs > 1_600_000_000_000);
    assert.equal(onDisk.autoUpdate.lastAppFingerprint, "new-fingerprint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordAutomaticCheck starts fresh when the config file is missing or unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-throttle-"));
  // A nested, not-yet-created directory -- recordAutomaticCheck must create
  // it rather than fail on a first launch that raced ahead of the harness.
  const configPath = join(dir, "nested", "deeper", "config.json");
  try {
    recordAutomaticCheck(configPath, { fingerprint: null });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(typeof onDisk.autoUpdate.lastCheckMs, "number");
    assert.equal("lastAppFingerprint" in onDisk.autoUpdate, false);

    writeFileSync(configPath, "{ this is not json");
    recordAutomaticCheck(configPath, { fingerprint: "after-garbage" });
    const recovered = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(recovered.autoUpdate.lastAppFingerprint, "after-garbage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// UI4: a permanently broken release feed (e.g. a release missing
// latest-mac.yml) fails every automatic check the same way, forever, and the
// 6-hour throttle above never engages because a failed check is never
// recorded as "last checked" (on purpose -- see updater.mjs's
// recordSuccessfulAutoCheck comment).  These pure helpers back a SEPARATE,
// in-memory backoff in updater.mjs: after AUTO_CHECK_FAILURE_STREAK_THRESHOLD
// consecutive automatic failures with the same classifyAutoCheckError()
// value, back off for AUTO_CHECK_FAILURE_BACKOFF_MS.
test("classifyAutoCheckError groups electron-updater's HttpError by name and status", () => {
  const httpError = Object.assign(new Error("HTTP error: 404"), { name: "HttpError", statusCode: 404 });
  assert.equal(classifyAutoCheckError(httpError), "HttpError:404");
  // A different status is a different class -- a 404 today and a 503
  // tomorrow is not "the same problem happening again".
  const other = Object.assign(new Error("HTTP error: 503"), { name: "HttpError", statusCode: 503 });
  assert.equal(classifyAutoCheckError(other), "HttpError:503");
});

test("classifyAutoCheckError falls back from statusCode to status to code, then to a bare name", () => {
  assert.equal(classifyAutoCheckError(Object.assign(new Error("x"), { name: "E", status: 500 })), "E:500");
  assert.equal(classifyAutoCheckError(Object.assign(new Error("x"), { name: "E", code: "ECONNRESET" })), "E:ECONNRESET");
  assert.equal(classifyAutoCheckError(new TypeError("network down")), "TypeError");
  assert.equal(classifyAutoCheckError(new Error("plain")), "Error");
});

test("classifyAutoCheckError never throws on a non-Error rejection", () => {
  assert.equal(classifyAutoCheckError(null), "unknown");
  assert.equal(classifyAutoCheckError(undefined), "unknown");
  assert.equal(classifyAutoCheckError("offline"), "offline");
  assert.equal(classifyAutoCheckError(42), "42");
});

test("nextAutoCheckFailureStreak counts up on a repeated class and resets on a different one", () => {
  let streak = null;
  streak = nextAutoCheckFailureStreak(streak, "HttpError:404");
  assert.deepEqual(streak, { errorClass: "HttpError:404", count: 1 });
  streak = nextAutoCheckFailureStreak(streak, "HttpError:404");
  assert.deepEqual(streak, { errorClass: "HttpError:404", count: 2 });

  // A transient, differently-shaped failure in between must not extend the
  // streak toward backoff -- that is the "keep the transient-failure path
  // unchanged" half of the fix.
  streak = nextAutoCheckFailureStreak(streak, "TypeError");
  assert.deepEqual(streak, { errorClass: "TypeError", count: 1 });
});

test("isAutoCheckBackoffActive fires only once the streak reaches the threshold", () => {
  assert.equal(isAutoCheckBackoffActive(null), false);
  let streak = null;
  for (let i = 0; i < AUTO_CHECK_FAILURE_STREAK_THRESHOLD - 1; i += 1) {
    streak = nextAutoCheckFailureStreak(streak, "HttpError:404");
    assert.equal(isAutoCheckBackoffActive(streak), false, `after ${i + 1} failures`);
  }
  streak = nextAutoCheckFailureStreak(streak, "HttpError:404");
  assert.equal(streak.count, AUTO_CHECK_FAILURE_STREAK_THRESHOLD);
  assert.equal(isAutoCheckBackoffActive(streak), true);
});

test("the failure backoff window documents one check per day", () => {
  assert.equal(AUTO_CHECK_FAILURE_BACKOFF_MS, 24 * 60 * 60 * 1000);
  assert.ok(AUTO_CHECK_FAILURE_BACKOFF_MS > AUTO_CHECK_THROTTLE_MS, "backoff must be a longer wait than the normal throttle");
});
