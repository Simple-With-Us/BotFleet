import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveStaticFile } from "./static-files.ts";

const base = mkdtempSync(join(tmpdir(), "omb-static-"));
const root = join(base, "ui");
const outside = join(base, "secret.txt");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html>");
writeFileSync(join(root, "assets", "app.js"), "// app");
writeFileSync(outside, "top secret");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const real = (path: string) => realpathSync(path);

describe("resolveStaticFile", () => {
  it("maps / and ordinary paths onto files inside the folder", () => {
    expect(resolveStaticFile(root, "/")).toBe(real(join(root, "index.html")));
    expect(resolveStaticFile(root, "")).toBe(real(join(root, "index.html")));
    expect(resolveStaticFile(root, "/assets/app.js")).toBe(real(join(root, "assets", "app.js")));
    expect(resolveStaticFile(root, "/assets/app%2Ejs")).toBe(real(join(root, "assets", "app.js")));
  });

  it("answers null for anything that lands outside, however it is spelled", () => {
    expect(resolveStaticFile(root, "/../secret.txt")).toBeNull();
    expect(resolveStaticFile(root, "/assets/../../secret.txt")).toBeNull();
    expect(resolveStaticFile(root, "/%2e%2e/secret.txt")).toBeNull();
    expect(resolveStaticFile(root, "/..%2fsecret.txt")).toBeNull();
    expect(resolveStaticFile(root, "/assets/app.js%00.html")).toBeNull();
    expect(resolveStaticFile(root, "/%ZZ")).toBeNull();
  });

  it("does not serve the folder itself or a missing file", () => {
    expect(resolveStaticFile(root, "/nope.js")).toBeNull();
    expect(resolveStaticFile(root, "/assets/..")).toBeNull();
  });

  it("follows a symlink planted inside the folder and refuses one that leaves it", () => {
    const leak = join(root, "assets", "leak.txt");
    const alias = join(root, "assets", "alias.js");
    try {
      symlinkSync(outside, leak);
      symlinkSync(join(root, "assets", "app.js"), alias);
    } catch {
      return; // no symlink permission on this runner
    }
    expect(resolveStaticFile(root, "/assets/leak.txt")).toBeNull();
    expect(resolveStaticFile(root, "/assets/alias.js")).toBe(real(join(root, "assets", "app.js")));
  });
});
