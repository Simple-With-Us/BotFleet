#!/usr/bin/env node
// PR lint gate: fail only when this branch adds anti-slop errors in files it
// touches.  Full-repo lint still runs on main pushes; the fleet is burning
// down the backlog file by file.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseRef = process.env.LINT_BASE_REF ?? "origin/main";
const baseBranch = baseRef.replace(/^origin\//, "");

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || `${cmd} failed\n`);
    process.exit(r.status ?? 1);
  }
  return r.stdout.trim();
}

function changedFiles() {
  // Fetch the full base history.  A depth-limited fetch drops the ancestry the
  // triple-dot diff needs to find a merge-base (stacked PRs lose it first), and
  // the failure must stay loud rather than fall back to a two-dot diff.
  const fetchArgs = ["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`];
  if (sh("git", ["rev-parse", "--is-shallow-repository"]) === "true") fetchArgs.push("--unshallow");
  sh("git", fetchArgs);
  const raw = sh("git", ["diff", "--name-only", "--diff-filter=ACMRT", `${baseRef}...HEAD`]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\.(?:[cm]?[jt]s|tsx)$/.test(line));
}

function oxlintErrors(path) {
  const r = spawnSync("pnpm", ["exec", "oxlint", path], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return text.split("\n").filter((line) => line.includes("error anti-slop")).length;
}

function mainFileAt(ref, file) {
  const r = spawnSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

const files = changedFiles();
if (files.length === 0) {
  console.log("lint-pr-gate: no lintable files changed");
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "lint-pr-gate-"));
const regressions = [];

for (const file of files) {
  const headPath = join(process.cwd(), file);
  const headErrors = oxlintErrors(headPath);
  const baseSource = mainFileAt(baseRef, file);
  let baseErrors = 0;
  if (baseSource !== null) {
    const basePath = join(scratch, file.replaceAll("/", "__"));
    writeFileSync(basePath, baseSource);
    baseErrors = oxlintErrors(basePath);
  }
  if (headErrors > baseErrors) {
    regressions.push({ file, baseErrors, headErrors, delta: headErrors - baseErrors });
  }
}

rmSync(scratch, { recursive: true, force: true });

if (regressions.length === 0) {
  console.log(`lint-pr-gate: ok (${files.length} changed file(s), no new anti-slop errors)`);
  process.exit(0);
}

process.stderr.write("lint-pr-gate: this PR adds anti-slop errors in changed files:\n");
for (const row of regressions) {
  process.stderr.write(
    `  ${row.file}: ${row.baseErrors} -> ${row.headErrors} (+${row.delta})\n`,
  );
}
process.exit(1);
