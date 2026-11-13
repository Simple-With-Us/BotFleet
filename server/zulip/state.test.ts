import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("persists through a write-only state directory: the mode repair stays best effort", () => {
    const root = mkdtempSync(join(tmpdir(), "zulip-store-wonly-"));
    const dir = join(root, "zulip");
    try {
      const store = new ZulipStateStore(root);
      store.save("bot-plumber", emptyState("BF-Plumber"));
      chmodSync(dir, 0o300);
      const state = emptyState("BF-Plumber");
      state.userId = 9;
      store.save("bot-plumber", state);
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

  it("accepts a root-owned symlinked state directory (verifiable as uid 0 only)", () => {
    if (!process.getuid || process.getuid() !== 0) return;
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
