import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleXaiSttRoutes, INVALID_STT_SESSION_REQUEST, VOICE_OFF_ERROR } from "./routes.ts";
import type { AppConfig } from "../config.ts";

function jsonSink() {
  const calls: Array<{ status: number; body: unknown }> = [];
  const json = (_res: ServerResponse, status: number, body: unknown) => {
    calls.push({ status, body });
  };
  return { json, calls, res: {} as ServerResponse };
}

const cfg = { tts: { enabled: true }, xai: { key: "sk-test" } } as AppConfig;

describe("handleXaiSttRoutes", () => {
  it("rejects an invalid session payload with a stable error code", async () => {
    const { json, calls, res } = jsonSink();
    const handled = await handleXaiSttRoutes({
      method: "POST",
      path: "/api/stt/xai/sessions",
      req: {} as IncomingMessage,
      res,
      cfg,
      json,
      readBody: async () => ({ language: "en", unexpected: true }),
    });
    expect(handled).toBe(true);
    expect(calls).toEqual([
      { status: 400, body: { error: "Invalid speech-to-text session request.", code: INVALID_STT_SESSION_REQUEST } },
    ]);
  });

  it("rejects unknown fields on the file-transcription request", async () => {
    const { json, calls, res } = jsonSink();
    const handled = await handleXaiSttRoutes({
      method: "POST",
      path: "/api/stt/xai",
      req: {} as IncomingMessage,
      res,
      cfg,
      json,
      readBody: async () => ({ audioBase64: "AAAA", unexpected: true }),
    });
    expect(handled).toBe(true);
    expect(calls[0]?.status).toBe(400);
  });

  it("refuses dictation when the workspace voice switch is off", async () => {
    const { json, calls, res } = jsonSink();
    const handled = await handleXaiSttRoutes({
      method: "POST",
      path: "/api/stt/xai/sessions",
      req: {} as IncomingMessage,
      res,
      cfg: { tts: { enabled: false }, xai: { key: "sk-test" } } as AppConfig,
      json,
      readBody: async () => ({}),
    });
    expect(handled).toBe(true);
    expect(calls).toEqual([{ status: 409, body: { error: VOICE_OFF_ERROR } }]);
  });
});
