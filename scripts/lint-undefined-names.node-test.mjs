// The linter names an identifier a Node script uses without defining it.
//
// A release-lane script has paths no unit test reaches, and nothing else in
// the gates reads an identifier against its import: a verifier lost an import
// and kept a call to it, and every local gate stayed green (BF-2712). The rule
// is on for the repository's `.mjs` and `.cjs` files; this decides that it is
// on and that it fires.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What this test reads from the linter's configuration, checked before it is believed. */
const LintConfig = z.object({
  env: z.object({ node: z.boolean() }),
  overrides: z.array(z.object({
    files: z.array(z.string()),
    rules: z.record(z.string(), z.string()),
  })),
});

/** Lint one file with the repository's own configuration and hand back its exit status and output. */
function lint(file) {
  const config = join(repoRoot, ".oxlintrc.json");
  const attempts = [
    { cmd: join(repoRoot, "node_modules", ".bin", "oxlint"), args: ["-c", config, file] },
    { cmd: "npx", args: ["--no-install", "oxlint", "-c", config, file] },
  ];
  for (const { cmd, args } of attempts) {
    // oxlint exits non-zero when diagnostics exist, so only a binary that is
    // not there moves on to the next attempt. A linter that hangs is a
    // failure, not a retry.
    const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" } });
    if (result.error?.code === "ENOENT") continue;
    if (result.error?.code === "ETIMEDOUT") return { status: null, output: "oxlint did not finish within a minute." };
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }
  return { status: null, output: "oxlint was not found" };
}

test("a Node script that calls a name it never defines is refused, and one that defines it is not", () => {
  const directory = mkdtempSync(join(tmpdir(), "bf-lint-undef-"));
  try {
    const defined = join(directory, "defined.mjs");
    const missing = join(directory, "missing.mjs");
    writeFileSync(defined, 'import { readFileSync } from "node:fs";\nexport const read = (path) => readFileSync(path, "utf8");\n');
    writeFileSync(missing, 'import { statSync } from "node:fs";\nexport const read = (path) => readFileSync(path, "utf8");\n');
    const clean = lint(defined);
    const refused = lint(missing);
    assert.equal(clean.status, 0, clean.output);
    assert.doesNotMatch(clean.output, /no-undef/);
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, /no-undef/);
    assert.match(refused.output, /readFileSync/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the rule is on for the repository's Node scripts, with Node's globals declared", () => {
  const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8"));
  const override = config.overrides?.find((entry) => entry.rules?.["no-undef"] === "error");
  assert.deepEqual(override?.files, ["**/*.mjs", "**/*.cjs"]);
  assert.equal(config.env?.node, true);
  // TypeScript is left out on purpose: without type information the rule
  // reports every type name.
  assert.equal(override.files.some((pattern) => pattern.includes("ts")), false);
});
