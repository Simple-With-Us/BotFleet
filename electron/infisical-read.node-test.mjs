// Tests for the read-only Infisical reader.
//
// Run with:  node --test electron/infisical-read.node-test.mjs
// No dependencies, no network: the fetch is a fake and the files are
// temporary.  Every secret-shaped value in this file is generated at runtime,
// because a literal one looks like a secret to the scanner and is not one.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BOTFLEET_INFISICAL_ENVIRONMENT,
  BOTFLEET_INFISICAL_PROJECT_ID,
  BOTFLEET_SERVER_SECRET_PATH,
  INFISICAL_SITE,
  InfisicalReadError,
  readBootstrapTokenFile,
  readInfisicalSecrets,
  validateServiceToken,
} from "./infisical-read.mjs";

// A service token, built at runtime.
const SERVICE_TOKEN = `st.${crypto.randomBytes(24).toString("hex")}`;

// The three names the Linux owner gate reads.
const GATE_NAMES = ["BOTFLEET_OWNER_LOGINS", "BOTFLEET_PUBLIC_ORIGIN", "BOTFLEET_SERVER_GATE_TOKEN"];

/**
 * Assert that a value is the expected token without ever printing either one.
 * `assert.equal` puts actual and expected in its failure message, and a
 * test log is not a place for a token, even a generated one.
 *
 * @param {unknown} actual
 * @param {string} expected
 * @param {string} what
 */
function assertSameToken(actual, expected, what) {
  assert.ok(actual === expected, `${what} is not the expected token (value withheld)`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "botfleet-infisical-read-"));
}

/**
 * A fetch that answers with one JSON body.
 *
 * @param {unknown} body
 * @param {{status?: number}} [options]
 */
function jsonFetch(body, options = {}) {
  const status = options.status ?? 200;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/**
 * A fetch that fails the way a network failure does.
 */
function failingFetch() {
  return async () => {
    throw new Error("getaddrinfo ENOTFOUND app.infisical.com");
  };
}

// ---------------------------------------------------------------------------
// validateServiceToken
// ---------------------------------------------------------------------------

test("validateServiceToken accepts a service token and trims it", () => {
  assertSameToken(validateServiceToken(`  ${SERVICE_TOKEN}  `), SERVICE_TOKEN, "the trimmed token");
});

test("validateServiceToken refuses anything that is not a service token", () => {
  const notAToken = crypto.randomBytes(24).toString("hex");
  for (const bad of [
    notAToken,
    `st.${crypto.randomBytes(4).toString("hex")}`,
    `st.${crypto.randomBytes(32).toString("hex")} with a space`,
    `st. ${crypto.randomBytes(32).toString("hex")}`,
    "",
    "   ",
    null,
    undefined,
    42,
    { toString: () => SERVICE_TOKEN },
  ]) {
    assert.throws(() => validateServiceToken(bad), /not a service token/i);
  }
});

test("validateServiceToken trims the newline a token file usually ends with", () => {
  assertSameToken(validateServiceToken(`${SERVICE_TOKEN}\n`), SERVICE_TOKEN, "the token without its newline");
});

test("validateServiceToken never puts the value in the error", () => {
  // A token-shaped value that is refused (it carries whitespace), so the
  // refusal message is the thing under test.
  const other = `st.${crypto.randomBytes(24).toString("hex")} ${crypto.randomBytes(8).toString("hex")}`;
  let message = null;
  try {
    validateServiceToken(other);
  } catch (err) {
    message = String(err?.message ?? "");
  }
  assert.ok(message !== null, "the value should have been refused");
  assert.ok(!message.includes(other), "the refusal message carried the value");
  assert.ok(!message.includes(SERVICE_TOKEN), "the refusal message carried a token");
});

// ---------------------------------------------------------------------------
// readInfisicalSecrets
// ---------------------------------------------------------------------------

test("readInfisicalSecrets returns only the requested names that are present", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        secrets: [
          { secretKey: "BOTFLEET_OWNER_LOGINS", secretValue: "owner@example.com" },
          { secretKey: "BOTFLEET_PUBLIC_ORIGIN", secretValue: "https://botfleet.example.com" },
          { secretKey: "BOTFLEET_SERVER_GATE_TOKEN", secretValue: crypto.randomBytes(16).toString("hex") },
          { secretKey: "SOMETHING_ELSE", secretValue: crypto.randomBytes(16).toString("hex") },
        ],
      }),
    };
  };

  const values = await readInfisicalSecrets({
    serviceToken: SERVICE_TOKEN,
    names: GATE_NAMES,
    fetchImpl,
  });

  assert.deepEqual(Object.keys(values).sort(), [...GATE_NAMES].sort());
  assert.equal(values.BOTFLEET_OWNER_LOGINS, "owner@example.com");
  assert.equal(values.SOMETHING_ELSE, undefined);

  // The request names the project, the environment and the path, and carries
  // the token in the Authorization header only.
  const request = seen[0];
  assert.ok(request.url.startsWith(`${INFISICAL_SITE}/api/v3/secrets/raw?`));
  // The path travels as one percent-encoded segment, never as a second path.
  assert.ok(request.url.includes("secretPath=%2Fbotfleet-server"));
  const query = new URL(request.url).searchParams;
  assert.equal(query.get("workspaceId"), BOTFLEET_INFISICAL_PROJECT_ID);
  assert.equal(query.get("environment"), BOTFLEET_INFISICAL_ENVIRONMENT);
  assert.equal(query.get("secretPath"), BOTFLEET_SERVER_SECRET_PATH);
  assert.equal(query.get("include_imports"), "false");
  // The values are asked for explicitly, and references are expanded by the
  // vault, the same way scripts/infisical-fetch.mjs reads them.
  assert.equal(query.get("viewSecretValue"), "true");
  assert.equal(query.get("expandSecretReferences"), "true");
  // The token never travels in the URL.
  assert.ok(!request.url.includes(SERVICE_TOKEN), "the request URL carried the token");
  assertSameToken(request.options.headers.authorization, `Bearer ${SERVICE_TOKEN}`, "the Authorization header");
  assert.equal(request.options.method, "GET");
});

test("readInfisicalSecrets leaves a missing name out of the result", async () => {
  const fetchImpl = jsonFetch({
    secrets: [{ secretKey: "BOTFLEET_OWNER_LOGINS", secretValue: "owner@example.com" }],
  });

  const values = await readInfisicalSecrets({
    serviceToken: SERVICE_TOKEN,
    names: GATE_NAMES,
    fetchImpl,
  });

  assert.deepEqual(Object.keys(values), ["BOTFLEET_OWNER_LOGINS"]);
  assert.equal(values.BOTFLEET_SERVER_GATE_TOKEN, undefined);
});

test("readInfisicalSecrets reports an HTTP failure with its status", async () => {
  const fetchImpl = jsonFetch({ message: "unauthorized" }, { status: 401 });

  await assert.rejects(
    () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl }),
    (err) => {
      assert.equal(err instanceof InfisicalReadError, true);
      assert.equal(err.reason, "http-401");
      assert.match(err.message, /401/);
      assert.ok(!err.message.includes(SERVICE_TOKEN), "the error message carried the token");
      return true;
    },
  );
});

test("readInfisicalSecrets reports a network failure as unreachable", async () => {
  await assert.rejects(
    () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl: failingFetch() }),
    (err) => {
      assert.equal(err instanceof InfisicalReadError, true);
      assert.equal(err.reason, "unreachable");
      assert.ok(!err.message.includes(SERVICE_TOKEN), "the error message carried the token");
      return true;
    },
  );
});

test("readInfisicalSecrets refuses an unresolved reference", async () => {
  const fetchImpl = jsonFetch({
    secrets: [
      { secretKey: "BOTFLEET_OWNER_LOGINS", secretValue: "${prod.some-folder.OWNER_LOGINS}" },
    ],
  });

  await assert.rejects(
    () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl }),
    (err) => {
      assert.equal(err instanceof InfisicalReadError, true);
      assert.equal(err.reason, "bad-output");
      assert.match(err.message, /BOTFLEET_OWNER_LOGINS/);
      return true;
    },
  );
});

test("readInfisicalSecrets refuses a reference embedded in a value", async () => {
  const fetchImpl = jsonFetch({
    secrets: [
      { secretKey: "BOTFLEET_PUBLIC_ORIGIN", secretValue: "https://${prod.some-folder.HOST}" },
    ],
  });

  await assert.rejects(
    () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl }),
    (err) => {
      assert.equal(err instanceof InfisicalReadError, true);
      assert.equal(err.reason, "bad-output");
      assert.match(err.message, /BOTFLEET_PUBLIC_ORIGIN/);
      return true;
    },
  );
});

test("readInfisicalSecrets keeps a value with a lone dollar sign", async () => {
  const fetchImpl = jsonFetch({
    secrets: [{ secretKey: "BOTFLEET_OWNER_LOGINS", secretValue: "owner$@example.com" }],
  });

  const values = await readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl });
  assert.equal(values.BOTFLEET_OWNER_LOGINS, "owner$@example.com");
});

test("readInfisicalSecrets reports a missing secrets list", async () => {
  const fetchImpl = jsonFetch({});

  await assert.rejects(
    () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl }),
    (err) => {
      assert.equal(err.reason, "missing");
      return true;
    },
  );
});

test("readInfisicalSecrets refuses a body that is not JSON", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("Unexpected token < in JSON");
    },
  });

  await assert.rejects(
    () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl }),
    (err) => {
      assert.equal(err.reason, "bad-output");
      return true;
    },
  );
});

test("readInfisicalSecrets refuses a token that is not a service token", async () => {
  await assert.rejects(
    () =>
      readInfisicalSecrets({
        serviceToken: crypto.randomBytes(24).toString("hex"),
        names: GATE_NAMES,
        fetchImpl: jsonFetch({ secrets: [] }),
      }),
    /not a service token/i,
  );
});

// ---------------------------------------------------------------------------
// readBootstrapTokenFile
// ---------------------------------------------------------------------------

test("readBootstrapTokenFile reads an owner-only regular file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "infisical-read-token");
  fs.writeFileSync(file, `${SERVICE_TOKEN}\n`);
  fs.chmodSync(file, 0o600);

  assertSameToken(readBootstrapTokenFile(file), SERVICE_TOKEN, "the token read from the file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a file that is not mode 0600", () => {
  const dir = tmpDir();
  const file = path.join(dir, "infisical-read-token");
  fs.writeFileSync(file, SERVICE_TOKEN);
  fs.chmodSync(file, 0o644);

  assert.throws(() => readBootstrapTokenFile(file), /mode 0600/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a symlink", () => {
  const dir = tmpDir();
  const target = path.join(dir, "real-token");
  const link = path.join(dir, "infisical-read-token");
  fs.writeFileSync(target, SERVICE_TOKEN);
  fs.chmodSync(target, 0o600);
  fs.symlinkSync(target, link);

  assert.throws(() => readBootstrapTokenFile(link), /symlink|regular file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a file with a second hard link", () => {
  const dir = tmpDir();
  const original = path.join(dir, "elsewhere");
  const file = path.join(dir, "infisical-read-token");
  fs.writeFileSync(original, SERVICE_TOKEN);
  fs.chmodSync(original, 0o600);
  fs.linkSync(original, file);

  assert.throws(() => readBootstrapTokenFile(file), /hard link/);
  // The other name is refused the same way: it is the same file.
  assert.throws(() => readBootstrapTokenFile(original), /hard link/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a symlink to a file with a second hard link", () => {
  const dir = tmpDir();
  const original = path.join(dir, "elsewhere");
  const second = path.join(dir, "second");
  const link = path.join(dir, "infisical-read-token");
  fs.writeFileSync(original, SERVICE_TOKEN);
  fs.chmodSync(original, 0o600);
  fs.linkSync(original, second);
  fs.symlinkSync(second, link);

  assert.throws(() => readBootstrapTokenFile(link), /symlink|regular file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a missing file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "infisical-read-token");

  assert.throws(() => readBootstrapTokenFile(file), /does not exist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a directory", () => {
  const dir = tmpDir();

  assert.throws(() => readBootstrapTokenFile(dir), /regular file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBootstrapTokenFile refuses a file that is not a service token", () => {
  const dir = tmpDir();
  const file = path.join(dir, "infisical-read-token");
  fs.writeFileSync(file, "not-a-service-token");
  fs.chmodSync(file, 0o600);

  assert.throws(() => readBootstrapTokenFile(file), /not a service token/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no thrown message ever carries the token", async () => {
  const messages = [];

  const attempts = [
    async () => readInfisicalSecrets({ serviceToken: SERVICE_TOKEN, names: GATE_NAMES, fetchImpl: failingFetch() }),
    async () =>
      readInfisicalSecrets({
        serviceToken: SERVICE_TOKEN,
        names: GATE_NAMES,
        fetchImpl: jsonFetch({}, { status: 401 }),
      }),
    async () =>
      readInfisicalSecrets({
        serviceToken: SERVICE_TOKEN,
        names: GATE_NAMES,
        fetchImpl: jsonFetch({
          secrets: [{ secretKey: "BOTFLEET_SERVER_GATE_TOKEN", secretValue: "${prod.folder.TOKEN}" }],
        }),
      }),
  ];

  for (const attempt of attempts) {
    let message = null;
    try {
      await attempt();
    } catch (err) {
      message = String(err?.message ?? "");
    }
    // Checked outside the catch: an assertion thrown inside the try would be
    // caught and counted as the expected failure.
    assert.ok(message !== null, "the read should have failed");
    messages.push(message);
  }

  const dir = tmpDir();
  const loose = path.join(dir, "infisical-read-token");
  fs.writeFileSync(loose, SERVICE_TOKEN);
  fs.chmodSync(loose, 0o644);
  let looseMessage = null;
  try {
    readBootstrapTokenFile(loose);
  } catch (err) {
    looseMessage = String(err?.message ?? "");
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(looseMessage !== null, "the file should have been refused");
  messages.push(looseMessage);

  // A constant diagnostic: the message under test is never echoed, because
  // the failure this guards against is exactly a message holding the token.
  messages.forEach((message, index) => {
    assert.ok(!message.includes(SERVICE_TOKEN), `thrown message #${index} carried the token (message withheld)`);
  });
});
