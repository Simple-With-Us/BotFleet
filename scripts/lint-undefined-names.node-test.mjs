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

/** Lint one file with the repository's own configuration and hand back its exit status and output. */
function lint(file) {
  const config = join(repoRoot, ".oxlintrc.json");
  const attempts = [
    { cmd: join(repoRoot, "node_modules", ".bin", "oxlint"), args: ["-c", config, file] },
    { cmd: "npx", args: ["--no-install", "oxlint", "-c", config, file] },
  ];
  for (const { cmd, args } of attempts) {
    // oxlint exits non-zero when diagnostics exist, so an error here is an answer.
    const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" } });
    if (result.error?.code === "ENOENT" || (result.status === null && !result.stdout && !result.stderr)) continue;
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
