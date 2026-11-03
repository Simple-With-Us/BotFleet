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
    const bin = join(home, "fixture-bin");
    const probes = join(home, "container-probes");
    mkdirSync(bin);
    for (const executable of ["docker", "podman"]) {
      writeFileSync(join(bin, executable), '#!/bin/sh\nprintf "%s\\n" "${1:-missing}" >> "$CRED_SYNC_FIXTURE_PROBES"\nexit 1\n', { mode: 0o755 });
    }
    // One credential candidate so the run reaches the sync stage.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = T\n");
    let stdout = "";
    try {
      // Refusing fixture runtimes shadow any real Docker or podman on the host.
      // The script must take the empty-target path without executing in a container.
      stdout = execFileSync("bash", [SCRIPT, "--target", "local", "--home", home, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`,
          CRED_SYNC_FIXTURE_PROBES: probes,
        },
      });
    } catch (err) {
      assert.fail(`script crashed on the no-targets path (bash 3.2 empty-array regression?): ${err.message}`);
    }
    const lastLine = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const summary = JSON.parse(lastLine);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.targets, []);
    const verbs = readFileSync(probes, "utf8").trim().split("\n");
    assert.ok(verbs.length > 0, "the fixture must intercept runtime probes");
    assert.deepEqual([...new Set(verbs)], ["inspect"], "no container exec is attempted");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
