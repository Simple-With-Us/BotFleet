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
  sendLinqCommandReply,
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
    expect(linqSendMessage).toHaveBeenNthCalledWith(1, "chat-a", { text: "hello a" });
    expect(linqSendMessage).toHaveBeenNthCalledWith(2, "chat-b", { text: "hello b" });
  });

  it("masks a credential in a tagged reply before it is pushed to the phone", async () => {
    // assembled at runtime so no token-shaped literal sits in the source
    const key = ["sk", "-ant-", "api03-", "TESTONLY", "0123456789abcdef0123456789abcdef"].join("");
    bindLinqChatToTurn("thread-1", "turn-a", "bot-1", "chat-a");
    const result = await deliverLinqOutboundIfNeeded("thread-1", "bot-1", `[to iMessage]\nThe key is ${key}`, "turn-a");
    expect(result).toEqual({ sent: true });
    const [, sent] = linqSendMessage.mock.calls[0] as unknown as [string, { text: string }];
    expect(sent.text).not.toContain("TESTONLY");
    expect(sent.text).toContain("The key is");
  });
});

describe("Linq command replies", () => {
  it("sends the reply to the chat the command came from, redacted, and stops the typing indicator", async () => {
    const key = ["sk", "-ant-", "api03-", "TESTONLY", "0123456789abcdef0123456789abcdef"].join("");
    await expect(sendLinqCommandReply("chat-z", `Conversation: ${key}`)).resolves.toEqual({ sent: true });
    const [chatId, sent] = linqSendMessage.mock.calls[0] as unknown as [string, { text: string }];
    expect(chatId).toBe("chat-z");
    expect(sent.text).not.toContain("TESTONLY");
    expect(linqStopTyping).toHaveBeenCalledWith("chat-z");
  });

  it("stops the typing indicator even when the send fails, and says why", async () => {
    linqSendMessage.mockRejectedValueOnce(new Error("linq: send failed"));
    await expect(sendLinqCommandReply("chat-z", "Idle")).resolves.toEqual({ sent: false, reason: "linq: send failed" });
    expect(linqStopTyping).toHaveBeenCalledWith("chat-z");
  });
});
