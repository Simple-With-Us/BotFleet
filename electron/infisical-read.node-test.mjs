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
  assert.equal(validateServiceToken(`  ${SERVICE_TOKEN}  `), SERVICE_TOKEN);
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
  assert.equal(validateServiceToken(`${SERVICE_TOKEN}\n`), SERVICE_TOKEN);
});

test("validateServiceToken never puts the value in the error", () => {
  const other = `st.${crypto.randomBytes(24).toString("hex")}`;
  try {
    validateServiceToken(other);
    assert.fail("the value should have been refused");
  } catch (err) {
    assert.equal(err.message.includes(other), false);
    assert.equal(err.message.includes(SERVICE_TOKEN), false);
  }
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
  assert.equal(request.options.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
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
      assert.equal(err.message.includes(SERVICE_TOKEN), false);
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
      assert.equal(err.message.includes(SERVICE_TOKEN), false);
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

  assert.equal(readBootstrapTokenFile(file), SERVICE_TOKEN);
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
    try {
      await attempt();
      assert.fail("the read should have failed");
    } catch (err) {
      messages.push(String(err?.message ?? ""));
    }
  }

  const dir = tmpDir();
  const loose = path.join(dir, "infisical-read-token");
  fs.writeFileSync(loose, SERVICE_TOKEN);
  fs.chmodSync(loose, 0o644);
  try {
    readBootstrapTokenFile(loose);
    assert.fail("the file should have been refused");
  } catch (err) {
    messages.push(String(err?.message ?? ""));
  }
  fs.rmSync(dir, { recursive: true, force: true });

  for (const message of messages) {
    assert.equal(message.includes(SERVICE_TOKEN), false, `a message carried the token: ${message}`);
  }
});
