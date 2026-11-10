import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const installArguments = (file) => {
  const source = readFileSync(join(directory, file), "utf8");
  const match = source.match(/pnpm install (.+?) --store-dir/);
  assert.ok(match, `${file} has the canonical dependency install`);
  return match[1].split(" ");
};

test("locked Linux installs repair a cached source dependency without mutating shared store links", {
  skip: process.platform === "win32",
  timeout: 60_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "botfleet-install-lifecycle-"));
  try {
    const project = join(root, "project"), source = join(root, "source", "package"), store = join(root, "store");
    mkdirSync(project, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "clutch", version: "1.0.0", type: "module", exports: { ".": "./index.ts", "./package.json": "./package.json" } }));
    writeFileSync(join(source, "index.ts"), "export const ok: boolean = true;\n");
    execFileSync("tar", ["-czf", join(root, "clutch.tgz"), "-C", join(root, "source"), "package"]);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", dependencies: { clutch: "file:../clutch.tgz" }, scripts: { postinstall: "node compile.mjs" } }));
    writeFileSync(join(project, "compile.mjs"), `
      import { createRequire } from 'node:module';
      import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      const require = createRequire(import.meta.url);
      const path = require.resolve('clutch/package.json');
      const links = statSync(path).nlink;
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.exports['.'] = './index.js';
      writeFileSync(path, JSON.stringify(manifest));
      writeFileSync(join(dirname(path), 'index.js'), 'export const ok = true;');
      const count = existsSync('compiled.json') ? JSON.parse(readFileSync('compiled.json')).count : 0;
      writeFileSync('compiled.json', JSON.stringify({ count: count + 1, links }));
    `);
    const pnpm = (args) => execFileSync("pnpm", args, { cwd: project, encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
    const common = ["--offline", "--store-dir", store];
    pnpm(["install", "--ignore-scripts", "--package-import-method=copy", ...common]);
    pnpm(["install", "--frozen-lockfile", ...common]);
    assert.throws(() => readFileSync(join(project, "compiled.json")), /ENOENT/);

    const update = installArguments("update.sh");
    assert.deepEqual(installArguments("install.sh"), update);
    pnpm(["install", ...update, ...common]);
    let result = JSON.parse(readFileSync(join(project, "compiled.json"), "utf8"));
    assert.deepEqual(result, { count: 1, links: 1 });
    execFileSync(process.execPath, ["--input-type=module", "-e", "if (!(await import('clutch')).ok) process.exit(1)"], { cwd: project, stdio: "pipe" });
    pnpm(["install", ...update, ...common]);
    result = JSON.parse(readFileSync(join(project, "compiled.json"), "utf8"));
    assert.deepEqual(result, { count: 2, links: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
