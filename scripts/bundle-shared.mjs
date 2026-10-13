// Bundle the shared STS module that the packaged Electron main process
// imports at runtime.  The Electron app ships ZERO node_modules
// (electron-builder.yml's `files:` glob excludes them) and the main process
// is launched by Electron itself, not via Node's `--experimental-strip-types`
// flag, so a bare `import "zod"` dies with ERR_MODULE_NOT_FOUND in
// production.  The fix is to inline the one runtime dependency the shared
// module uses into a single self-contained .js, the same approach the
// harness bundler applies to its own server entry points.
//
// Source:  shared/sts-tokens.ts
// Output:  dist-shared/sts-tokens.js
//
// Used by:
//   - electron/sts-tokens.mjs (relative import; the asar carries dist-shared/)
//   - node --test electron/sts-packaging.node-test.mjs (regression)
//   - the Electron main process when run from a packaged build
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-shared", "sts-tokens.js");

mkdirSync(dirname(out), { recursive: true });

await build({
  entryPoints: [join(root, "shared", "sts-tokens.ts")],
  bundle: true,
  // Pin to a Node version at least as old as Electron 44's.  `target: "node20"`
  // is the safest floor: it does not assume the platform's current
  // `--experimental-strip-types` flag, which the packaged Electron main
  // process does not receive.
  target: "node20",
  platform: "node",
  format: "esm",
  outfile: out,
  // The .ts is consumed by Node directly when `--experimental-strip-types`
  // is set; allow the loader to read the import path in the same way.
  loader: { ".ts": "ts" },
  // Keep the public surface untouched: every export the desktop and the
  // harness already import is preserved, including type-only re-exports.
  // Types are erased; the harness reads them from the still-`.ts` source.
  logLevel: "info",
  // `legalComments: "none"` strips the esbuild banner from the output --
  // the bundle is then self-contained JS with no runtime surprises.
  legalComments: "none",
  allowOverwrite: true,
});

// Symlink the d.ts so editors see the public types without a separate
// tsc build.  The `.d.ts` was generated when the harness ran tsc; if it
// is not present, this is a no-op (the d.ts is published by `tsc -p
// tsconfig.server.build.json` from the harness's own pipeline, not from
// this bundler).
try {
  const { copyFileSync, existsSync } = await import("node:fs");
  const dts = join(root, "dist-shared", "sts-tokens.d.ts");
  if (existsSync(dts)) {
    // already there from a prior tsc run; leave it
  } else {
    // emit a minimal `declare module` so the .js bundle's exports type-check
    // when the source .ts is gone.  The repo's CI runs tsc before this
    // script, so the real .d.ts will be in place; this branch is only for
    // running the bundler on its own.
    copyFileSync(
      join(root, "shared", "sts-tokens.d.ts.placeholder"),
      join(root, "dist-shared", "sts-tokens.d.ts"),
    );
  }
} catch {
  // best-effort; do not fail the build for a missing d.ts
}
