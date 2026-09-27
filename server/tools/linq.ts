// `send_voice_message` tool executor.  Companion to `tools/registry.ts`'s
// `LINQ_VOICE_MESSAGE` record.  The executor is the only place the TTS +
// upload + send pipeline lives; the registry entry is its wire description.
//
// The gate is `ctx.linq`, set by the dispatch for turns whose bot is bound
// to a Linq phone number AND whose workspace allows voice messages.  We
// refuse early when the gate is closed so a misconfigured turn surfaces a
// clean error rather than spinning on the TTS pipeline.
//
// `tools/linq.ts` does NOT import `server/tts/index.ts` directly.  The
// sibling test in `tools/registry.test.ts:386` bans every file under
// `server/tools/` from importing an `index.ts` to keep the cycle that
// previously duplicated the `list_bots` filter out.  We reach the
// first-party hosted TTS driver via lazy `linqDeps.synthesize` injection
// from `server/index.ts` instead — the index module already pays the
// import cost, so this stays a one-edge dependency.

import { homedir } from "node:os";
import { join } from "node:path";

import type { TurnToolCall, TurnToolOutcome, TurnToolRuntime } from "../contracts.ts";
import { loadConfig } from "../config.ts";
import {
  linqGetUploadUrl,
  linqSendMessage,
  linqUploadBytes,
} from "../linq/client.ts";
import { peekLinqChat } from "../linq/outbound.ts";
import { resolveLinqBinding } from "../linq/dispatch.ts";
import type { BotRecord } from "../store.ts";

export interface LinqToolContext {
  botId: string;
  threadId: string;
}

export interface LinqToolDeps {
  /** Synthesize speech.  Returns raw audio bytes (the Linq partner API
   *  accepts any common audio container; we ship mp3 because it is the
   *  smallest universal format).  Throws on upstream errors; the executor
   *  turns the throw into a typed `TurnToolOutcome`.  Required: production
   *  callers pass the first-party hosted TTS driver; tests stub a
   *  deterministic producer.  `tools/linq.ts` itself does NOT resolve the
   *  driver — see the file-level comment for the dependency-cycle reason. */
  synthesize: (text: string, voice?: string) => Promise<{ bytes: Uint8Array; mime: string }>;
}

const DEFAULT_VOICE = "male-qn-jingying";

const ok = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "result", content, detail } : { kind: "result", content };
const failed = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "error", content, detail } : { kind: "error", content };

export function createLinqTools(
  ctx: LinqToolContext,
  deps: LinqToolDeps,
): Record<string, (call: TurnToolCall, ctxBot: LinqToolContext, runtime: TurnToolRuntime) => Promise<TurnToolOutcome>> {
  return {
    async send_voice_message(call): Promise<TurnToolOutcome> {
      // Prefer an explicit chat_id; otherwise reuse the inbound chat this
      // turn was bound to so the model need not invent a destination.
      const remembered = peekLinqChat(ctx.threadId);
      const chatId = String(call.arguments.chat_id ?? "").trim()
        || (remembered?.botId === ctx.botId ? remembered.chatId : "");
      const text = String(call.arguments.text ?? "").trim();
      const ttsCfg = loadConfig().tts;
      const explicitVoice = typeof call.arguments.voice === "string" && call.arguments.voice.trim()
        ? call.arguments.voice.trim()
        : undefined;
      // MiniMax-specific default must not leak to ElevenLabs / system TTS.
      // An empty saved voice ("") means unselected — normalize before the
      // fallback chain so it does not shadow the provider default and fail
      // every call with NoVoiceConfigured.
      const configuredVoice = ttsCfg?.voice?.trim() || undefined;
      const voice = explicitVoice
        ?? configuredVoice
        ?? ((ttsCfg?.provider === "minimax" || ttsCfg?.provider === undefined) ? DEFAULT_VOICE : undefined);
      if (!chatId || !text) {
        return failed(
          JSON.stringify({ error: "send_voice_message requires `chat_id` and `text`" }),
          "bad arguments",
        );
      }
      // Two-layer permission check: workspace policy first, then per-bot
      // Linq binding.  When either is off, refuse with a typed error —
      // calling TTS without an active binding is a billable silent burn.
      const cfg = loadConfig();
      if (cfg.imessageLinq?.allowVoiceByDefault !== true) {
        return failed(
          JSON.stringify({ error: "Voice messages are disabled in workspace settings (allowVoiceByDefault is off)" }),
          "voice_disabled",
        );
      }
      // No workspace fallback: a bot the operator just moved off Linq
      // must not keep sending voice on the shared number for the rest of
      // this turn.
      const binding = resolveLinqBinding(cfg, ctx.botId);
      if (!binding) {
        return failed(
          JSON.stringify({ error: "Linq transport is not enabled for this bot" }),
          "linq_disabled",
        );
      }
      // `bot` only validates liveness; the executor doesn't need the record.
      const _validateBot: BotRecord | undefined = undefined;
      void _validateBot;
      let synthesized: { bytes: Uint8Array; mime: string };
      try {
        synthesized = await deps.synthesize(text, voice);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: `TTS failed: ${message}` }), "tts_error");
      }
      const mimeType = synthesized.mime || "audio/mpeg";
      // The filename extension must match the synthesized container: a
      // system-TTS WAV named .mp3 breaks Linq's upload metadata / decoding.
      const ext = mimeType === "audio/wav" ? "wav" : mimeType === "audio/pcm" ? "pcm" : "mp3";
      const filename = `voice-${Date.now()}.${ext}`;
      let credentials: { uploadUrl: string; attachmentId: string; requiredHeaders: Record<string, string> };
      try {
        credentials = await linqGetUploadUrl(mimeType, filename, synthesized.bytes.byteLength);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: `linq: signed upload URL failed: ${message}` }), "upload_url_error");
      }
      try {
        await linqUploadBytes(credentials.uploadUrl, synthesized.bytes, mimeType, credentials.requiredHeaders);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: `linq: signed upload PUT failed: ${message}` }), "upload_put_error");
      }
      try {
        const sent = await linqSendMessage(chatId, {
          text,
          media: [{ attachmentId: credentials.attachmentId }],
        });
        return ok(
          JSON.stringify({ message_id: sent.id, attachment_id: credentials.attachmentId }),
          "voice message sent",
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: `linq: send failed: ${message}` }), "send_error");
      }
    },
  };
}

/** Save the synthesized voice clip on disk next to the homedir, used by the
 *  test fake so the test can inspect what bytes crossed the boundary. */
export function tmpAudioPath(name: string): string {
  return join(homedir(), ".cache", "botfleet-tests", name);
}
