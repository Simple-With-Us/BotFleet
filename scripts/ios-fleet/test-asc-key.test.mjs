// The App Store Connect private key:  how it is validated, how it is staged
// for the Apple tools, and how the client takes it.
//
// The private key is a secret, and the approved secret sources are the process
// environment, a captured `fleet-secrets get NAME` and bootstrap-only Keychain
// credentials.  A caller-supplied file is not one of them, so the node client
// never reads a key file:  the shell layer that owns the credential writes a
// short-lived mode-600 copy and hands the key over in the environment.  These
// tests cover that handoff.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and nothing reaches the network beyond a local server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizePrivateKey, writePrivateKeyFile, CLIENT_ENV_ALLOWLIST, clientEnvironment } from "./asc-key.mjs";

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
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
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

test("the child's environment is an allowlist, not a copy of the parent's", () => {
  //  A wholesale copy hands every credential on the operator's machine to the
  //  child, including the ones that have nothing to do with App Store Connect.
  const child = clientEnvironment(
    { PATH: "/usr/bin", HOME: "/tmp/home", SECRET_TOKEN: "leaked", ASC_KEY_ID: "KEY1" },
    { ASC_KEY_P8: envKeyPem }
  );
  assert.deepEqual(Object.keys(child).sort(), ["ASC_KEY_ID", "ASC_KEY_P8", "HOME", "PATH"]);
  assert.equal(child.SECRET_TOKEN, undefined, "an unrelated credential crossed over");
  assert.equal(child.ASC_KEY_P8, envKeyPem);
  assert.ok(CLIENT_ENV_ALLOWLIST.includes("PATH"));
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("SECRET_TOKEN"));
});

test("the client takes the key from the environment and ignores a named ASC_KEY_PATH", async () => {
  //  This is the whole point of the port:  a named path is not a credential
  //  source, so the key that signs the request is the one in the environment
  //  and never the one somebody named on disk.
  const server = await localServer();
  try {
    const named = staged("named.p8", namedKeyPem);
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-client"),
      ASC_API_BASE: server.base,
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_P8: envKeyPem,
      ASC_KEY_PATH: named
    });
    assert.equal(result.code, 0, `the client did not run: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using ASC_KEY_P8 environment/,
      `the client did not report the environment source:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /PRIVATE KEY/, "the key reached the output");
    assert.equal(server.seen.length, 1, "the client never reached App Store Connect");
    assert.equal(bearerKeyId(server.seen[0].authorization), "SYNTHETICKEYID1");
    const token = String(server.seen[0].authorization).replace(/^Bearer /, "");
    assert.ok(signedWith(token, envKeyPem), "the request was not signed with the environment key");
    assert.ok(!signedWith(token, namedKeyPem), "the request was signed with the named file");
  } finally {
    server.close();
  }
});

test("a named ASC_KEY_PATH is not a credential source at all", async () => {
  //  With no key in the environment there is no credential, and the client
  //  says so in a way that names the path as the wrong thing to reach for.
  const server = await localServer();
  try {
    const named = staged("only-named.p8", namedKeyPem);
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-empty"),
      ASC_API_BASE: server.base,
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_PATH: named
    });
    assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /no App Store Connect credential found/);
    assert.match(result.stderr, /A path in ASC_KEY_PATH is not a credential source/);
    assert.equal(server.seen.length, 0, "the client signed a request without a credential");
  } finally {
    server.close();
  }
});

test("the client refuses a key in the environment that is not a PEM", async () => {
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: safePath,
    HOME: join(root, "home-bad"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_P8: "not a private key at all"
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /ASC_KEY_P8 is set but is not a PEM private key/);
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
