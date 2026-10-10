import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import {
  createBotFleetExternalStore,
  useBotFleetRuntime,
  STREAMING_MESSAGE_ID,
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
    expect(converted.content).toEqual([
      { type: "text", text: "Deployed to 127.0.0.1:8799." },
    ]);
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

  it("treats a reasoning-only stream as running and surfaces reasoning as its own part", () => {
    const adapter = createBotFleetExternalStore({
      threadId: "t1",
      messages,
      stream: { reasoning: "thinking…" },
      send: async () => {},
    });
    expect(adapter.isRunning).toBe(true);
    const last = adapter.messages![adapter.messages!.length - 1];
    expect(last.reasoning).toBe("thinking…");
    const converted = adapter.convertMessage!(last, 1) as { content: unknown };
    expect(converted.content).toEqual([
      { type: "text", text: "Deployed to 127.0.0.1:8799." },
      { type: "reasoning", text: "thinking…" },
    ]);
  });

  it("appends a synthetic assistant message when streaming before any settled bot text", () => {
    // The harness streams tokens before the settled message lands; ChatView.tsx
    // renders that window as a live bubble rather than dropping it.
    const userOnly: BotFleetThreadMessage[] = [
      { id: "u1", role: "user", text: "deploy the harness", createdAt: new Date(0) },
    ];
    const adapter = createBotFleetExternalStore({
      threadId: "t1",
      messages: userOnly,
      stream: { text: "Working…" },
      send: async () => {},
    });
    const last = adapter.messages![adapter.messages!.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.id).toBe(STREAMING_MESSAGE_ID);
    expect(last.text).toBe("Working…");
    expect(adapter.isRunning).toBe(true);
  });

  it("stays running when tokens stream before any settled bot message", () => {
    // This is the disagreement between two review suggestions.  A guard like
    // `last.role === "assistant"` was proposed to keep isRunning in sync with
    // the rendered tail — but once appendStreamTail appends a synthetic
    // assistant message, that guard would suppress the working state during
    // the exact window where the user needs it.  Pinned here deliberately.
    const userOnly: BotFleetThreadMessage[] = [
      { id: "u1", role: "user", text: "deploy the harness", createdAt: new Date(0) },
    ];
    const adapter = createBotFleetExternalStore({
      threadId: "t1",
      messages: userOnly,
      stream: { text: "Working…" },
      send: async () => {},
    });
    expect(adapter.isRunning).toBe(true);
    expect(adapter.messages).toHaveLength(2);
    expect(adapter.messages![1].role).toBe("assistant");
  });

it("sends through the harness send path, not an AI SDK", async () => {
    const send = vi.fn(async () => {});
    const adapter = createBotFleetExternalStore({ threadId: "t7", messages, send });
    const onNew = adapter.onNew!;
    // `AppendMessage` is `Omit<ThreadMessage, "id">` plus the run-plumbing
    // fields (parentId / sourceId / runConfig); build a complete one rather
    // than asserting the literal.
    await onNew({
      content: [{ type: "text", text: "hello harness" }],
      role: "user",
      createdAt: new Date(0),
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    });
    expect(send).toHaveBeenCalledWith({ threadId: "t7", text: "hello harness" });
  });

  it("renders harness message text through ThreadPrimitive.Messages", () => {
    function Harness({ stream }: { stream?: { text?: string } }) {
      const runtime = useBotFleetRuntime({
        threadId: "t1",
        messages,
        stream,
        send: async () => {},
      });
      // Route the harness messages through the primitives so the assertions
      // below can only pass if the runtime actually reaches the DOM with OUR
      // text.  A literal child would render either way, which is exactly the
      // gap Kody flagged on the first version of this test.
      //
      // `Messages` takes a RENDER-FUNCTION child (it maps over the thread's
      // message ids); `MessagePrimitive.Content` renders the message part.
      const body: ReactNode = createElement(
        ThreadPrimitive.Viewport,
        null,
        createElement(ThreadPrimitive.Messages, {
          children: () =>
            createElement(
              MessagePrimitive.Root,
              null,
              // `Parts` maps message parts to components.  The `Text`
              // override is the component that renders the harness text: if
              // the store never reached the parts, this renders empty and the
              // assertions below fail.  (No extra foil component — the real
              // text itself is the evidence.)
              createElement(MessagePrimitive.Parts, {
                components: {
                  Text: ({ text }: { text?: string }) => createElement("b", null, text),
                },
              }),
            ),
        }),
      );
      return createElement(AssistantRuntimeProvider, { runtime }, body);
    }

    // No live stream: assistant-ui renders the settled text for both roles.
    const settled = renderToStaticMarkup(
      createElement(Harness, { stream: undefined }),
    );
    expect(settled).toContain("deploy the harness");
    expect(settled).toContain("Deployed to 127.0.0.1:8799.");

    // With a live stream the trailing assistant message carries the appended
    // tail, because our adapter folds the stream into the last assistant
    // message before handing it over.  (Verified: this is a property of the
    // adapter, not of the primitives — the settled and live paths both render.)
    const live = renderToStaticMarkup(
      createElement(Harness, { stream: { text: " Streaming tail…" } }),
    );
    expect(live).toContain("deploy the harness");
    expect(live).toContain("Deployed to 127.0.0.1:8799. Streaming tail…");
  });
});