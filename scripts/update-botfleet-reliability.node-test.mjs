// Reliability tests for the Mac updater: the cases that kept it from ever
// reporting success.  Each group names the failure it pins.
//
//   - credential:  a terminal run has no BOTFLEET_OWNER_NONCE, so the updater
//     must fall back to the credential in the live owner record (main's
//     resolveHarnessBearerCredential).
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
import { runtimePreflight } from "./update-botfleet-mac.mjs";

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
  const result = await runtimePreflight(configFor(dataDirectory, harness), null);
  assert.equal(result.safe, true, result.reason);
});
