// Postinstall: compile the `clutch` dependency from TypeScript to JavaScript.
//
// The `clutch` package (github:jaywedgeworth22/Clutch) ships TypeScript
// sources only.  Node's native type-stripping refuses to load `.ts` files
// under `node_modules/` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which
// breaks every `node server/index.ts` execution — notably the e2e fixtures
// that spawn the real server.  Vitest/esbuild handle it fine, which is why
// unit tests pass but spawned-server tests fail.
//
// This script transpiles `clutch/src/**/*.ts` to `clutch/dist/**/*.js` once
// per install and rewrites the package's `exports` so the `default` condition
// resolves to the compiled JS while `types` still resolves to the original
// `.ts` sources (so `pnpm typecheck` keeps full type information).
//
// Idempotent: safe to re-run.  If the clutch package or its src/ is missing the
// script fails loudly (exit 1) instead of leaving an uncompiled dependency.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function findClutchDir() {
  try {
    const pkgPath = require.resolve("clutch/package.json");
    return dirname(pkgPath);
  } catch {
    return null;
  }
}

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Rewrite relative `.ts` import specifiers to `.js`: the clutch source uses
// explicit `.ts` extensions, but the compiled output files are `.js`.
function rewriteTsImports(code) {
  return code.replace(/from\s*(["'])(\.{1,2}\/[^"']*)\.ts\1/g, (_m, q, p) => `from ${q}${p}.js${q}`);
}

const clutchDir = findClutchDir();
if (!clutchDir) {
  console.error("[compile-clutch-dep] clutch package not found; run the install so the clutch dependency resolves.");
  process.exit(1);
}

const srcDir = join(clutchDir, "src");
const distDir = join(clutchDir, "dist");
if (!existsSync(srcDir)) {
  console.error("[compile-clutch-dep] clutch src/ not found.");
  process.exit(1);
}

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  console.error("[compile-clutch-dep] esbuild not available; cannot compile clutch.");
  process.exit(1);
}

const tsFiles = collectTsFiles(srcDir);
let compiled = 0;
for (const tsFile of tsFiles) {
  const rel = relative(srcDir, tsFile);
  const jsFile = join(distDir, rel.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(jsFile), { recursive: true });
  const source = readFileSync(tsFile, "utf8");
  const result = esbuild.transformSync(source, {
    loader: "ts",
    format: "esm",
    platform: "node",
    target: "node22",
  });
  writeFileSync(jsFile, rewriteTsImports(result.code));
  compiled++;
}

// Rewrite exports: "./dsh/acp": "./src/dsh/acp/driver.ts"
// becomes "./dsh/acp": { types: "./src/dsh/acp/driver.ts", default: "./dist/dsh/acp/driver.js" }
const pkgPath = join(clutchDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
let patched = 0;
if (pkg.exports && typeof pkg.exports === "object") {
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value === "string" && value.startsWith("./src/") && value.endsWith(".ts")) {
      const srcTarget = join(clutchDir, value);
      if (existsSync(srcTarget)) {
        const jsPath = value.replace("./src/", "./dist/").replace(/\.ts$/, ".js");
        pkg.exports[key] = { types: value, default: jsPath };
        patched++;
      }
    } else if (value && typeof value === "object" && value.types && value.default) {
      // Already patched; ensure the dist file exists, otherwise recompile.
      patched++;
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

console.log(`[compile-clutch-dep] compiled ${compiled} files, patched ${patched} exports.`);
