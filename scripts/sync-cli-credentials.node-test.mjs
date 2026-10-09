// Tests for scripts/sync-cli-credentials.sh, in particular the macOS
// bash 3.2 empty-array crash on the --json no-targets path:
// "${SYNCED_TARGETS[@]}" under `set -u` aborts the script when no target
// synced, so the guard ${SYNCED_TARGETS[@]+"${SYNCED_TARGETS[@]}"} must be
// used.  The functional case runs the script with a credential-bearing
// fake HOME and no reachable container, forcing the empty-targets JSON
// path; the source assertion pins the guard so a refactor cannot drop it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
    // One credential candidate so the run reaches the sync stage.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = T\n");
    let stdout = "";
    try {
      // No docker/podman on this runner: every sync attempt fails, so
      // SYNCED_TARGETS stays empty and the JSON summary takes the
      // empty-array path.  set -e aborts inside command substitutions do
      // not kill the script because the JSON block is the last thing run.
      stdout = execFileSync("bash", [SCRIPT, "--target", "local", "--home", home, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          HOME: home,
          PATH: `${process.execPath.replace(/\/node$/, "")}:/usr/bin:/bin`,
        },
      });
    } catch (err) {
      assert.fail(`script crashed on the no-targets path (bash 3.2 empty-array regression?): ${err.message}`);
    }
    const lastLine = stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const summary = JSON.parse(lastLine);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.targets, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
