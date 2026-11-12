// Webhook receiver tests — exercise the HMAC verification path, the
// unknown-event refusal, and the dispatch path that hands off to
// `handleLinqInbound`.  We stub the dispatch module at the top of the
// file so the receiver's only job — verifying and routing — runs without
// its real downstream calls hitting the partner API.

import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../linq/client.ts", async () => {
  const actual = await vi.importActual<typeof import("../linq/client.ts")>(
    "../linq/client.ts",
  );
  return {
    ...actual,
    linqMarkRead: async () => undefined,
    linqStartTyping: async () => undefined,
    linqStopTyping: async () => undefined,
  };
});

import { readLinqWebhook } from "./linq-webhook.ts";

interface DispatchCall {
  msg?: unknown;
  bots?: unknown;
}

const dispatchCalls: DispatchCall[] = [];
let nextDispatch: { dispatched: boolean; reason?: string } = { dispatched: true };

vi.mock("../linq/dispatch.ts", async () => {
  const actual = await vi.importActual<typeof import("../linq/dispatch.ts")>(
    "../linq/dispatch.ts",
  );
  return {
    ...actual,
    handleLinqInbound: async (msg: unknown, bots: unknown) => {
      dispatchCalls.push({ msg, bots });
      return nextDispatch;
    },
  };
});

afterEach(() => {
  dispatchCalls.length = 0;
  nextDispatch = { dispatched: true };
  delete process.env.LINQ_WEBHOOK_SECRET;
  delete process.env.LINQ_API_TOKEN;
  delete process.env.LINQ_ALLOW_UNSIGNED_WEBHOOK;
});

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeReq(body: string, headers: Record<string, string> = {}): Parameters<typeof readLinqWebhook>[0] {
  const stream = Readable.from(Buffer.from(body)) as Parameters<typeof readLinqWebhook>[0];
  stream.headers = headers;
  return stream;
}

async function run(body: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  let captured: JsonResponse = { status: 0, body: {} };
  const res = {
    writeHead(status: number) {
      (res as unknown as { status: number }).status = status;
    },
    end(payload: string) {
      const status = (res as unknown as { status: number }).status ?? 200;
      captured = { status, body: payload ? JSON.parse(payload) : {} };
      return res;
    },
  } as unknown as Parameters<typeof readLinqWebhook>[1];
  await readLinqWebhook(makeReq(body, headers), res, {
    getBots: () => [{ id: "director", threadId: "thread" } as never],
    beginAdmission: () => () => {},
  });
  return captured;
}


const TEST_SECRET = "the-real-secret";

/** Fail-closed by default: most cases need a valid signature (or the
 *  explicit LINQ_ALLOW_UNSIGNED_WEBHOOK=1 opt-out under test). */
function signed(body: string, secret = TEST_SECRET): Record<string, string> {
  return { "x-linq-signature": createHmac("sha256", secret).update(body).digest("hex") };
}

async function runSigned(body: string): Promise<JsonResponse> {
  process.env.LINQ_WEBHOOK_SECRET = TEST_SECRET;
  return run(body, signed(body));
}

describe("readLinqWebhook", () => {
  it("returns 400 when the body is not valid JSON", async () => {
    const res = await runSigned("not json");
    expect(res.status).toBe(400);
  });

  it("returns 401 when a body is signed with the wrong secret", async () => {
    const secret = "the-real-secret";
    process.env.LINQ_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ type: "message.received", chat_id: "x", message_id: "m", from: "+1" });
    const badSignature = createHmac("sha256", "wrong").update(body).digest("hex");
    const res = await run(body, { "x-linq-signature": badSignature });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad_signature");
  });

  it("accepts an inbound when the signature matches", async () => {
    const secret = "the-real-secret";
    process.env.LINQ_WEBHOOK_SECRET = secret;
    process.env.LINQ_API_TOKEN = "test-token";
    const body = JSON.stringify({
      type: "message.received",
      chat_id: "chat-1",
      message_id: "m-1",
      from: "+15555550100",
      to: "+14158707772",
      body: "hello",
    });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const res = await run(body, { "x-linq-signature": sig });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dispatchCalls).toHaveLength(1);
    expect((dispatchCalls[0].msg as { fromNumber: string }).fromNumber).toBe("+15555550100");
  });

  it("refuses unsigned calls when LINQ_WEBHOOK_SECRET is unset (fail closed)", async () => {
    delete process.env.LINQ_WEBHOOK_SECRET;
    delete process.env.LINQ_ALLOW_UNSIGNED_WEBHOOK;
    const body = JSON.stringify({
      type: "message.received",
      chat_id: "chat-2",
      message_id: "m-2",
      from: "+15555550100",
      to: "+14158707772",
      body: "open",
    });
    const res = await run(body);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("webhook_secret_not_configured");
    expect(dispatchCalls).toHaveLength(0);
  });

  it("accepts unsigned calls only when LINQ_ALLOW_UNSIGNED_WEBHOOK=1", async () => {
    delete process.env.LINQ_WEBHOOK_SECRET;
    process.env.LINQ_ALLOW_UNSIGNED_WEBHOOK = "1";
    const body = JSON.stringify({
      type: "message.received",
      chat_id: "chat-2",
      message_id: "m-2",
      from: "+15555550100",
      to: "+14158707772",
      body: "open",
    });
    const res = await run(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    delete process.env.LINQ_ALLOW_UNSIGNED_WEBHOOK;
  });

  it("returns 400 on an unknown event payload", async () => {
    const res = await runSigned(JSON.stringify({ type: "message.unknown" }));
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("bad_event");
  });

  it("returns 200 on a delivered lifecycle event without dispatching", async () => {
    const body = JSON.stringify({ type: "message.delivered", message_id: "m", at: new Date().toISOString() });
    const res = await runSigned(body);
    expect(res.status).toBe(200);
    expect(res.body.lifecycle).toBe("message.delivered");
    expect(dispatchCalls).toHaveLength(0);
  });

  it("answers 503 when the message never reached the bot, so Linq retries", async () => {
    nextDispatch = { dispatched: false, reason: "http_500" };
    const body = JSON.stringify({ type: "message.received", chat_id: "c", message_id: "m", from: "+1", to: "+2", body: "hi" });
    const res = await runSigned(body);
    expect(res.status).toBe(503);
    expect(res.body.retry).toBe(true);
  });

  it("answers 200 for a deliberate policy drop, so Linq does not redeliver", async () => {
    nextDispatch = { dispatched: false, reason: "sender_blocked" };
    const body = JSON.stringify({ type: "message.received", chat_id: "c", message_id: "m", from: "+1", to: "+2", body: "hi" });
    const res = await runSigned(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("falls back from an empty body to text parts", async () => {
    const body = JSON.stringify({
      type: "message.received",
      chat_id: "chat-parts",
      message_id: "m-parts",
      from: "+15555550100",
      to: "+14158707772",
      body: "",
      parts: [{ type: "text", value: "hello from parts" }],
    });
    const res = await runSigned(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((dispatchCalls[0].msg as { text: string }).text).toBe("hello from parts");
  });

  it("verifies the HMAC over raw bytes when a multibyte character spans two chunks", async () => {
    const secret = "the-real-secret";
    process.env.LINQ_WEBHOOK_SECRET = secret;
    const body = JSON.stringify({ type: "message.received", chat_id: "c", message_id: "m", from: "+1", to: "+2", body: "caf\u00e9 \u{1F600}" });
    const bytes = Buffer.from(body, "utf8");
    const split = bytes.indexOf(Buffer.from("\u{1F600}", "utf8")) + 2;
    const sig = createHmac("sha256", secret).update(bytes).digest("hex");
    const req = Readable.from([bytes.subarray(0, split), bytes.subarray(split)]) as Parameters<typeof readLinqWebhook>[0];
    req.headers = { "x-linq-signature": sig };
    let status = 0;
    const res = {
      writeHead(s: number) { status = s; },
      end() { return res; },
    } as unknown as Parameters<typeof readLinqWebhook>[1];
    await readLinqWebhook(req, res, { getBots: () => [], beginAdmission: () => () => {} });
    expect(status).toBe(200);
    expect((dispatchCalls[0].msg as { text: string }).text).toBe("caf\u00e9 \u{1F600}");
  });
});
