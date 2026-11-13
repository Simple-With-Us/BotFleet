import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { voiceMasterEnabled } from "../../shared/voice-master.ts";
import type { AppConfig } from "../config.ts";
import { transcribeFile } from "./xai.ts";
import {
  appendXaiSttAudio,
  createXaiSttSession,
  stopXaiSttSession,
  subscribeXaiSttSession,
} from "./sessions.ts";

export const VOICE_OFF_ERROR = "Voice is turned off in Settings.";

export function voiceIsOff(cfg: AppConfig): boolean {
  return !voiceMasterEnabled(cfg.tts);
}

export type SttJsonResponse =
  | { error: string }
  | { sessionId: string }
  | { ok: true }
  | { text: string; duration?: number };

type JsonFn = (res: ServerResponse, status: number, body: SttJsonResponse) => ServerResponse | void;

const SttFileRequestSchema = z.object({
  audioBase64: z.string(),
  filename: z.string().optional(),
  mime: z.string().optional(),
  language: z.string().optional(),
  keyterms: z.array(z.string()).optional(),
});

const SttSessionRequestSchema = z.object({
  language: z.string().optional(),
  keyterms: z.array(z.string()).optional(),
  endpointMs: z.number().optional(),
});

function readRawBytes(req: IncomingMessage, maxBytes = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(msg), { status }));
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(413, "body too large");
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => fail(400, error instanceof Error ? error.message : String(error)));
  });
}

function xaiKey(cfg: AppConfig): string {
  return (cfg.xai?.key ?? "").trim();
}

export function endNoContent(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

/** Handle /api/stt/xai* routes.  Returns true when the request was consumed. */
export async function handleXaiSttRoutes(args: {
  method: string;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  cfg: AppConfig;
  json: JsonFn;
  readBody: (req: IncomingMessage, maxBytes?: number) => Promise<object | null>;
}): Promise<boolean> {
  const { method, path, req, res, cfg, json, readBody } = args;
  if (!path.startsWith("/api/stt/xai")) return false;

  if (voiceIsOff(cfg)) {
    json(res, 409, { error: VOICE_OFF_ERROR });
    return true;
  }
  const apiKey = xaiKey(cfg);
  if (!apiKey) {
    json(res, 409, { error: "Add an xAI API key in Connections before using xAI dictation." });
    return true;
  }

  if (method === "POST" && path === "/api/stt/xai") {
    const parsed = SttFileRequestSchema.safeParse(await readBody(req, 12_000_000));
    if (!parsed.success || !parsed.data.audioBase64) {
      json(res, 400, { error: "audioBase64 required" });
      return true;
    }
    const audioBase64 = parsed.data.audioBase64;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) {
      json(res, 400, { error: "Audio data is not valid base64." });
      return true;
    }
    const bytes = new Uint8Array(Buffer.from(audioBase64, "base64"));
    try {
      const result = await transcribeFile(apiKey, {
        bytes,
        filename: parsed.data.filename || "audio.wav",
        mime: parsed.data.mime,
        language: parsed.data.language,
        keyterms: parsed.data.keyterms,
      });
      json(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not transcribe.";
      const status = /rejected this API key/i.test(message) ? 401 : 502;
      json(res, status, { error: message });
    }
    return true;
  }

  if (method === "POST" && path === "/api/stt/xai/sessions") {
    const parsed = SttSessionRequestSchema.safeParse(await readBody(req));
    const body = parsed.success ? parsed.data : {};
    try {
      const id = await createXaiSttSession({
        apiKey,
        params: {
          language: body.language,
          keyterms: body.keyterms,
          endpointingMs: body.endpointMs,
        },
      });
      json(res, 200, { sessionId: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start xAI dictation.";
      json(res, 502, { error: message });
    }
    return true;
  }

  const audioMatch = path.match(/^\/api\/stt\/xai\/sessions\/([^/]+)\/audio$/);
  if (audioMatch && method === "POST") {
    const bytes = await readRawBytes(req, 2_000_000);
    if (!appendXaiSttAudio(audioMatch[1]!, bytes)) {
      json(res, 404, { error: "Dictation session is not running." });
      return true;
    }
    endNoContent(res);
    return true;
  }

  const eventsMatch = path.match(/^\/api\/stt\/xai\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    const id = eventsMatch[1]!;
    const off = subscribeXaiSttSession(id, (event) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    if (!off) {
      json(res, 404, { error: "Dictation session is not running." });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("\n");
    req.on("close", () => off());
    return true;
  }

  const stopMatch = path.match(/^\/api\/stt\/xai\/sessions\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    const ok = await stopXaiSttSession(stopMatch[1]!);
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Dictation session is not running." });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
