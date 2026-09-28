// The voice, driven against a stub rather than the live service — same
// rule as the box and computer-proxy contract tests: what we send, and how
// a refusal is reported, are the things that break.
//
// The stub serves MiniMax paths (`/v1/get_voice`, `/v1/t2a_v2`).
// A single `refuse` switch flips the provider into its failure shape.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";

let server: Server;
/** every request the stub saw, so tests can assert on what we sent */
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
/** flipped by tests that want the active provider to refuse */
let refuse: { status: number; body: unknown } | null = null;

const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
const MP3_HEX = MP3_BYTES.toString("hex");

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (refuse) return send(refuse.status, refuse.body);
      const path = (req.url ?? "").split("?")[0];

      // ---- MiniMax (default provider) ----
      if (req.method === "POST" && path === "/v1/get_voice") {
        return send(200, {
          system_voice: [
            { voice_id: "English_Graceful_Lady", voice_name: "Graceful Lady", language: "en", gender: "female" },
            { voice_id: "English_Persuasive_Man", voice_name: "Persuasive Man", language: "en", gender: "male" },
            { voice_id: "female-shaonv", voice_name: "Shaonv", language: "zh", gender: "female" },
          ],
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      if (req.method === "GET" && path === "/v1/voices") {
        return send(200, { voices: [{ voice_id: "eleven-v", name: "Eleven" }] });
      }
      if (req.method === "POST" && path.startsWith("/v1/text-to-speech/")) {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3_BYTES);
      }
      if (req.method === "POST" && path === "/v1/files/upload") {
        return send(200, { file: { file_id: 12345 }, base_resp: { status_code: 0 } });
      }
      if (req.method === "POST" && path === "/v1/voice_clone") {
        return send(200, { base_resp: { status_code: 0 } });
      }
      if (req.method === "POST" && path === "/v1/t2a_v2") {
        return send(200, {
          data: { audio: MP3_HEX, status: 2 },
          extra_info: { audio_format: "mp3", audio_length: MP3_BYTES.length * 8 },
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }

      send(404, { detail: "no such stub route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.MINIMAX_API_URL = `http://127.0.0.1:${port}`;
  process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "botfleet-voice-"));
  process.env.OMB_ELEVENLABS_API = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The module reads its base URL at import time, so tests import after the
 * stub is listening. */
const voice = () => import("./index.ts");

const cfg = (tts: AppConfig["tts"]): AppConfig => ({ tts });

describe("configuration", () => {
  it("needs a key and an explicit voice; MiniMax has no product-default id", async () => {
    const { voiceConfigured, voiceReady } = await voice();
    expect(voiceConfigured({})).toBe(false);
    expect(voiceConfigured(cfg({ key: "k" }))).toBe(false);
    expect(voiceConfigured(cfg({ voice: "v-1" }))).toBe(false);
    expect(voiceConfigured(cfg({ key: "k", voice: "v-1" }))).toBe(true);
    expect(voiceReady(cfg({ key: "k" }), "v-per-bot")).toBe(true);
    expect(voiceReady({}, "v-per-bot")).toBe(false);
  });

  it("defaults the provider to MiniMax and never reports the key itself", async () => {
    const { describeVoice } = await voice();
    const described = describeVoice(cfg({ key: "sk-secret", voice: "English_Graceful_Lady" }));
    expect(described).toEqual({ configured: true, ready: true, voice: "English_Graceful_Lady", provider: "minimax", optimizedSummary: false });
    expect(JSON.stringify(described)).not.toContain("sk-secret");
  });

  it("distinguishes 'no key' from 'no voice picked'", async () => {
    // the two need different instructions, so they are different errors
    const { speak, NoVoiceConfigured } = await voice();
    expect(() => speak({}, "hi")).toThrow(NoVoiceConfigured);
    expect(() => speak({}, "hi")).toThrow(
      "Add a MiniMax key in Settings on the computer to turn on voice.",
    );
    expect(() => speak(cfg({ key: "k", provider: "minimax" }), "hi")).toThrow(
      "Pick a voice in the agent profile.",
    );
  });

  it("lists standard canned voices without a key, rather than calling out", async () => {
    seen.length = 0;
    const { listVoices } = await voice();
    const voices = await listVoices({});
    expect(voices.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(0);
  });
});

describe("MiniMax (default provider)", () => {
  const ready = { key: "sk-mm", voice: "English_Graceful_Lady" };

  it("verifies a key against /v1/get_voice with Bearer auth, not the key in the URL", async () => {
    refuse = null;
    seen.length = 0;
    const { verifyKey } = await voice();
    expect(await verifyKey("sk-mm", cfg(ready))).toEqual({ ok: true });
    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/get_voice");
    expect(call.headers["authorization"]).toBe("Bearer sk-mm");
    expect(call.url).not.toContain("sk-mm");
  });

  it("names the upstream's own message when MiniMax refuses the key", async () => {
    refuse = { status: 401, body: { base_resp: { status_msg: "Incorrect API key provided." } } };
    const { verifyKey } = await voice();
    const result = await verifyKey("nope", cfg(ready));
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Incorrect API key");
      expect(result.message.toLowerCase()).toContain("minimax");
    }
  });

  it("lists MiniMax voices from the upstream catalog when a key is set", async () => {
    refuse = null;
    seen.length = 0;
    const { listVoices } = await voice();
    const voices = await listVoices(cfg(ready));
    expect(voices.map((v) => v.id)).toEqual(
      expect.arrayContaining(["English_Graceful_Lady", "English_Persuasive_Man", "female-shaonv"]),
    );
    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/get_voice");
  });

  it("POSTs /v1/t2a_v2 with the native shape and hex-decodes the mp3 bytes", async () => {
    refuse = null;
    seen.length = 0;
    const { speak } = await voice();
    const audio = await speak(cfg(ready), "hello there");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3_BYTES);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/t2a_v2");
    expect(call.headers["authorization"]).toBe("Bearer sk-mm");
    expect(call.url).not.toContain("sk-mm");
    const body = JSON.parse(call.body);
    expect(body.model).toBe("speech-2.8-turbo");
    expect(body.text).toBe("hello there");
    expect(body.output_format).toBe("hex");
    expect(body.voice_setting.voice_id).toBe("English_Graceful_Lady");
    expect(body.audio_setting.format).toBe("mp3");
    const { speechUsageTotals } = await import("./usage.ts");
    expect(speechUsageTotals().minimax.characters).toBeGreaterThanOrEqual("hello there".length);
  });

  it("lets a caller override the voice per bot", async () => {
    refuse = null;
    seen.length = 0;
    const { speak } = await voice();
    await speak(cfg(ready), "hello", "English_Persuasive_Man");
    expect(JSON.parse(seen.at(-1)!.body).voice_setting.voice_id).toBe("English_Persuasive_Man");
  });

  it("surfaces base_resp.status_msg when MiniMax returns a non-zero status_code", async () => {
    refuse = {
      status: 200,
      body: { data: { audio: "", status: 1 }, base_resp: { status_code: 1001, status_msg: "voice id missing" } },
    };
    const { speak } = await voice();
    const message = await speak(cfg(ready), "hi").catch((e: Error) => e.message);
    refuse = null;
    expect(message).toContain("voice id missing");
  });

  it("surfaces the service's own refusal rather than a bare status", async () => {
    refuse = { status: 429, body: { base_resp: { status_msg: "Rate limit reached." } } };
    const { speak } = await voice();
    const message = await speak(cfg(ready), "hi").catch((e: Error) => e.message);
    refuse = null;
    expect(message).toContain("Rate limit");
  });
});

describe("MiniMax clone", () => {
  it("uploads accepted audio and sends the operator-chosen voice ID", async () => {
    refuse = null;
    seen.length = 0;
    const { cloneVoice, listVoices } = await voice();
    const result = await cloneVoice(cfg({ key: "sk-mm", provider: "minimax" }), {
      voiceId: "Jay-Wedgeworth-001", filename: "sample.wav", audioBase64: Buffer.from("RIFF-example").toString("base64"),
    });
    expect(result.id).toBe("Jay-Wedgeworth-001");
    const calls = seen.slice(-2);
    expect(calls.map((call) => call.url)).toEqual(["/v1/files/upload", "/v1/voice_clone"]);
    expect(JSON.parse(calls[1].body).voice_id).toBe("Jay-Wedgeworth-001");
    expect((await listVoices(cfg({ key: "sk-mm" }))).some((voice) => voice.id === result.id)).toBe(true);
  });
  it("refuses malformed audio data before contacting the provider", async () => {
    seen.length = 0;
    const { cloneVoice } = await voice();
    await expect(cloneVoice(cfg({ key: "sk-mm" }), { voiceId: "Jay-Wedgeworth-002", filename: "x.wav", audioBase64: "not base64" })).rejects.toThrow("base64");
    expect(seen).toHaveLength(0);
  });
});

describe("built-in macOS voices", () => {
  // `say -v ?` output: name, locale, then a # sample sentence. The header
  // above the table is localized, and some voice names contain spaces.
  const LISTING = [
    "Stimmen, die mit „say“ gesprochen werden können:", // localized header — must be ignored
    "Albert              en_US    # Hello! My name is Albert.",
    "Bad News            en_US    # The things I could tell you…",
    "Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.",
    "", // trailing blank
  ].join("\n");

  /** A stand-in for `say`: records argv, writes a tiny WAV where -o points,
   * and answers -v ? with the listing above. */
  const fakeSay = (record: string[][]) => async (_file: string, args: string[]) => {
    record.push(args);
    if (args[0] === "-v" && args[1] === "?") return { stdout: LISTING };
    const out = args[args.indexOf("-o") + 1];
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from("RIFF....WAVEfmt "));
    return { stdout: "" };
  };

  const system = { provider: "system" as const, voice: "Albert" };
  const onMac = process.platform === "darwin";

  it("needs no key — only a picked voice — once selected", async () => {
    const { voiceConfigured, voiceReady, describeVoice } = await voice();
    expect(voiceConfigured(cfg(system))).toBe(onMac);
    expect(voiceReady(cfg({ provider: "system" }), "Albert")).toBe(onMac);
    expect(voiceReady(cfg(system))).toBe(onMac);
    const described = describeVoice(cfg(system));
    expect(described).toEqual({
      configured: onMac,
      ready: onMac,
      voice: "Albert",
      provider: "system", optimizedSummary: false,
    });
  });

  it("parses the say voice table, header junk and all", async () => {
    const { listVoices } = await voice();
    const record: string[][] = [];
    expect(await listVoices(cfg({ provider: "system" }), fakeSay(record))).toEqual([
      { id: "Albert", label: "Albert", description: "en_US — Hello! My name is Albert." },
      { id: "Bad News", label: "Bad News", description: "en_US — The things I could tell you…" },
      { id: "Amélie", label: "Amélie", description: "fr_CA — Bonjour! Je m’appelle Amélie." },
    ]);
    expect(record[0].slice(0, 2)).toEqual(["-v", "?"]);
  });

  it("synthesizes to a WAV without any key or network", async () => {
    const { speak } = await voice();
    const record: string[][] = [];
    const audio = await speak(cfg({ provider: "system" }), "hello there", "Albert", fakeSay(record));
    expect(audio.mime).toBe("audio/wav");
    expect(Buffer.from(audio.bytes).toString()).toContain("WAVE");

    const args = record.find((argv) => argv[0] === "-o")!;
    expect(args).toContain("--data-format=LEI16@22050");
    expect(args[args.indexOf("-v") + 1]).toBe("Albert");
    expect(args.at(-1)).toBe("hello there");

    // the utterance temp dir does not outlive the call
    const { access } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await expect(access(dirname(args[1]))).rejects.toThrow();
  });

  it("still demands a picked voice, and says so", async () => {
    const { speak, NoVoiceConfigured } = await voice();
    expect(() => speak(cfg({ provider: "system" }), "hi", undefined, fakeSay([]))).toThrow(NoVoiceConfigured);
    expect(() => speak(cfg({ provider: "system" }), "hi", undefined, fakeSay([]))).toThrow(
      "Pick a voice in the agent profile.",
    );
  });
});
