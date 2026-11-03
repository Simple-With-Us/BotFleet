import assert from "node:assert/strict";
import fs, { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDesktopStartupRequest, desktopStartupReceiptPath, desktopStartupUiPort, readDesktopStartupReceipt, writeDesktopStartupReceipt } from "./desktop-startup-receipt.mjs";

const BUILD = { app: "botfleet", sourceCommit: "a".repeat(40), sourceDirty: false,
  version: "0.1.0", apiVersion: 1, uiHash: "b".repeat(64), build: "202611031234" };
const OPTIONS = { pid: 12345, mode: "local", uiPort: 54321 };
const GENERIC = { message: "Invalid desktop startup receipt" };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-startup-receipt-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "desktop-startup.json") };
}

function store(file, value) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

test("loopback UI origins retain the effective HTTP port including normalized default 80", () => {
  for (const origin of ["http://127.0.0.1", "http://127.0.0.1:80/"]) assert.equal(desktopStartupUiPort(origin), 80);
  assert.equal(desktopStartupUiPort("http://127.0.0.1:18799/"), 18799);
  for (const origin of ["https://127.0.0.1", "http://localhost:8799", "http://example.com:8799", "http://user@127.0.0.1:8799", "http://127.0.0.1:0", "http://127.0.0.1:65536", "invalid"]) {
    assert.throws(() => desktopStartupUiPort(origin), GENERIC);
  }
});

test("argv accepts one absolute normalized fixed-basename flag", () => {
  const file = join(tmpdir(), "private", "desktop-startup.json");
  assert.equal(desktopStartupReceiptPath(["app", "unrelated"]), null);
  assert.equal(desktopStartupReceiptPath(["app", `--update-startup-receipt=${file}`]), file);
  for (const args of [
    ["--update-startup-receipt"], ["--update-startup-receipt="],
    ["--update-startup-receipt=desktop-startup.json"],
    ["--update-startup-receipt=/private/other.json"],
    ["--update-startup-receipt=/private/../desktop-startup.json"],
    ["--update-startup-receipt=/private//desktop-startup.json"],
    [`--update-startup-receipt=${file}`, `--update-startup-receipt=${file}`],
    [`--update-startup-receipt=${file}`, "--update-startup-receipt"],
    ["--update-startup-receipt=/private/\0/desktop-startup.json"], [null],
  ]) assert.throws(() => desktopStartupReceiptPath(args), GENERIC);
});

test("request creation is exclusive and private, and persists no build metadata", (t) => {
  const { file } = fixture(t);
  const request = createDesktopStartupRequest(file, BUILD);
  const disk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(disk).sort(), ["kind", "requestId", "schemaVersion", "sourceCommit"]);
  assert.equal(disk.kind, "request");
  assert.match(disk.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(disk.sourceCommit, BUILD.sourceCommit);
  assert.equal(lstatSync(file).mode & 0o7777, 0o600);
  assert.equal(lstatSync(file).nlink, 1);
  assert.equal(readDesktopStartupReceipt(file, request), null);
  assert.throws(() => createDesktopStartupRequest(file, BUILD), GENERIC);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), disk);
});

for (const mode of ["local", "remote"]) {
  test(`${mode} UI receipt binds request, build identity, process and port on the same inode`, (t) => {
    const { file } = fixture(t);
    const request = createDesktopStartupRequest(file, BUILD);
    const before = lstatSync(file);
    const receipt = writeDesktopStartupReceipt(file, { ...BUILD, token: "must-not-be-written", endpoint: "must-not-be-written" }, { ...OPTIONS, mode });
    assert.deepEqual(readDesktopStartupReceipt(file, request), receipt);
    assert.equal(receipt.requestId, request.requestId);
    assert.equal(receipt.app, "botfleet-desktop");
    assert.equal(receipt.mode, mode);
    assert.equal(receipt.pid, OPTIONS.pid);
    assert.equal(receipt.uiPort, OPTIONS.uiPort);
    assert.equal(receipt.build, BUILD.build);
    assert.equal(before.ino, lstatSync(file).ino);
    assert.equal(before.dev, lstatSync(file).dev);
    assert.equal(readFileSync(file, "utf8").includes("must-not-be-written"), false);
    assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  });
}

test("build-less clean packaged identity and the default current PID are supported", (t) => {
  const { file } = fixture(t);
  const build = { ...BUILD };
  delete build.build;
  const request = createDesktopStartupRequest(file, build);
  const receipt = writeDesktopStartupReceipt(file, build, { mode: "remote", uiPort: 1234 });
  assert.equal(receipt.pid, process.pid);
  assert.equal(Object.hasOwn(receipt, "build"), false);
  assert.deepEqual(readDesktopStartupReceipt(file, request), receipt);
});

test("reader compares explicit candidate fields even when the on-disk request only carries commit", (t) => {
  const { file } = fixture(t);
  const request = createDesktopStartupRequest(file, { sourceCommit: BUILD.sourceCommit });
  writeDesktopStartupReceipt(file, BUILD, OPTIONS);
  for (const [key, value] of [["sourceCommit", "d".repeat(40)], ["version", "0.1.1"], ["apiVersion", 2], ["uiHash", "e".repeat(64)], ["build", "202611031235"]]) {
    assert.throws(() => readDesktopStartupReceipt(file, request, { ...BUILD, [key]: value }), GENERIC);
  }
  assert.equal(readDesktopStartupReceipt(file, request, BUILD).sourceCommit, BUILD.sourceCommit);
});

test("unsafe or missing parent directories are rejected without creating a receipt", (t) => {
  const { dir, file } = fixture(t);
  const missing = join(dir, "missing", "desktop-startup.json");
  assert.throws(() => createDesktopStartupRequest(missing, BUILD), GENERIC);
  for (const mode of [0o755, 0o770, 0o777, 0o1700]) {
    chmodSync(dir, mode);
    assert.throws(() => createDesktopStartupRequest(file, BUILD), GENERIC);
  }
  chmodSync(dir, 0o700);
  const target = join(dir, "target");
  mkdirSync(target, { mode: 0o700 });
  const alias = join(dir, "alias");
  symlinkSync(target, alias);
  assert.throws(() => createDesktopStartupRequest(join(alias, "desktop-startup.json"), BUILD), GENERIC);
  assert.equal(fs.existsSync(join(target, "desktop-startup.json")), false);
});

test("writer never creates a missing receipt", (t) => {
  const { file } = fixture(t);
  assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  assert.equal(fs.existsSync(file), false);
});

test("symlinks, directories, hardlinks and permissive files are rejected by reader and writer", (t) => {
  const { dir, file } = fixture(t);
  const request = createDesktopStartupRequest(file, BUILD);
  const original = readFileSync(file);
  const target = join(dir, "target");
  renameSync(file, target);
  symlinkSync(target, file);
  assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
  assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  assert.deepEqual(readFileSync(target), original);
  rmSync(file);
  mkdirSync(file, { mode: 0o600 });
  assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
  rmSync(file, { recursive: true });
  linkSync(target, file);
  assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
  rmSync(file);
  renameSync(target, file);
  for (const mode of [0o644, 0o660, 0o666, 0o4600]) {
    chmodSync(file, mode);
    assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
    assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
  }
});

test("ownership is checked for the parent", (t) => {
  const { file } = fixture(t);
  const request = createDesktopStartupRequest(file, BUILD);
  const uid = process.getuid();
  t.mock.method(process, "getuid", () => uid + 1);
  assert.throws(() => createDesktopStartupRequest(file, BUILD), GENERIC);
  assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
  t.mock.restoreAll();
});

test("an unowned file is rejected even inside an owned private parent", (t) => {
  const { file } = fixture(t);
  const request = createDesktopStartupRequest(file, BUILD);
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (...args) => {
    const stat = originalLstat(...args);
    if (args[0] === file) stat.uid += 1;
    return stat;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
    assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  } finally {
    fs.lstatSync = originalLstat;
    syncBuiltinESMExports();
  }
  assert.equal(readDesktopStartupReceipt(file, request), null);
});

test("malformed, oversized, foreign and extra-field requests cannot be rewritten", (t) => {
  const { file } = fixture(t);
  const request = createDesktopStartupRequest(file, BUILD);
  const disk = JSON.parse(readFileSync(file));
  for (const bytes of ["", "{secret-input", "{} trailing-secret", " ".repeat(8193), Buffer.from([0xff]),
    JSON.stringify({ ...disk, sourceCommit: "c".repeat(40) }),
    JSON.stringify({ ...disk, sourceCommit: "0".repeat(40) }),
    JSON.stringify({ ...disk, requestId: "unknown" }),
    JSON.stringify({ ...disk, schemaVersion: 2 }),
    JSON.stringify({ ...disk, extra: "secret-input" }),
  ]) {
    writeFileSync(file, bytes);
    assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
    assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
    assert.deepEqual(readFileSync(file), Buffer.from(bytes));
  }
  store(file, { ...disk, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
});

test("writer rejects dirty, zero, malformed or mismatched build and UI identities", (t) => {
  const { file } = fixture(t);
  createDesktopStartupRequest(file, BUILD);
  const original = readFileSync(file);
  for (const bad of [
    { app: "other" }, { sourceDirty: true }, { sourceDirty: undefined },
    { sourceCommit: "0".repeat(40) }, { sourceCommit: "d".repeat(40) }, { sourceCommit: "A".repeat(40) },
    { version: "secret-input" }, { apiVersion: 0 }, { uiHash: null }, { uiHash: "invalid" }, { build: 123 },
  ]) assert.throws(() => writeDesktopStartupReceipt(file, { ...BUILD, ...bad }, OPTIONS), GENERIC);
  for (const bad of [{ pid: 0 }, { pid: 1.5 }, { uiPort: 0 }, { uiPort: 65536 }, { mode: "unknown" }]) {
    assert.throws(() => writeDesktopStartupReceipt(file, BUILD, { ...OPTIONS, ...bad }), GENERIC);
  }
  assert.deepEqual(readFileSync(file), original);
});

test("reader rejects stale requests, extra fields and malformed receipt values", (t) => {
  const { file } = fixture(t);
  const request = createDesktopStartupRequest(file, BUILD);
  const receipt = writeDesktopStartupReceipt(file, BUILD, OPTIONS);
  for (const bad of [
    { schemaVersion: 2 }, { kind: "request" }, { app: "other" }, { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { sourceCommit: "d".repeat(40) }, { sourceCommit: "0".repeat(40) }, { pid: 0 }, { pid: "12345" },
    { uiPort: -1 }, { uiPort: 65536 }, { mode: "other" }, { version: "bad" }, { apiVersion: 0 },
    { uiHash: null }, { build: null }, { token: "secret-input" }, { url: "secret-input" },
  ]) {
    store(file, { ...receipt, ...bad });
    assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
  }
  const missing = { ...receipt };
  delete missing.uiHash;
  store(file, missing);
  assert.throws(() => readDesktopStartupReceipt(file, request), GENERIC);
});

test("writer detects a pathname replaced during its held-descriptor write", (t) => {
  const { dir, file } = fixture(t);
  createDesktopStartupRequest(file, BUILD);
  const originalWrite = fs.writeSync;
  let replaced = false;
  fs.writeSync = (...args) => {
    if (!replaced) {
      replaced = true;
      renameSync(file, join(dir, "held-original"));
      store(file, { untouched: true });
    }
    return originalWrite(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeDesktopStartupReceipt(file, BUILD, OPTIONS), GENERIC);
  } finally {
    fs.writeSync = originalWrite;
    syncBuiltinESMExports();
  }
  assert.deepEqual(JSON.parse(readFileSync(file)), { untouched: true });
  assert.equal(JSON.parse(readFileSync(join(dir, "held-original"))).kind, "started");
});
