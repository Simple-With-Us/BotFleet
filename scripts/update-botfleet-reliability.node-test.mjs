// Reliability tests for the Mac updater: the cases that kept it from ever
// reporting success.  Each group names the failure it pins.
//
//   - credential:  the harness mints a new owner credential on every boot, so
//     the updater must read the CURRENT one from the owner record.
//
// Nothing here touches the real ~/.botfleet, ~/Library/Caches/BotFleet or a
// running BotFleet: every fixture lives in a temporary directory and every
// harness is a loopback server on an ephemeral port.
import assert from "node:assert/strict";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { run, strictRuntimePreflight } from "./update-botfleet-mac.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const posixOnly = { skip: process.platform === "win32" ? "POSIX ownership, modes and lsof" : false };
const COMMIT = "b".repeat(40);

/**
 * A harness that answers the way server/index.ts does for the two routes the
 * updater uses, and accepts only the credential it currently holds, exactly as
 * a harness that has just booted does.
 */
async function fakeHarness({ nonce, commit = COMMIT, pid = process.pid }) {
  let accepted = nonce;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, authorized: request.headers.authorization === `Bearer ${accepted}` });
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/health") {
      return reply(200, { app: "botfleet", pid, static: false, ready: true, booting: false });
    }
    if (request.url === "/api/runtime") {
      if (request.headers.authorization !== `Bearer ${accepted}`) return reply(401, { error: "unauthorized" });
      return reply(200, {
        app: "botfleet",
        pid,
        dataOwner: { pid, port: server.address().port },
        sourceCommit: commit,
        sourceDirty: false,
        safeToRestart: true,
        activeWorkCount: 0,
      });
    }
    return reply(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    /** The harness restarted: it now accepts only this credential. */
    rotate(next) { accepted = next; },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}

/** A data directory holding an owner record for `harness`, plus a messages.db
 *  this process holds open, which is how the updater proves one data owner. */
async function dataDirectoryFor(t, harness, nonce) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ubf-reliability-data-"));
  const database = openSync(join(dataDirectory, "messages.db"), "w");
  t.after(async () => {
    closeSync(database);
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const writeOwner = (value) => writeFile(
    join(dataDirectory, "harness-owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: harness.port, nonce: value }),
    { mode: 0o600 },
  );
  await writeOwner(nonce);
  return { dataDirectory, writeOwner };
}

const configFor = (dataDirectory, harness) => ({
  dataDirectory,
  ports: [harness.port],
  unknownHolderWaitMs: 0,
  reportDetail: () => {},
});

test("a check after the harness restarted uses the credential in the owner record, not one captured earlier", posixOnly, async (t) => {
  const before = "a".repeat(64);
  const after = "c".repeat(64);
  const harness = await fakeHarness({ nonce: before });
  t.after(() => harness.close());
  const { dataDirectory, writeOwner } = await dataDirectoryFor(t, harness, before);
  const config = configFor(dataDirectory, harness);

  const first = await strictRuntimePreflight(config, null, { requireIdle: false });
  assert.equal(first.safe, true, first.reason);

  // The update restarted the harness: a new credential, a rewritten record.
  // The environment still holds the old one, as a run launched before the
  // restart would.  This is the case #852 broke: it sent the old one and waited
  // out the whole deadline on a 401 before rolling the install back.
  harness.rotate(after);
  await writeOwner(after);
  const previous = process.env.BOTFLEET_OWNER_NONCE;
  process.env.BOTFLEET_OWNER_NONCE = before;
  t.after(() => {
    if (previous === undefined) delete process.env.BOTFLEET_OWNER_NONCE;
    else process.env.BOTFLEET_OWNER_NONCE = previous;
  });
  const second = await strictRuntimePreflight(config, null, { requireIdle: false });
  assert.equal(second.safe, true, second.reason);
  assert.equal(
    harness.requests.filter((request) => request.path === "/api/runtime").every((request) => request.authorized),
    true,
    "every runtime request carried the credential the harness held at that moment",
  );
});

test("no environment variable is needed for an authenticated check", posixOnly, async (t) => {
  const nonce = "d".repeat(64);
  const harness = await fakeHarness({ nonce });
  t.after(() => harness.close());
  const { dataDirectory } = await dataDirectoryFor(t, harness, nonce);
  const previous = process.env.BOTFLEET_OWNER_NONCE;
  delete process.env.BOTFLEET_OWNER_NONCE;
  t.after(() => {
    if (previous !== undefined) process.env.BOTFLEET_OWNER_NONCE = previous;
  });
  const result = await strictRuntimePreflight(configFor(dataDirectory, harness), null, { requireIdle: false });
  assert.equal(result.safe, true, result.reason);
});

test("a harness that refuses the recorded credential is named as such, and asked again", posixOnly, async (t) => {
  const harness = await fakeHarness({ nonce: "1".repeat(64) });
  t.after(() => harness.close());
  // The record holds a credential the harness does not: a newer harness has
  // replaced the one the file names, or the file is mid-rewrite.
  const { dataDirectory } = await dataDirectoryFor(t, harness, "2".repeat(64));
  const result = await strictRuntimePreflight(configFor(dataDirectory, harness), null, { requireIdle: false });
  assert.equal(result.safe, false);
  assert.equal(result.transient, true, "it settles on its own, so the caller asks again");
  assert.match(result.reason, /refused the credential in its owner record \(HTTP 401\)/);
  assert.doesNotMatch(result.reason, /[a-f0-9]{16}/, "the credential is never put in a message");
});

// ---------------------------------------------------------------------------
// The wrapper's "already current" shortcut and its runtime probe.
// ---------------------------------------------------------------------------

/** A remote with one commit carrying a stub updater, cloned as the checkout. */
async function currentCheckoutFixture(t) {
  const fixture = await mkdtemp(join(tmpdir(), "ubf-reliability-wrapper-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote");
  const checkout = join(fixture, "checkout");
  const marker = join(fixture, "executed.json");
  await mkdir(remote, { recursive: true });
  const git = (cwd, args) => run("git", ["-C", cwd, ...args]);
  for (const path of [
    "scripts/update-botfleet-mac.mjs",
    "scripts/mac-update-transaction.mjs",
    "scripts/ci-build-resolver.mjs",
    "scripts/stage-entries.mjs",
    "scripts/update-progress.mjs",
    "electron/update-credential-preparation.mjs",
  ]) {
    await mkdir(dirname(join(remote, path)), { recursive: true });
    await writeFile(join(remote, path), path.endsWith("update-botfleet-mac.mjs")
      ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2) }));\n`
      : "// placeholder\n");
  }
  await git(fixture, ["init", "-b", "main", "remote"]);
  await git(remote, ["config", "user.email", "test@example.com"]);
  await git(remote, ["config", "user.name", "Test"]);
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "updater"]);
  await git(fixture, ["clone", "remote", "checkout"]);
  const head = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
  const invoke = async (extraEnv = {}) => {
    await rm(marker, { force: true });
    const result = await run("bash", [join(scripts, "update-botfleet.sh")], {
      env: {
        BOTFLEET_CHECKOUT: checkout,
        BOTFLEET_APP_PATH: join(fixture, "no-app.app"),
        BOTFLEET_OWNER_NONCE: "",
        ...extraEnv,
      },
      allowFailure: true,
    });
    const executed = await readFile(marker, "utf8").then(JSON.parse, () => null);
    return { ...result, executed };
  };
  return { fixture, head, invoke };
}

test("a terminal run says 'already current' with no credential in its environment", posixOnly, async (t) => {
  const { fixture, head, invoke } = await currentCheckoutFixture(t);
  const nonce = "e".repeat(64);
  const harness = await fakeHarness({ nonce, commit: head });
  t.after(() => harness.close());
  const dataDirectory = join(fixture, "data");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "harness-owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: harness.port, nonce }),
    { mode: 0o600 },
  );
  // BOTFLEET_OWNER_NONCE is deliberately empty (see invoke): #852 made this
  // exit 1 with "BOTFLEET_OWNER_NONCE is required" instead of finishing.
  const result = await invoke({ BOTFLEET_DATA_DIR: dataDirectory });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Already at .*Nothing to update/);
  assert.equal(result.executed, null, "an up-to-date Mac runs no updater");
  assert.equal(harness.requests.some((request) => request.path === "/api/runtime" && request.authorized), true,
    "the probe really asked the harness, with the credential from its record");
});

test("a running harness on a different commit turns the shortcut off", posixOnly, async (t) => {
  const { fixture, invoke } = await currentCheckoutFixture(t);
  const nonce = "f".repeat(64);
  const harness = await fakeHarness({ nonce, commit: "9".repeat(40) });
  t.after(() => harness.close());
  const dataDirectory = join(fixture, "data");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "harness-owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: harness.port, nonce }),
    { mode: 0o600 },
  );
  const result = await invoke({ BOTFLEET_DATA_DIR: dataDirectory });
  assert.doesNotMatch(result.stdout, /Already at/);
  assert.notEqual(result.executed, null, "a stale runtime is reinstalled");
});

test("a harness that refuses its own record is left to the updater to diagnose, not called current", posixOnly, async (t) => {
  const { fixture, invoke } = await currentCheckoutFixture(t);
  const harness = await fakeHarness({ nonce: "1".repeat(64) });
  t.after(() => harness.close());
  const dataDirectory = join(fixture, "data");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "harness-owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: harness.port, nonce: "2".repeat(64) }),
    { mode: 0o600 },
  );
  const result = await invoke({ BOTFLEET_DATA_DIR: dataDirectory });
  assert.doesNotMatch(result.stdout, /Already at/);
  assert.match(result.stderr, /refused the credential/);
  assert.notEqual(result.executed, null);
});

test("a harness nobody can reach is not evidence that the checkout is out of date", posixOnly, async (t) => {
  const { fixture, invoke } = await currentCheckoutFixture(t);
  const dataDirectory = join(fixture, "data");
  await mkdir(dataDirectory, { recursive: true });
  // Nothing listens on this port.
  await writeFile(
    join(dataDirectory, "harness-owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, port: 9, nonce: "3".repeat(64) }),
    { mode: 0o600 },
  );
  const result = await invoke({ BOTFLEET_DATA_DIR: dataDirectory });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Already at .*Nothing to update/);
});
