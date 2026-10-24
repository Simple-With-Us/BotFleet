import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";

import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  resolveServerTarget,
  readKeychainServiceToken,
  validateGateToken,
  validateRemoteServerUrl,
  SERVER_TARGET_FILE,
} from "./server-target.mjs";

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), "bf-server-target-"));
}

// Every secret in this file is generated at run time: a literal that looks
// like a token would be a secret in the repository.
function serviceToken() {
  return `st.${randomBytes(24).toString("hex")}`;
}

function gateToken() {
  return randomBytes(16).toString("hex");
}

// The vault read, with nothing behind it: no network, no keychain, no env.
function fakeVault(secrets) {
  return async ({ names }) => {
    const out = {};
    for (const name of names) {
      if (Object.prototype.toString.call(secrets?.[name]) === "[object String]") out[name] = secrets[name];
    }
    return out;
  };
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

// ── validateGateToken ──────────────────────────────────────────────────────

test("a gate token of 16 to 256 URL-safe characters is accepted", () => {
  const good = gateToken();
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

// ── readKeychainServiceToken ──────────────────────────────────────────────

// The keychain read only happens on macOS.  The platform is swapped for the
// duration of the test so the module can be exercised anywhere.
async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

test("the keychain token is read with the security tool, service and account", async () => {
  const token = serviceToken();
  const calls = [];
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: `${token}\n` };
  };

  const result = await withPlatform("darwin", () => readKeychainServiceToken({ execFileImpl }));
  assert.equal(result, token);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/security");
  assert.deepEqual(calls[0].args, [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  assert.equal(calls[0].options.timeout, 10_000);
});

test("a keychain without the item is not enrolled, not an error", async () => {
  const execFileImpl = async () => {
    const error = new Error("could not find the item");
    error.code = 44;
    throw error;
  };
  const result = await withPlatform("darwin", () => readKeychainServiceToken({ execFileImpl }));
  assert.equal(result, null);
});

test("a keychain that cannot be read is an error", async () => {
  const execFileImpl = async () => {
    const error = new Error("User interaction is not allowed");
    error.code = 36;
    throw error;
  };
  await assert.rejects(
    () => withPlatform("darwin", () => readKeychainServiceToken({ execFileImpl })),
    /could not read the Infisical read token from the Keychain/,
  );
});

test("a keychain value that is not a service token is refused", async () => {
  const execFileImpl = async () => ({ stdout: "not-a-service-token" });
  await assert.rejects(
    () => withPlatform("darwin", () => readKeychainServiceToken({ execFileImpl })),
    /could not read the Infisical read token from the Keychain/,
  );
});

test("a machine that is not macOS has no keychain to read", async () => {
  let called = false;
  const execFileImpl = async () => {
    called = true;
    return { stdout: serviceToken() };
  };
  const result = await withPlatform("linux", () => readKeychainServiceToken({ execFileImpl }));
  assert.equal(result, null);
  assert.equal(called, false);
});

// ── resolveServerTarget ───────────────────────────────────────────────────

test("no keychain token means this Mac, and the app says it is not enrolled", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => null,
    readSecrets: async () => {
      throw new Error("the vault must not be read without a bootstrap token");
    },
  });
  assert.equal(result.mode, "local");
  assert.equal(result.source, "not-enrolled");
  assert.equal(result.legacyFile, false);
});

test("Infisical can say local too", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: fakeVault({ BOTFLEET_SERVER_MODE: "local" }),
  });
  assert.equal(result.mode, "local");
  assert.equal(result.source, "infisical");
  assert.equal(result.legacyFile, false);
});

test("a remote target carries the origin and the gate token", async () => {
  const dir = makeUserDataDir();
  const token = gateToken();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: fakeVault({
      BOTFLEET_SERVER_MODE: "remote",
      BOTFLEET_SERVER_URL: "https://jay-server.boa-roygbiv.ts.net:8799/",
      BOTFLEET_SERVER_GATE_TOKEN: token,
    }),
  });
  assert.equal(result.mode, "remote");
  assert.equal(result.source, "infisical");
  assert.equal(result.origin, "https://jay-server.boa-roygbiv.ts.net:8799");
  assert.equal(result.token, token);
  assert.equal(result.legacyFile, false);
});

test("a remote target with an unusable url is an error, not a fallback to this Mac", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: fakeVault({
      BOTFLEET_SERVER_MODE: "remote",
      BOTFLEET_SERVER_URL: "http://host.example:8799",
      BOTFLEET_SERVER_GATE_TOKEN: gateToken(),
    }),
  });
  assert.equal(result.mode, "error");
  assert.equal(result.source, "infisical");
  assert.match(result.message, /BOTFLEET_SERVER_URL/);
  assert.match(result.message, /Infisical/);
});

test("a remote target without a url is an error", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: fakeVault({
      BOTFLEET_SERVER_MODE: "remote",
      BOTFLEET_SERVER_GATE_TOKEN: gateToken(),
    }),
  });
  assert.equal(result.mode, "error");
  assert.match(result.message, /BOTFLEET_SERVER_URL/);
});

test("a remote target without a gate token is an error", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: fakeVault({
      BOTFLEET_SERVER_MODE: "remote",
      BOTFLEET_SERVER_URL: "https://host.example:8799",
    }),
  });
  assert.equal(result.mode, "error");
  assert.match(result.message, /BOTFLEET_SERVER_GATE_TOKEN/);
});

test("a remote target with an unusable gate token is an error", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: fakeVault({
      BOTFLEET_SERVER_MODE: "remote",
      BOTFLEET_SERVER_URL: "https://host.example:8799",
      BOTFLEET_SERVER_GATE_TOKEN: "short",
    }),
  });
  assert.equal(result.mode, "error");
  assert.match(result.message, /BOTFLEET_SERVER_GATE_TOKEN/);
});

test("a vault that cannot be reached is an error, never a quiet fallback", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: async () => {
      const error = new Error("Infisical could not be reached");
      error.reason = "unreachable";
      throw error;
    },
  });
  assert.equal(result.mode, "error");
  assert.notEqual(result.mode, "local");
  assert.equal(result.source, "infisical");
  assert.match(result.message, /Infisical/);
  assert.match(result.message, /prod/);
  assert.match(result.message, /\/botfleet-server/);
});

test("a vault that answers with an HTTP error is an error", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => serviceToken(),
    readSecrets: async () => {
      const error = new Error("answered HTTP 403");
      error.reason = "http-403";
      throw error;
    },
  });
  assert.equal(result.mode, "error");
  assert.match(result.message, /403/);
});

test("a mode that is missing or unknown is an error", async () => {
  const dir = makeUserDataDir();
  for (const mode of [undefined, "", "sideways", "LOCAL SERVER"]) {
    const result = await resolveServerTarget({
      userDataDir: dir,
      readToken: async () => serviceToken(),
      readSecrets: fakeVault(
        mode === undefined ? {} : { BOTFLEET_SERVER_MODE: mode },
      ),
    });
    assert.equal(result.mode, "error", `${String(mode)} should be refused`);
    assert.match(result.message, /BOTFLEET_SERVER_MODE/);
  }
});

test("a keychain that cannot be read is an error, not a silent local mode", async () => {
  const dir = makeUserDataDir();
  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => {
      throw new Error("could not read the Infisical read token from the Keychain");
    },
    readSecrets: async () => ({}),
  });
  assert.equal(result.mode, "error");
  assert.match(result.message, /Keychain/);
});

test("the old target file is flagged and never read", async () => {
  const dir = makeUserDataDir();
  const token = gateToken();
  fs.writeFileSync(
    path.join(dir, SERVER_TARGET_FILE),
    JSON.stringify({ mode: "remote", url: "http://127.0.0.1:9", token }),
  );

  const result = await resolveServerTarget({
    userDataDir: dir,
    readToken: async () => null,
    readSecrets: async () => {
      throw new Error("the vault must not be read without a bootstrap token");
    },
  });
  // The file exists, so it is flagged…
  assert.equal(result.legacyFile, true);
  // …and it is ignored: the app is on this Mac, not on the remote address in
  // the file, and the token in it is nowhere in sight.
  assert.equal(result.mode, "local");
  assert.equal(result.source, "not-enrolled");
  assert.equal(result.token, undefined);
  assert.equal(result.origin, undefined);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("no message ever carries a token or a url value", async () => {
  const dir = makeUserDataDir();
  const token = gateToken();
  const secret = serviceToken();
  const url = "https://host.example:8799";

  const cases = [
    {
      readToken: async () => secret,
      readSecrets: async () => {
        const error = new Error("boom");
        error.reason = "unreachable";
        throw error;
      },
    },
    {
      readToken: async () => secret,
      readSecrets: fakeVault({ BOTFLEET_SERVER_MODE: "sideways" }),
    },
    {
      readToken: async () => secret,
      readSecrets: fakeVault({
        BOTFLEET_SERVER_MODE: "remote",
        BOTFLEET_SERVER_URL: "not a url",
        BOTFLEET_SERVER_GATE_TOKEN: token,
      }),
    },
    {
      readToken: async () => secret,
      readSecrets: fakeVault({
        BOTFLEET_SERVER_MODE: "remote",
        BOTFLEET_SERVER_URL: url,
        BOTFLEET_SERVER_GATE_TOKEN: "short",
      }),
    },
  ];

  for (const injected of cases) {
    const result = await resolveServerTarget({ userDataDir: dir, ...injected });
    assert.equal(result.mode, "error");
    const message = String(result.message);
    assert.equal(message.includes(token), false, `the message carried the token: ${message}`);
    assert.equal(message.includes(secret), false, `the message carried the service token: ${message}`);
    assert.equal(message.includes(url), false, `the message carried the url: ${message}`);
  }
});

// ── main.mjs: the shape of the startup ────────────────────────────────────

test("main.mjs resolves the target from Infisical and keeps the source order", () => {
  const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(
    main,
    /const target = await resolveServerTarget\(\{ userDataDir: app\.getPath\("userData"\) \}\);/,
  );
  assert.match(main, /if \(target\.mode === "remote"\) serverReady = await startRemoteServer\(/);
  assert.match(main, /else serverReady = await startServerPackaged\(\);/);
  // The remote error page still exists, so the remote path keeps its own
  // failure handling.
  assert.match(main, /startRemoteServer\(target\.origin, target\.token \?\? ""\)/);
});
