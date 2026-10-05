#!/usr/bin/env node
/**
 * Per-rule lint baseline ratchet.
 *
 * Replaces the global `--max-warnings` cap (which let a removed warning offset a
 * newly introduced one) with a per-rule baseline: CI fails if ANY rule's warning
 * count rises above its checked-in baseline, even if the total stays flat.
 *
 * Usage:
 *   node scripts/check-lint-baseline.mjs
 *     Check the working tree against .oxlint-baseline.json.  This is `pnpm lint`
 *     and the main-push job.
 *   node scripts/check-lint-baseline.mjs --update
 *     Rewrite the baseline with current counts.  Use it only to tighten the
 *     file after cleaning violations, or to record an allowed pull-request
 *     increase at the exact measured count.
 *   node scripts/check-lint-baseline.mjs --baseline-ref origin/main
 *     Pull-request mode.  Lint the working tree (GitHub's merge commit,
 *     refs/pull/<n>/merge) and compare those counts to the baseline ON the
 *     base ref, not to the copy of the file in the branch.  A branch that is
 *     only behind the base does not regenerate .oxlint-baseline.json.
 *
 * Allow path for a real baseline increase (reviewable, not a silent JSON bump):
 *   The pull-request workflow sets LINT_BASELINE_ALLOW_INCREASE=1 only when
 *   the pull request has the label `allow-lint-baseline-increase`.
 *   Each raised rule must then be committed at the measured merge-commit
 *   count.  Headroom above that count still fails.  Rewriting the JSON with
 *   --update does not itself make the pull request green.
 *
 * The baseline lives in .oxlint-baseline.json at the repo root.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_INCREASE_LABEL = "allow-lint-baseline-increase";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, ".oxlint-baseline.json");

export function ruleIdFromCode(code) {
  // oxlint JSON uses "plugin(rule-name)"; normalize to "plugin/rule-name".
  // (Avoid `typeof` here: this file is itself linted by anti-slop/no-runtime-typeof.)
  if (code != null && code.endsWith?.(")")) {
    const open = code.indexOf("(");
    if (open > 0) return `${code.slice(0, open)}/${code.slice(open + 1, -1)}`;
  }
  return String(code);
}

export function allowIncreaseFromEnv(env = process.env) {
  return env.LINT_BASELINE_ALLOW_INCREASE === "1";
}

export function assertSafeRef(ref) {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error(`Refusing baseline ref ${JSON.stringify(ref)}.`);
  }
}

export function parseArgs(argv, env = process.env) {
  let update = false;
  let allowIncrease = allowIncreaseFromEnv(env);
  let baselineRef = env.LINT_BASELINE_REF ?? null;
  if (baselineRef === "") baselineRef = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") {
      update = true;
    } else if (arg === "--allow-increase") {
      allowIncrease = true;
    } else if (arg === "--baseline-ref") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--baseline-ref needs a git ref.");
      }
      i += 1;
      baselineRef = next;
    } else if (arg.startsWith("--baseline-ref=")) {
      baselineRef = arg.slice("--baseline-ref=".length);
      if (!baselineRef) throw new Error("--baseline-ref needs a git ref.");
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  if (update && baselineRef) {
    throw new Error(
      "--update rewrites the working tree baseline and cannot be combined with --baseline-ref.  " +
        "Pull request CI does not treat a rewritten baseline as success.",
    );
  }
  if (baselineRef) assertSafeRef(baselineRef);
  return { update, allowIncrease, baselineRef };
}

function runOxlintJson() {
  const localBin = join(repoRoot, "node_modules", ".bin", "oxlint");
  let raw;
  const attempts = [
    { cmd: localBin, args: [".", "--format=json"] },
    { cmd: "npx", args: ["--no-install", "oxlint", ".", "--format=json"] },
  ];
  let lastErr;
  for (const { cmd, args } of attempts) {
    try {
      raw = execFileSync(cmd, args, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
      });
      lastErr = undefined;
      break;
    } catch (err) {
      // oxlint exits non-zero when diagnostics exist; stdout still carries JSON.
      if (err.stdout) {
        raw = err.stdout;
        lastErr = undefined;
        break;
      }
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return JSON.parse(raw);
}

export function countByRule(diagnostics) {
  const warnings = new Map();
  const errors = [];
  for (const diagnostic of diagnostics ?? []) {
    const rule = ruleIdFromCode(diagnostic.code);
    if (diagnostic.severity === "error") {
      errors.push(`${rule} in ${diagnostic.filename}`);
    } else if (diagnostic.severity === "warning") {
      warnings.set(rule, (warnings.get(rule) ?? 0) + 1);
    }
  }
  return { warnings, errors };
}

function asCountMap(current) {
  if (current instanceof Map) return current;
  return new Map(Object.entries(current ?? {}));
}

/**
 * Decide whether the ratchet holds.
 *
 * working-tree: compare measured counts to the baseline file in the tree.
 *   Used by `pnpm lint` and the main-push job.
 * base-ref: compare measured counts (the merge commit) to the base branch's
 *   baseline.  Also reject a committed baseline that rises above the base,
 *   or that sits below the measured counts, unless the allow path is on.
 *   The allow path still requires each raised rule to equal the measurement.
 */
export function evaluateRatchet({
  baselineRules = {},
  committedRules = null,
  current,
  errors = [],
  allowIncrease = false,
  mode = "working-tree",
}) {
  if (mode !== "working-tree" && mode !== "base-ref") {
    throw new Error(`Unknown ratchet mode ${JSON.stringify(mode)}.`);
  }
  const counts = asCountMap(current);
  const committed = committedRules ?? baselineRules;
  const increased = [];
  const decreased = [];
  const fileRaised = [];
  const exactMismatch = [];
  const belowMeasured = [];
  const rules = new Set([
    ...Object.keys(baselineRules),
    ...Object.keys(committed),
    ...counts.keys(),
  ]);

  for (const rule of [...rules].sort()) {
    const base = baselineRules[rule] ?? 0;
    const now = counts.get(rule) ?? 0;
    const committedCount = committed[rule] ?? 0;
    if (now > base) increased.push({ rule, base, now, committed: committedCount });
    else if (now < base) decreased.push({ rule, base, now });

    if (mode !== "base-ref") continue;
    const raised = now > base || committedCount > base;
    if (committedCount > base) {
      fileRaised.push({ rule, base, now, committed: committedCount });
    }
    if (raised && allowIncrease && committedCount !== now) {
      exactMismatch.push({ rule, base, now, committed: committedCount });
    }
    if (!raised && committedCount < now) {
      belowMeasured.push({ rule, base, now, committed: committedCount });
    }
  }

  let failed = errors.length > 0;
  if (mode === "working-tree") {
    if (increased.length > 0) failed = true;
  } else if (allowIncrease) {
    if (exactMismatch.length > 0 || belowMeasured.length > 0) failed = true;
  } else if (increased.length > 0 || fileRaised.length > 0 || belowMeasured.length > 0) {
    failed = true;
  }

  return {
    failed,
    increased,
    decreased,
    fileRaised,
    exactMismatch,
    belowMeasured,
    errors,
    mode,
  };
}

export function formatRatchetReport(result, { baselineRef = null, allowIncrease = false } = {}) {
  const lines = [];
  if (result.errors.length > 0) {
    lines.push(`ERROR: ${result.errors.length} lint error(s) (errors always fail):`);
    for (const error of result.errors.slice(0, 20)) lines.push(`  - ${error}`);
    if (result.errors.length > 20) {
      lines.push(`  ... and ${result.errors.length - 20} more`);
    }
    lines.push("");
  }

  const ceiling = baselineRef ? `the baseline on ${baselineRef}` : "its baseline";
  if (result.increased.length > 0 && !(result.mode === "base-ref" && allowIncrease)) {
    lines.push(`ERROR: per-rule warning count is above ${ceiling}:`);
    for (const row of result.increased) {
      lines.push(`  - ${row.rule}: baseline ${row.base}, now ${row.now} (+${row.now - row.base})`);
    }
    lines.push("");
    if (result.mode === "base-ref") {
      lines.push("Fix the new violations in the merge commit.");
      lines.push("Do not run --update and commit .oxlint-baseline.json to get green.");
      lines.push("That file is not the ceiling on a pull request.  The ceiling is the baseline on the base branch.");
      lines.push(
        `An increase is allowed only with the pull request label ${BASELINE_INCREASE_LABEL}, ` +
          "and each raised rule must be committed at the measured merge-commit count.",
      );
      lines.push("");
    } else {
      lines.push("Fix the new violations.");
      lines.push("On a pull request, rewriting .oxlint-baseline.json does not make CI green.");
      lines.push(
        `The allow path is the label ${BASELINE_INCREASE_LABEL}, at the measured merge-commit count.`,
      );
      lines.push("--update only rewrites this file.  Use it to tighten after a cleanup, or to record that allowed count.");
      lines.push("");
    }
  }

  if (result.fileRaised.length > 0 && !allowIncrease) {
    lines.push(`ERROR: .oxlint-baseline.json raises a rule above ${ceiling}:`);
    for (const row of result.fileRaised) {
      lines.push(`  - ${row.rule}: base ${row.base}, committed ${row.committed}`);
    }
    lines.push("");
    lines.push("Bumping this JSON is not a green path.");
    lines.push("Revert .oxlint-baseline.json, or add the label " + BASELINE_INCREASE_LABEL + ".");
    lines.push("With that label, each raised rule must equal the measured merge-commit count.  No headroom.");
    lines.push("");
  }

  if (result.belowMeasured.length > 0) {
    lines.push("ERROR: .oxlint-baseline.json is below the merge commit's measured counts:");
    for (const row of result.belowMeasured) {
      lines.push(
        `  - ${row.rule}: committed ${row.committed}, measured ${row.now}, base ${row.base}`,
      );
    }
    lines.push("");
    lines.push("A branch that is only behind the base does not need a new baseline.");
    lines.push("This job lints the merge commit and compares it to the baseline on the base branch.");
    lines.push("Revert .oxlint-baseline.json to the base branch version.  Do not regenerate it.");
    lines.push("");
  }

  if (result.exactMismatch.length > 0) {
    lines.push(
      `ERROR: label ${BASELINE_INCREASE_LABEL} requires each raised rule to equal the measured count (no headroom):`,
    );
    for (const row of result.exactMismatch) {
      lines.push(
        `  - ${row.rule}: base ${row.base}, measured ${row.now}, committed ${row.committed}`,
      );
    }
    lines.push("");
  }

  const allowed = result.mode === "base-ref" && allowIncrease && !result.failed
    ? result.increased.filter((row) => row.committed === row.now)
    : [];
  if (allowed.length > 0) {
    lines.push(`Allowed baseline increase (label ${BASELINE_INCREASE_LABEL}):`);
    for (const row of allowed) {
      lines.push(`  - ${row.rule}: base ${row.base}, measured ${row.now}, committed ${row.committed}`);
    }
    lines.push("");
  }

  if (result.decreased.length > 0) {
    lines.push("Cleaned up since baseline (tighten it with --update when ready):");
    for (const row of result.decreased) {
      lines.push(`  - ${row.rule}: baseline ${row.base}, now ${row.now} (-${row.base - row.now})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function originBranchFromRef(ref) {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : null;
}

function gitExec(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function refExists(ref, cwd) {
  try {
    gitExec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

// Pull-request runners sometimes only have the merge commit checked out.
// Fetch the base branch so the ceiling is main's baseline, not the file in
// the head.  A missing ref stays a hard failure.  There is no fallback to
// the working tree copy.
export function ensureBaselineRef(ref, cwd = repoRoot) {
  assertSafeRef(ref);
  if (refExists(ref, cwd)) return;
  const branch = originBranchFromRef(ref);
  if (!branch) {
    throw new Error(
      `Baseline ref ${ref} is not in this checkout, and only origin/<branch> is fetched automatically.`,
    );
  }
  const fetchArgs = ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
  if (gitExec(["rev-parse", "--is-shallow-repository"], cwd).trim() === "true") {
    fetchArgs.push("--unshallow");
  }
  try {
    gitExec(fetchArgs, cwd);
  } catch (err) {
    const detail = err.stderr || err.message || "";
    throw new Error(`Could not fetch ${ref}.\n${detail}`);
  }
  if (!refExists(ref, cwd)) {
    throw new Error(`Fetched origin/${branch}, but ${ref} is still missing.`);
  }
}

export function readBaselineRulesFromRef(ref, cwd = repoRoot) {
  assertSafeRef(ref);
  ensureBaselineRef(ref, cwd);
  let raw;
  try {
    raw = gitExec(["show", `${ref}:.oxlint-baseline.json`], cwd);
  } catch (err) {
    const detail = err.stderr || err.message || "";
    throw new Error(
      `Could not read .oxlint-baseline.json from ${ref}.  Fetch the base branch.  ` +
        `This check does not fall back to the working tree file.\n${detail}`,
    );
  }
  const parsed = JSON.parse(raw);
  return parsed.rules ?? {};
}

function readWorkingTreeBaseline() {
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function writeUpdatedBaseline(baseline, current) {
  const baselineRules = baseline.rules ?? {};
  const next = { ...baseline, generated: new Date().toISOString(), rules: {} };
  for (const rule of Object.keys(baselineRules)) next.rules[rule] = current.get(rule) ?? 0;
  for (const [rule, count] of current) {
    if (!(rule in next.rules)) next.rules[rule] = count;
  }
  const ordered = {};
  for (const rule of Object.keys(next.rules).sort()) ordered[rule] = next.rules[rule];
  next.rules = ordered;
  writeFileSync(baselinePath, JSON.stringify(next) + "\n");
  return ordered;
}

function totals(current, baselineRules) {
  const totalNow = [...current.values()].reduce((sum, count) => sum + count, 0);
  const totalBase = Object.values(baselineRules).reduce((sum, count) => sum + count, 0);
  return { totalNow, totalBase };
}

function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { warnings: current, errors } = countByRule(runOxlintJson().diagnostics);

  if (args.update) {
    const baseline = readWorkingTreeBaseline();
    const ordered = writeUpdatedBaseline(baseline, current);
    console.log(`Baseline updated: ${Object.keys(ordered).length} rules written to .oxlint-baseline.json.`);
    console.log("Committing this file does not make a pull request green.");
    console.log("Pull request CI compares the merge commit to the baseline on the base branch.");
    console.log(
      `Raise a count only with the label ${BASELINE_INCREASE_LABEL}, and only to the measured merge-commit count.`,
    );
    process.exit(0);
  }

  let baselineRules;
  let committedRules;
  let mode;
  try {
    if (args.baselineRef) {
      baselineRules = readBaselineRulesFromRef(args.baselineRef);
      committedRules = readWorkingTreeBaseline().rules ?? {};
      mode = "base-ref";
    } else {
      baselineRules = readWorkingTreeBaseline().rules ?? {};
      committedRules = baselineRules;
      mode = "working-tree";
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const allowIncrease = mode === "base-ref" && args.allowIncrease;
  const result = evaluateRatchet({
    baselineRules,
    committedRules,
    current,
    errors,
    allowIncrease,
    mode,
  });
  const report = formatRatchetReport(result, {
    baselineRef: args.baselineRef,
    allowIncrease,
  });
  if (report) {
    if (result.failed) process.stderr.write(`${report}\n`);
    else process.stdout.write(`${report}\n`);
  }
  const { totalNow, totalBase } = totals(current, baselineRules);
  const where = args.baselineRef ? ` on ${args.baselineRef}` : "";
  console.log(
    `\nWarnings: ${totalNow} (baseline ${totalBase}${where}).  ${result.failed ? "BASELINE CHECK FAILED." : "Baseline check passed."}`,
  );
  process.exit(result.failed ? 1 : 0);
}

if (isEntryModule()) {
  main();
}
