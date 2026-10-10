import { describe, expect, it } from "vitest";
import {
  isRetiredModelId,
  rewriteModelSelection,
  rewriteRetiredModelId,
} from "./retired-model-ids.ts";

describe("rewriteRetiredModelId", () => {
  it("maps MiniMax-M3 onto the live Flash Preview id", () => {
    expect(rewriteRetiredModelId("MiniMax-M3")).toBe("MiniMax-M3.1-Flash-Preview");
  });

  it("maps plain MiniMax-M2.7 onto highspeed, not the Preview row", () => {
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

  it("leaves live catalog ids alone, including near-miss stems", () => {
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-Preview")).toBe("MiniMax-M3.1-Flash-Preview");
    expect(rewriteRetiredModelId("MiniMax-M2.7-highspeed")).toBe("MiniMax-M2.7-highspeed");
    expect(rewriteRetiredModelId("DeepSeek-V4.1-Flash")).toBe("DeepSeek-V4.1-Flash");
    expect(rewriteRetiredModelId("MiniMax-M3.1-Flash-Preview-thinking")).toBe(
      "MiniMax-M3.1-Flash-Preview-thinking",
    );
  });
});

describe("isRetiredModelId", () => {
  it("flags only exact retired spellings", () => {
    expect(isRetiredModelId("MiniMax-M3")).toBe(true);
    expect(isRetiredModelId("MiniMax-M3.1-Flash-Preview")).toBe(false);
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
      model: "MiniMax-M3.1-Flash-Preview",
      fallbacks: [
        { instanceId: "minimax", model: "MiniMax-M3.1-Flash-Preview" },
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

  it("preserves effort and reports unchanged when nothing is retired", () => {
    const input = {
      instanceId: "mcode",
      model: "MiniMax-M3.1-Flash-Preview-thinking",
      effort: "high" as const,
      fallbacks: [{ instanceId: "dsh", model: "MiniMax-M3.1-Flash-Preview" }],
    };
    const { selection, changed } = rewriteModelSelection(input);
    expect(changed).toBe(false);
    expect(selection).toBe(input);
  });
});
