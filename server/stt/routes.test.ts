import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import {
  handleXaiSttRoutes,
  INVALID_STT_SESSION_REQUEST,
  SttFileRequestSchema,
  SttSessionRequestSchema,
  VOICE_OFF_ERROR,
  type SttJsonResponse,
} from "./routes.ts";

const sockets: Socket[] = [];

function dummyPair() {
  const socket = new Socket();
  sockets.push(socket);
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);
  return { req, res };
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

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

  it("accepts a keyterm up to 512 characters and rejects a longer one", () => {
    const allowed = "A".repeat(512);
    const tooLong = "A".repeat(513);
    expect(SttSessionRequestSchema.safeParse({ keyterms: [allowed] }).success).toBe(true);
    expect(SttSessionRequestSchema.safeParse({ keyterms: [tooLong] }).success).toBe(false);
    expect(SttFileRequestSchema.safeParse({ audioBase64: "AAAA", keyterms: [allowed] }).success).toBe(true);
    expect(SttFileRequestSchema.safeParse({ audioBase64: "AAAA", keyterms: [tooLong] }).success).toBe(false);
  });
});

describe("handleXaiSttRoutes", () => {
  it("returns 409 with VOICE_OFF_ERROR when voice is off", async () => {
    const { req, res } = dummyPair();
    const replies: Array<{ status: number; body: SttJsonResponse }> = [];
    const cfg: AppConfig = { tts: { enabled: false }, xai: { key: "sk-test" } };
    const handled = await handleXaiSttRoutes({
      method: "POST",
      path: "/api/stt/xai/sessions",
      req,
      res,
      cfg,
      json: (_res, status, body) => { replies.push({ status, body }); },
      readBody: async () => ({}),
    });
    expect(handled).toBe(true);
    expect(replies).toEqual([{ status: 409, body: { error: VOICE_OFF_ERROR } }]);
  });

  it("returns 400 with invalid_stt_session_request for an invalid session payload", async () => {
    const { req, res } = dummyPair();
    const replies: Array<{ status: number; body: SttJsonResponse }> = [];
    const cfg: AppConfig = { tts: { enabled: true }, xai: { key: "sk-test" } };
    const handled = await handleXaiSttRoutes({
      method: "POST",
      path: "/api/stt/xai/sessions",
      req,
      res,
      cfg,
      json: (_res, status, body) => { replies.push({ status, body }); },
      readBody: async () => ({ language: "en", unexpected: true }),
    });
    expect(handled).toBe(true);
    expect(replies).toEqual([{
      status: 400,
      body: { error: "Invalid speech-to-text session request.", code: INVALID_STT_SESSION_REQUEST },
    }]);
  });
});
