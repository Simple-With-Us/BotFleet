import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Guards for the two review-autofix callers.  Both call a reusable workflow in another repo, so
// actionlint cannot see the callee and a mismatch only shows up as a startup failure on every
// bot review.  PR #1217 repinned both callers;  this file keeps the parts that broke before.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// Secret names passed under the job's `secrets:` map (six-space keys, comments skipped).
function passedSecrets(yml) {
  const lines = yml.split("\n");
  const start = lines.findIndex((line) => /^ {4}secrets:\s*$/.test(line));
  assert.notEqual(start, -1, "job has a secrets: map");
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(line)) break;
    const match = /^ {6}([A-Za-z0-9_]+):/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

test("claude-code-autofix.yml passes only secrets the codex reusable declares", () => {
  const yml = read(".github/workflows/claude-code-autofix.yml");
  // codex-autofix-reusable.yml declares MINIMAX_API_KEY and an ignored GH_PAT.  Passing
  // GH_ADMIN_PAT failed every run with "Invalid secret, GH_ADMIN_PAT is not defined in the
  // referenced workflow" (run 39054950004), and no fleet workflow may act as the owner.
  assert.deepEqual(passedSecrets(yml), ["MINIMAX_API_KEY"]);
  assert.doesNotMatch(yml, /secrets\.GH_ADMIN_PAT/);
});

test("autofix.yml passes only secrets the pr-autofix reusable declares", () => {
  const yml = read(".github/workflows/autofix.yml");
  assert.deepEqual(passedSecrets(yml), ["MINIMAX_API_KEY", "AUTOFIX_GITHUB_APP_PRIVATE_KEY"]);
});

test("both autofix callers pin their reusable workflow to a full commit SHA", () => {
  const pins = [
    [".github/workflows/autofix.yml", "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/pr-autofix-reusable.yml"],
    [".github/workflows/claude-code-autofix.yml", "Simple-With-Us/congress-trading-shared/.github/workflows/codex-autofix-reusable.yml"],
  ];
  for (const [file, callee] of pins) {
    const uses = read(file).match(/^ {4}uses:\s*(\S+)\s*$/m);
    assert.ok(uses, `${file} has a job-level uses:`);
    const [path, ref] = uses[1].split("@");
    assert.equal(path, callee, `${file} calls ${callee}`);
    assert.match(ref ?? "", /^[0-9a-f]{40}$/, `${file} pins ${callee} to a 40-hex SHA`);
  }
});

test("PR Autofix is not pinned to a reusable revision that deadlocks", () => {
  // 2e671004 (AI-Fleet-Coordinator #520) up to its #611 gave the reusable job the same concurrency
  // group the caller holds, so GitHub cancelled every run as a deadlock before a step ran
  // (runs 39012365598, 39054950194).  #611 merged as c525150d.
  const ref = read(".github/workflows/autofix.yml").match(/pr-autofix-reusable\.yml@([0-9a-f]+)/)?.[1] ?? "";
  for (const bad of ["2e671004", "3fac4c3c"]) {
    assert.ok(!ref.startsWith(bad), `pr-autofix-reusable.yml is pinned to deadlocking ${bad}`);
  }
});

test("autofix callers keep their least-privilege and fork guards", () => {
  const autofix = read(".github/workflows/autofix.yml");
  assert.match(autofix, /^permissions: \{\}\s*$/m, "autofix.yml grants nothing at workflow level");
  assert.match(autofix, /^ {6}contents: write\n {6}pull-requests: read\n/m);
  assert.match(autofix, /github\.event_name == 'pull_request_review' && contains\(fromJSON\('\["bot", "Bot"\]'\), github\.event\.review\.user\.type\)/);
  assert.match(autofix, /github\.event_name != 'pull_request_review' && contains\(fromJSON\('\["bot", "Bot"\]'\), github\.event\.comment\.user\.type\)/);

  const claude = read(".github/workflows/claude-code-autofix.yml");
  assert.match(claude, /github\.event\.review\.user\.type == 'Bot'/);
  assert.match(claude, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
});
