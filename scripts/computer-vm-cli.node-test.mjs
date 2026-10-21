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

// The owner hit this on Oct 21, 2026: every offline Local VM action in the
// Control app failed with
//   ENOENT: no such file or directory, open '.../BotFleet Control.app/Contents/scripts/computer-vm-cli/manifest.json'
// The bundled helper resolves the manifest against the directory it runs
// from, and the Control app bundle never shipped it — scripts/bundle-server.mjs
// ships it for the server bundle, but the Control app's own bundle did not.
// This test pins the bundle side, so the file cannot go missing again.
test("the Control app bundle ships the vm-cli manifest", () => {
  const builder = readFileSync(join(ROOT, "electron/build-control-app.mjs"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    builder.includes("computer-vm-cli"),
    "electron/build-control-app.mjs must copy the vm-cli manifest into the Control app bundle",
  );

  // The resolver looks for the manifest relative to the helper's own
  // directory, so the bundle must place it where the resolver will look.
  const resolver = readFileSync(join(ROOT, "server/vm-cli-manifest.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    resolver.includes('join(SERVER_ROOT, "computer-vm-cli/manifest.json")'),
    "the manifest must stay the first candidate so the bundle can satisfy it",
  );
});
