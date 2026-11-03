// Tests for scripts/sync-cli-credentials.sh, in particular the macOS
// bash 3.2 empty-array crash on the --json no-targets path:
// "${SYNCED_TARGETS[@]}" under `set -u` aborts the script when no target
// synced, so the guard ${SYNCED_TARGETS[@]+"${SYNCED_TARGETS[@]}"} must be
// used.  The functional case runs the script with a credential-bearing
// fake HOME and no reachable container, forcing the empty-targets JSON
// path; the source assertion pins the guard so a refactor cannot drop it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-cli-credentials.sh");
const SRC = readFileSync(SCRIPT, "utf8");

// Windows CI does not ship bash.  Keep the static guard assertion on every
// platform; run shell syntax and behavior checks only where bash exists.
const bashAvailable = process.platform !== "win32" && !spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore" }).error;

test("script parses under bash", { skip: !bashAvailable }, () => {
  execFileSync("bash", ["-n", SCRIPT]);
});

test("json no-targets path uses the bash 3.2-safe empty-array idiom", () => {
  assert.match(SRC, /\$\{SYNCED_TARGETS\[@\]\+"\$\{SYNCED_TARGETS\[@\]\}"\}/);
  // Every expansion of the array must sit inside the + guard (lookbehind).
  assert.doesNotMatch(SRC, /(?<!\+)"\$\{SYNCED_TARGETS\[@\]\}"/);
});

test("--json with no synced target exits 0 and prints an empty targets list", { skip: !bashAvailable }, () => {
  const home = mkdtempSync(join(tmpdir(), "cred-sync-"));
  try {
    const bin = join(home, "bin");
    const calls = join(home, "container-client-calls");
    mkdirSync(bin);
    for (const client of ["docker", "podman"]) {
      writeFileSync(join(bin, client), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CRED_SYNC_TEST_LOG"\nexit 1\n', { mode: 0o755 });
    }
    // One credential candidate so the run reaches the sync stage.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = T\n");
    let stdout = "";
    try {
      // Container clients are always stubs, even on a host with running VMs.
      // A unique target is an additional fence against touching a real VM.
      stdout = execFileSync("bash", [SCRIPT, "--target", "local", "--container", `fixture-${home.split(/[\\/]/).pop()}`, "--home", home, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`,
          CRED_SYNC_TEST_LOG: calls,
        },
      });
    } catch (err) {
      assert.fail(`script crashed on the no-targets path (bash 3.2 empty-array regression?): ${err.message}`);
    }
    const lastLine = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const summary = JSON.parse(lastLine);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.targets, []);
    assert.match(readFileSync(calls, "utf8"), /^inspect /);
    assert.doesNotMatch(readFileSync(calls, "utf8"), /(?:^|\n)exec /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a refused archive copy never reports a synced container or hardens its files", { skip: !bashAvailable }, () => {
  const home = mkdtempSync(join(tmpdir(), "cred-sync-refused-"));
  try {
    const bin = join(home, "bin");
    const calls = join(home, "container-client-calls");
    mkdirSync(bin);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Fixture\n");
    const stub = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CRED_SYNC_TEST_LOG"\nif [ "$1" = inspect ]; then printf "true\\n"; exit 0; fi\ncat > /dev/null\nexit 42\n';
    for (const client of ["docker", "podman"]) {
      writeFileSync(join(bin, client), stub, { mode: 0o755 });
    }
    const stdout = execFileSync("bash", [SCRIPT, "--target", "local", "--container", "fixture-refused-copy", "--home", home, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`,
        CRED_SYNC_TEST_LOG: calls,
      },
    });
    const summary = JSON.parse(stdout.trim().split("\n").filter((line) => line.startsWith("{")).pop());
    assert.deepEqual(summary.targets, []);
    const invoked = readFileSync(calls, "utf8");
    assert.equal(invoked.split("\n").filter((line) => line.startsWith("exec ")).length, 1);
    assert.doesNotMatch(invoked, / sh -c /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
