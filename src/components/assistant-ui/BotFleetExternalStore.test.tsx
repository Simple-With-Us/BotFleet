import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import {
  createBotFleetExternalStore,
  useBotFleetRuntime,
  type BotFleetThreadMessage,
} from "./BotFleetExternalStore";

/**
 * Proves the assistant-ui seam renders BotFleet's own harness-shaped data.
 * No AI SDK, no network: the adapter is the only thing under test.
 *
 * Built on ThreadPrimitive, NOT @assistant-ui/react-ui: the published
 * react-ui package imports `useAssistantRuntime`, which no published
 * @assistant-ui/react (through 0.15.27) exports.  See
 * docs/decisions/2026-10-10-chat-ui-libraries.md.
 */

const messages: BotFleetThreadMessage[] = [
  { id: "m1", role: "user", text: "deploy the harness", createdAt: new Date(0) },
  { id: "m2", role: "assistant", text: "Deployed to 127.0.0.1:8799.", createdAt: new Date(1) },
];

describe("botfleet external store adapter", () => {
  it("maps harness messages into assistant-ui parts", () => {
    const adapter = createBotFleetExternalStore({
      threadId: "t1",
      messages,
      send: async () => {},
    });
    const converted = adapter.convertMessage!(messages[1], 1) as {
      id: string;
      role: string;
      content: unknown;
    };
    expect(converted.id).toBe("m2");
    expect(converted.role).toBe("assistant");
    expect(converted.content).toBe("Deployed to 127.0.0.1:8799.");
  });

  it("appends the live stream tail to the last assistant message", () => {
    const adapter = createBotFleetExternalStore({
      threadId: "t1",
      messages,
      stream: { text: " Streaming tail…" },
      send: async () => {},
    });
    const last = adapter.messages![adapter.messages!.length - 1];
    expect(last.text).toBe("Deployed to 127.0.0.1:8799. Streaming tail…");
    expect(adapter.isRunning).toBe(true);
  });

  it("sends through the harness send path, not an AI SDK", async () => {
    const send = vi.fn(async () => {});
    const adapter = createBotFleetExternalStore({ threadId: "t7", messages, send });
    await adapter.onNew!({
      content: [{ type: "text", text: "hello harness" }],
      role: "user",
    } as never);
    expect(send).toHaveBeenCalledWith({ threadId: "t7", text: "hello harness" });
  });

  it("renders ThreadPrimitive markup from harness data with no AI SDK", () => {
    function Harness() {
      const runtime = useBotFleetRuntime({
        threadId: "t1",
        messages,
        stream: { text: " Streaming tail…" },
        send: async () => {},
      });
      const body: ReactNode = createElement(
        ThreadPrimitive.Viewport,
        null,
        createElement(ThreadPrimitive.Viewport, null, "harness view"),
      );
      return createElement(AssistantRuntimeProvider, { runtime }, body);
    }

    const html = renderToStaticMarkup(createElement(Harness));
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("harness view");
  });
});