import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZulipStateStore, emptyState } from "./state.ts";

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
});
