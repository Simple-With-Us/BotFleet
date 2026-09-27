#!/usr/bin/env node
/**
 * Per-rule lint baseline ratchet.
 *
 * Replaces the global `--max-warnings` cap (which let a removed warning offset a
 * newly introduced one) with a per-rule baseline: CI fails if ANY rule's warning
 * count rises above its checked-in baseline, even if the total stays flat.
 *
 * Usage:
 *   node scripts/check-lint-baseline.mjs            # check against baseline
 *   node scripts/check-lint-baseline.mjs --update   # rewrite baseline with current counts
 *                                                    # (only after cleaning up violations)
 *
 * The baseline lives in .oxlint-baseline.json at the repo root.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, ".oxlint-baseline.json");
const update = process.argv.includes("--update");

function ruleIdFromCode(code) {
  // oxlint JSON uses "plugin(rule-name)"; normalize to "plugin/rule-name".
  // (Avoid `typeof` here: this file is itself linted by anti-slop/no-runtime-typeof.)
  if (code != null && code.endsWith?.(")")) {
    const open = code.indexOf("(");
    if (open > 0) return `${code.slice(0, open)}/${code.slice(open + 1, -1)}`;
  }
  return String(code);
}

function runOxlintJson() {
  const localBin = join(repoRoot, "node_modules", ".bin", "oxlint");
  let raw;
  const attempts = [
    { cmd: localBin, args: [".", "--format=json"] },
    { cmd: "npx", args: ["--no-install", "oxlint", ".", "--format=json"] }
  ];
  let lastErr;
  for (const { cmd, args } of attempts) {
    try {
      raw = execFileSync(cmd, args, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
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

function countByRule(diagnostics) {
  const warnings = new Map();
  const errors = [];
  for (const d of diagnostics ?? []) {
    const rule = ruleIdFromCode(d.code);
    if (d.severity === "error") {
      errors.push(`${rule} in ${d.filename}`);
    } else if (d.severity === "warning") {
      warnings.set(rule, (warnings.get(rule) ?? 0) + 1);
    }
  }
  return { warnings, errors };
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const baselineRules = baseline.rules ?? {};
const { warnings: current, errors } = countByRule(runOxlintJson().diagnostics);

if (update) {
  const next = { ...baseline, generated: new Date().toISOString(), rules: {} };
  for (const rule of Object.keys(baselineRules)) next.rules[rule] = current.get(rule) ?? 0;
  // Keep rules that vanished from the config at 0 so the file stays explicit.
  for (const [rule, count] of current) {
    if (!(rule in next.rules)) next.rules[rule] = count;
  }
  const ordered = {};
  for (const rule of Object.keys(next.rules).sort()) ordered[rule] = next.rules[rule];
  next.rules = ordered;
  writeFileSync(baselinePath, JSON.stringify(next) + "\n");
  console.log(`Baseline updated: ${Object.keys(ordered).length} rules written to .oxlint-baseline.json.`);
  process.exit(0);
}

let failed = false;
if (errors.length > 0) {
  failed = true;
  console.error(`\nERROR: ${errors.length} lint error(s) (errors always fail):`);
  for (const e of errors.slice(0, 20)) console.error(`  - ${e}`);
  if (errors.length > 20) console.error(`  ... and ${errors.length - 20} more`);
}

const increased = [];
const decreased = [];
const allRules = new Set([...Object.keys(baselineRules), ...current.keys()]);
for (const rule of [...allRules].sort()) {
  const base = baselineRules[rule] ?? 0;
  const now = current.get(rule) ?? 0;
  if (now > base) increased.push({ rule, base, now });
  else if (now < base) decreased.push({ rule, base, now });
}

if (increased.length > 0) {
  failed = true;
  console.error("\nERROR: per-rule warning baseline exceeded (new violations introduced):");
  for (const { rule, base, now } of increased) {
    console.error(`  - ${rule}: baseline ${base}, now ${now} (+${now - base})`);
  }
  console.error("\nFix the new violations, or (only if intentional) update the baseline with:");
  console.error("  node scripts/check-lint-baseline.mjs --update");
  console.error("\nNote: CI lints the PR merge commit (refs/pull/<n>/merge), not the branch head.");
  console.error("If the baseline was generated from the branch alone, merge main and regenerate it.");
}

if (decreased.length > 0) {
  console.log("\nCleaned up since baseline (tighten it with --update when ready):");
  for (const { rule, base, now } of decreased) {
    console.log(`  - ${rule}: baseline ${base}, now ${now} (-${base - now})`);
  }
}

const totalNow = [...current.values()].reduce((a, b) => a + b, 0);
const totalBase = Object.values(baselineRules).reduce((a, b) => a + b, 0);
console.log(`\nWarnings: ${totalNow} (baseline ${totalBase}). ${failed ? "BASELINE CHECK FAILED." : "Baseline check passed."}`);
process.exit(failed ? 1 : 0);
