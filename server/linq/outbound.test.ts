import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, linqSendMessage, linqStopTyping } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  linqSendMessage: vi.fn(async () => undefined),
  linqStopTyping: vi.fn(async () => undefined),
}));

vi.mock("../config.ts", async () => {
  const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
  return { ...actual, loadConfig: loadConfigMock };
});

vi.mock("./client.ts", async () => {
  const actual = await vi.importActual<typeof import("./client.ts")>("./client.ts");
  return { ...actual, linqSendMessage, linqStopTyping };
});

import {
  _resetLinqChatBindingsForTests,
  bindLinqChatToTurn,
  deliverLinqOutboundIfNeeded,
  peekLinqChat,
  releaseLinqChat,
  rememberLinqChat,
} from "./outbound.ts";

afterEach(() => {
  _resetLinqChatBindingsForTests();
  linqSendMessage.mockClear();
  linqStopTyping.mockClear();
});

beforeEach(() => {
  loadConfigMock.mockReturnValue({
    botDefaults: { imessagePerBot: { "bot-1": "linq" } },
  });
});

describe("Linq turn-scoped chat binding", () => {
  it("does not retarget an in-flight turn when a second inbound remembers a different chat", () => {
    bindLinqChatToTurn("thread-1", "turn-a", "bot-1", "chat-a");
    rememberLinqChat("thread-1", "bot-1", "chat-b");
    expect(peekLinqChat("thread-1", "turn-a")).toEqual({ chatId: "chat-a", botId: "bot-1" });
    expect(peekLinqChat("thread-1")).toEqual({ chatId: "chat-a", botId: "bot-1" });
    bindLinqChatToTurn("thread-1", "turn-b", "bot-1", "chat-b");
    expect(peekLinqChat("thread-1", "turn-a")).toEqual({ chatId: "chat-a", botId: "bot-1" });
    expect(peekLinqChat("thread-1", "turn-b")).toEqual({ chatId: "chat-b", botId: "bot-1" });
    releaseLinqChat("thread-1", "turn-a");
    expect(peekLinqChat("thread-1", "turn-a")).toBeUndefined();
    expect(peekLinqChat("thread-1", "turn-b")).toEqual({ chatId: "chat-b", botId: "bot-1" });
  });

  it("keeps a pending launch binding until the provider turnId is known", () => {
    rememberLinqChat("thread-1", "bot-1", "chat-a");
    expect(peekLinqChat("thread-1", "turn-a")).toEqual({ chatId: "chat-a", botId: "bot-1" });
    bindLinqChatToTurn("thread-1", "turn-a", "bot-1", "chat-a");
    expect(peekLinqChat("thread-1", "turn-a")).toEqual({ chatId: "chat-a", botId: "bot-1" });
    releaseLinqChat("thread-1", "turn-a");
    expect(peekLinqChat("thread-1")).toBeUndefined();
    expect(peekLinqChat("thread-1", "turn-a")).toBeUndefined();
  });

  it("sends each turn's tagged reply to the chat that started that turn", async () => {
    bindLinqChatToTurn("thread-1", "turn-a", "bot-1", "chat-a");
    bindLinqChatToTurn("thread-1", "turn-b", "bot-1", "chat-b");
    const first = await deliverLinqOutboundIfNeeded(
      "thread-1",
      "bot-1",
      "[to iMessage]\nhello a",
      "turn-a",
    );
    const second = await deliverLinqOutboundIfNeeded(
      "thread-1",
      "bot-1",
      "[to iMessage]\nhello b",
      "turn-b",
    );
    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: true });
    expect(linqSendMessage.mock.calls.map((call) => call[0])).toEqual(["chat-a", "chat-b"]);
  });
});
