// Hand-rolled fetch-mock for the v3 client tests.  We do not pull in nock
// because the tests pin one endpoint per case and the mock is a single
// `mockFetch` swap on the global.  Reset in `afterEach`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINQ_CONFIG,
  LinqApiErrorImpl,
  isLinqConfigured,
  linqAddReaction,
  linqGetChat,
  linqGetContactCard,
  linqGetUploadUrl,
  linqMarkRead,
  linqSendMessage,
  linqShareContactCard,
  linqStartTyping,
  linqStopTyping,
  linqUpdateChat,
  linqUploadBytes,
} from "./client.ts";

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;

let calls: CapturedCall[] = [];
let responses: Array<(init: RequestInit | undefined) => Response> = [];

function queueResponse(builder: (init: RequestInit | undefined) => Response): void {
  responses.push(builder);
}

beforeEach(() => {
  process.env.LINQ_API_TOKEN = "test-token";
  delete process.env.BOTFLEET_LINQAPP_API_KEY;
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (responses.length === 0) {
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    }
    const next = responses.shift()!;
    return next(init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LINQ_API_TOKEN;
  delete process.env.BOTFLEET_LINQAPP_API_KEY;
});

describe("linq/client", () => {
  it("exposes a populated config from env at module init", () => {
    expect(LINQ_CONFIG.baseUrl).toMatch(/^https:\/\/api\.linqapp\.com\/api\/partner\/v3/);
    expect(isLinqConfigured()).toBe(true);
  });

  it("reads BOTFLEET_LINQAPP_API_KEY when set, falling back to LINQ_API_TOKEN", async () => {
    const beforeGlobal = process.env.BOTFLEET_LINQAPP_API_KEY;
    const beforeLegacy = process.env.LINQ_API_TOKEN;
    try {
      // Reset module cache so each env swap reads fresh module-init state.
      vi.resetModules();
      delete process.env.LINQ_API_TOKEN;
      process.env.BOTFLEET_LINQAPP_API_KEY = "global-token";
      const { LINQ_CONFIG: cfgGlobal } = await import("./client.ts");
      expect(cfgGlobal.token).toBe("global-token");

      vi.resetModules();
      delete process.env.BOTFLEET_LINQAPP_API_KEY;
      process.env.LINQ_API_TOKEN = "legacy-token";
      const { LINQ_CONFIG: cfgLegacy } = await import("./client.ts");
      expect(cfgLegacy.token).toBe("legacy-token");
    } finally {
      if (beforeGlobal === undefined) delete process.env.BOTFLEET_LINQAPP_API_KEY;
      else process.env.BOTFLEET_LINQAPP_API_KEY = beforeGlobal;
      if (beforeLegacy === undefined) delete process.env.LINQ_API_TOKEN;
      else process.env.LINQ_API_TOKEN = beforeLegacy;
    }
  });

  it("sends a text message with the canonical envelope shape", async () => {
    queueResponse((init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body.message.parts[0]).toEqual({ type: "text", value: "hi from bot" });
      return new Response(JSON.stringify({ message_id: "msg-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await linqSendMessage("chat-1", { text: "hi from bot" });
    expect(result).toEqual({ id: "msg-123" });
    const [call] = calls;
    expect(call.url).toBe("https://api.linqapp.com/api/partner/v3/chats/chat-1/messages");
    expect((call.init?.headers as Record<string, string>)?.authorization).toBe("Bearer test-token");
  });

  it("sends a media-only attachment via attachment_id when text is absent", async () => {
    queueResponse((init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      // No text means no leading text part; parts[0] is the media part.
      expect(body.message.parts[0].type).toBe("media");
      expect(body.message.parts[0].attachment_id).toBe("att-abc");
      return new Response(JSON.stringify({ message_id: "msg-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await linqSendMessage("chat-2", {
      media: [{ attachmentId: "att-abc" }],
    });
    expect(result.id).toBe("msg-2");
  });

  it("appends a media part after text when both are present", async () => {
    queueResponse((init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body.message.parts[0]).toEqual({ type: "text", value: "spoken" });
      expect(body.message.parts[1]).toMatchObject({ type: "media", attachment_id: "att-abc" });
      return new Response(JSON.stringify({ message_id: "msg-3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await linqSendMessage("chat-3", {
      text: "spoken",
      media: [{ attachmentId: "att-abc" }],
    });
  });

  it("returns a typed error on a 401", async () => {
    queueResponse(() =>
      new Response(JSON.stringify({ error: { message: "bad token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(linqMarkRead("chat-x")).rejects.toThrow(LinqApiErrorImpl);
  });

  it("marks a chat as read", async () => {
    queueResponse(() => new Response(null, { status: 204 }));
    await expect(linqMarkRead("chat-r")).resolves.toBeUndefined();
  });

  it("starts and stops typing on the chat", async () => {
    queueResponse(() => new Response(null, { status: 204 }));
    await linqStartTyping("chat-t");
    queueResponse(() => new Response(null, { status: 204 }));
    await linqStopTyping("chat-t");
  });

  it("adds a reaction", async () => {
    queueResponse((init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body.operation).toBe("add");
      expect(body.type).toBe("love");
      return new Response(null, { status: 204 });
    });
    await linqAddReaction("msg-r", { operation: "add", type: "love" });
  });

  it("shares a contact card with the canonical payload", async () => {
    queueResponse(() => new Response(null, { status: 204 }));
    await linqShareContactCard("chat-c", { full_name: "Director Bot", phone: "+14158707772" });
    const [call] = calls;
    expect(call.url).toContain("/share_contact_card");
  });

  it("fetches a contact card", async () => {
    queueResponse(() =>
      new Response(JSON.stringify({ name: "Director", photo_url: "https://x/y.jpg" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const card = await linqGetContactCard("+14158707772");
    expect(card).toEqual({ name: "Director", photoUrl: "https://x/y.jpg" });
  });

  it("requests a signed upload URL", async () => {
    queueResponse(() =>
      new Response(
        JSON.stringify({
          attachment_id: "att-up",
          upload_url: "https://upload.linqapp.com/abc",
          required_headers: { "x-amz-acl": "private" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const creds = await linqGetUploadUrl("audio/mpeg", "voice.mp3", 2048);
    expect(creds.attachmentId).toBe("att-up");
    expect(creds.uploadUrl).toBe("https://upload.linqapp.com/abc");
    expect(creds.requiredHeaders["x-amz-acl"]).toBe("private");
    expect(calls[0].url).toBe("https://api.linqapp.com/api/partner/v3/attachments");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ filename: "voice.mp3", content_type: "audio/mpeg", size_bytes: 2048 });
  });

  it("PUTs bytes to the signed URL without the bearer token", async () => {
    let uploadHeaders: Record<string, string> = {};
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("upload.linqapp.com")) {
        uploadHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(null, { status: 200 });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const bytes = new Uint8Array([1, 2, 3]);
    await linqUploadBytes("https://upload.linqapp.com/abc", bytes, "audio/mpeg", { "x-amz-acl": "private" });
    expect(uploadHeaders["x-amz-acl"]).toBe("private");
    expect(uploadHeaders.authorization).toBeUndefined();
    expect(uploadHeaders["content-type"]).toBe("audio/mpeg");
  });

  it("reads chat info and detects groups", async () => {
    queueResponse(() =>
      new Response(
        JSON.stringify({
          id: "chat-info-1",
          display_name: "Crew",
          handles: ["+14158707772", "+15555550100"],
          is_group: true,
          service: "iMessage",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const info = await linqGetChat("chat-info-1");
    expect(info.isGroup).toBe(true);
    expect(info.service).toBe("imessage");
    expect(info.displayName).toBe("Crew");
  });

  it("updates a chat on PUT", async () => {
    queueResponse(() => new Response(null, { status: 204 }));
    await linqUpdateChat("chat-u", { displayName: "Crew Renamed" });
  });

  it("does not duplicate content-type when required_headers already has Content-Type", async () => {
    const { linqUploadBytes } = await import("./client.ts");
    const calls: Array<{ headers: Record<string, string> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ headers });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await linqUploadBytes(
        "https://upload.example/put",
        new Uint8Array([1, 2, 3]),
        "audio/mpeg",
        { "Content-Type": "audio/mpeg", "x-amz-acl": "private" },
      );
      expect(calls).toHaveLength(1);
      const keys = Object.keys(calls[0].headers).filter((k) => k.toLowerCase() === "content-type");
      expect(keys).toHaveLength(1);
      expect(calls[0].headers[keys[0]]).toBe("audio/mpeg");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

});
