import { describe, expect, it } from "vitest";

import {
  mergeSessionCurrentModelId,
  parseAcpSessionLifecycleResult,
  sessionAvailableModels,
  sessionCurrentModelId,
} from "./session-schema.ts";

describe("parseAcpSessionLifecycleResult", () => {
  it("accepts session/new shaped payloads", () => {
    const payload = {
      sessionId: "fake-acp-session",
      models: {
        availableModels: [{ modelId: "gpt-5.3-codex", name: "Codex" }],
        currentModelId: "gpt-5.3-codex",
      },
    };
    expect(parseAcpSessionLifecycleResult(payload)).toEqual(payload);
    expect(sessionAvailableModels(payload)).toEqual([{ modelId: "gpt-5.3-codex", name: "Codex" }]);
    expect(sessionCurrentModelId(payload)).toBe("gpt-5.3-codex");
  });

  it("returns null for non-objects", () => {
    expect(parseAcpSessionLifecycleResult(null)).toBeNull();
    expect(parseAcpSessionLifecycleResult("nope")).toBeNull();
  });
});

describe("mergeSessionCurrentModelId", () => {
  it("preserves availableModels when updating currentModelId", () => {
    const prior = parseAcpSessionLifecycleResult({
      sessionId: "s1",
      models: { availableModels: [{ modelId: "a" }], currentModelId: "old" },
    });
    const next = mergeSessionCurrentModelId(prior, "new");
    expect(next.models?.currentModelId).toBe("new");
    expect(next.models?.availableModels).toEqual([{ modelId: "a" }]);
  });
});
