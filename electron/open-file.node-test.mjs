import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { parseExternalHttpUrl, windowOpenExternalUrl } from "./external-url.mjs";
import { mayOpenBotFile, resolveOpenablePath } from "./open-file.mjs";

let home;
let botHome;
let insideFile;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omb-open-file-"));
  botHome = path.join(home, ".botfleet");
  fs.mkdirSync(path.join(botHome, "workspaces", "bot"), { recursive: true });
  insideFile = path.join(botHome, "workspaces", "bot", "report.docx");
  fs.writeFileSync(insideFile, "docx");
  fs.writeFileSync(path.join(home, "secret.txt"), "private");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("window-open http(s) allowlist", () => {
  it("accepts ordinary http and https URLs", () => {
    assert.equal(parseExternalHttpUrl("https://example.com/docs").toString(), "https://example.com/docs");
    assert.equal(parseExternalHttpUrl("http://127.0.0.1:8799/").toString(), "http://127.0.0.1:8799/");
    assert.equal(windowOpenExternalUrl("https://botfleet.app"), "https://botfleet.app/");
  });

  it("denies javascript:, file:, and other non-web schemes without opening them", () => {
    assert.equal(windowOpenExternalUrl("javascript:alert(1)"), null);
    assert.equal(windowOpenExternalUrl("file:///etc/passwd"), null);
    assert.equal(windowOpenExternalUrl("data:text/html,hello"), null);
    assert.equal(windowOpenExternalUrl("mailto:you@example.com"), null);
    assert.throws(() => parseExternalHttpUrl("javascript:alert(1)"), { message: "Only web links can be opened" });
    assert.throws(() => parseExternalHttpUrl("file:///tmp/report.docx"), { message: "Only web links can be opened" });
  });

  it("rejects missing and malformed addresses", () => {
    assert.equal(windowOpenExternalUrl(""), null);
    assert.equal(windowOpenExternalUrl("not a url"), null);
    assert.throws(() => parseExternalHttpUrl(null), { message: "A web address is required" });
    assert.throws(() => parseExternalHttpUrl("not a url"), { message: "That web address is invalid" });
  });
});

describe("open-file / show-in-folder path confinement", () => {
  it("accepts a file inside ~/.botfleet as a path or a file:// URL via fileURLToPath", async () => {
    const expected = await fs.promises.realpath(insideFile);
    assert.equal(await resolveOpenablePath(insideFile, { home }), expected);
    assert.equal(await resolveOpenablePath(pathToFileURL(insideFile).href, { home }), expected);
  });

  it("rejects a file outside ~/.botfleet, including via traversal", async () => {
    const rejected = "Only files created by your bots can be opened";
    await assert.rejects(resolveOpenablePath(path.join(home, "secret.txt"), { home }), { message: rejected });
    await assert.rejects(resolveOpenablePath(path.join(botHome, "..", "secret.txt"), { home }), { message: rejected });
    await assert.rejects(resolveOpenablePath(pathToFileURL(path.join(home, "secret.txt")).href, { home }), {
      message: rejected,
    });
  });

  it("rejects empty, relative, and missing targets instead of opening them", async () => {
    await assert.rejects(resolveOpenablePath("", { home }), { message: "A file path is required" });
    await assert.rejects(resolveOpenablePath("workspaces/bot/report.docx", { home }), {
      message: "That file path is invalid",
    });
    await assert.rejects(resolveOpenablePath(path.join(botHome, "missing.docx"), { home }), {
      message: "That file no longer exists",
    });
  });
});

// OS openers execute these on at least one supported desktop platform.
assert.equal(mayOpenBotFile("/tmp/report.pdf"), true);
for (const unsafe of ["run.command", "run.sh", "run.bat", "run.cmd", "run.js", "run.ps1", "run.exe", "run.desktop", "run.app", "run.html"]) {
  assert.equal(mayOpenBotFile(`/tmp/${unsafe}`), false);
}
