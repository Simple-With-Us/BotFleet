// The MiniMax TTS driver, in isolation. The `index.ts` test exercises the
// engine picker; this file owns the driver's contract: what it sends, how
// it formats the URL, and what it does on a refusal. The fetch is stubbed
// through a local HTTP server, the API base is overridden, and the timeout
// path is hit by swapping fetch for a rejecting stub.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: ReturnType<typeof import("node:http").createServer>;
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
let refuse: { status: number; body: unknown } | null = null;

const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
const MP3_HEX = MP3_BYTES.toString("hex");

beforeAll(async () => {
  const http = await import("node:http");
  server = http.createServer((req, res) => {
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
      if (req.method === "POST" && path === "/v1/t2a_v2") {
        return send(200, {
          data: { audio: MP3_HEX, status: 2 },
          extra_info: { audio_format: "mp3", audio_length: MP3_BYTES.length * 8 },
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      send(404, { base_resp: { status_code: 404, status_msg: "no such stub route" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.MINIMAX_API_URL = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The driver reads MINIMAX_API_URL at import time, so import after the
 * stub is up. */
const driver = () => import("./minimax.ts");

describe("verifyKey", () => {
  it("returns ok against a real /v1/get_voice probe", async () => {
    refuse = null;
    seen.length = 0;
    const { verifyKey } = await driver();
    expect(await verifyKey("sk-good")).toEqual({ ok: true });
    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/get_voice");
    expect(call.headers["authorization"]).toBe("Bearer sk-good");
  });

  it("rejects a key when MiniMax returns HTTP 200 with a non-zero base_resp", async () => {
    refuse = { status: 200, body: { system_voice: [], base_resp: { status_code: 1001, status_msg: "auth failed" } } };
    const { verifyKey } = await driver();
    const result = await verifyKey("bad");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("auth failed");
  });

  it("surfaces the upstream's own message on 401", async () => {
    refuse = { status: 401, body: { base_resp: { status_msg: "Incorrect API key" } } };
    const { verifyKey } = await driver();
    const result = await verifyKey("bad");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Incorrect API key");
      expect(result.message.toLowerCase()).toContain("rejected");
    }
  });

  it("falls back to a permission hint when the upstream gives no detail on 401", async () => {
    refuse = { status: 401, body: { base_resp: {} } };
    const { verifyKey } = await driver();
    const result = await verifyKey("bad");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("rejected");
  });

  it("returns a network-shaped failure when the fetch throws", async () => {
    const { verifyKey } = await driver();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await verifyKey("sk");
    globalThis.fetch = original;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("couldn't reach");
  });
});

describe("listVoices", () => {
  it("returns the system catalog shaped from the upstream response", async () => {
    refuse = null;
    seen.length = 0;
    const { listVoices } = await driver();
    const voices = await listVoices("sk");
    expect(voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "English_Graceful_Lady", label: "Graceful Lady", description: undefined }),
        expect.objectContaining({ id: "English_Persuasive_Man", label: "Persuasive Man", description: undefined }),
        expect.objectContaining({ id: "female-shaonv", label: "Shaonv", description: undefined }),
      ]),
    );
    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/get_voice");
    expect(call.headers["authorization"]).toBe("Bearer sk");
  });

  it("throws when the upstream returns a non-zero base_resp", async () => {
    refuse = { status: 200, body: { system_voice: [], base_resp: { status_code: 1001, status_msg: "auth failed" } } };
    const { listVoices } = await driver();
    const msg = await listVoices("sk").catch((e: Error) => e.message);
    refuse = null;
    expect(msg).toContain("auth failed");
  });
});

describe("synthesize", () => {
  it("POSTs the native /v1/t2a_v2 shape and returns decoded mp3 bytes", async () => {
    refuse = null;
    seen.length = 0;
    const { synthesize } = await driver();
    const audio = await synthesize("hi there", "English_Graceful_Lady", "sk");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3_BYTES);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/t2a_v2");
    expect(call.headers["authorization"]).toBe("Bearer sk");
    expect(call.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(call.body);
    expect(body.model).toBe("speech-2.8-turbo");
    expect(body.text).toBe("hi there");
    expect(body.stream).toBe(false);
    expect(body.output_format).toBe("hex");
    expect(body.voice_setting.voice_id).toBe("English_Graceful_Lady");
    expect(body.audio_setting.format).toBe("mp3");
    expect(body.language_boost).toBe("auto");
  });

  it("honors an explicit voice_id override on the synthesize options", async () => {
    refuse = null;
    seen.length = 0;
    const { synthesize } = await driver();
    await synthesize("hi", "female-shaonv", "sk");
    expect(JSON.parse(seen.at(-1)!.body).voice_setting.voice_id).toBe("female-shaonv");
  });

  it("returns an empty payload for whitespace-only text without calling the API", async () => {
    refuse = null;
    seen.length = 0;
    const { synthesize } = await driver();
    const audio = await synthesize("   ", "English_Graceful_Lady", "sk");
    expect(audio.bytes.length).toBe(0);
    expect(audio.mime).toBe("audio/mpeg");
    expect(seen).toHaveLength(0);
  });

  it("rejects utterances above the 10K-char limit with a precise message", async () => {
    const { synthesize } = await driver();
    const longText = "a".repeat(10_001);
    const msg = await synthesize(longText, "English_Graceful_Lady", "sk").catch((e: Error) => e.message);
    expect(msg).toMatch(/10001.*10000/);
  });

  it("surfaces base_resp.status_msg on a 200 with non-zero status_code", async () => {
    refuse = {
      status: 200,
      body: {
        data: { audio: "", status: 1 },
        base_resp: { status_code: 1001, status_msg: "voice id missing" },
      },
    };
    const { synthesize } = await driver();
    const msg = await synthesize("hi", "English_Graceful_Lady", "sk").catch((e: Error) => e.message);
    refuse = null;
    expect(msg).toContain("voice id missing");
  });

  it("surfaces the upstream's own message on a 4xx refusal", async () => {
    refuse = { status: 402, body: { base_resp: { status_msg: "insufficient credit" } } };
    const { synthesize } = await driver();
    const msg = await synthesize("hi", "English_Graceful_Lady", "sk").catch((e: Error) => e.message);
    refuse = null;
    expect(msg).toContain("insufficient credit");
  });

  it("throws with a network-shaped message when the fetch itself fails", async () => {
    const { synthesize } = await driver();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const err: unknown = await synthesize("hi", "English_Graceful_Lady", "sk").catch((e) => e);
    globalThis.fetch = original;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.toLowerCase()).toContain("couldn't reach");
  });
});
