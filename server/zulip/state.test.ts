import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ZulipStateStore, emptyState, stateFileSchema } from "./state.ts";

describe("ZulipStateStore write-path policy", () => {
  it("supports a user-owned data-root alias while policing what lies below it", () => {
    const real = mkdtempSync(join(tmpdir(), "zulip-store-real-"));
    const alias = `${real}-alias`;
    symlinkSync(real, alias);
    try {
      const store = new ZulipStateStore(alias);
      const state = emptyState("BF-Plumber");
      for (let n = 0; n < 12; n++) {
        state.notices.push({ at: n, userId: 9, text: `terminal ${n}`, attempts: 8, failed: "gave up" });
      }
      store.save("bot-plumber", state);
      // The alias is canonicalized: both writes land under the real root.
      expect(existsSync(join(real, "zulip", "bot-plumber.json"))).toBe(true);
      expect(existsSync(join(real, "zulip", "bot-plumber.notices-archive.jsonl"))).toBe(true);
    } finally {
      rmSync(alias, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  // Root bypasses DAC checks, so the EACCES branch this pins never runs
  // under uid 0; skip there instead of passing vacuously.
  it.skipIf(process.getuid?.() === 0)("persists through a write-only state directory: the mode repair stays best effort", () => {
    const root = mkdtempSync(join(tmpdir(), "zulip-store-wonly-"));
    const dir = join(root, "zulip");
    try {
      const store = new ZulipStateStore(root);
      store.save("bot-plumber", emptyState("BF-Plumber"));
      chmodSync(dir, 0o300);
      const state = emptyState("BF-Plumber");
      state.userId = 9;
      store.save("bot-plumber", state);
      // The mode repair was skipped: the directory stays write-only.
      expect(lstatSync(dir).mode & 0o777).toBe(0o300);
      chmodSync(dir, 0o700);
      expect(stateFileSchema.parse(JSON.parse(readFileSync(join(dir, "bot-plumber.json"), "utf8"))).userId).toBe(9);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a missing data root instead of failing the save", () => {
    const base = mkdtempSync(join(tmpdir(), "zulip-store-missing-"));
    const root = join(base, "not-yet-created", "deeper");
    try {
      const store = new ZulipStateStore(root);
      store.save("bot-plumber", emptyState("BF-Plumber"));
      expect(existsSync(join(root, "zulip", "bot-plumber.json"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a dangling symlink above a RELATIVE data root", () => {
    const base = mkdtempSync(join(tmpdir(), "zulip-store-rel-dangling-"));
    symlinkSync(join(base, "no-such-target"), join(base, "link"));
    const root = relative(process.cwd(), join(base, "link", "root"));
    try {
      const store = new ZulipStateStore(root);
      // A relative configured root resolves against the process cwd; the
      // dangling-link classification must inspect THAT path, not a
      // same-named tree under the filesystem root.
      expect(() => store.load("bot-plumber", "BF-Plumber")).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses when a dangling symlink sits above the data root", () => {
    const base = mkdtempSync(join(tmpdir(), "zulip-store-dangling-ancestor-"));
    symlinkSync(join(base, "no-such-target"), join(base, "link"));
    const root = join(base, "link", "root");
    try {
      const store = new ZulipStateStore(root);
      // The dangling link is an ANCESTOR of the configured root: lstat on
      // the root itself fails too, so only walking the root's own
      // components distinguishes this from a genuinely absent tree.  The
      // load must refuse, never boot with silently reset ledgers; the
      // save must refuse and create nothing.
      expect(() => store.load("bot-plumber", "BF-Plumber")).toThrow();
      expect(() => store.save("bot-plumber", emptyState("BF-Plumber"))).toThrow(/dangling|does not resolve to a directory/);
      expect(existsSync(join(base, "no-such-target"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a dangling symlinked data root instead of booting or saving empty", () => {
    const base = mkdtempSync(join(tmpdir(), "zulip-store-dangling-root-"));
    const root = join(base, "dangling-root");
    symlinkSync(join(base, "no-such-target"), root);
    try {
      const store = new ZulipStateStore(root);
      // A dangling root is a hostile path, not a fresh tree: the load must
      // refuse (per-bot containment), never boot with silently reset
      // ledgers, and the save must refuse BEFORE creating anything.  No
      // root needed: realpathSync fails before any ownership check.
      expect(() => store.load("bot-plumber", "BF-Plumber")).toThrow();
      expect(() => store.save("bot-plumber", emptyState("BF-Plumber"))).toThrow(/dangling|does not resolve to a directory/);
      // The refusal happens BEFORE any create: the link target tree is
      // never materialized through the dangling link.
      expect(existsSync(join(base, "no-such-target"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // uid 0 only: planting a ROOT-OWNED dangling symlink (which the
  // verifier's statSync then fails to resolve with ENOENT) needs root;
  // non-root CI skips deterministically rather than passing vacuously.
  it.skipIf(!process.getuid || process.getuid() !== 0)("refuses a root-owned dangling symlinked state directory", () => {
    const base = mkdtempSync(join(tmpdir(), "zulip-store-dangling-"));
    symlinkSync(join(base, "no-such-target"), join(base, "zulip"));
    try {
      const store = new ZulipStateStore(base);
      // A dangling ancestor link is a hostile path: the load must refuse
      // (per-bot containment), never boot with silently reset ledgers.
      expect(() => store.load("bot-plumber", "BF-Plumber")).toThrow();
      // The save side refuses through the same classifier, BEFORE any
      // create: a hostile path is never mkdir'd through or around.
      expect(() => store.save("bot-plumber", emptyState("BF-Plumber"))).toThrow(/dangling|does not resolve to a directory/);
      expect(existsSync(join(base, "no-such-target"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // uid 0 only: creating the ROOT-OWNED symlink this case accepts (the
  // /var -> /private/var pattern) needs root; non-root CI skips
  // deterministically rather than passing vacuously.
  it.skipIf(!process.getuid || process.getuid() !== 0)("accepts a root-owned symlinked state directory", () => {
    const target = mkdtempSync(join(tmpdir(), "zulip-store-dirlink-"));
    const base = mkdtempSync(join(tmpdir(), "zulip-store-base-"));
    symlinkSync(target, join(base, "zulip"));
    try {
      const store = new ZulipStateStore(base);
      store.save("bot-plumber", emptyState("BF-Plumber"));
      expect(existsSync(join(target, "bot-plumber.json"))).toBe(true);
    } finally {
      rmSync(join(base, "zulip"), { force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
