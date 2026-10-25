import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { REMOTE_CREDENTIAL_ERROR, refuseCredentialsInRemoteMode } from "./remote-credential-guard.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";

// main.mjs imports "electron" and runs side effects at load, so it cannot be
// imported here.  These tests cover the guard itself, the shared credential
// state with the handlers' backstop, and the source shape that wires both
// credential:set and credential:set-instance to the guard first.
const MAIN_SOURCE = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

const dummy = () => randomBytes(24).toString("hex");

function storedDocument() {
  return {
    xaiApiKey: dummy(),
    openaiImageApiKey: dummy(),
    infisicalClientSecret: dummy(),
    instanceKeys: { "my-engine": dummy(), "other.engine": dummy() },
  };
}

function secretsIn(document) {
  return [
    document.xaiApiKey,
    document.openaiImageApiKey,
    document.infisicalClientSecret,
    ...Object.values(document.instanceKeys),
  ];
}

function remoteBackstop(serverMode) {
  return async () => {
    if (serverMode === "remote") throw new Error(REMOTE_CREDENTIAL_ERROR);
    return { ok: true };
  };
}

// The same order main.mjs uses: guard first, then the shared state update
// whose afterPersist is the apply-to-server backstop.
function fakeHandlers(serverMode, state) {
  const setCredential = async (name, value) => {
    refuseCredentialsInRemoteMode(serverMode);
    return state.update((credentials) => ({ ...credentials, [name]: value.trim() }), remoteBackstop(serverMode));
  };
  const setInstanceCredential = async (instanceId, value) => {
    refuseCredentialsInRemoteMode(serverMode);
    return state.update(
      (credentials) => ({ ...credentials, instanceKeys: { ...credentials.instanceKeys, [instanceId]: value.trim() } }),
      remoteBackstop(serverMode),
    );
  };
  return { setCredential, setInstanceCredential };
}

function assertLeaksNothing(error, secrets) {
  const seen = JSON.stringify({ message: error.message, ...error });
  for (const secret of secrets) assert.equal(seen.includes(secret), false);
}

test("the guard refuses only in remote mode", () => {
  assert.throws(() => refuseCredentialsInRemoteMode("remote"), { message: REMOTE_CREDENTIAL_ERROR });
  assert.doesNotThrow(() => refuseCredentialsInRemoteMode("local"));
  assert.doesNotThrow(() => refuseCredentialsInRemoteMode(undefined));
  assert.match(REMOTE_CREDENTIAL_ERROR, /remote BotFleet server\.\u00a0 Set keys on that server/);
});

for (const kind of ["credential:set", "credential:set-instance"]) {
  test(`${kind} in remote mode refuses before the store is touched and returns no credentials`, async () => {
    const initial = storedDocument();
    const writes = [];
    const state = createSecureCredentialState(initial, async (document) => writes.push(document));
    const { setCredential, setInstanceCredential } = fakeHandlers("remote", state);
    const incoming = dummy();

    const call = kind === "credential:set"
      ? setCredential("xaiApiKey", incoming)
      : setInstanceCredential("my-engine", incoming);
    const error = await call.then(
      () => assert.fail("expected a refusal"),
      (caught) => caught,
    );

    assert.equal(error.message, REMOTE_CREDENTIAL_ERROR);
    assertLeaksNothing(error, [...secretsIn(initial), incoming]);
    assert.equal(writes.length, 0);
    assert.deepEqual(state.read(), initial);
  });

  test(`${kind} backstop in remote mode rolls back and never resolves to the decrypted document`, async () => {
    const initial = storedDocument();
    const writes = [];
    const state = createSecureCredentialState(initial, async (document) => writes.push(document));
    const incoming = dummy();
    const derive = kind === "credential:set"
      ? (credentials) => ({ ...credentials, xaiApiKey: incoming })
      : (credentials) => ({ ...credentials, instanceKeys: { ...credentials.instanceKeys, "my-engine": incoming } });

    const error = await state.update(derive, remoteBackstop("remote")).then(
      () => assert.fail("expected the backstop to throw"),
      (caught) => caught,
    );

    assert.equal(error.message, REMOTE_CREDENTIAL_ERROR);
    assertLeaksNothing(error, [...secretsIn(initial), incoming]);
    assert.deepEqual(writes.at(-1), initial);
    assert.deepEqual(state.read(), initial);
  });

  test(`${kind} in main.mjs calls the guard as its first statement and keeps a throwing backstop`, () => {
    const start = MAIN_SOURCE.indexOf(`ipcMain.handle("${kind}", async`);
    assert.ok(start > -1, `${kind} handler not found`);
    const body = MAIN_SOURCE.slice(start, start + 2000);
    assert.match(body, /^ipcMain\.handle\("[^"]+", async \([^)]*\) => \{\n\s+refuseCredentialsInRemoteMode\(serverMode\);\n/);
    assert.match(body, /const applyToHarness = async \(\) => \{[\s\S]*?if \(serverMode === "remote"\) throw new Error\(REMOTE_CREDENTIAL_ERROR\);/);
  });
}

test("local mode still saves through the same path", async () => {
  const initial = storedDocument();
  const state = createSecureCredentialState(initial, async () => {});
  const { setCredential, setInstanceCredential } = fakeHandlers("local", state);
  const key = dummy();
  const instanceKey = dummy();
  assert.deepEqual(await setCredential("xaiApiKey", key), { ok: true });
  assert.deepEqual(await setInstanceCredential("my-engine", instanceKey), { ok: true });
  assert.equal(state.read().xaiApiKey, key);
  assert.equal(state.read().instanceKeys["my-engine"], instanceKey);
});
