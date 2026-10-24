import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";

import {
  readSavedRemoteUrl,
  readServerTarget,
  readServerTargetFile,
  validateGateToken,
  validateRemoteServerUrl,
  validateTargetFile,
  writeServerTarget,
  writeServerTargetTemplate,
  SERVER_TARGET_FILE,
} from "./server-target.mjs";

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), "bf-server-target-"));
}

function writeTargetFile(dir, contents) {
  fs.writeFileSync(path.join(dir, SERVER_TARGET_FILE), contents);
}

// ── validateRemoteServerUrl ────────────────────────────────────────────────

test("an https server url is accepted and normalized to an origin", () => {
  const result = validateRemoteServerUrl("https://jay-server.boa-roygbiv.ts.net:8799");
  assert.deepEqual(result, { ok: true, origin: "https://jay-server.boa-roygbiv.ts.net:8799" });
});

test("a trailing slash is normalized away", () => {
  assert.deepEqual(validateRemoteServerUrl("https://host.example:8799/"), {
    ok: true,
    origin: "https://host.example:8799",
  });
  assert.deepEqual(validateRemoteServerUrl("https://host.example"), {
    ok: true,
    origin: "https://host.example",
  });
});

test("http is accepted only for a loopback host (an ssh -L tunnel)", () => {
  assert.deepEqual(validateRemoteServerUrl("http://127.0.0.1:8799"), {
    ok: true,
    origin: "http://127.0.0.1:8799",
  });
  assert.deepEqual(validateRemoteServerUrl("http://localhost:8799"), {
    ok: true,
    origin: "http://localhost:8799",
  });
  assert.deepEqual(validateRemoteServerUrl("http://[::1]:8799"), {
    ok: true,
    origin: "http://[::1]:8799",
  });
  // 127.0.0.2 is loopback too.
  assert.equal(validateRemoteServerUrl("http://127.0.0.2:8799").ok, true);

  const remote = validateRemoteServerUrl("http://host.example:8799");
  assert.equal(remote.ok, false);
  assert.match(remote.error, /loopback/i);
});

test("a url with credentials, a path, a query or a fragment is refused", () => {
  for (const bad of [
    "https://user:pass@host.example:8799",
    "https://user@host.example:8799",
    "https://host.example:8799/api",
    "https://host.example:8799?token=abc",
    "https://host.example:8799#frag",
  ]) {
    const result = validateRemoteServerUrl(bad);
    assert.equal(result.ok, false, `${bad} should be refused`);
    assert.equal(Object.prototype.toString.call(result.error), "[object String]");
    assert.notEqual(result.error, "");
  }
});

test("a value that is not a url at all is refused", () => {
  for (const bad of ["", "   ", "host.example:8799", "not a url", null, undefined, 42]) {
    const result = validateRemoteServerUrl(bad);
    assert.equal(result.ok, false, `${String(bad)} should be refused`);
  }
});

test("a non-http scheme is refused", () => {
  for (const bad of ["ftp://host.example", "ws://host.example:8799", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.equal(validateRemoteServerUrl(bad).ok, false, `${bad} should be refused`);
  }
});

// ── readServerTarget ───────────────────────────────────────────────────────

test("a missing target file means the server on this Mac", () => {
  const dir = makeUserDataDir();
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), { mode: "local" });
});

test("BOTFLEET_SERVER_URL overrides the file", () => {
  const dir = makeUserDataDir();
  writeTargetFile(dir, JSON.stringify({ mode: "remote", url: "https://file.example:8799" }));

  assert.deepEqual(
    readServerTarget({ userDataDir: dir, env: { BOTFLEET_SERVER_URL: "local" } }),
    { mode: "local" },
  );
  assert.deepEqual(
    readServerTarget({ userDataDir: dir, env: { BOTFLEET_SERVER_URL: "https://env.example:8799" } }),
    { mode: "remote", origin: "https://env.example:8799" },
  );
});

test("an invalid BOTFLEET_SERVER_URL falls back to this Mac with an error", () => {
  const dir = makeUserDataDir();
  const result = readServerTarget({ userDataDir: dir, env: { BOTFLEET_SERVER_URL: "http://host.example" } });
  assert.equal(result.mode, "local");
  assert.match(result.error, /BOTFLEET_SERVER_URL/);
});

test("a target file naming a remote server is used", () => {
  const dir = makeUserDataDir();
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://jay-server.boa-roygbiv.ts.net:8799" }),
  );
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), {
    mode: "remote",
    origin: "https://jay-server.boa-roygbiv.ts.net:8799",
  });
});

test("a target file naming the local server is used", () => {
  const dir = makeUserDataDir();
  writeTargetFile(dir, JSON.stringify({ mode: "local", savedUrl: "https://host.example:8799" }));
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), { mode: "local" });
});

test("a malformed target file falls back to this Mac with an error, never a throw", () => {
  const dir = makeUserDataDir();
  writeTargetFile(dir, "{ this is not json");
  const result = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(result.mode, "local");
  assert.match(result.error, /JSON/);

  writeTargetFile(dir, JSON.stringify(["not", "an", "object"]));
  const array = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(array.mode, "local");
  assert.ok(array.error);

  writeTargetFile(dir, JSON.stringify({ mode: "sideways" }));
  const sideways = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(sideways.mode, "local");
  assert.match(sideways.error, /mode/);
});

test("a remote target file with an invalid url falls back to this Mac with an error", () => {
  const dir = makeUserDataDir();
  writeTargetFile(dir, JSON.stringify({ mode: "remote", url: "http://host.example:8799" }));
  const result = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(result.mode, "local");
  assert.match(result.error, /not valid/i);

  writeTargetFile(dir, JSON.stringify({ mode: "remote" }));
  const missing = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(missing.mode, "local");
  assert.ok(missing.error);
});

// ── writeServerTarget ──────────────────────────────────────────────────────

test("a written target file is owner-only", () => {
  const dir = makeUserDataDir();
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799" });
  const file = path.join(dir, SERVER_TARGET_FILE);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("writing a remote target stores the normalized origin", () => {
  const dir = makeUserDataDir();
  const written = writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799/" });
  assert.equal(written.mode, "remote");
  assert.equal(written.url, "https://host.example:8799");
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), {
    mode: "remote",
    origin: "https://host.example:8799",
  });
});

test("switching back to this Mac keeps the last remote url so the menu can switch back", () => {
  const dir = makeUserDataDir();
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799" });
  writeServerTarget(dir, { mode: "local" });

  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), { mode: "local" });
  assert.equal(readSavedRemoteUrl(dir), "https://host.example:8799");

  // …and the kept url is still usable as a remote target.
  writeServerTarget(dir, { mode: "remote", url: readSavedRemoteUrl(dir) });
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), {
    mode: "remote",
    origin: "https://host.example:8799",
  });
});

test("writing an invalid remote url throws and leaves the file alone", () => {
  const dir = makeUserDataDir();
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799" });
  assert.throws(() => writeServerTarget(dir, { mode: "remote", url: "http://host.example:8799" }));
  assert.throws(() => writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799/api" }));
  assert.throws(() => writeServerTarget(dir, { mode: "remote", url: "https://user:pw@host.example:8799" }));
  assert.throws(() => writeServerTarget(dir, { mode: "sideways" }));
  // The good target is still in place.
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), {
    mode: "remote",
    origin: "https://host.example:8799",
  });
});

test("a local target may carry a template url that is not a valid server url yet", () => {
  const dir = makeUserDataDir();
  writeServerTarget(dir, { mode: "local", url: "https://<host>.<tailnet>.ts.net:8799" });
  // The app still runs against this Mac…
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), { mode: "local" });
  // …and the template is not offered as a switch-back target until it is real.
  assert.equal(readSavedRemoteUrl(dir), null);
});

// ── validateGateToken ──────────────────────────────────────────────────────

test("a gate token of 16 to 256 URL-safe characters is accepted", () => {
  const good = randomBytes(16).toString("hex");
  assert.deepEqual(validateGateToken(good), { ok: true, token: good });
  // The full alphabet the gate token may use.
  assert.equal(validateGateToken("aZ0._~-".repeat(4)).ok, true);
  // A token is trimmed: it is usually pasted out of a terminal.
  assert.deepEqual(validateGateToken(`  ${good}  `), { ok: true, token: good });
});

test("a gate token that is too short or too long is refused", () => {
  assert.equal(validateGateToken("a".repeat(15)).ok, false);
  assert.equal(validateGateToken("a".repeat(256)).ok, true);
  assert.equal(validateGateToken("a".repeat(257)).ok, false);
});

test("a gate token with characters outside the URL-safe set is refused", () => {
  for (const bad of [
    "0123456789abcde!",
    "0123456789abcde ",
    "0123456789abcde\n",
    "0123456789abcde/",
    "0123456789abcde=",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(validateGateToken(bad).ok, false, `${String(bad)} should be refused`);
  }
});

// ── readServerTarget: the token ───────────────────────────────────────────

test("a remote target file may carry a gate token", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token }),
  );
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), {
    mode: "remote",
    origin: "https://host.example:8799",
    token,
  });
});

test("a gate token in the file is trimmed", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token: `  ${token}\n` }),
  );
  assert.equal(readServerTarget({ userDataDir: dir, env: {} }).token, token);
});

test("an invalid gate token in the file is ignored and reported", () => {
  const dir = makeUserDataDir();
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token: "short" }),
  );
  const result = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(result.mode, "remote");
  assert.equal(result.token, undefined);
  assert.match(result.error, /token/i);
});

test("BOTFLEET_SERVER_TOKEN overrides the token in the file", () => {
  const dir = makeUserDataDir();
  writeTargetFile(
    dir,
    JSON.stringify({
      mode: "remote",
      url: "https://host.example:8799",
      token: randomBytes(16).toString("hex"),
    }),
  );
  const fromEnv = randomBytes(16).toString("hex");
  assert.deepEqual(
    readServerTarget({ userDataDir: dir, env: { BOTFLEET_SERVER_TOKEN: fromEnv } }),
    { mode: "remote", origin: "https://host.example:8799", token: fromEnv },
  );
});

test("an invalid BOTFLEET_SERVER_TOKEN is reported, not used", () => {
  const dir = makeUserDataDir();
  writeTargetFile(dir, JSON.stringify({ mode: "remote", url: "https://host.example:8799" }));
  const result = readServerTarget({ userDataDir: dir, env: { BOTFLEET_SERVER_TOKEN: "nope" } });
  assert.equal(result.mode, "remote");
  assert.equal(result.token, undefined);
  assert.match(result.error, /BOTFLEET_SERVER_TOKEN/);
});

test("a remote target without a token is still a remote target", () => {
  const dir = makeUserDataDir();
  writeTargetFile(dir, JSON.stringify({ mode: "remote", url: "https://host.example:8799" }));
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), {
    mode: "remote",
    origin: "https://host.example:8799",
  });
});

// ── writeServerTarget: the token ───────────────────────────────────────────

test("writing a remote target keeps the token the file already had", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token }),
  );
  writeServerTarget(dir, { mode: "local" });
  // The file is read through the app's own validated reader, so a malformed
  // target can never reach the assertions unnoticed.
  const after = readServerTargetFile(dir);
  assert.equal(after.token, token);

  // …and switching back to remote keeps it too.
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799" });
  assert.equal(readServerTarget({ userDataDir: dir, env: {} }).token, token);
});

test("an invalid token in the file is dropped, not written back", () => {
  const dir = makeUserDataDir();
  // The file is hand-editable by design, so a token typed by hand can be
  // wrong.  Carrying it over would write it back verbatim, and the reader
  // would then reject it — locking the owner out of the server they had
  // configured.
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token: "short" }),
  );
  writeServerTarget(dir, { mode: "local" });

  const after = readServerTargetFile(dir);
  assert.equal(after.token, undefined);
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), { mode: "local" });

  // A new token still replaces whatever was there.
  const token = randomBytes(16).toString("hex");
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799", token });
  assert.equal(readServerTargetFile(dir).token, token);
});

test("a new token replaces the one in the file", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  const other = randomBytes(16).toString("hex");
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799", token });
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799", token: other });
  assert.equal(readServerTarget({ userDataDir: dir, env: {} }).token, other);
});

test("writing an invalid token throws and leaves the file alone", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799", token });
  assert.throws(() =>
    writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799", token: "short" }),
  );
  assert.equal(readServerTarget({ userDataDir: dir, env: {} }).token, token);
});

test("the reader validates the file before anything uses it", () => {
  const dir = makeUserDataDir();

  // A file that is not an object at all.
  writeTargetFile(dir, JSON.stringify(["not", "an", "object"]));
  assert.equal(readServerTargetFile(dir), null);

  // An unknown mode.
  writeTargetFile(dir, JSON.stringify({ mode: "sideways" }));
  assert.equal(readServerTargetFile(dir), null);

  // A remote file comes back validated, with its token trimmed.
  const token = randomBytes(16).toString("hex");
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token: `  ${token}\n` }),
  );
  assert.deepEqual(readServerTargetFile(dir), {
    mode: "remote",
    url: "https://host.example:8799",
    token,
  });

  // An invalid token is dropped by the reader, and the reader says so.
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token: "short" }),
  );
  assert.deepEqual(readServerTargetFile(dir), {
    mode: "remote",
    url: "https://host.example:8799",
  });
  const result = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(result.mode, "remote");
  assert.equal(result.token, undefined);
  assert.match(result.error, /token/i);
});

test("validateTargetFile refuses a shape the app would never use", () => {
  assert.equal(validateTargetFile(null).value, null);
  assert.equal(validateTargetFile("remote").value, null);
  assert.equal(validateTargetFile({}).value, null);
  assert.equal(validateTargetFile({ mode: "sideways" }).value, null);

  const checked = validateTargetFile({ mode: "remote", url: "https://host.example:8799" });
  assert.deepEqual(checked.value, { mode: "remote", url: "https://host.example:8799" });
  assert.equal(checked.error, null);
});

test("a dropped gate token is marked, so the launch goes on without it", () => {
  const dir = makeUserDataDir();
  writeTargetFile(
    dir,
    JSON.stringify({ mode: "remote", url: "https://host.example:8799", token: "short" }),
  );
  const fromFile = readServerTarget({ userDataDir: dir, env: {} });
  assert.equal(fromFile.mode, "remote");
  assert.equal(fromFile.origin, "https://host.example:8799");
  assert.equal(fromFile.tokenDropped, true);

  const fromEnv = readServerTarget({ userDataDir: dir, env: { BOTFLEET_SERVER_TOKEN: "nope" } });
  assert.equal(fromEnv.tokenDropped, true);
  assert.equal(fromEnv.token, undefined);

  const override = readServerTarget({
    userDataDir: dir,
    env: { BOTFLEET_SERVER_URL: "https://other.example:8799", BOTFLEET_SERVER_TOKEN: "nope" },
  });
  assert.equal(override.tokenDropped, true);
  assert.equal(override.origin, "https://other.example:8799");
});

test("main.mjs aborts the launch only for a remote error that is not a dropped token", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /if \(target\.mode === "remote" && target\.error && !target\.tokenDropped\) \{/);
  assert.match(main, /startRemoteServer\(target\.origin, target\.token \?\? ""\)/);
});

test("validateTargetFile validates a remote url and never returns an unchecked one", () => {
  const bad = validateTargetFile({ mode: "remote", url: "ftp://host.example", token: "a".repeat(32) });
  assert.match(bad.error, /remote server URL/);
  assert.match(bad.urlError, /remote server URL/);
  assert.equal(bad.value.url, undefined);
  // The rest of the file is still read, so the token can be carried over.
  assert.equal(bad.value.token, "a".repeat(32));

  const good = validateTargetFile({ mode: "remote", url: " https://host.example:8799/ " });
  assert.equal(good.value.url, "https://host.example:8799");

  // A local file keeps its template url as typed.
  assert.equal(validateTargetFile({ mode: "local", url: "not yet" }).value.url, "not yet");
});

test("a remote file with a bad url still hands its token to the next write", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  writeTargetFile(dir, JSON.stringify({ mode: "remote", url: "ftp://host.example", token }));
  assert.equal(readServerTarget({ userDataDir: dir, env: {} }).mode, "local");
  const written = writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799" });
  assert.equal(written.token, token);
});

// ── writeServerTargetTemplate ──────────────────────────────────────────────

test("the template is written when there is no target file yet", () => {
  const dir = makeUserDataDir();
  const result = writeServerTargetTemplate(dir);
  assert.equal(result.written, true);

  const file = path.join(dir, SERVER_TARGET_FILE);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);

  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(parsed, { mode: "local", url: "", token: "" });
  // …and the same file read through the app's own validated reader.
  assert.deepEqual(readServerTargetFile(dir), { mode: "local", url: "" });
});

test("the template never overwrites an existing target file", () => {
  const dir = makeUserDataDir();
  const token = randomBytes(16).toString("hex");
  writeServerTarget(dir, { mode: "remote", url: "https://host.example:8799", token });
  const before = fs.readFileSync(path.join(dir, SERVER_TARGET_FILE), "utf8");

  const result = writeServerTargetTemplate(dir);
  assert.equal(result.written, false);
  assert.equal(fs.readFileSync(path.join(dir, SERVER_TARGET_FILE), "utf8"), before);
});

test("the template's empty url does not make the app fall over", () => {
  const dir = makeUserDataDir();
  writeServerTargetTemplate(dir);
  // The app still runs against this Mac…
  assert.deepEqual(readServerTarget({ userDataDir: dir, env: {} }), { mode: "local" });
  // …and the empty url is not offered as a switch-back target.
  assert.equal(readSavedRemoteUrl(dir), null);
});
