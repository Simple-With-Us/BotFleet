import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Guards for the two review-autofix callers.  Both call a reusable workflow in another repo, so
// actionlint cannot see the callee and a mismatch only shows up as a startup failure on every
// bot review.  PR #1217 repinned both callers;  this file keeps the parts that broke before.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Windows CI checks files out with CRLF line endings;  the assertions below are written for LF.
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
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

test("claude-code-autofix.yml passes only secrets the Claude reusable declares", () => {
  const yml = read(".github/workflows/claude-code-autofix.yml");
  // claude-code-autofix-reusable.yml declares MINIMAX_API_KEY, an optional USAGE_INGEST_TOKEN (UM-1593 metering),  the optional
  // org META_MODEL_API_TOKEN for the model switch (2026-10-21),  and an ignored GH_PAT.  Passing
  // GH_ADMIN_PAT failed every run with "Invalid secret, GH_ADMIN_PAT is not defined in the
  // referenced workflow" (run 39054950004), and no fleet workflow may act as the owner.
  assert.deepEqual(passedSecrets(yml), ["MINIMAX_API_KEY", "META_MODEL_API_TOKEN", "USAGE_INGEST_TOKEN"]);
  assert.doesNotMatch(yml, /secrets\.GH_ADMIN_PAT/);
});

test("autofix.yml passes only secrets the pr-autofix reusable declares", () => {
  const yml = read(".github/workflows/autofix.yml");
  assert.deepEqual(passedSecrets(yml), ["MINIMAX_API_KEY", "META_MODEL_API_TOKEN", "AUTOFIX_GITHUB_APP_PRIVATE_KEY", "USAGE_INGEST_TOKEN"]);
});

test("the trusted policy pins no model while the org-switch revision is pinned", () => {
  // Kody on #1289:  with the switch revision pinned,  a model id in the
  // trusted file is one more place that must move when the fleet switches,
  // and it never wins -  the org variable outranks any file pin.  Keep it out.
  const trusted = read(".github/pr-autofix-trusted.yml");
  assert.doesNotMatch(trusted, /^model:/m, "the trusted policy must not pin a model id");
});

test("both autofix callers pin their reusable workflow to a full commit SHA", () => {
  const pins = [
    [".github/workflows/autofix.yml", "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/pr-autofix-reusable.yml"],
    [".github/workflows/claude-code-autofix.yml", "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/claude-code-autofix-reusable.yml"],
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
  // Exact-SHA guard (Kody on #1289): the pr-autofix caller passes
  // META_MODEL_API_TOKEN, which only the model-switch revision declares - a
  // silent repin to anything else fails validation on every run.  c97a2dae is
  // that revision now: closed host preset, fail-closed credential, request gate,
  // Validate Model Switch guard.
  assert.equal(
    ref,
    "c97a2dae96762eb9ffc122c753f0dfb0a7840650",
    "pr-autofix-reusable.yml pin must stay on the model-switch revision",
  );
});

test("autofix callers keep their least-privilege and fork guards", () => {
  const autofix = read(".github/workflows/autofix.yml");
  assert.match(autofix, /^permissions: \{\}\s*$/m, "autofix.yml grants nothing at workflow level");
  assert.match(autofix, /^ {6}contents: write\n {6}pull-requests: read\n/m);
  // The caller delegates identity enforcement to the pinned reusable.  Its
  // local gate must still control invocation and reject closed/non-PR events.
  assert.match(autofix, /^ {4}needs: decide$/m);
  assert.ok(autofix.includes("needs.decide.outputs.run == 'true' &&"));
  assert.ok(autofix.includes("(github.event.issue.pull_request || github.event.pull_request) &&"));
  assert.ok(autofix.includes("(github.event.issue.state == 'open' || github.event.pull_request.state == 'open')"));
  assert.match(autofix, /^ {6}run: \$\{\{ steps\.gate\.outputs\.run \}\}$/m);
  assert.ok(autofix.includes('grep -q \'@autofix\' <<< "$body"'));
  for (const reviewer of ["kody-ai[bot]", "chatgpt-codex-connector[bot]", "sentry[bot]"]) {
    assert.ok(autofix.includes(`"$REVIEWER" = "${reviewer}"`), `automatic reviews include ${reviewer}`);
  }
  assert.ok(autofix.includes('[ "$EVENT_NAME" = "pull_request_review" ]'));
  // Current state-gate wiring only: this does not establish that inline-only
  // COMMENTED findings are recognized.  That functional gap remains separate.
  assert.ok(autofix.includes('[ "$state" = "changes_requested" ]'));
  assert.ok(autofix.includes('[ "$state" = "commented" ]'));
  assert.ok(autofix.includes('[ -n "${body//[[:space:]]/}" ]'));
  assert.ok(autofix.includes('[ "$total" -le 1 ]'));
  assert.ok(autofix.includes('echo "run=false" >> "$GITHUB_OUTPUT"'));

  // Pin the declared policy, without claiming this proves the external
  // reusable's actor guard or its support for human tagged invocations.
  const autofixrc = read(".autofix.yml");
  for (const bot of [
    "jaywedgeworth22", "kody-ai[bot]", "chatgpt-codex-connector[bot]",
    "sentry[bot]", "github-actions[bot]", "sonarcloud[bot]", "codacy-production[bot]",
  ]) {
    assert.ok(autofixrc.includes(`- ${bot}`), `.autofix.yml allows ${bot}`);
  }

  const claude = read(".github/workflows/claude-code-autofix.yml");
  assert.match(claude, /github\.event\.review\.user\.type == 'Bot'/);
  assert.match(claude, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
});

test("Claude Autofix keeps the Sentry-capable pin and same-repository bot gate", () => {
  const claude = read(".github/workflows/claude-code-autofix.yml");
  // 2026-10-20: repinned to the AFC pin that retires MiniMax-M3.1-Flash-Preview,
  // and the caller now passes allowed_bots explicitly - the reusable default
  // drops claude/claude[bot] and refuses swu-echo dispatches, which blocked an
  // owner-directed rerun (run 39531317324).
  // 2026-10-21: repinned again for the org model switch (c97a2dae carries the
  // closed host preset,  the fail-closed credential,  the request gate,  and the
  // Validate Model Switch guard).
  // Compare the job-level uses: ref itself (as the PR Autofix guard does),  not a
  // whole-file text match that a comment quoting the SHA would also satisfy.
  const claudeUses = [...claude.matchAll(/^ {4}uses:\s*(\S+)\s*$/gm)].map(
    (m) => m[1],
  );
  assert.ok(
    claudeUses.includes(
      "Simple-With-Us/AI-Fleet-Coordinator/.github/workflows/claude-code-autofix-reusable.yml@c97a2dae96762eb9ffc122c753f0dfb0a7840650",
    ),
    "claude-code-autofix-reusable.yml pin must stay on the model-switch revision",
  );
  assert.match(claude, /^\s+allowed_bots: .*swu-echo/m);
  const guard = claude.match(/^ {4}if: >-\n([\s\S]*?)^ {4}uses:/m)?.[1];
  assert.ok(guard, "Claude Autofix has a job-level guard");
  assert.equal(
    guard.replace(/\s+/g, " ").trim(),
    "github.event_name == 'workflow_dispatch' || " +
      "(github.event_name == 'pull_request_review' && " +
      "github.event.review.user.type == 'Bot' && " +
      "github.event.pull_request.head.repo.full_name == github.repository)",
  );
});
