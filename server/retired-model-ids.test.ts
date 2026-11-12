import { describe, expect, it } from "vitest";
import {
  isRetiredModelId,
  rewriteModelSelection,
  rewriteRetiredModelId,
} from "./retired-model-ids.ts";

describe("rewriteRetiredModelId", () => {
  it("maps MiniMax-M3 onto the live Flash id", () => {
    expect(rewriteRetiredModelId("MiniMax-M3")).toBe("MiniMax-M3.1-Flash");
  });

  it("maps plain MiniMax-M2.7 onto highspeed, not the Flash row", () => {
    expect(rewriteRetiredModelId("MiniMax-M2.7")).toBe("MiniMax-M2.7-highspeed");
  });

  it("maps the retired DeepSeek flash wire/display id onto V4.1 Flash", () => {
    expect(rewriteRetiredModelId("deepseek-v4-flash")).toBe("DeepSeek-V4.1-Flash");
  });

  it("maps the misnamed DeepSeek-V4.1-Pro row onto DeepSeek-V4-Pro", () => {
    // DeepSeek never published a 4.1 Pro (its catalog is DeepSeek-V4.1-Flash
    // plus DeepSeek-V4-Pro-0813), so this is a rename, not a retirement with a
    // successor.  Bots saved against the old id would otherwise send an id no
    // engine accepts.
    expect(rewriteRetiredModelId("DeepSeek-V4.1-Pro")).toBe("DeepSeek-V4-Pro");
    expect(isRetiredModelId("DeepSeek-V4.1-Pro")).toBe(true);
    expect(rewriteRetiredModelId("DeepSeek-V4-Pro")).toBe("DeepSeek-V4-Pro");
  });

  it("migrates a saved MiniMax-M3.1 Flash Preview id onto the live Flash id", () => {
    // MiniMax dropped the `-Preview` suffix, and every engine that serves M3.1
    // now answers to `MiniMax-M3.1-Flash`, so a bot saved against the old
    // spelling must be migrated rather than sent a dead id.
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-Preview")).toBe("MiniMax-M3.1-Flash");
    expect(isRetiredModelId("MiniMax-M3.1-Flash-Preview")).toBe(true);
  });

  it("migrates a saved MiniMax-M3.1 Flash Preview 1M id onto the live 1M id", () => {
    // The 1M row has its own id, so the exact-match index needs its own entry
    // rather than folding onto the 512K row.
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-Preview-1M")).toBe("MiniMax-M3.1-Flash-1M");
    expect(isRetiredModelId("MiniMax-M3.1-Flash-Preview-1M")).toBe(true);
  });

  it("migrates a saved mcode thinking id onto the live thinking id", () => {
    // The mcode picker ids carry the same suffix, so they need their own
    // entries: an exact-match index cannot fold one into another.
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-Preview-thinking")).toBe("MiniMax-M3.1-Flash-thinking");
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-Preview-thinking-1M")).toBe("MiniMax-M3.1-Flash-thinking-1M");
    expect(isRetiredModelId("MiniMax-M3.1-Flash-Preview-thinking")).toBe(true);
  });

  it("leaves live catalog ids alone, including near-miss stems", () => {
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash")).toBe("MiniMax-M3.1-Flash");
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-1M")).toBe("MiniMax-M3.1-Flash-1M");
    expect(rewriteRetiredModelId("MiniMax-M2.7-highspeed")).toBe("MiniMax-M2.7-highspeed");
    expect(rewriteRetiredModelId("DeepSeek-V4.1-Flash")).toBe("DeepSeek-V4.1-Flash");
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-thinking")).toBe("MiniMax-M3.1-Flash-thinking");
  });
});

describe("isRetiredModelId", () => {
  it("flags only exact retired spellings", () => {
    expect(isRetiredModelId("MiniMax-M3")).toBe(true);
    expect(isRetiredModelId("MiniMax-M3.1-Flash-Preview")).toBe(true);
    expect(isRetiredModelId("MiniMax-M3.1-Flash")).toBe(false);
    expect(isRetiredModelId("MiniMax-M3.1-Flash-1M")).toBe(false);
    expect(isRetiredModelId("MiniMax-M3.1-Flash-thinking")).toBe(false);
  });
});

describe("rewriteModelSelection", () => {
  it("rewrites a Director-shaped chain with nested MiniMax-M3 fallbacks", () => {
    const { selection, changed } = rewriteModelSelection({
      instanceId: "dsh",
      model: "MiniMax-M3",
      fallbacks: [
        { instanceId: "minimax", model: "MiniMax-M3" },
        { instanceId: "grok", model: "grok-4.6" },
      ],
    });
    expect(changed).toBe(true);
    expect(selection).toEqual({
      instanceId: "dsh",
      // Every engine that serves M3.1 spells it the same way now.
      model: "MiniMax-M3.1-Flash",
      fallbacks: [
        { instanceId: "minimax", model: "MiniMax-M3.1-Flash" },
        { instanceId: "grok", model: "grok-4.6" },
      ],
    });
  });

  it("rewrites a saved Pro selection and its DSH fallback", () => {
    const { selection, changed } = rewriteModelSelection({
      instanceId: "dsh",
      model: "DeepSeek-V4.1-Pro",
      fallbacks: [
        { instanceId: "dsh", model: "DeepSeek-V4.1-Pro" },
        { instanceId: "dsh", model: "DeepSeek-V4.1-Flash" },
      ],
    });
    expect(changed).toBe(true);
    expect(selection).toEqual({
      instanceId: "dsh",
      model: "DeepSeek-V4-Pro",
      fallbacks: [
        { instanceId: "dsh", model: "DeepSeek-V4-Pro" },
        { instanceId: "dsh", model: "DeepSeek-V4.1-Flash" },
      ],
    });
  });

  it("moves a saved M3.1 Flash Preview selection onto the id every engine offers (BOTFLEET-4E)", () => {
    const { selection, changed } = rewriteModelSelection({
      instanceId: "dsh",
      model: "MiniMax-M3.1-Flash-Preview",
      effort: "high",
      fallbacks: [
        { instanceId: "dsh", model: "MiniMax-M3.1-Flash-Preview" },
        { instanceId: "minimax", model: "MiniMax-M3.1-Flash-Preview" },
        { instanceId: "mcode", model: "MiniMax-M3.1-Flash-Preview-thinking" },
      ],
    });
    expect(changed).toBe(true);
    expect(selection).toEqual({
      instanceId: "dsh",
      model: "MiniMax-M3.1-Flash",
      effort: "high",
      fallbacks: [
        { instanceId: "dsh", model: "MiniMax-M3.1-Flash" },
        { instanceId: "minimax", model: "MiniMax-M3.1-Flash" },
        { instanceId: "mcode", model: "MiniMax-M3.1-Flash-thinking" },
      ],
    });
  });

  it("preserves effort and reports unchanged when nothing is retired", () => {
    const input = {
      instanceId: "mcode",
      model: "MiniMax-M3.1-Flash-thinking",
      effort: "high" as const,
      fallbacks: [{ instanceId: "minimax", model: "MiniMax-M3.1-Flash" }],
    };
    const { selection, changed } = rewriteModelSelection(input);
    expect(changed).toBe(false);
    expect(selection).toBe(input);
  });
});
