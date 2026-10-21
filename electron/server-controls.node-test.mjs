import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installServerControls, openServerControls, shutdownAttachedServer } from "./server-controls.mjs";

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
