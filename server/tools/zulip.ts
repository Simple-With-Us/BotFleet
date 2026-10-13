// `zulip_reply`, `zulip_post` and `zulip_follow_topic` executors for the
// HTTP tool lane.  Companion to `tools/registry.ts`'s ZULIP_REPLY,
// ZULIP_POST and ZULIP_FOLLOW_TOPIC records.
//
// The executor owns nothing but the hop: the Zulip hub (server/zulip/hub.ts)
// decides the target, scans the text and posts.  The caller's identity is
// the turn's (`AgentToolCallContext`, built by the tool host at dispatch),
// never the model's arguments, so a bot can only ever post as itself and
// only ever reply to the conversation that woke its own turn.  The hub is
// injected rather than imported from the harness: nothing under
// server/tools/ may reach server/index.ts (registry.test.ts).

import type { TurnToolCall, TurnToolOutcome } from "../contracts.ts";
import type { AgentToolCallContext, AgentToolExecutor } from "./agents.ts";

export interface ZulipToolRequest {
  botId: string;
  threadId: string;
  tool: "reply" | "post" | "follow";
  /** The model's arguments, unparsed: the hub parses them at its boundary. */
  args: unknown;
}

export type ZulipToolSend = (request: ZulipToolRequest) => Promise<{ ok: boolean; text: string }>;

export function createZulipTools(deps: { send: ZulipToolSend }) {
  const run =
    (tool: "reply" | "post" | "follow"): AgentToolExecutor =>
    async (call: TurnToolCall, identity: AgentToolCallContext): Promise<TurnToolOutcome> => {
      const result = await deps.send({ botId: identity.botId, threadId: identity.threadId, tool, args: call.arguments });
      const done = tool === "follow" ? "changed" : "posted";
      return result.ok
        ? { kind: "result", content: result.text, detail: done }
        : { kind: "error", content: result.text, detail: `not ${done}` };
    };
  return {
    zulip_reply: run("reply"),
    zulip_post: run("post"),
    zulip_follow_topic: run("follow"),
  } satisfies Record<string, AgentToolExecutor>;
}
