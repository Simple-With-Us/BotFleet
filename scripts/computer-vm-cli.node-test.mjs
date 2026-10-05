import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest is valid JSON with unique tool names", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/computer-vm-cli/manifest.json"), "utf8"));
  const names = manifest.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(manifest.tools.length >= 40);
});

test("install and verify entrypoints exist", () => {
  for (const file of ["install.mjs", "verify.mjs", "run-install.sh", "manifest.json"]) {
    assert.ok(readFileSync(join(ROOT, "scripts/computer-vm-cli", file), "utf8").length > 0, file);
  }
});
