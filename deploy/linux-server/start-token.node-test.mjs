// Tests for start.sh's harness vault token loading.
//
// Run with:  node --test deploy/linux-server/start-token.node-test.mjs
// No dependencies, no network, no real node: a fake node binary (a shell
// script) stands in for both the storage preflight and the server exec.  The
// fake binary reports only whether INFISICAL_TOKEN was set and its length —
// never the value — and every token below is fake, built at runtime.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const START_SH = join(directory, "start.sh");

// Fake tokens, built at runtime so no token-shaped literal is in the source.
const FILE_TOKEN = `st.test-file-${crypto.randomBytes(8).toString("hex")}`;
const ENV_TOKEN = `st.test-env-${crypto.randomBytes(12).toString("hex")}`;

// The fake node binary: the storage preflight exits silently, and the server
// exec reports the token state (set or not, and its length) plus its argv, so
// the tests can prove the value never lands on argv.  It never prints the value.
const FAKE_NODE = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *check-storage.mjs) exit 0 ;;
  esac
done
if [ -z "\${INFISICAL_TOKEN:-}" ]; then
  echo "token_state=unset-or-empty"
else
  echo "token_state=set"
  echo "token_len=\${#INFISICAL_TOKEN}"
fi
echo "argv=$*"
`;

const posixOnly = { skip: process.platform === "win32" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "botfleet-start-token-"));
  const rr = join(root, "rr");
  const code = join(root, "code");
  mkdirSync(join(rr, "config"), { recursive: true });
  mkdirSync(join(rr, "logs"), { recursive: true });
  mkdirSync(join(rr, "bin"), { recursive: true });
  mkdirSync(join(rr, "data"), { recursive: true });
  mkdirSync(code, { recursive: true });
  const fakeNode = join(root, "fake-node.sh");
  writeFileSync(fakeNode, FAKE_NODE, { mode: 0o755 });
  return { root, rr, code, fakeNode, tokenFile: join(rr, "config", "harness-infisical-token") };
}

/** start.sh's environment: the runner's own, minus any real INFISICAL_TOKEN. */
function freshEnv(extra = {}) {
  const env = { ...process.env };
  delete env.INFISICAL_TOKEN;
  return { ...env, ...extra };
}

function runStart(fx, env) {
  const result = spawnSync("sh", [START_SH, fx.rr, fx.code, fx.fakeNode], { env, encoding: "utf8" });
  const logPath = join(fx.rr, "logs", "server.log");
  return { ...result, log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "" };
}

function withFixture(fn) {
  const fx = fixture();
  try {
    fn(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

test("loads the harness token file into INFISICAL_TOKEN for the server exec", posixOnly, () => {
  withFixture((fx) => {
    writeFileSync(fx.tokenFile, `${FILE_TOKEN}\n`, { mode: 0o600 });
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.match(run.log, /^token_state=set$/m);
    assert.match(run.log, new RegExp(`^token_len=${FILE_TOKEN.length}$`, "m"));
    assert.match(run.log, /--experimental-strip-types .*server\/index\.ts --require-data-volume/);
    // never echoed, never on argv
    assert.ok(!run.log.includes(FILE_TOKEN));
    assert.ok(!run.stderr.includes(FILE_TOKEN));
    assert.ok(!(run.stdout ?? "").includes(FILE_TOKEN));
  });
});

test("an INFISICAL_TOKEN already in the environment wins over the file", posixOnly, () => {
  withFixture((fx) => {
    writeFileSync(fx.tokenFile, FILE_TOKEN, { mode: 0o600 });
    const run = runStart(fx, freshEnv({ INFISICAL_TOKEN: ENV_TOKEN }));
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.match(run.log, /^token_state=set$/m);
    assert.match(run.log, new RegExp(`^token_len=${ENV_TOKEN.length}$`, "m"));
    assert.ok(!run.log.includes(FILE_TOKEN));
  });
  withFixture((fx) => {
    // the file is not even consulted: a broken file plus env is silent
    writeFileSync(join(fx.rr, "config", "real-token"), FILE_TOKEN, { mode: 0o600 });
    symlinkSync(join(fx.rr, "config", "real-token"), fx.tokenFile);
    const run = runStart(fx, freshEnv({ INFISICAL_TOKEN: ENV_TOKEN }));
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.match(run.log, new RegExp(`^token_len=${ENV_TOKEN.length}$`, "m"));
  });
});

test("refuses a symlinked token file and starts without it", posixOnly, () => {
  withFixture((fx) => {
    writeFileSync(join(fx.rr, "config", "real-token"), FILE_TOKEN, { mode: 0o600 });
    symlinkSync(join(fx.rr, "config", "real-token"), fx.tokenFile);
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr.trim().split("\n").length, 1);
    assert.ok(run.stderr.includes(fx.tokenFile));
    assert.match(run.stderr, /symlink/);
    assert.match(run.log, /^token_state=unset-or-empty$/m);
    assert.ok(!run.stderr.includes(FILE_TOKEN));
    assert.ok(!run.log.includes(FILE_TOKEN));
  });
});

test("refuses a token file with group or other permission bits", posixOnly, () => {
  withFixture((fx) => {
    writeFileSync(fx.tokenFile, FILE_TOKEN, { mode: 0o600 });
    chmodSync(fx.tokenFile, 0o640);
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr.trim().split("\n").length, 1);
    assert.ok(run.stderr.includes(fx.tokenFile));
    assert.match(run.stderr, /group or other/);
    assert.match(run.log, /^token_state=unset-or-empty$/m);
    assert.ok(!run.stderr.includes(FILE_TOKEN));
  });
});

test("refuses a token path that is not a regular file", posixOnly, () => {
  withFixture((fx) => {
    mkdirSync(fx.tokenFile);
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr.trim().split("\n").length, 1);
    assert.ok(run.stderr.includes(fx.tokenFile));
    assert.match(run.stderr, /not a regular file/);
    assert.match(run.log, /^token_state=unset-or-empty$/m);
  });
});

test("ignores an empty token file with a note", posixOnly, () => {
  withFixture((fx) => {
    writeFileSync(fx.tokenFile, "", { mode: 0o600 });
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr.trim().split("\n").length, 1);
    assert.ok(run.stderr.includes(fx.tokenFile));
    assert.match(run.stderr, /ignoring.*empty/);
    assert.match(run.log, /^token_state=unset-or-empty$/m);
  });
  withFixture((fx) => {
    writeFileSync(fx.tokenFile, "\n", { mode: 0o600 });
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.match(run.stderr, /ignoring.*empty/);
    assert.match(run.log, /^token_state=unset-or-empty$/m);
  });
});

test("starts fine with no token file", posixOnly, () => {
  withFixture((fx) => {
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.match(run.log, /^token_state=unset-or-empty$/m);
  });
});

test("strips one trailing newline and CR from the token file", posixOnly, () => {
  withFixture((fx) => {
    writeFileSync(fx.tokenFile, `${FILE_TOKEN}\r\n`, { mode: 0o600 });
    const run = runStart(fx, freshEnv());
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.match(run.log, new RegExp(`^token_len=${FILE_TOKEN.length}$`, "m"));
  });
});
