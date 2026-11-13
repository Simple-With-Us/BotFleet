import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { bundleOfflineVmHelper } from "../electron/build-control-app.mjs";

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
//
// Two checks, because the two halves of the failure are separate.  This one
// pins the contract: the exact source and destination pair the builder uses,
// and the order of the resolver's candidates.  The one below builds the
// bundle and asks the real resolver where it looks, so the contract cannot
// hold on paper while the bundle is still wrong.
test("the Control app bundle copies the vm-cli manifest where the resolver looks for it", () => {
  const builder = readFileSync(join(ROOT, "electron/build-control-app.mjs"), "utf8").replace(/\r\n/g, "\n");
  // Assert the exact source and destination pair: a generic "computer-vm-cli"
  // mention anywhere in the file would not prove the manifest itself is
  // copied into the bundle.
  assert.ok(
    builder.includes('path.join(project, "scripts", "computer-vm-cli", "manifest.json")'),
    "electron/build-control-app.mjs must copy scripts/computer-vm-cli/manifest.json from the repo",
  );
  assert.ok(
    builder.includes('path.join(vmCliManifestDir, "manifest.json")'),
    "electron/build-control-app.mjs must place manifest.json inside the bundle's computer-vm-cli directory",
  );

  // The resolver looks for the manifest relative to the helper's own
  // directory, and the bundle only satisfies the SERVER_ROOT candidate —
  // so that candidate must come FIRST. Presence anywhere in the list is not
  // enough: a later relative candidate would silently shadow the bundled copy.
  const resolver = readFileSync(join(ROOT, "server/vm-cli-manifest.ts"), "utf8").replace(/\r\n/g, "\n");
  const candidates = [...resolver.matchAll(/join\((\w+),\s*"([^"]*computer-vm-cli\/manifest\.json)"\)/g)].map(
    (match) => ({ root: match[1], path: match[2] }),
  );
  assert.ok(
    candidates.length > 0,
    "server/vm-cli-manifest.ts must resolve the manifest from an explicit candidate list",
  );
  assert.equal(
    candidates[0].root,
    "SERVER_ROOT",
    `the SERVER_ROOT candidate must come first so the Control app bundle satisfies it (found ${candidates[0].root}: ${candidates[0].path})`,
  );
});

//
// This test builds the bundle the app ships and asks the real resolver where
// it looks, so neither half can drift: the manifest has to be inside the
// bundle, and the resolver has to open that copy rather than one of the
// other places it would accept.
test("the Control app bundle ships the vm-cli manifest where the resolver looks", async () => {
  const root = mkdtempSync(join(tmpdir(), "botfleet-control-bundle-"));
  try {
    // The app bundle's Contents/Resources, where the helper runs from.
    const contents = join(root, "BotFleet Control.app", "Contents");
    const resources = join(contents, "Resources");
    await bundleOfflineVmHelper(resources);

    const bundled = join(resources, "computer-vm-cli", "manifest.json");
    assert.ok(existsSync(bundled), "the bundle must ship computer-vm-cli/manifest.json");
    assert.equal(
      readFileSync(bundled, "utf8"),
      readFileSync(join(ROOT, "scripts", "computer-vm-cli", "manifest.json"), "utf8"),
      "the bundled manifest must be the one the repository ships",
    );

    // The resolver also accepts a manifest one directory up, and one under
    // scripts/.  Put decoys there: if the resolver ever prefers them, the
    // bundle's own copy would stop being the file it opens.
    for (const decoy of [join(contents, "computer-vm-cli"), join(contents, "scripts", "computer-vm-cli")]) {
      mkdirSync(decoy, { recursive: true });
      writeFileSync(join(decoy, "manifest.json"), '{"decoy":true}\n');
    }

    // The resolver resolves against the directory the helper runs from, so
    // bundle it the way the app bundles it and ask it where it looks.
    const probeEntry = join(root, "manifest-probe.ts");
    writeFileSync(
      probeEntry,
      `import { vmCliManifestPath } from ${JSON.stringify(join(ROOT, "server", "vm-cli-manifest.ts"))};\nprocess.stdout.write(vmCliManifestPath());\n`,
    );
    const probe = join(resources, "manifest-probe.mjs");
    await build({
      entryPoints: [probeEntry],
      outfile: probe,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
    });
    const resolved = spawnSync(process.execPath, [probe], { encoding: "utf8" });
    assert.equal(resolved.status, 0, resolved.stderr);
    // The resolver reports the path it resolved, which the loader has already
    // taken through any symlink (macOS puts the temporary directory behind
    // /private).
    assert.equal(resolved.stdout.trim(), realpathSync(bundled), "the resolver must open the manifest the bundle ships");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
