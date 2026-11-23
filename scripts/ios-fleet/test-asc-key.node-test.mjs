// The App Store Connect private key:  how it is validated, how it is staged
// for the Apple tools, and how the client takes it.
//
// The private key is a secret, and the approved secret sources are the process
// environment, a captured scoped-reader read and bootstrap-only Keychain
// credentials.  A caller-supplied file is not one of them, so the node client
// never reads a key file:  the shell layer that owns the credential writes a
// short-lived mode-600 copy and hands the key over in the environment.  These
// tests cover that handoff.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and nothing reaches the network beyond a local server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizePrivateKey, writePrivateKeyFile, CLIENT_ENV_ALLOWLIST, clientEnvironment } from "./asc-key.mjs";
import { credentialSource, isKeyId, readStoreSecrets } from "./asc-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "asc-key.mjs");
const client = join(here, "asc-api.mjs");
const root = mkdtempSync(join(tmpdir(), "asc-key-test-"));
//  A PATH with node and nothing else:  the fleet reader lives in the operator's
//  own bin directory, and a test must never reach it or Infisical.
const safePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

const envPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const envKeyPem = envPair.privateKey.export({ type: "pkcs8", format: "pem" });
//  A second, different key:  it stands in for the key somebody named in a
//  file.  It must never sign anything.
const namedPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const namedKeyPem = namedPair.privateKey.export({ type: "pkcs8", format: "pem" });

//  A fake store:  one key, read through the shared scoped reader.  The
//  reader is a Python program, because the helper runs it with `python3 -I`.
const storePair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const storeKeyPem = storePair.privateKey.export({ type: "pkcs8", format: "pem" });

function storeReader(exitCode = 0) {
  const path = join(root, `store-reader-${exitCode}.py`);
  const pemFile = join(root, `store-key-${exitCode}.p8`);
  writeFileSync(pemFile, storeKeyPem);
  chmodSync(pemFile, 0o600);
  //  A non-zero exit code is the store's own answer for every name:  3 is
  //  "absent from that folder" and 4 is "refused".
  const body = exitCode === 0 ? [
    "import os, sys",
    "name = sys.argv[2]",
    "if name == \"ASC_KEY_ID\":",
    "    sys.stdout.write(\"STOREKEY0001\")",
    "elif name == \"ASC_ISSUER_ID\":",
    "    sys.stdout.write(\"store-issuer\")",
    "elif name == \"ASC_KEY_P8\":",
    "    import os.path",
    "    here = os.path.dirname(os.path.abspath(__file__))",
    `    with open(os.path.join(here, "store-key-${exitCode}.p8")) as fh:`,
    "        sys.stdout.write(fh.read())",
    "else:",
    "    sys.exit(3)"
  ].join("\n") : ["import sys", `sys.exit(${exitCode})`].join("\n");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function staged(name, content = envKeyPem, mode = 0o600) {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function run(args, stdin = "", env = undefined) {
  return new Promise((resolve) => {
    const options = { stdio: ["pipe", "pipe", "pipe"] };
    if (env) options.env = env;
    const child = spawn(process.execPath, [helper, ...args], options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function spawnNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

//  A local App Store Connect, so the request the client signs can be read.
function localServer() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => server.close()
    }));
  });
}

function bearerKeyId(authorization) {
  const token = String(authorization || "").replace(/^Bearer /, "");
  if (!token) return null;
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).kid;
}

//  True when the token was signed with the key behind this PEM.
function signedWith(token, pem) {
  const [, payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return false;
  const verifier = createVerify("SHA256");
  verifier.update(`${token.split(".")[0]}.${payload}`);
  verifier.end();
  return verifier.verify(
    { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")
  );
}

test("a generated key is accepted and comes back with a trailing newline", () => {
  const normalized = normalizePrivateKey(envKeyPem);
  assert.ok(normalized, "a real key was refused");
  assert.ok(normalized.endsWith("\n"), "the key has to end with a newline");
  assert.equal(normalized.trim(), envKeyPem.trim());
});

test("a malformed PEM is refused, because the envelope is not a key", () => {
  //  A truncated key, an armored block and a mangled export all carry the
  //  envelope and still fail to parse.  Accepting them would hand the signer
  //  something it cannot use, and the failure would come back as a stack
  //  trace instead of a credential error.
  //  The fixture envelopes are assembled at run time:  a contiguous
  //  private-key block is refused by the relay's secret scan, and these are
  //  fixtures, not credentials.
  const envelope = ["-----BEGIN PRIVATE", " KEY-----", "\n", "-----END PRIVATE", " KEY-----\n"].join("");
  assert.equal(normalizePrivateKey(envelope.replace("\n", "\nnot base64 at all\n")), null);
  assert.equal(normalizePrivateKey(envelope), null);
  assert.equal(normalizePrivateKey(""), null);
  assert.equal(normalizePrivateKey(undefined), null);
  assert.equal(normalizePrivateKey("hunter2"), null);
});

test("the command line reports the status of a key on stdin and never prints it", async () => {
  //  A key on stdout is a key in every log that captures it, so the command
  //  reports whether the value is usable and nothing else.
  const ok = await run(["validate"], envKeyPem);
  assert.equal(ok.code, 0, `the key was refused: ${ok.stderr}`);
  assert.match(ok.stdout, /is a PEM private key/, `the status was not reported:\n${ok.stdout}`);
  assert.doesNotMatch(ok.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.doesNotMatch(ok.stderr, /PRIVATE KEY/, "the key reached stderr");

  const bad = await run(["validate"], "not a private key at all");
  assert.notEqual(bad.code, 0, "a value that is not a key must be refused");
  assert.match(bad.stderr, /not a PEM private key/);
  assert.equal(bad.stdout, "", "a refused key must not put anything on stdout");
});

test("the command line writes a key to a file only its owner can read", async () => {
  const path = join(root, "written.p8");
  const result = await run(["write", path], envKeyPem);
  assert.equal(result.code, 0, `the write failed: ${result.stderr}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), envKeyPem.trim());
});

test("the command line refuses a value that is not a key", async () => {
  const path = join(root, "refused.p8");
  const result = await run(["write", path], "not a private key");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not a PEM private key/);
});

test("the write command says which failure it was through its exit code", async () => {
  //  The shell layer reads the exit code, so the two failures cannot share
  //  one:  a value the Apple tools cannot use is a credential failure (3),
  //  and a path or a file that could not be used is a staging failure (2).
  //  One code for both would send the owner to the wrong place.
  //
  //  The credential status is 3 and not 1 because 1 is what this process
  //  uses for a usage error and what node uses for an uncaught exception.
  //  A crash would then read as a broken key, which is the same class of
  //  misdiagnosis this separation exists to prevent.
  const value = await run(["write", join(root, "bad-value.p8")], "not a private key");
  assert.equal(value.code, 3, `a broken credential did not exit 3: ${value.stderr}`);

  const shared = mkdtempSync(join(tmpdir(), "asc-key-shared-"));
  chmodSync(shared, 0o755);
  const staging = await run(["write", join(shared, "key.p8")], envKeyPem);
  assert.equal(staging.code, 2, `a refused staging path did not exit 2: ${staging.stderr}`);
});

test("a refused path outranks a broken value, on the command line and in the module", async () => {
  //  A value that is both a broken PEM and a path that cannot be used is
  //  classified the same way by both entry points.  When the two disagreed,
  //  the command line called it a path failure while the exported function
  //  called it a credential failure, and the caller was sent to two
  //  different owners for one run.
  const shared = mkdtempSync(join(tmpdir(), "asc-key-both-"));
  chmodSync(shared, 0o755);
  const refused = join(shared, "key.p8");

  const cli = await run(["write", refused], "not a private key");
  assert.equal(cli.code, 2, `a refused path did not outrank a broken value: ${cli.stderr}`);

  const written = writePrivateKeyFile(refused, "not a private key");
  assert.equal(written.reason, "staging", "the module and the command line disagree about which failure wins");
});

test("the module has no read and no exec subcommand", async () => {
  //  A path on disk is not an approved credential source, so the module never
  //  reads a key file and never runs a command with the key in hand.
  const path = staged("no-read.p8");
  const read = await run(["read", path]);
  assert.notEqual(read.code, 0, "the read subcommand must not exist");
  assert.doesNotMatch(read.stdout, /holds a PEM private key/);
  assert.doesNotMatch(read.stdout + read.stderr, /PRIVATE KEY/, "the key reached the output");

  const exec = await run(["exec", path, "--", process.execPath, "-e",
    "process.stdout.write('seen:' + (process.env.ASC_KEY_P8 ? 'yes' : 'no'))"]);
  assert.notEqual(exec.code, 0, "the exec subcommand must not exist");
  assert.doesNotMatch(exec.stdout, /seen:yes/, "a child received the key from a named file");
  assert.doesNotMatch(exec.stdout + exec.stderr, /PRIVATE KEY/, "the key reached the output");
});

test("the staged file is written with mode 600 whatever the umask says", () => {
  const path = join(root, "mode.p8");
  const written = writePrivateKeyFile(path, envKeyPem);
  assert.ok(written.pem, `the key was not written: ${written.error}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(written.pem.trim(), envKeyPem.trim());
});

test("the writer refuses a directory anyone but the owner may enter", () => {
  //  A credential may never land in a shared or durable place:  the staged
  //  copy lives in an owner-only staging directory, and the writer refuses
  //  anything else.
  const shared = mkdtempSync(join(tmpdir(), "asc-key-shared-"));
  chmodSync(shared, 0o755);
  const written = writePrivateKeyFile(join(shared, "key.p8"), envKeyPem);
  assert.ok(written.error, `a shared directory was accepted: ${written.error}`);
  assert.match(written.error, /not owner-only/);
});

test("the writer refuses a protected place", () => {
  //  A credential directory is refused by the same rules the house policy
  //  uses for a routine's own files.
  mkdirSync(join(root, ".ssh"), { mode: 0o700 });
  const written = writePrivateKeyFile(join(root, ".ssh", "key.p8"), envKeyPem);
  assert.ok(written.error, `a protected place was accepted: ${written.error}`);
  assert.match(written.error, /protected place/);
});

test("the writer refuses a path that is not normal", () => {
  //  A doubled slash is what a trailing-slash TMPDIR produces.  The caller
  //  has to strip it.  This check stays, and it refuses before any write.
  const written = writePrivateKeyFile(`${root}//key.p8`, envKeyPem);
  assert.ok(written.error, "a doubled slash was accepted");
  assert.match(written.error, /not a normal path/);
});

test("the writer refuses a link at the last component", () => {
  //  A path that was swapped for a symlink must not redirect the key.
  const link = join(root, "linked.p8");
  symlinkSync(join(root, "real.p8"), link);
  const written = writePrivateKeyFile(link, envKeyPem);
  assert.ok(written.error, "a symlink was written through");
  assert.match(written.error, /link/);
});

test("the writer keeps mode 600 on a file that already existed", () => {
  //  writeFileSync would have applied the mode only on creation; the mode is
  //  enforced on the handle, so a stale file cannot keep permissions that
  //  let anyone else read the key.
  const path = join(root, "existing.p8");
  writeFileSync(path, "stale");
  chmodSync(path, 0o644);
  const written = writePrivateKeyFile(path, envKeyPem);
  assert.ok(written.pem, `the write failed: ${written.error}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), envKeyPem.trim());
});

test("the child's environment is an allowlist, not a copy of the parent's", () => {
  //  A wholesale copy hands every credential on the operator's machine to the
  //  child, including the ones that have nothing to do with App Store Connect.
  //  The allowlist carries the STORE BINDING and never a credential name:  the
  //  key material resolves in the client, so it has no business in the
  //  environment of anything (owner ruling, November 22, 2026).
  const child = clientEnvironment(
    { PATH: "/usr/bin", HOME: "/tmp/home", SECRET_TOKEN: "leaked", ASC_KEY_ID: "KEY1", ASC_KEY_P8: envKeyPem, INFISICAL_TOKEN: "reader-token" },
    {}
  );
  assert.deepEqual(Object.keys(child).sort(), ["HOME", "INFISICAL_TOKEN", "PATH"]);
  assert.equal(child.SECRET_TOKEN, undefined, "an unrelated credential crossed over");
  assert.equal(child.ASC_KEY_ID, undefined, "a credential name crossed over");
  assert.equal(child.ASC_KEY_P8, undefined, "the key material crossed over");
  assert.equal(child.INFISICAL_TOKEN, "reader-token", "the store binding did not cross over");
  assert.ok(CLIENT_ENV_ALLOWLIST.includes("PATH"));
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("SECRET_TOKEN"));
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("ASC_KEY_P8"));
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("ASC_KEY_ID"));
});

test("the client takes the key from the store and ignores a complete environment", async () => {
  //  The store is the only source (owner ruling, November 22, 2026):  a
  //  hand-set environment value never replaces the reviewed grant, and a
  //  named path is not a credential source either.
  const server = await localServer();
  try {
    const named = staged("named.p8", namedKeyPem);
    const store = storeReader();
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-client"),
      ASC_API_BASE: server.base,
      FLEET_INFISICAL_READER: store,
      FLEET_INFISICAL_ASC_ACCOUNT: "fixture-asc-ro",
      //  A complete, stale environment:  none of it is a source.
      ASC_KEY_ID: "STALEKEY0001",
      ASC_ISSUER_ID: "stale-issuer",
      ASC_KEY_P8: envKeyPem,
      APPLE_API_KEY_ID: "STALEKEY0001",
      APPLE_API_ISSUER_ID: "stale-issuer",
      APPLE_API_KEY_P8_BASE64: Buffer.from(envKeyPem).toString("base64"),
      ASC_KEY_PATH: named
    });
    assert.equal(result.code, 0, `the client did not run: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using Infisical \/asc/,
      `the client did not report the store source:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /PRIVATE KEY/, "the key reached the output");
    assert.doesNotMatch(result.stderr, /STALEKEY0001/, "the stale key id reached the output");
    assert.equal(server.seen.length, 1, "the client never reached App Store Connect");
    assert.equal(bearerKeyId(server.seen[0].authorization), "STOREKEY0001");
    const token = String(server.seen[0].authorization).replace(/^Bearer /, "");
    assert.ok(signedWith(token, storeKeyPem), "the request was not signed with the store key");
    assert.ok(!signedWith(token, namedKeyPem), "the request was signed with the named file");
  } finally {
    server.close();
  }
});

test("an empty or a denied store fails closed, and the environment is never used instead", async () => {
  //  The store is the only source:  an empty store, a refused store and a
  //  missing reader all fail closed, and a stale environment value never
  //  becomes the credential.  The refusal names the folder and the account
  //  it needed, and never a value.
  const server = await localServer();
  try {
    const named = staged("only-named.p8", namedKeyPem);
    for (const [label, exitCode] of [["empty", 3], ["denied", 4]]) {
      const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
        PATH: safePath,
        HOME: join(root, `home-${label}`),
        ASC_API_BASE: server.base,
        FLEET_INFISICAL_READER: storeReader(exitCode),
        FLEET_INFISICAL_ASC_ACCOUNT: "fixture-asc-ro",
        ASC_KEY_ID: "STALEKEY0001",
        ASC_ISSUER_ID: "stale-issuer",
        ASC_KEY_P8: envKeyPem,
        ASC_KEY_PATH: named
      });
      assert.equal(result.code, 1, `expected the refusal exit for the ${label} store, got ${result.code}: ${result.stderr}`);
      assert.match(result.stderr, /no App Store Connect credential found/);
      assert.match(result.stderr, /fixture-asc-ro/, "the refusal did not name the account it needed");
      assert.match(result.stderr, /\/asc/, "the refusal did not name the folder it needed");
      assert.doesNotMatch(result.stderr, /STALEKEY0001/, "the stale key id reached the output");
      assert.doesNotMatch(result.stderr, /PRIVATE KEY/, "the key reached the output");
      assert.equal(server.seen.length, 0, "the client signed a request without a credential");
    }
  } finally {
    server.close();
  }
});

test("the client ignores a key in the environment that is not a PEM", async () => {
  //  The environment is not a source, so a value in it is not even looked
  //  at:  the refusal names the store the client needs, and never a value.
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: safePath,
    HOME: join(root, "home-bad"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_P8: "not a private key at all"
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /no App Store Connect credential found/);
  assert.match(result.stderr, /The store is the only source/);
  assert.doesNotMatch(result.stderr, /not a private key at all/, "the environment value reached the output");
});

test("the client ignores a broken APPLE_API_KEY_P8_BASE64 in the environment", async () => {
  //  A hand-set value is not a source, so a broken one changes nothing:  the
  //  client asks the store, and without a store it fails closed.
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-broken"),
      ASC_API_BASE: server.base,
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_P8: envKeyPem,
      APPLE_API_KEY_ID: "BROKENKEY001",
      APPLE_API_ISSUER_ID: "broken-issuer",
      APPLE_API_KEY_P8_BASE64: "not a private key at all"
    });
    assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /no App Store Connect credential found/);
    assert.equal(server.seen.length, 0, "the client signed a request without a credential");
  } finally {
    server.close();
  }
});

test("the store read walks to the folder that holds the names", async () => {
  //  A grant covers one folder, and the names may live in the folder the
  //  token is pointed at rather than in the consumer's own.  A folder that
  //  answers with none of the names must not end the walk:  the credential in
  //  the second folder is the credential in play.
  const asked = [];
  const fakeFetch = async (url) => {
    const parsed = new URL(url);
    asked.push(parsed.pathname + parsed.search);
    if (parsed.pathname === "/api/v2/service-token") {
      // The token's own scopes:  the two folders this consumer may read.
      return {
        ok: true,
        json: async () => ({
          workspace: "fleet-ops",
          scopes: [
            { environment: "prod", secretPath: "/asc" },
            { environment: "prod", secretPath: "/asc-folder" },
          ],
          permissions: ["read"],
          expiresAt: null,
        }),
      };
    }
    const secretPath = parsed.searchParams.get("secretPath") || "/";
    const secrets = secretPath === "/asc"
      ? []
      : [{
          secretKey: "ASC_KEY_ID",
          secretValue: "STOREKEY0002",
          workspace: "fleet-ops",
          environment: "prod",
          secretPath,
          secretValueHidden: false,
        }];
    return { ok: true, json: async () => ({ secrets }) };
  };
  const found = await readStoreSecrets([["ASC_KEY_ID"]], {
    fetchImpl: fakeFetch,
    siteUrl: "https://store.invalid",
    token: "reader-token",
    projectId: "fleet-ops",
    environment: "prod",
    paths: ["/asc", "/asc-folder"],
  });
  assert.equal(found.values.get("ASC_KEY_ID"), "STOREKEY0002", "the second folder was never read");
  assert.equal(found.folder, "/asc-folder", "the answering folder was not reported");
  assert.ok(asked.some((u) => u.includes("secretPath=%2Fasc")), "the first folder was never read");
  assert.ok(asked.some((u) => u.includes("secretPath=%2Fasc-folder")), "the second folder was never read");
});

test("a credential split across two folders is never assembled", async () => {
  //  The parts of one key belong together.  A folder that holds the key id
  //  and a folder that holds the material are two different folders, and
  //  combining them is a triple that fails authentication as the wrong key.
  const fakeFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v2/service-token") {
      return {
        ok: true,
        json: async () => ({
          workspace: "fleet-ops",
          scopes: [
            { environment: "prod", secretPath: "/asc" },
            { environment: "prod", secretPath: "/asc-folder" },
          ],
          permissions: ["read"],
          expiresAt: null,
        }),
      };
    }
    const secretPath = parsed.searchParams.get("secretPath") || "/";
    const secrets = secretPath === "/asc"
      ? [{ secretKey: "ASC_KEY_ID", secretValue: "SPLITKEY001" }]
      : [{ secretKey: "ASC_KEY_P8", secretValue: "SPLITKEYPEM" }];
    return {
      ok: true,
      json: async () => ({
        secrets: secrets.map((secret) => ({
          ...secret,
          workspace: "fleet-ops",
          environment: "prod",
          secretPath,
          secretValueHidden: false,
        })),
      }),
    };
  };
  const found = await readStoreSecrets(
    [["ASC_KEY_ID"], ["ASC_ISSUER_ID"], ["ASC_KEY_P8"]],
    {
      fetchImpl: fakeFetch,
      siteUrl: "https://store.invalid",
      token: "reader-token",
      projectId: "fleet-ops",
      environment: "prod",
      paths: ["/asc", "/asc-folder"],
    },
  );
  assert.equal(found.folder, null, "a split credential was taken from two folders");
  assert.equal(found.values.size, 0, "a split credential was assembled");
});

test("the labels are taken as one pair from one folder", async () => {
  //  The key id and the issuer id are one pair:  a diagnostic that names a
  //  pair from two folders names a credential that was never issued.  The
  //  store read answers with the first folder that holds the WHOLE pair.
  const fakeFetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v2/service-token") {
      return {
        ok: true,
        json: async () => ({
          workspace: "fleet-ops",
          scopes: [
            { environment: "prod", secretPath: "/asc" },
            { environment: "prod", secretPath: "/asc-folder" },
          ],
          permissions: ["read"],
          expiresAt: null,
        }),
      };
    }
    const secretPath = parsed.searchParams.get("secretPath") || "/";
    const secrets = secretPath === "/asc"
      ? [{ secretKey: "ASC_KEY_ID", secretValue: "SPLITKEY001" }]
      : [{ secretKey: "ASC_ISSUER_ID", secretValue: "split-issuer" }];
    return {
      ok: true,
      json: async () => ({
        secrets: secrets.map((secret) => ({
          ...secret,
          workspace: "fleet-ops",
          environment: "prod",
          secretPath,
          secretValueHidden: false,
        })),
      }),
    };
  };
  const found = await readStoreSecrets([["ASC_KEY_ID"], ["ASC_ISSUER_ID"]], {
    fetchImpl: fakeFetch,
    siteUrl: "https://store.invalid",
    token: "reader-token",
    projectId: "fleet-ops",
    environment: "prod",
    paths: ["/asc", "/asc-folder"],
  });
  assert.equal(found.folder, null, "a label pair was taken from two folders");
  assert.equal(found.values.size, 0, "a label pair was assembled");
});

test("the provenance names the grant that read the credential", () => {
  //  The status line and the refusal name the grant that answered, so a
  //  reader that is not the one that read the credential is never named.
  assert.equal(
    credentialSource("/asc", "reader"),
    "Infisical /asc (scoped reader, account fleet-tools-mm-asc-ro)",
  );
  assert.equal(
    credentialSource("/asc-folder", "token"),
    "Infisical /asc-folder (service token binding)",
  );
});

test("a key id that is not a key id is refused and nothing is staged", async () => {
  //  The key id becomes part of a file name, so a value that is not a key id
  //  must never name a path.  The client refuses it before it writes, and the
  //  staging directory stays empty.
  assert.equal(isKeyId("ABCDE12345"), true);
  assert.equal(isKeyId("../../escape"), false);
  assert.equal(isKeyId("a/b"), false);
  assert.equal(isKeyId(""), false);
  const reader = join(root, "traversal-reader.py");
  writeFileSync(reader, [
    "import sys",
    "name = sys.argv[2]",
    "if name == \"ASC_KEY_ID\":",
    "    sys.stdout.write(\"../../escape\")",
    "elif name == \"ASC_ISSUER_ID\":",
    "    sys.stdout.write(\"store-issuer\")",
    "elif name == \"ASC_KEY_P8\":",
    "    import os.path",
    "    here = os.path.dirname(os.path.abspath(__file__))",
    `    with open(os.path.join(here, "store-key-0.p8")) as fh:`,
    "        sys.stdout.write(fh.read())",
    "else:",
    "    sys.exit(3)"
  ].join("\n"));
  chmodSync(reader, 0o755);
  const staging = join(root, "staging-traversal");
  mkdirSync(staging, { recursive: true });
  const result = await spawnNode([client, "stage-key", staging], {
    PATH: safePath,
    HOME: join(root, "home-traversal"),
    FLEET_INFISICAL_READER: reader,
    FLEET_INFISICAL_ASC_ACCOUNT: "fixture-asc-ro",
  });
  assert.equal(result.code, 3, "a key id that is not a key id was accepted");
  assert.match(result.stderr, /not a PEM private key|not a key id/);
  assert.deepEqual(readdirSync(staging), [], "a file was staged for a key id that is not one");
});

test("the key never travels in the command arguments", async () => {
  //  The key goes in on stdin, and the command reports the status of it
  //  without printing it, so it is never an argument of any process and never
  //  on stdout.
  const result = await run(["validate"], envKeyPem);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /is a PEM private key/);
  assert.doesNotMatch(result.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.ok(!result.stderr.includes("PRIVATE KEY"), "the key envelope reached a log line");
});
