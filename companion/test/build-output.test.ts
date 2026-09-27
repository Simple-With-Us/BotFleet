// What the packaged app is allowed to contain.
//
// The installed bundle shipped `companion/apns.test.js` inside
// Contents/Resources: the sidecar's tests live beside the code they cover,
// and `tsc -p tsconfig.companion.build.json` emits everything it includes.
// Test code in a shipped binary is dead weight at best and a second, unused
// copy of the module's behaviour at worst.
//
// Asserted against the config rather than against a build, because building
// the companion here would cost a compile on every test run to check a
// four-line file.  The compile itself is `pnpm build:companion`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("companion build output", () => {
  it("excludes test files from what is packaged", () => {
    const config = JSON.parse(readFileSync(`${repoRoot}tsconfig.companion.build.json`, "utf8")) as {
      include?: string[];
      exclude?: string[];
      compilerOptions?: { outDir?: string };
    };
    // The emit is still the whole of companion/src — the exclude is what
    // keeps the tests out of it.
    expect(config.include).toContain("companion/src");
    expect(config.compilerOptions?.outDir).toBe("dist-companion");
    expect(config.exclude ?? []).toContain("companion/src/**/*.test.ts");
  });

  it("still typechecks the tests it refuses to ship", () => {
    // Excluding them from the build must not exclude them from tsc: the
    // server project covers the whole companion tree, tests included, and
    // `pnpm typecheck` runs it.
    const server = JSON.parse(readFileSync(`${repoRoot}tsconfig.server.json`, "utf8")) as {
      include?: string[];
      exclude?: string[];
    };
    expect(server.include).toContain("companion");
    expect(server.exclude ?? []).not.toContain("companion/src/**/*.test.ts");
  });
});
