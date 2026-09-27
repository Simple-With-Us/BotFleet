// Static tool catalog for HTTP drivers (MiniMax, OpenAI-compatible).
//
// CLI drivers (Claude, Codex, Droid, Pi, ACP engines) mount MCP
// servers at turn time and discover tools at runtime, so they do not need a
// static catalog.  HTTP drivers cannot, so the harness has to hand the model
// a tool list on the wire.
//
// This file no longer OWNS any definition.  `server/tools/registry.ts` holds
// one record per tool and both lanes render it, so the HTTP catalog and the
// MCP catalog cannot drift the way they did when each lane wrote its own
// schema.  What remains here is the shim that maps the dispatch's
// `integrations` object onto a registry gate; it disappears when the last
// caller moves to `httpToolDefinitions` directly.

import { httpToolDefinitions, type ToolGateContext } from "./tools/registry.ts";
import type { SendTurnInput } from "./contracts.ts";

type ToolDefinition = NonNullable<SendTurnInput["tools"]>[number];

/** Build the tool catalog for an HTTP-driver turn.  Returns an empty array
 * when no integration surfaces are enabled, so the driver hands the model a
 * plain chat request and the loop is a no-op.
 *
 * The dispatch has already gated `integrations.agents` on
 * `commsDepth < MAX_COMMS_DEPTH` and the driver's `agentsMcp` capability by
 * the time it gets here — if either is false the object is absent and the
 * model is offered nothing.  A caller with the real numbers to hand can pass
 * `gate` instead and let the registry apply the ceiling itself. */
export function buildTurnTools(
  integrations: {
    agents?: unknown;
    localComputer?: unknown;
    workspace?: unknown;
    recall?: unknown;
    phone?: unknown;
    linq?: unknown;
  },
  gate?: Partial<ToolGateContext>,
): ToolDefinition[] {
  return httpToolDefinitions({
    agents: !!integrations.agents,
    localComputer: Boolean(integrations.localComputer),
    workspace: Boolean(integrations.workspace),
    recall: Boolean(integrations.recall),
    phone: Boolean(integrations.phone),
    // github has no integrations key of its own — it rides the same
    // localComputer grant bash does (registry.ts's githubEnabled), so the
    // wire catalog must derive it the same way host.ts's gate does, or the
    // two would disagree about whether github_* tools exist this turn.
    github: Boolean(integrations.localComputer),
    linq: Boolean(integrations.linq ?? gate?.linq),
    commsDepth: 0,
    // The caller's own depth gate already ran; without explicit numbers the
    // registry ceiling must not subtract a second time.
    maxCommsDepth: Number.POSITIVE_INFINITY,
    chiefOfStaff: false,
    ...gate,
  });
}
