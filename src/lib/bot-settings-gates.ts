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
import {
  effectiveReviewHook,
  type AutoReviewMode,
  type ReviewerRole,
  type ReviewHook,
} from "../../shared/auto-review";
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

/** The engine that actually ran the most recent turn, and whether a fallback
 *  moved it off the configured one.  A named contract, not an inline shape, so
 *  a caller cannot quietly disagree about what it is reading. */
export interface ActiveEngine {
  engine: InstanceInfo | undefined;
  rolledOver: boolean;
}

/** One read of the engine's capabilities, so no control re-derives it. */
export interface CapabilityGates {
  engine: InstanceInfo | undefined;
  /** Can this bot reach other bots? */
  canCoordinate: boolean;
  /** Can this engine answer a bounded review prompt on its own?  Whether
   *  auto-review is available at all is `autoReviewGate`: an engine that
   *  cannot review itself is reviewed by the owner's fallback reviewer. */
  canAutoReview: boolean;
  /** Can this engine mount Composio? */
  canUseConnectedApps: boolean;
  /** Can this engine be given a VPS at all? */
  canUseVps: boolean;
  /** Runs the harness HTTP tool loop. */
  toolLoop: boolean;
}

/** The engine that actually ran the most recent turn, when a fallback moved it
 *  off the configured one.  Used to tell the owner that a ceiling they can see
 *  is not the ceiling currently in force. */
export function activeEngine(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection" | "activeModelSelection">,
): ActiveEngine {
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

/** One read of the engine's capabilities for the whole panel. */
export function botCapabilityGates(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): CapabilityGates {
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

// ── auto-review ──────────────────────────────────────────────────────────
// The owner was told "this engine cannot run an isolated review safely" for
// every engine but Claude.  Two separate questions were collapsed into one:
// where BotFleet can see the engine's actions (the hook), and who can review
// them (the engine itself, or the fallback reviewer the owner picks).  This
// gate answers both, in the words the panel shows, and keeps the file's rule:
// an engine that has not reported yet is unknown, never "no".

/** A sentence gap that survives HTML whitespace collapsing. */
const GAP = "  ";

/** One engine that can review for others. */
export interface ReviewerOption {
  instanceId: string;
  name: string;
}

export interface AutoReviewGate {
  /** Where review sees this bot's actions under On.  A full-auto instance
   *  that can ask is held in its asking mode, so this reads `before`. */
  hook: ReviewHook | "unknown";
  /** Under Watch, which never changes what the engine does. */
  watchHook: ReviewHook | "unknown";
  /** Who reviews, or null when nobody can. */
  reviewer: (ReviewerOption & { role: ReviewerRole }) | null;
  canWatch: boolean;
  canEnforce: boolean;
  /** Why Watch and On are disabled, or null when they are not. */
  disabledReason: string | null;
  /** The engine cannot review its own actions, so the fallback reviewer
   *  decides whether review is available. */
  needsFallback: boolean;
  /** Engines the owner may pick as the fallback reviewer. */
  fallbackOptions: ReviewerOption[];
  /** The card's description line. */
  summary: string;
  /** The tooltip for each mode button. */
  hints: Record<AutoReviewMode, string>;
  /** How Bypass Permissions combines with the current mode, or null when
   *  Bypass is off. */
  bypassNote: string | null;
}

/** Engines that can review for any bot: an isolated reviewer, switched on. */
export function reviewerOptions(instances: InstanceInfo[]): ReviewerOption[] {
  return instances
    .filter((instance) => instance.capabilities?.approvalReview === true && instance.enabled !== false)
    .map((instance) => ({ instanceId: instance.instanceId, name: instance.displayName }));
}

/** What the Review Routine Approvals card offers this bot, and what it says.
 *
 *  `fallbackReviewerId` is the fleet's chosen fallback reviewer from config
 *  (`autoReview.fallbackReviewer`), or null. */
export function autoReviewGate(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection" | "autoReview" | "bypassPermissions">,
  fallbackReviewerId: string | null | undefined,
): AutoReviewGate {
  const engine = configuredEngine(instances, bot);
  const name = engine?.displayName ?? "This engine";
  const capabilities = engine?.capabilities;
  const nativeHook: ReviewHook | "unknown" = capabilities?.reviewHook ?? "unknown";
  const asksWhenHeld = capabilities?.asksWhenHeld === true;
  const enforceHook: ReviewHook | "unknown" =
    nativeHook === "unknown" ? "unknown" : effectiveReviewHook(nativeHook, asksWhenHeld, true);
  const fallbackOptions = reviewerOptions(instances);
  const reviewsItself = capabilities?.approvalReview === true && engine?.enabled !== false;
  const fallback = fallbackReviewerId
    ? fallbackOptions.find((option) => option.instanceId === fallbackReviewerId)
    : undefined;
  const reviewer = reviewsItself && engine
    ? { instanceId: engine.instanceId, name: engine.displayName, role: "own" as const }
    : fallback
      ? { ...fallback, role: "fallback" as const }
      : null;
  const needsFallback = engine !== undefined && !reviewsItself;

  const hints: Record<AutoReviewMode, string> = {
    off: "Every undecided approval waits for you.",
    shadow:
      nativeHook === "after"
        ? "Record what the reviewer thinks of each step, without changing anything."
        : "Record the review without answering the card.",
    enforce:
      enforceHook === "after"
        ? "Stop the turn when the reviewer refuses a step."
        : "Answer only reviews that return a strict approval.",
  };

  // Unknown engine: say so and keep every mode open.  A saved choice must
  // never look deleted because the instance list has not answered yet.
  if (nativeHook === "unknown") {
    return {
      hook: "unknown",
      watchHook: "unknown",
      reviewer,
      canWatch: true,
      canEnforce: true,
      disabledReason: null,
      needsFallback,
      fallbackOptions,
      summary: `${name} has not reported how it handles approvals yet.`,
      hints,
      bypassNote: bypassNote(bot, "unknown"),
    };
  }

  let disabledReason: string | null = null;
  if (nativeHook === "none") {
    disabledReason = `${name} reports no actions, so there is nothing to review.`;
  } else if (!reviewer) {
    disabledReason = fallbackOptions.length > 0
      ? `${name} cannot review on its own.${GAP}Choose a fallback reviewer below to turn this on.`
      : `${name} cannot review on its own, and no engine that can review is set up.${GAP}Set up Claude or an API engine to review for it.`;
  }
  const available = disabledReason === null;

  const reviewerName = reviewer?.name ?? "the reviewer";
  const who = reviewer?.role === "fallback"
    ? `${name} cannot review on its own, so ${reviewerName} reviews for it.${GAP}${reviewerName} sees each action this bot asks to run.`
    : `${name} reviews its own approvals.`;
  let summary: string;
  if (!available) {
    summary = disabledReason!;
  } else if (nativeHook === "before") {
    summary = `${who}${GAP}Each approval it asks for is reviewed before it runs.${GAP}Existing safety rules, unattended turns, local-computer access, and questions still wait for you.`;
  } else if (asksWhenHeld) {
    summary = `${name} is set to full auto.${GAP}On runs this bot's turns in asking mode, so each ask is reviewed before it runs.${GAP}Watch only records each step, and turns nobody started are watched, not held.${GAP}${who}`;
  } else {
    summary = `${name} runs its tools without asking first, so review can only watch.${GAP}Each step is checked as it starts, and On stops the turn when the reviewer refuses one.${GAP}It cannot undo a step that already started.${GAP}${who}`;
  }

  return {
    hook: enforceHook,
    watchHook: nativeHook,
    reviewer,
    canWatch: available,
    canEnforce: available,
    disabledReason,
    needsFallback,
    fallbackOptions,
    summary,
    hints,
    bypassNote: bypassNote(bot, enforceHook),
  };
}

function bypassNote(
  bot: Pick<Bot, "autoReview" | "bypassPermissions">,
  enforceHook: ReviewHook | "unknown",
): string | null {
  if (!bot.bypassPermissions) return null;
  const mode = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
  if (mode === "off") {
    return "Bypass Permissions is on, so routine actions run without approval cards or review.";
  }
  if (mode === "shadow") {
    return `Bypass Permissions is on, so routine actions are approved at once.${GAP}Watch only records what the reviewer would have done.`;
  }
  if (enforceHook === "after") {
    return `Bypass Permissions does not change this engine, which never asks.${GAP}On still stops the turn when the reviewer refuses a step.`;
  }
  return `Bypass Permissions is on, but the reviewer still checks each action first.${GAP}Anything it refuses comes back to you as a card.`;
}

export { DEFAULT_MAX_TOOL_ROUNDS };
