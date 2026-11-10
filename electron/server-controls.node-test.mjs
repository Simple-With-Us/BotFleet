import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { controlRelease, installServerControls, openServerControls, shutdownAttachedServer, updateServerControls } from "./server-controls.mjs";

test("desktop quit uses the protected all-VM shutdown and surfaces a refusal", async () => {
  let sent;
  const request = async (url, options) => {
    sent = { url, options };
    return { ok: false, json: async () => ({ error: "a bot is active" }) };
  };
  await assert.rejects(shutdownAttachedServer(28799, { request }), /a bot is active/);
  assert.equal(sent.url, "http://127.0.0.1:28799/api/system/control/stop");
  assert.equal(sent.options.headers["Content-Type"], "application/json");
  assert.equal(sent.options.redirect, "error");
  await assert.rejects(shutdownAttachedServer(28799, { request: async () => ({ ok: true, json: async () => ({ ok: false }) }) }), /did not confirm/);
});

test("desktop quit waits for Local VM shutdown beyond two seconds", async () => {
  await shutdownAttachedServer(28799, {
    request: async (_url, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2_500);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
});

test("desktop quit accepts an already stopped server but preserves uncertain failures", async () => {
  await shutdownAttachedServer(28799, {
    request: async () => { throw new TypeError("fetch failed: ECONNREFUSED"); },
  });
  await assert.rejects(shutdownAttachedServer(28799, {
    request: async () => { throw new DOMException("The request timed out", "TimeoutError"); },
  }), /timed out/);
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "botfleet-control-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.app");
  const applications = path.join(root, "Applications");
  mkdirSync(path.join(source, "Contents"), { recursive: true });
  writeFileSync(path.join(source, "Contents", "Info.plist"), "<string>app.botfleet.control.macos</string>");
  return { source, applications, root, target: path.join(applications, "BotFleet Control.app") };
}

test("explicit installation preserves an active app and updates it after exit", (t) => {
  const f = fixture(t);
  assert.equal(installServerControls(f.source, { applications: f.applications, isRunning: () => false }), f.target);
  writeFileSync(path.join(f.target, "running-state"), "keep");
  writeFileSync(path.join(f.source, "new-version"), "new");
  installServerControls(f.source, { applications: f.applications, isRunning: () => true });
  assert.equal(readFileSync(path.join(f.target, "running-state"), "utf8"), "keep");
  installServerControls(f.source, { applications: f.applications, isRunning: () => false });
  assert.equal(readFileSync(path.join(f.target, "new-version"), "utf8"), "new");
});

test("installation refuses an unrelated bundle or a symlink", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  mkdirSync(f.applications);
  symlinkSync(f.source, f.target);
  assert.throws(() => installServerControls(f.source, { applications: f.applications }), /regular app bundle/);
  rmSync(f.target);
  mkdirSync(path.join(f.target, "Contents"), { recursive: true });
  writeFileSync(path.join(f.target, "Contents", "Info.plist"), "unrelated app");
  assert.throws(() => installServerControls(f.source, { applications: f.applications }), /Unexpected control app identity/);
  rmSync(path.join(f.target, "Contents", "Info.plist"));
  symlinkSync(path.join(f.source, "Contents", "Info.plist"), path.join(f.target, "Contents", "Info.plist"));
  assert.throws(() => installServerControls(f.source, { applications: f.applications }));
});

test("opening an unavailable control app reports failure without launching anything", async () => {
  let message;
  await openServerControls({
    source: "/nonexistent-botfleet-fixture.app",
    shell: { openPath: () => assert.fail("must not launch on install failure") },
    dialog: { showErrorBox: (title, detail) => { message = { title, detail }; } },
  });
  assert.equal(message.title, "Could Not Open Server Controls");
});

function writeRelease(bundle, version, build) {
  writeFileSync(path.join(bundle, "Contents", "Info.plist"), `<plist><dict>
<key>CFBundleIdentifier</key><string>app.botfleet.control.macos</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
</dict></plist>`);
}

function updateFixture(t) {
  const f = fixture(t);
  writeRelease(f.source, "1.0.9", "9");
  installServerControls(f.source, { applications: f.applications, isRunning: () => false });
  writeRelease(f.source, "0.1.0", "202610301230");
  return f;
}

test("an update cancellation never quits Control or modifies its installed bundle", async (t) => {
  const f = updateFixture(t);
  const updated = await updateServerControls({
    ...f,
    isRunning: () => true,
    requestQuit: () => assert.fail("cancel must not quit Control"),
    shell: { openPath: () => assert.fail("cancel must not open a bundle") },
    dialog: {
      showMessageBox: async (options) => { assert.equal(options.defaultId, options.cancelId); return { response: 0 }; },
      showErrorBox: () => assert.fail("cancel is not an error"),
    },
  });
  assert.equal(updated, false);
  assert.equal(controlRelease(f.target).build, "9");
});

test("an explicit update waits for normal exit then installs the newer numeric build and reopens", async (t) => {
  const f = updateFixture(t);
  let running = true;
  const calls = [];
  const savedHosts = path.join(f.root, "control-hosts.json");
  writeFileSync(savedHosts, "private fixture hosts and tokens", { mode: 0o600 });
  assert.equal(await updateServerControls({
    ...f,
    isRunning: () => running,
    requestQuit: () => { calls.push("quit"); assert.equal(controlRelease(f.target).build, "9"); },
    sleep: async () => { calls.push("observed exit"); running = false; },
    shell: { openPath: async (target) => { calls.push("open"); assert.equal(target, f.target); return ""; } },
    dialog: {
      showMessageBox: async () => { calls.push("selected update"); return { response: 1 }; },
      showErrorBox: (_title, detail) => assert.fail(detail),
    },
  }), true);
  assert.deepEqual(calls, ["selected update", "quit", "observed exit", "open"]);
  assert.deepEqual(controlRelease(f.target), { version: "0.1.0", build: "202610301230" });
  assert.equal(readFileSync(savedHosts, "utf8"), "private fixture hosts and tokens");
});

test("an app that refuses to quit is never replaced or forcibly killed", async (t) => {
  const f = updateFixture(t);
  let message;
  let waits = 0;
  const updated = await updateServerControls({
    ...f, isRunning: () => true, requestQuit: () => {}, sleep: async () => { waits += 1; },
    shell: { openPath: () => assert.fail("a running app must not be replaced") },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showErrorBox: (_title, detail) => { message = detail; },
    },
  });
  assert.equal(updated, false);
  assert.equal(waits, 40);
  assert.match(message, /did not quit/);
  assert.equal(controlRelease(f.target).build, "9");
});

test("the installer refuses Control restarting between exit observation and replacement", async (t) => {
  const f = updateFixture(t);
  let probes = 0;
  let message;
  const updated = await updateServerControls({
    ...f,
    isRunning: () => { probes += 1; return probes === 1 || probes >= 4; },
    requestQuit: () => {},
    shell: { openPath: () => assert.fail("a restarted app must not be replaced") },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showErrorBox: (_title, detail) => { message = detail; },
    },
  });
  assert.equal(updated, false);
  assert.match(message, /still running/);
  assert.equal(controlRelease(f.target).build, "9");
});

test("the staged installer rechecks for a restart before replacing the bundle", (t) => {
  const f = updateFixture(t);
  let probes = 0;
  assert.throws(() => installServerControls(f.source, {
    applications: f.applications,
    isRunning: () => { probes += 1; return probes > 1; },
    requireStopped: true,
    expectedRelease: controlRelease(f.source),
  }), /restarted while its update was staged/);
  assert.equal(controlRelease(f.target).build, "9");
});

test("an older, equal, unknown or unavailable bundled release refuses before quitting", async (t) => {
  const f = updateFixture(t);
  for (const [version, build] of [["1.0.8", "8"], ["1.0.9", "9"], ["unknown", "999"], ["0.1.0", "unknown"]]) {
    writeRelease(f.source, version, build);
    let message;
    assert.equal(await updateServerControls({
      ...f,
      isRunning: () => assert.fail("preflight must happen before process operations"),
      requestQuit: () => assert.fail("an unsuitable release must not quit Control"),
      shell: { openPath: () => assert.fail("an unsuitable release must not open") },
      dialog: {
        showMessageBox: () => assert.fail("an unsuitable release must not be offered"),
        showErrorBox: (_title, detail) => { message = detail; },
      },
    }), false);
    assert.match(message, /not newer|unknown/);
    assert.equal(controlRelease(f.target).build, "9");
  }
});

test("a bundled release changing after consent cannot silently select another update", async (t) => {
  const f = updateFixture(t);
  let running = true;
  let message;
  assert.equal(await updateServerControls({
    ...f,
    isRunning: () => running,
    requestQuit: () => { writeRelease(f.source, "0.1.0", "202610301231"); running = false; },
    shell: { openPath: () => assert.fail("the changed release was not selected") },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showErrorBox: (_title, detail) => { message = detail; },
    },
  }), false);
  assert.match(message, /release changed/);
  assert.equal(controlRelease(f.target).build, "9");
});
