import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadValidatedManifest() {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "-e",
      `import { loadVmCliManifest } from "./server/vm-cli-manifest.ts";
const manifest = loadVmCliManifest();
console.log(JSON.stringify({ names: manifest.tools.map((tool) => tool.name) }));`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("manifest is valid JSON with unique tool names", () => {
  const { names } = loadValidatedManifest();
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 40);
});

test("install and verify entrypoints exist", () => {
  for (const file of ["install.mjs", "verify.mjs", "run-install.sh", "manifest.json"]) {
    assert.ok(readFileSync(join(ROOT, "scripts/computer-vm-cli", file), "utf8").length > 0, file);
  }
});
