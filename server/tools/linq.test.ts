// Voice-message tool tests.  We inject a fake synthesizer so the TTS driver
// never runs, and stub the partner API calls with a hand-rolled fetch
// replacement.  Each test calls the executor with a TurnToolCall-shaped
// payload + a minimal runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetches: Array<{ url: string }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetches.length = 0;
  process.env.LINQ_API_TOKEN = "test-token";
  process.env.LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner/v3";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    fetches.push({ url });
    void init;
    if (url.includes("/v3/attachments")) {
      return new Response(
        JSON.stringify({
          attachment_id: "att-voice",
          upload_url: "https://upload.linqapp.com/voice-1",
          required_headers: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://upload.linqapp.com/")) {
      return new Response(null, { status: 200 });
    }
    if (url.includes("/v3/chats/") && url.includes("/messages")) {
      return new Response(JSON.stringify({ message_id: "msg-voice" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LINQ_API_TOKEN;
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Run the executor against a runtime-injected synthesize + a stubbed
 *  resolveLinqBinding so each test only exercises one path. */
async function runExecute(
  args: Record<string, unknown>,
  binding:
    | null
    | {
        botNumber: string;
        allowedSenders?: string[];
        ignoredSenders?: string[];
      },
  allowVoice: boolean | undefined,
) {
  vi.doMock("../linq/dispatch.ts", async () => {
    const actual = await vi.importActual<typeof import("../linq/dispatch.ts")>(
      "../linq/dispatch.ts",
    );
    return {
      ...actual,
      resolveLinqBinding: () =>
        binding
          ? {
              botNumber: binding.botNumber,
              allowedSenders: binding.allowedSenders ?? [],
              ignoredSenders: binding.ignoredSenders ?? [],
            }
          : null,
    };
  });
  vi.doMock("../config.ts", async () => {
    const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
    return {
      ...actual,
      loadConfig: () => ({ imessageLinq: { botNumber: binding?.botNumber, allowVoiceByDefault: allowVoice } }),
    };
  });
  vi.resetModules();
  const { createLinqTools } = await import("./linq.ts");
  const tools = createLinqTools({ botId: "director", threadId: "thread" }, {
    synthesize: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" }),
  });
  const executor = tools.send_voice_message as unknown as (
    call: { arguments: Record<string, unknown> },
  ) => Promise<{ kind: "result" | "error"; content: string; detail?: string }>;
  return executor({ arguments: args });
}

describe("send_voice_message tool", () => {
  it("refuses when chat_id or text is missing", async () => {
    const result = await runExecute({ chat_id: "chat-1" }, { botNumber: "+14158707772" }, true);
    expect(result.kind).toBe("error");
  });

  it("uploads audio bytes and posts the resulting attachment id", async () => {
    const result = await runExecute(
      { chat_id: "chat-2", text: "hi" },
      { botNumber: "+14158707772" },
      true,
    );
    expect(result.kind).toBe("result");
    expect(fetches.some((f) => f.url.includes("/v3/attachments"))).toBe(true);
    expect(fetches.some((f) => f.url.includes("https://upload.linqapp.com/"))).toBe(true);
    expect(fetches.some((f) => f.url.includes("/v3/chats/chat-2/messages"))).toBe(true);
  });

  it("refuses when the bot has no Linq binding", async () => {
    const result = await runExecute({ chat_id: "chat-3", text: "hi" }, null, true);
    expect(result.kind).toBe("error");
  });

  it("refuses when the workspace disabled voice messages", async () => {
    const result = await runExecute(
      { chat_id: "chat-4", text: "hi" },
      { botNumber: "+14158707772" },
      false,
    );
    expect(result.kind).toBe("error");
  });

  it("refuses when allowVoiceByDefault is undefined (opt-in default)", async () => {
    const result = await runExecute(
      { chat_id: "chat-u", text: "hi" },
      { botNumber: "+14158707772" },
      undefined,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("voice_disabled");
  });

  it("allows voice when allowVoiceByDefault is true", async () => {
    const result = await runExecute(
      { chat_id: "chat-ok", text: "hi" },
      { botNumber: "+14158707772" },
      true,
    );
    expect(result.kind).toBe("result");
  });

});
