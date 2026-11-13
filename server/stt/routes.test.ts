import { describe, expect, it } from "vitest";

import { INVALID_STT_SESSION_REQUEST, SttFileRequestSchema, SttSessionRequestSchema } from "./routes.ts";

describe("STT request schemas", () => {
  it("rejects an invalid session payload so the route can return a stable error code", () => {
    const parsed = SttSessionRequestSchema.safeParse({ language: "en", unexpected: true });
    expect(parsed.success).toBe(false);
    expect(INVALID_STT_SESSION_REQUEST).toBe("invalid_stt_session_request");
  });

  it("accepts a valid session payload", () => {
    const parsed = SttSessionRequestSchema.safeParse({ language: "en", keyterms: ["BotFleet"], endpointMs: 850 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.language).toBe("en");
      expect(parsed.data.keyterms).toEqual(["BotFleet"]);
      expect(parsed.data.endpointMs).toBe(850);
    }
  });

  it("rejects unknown fields on the file-transcription request", () => {
    expect(SttFileRequestSchema.safeParse({ audioBase64: "AAAA", unexpected: true }).success).toBe(false);
    expect(SttFileRequestSchema.safeParse({ audioBase64: "AAAA" }).success).toBe(true);
  });
});

  it("accepts a keyterm longer than 50 characters, matching parseKeyterms", () => {
    const term = "A".repeat(80);
    expect(SttSessionRequestSchema.safeParse({ keyterms: [term] }).success).toBe(true);
    expect(SttFileRequestSchema.safeParse({ audioBase64: "AAAA", keyterms: [term] }).success).toBe(true);
  });

