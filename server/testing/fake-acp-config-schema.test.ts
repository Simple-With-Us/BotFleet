import { describe, expect, it } from "vitest";

import { fakeAcpConfigCallFileSchema } from "./fake-acp-config-schema.ts";

describe("fakeAcpConfigCallFileSchema", () => {
  it("accepts recorded set_model calls", () => {
    const payload = [
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "gpt-5.3-codex" } },
    ];
    expect(fakeAcpConfigCallFileSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects extra keys on call objects", () => {
    expect(fakeAcpConfigCallFileSchema.safeParse([{ method: "x", params: {}, extra: true }]).success).toBe(false);
  });
});
