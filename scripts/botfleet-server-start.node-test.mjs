// Exercises the tracked LaunchAgent entry point end to end with a fake
// checkout, a missing pnpm, and a stub node -- no real dependency install or
// harness boot.  The behavior under test: launchd (KeepAlive.SuccessfulExit
// false, ThrottleInterval 5) respawns this script every 5-7s on any non-zero
// exit, so a persistently broken checkout must eventually exit 0 to stop the
// storm, and a later genuine success must clear that ledger.  See
// scripts/botfleet-server-start.sh and docs/audits/2026-09-24-efficiency-audit.md OP10.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/botfleet-server-start.sh");

function makeFixture({ withDependencies = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-server-start-test-"));
  const serverRoot = join(dir, "root");
  mkdirSync(join(serverRoot, "server"), { recursive: true });
  writeFileSync(join(serverRoot, "server", "index.ts"), "// fake entry\n");
  if (withDependencies) {
    mkdirSync(join(serverRoot, "node_modules", "yaml"), { recursive: true });
  }
  // Randomized per fixture: this Mac runs many concurrent agent harnesses
  // and test fixtures, and a fixed "obviously not the real 8799" port
  // (18799 was tried) collided with something else already listening on
  // it, making health() see a false positive and every test past it fail.
  const port = 20000 + Math.floor(Math.random() * 20000);
  return { dir, serverRoot, ledger: join(dir, "ledger"), port };
}

function run(fixture, { threshold = 20, windowSeconds = 3600, args = [], node = "/bin/echo" } = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      BOTFLEET_SERVER_ROOT: fixture.serverRoot,
      BOTFLEET_PORT: String(fixture.port),
      BOTFLEET_NODE: node,
      BOTFLEET_PNPM: join(fixture.dir, "pnpm-does-not-exist"),
      BOTFLEET_HEAL_STAMP: join(fixture.serverRoot, ".botfleet-heal-stamp"),
      BOTFLEET_FAIL_LEDGER: fixture.ledger,
      BOTFLEET_FAIL_STORM_THRESHOLD: String(threshold),
      BOTFLEET_FAIL_WINDOW_SECONDS: String(windowSeconds),
    },
  });
}

test("bash -n accepts the script", () => {
  const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("--help prints usage without touching the ledger", () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, { args: ["--help"] });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an ordinary failure below the storm threshold exits 1 and records the ledger", () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, { threshold: 20 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not on PATH; cannot self-heal/);
    assert.doesNotMatch(result.stderr, /giving up so launchd stops restarting/);
    const [count] = readFileSync(fixture.ledger, "utf8").trim().split(" ");
    assert.equal(count, "1");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the storm threshold stops launchd's loop with exit 0 and names the fix", () => {
  const fixture = makeFixture();
  try {
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = run(fixture, { threshold: 3 });
    }
    assert.equal(last.status, 0);
    assert.match(last.stderr, /failed 3 times in the last 60 minutes; giving up so launchd stops restarting it/);
    assert.match(last.stderr, /FIX: cd .* && .*pnpm-does-not-exist install --frozen-lockfile/);
    assert.match(last.stderr, /com\.jay\.mac-process-watch retries this job every 120s/);

    // Stays latched (still exits 0) on the very next attempt inside the same
    // window, so launchd never resumes rapid-firing on its own.
    const again = run(fixture, { threshold: 3 });
    assert.equal(again.status, 0);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a rolling window that has aged out starts counting over", () => {
  const fixture = makeFixture();
  try {
    // Seed a ledger whose window started at the Unix epoch -- however long
    // this test takes to run, that is well past a 5s window -- so the next
    // failure is treated as the start of a fresh burst, not a third.
    writeFileSync(fixture.ledger, "2 1\n");
    const result = run(fixture, { threshold: 3, windowSeconds: 5 });
    assert.equal(result.status, 1, "an aged-out window must not still be latched");
    const [count] = readFileSync(fixture.ledger, "utf8").trim().split(" ");
    assert.equal(count, "1");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a genuine success resets the ledger", () => {
  const fixture = makeFixture({ withDependencies: true });
  try {
    writeFileSync(fixture.ledger, "5 1\n");
    // /bin/echo stands in for node: the import probe (`node ... -e "..."`)
    // and the final `exec` both just echo their arguments and exit 0.
    const result = run(fixture, { threshold: 3 });
    assert.equal(result.status, 0);
    assert.throws(() => readFileSync(fixture.ledger, "utf8"), /ENOENT/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a missing checkout is an ordinary preflight failure, not an unhandled crash", () => {
  const fixture = makeFixture();
  rmSync(join(fixture.serverRoot, "server", "index.ts"));
  try {
    const result = run(fixture, { threshold: 20 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing .*server\/index\.ts/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
