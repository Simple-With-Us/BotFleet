// Which Bot Profile controls apply to this bot, and why.
//
// WHY THIS FILE EXISTS.  Every capability-gated row in the Bot Profile panel
// used to ask the live instance list inline, like this:
//
//   const engine = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
//   …
//   {engine?.capabilities?.toolLoop === true && <MaxToolRoundsField … />}
//
// which produced two defects that a reader reported as "only a couple of bots
// have a tool-rounds setting":
//
//  1. `undefined` reads as "no".  The lookup returns undefined while
//     `/api/instances` is still in flight, and forever after for an engine the
//     client has never heard of — so a MiniMax bot's control VANISHED on a
//     cold start and a saved value looked deleted.  An unknown engine is not a
//     no-capability engine, and the file's own sibling (lib/local-computer.ts)
//     already says so in a comment: "null is NOT 'no reach'".
//  2. Nothing distinguished "this engine ignores the setting" from "you never
//     set one".  A CLI/ACP engine runs its own loop inside the vendor CLI, so
//     `maxToolRounds` genuinely does not apply to it — but the control simply
//     disappeared, and a value saved while the bot was on MiniMax stayed on
//     the record, invisible and inert, with no way to see or clear it.
//
// So the rule is: never let a saved value be invisible, and never let an
// unanswered question be answered "no".  An engine we do not know about, or
// one that does not honor the setting, gets an explanation and a way out —
// not a vanished control.

import { DEFAULT_MAX_TOOL_ROUNDS, toolRoundsCaption } from "../../shared/bot-profile";
import type { Bot, InstanceInfo } from "@/state/store";

/** The smallest bot shape these gates need.  Kept structural so tests can pass
 *  a literal instead of a whole `Bot`. */
export type GateBot = Pick<Bot, "modelSelection" | "activeModelSelection" | "maxToolRounds">;

/** The engine a turn will be dispatched to first: the configured selection.
 *
 *  This is deliberately NOT `activeModelSelection`.  A fallback rollover
 *  records what actually ran last, but the next turn attempts the configured
 *  engine again, so the configured one is what a person setting a per-bot
 *  option is actually choosing. */
export function configuredEngine(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): InstanceInfo | undefined {
  return instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
}

/** The engine that actually ran the most recent turn, when a fallback moved it
 *  off the configured one.  Used to tell the owner that a ceiling they can see
 *  is not the ceiling currently in force. */
export function activeEngine(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection" | "activeModelSelection">,
): { engine: InstanceInfo | undefined; rolledOver: boolean } {
  const active = bot.activeModelSelection;
  if (!active || active.instanceId === bot.modelSelection.instanceId) {
    return { engine: configuredEngine(instances, bot), rolledOver: false };
  }
  return {
    engine: instances.find((instance) => instance.instanceId === active.instanceId),
    rolledOver: true,
  };
}

/** What the Maximum Tool Rounds control should do for this bot. */
export interface ToolRoundsGate {
  /** Render the control at all. */
  visible: boolean;
  /** Accept typing.  False when the engine in force does not apply the value. */
  editable: boolean;
  /** The one line under the title.  Always derived from the real constants. */
  caption: string;
  /** Why the control is read-only, or null when it is editable or hidden. */
  note: string | null;
}

/** Whether this engine runs the harness HTTP tool loop, and so honors
 *  `maxToolRounds`.  Mirrors `server/harness/registry.ts`, which is what
 *  actually ships `capabilities.toolLoop` on the wire. */
export function honorsToolRounds(engine: InstanceInfo | undefined): boolean {
  return engine?.capabilities?.toolLoop === true;
}

/**
 * The Maximum Tool Rounds control for one bot.
 *
 * Three cases, and the difference between them is the whole point:
 *
 *  - the engine honors the loop  → visible and editable (what it always was)
 *  - the engine is known and does NOT honor it, and a value is saved
 *      → visible and READ-ONLY, naming the engine and offering the truth: the
 *        value is inert until a turn lands on an engine that applies it
 *  - the engine is known and does NOT honor it, and nothing is saved
 *      → hidden, because there is nothing to say and nothing to set
 *
 * An UNKNOWN engine (instances still loading, or an engine the client has
 * never heard of) is treated as the second case, not the third: we will not
 * claim the setting is inapplicable on the strength of a lookup that has not
 * answered yet.
 */
export function toolRoundsGate(
  instances: InstanceInfo[],
  bot: GateBot,
): ToolRoundsGate {
  const caption = toolRoundsCaption();
  const engine = configuredEngine(instances, bot);
  const saved = typeof bot.maxToolRounds === "number";

  if (honorsToolRounds(engine)) {
    return { visible: true, editable: true, caption, note: null };
  }

  if (!saved) {
    // Known engine that cannot use it and nothing to preserve: stay out of the
    // way.  An unknown engine still lands here, which is the only place a
    // cold start can hide a control that would have been editable anyway.
    return { visible: false, editable: false, caption, note: null };
  }

  const name = engine?.displayName ?? "This engine";
  const reason = engine
    ? `${name} runs its own tool loop, so this ceiling does not apply to it.`
    : "This engine has not reported its capabilities yet, so this ceiling may not apply to it.";
  const { engine: running, rolledOver } = activeEngine(instances, bot);
  const rolloverNote = rolledOver
    ? ` A turn last ran on ${running?.displayName ?? "another engine"} instead.`
    : "";

  return {
    visible: true,
    editable: false,
    caption,
    note: `${reason}${rolloverNote} It applies again if a turn lands on an engine that uses the app's loop. Clear it to stop carrying it.`,
  };
}

/** One read of the engine's capabilities, so no control re-derives it. */
export function botCapabilityGates(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): {
  engine: InstanceInfo | undefined;
  /** Can this bot reach other bots? */
  canCoordinate: boolean;
  /** Can this engine answer a bounded review prompt? */
  canAutoReview: boolean;
  /** Can this engine mount Composio? */
  canUseConnectedApps: boolean;
  /** Can this engine be given a VPS at all? */
  canUseVps: boolean;
  /** Runs the harness HTTP tool loop. */
  toolLoop: boolean;
} {
  const engine = configuredEngine(instances, bot);
  const capabilities = engine?.capabilities;
  return {
    engine,
    canCoordinate: capabilities?.agentsMcp === true,
    canAutoReview: capabilities?.approvalReview === true,
    canUseConnectedApps: capabilities?.composioMcp === true,
    canUseVps: capabilities?.computerMcp === true && engine?.driverKind !== "boxAgent",
    toolLoop: capabilities?.toolLoop === true,
  };
}

export { DEFAULT_MAX_TOOL_ROUNDS };
