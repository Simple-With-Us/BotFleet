// The application menu opens two folders: the app's data directory and the
// log directory.  Both menu items used to reference a DATA_DIR constant that
// was never defined, so clicking either one threw a ReferenceError at click
// time and the menu item was simply dead.
//
// These tests cover the resolver and pin the wiring, so the same class of
// bug (a menu item pointing at an identifier that does not exist) cannot
// come back unnoticed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { botfleetDataDir } from "./app-paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = readFileSync(join(ROOT, "electron/main.mjs"), "utf8");

test("the data directory is ~/.botfleet unless OMB_DATA_DIR overrides it", () => {
  assert.equal(botfleetDataDir({}, "/Users/jay"), join("/Users/jay", ".botfleet"));
  assert.equal(
    botfleetDataDir({ OMB_DATA_DIR: "/Volumes/External/botfleet" }, "/Users/jay"),
    "/Volumes/External/botfleet",
  );
});

test("an empty or whitespace override is unset, not the current directory", () => {
  // `OMB_DATA_DIR=""` used to reach a `??` expression and produce a relative
  // path, which then resolved against whatever directory the process
  // happened to be in.
  assert.equal(botfleetDataDir({ OMB_DATA_DIR: "" }, "/Users/jay"), join("/Users/jay", ".botfleet"));
  assert.equal(botfleetDataDir({ OMB_DATA_DIR: "   " }, "/Users/jay"), join("/Users/jay", ".botfleet"));
  assert.equal(botfleetDataDir({ OMB_DATA_DIR: undefined }, "/Users/jay"), join("/Users/jay", ".botfleet"));
});

test("the application menu opens folders that exist as constants", () => {
  // The bug this pins: `shell.openPath(DATA_DIR)` with no DATA_DIR in scope.
  assert.match(MAIN, /const DATA_DIR = botfleetDataDir\(\);/);
  assert.match(MAIN, /const LOG_DIR = app\.getPath\("logs"\);/);

  // Every shell.openPath target in the menu must be one of those two.
  const targets = [...MAIN.matchAll(/shell\.openPath\(([A-Z_]+)\)/g)].map((match) => match[1]);
  assert.ok(targets.length >= 2, "the menu opens at least the data and logs folders");
  for (const target of targets) {
    assert.ok(
      target === "DATA_DIR" || target === "LOG_DIR",
      `shell.openPath(${target}) must resolve to a defined constant`,
    );
  }
});

test("the log folder item says what it opens", () => {
  // "Open Logs & Data Folder" pointed at the data directory, which is not
  // where the logs live: the harness and the app both write server.log into
  // the OS log dir.
  assert.match(MAIN, /label: "Open Logs Folder"[\s\S]{0,120}shell\.openPath\(LOG_DIR\)/);
  assert.match(MAIN, /label: "Open Data Folder"[\s\S]{0,120}shell\.openPath\(DATA_DIR\)/);
});
