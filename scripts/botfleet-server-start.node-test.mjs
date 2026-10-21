// Exercises the tracked LaunchAgent entry point end to end with a fake
// checkout, a missing pnpm, and a stub node -- no real dependency install or
// harness boot.  The behavior under test: launchd (KeepAlive.SuccessfulExit
// false, ThrottleInterval 5) respawns this script every 5-7s on any non-zero
// exit, so a persistently broken checkout must eventually exit 0 to stop the
// storm, and a later genuine success must clear that ledger.  See
// scripts/botfleet-server-start.sh and docs/audits/2026-09-24-efficiency-audit.md OP10.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  return { dir, serverRoot, ledger: join(dir, "ledger"), marker: join(dir, "stopped.marker"), disabled: join(dir, "startup-disabled.marker"), enabled: join(dir, "startup-enabled.marker"), session: join(dir, "startup-session"), port };
}

function run(fixture, { threshold = 20, windowSeconds = 3600, args = [], node = "/bin/echo", xpcServiceName = "" } = {}) {
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
      // Always a fixture-local marker, never the real ~/.botfleet one: a test
      // that could see the owner's actual shutdown sentinel would both read
      // his state and be able to clear it.
      BOTFLEET_SHUTDOWN_MARKER: fixture.marker,
      BOTFLEET_STARTUP_DISABLED_MARKER: fixture.disabled,
      BOTFLEET_STARTUP_ENABLED_MARKER: fixture.enabled,
      BOTFLEET_STARTUP_SESSION: fixture.session,
      BOTFLEET_BOOT_SESSION_OVERRIDE: "fixture-boot",
      // Explicit rather than inherited: every other test in this file models
      // a person or a generic launchd run, not this specific agent, and an
      // XPC_SERVICE_NAME leaking in from the shell would silently change which
      // branch they take.
      XPC_SERVICE_NAME: xpcServiceName,
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

// --- Immutable releases ------------------------------------------------------
//
// The dependency self-heal used to run `pnpm install --frozen-lockfile` INSIDE
// $ROOT and record its "heal attempted" stamp there too.  Both break once $ROOT
// is a promoted release: the directory is read-only by construction and is
// supposed to stay byte-identical to the commit it names.  The failure is quiet
// either way — a permissions error that says nothing useful, or a successful
// reinstall that leaves a release matching nothing the updater verified.

const RELEASE_COMMIT = "abc123def4567890abcdef1234567890abcdef12";

function makeReleaseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-server-start-release-"));
  const serverRoot = join(dir, "releases", RELEASE_COMMIT);
  mkdirSync(join(serverRoot, "server"), { recursive: true });
  writeFileSync(join(serverRoot, "server", "index.ts"), "// fake entry\n");
  // No node_modules, which is what triggers the heal in the first place.
  writeFileSync(
    join(serverRoot, ".botfleet-release.json"),
    `${JSON.stringify({ schemaVersion: 1, commit: RELEASE_COMMIT, promotedAt: "2026-10-04T00:00:00.000Z" }, null, 2)}\n`,
  );
  const logFile = join(dir, "server.log");
  // A pnpm that records that it was called, so "did not reinstall" is
  // observable rather than inferred from a log line.
  const pnpmCalled = join(dir, "pnpm-was-called");
  const pnpmStub = join(dir, "pnpm-stub");
  writeFileSync(pnpmStub, `#!/bin/sh\ntouch "${pnpmCalled}"\nexit 0\n`);
  chmodSync(pnpmStub, 0o755);
  const port = 20000 + Math.floor(Math.random() * 20000);
  return { dir, serverRoot, logFile, pnpmCalled, pnpmStub, ledger: join(dir, "ledger"), port };
}

function runRelease(fixture) {
  return spawnSync("bash", [SCRIPT, "--heal-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.dir}:${process.env.PATH}`,
      HOME: fixture.dir,
      BOTFLEET_SERVER_ROOT: fixture.serverRoot,
      BOTFLEET_PORT: String(fixture.port),
      BOTFLEET_NODE: "/bin/echo",
      BOTFLEET_PNPM: fixture.pnpmStub,
      BOTFLEET_SERVER_LOG: fixture.logFile,
      BOTFLEET_FAIL_LEDGER: fixture.ledger,
      BOTFLEET_FAIL_STORM_THRESHOLD: "20",
      BOTFLEET_FAIL_WINDOW_SECONDS: "3600",
      BOTFLEET_SHUTDOWN_MARKER: join(fixture.dir, "stopped.marker"),
      BOTFLEET_STARTUP_DISABLED_MARKER: join(fixture.dir, "startup-disabled.marker"),
      BOTFLEET_STARTUP_ENABLED_MARKER: join(fixture.dir, "startup-enabled.marker"),
      BOTFLEET_STARTUP_SESSION: join(fixture.dir, "startup-session"),
      BOTFLEET_BOOT_SESSION_OVERRIDE: "fixture-boot",
    },
  });
}

test("a release with missing dependencies is not repaired in place", () => {
  const fixture = makeReleaseFixture();
  try {
    const result = runRelease(fixture);
    assert.equal(existsSync(fixture.pnpmCalled), false, "pnpm must not run against an immutable release");
    // log_err writes to stderr; the log file is only what launchd captures from
    // the harness process itself, which never starts here.
    const said = `${result.stdout || ""}${result.stderr || ""}`;
    assert.match(said, /immutable release/);
    // A refusal with no alternative leaves the operator with nothing to do, so
    // the message has to name the commit and what to run instead.
    assert.match(said, new RegExp(RELEASE_COMMIT.slice(0, 12)), "the refusal must name the broken release");
    assert.match(said, /update-botfleet\.sh/, "the refusal must say what to run instead");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a mutable checkout is still repaired in place", () => {
  // The other direction matters just as much: the release store must not have
  // cost the fast repair for a half-deleted node_modules in an ordinary
  // checkout, which is a recurring failure on this machine.
  const dir = mkdtempSync(join(tmpdir(), "botfleet-heal-still-works-"));
  try {
    const serverRoot = join(dir, "root");
    mkdirSync(join(serverRoot, "server"), { recursive: true });
    writeFileSync(join(serverRoot, "server", "index.ts"), "// fake entry\n");
    const pnpmCalled = join(dir, "pnpm-was-called");
    const pnpmStub = join(dir, "pnpm-stub");
    writeFileSync(pnpmStub, `#!/bin/sh\ntouch "${pnpmCalled}"\nexit 0\n`);
    chmodSync(pnpmStub, 0o755);
    const fixture = {
      dir,
      serverRoot,
      pnpmCalled,
      pnpmStub,
      logFile: join(dir, "server.log"),
      ledger: join(dir, "ledger"),
      port: 20000 + Math.floor(Math.random() * 20000),
    };
    runRelease(fixture);
    assert.equal(existsSync(fixture.pnpmCalled), true, "a mutable checkout must still self-heal in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the heal stamp's default is not inside the root", () => {
  // The stamp is mutable state.  Writing it into a read-only release fails on
  // exactly the code path whose job is to report a problem.
  const source = readFileSync(SCRIPT, "utf8");
  const stamp = source.match(/STAMP="\$\{BOTFLEET_HEAL_STAMP:(.+?)\}"/);
  assert.ok(stamp, "the stamp must keep an overridable default");
  assert.doesNotMatch(stamp[1], /\$ROOT/, "the default stamp must not live inside $ROOT");
});

test("the root is resolved physically so a pointer is not mistaken for a path", () => {
  // `current` is a symlink into releases/<commit>.  If the launcher keeps the
  // symlink, the server's working directory is the POINTER rather than the
  // release — and the updater's dependency fingerprint and bundle identity
  // checks both refuse a symlinked root, so the two halves would disagree about
  // which directory they are reasoning about.
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /cd -P "\$ROOT"/, "the root must be resolved with a physical cd");
});

// --- Infisical machine identity ----------------------------------------------
//
// launchd does not inherit a desktop session, so the only identity the harness
// can recover after a restart is the pair `fleet-secrets get` returns.  These
// tests use a private HOME with a fake $HOME/.local/bin/fleet-secrets (backed by
// a plain NAME=value file inside the fixture) and a node stub that records only fixture-prefixed
// values (anything else is reported as "other") so a real secret can never
// land in the assertion output.

function writeIdentityNode(dir) {
  const recorder = join(dir, "record-env.mjs");
  const stub = join(dir, "node-stub");
  const names = [
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  ];
  // The launcher execs `$NODE --experimental-strip-types -e ...` for the import
  // probe and `$NODE --experimental-strip-types server/index.ts` to boot.  The
  // probe must succeed without importing the fixture.  The boot must record
  // only fixture-prefixed identity values, never an arbitrary environment value.
  writeFileSync(
    recorder,
    [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "if (args.includes('-e')) process.exit(0);",
      "const report = process.env.BOTFLEET_ENV_REPORT;",
      "if (!report) { console.error('BOTFLEET_ENV_REPORT missing'); process.exit(1); }",
      "const names = " + JSON.stringify(names) + ";",
      "const lines = names.map((name) => {",
      "  if (!Object.hasOwn(process.env, name)) return name + '=unset';",
      "  const value = process.env[name];",
      "  if (value === '') return name + '=empty';",
      "  if (value.startsWith('fixture-')) return name + '=' + value;",
      "  return name + '=other';",
      "});",
      "writeFileSync(report, lines.join('\\n') + '\\n');",
    ].join("\n"),
  );
  writeFileSync(stub, "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(recorder) + ' "$@"\n');
  chmodSync(stub, 0o755);
  return stub;
}

function identityFixture() {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-identity-"));
  const serverRoot = join(dir, "root");
  mkdirSync(join(serverRoot, "server"), { recursive: true });
  mkdirSync(join(serverRoot, "node_modules", "yaml"), { recursive: true });
  writeFileSync(join(serverRoot, "server", "index.ts"), "// fake entry\n");
  const home = join(dir, "home");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  return {
    dir,
    serverRoot,
    home,
    keys: join(dir, "fake-store"),
    bin: join(home, ".local", "bin", "fleet-secrets"),
    report: join(dir, "env-report"),
    node: writeIdentityNode(dir),
    ledger: join(dir, "ledger"),
    port: 20000 + Math.floor(Math.random() * 20000),
  };
}

// Installs a fake `fleet-secrets` whose `get NAME` prints the value of the first
// NAME=value line in the fixture store (no quote stripping, like the real one)
// and exits 3 when the name is absent.
function writeKeys(fixture, body) {
  writeFileSync(fixture.keys, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
  installFakeFleetSecrets(fixture, [
    "#!/bin/sh",
    '[ "$1" = get ] || exit 2',
    `line="$(grep -m1 "^$2=" ${JSON.stringify(fixture.keys)})" || exit 3`,
    'printf "%s" "${line#*=}"',
  ].join("\n"));
}

function installFakeFleetSecrets(fixture, script) {
  writeFileSync(fixture.bin, `${script}\n`);
  chmodSync(fixture.bin, 0o755);
}

function runIdentity(fixture, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("INFISICAL_")) delete env[key];
  }
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...env,
      ...extraEnv,
      HOME: fixture.home,
      BOTFLEET_ENV_REPORT: fixture.report,
      BOTFLEET_SERVER_ROOT: fixture.serverRoot,
      BOTFLEET_PORT: String(fixture.port),
      BOTFLEET_NODE: fixture.node,
      BOTFLEET_PNPM: join(fixture.dir, "pnpm-does-not-exist"),
      BOTFLEET_HEAL_STAMP: join(fixture.dir, "heal-stamp"),
      BOTFLEET_SERVER_LOG: join(fixture.dir, "server.log"),
      BOTFLEET_FAIL_LEDGER: fixture.ledger,
      BOTFLEET_FAIL_STORM_THRESHOLD: "20",
      BOTFLEET_FAIL_WINDOW_SECONDS: "3600",
      BOTFLEET_SHUTDOWN_MARKER: join(fixture.dir, "stopped.marker"),
      BOTFLEET_STARTUP_DISABLED_MARKER: join(fixture.dir, "startup-disabled.marker"),
      BOTFLEET_STARTUP_ENABLED_MARKER: join(fixture.dir, "startup-enabled.marker"),
      BOTFLEET_STARTUP_SESSION: join(fixture.dir, "startup-session"),
      BOTFLEET_BOOT_SESSION_OVERRIDE: "fixture-boot",
    },
  });
}

function identityReport(fixture, result) {
  assert.equal(result.status, 0, `launcher failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  const said = `${result.stdout || ""}${result.stderr || ""}`;
  assert.doesNotMatch(said, /fixture-/, "the launcher must not print identity values");
  assert.equal(existsSync(fixture.report), true, "the node stub did not record the environment");
  return Object.fromEntries(
    readFileSync(fixture.report, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
}

test("the Infisical identity banner is 7-bit ASCII", () => {
  const line = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .find((row) => row.includes("the Infisical machine identity"));
  assert.ok(line, "the identity section banner is missing");
  assert.match(line, /^# --- the Infisical machine identity/);
  assert.equal([...line].some((ch) => ch.charCodeAt(0) > 127), false);
});

test("documented names are fetched and exported, and nothing else is", () => {
  const fixture = identityFixture();
  try {
    writeKeys(
      fixture,
      [
        "INFISICAL_CLIENT_ID=fixture-canonical-id",
        "INFISICAL_CLIENT_SECRET=fixture-canonical-secret",
        "UNRELATED_TOKEN=fixture-should-not-leak",
      ].join("\n"),
    );
    const got = identityReport(fixture, runIdentity(fixture));
    assert.equal(got.INFISICAL_CLIENT_ID, "fixture-canonical-id");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "fixture-canonical-secret");
    assert.equal(got.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID, "unset");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("automation file names map onto the env names the harness already resolves", () => {
  const fixture = identityFixture();
  try {
    writeKeys(
      fixture,
      ["INFISICAL_AUTOMATION_CLIENT_ID=fixture-auto-id", "INFISICAL_AUTOMATION_CLIENT_SECRET=fixture-auto-secret"].join("\n"),
    );
    const got = identityReport(fixture, runIdentity(fixture));
    assert.equal(got.INFISICAL_CLIENT_ID, "fixture-auto-id");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "fixture-auto-secret");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a documented key wins over the automation name when both are present", () => {
  const fixture = identityFixture();
  try {
    writeKeys(
      fixture,
      [
        "INFISICAL_AUTOMATION_CLIENT_ID=fixture-auto-id",
        "INFISICAL_CLIENT_ID=fixture-canonical-id",
        "INFISICAL_AUTOMATION_CLIENT_SECRET=fixture-auto-secret",
        "INFISICAL_CLIENT_SECRET=fixture-canonical-secret",
      ].join("\n"),
    );
    const got = identityReport(fixture, runIdentity(fixture));
    assert.equal(got.INFISICAL_CLIENT_ID, "fixture-canonical-id");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "fixture-canonical-secret");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a blank documented line falls through to the automation name", () => {
  const fixture = identityFixture();
  try {
    writeKeys(
      fixture,
      [
        "INFISICAL_CLIENT_ID=",
        "INFISICAL_AUTOMATION_CLIENT_ID=fixture-auto-id",
        "INFISICAL_CLIENT_SECRET=",
        "INFISICAL_AUTOMATION_CLIENT_SECRET=fixture-auto-secret",
      ].join("\n"),
    );
    const got = identityReport(fixture, runIdentity(fixture));
    assert.equal(got.INFISICAL_CLIENT_ID, "fixture-auto-id");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "fixture-auto-secret");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a store with no identity does not export empty strings", () => {
  const fixture = identityFixture();
  try {
    writeKeys(fixture, "OTHER_TOKEN=fixture-unrelated\n");
    const got = identityReport(fixture, runIdentity(fixture, {
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "fixture-alias-id",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "fixture-alias-secret",
    }));
    assert.equal(got.INFISICAL_CLIENT_ID, "unset");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "unset");
    assert.equal(got.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID, "fixture-alias-id");
    assert.equal(got.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, "fixture-alias-secret");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a half pair from fleet-secrets is not exported", () => {
  const fixture = identityFixture();
  try {
    writeKeys(fixture, "INFISICAL_CLIENT_ID=fixture-only-id\n");
    const got = identityReport(fixture, runIdentity(fixture));
    assert.equal(got.INFISICAL_CLIENT_ID, "unset");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "unset");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an identity already in the environment is not replaced by fleet-secrets", () => {
  const fixture = identityFixture();
  try {
    writeKeys(
      fixture,
      ["INFISICAL_CLIENT_ID=fixture-file-id", "INFISICAL_CLIENT_SECRET=fixture-file-secret"].join("\n"),
    );
    const got = identityReport(fixture, runIdentity(fixture, {
      INFISICAL_CLIENT_ID: "fixture-env-id",
      INFISICAL_CLIENT_SECRET: "fixture-env-secret",
    }));
    assert.equal(got.INFISICAL_CLIENT_ID, "fixture-env-id");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "fixture-env-secret");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a missing fleet-secrets still forwards an identity the environment already holds", () => {
  const fixture = identityFixture();
  try {
    const got = identityReport(fixture, runIdentity(fixture, {
      INFISICAL_CLIENT_ID: "fixture-env-id",
      INFISICAL_CLIENT_SECRET: "fixture-env-secret",
    }));
    assert.equal(got.INFISICAL_CLIENT_ID, "fixture-env-id");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "fixture-env-secret");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a failing fleet-secrets does not stop the harness", () => {
  const fixture = identityFixture();
  try {
    installFakeFleetSecrets(fixture, "#!/bin/sh\nexit 4");
    const got = identityReport(fixture, runIdentity(fixture));
    assert.equal(got.INFISICAL_CLIENT_ID, "unset");
    assert.equal(got.INFISICAL_CLIENT_SECRET, "unset");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// --- the intentional-shutdown sentinel (BF-2489) --------------------------
//
// The behavior that matters: with StartInterval=300 and
// KeepAlive.SuccessfulExit=false, a harness that exits cleanly is still run
// again five minutes later, and a closed port reads as a crash.  So "shut it
// down" from inside the app cannot stick on its own — the wrapper has to know
// the stop was deliberate, and the only way it can know is a file.

test("a shutdown marker makes the launchd tick exit 0 without starting anything", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.marker, "stopped on purpose\n");
    const result = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /shut down on purpose/);
    // It must not have fallen through and tried to boot a harness.
    assert.doesNotMatch(result.stdout, /Starting server|exec .*node/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the launchd tick leaves the marker in place", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.marker, "stopped on purpose\n");
    run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.ok(existsSync(fixture.marker), "the marker must survive the tick, or the next one would restart it");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("dependency preparation preserves a deliberate stop and boot policy", () => {
  const fixture = makeFixture({ withDependencies: true });
  try {
    writeFileSync(fixture.marker, "intentionally stopped\n");
    writeFileSync(fixture.disabled, "");
    writeFileSync(fixture.session, "previous-boot\n");
    const result = run(fixture, { args: ["--heal-only"] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.marker, "utf8"), "intentionally stopped\n");
    assert.equal(readFileSync(fixture.session, "utf8"), "previous-boot\n");
    assert.equal(existsSync(fixture.disabled), true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("login-disabled launchd run stays stopped until explicitly started this boot", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.disabled, "disabled\n");
    writeFileSync(fixture.marker, "stopped\n");
    const blocked = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /startup is disabled at login/);
    assert.ok(existsSync(fixture.marker));
    assert.ok(!existsSync(fixture.session));
    run(fixture);
    assert.equal(readFileSync(fixture.session, "utf8").trim(), "fixture-boot");
    assert.ok(!existsSync(fixture.marker));
    assert.ok(existsSync(fixture.disabled));
    const sameBoot = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.doesNotMatch(sameBoot.stdout, /startup is disabled at login/);
    writeFileSync(fixture.session, "previous-boot\n");
    const nextBoot = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.match(nextBoot.stdout, /startup is disabled at login/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("explicit login enablement starts on the next boot and clears an older stop", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.enabled, "enabled\n");
    writeFileSync(fixture.marker, "stopped\n");
    writeFileSync(fixture.session, "previous-boot\n");
    const result = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.match(result.stdout, /startup is enabled at login/);
    assert.ok(!existsSync(fixture.marker));
    assert.equal(readFileSync(fixture.session, "utf8").trim(), "fixture-boot");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a stop during the current boot remains stopped despite login enablement", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.enabled, "enabled\n");
    writeFileSync(fixture.marker, "stopped\n");
    writeFileSync(fixture.session, "fixture-boot\n");
    const result = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.match(result.stdout, /shut down on purpose/);
    assert.ok(existsSync(fixture.marker));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("without explicit login enablement an older stop stays durable", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.marker, "stopped\n");
    writeFileSync(fixture.session, "previous-boot\n");
    const result = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.match(result.stdout, /shut down on purpose/);
    assert.ok(existsSync(fixture.marker));
    assert.equal(readFileSync(fixture.session, "utf8").trim(), "previous-boot");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("disabled login policy wins if both startup markers exist", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.enabled, "enabled\n");
    writeFileSync(fixture.disabled, "disabled\n");
    writeFileSync(fixture.marker, "stopped\n");
    writeFileSync(fixture.session, "previous-boot\n");
    const result = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.match(result.stdout, /startup is disabled at login/);
    assert.ok(existsSync(fixture.marker));
    assert.equal(readFileSync(fixture.session, "utf8").trim(), "previous-boot");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("a manual run clears the marker and starts, which is the way back", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(fixture.marker, "stopped on purpose\n");
    const result = run(fixture, { xpcServiceName: "" });
    assert.ok(!existsSync(fixture.marker), "a person asking for the server must not be blocked by the sentinel");
    assert.match(result.stdout + result.stderr, /treating it as a deliberate start/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("no marker means the tick behaves exactly as before", () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, { xpcServiceName: "app.botfleet.server" });
    assert.doesNotMatch(result.stdout + result.stderr, /shut down on purpose/);
    assert.ok(!existsSync(fixture.marker), "the script must not invent a marker");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/**
 * A fake node that records the directory it ran in, by writing a marker
 * file into its own working directory.
 *
 * Comparing the reported path as a string is not good enough: the launcher
 * runs under the platform's shell, and on Windows that shell reports a path
 * in its own dialect (`/c/Users/...`) while Node reports the native one
 * (`C:\Users\...`).  Both name the same directory, and a suffix match over
 * either is loose enough to pass for a sibling checkout.
 *
 * So the marker is the assertion: wherever it LANDS is the directory the
 * harness actually ran in, whatever dialect the shell used to say so.
 */
function fakeNodeScript(markerName) {
  return `#!/bin/bash\ntouch "$PWD/${markerName}"\necho fake\n`;
}

// --- The store pointer is the runtime root ------------------------------------
//
// A checkout is a mutable working tree, and three separate failures came from
// it: an update rewrote it under a live server, a seat's branch deleted files
// the harness still imported, and the janitor removed its node_modules from
// under a serving process.  A promoted release is immutable, and the pointer
// at ~/.botfleet/current is the only thing that changes when the harness
// moves to a new version.
//
// The launcher must therefore prefer the store pointer when one exists, and
// must still fall back to the legacy checkout path on a machine that has
// never promoted a release, so a fresh install is not broken by this change.

test("the store pointer is the runtime root when it exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-server-start-pointer-"));
  const storeHome = join(dir, "home");
  const releaseDir = join(storeHome, ".botfleet", "releases", "a".repeat(40));
  mkdirSync(join(releaseDir, "server"), { recursive: true });
  writeFileSync(join(releaseDir, "server", "index.ts"), "// fake entry\n");
  mkdirSync(join(releaseDir, "node_modules", "yaml"), { recursive: true });
  const pointer = join(storeHome, ".botfleet", "current");
  symlinkSync(releaseDir, pointer);

  // The stub node writes a marker into its own working directory, so the
  // assertion is on the directory the harness actually ran in.
  const node = join(dir, "fake-node");
  writeFileSync(node, fakeNodeScript("ran-here.txt"));
  chmodSync(node, 0o755);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: storeHome,
      // No BOTFLEET_SERVER_ROOT: the launcher must find the pointer itself.
      BOTFLEET_PORT: String(port),
      BOTFLEET_NODE: node,
      BOTFLEET_PNPM: join(dir, "pnpm-does-not-exist"),
      BOTFLEET_HEAL_STAMP: join(dir, "heal-stamp"),
      BOTFLEET_FAIL_LEDGER: join(dir, "ledger"),
      BOTFLEET_SHUTDOWN_MARKER: join(dir, "stopped.marker"),
      BOTFLEET_STARTUP_DISABLED_MARKER: join(dir, "startup-disabled.marker"),
      BOTFLEET_STARTUP_ENABLED_MARKER: join(dir, "startup-enabled.marker"),
      BOTFLEET_STARTUP_SESSION: join(dir, "startup-session"),
      BOTFLEET_BOOT_SESSION_OVERRIDE: "fixture-boot",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  // The marker must have landed in the RELEASE, and nowhere else: not in the
  // store root, not beside the pointer, and not in the fixture root.
  assert.ok(existsSync(join(releaseDir, "ran-here.txt")), "the harness must run from the release directory");
  assert.equal(existsSync(join(storeHome, ".botfleet", "ran-here.txt")), false, "the harness must not run from the store root");
  assert.equal(existsSync(join(dir, "ran-here.txt")), false, "the harness must not run from the fixture root");
});

test("without a store pointer the legacy checkout path still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-server-start-nopointer-"));
  const serverRoot = join(dir, "root");
  mkdirSync(join(serverRoot, "server"), { recursive: true });
  writeFileSync(join(serverRoot, "server", "index.ts"), "// fake entry\n");
  mkdirSync(join(serverRoot, "node_modules", "yaml"), { recursive: true });
  const node = join(dir, "fake-node");
  writeFileSync(node, fakeNodeScript("ran-here.txt"));
  chmodSync(node, 0o755);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      BOTFLEET_SERVER_ROOT: serverRoot,
      BOTFLEET_PORT: String(port),
      BOTFLEET_NODE: node,
      BOTFLEET_PNPM: join(dir, "pnpm-does-not-exist"),
      BOTFLEET_HEAL_STAMP: join(dir, "heal-stamp"),
      BOTFLEET_FAIL_LEDGER: join(dir, "ledger"),
      BOTFLEET_SHUTDOWN_MARKER: join(dir, "stopped.marker"),
      BOTFLEET_STARTUP_DISABLED_MARKER: join(dir, "startup-disabled.marker"),
      BOTFLEET_STARTUP_ENABLED_MARKER: join(dir, "startup-enabled.marker"),
      BOTFLEET_STARTUP_SESSION: join(dir, "startup-session"),
      BOTFLEET_BOOT_SESSION_OVERRIDE: "fixture-boot",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(serverRoot, "ran-here.txt")), "the harness must still run from the legacy checkout path");
  assert.equal(existsSync(join(dir, "ran-here.txt")), false, "the harness must not run from the fixture root");
});
