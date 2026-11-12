import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dependencyScopeStatus, verifyReleaseAgainstCommit } from "./release-provenance.mjs";

/**
 * REAL-INSTALL QUALIFICATION - opt-in, network + pnpm required.
 *
 *   BF_PROVENANCE_INSTALL=1 node --test scripts/release-provenance-install.node-test.mjs
 *
 * Run from a COMPLETE checkout of the reviewed commit (the full repo tree;
 * partial archives omit workspace manifests and patches the install reads).
 * pnpm must be the repo's pinned packageManager (package.json); the test
 * asserts the pin before installing.  This is a MANUAL/reviewer-run
 * qualification: no CI workflow wires it today.
 *
 * What it proves, end to end with normal links and hooks:
 *  1. Two fresh installs of the SAME commit at DIFFERENT paths fingerprint
 *     identically - the dependency-scope fingerprint is content, never
 *     embedded absolute paths.
 *  2. A real pnpm workspace graph (links from node_modules into the repo's
 *     own packages) passes confinement with ZERO link problems.
 *  3. Both installed trees verify against the commit's git objects.
 */
const ENABLED = process.env.BF_PROVENANCE_INSTALL === "1";
// Lazily resolved inside the test: a partial archive without .git must still
// load the module and skip cleanly.
const COMMIT = () => process.env.BF_PROVENANCE_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const REPO = () => process.env.BF_PROVENANCE_REPO || process.cwd();

function installAt(t, label, repo, commit) {
  const dir = mkdtempSync(join(tmpdir(), `botfleet-prov-install-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }));
  execFileSync("git", ["-C", repo, "archive", "--format=tar", "--output", join(dir, "tree.tar"), commit], { stdio: "inherit" });
  execFileSync("tar", ["-xf", join(dir, "tree.tar"), "-C", dir], { stdio: "inherit" });
  rmSync(join(dir, "tree.tar"), { force: true });
  execFileSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: dir,
    stdio: "inherit",
    timeout: 30 * 60_000,
    env: { ...process.env },
  });
  return dir;
}

test("two real installs of one commit at different paths fingerprint identically, confined, verified", { skip: !ENABLED && "set BF_PROVENANCE_INSTALL=1 (needs network + pinned pnpm)" }, async (t) => {
  const repo = REPO();
  const commit = COMMIT();
  const pinned = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).packageManager;
  const pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  assert.equal(`pnpm@${pnpmVersion}`, pinned, "the install must run the repo's pinned packageManager");
  const first = installAt(t, "a", repo, commit);
  const second = installAt(t, "b", repo, commit);
  const scopeA = dependencyScopeStatus(first);
  const scopeB = dependencyScopeStatus(second);
  assert.deepEqual(scopeA.linkProblems, [], `links outside custody under ${first}`);
  assert.deepEqual(scopeB.linkProblems, [], `links outside custody under ${second}`);
  assert.ok(scopeA.fingerprint, "the install produced a dependency scope");
  assert.equal(scopeA.fingerprint, scopeB.fingerprint,
    "the fingerprint is tree content - absolute paths must never leak into it");
  for (const dir of [first, second]) {
    const verdict = verifyReleaseAgainstCommit({ releaseRoot: dir, commit, repo });
    assert.equal(verdict.ok, true, `${dir}: ${verdict.detail || "source verifies"}`);
  }
}, { timeout: 40 * 60_000 });
