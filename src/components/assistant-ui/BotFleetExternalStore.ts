/**
 * Spike: prove assistant-ui can be driven by BotFleet's own harness stream.
 *
 * BotFleet does NOT use the Vercel AI SDK.  Messages arrive over the
 * Electron/harness bridge (`useStreaming()` in src/state/store.tsx) as
 * per-thread streaming text plus a settled message list.  This adapter is
 * the seam: it maps that shape onto assistant-ui's ExternalStoreAdapter so
 * the primitives render our data instead of an AI-SDK stream.
 *
 * Verified against @assistant-ui/react 0.15.27 / @assistant-ui/core 0.3.26.
 */

import { useMemo } from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";

/** Mirrors the shape ChatView.tsx consumes from `useStreaming()`. */
export type BotFleetThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Reasoning tail for the assistant's turn; surfaced as its own part. */
  reasoning?: string;
  createdAt: Date;
  /** Stable branch key; BotFleet supports re-generating a turn. */
  branchKey?: string;
};

/** Streaming tail for a thread that has not settled yet. */
export type BotFleetStreamChunk = {
  text?: string;
  reasoning?: string;
};

/** Our send path is the harness `POST /api/bots/{id}/messages`, not AI SDK. */
export type BotFleetSend = (params: { threadId: string; text: string }) => Promise<void>;

/** Our reload path is the harness' regenerate endpoint. */
export type BotFleetReload = (params: {
  messageId: string;
  sourceId: string | null;
  runConfig: RunConfigLike;
}) => Promise<void>;

/**
 * `RunConfig` in @assistant-ui/core is `{ custom?: Record<string, unknown> }`.
 * Neither `RunConfig` nor `StartRunConfig` is re-exported by
 * @assistant-ui/react, so the shapes are spelled out structurally here.
 */
type RunConfigLike = { readonly custom?: Record<string, unknown> };

/**
 * `onReload(parentId, config)` — `config` is a `StartRunConfig`.  `sourceId` is
 * the edited message and `runConfig` is caller-supplied run options; both are
 * forwarded so a regenerate can carry the harness' own branch semantics
 * instead of dropping them.
 */
type StartRunConfigLike = {
  parentId: string | null;
  sourceId: string | null;
  runConfig: RunConfigLike;
};

/**
 * Id for the synthetic assistant message that carries the live stream when the
 * harness has not settled a real one yet.  Stable so re-renders replace it
 * rather than append a new bubble per frame.
 */
export const STREAMING_MESSAGE_ID = "__botfleet_streaming__";

function toThreadMessage(message: BotFleetThreadMessage): ThreadMessageLike {
  // `content` is `string | readonly ThreadMessageLikePart[]` — a plain string
  // is the supported text-only shape (verified in core's thread-message-like.d.ts).
  // `ThreadMessageLikePart` itself is NOT re-exported from @assistant-ui/react
  // or @assistant-ui/core, so derive the element type from `ThreadMessageLike`.
  type Part = Extract<ThreadMessageLike["content"], readonly unknown[]>[number];
  const parts: Part[] = [{ type: "text", text: message.text }];
  if (message.reasoning) parts.push({ type: "reasoning", text: message.reasoning });
  return {
    id: message.id,
    role: message.role,
    content: parts,
    createdAt: message.createdAt,
    // Branch identity rides in `custom`; the `unstable_*` metadata keys are all
    // marked deprecated in 0.3.26.
    metadata: message.branchKey ? { custom: { branchKey: message.branchKey } } : undefined,
  };
}

/**
 * Build the adapter.  Kept separate from the hook so it can be unit-tested
 * without React.
 */
export function createBotFleetExternalStore(params: {
  threadId: string;
  messages: BotFleetThreadMessage[];
  /** Live streaming tail appended to the last assistant message. */
  stream?: BotFleetStreamChunk;
  send: BotFleetSend;
  reload?: BotFleetReload;
}): ExternalStoreAdapter<BotFleetThreadMessage> {
  const { threadId, messages, stream, send, reload } = params;

  // Streaming is "mutate the assistant message in place" — the same thing
  // BotFleet already does with its per-frame rAF delta buffer.
  const withStream = appendStreamTail(messages, stream);

  return {
    messages: withStream,
    convertMessage: toThreadMessage,
    // True whenever the harness is mid-turn.  appendStreamTail guarantees a
    // rendered tail for every streaming frame: it folds the delta into the
    // trailing assistant message, or appends a synthetic one when the settled
    // message has not landed yet.  So isRunning and the visible text stay in
    // sync WITHOUT also requiring the last message to be an assistant one —
    // that guard would hide the "working" state during exactly the window
    // (tokens streaming before the settled reply) where the user needs it.
    isRunning: Boolean(stream?.text || stream?.reasoning),
    onNew: async (message: AppendMessage) => {
      const text = extractText(message);
      if (!text.trim()) return;
      await send({ threadId, text });
    },
    // Signature is (parentId, config) — parentId is `string | null`, not an object.
    onReload: reload
      ? async (parentId: string | null, config: StartRunConfigLike) => {
          if (!parentId) return;
          await reload({
            messageId: parentId,
            sourceId: config.sourceId,
            runConfig: config.runConfig,
          });
        }
      : undefined,
  };
}

/** Pure helper — no hooks, so it is unit-testable outside React. */
export function appendStreamTail(
  messages: BotFleetThreadMessage[],
  stream?: BotFleetStreamChunk,
): BotFleetThreadMessage[] {
  const tail = stream?.text ?? "";
  const reasoning = stream?.reasoning ?? "";
  if (!tail && !reasoning) return messages;
  const next = messages.slice();
  const last = next[next.length - 1];

  // No assistant message yet — the harness streams tokens BEFORE the settled
  // message lands (ChatView.tsx renders exactly this window as a live bubble).
  // Append a synthetic assistant message rather than dropping the tail, so the
  // running state and the visible text stay in sync.
  if (!last || last.role !== "assistant") {
    const lastCreatedAt = messages[messages.length - 1]?.createdAt;
    next.push({
      id: STREAMING_MESSAGE_ID,
      role: "assistant",
      text: tail,
      reasoning: reasoning || undefined,
      createdAt: lastCreatedAt
        ? new Date(Math.max(lastCreatedAt.getTime(), Date.now() - 1))
        : new Date(),
      branchKey: last?.branchKey,
    });
    return next;
  }

  next[next.length - 1] = {
    ...last,
    text: last.text + tail,
    reasoning: (last.reasoning ?? "") + reasoning,
  };
  return next;
}

function extractText(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** React entry point — mount under <AssistantRuntimeProvider runtime={runtime}>. */
export function useBotFleetRuntime(params: Parameters<typeof createBotFleetExternalStore>[0]) {
  // Memo on the pieces the adapter actually closes over, so a re-render with
  // an unchanged message list does not hand assistant-ui a new adapter identity.
  const { threadId, messages, stream, send, reload } = params;
  const adapter = useMemo(
    () =>
      createBotFleetExternalStore({
        threadId,
        messages,
        stream: stream ? { text: stream.text, reasoning: stream.reasoning } : undefined,
        send,
        reload,
      }),
    [threadId, messages, stream?.text, stream?.reasoning, send, reload],
  );
  return useExternalStoreRuntime(adapter);
}