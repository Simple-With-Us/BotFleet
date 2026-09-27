// Dispatch router tests — verify that an inbound maps to a bound bot,
// that unbound senders log-and-ignore, that text replies tag with the
// `[from iMessage]` convention, and that the bots list is injected rather
// than reaching for the singleton store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BotRecord } from "../store.ts";

// Stub out the upstream Linq typing/mark calls before importing the
// module under test so partner-API traffic never crosses the boundary.
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

// loadConfig pulls from disk; the contract has no env knob, so we mock it
// for every test in this file.  Use `vi.hoisted` so the `vi.mock` factory
// can close over a name that's initialized before the mock is set up
// (vitest hoists `vi.mock` above this `const` declaration otherwise).
const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));

vi.mock("../config.ts", async () => {
  const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
  return { ...actual, loadConfig: loadConfigMock };
});

import {
  findBotForInbound,
  handleLinqInbound,
  ingestInbound,
  resolveLinqBinding,
  senderAllowed,
} from "./dispatch.ts";
import type { LinqInboundMessage } from "./types.ts";

const realFetch = globalThis.fetch;

interface Fetched {
  url: string;
  body: unknown;
}

let fetches: Fetched[] = [];

beforeEach(() => {
  loadConfigMock.mockReset();
  fetches = [];
  process.env.LINQ_API_TOKEN = "test-token";
  process.env.LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner/v3";
  process.env.BOTFLEET_HOST = "127.0.0.1:0";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    fetches.push({ url, body });
    if (url.startsWith("http://127.0.0.1:0/api/bots/")) {
      return new Response(JSON.stringify({ ok: true }), {
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
});

function makeBot(id: string): BotRecord {
  return {
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "blue" as never,
    unread: false,
    modelSelection: { kind: "minimax", model: "test" },
    resumeCursors: {},
  } as unknown as BotRecord;
}

const sampleInbound = (overrides: Partial<LinqInboundMessage> = {}): LinqInboundMessage => ({
  chatId: "chat-1",
  fromNumber: "+15555550100",
  toNumber: "+14158707772",
  text: "hello director",
  media: undefined,
  group: false,
  messageId: "msg-99",
  sentAt: new Date().toISOString(),
  ...overrides,
});

describe("resolveLinqBinding", () => {
  it("returns null when the bot has no transport override", () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { other: "linq" } },
      imessageLinq: { botNumber: "+14158707772" },
    });
    expect(resolveLinqBinding(loadConfigMock(), "thisbot")).toBeNull();
  });

  it("returns the workspace binding when the bot opts in to linq", () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { thisbot: "linq" } },
      imessageLinq: {
        botNumber: "+14158707772",
        allowedSenders: ["+15555550100"],
        ignoredSenders: [],
      },
    });
    const binding = resolveLinqBinding(loadConfigMock(), "thisbot");
    expect(binding?.botNumber).toBe("+14158707772");
    expect(binding?.allowedSenders).toEqual(["+15555550100"]);
  });

  it("returns null when the linq token is unset", () => {
    delete process.env.LINQ_API_TOKEN;
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { thisbot: "linq" } },
      imessageLinq: { botNumber: "+14158707772" },
    });
    expect(resolveLinqBinding(loadConfigMock(), "thisbot")).toBeNull();
    process.env.LINQ_API_TOKEN = "test-token";
  });
});

describe("senderAllowed", () => {
  it("respects the allowlist when one is configured", () => {
    const binding = { botNumber: "+1", allowedSenders: ["+1"], ignoredSenders: [] };
    expect(senderAllowed(binding, "+1")).toBe(true);
    expect(senderAllowed(binding, "+2")).toBe(false);
  });

  it("honors the ignore list when no allowlist is configured", () => {
    const binding = { botNumber: "+1", allowedSenders: [], ignoredSenders: ["+2"] };
    expect(senderAllowed(binding, "+2")).toBe(false);
    expect(senderAllowed(binding, "+3")).toBe(true);
  });
});

describe("findBotForInbound", () => {
  it("returns the bot whose workspace binding matches `toNumber`", () => {
    process.env.BOTFLEET_HOST = "127.0.0.1:8799";
    loadConfigMock.mockReturnValue({
      botDefaults: {
        imessagePerBot: { director: "linq", sidekick: "off" },
      },
      imessageLinq: { botNumber: "+14158707772" },
    });
    const bots = [makeBot("sidekick"), makeBot("director")];
    const result = findBotForInbound(loadConfigMock(), bots, sampleInbound());
    expect(result?.bot.id).toBe("director");
  });

  it("falls back to the only Linq-bound bot when `to` is missing", () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { director: "linq", sidekick: "off" } },
      imessageLinq: { botNumber: "+14158707772" },
    });
    const bots = [makeBot("sidekick"), makeBot("director")];
    expect(findBotForInbound(loadConfigMock(), bots, sampleInbound({ toNumber: undefined }))?.bot.id).toBe("director");
  });

  it("returns null without `to` when several bots are Linq-bound", () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { director: "linq", sidekick: "linq" } },
      imessageLinq: { botNumber: "+14158707772" },
    });
    const bots = [makeBot("sidekick"), makeBot("director")];
    expect(findBotForInbound(loadConfigMock(), bots, sampleInbound({ toNumber: undefined }))).toBeNull();
  });

  it("returns null when no bot is bound to that number", () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { other: "linq" } },
      imessageLinq: { botNumber: "+14158707772" },
    });
    const bots = [makeBot("other")];
    expect(
      findBotForInbound(loadConfigMock(), bots, sampleInbound({ toNumber: "+19999999999" })),
    ).toBeNull();
  });
});

describe("ingestInbound", () => {
  it("wraps the text in the iMessage inbound marker and posts to the harness", async () => {
    process.env.BOTFLEET_HOST = "127.0.0.1:0";
    const bot = makeBot("director");
    const result = await ingestInbound({
      source: "linq",
      bot,
      chatId: "chat-1",
      text: "hello",
    });
    expect(result.dispatched).toBe(true);
    const call = fetches.find((f) => f.url.endsWith("/api/bots/director/messages"));
    expect((call?.body as Record<string, unknown>).source).toBe("linq");
    expect((call?.body as Record<string, unknown>).chatId).toBe("chat-1");
    expect(((call?.body as Record<string, unknown>).text as string).startsWith("[IMESSAGE INBOUND]")).toBe(true);
  });

  it("refuses empty payloads", async () => {
    const bot = makeBot("d");
    const result = await ingestInbound({ source: "linq", bot, chatId: "c" });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("empty");
  });
});

describe("handleLinqInbound", () => {
  it("routes a bound inbound into the harness with source=linq", async () => {
    process.env.BOTFLEET_HOST = "127.0.0.1:0";
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { director: "linq" } },
      imessageLinq: { botNumber: "+14158707772" },
    });
    const bots = [makeBot("director")];
    const result = await handleLinqInbound(sampleInbound(), bots);
    expect(result.dispatched).toBe(true);
    const call = fetches.find((f) => f.url.endsWith("/api/bots/director/messages"));
    expect((call?.body as Record<string, unknown>).source).toBe("linq");
  });

  it("refuses an inbound from a sender on the ignore list", async () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: { director: "linq" } },
      imessageLinq: {
        botNumber: "+14158707772",
        ignoredSenders: ["+15555550100"],
        allowedSenders: [],
      },
    });
    const bots = [makeBot("director")];
    const result = await handleLinqInbound(sampleInbound(), bots);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("sender_blocked");
  });

  it("refuses an inbound for a chat that has no bound bot", async () => {
    loadConfigMock.mockReturnValue({
      botDefaults: { imessagePerBot: {} },
      imessageLinq: { botNumber: "+14158707772" },
    });
    const bots = [makeBot("director")];
    const result = await handleLinqInbound(sampleInbound(), bots);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("no_bot_for_chat");
  });
});
