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
  DEFAULT_MAX_REVIEWS_PER_TURN,
  effectiveReviewHook,
  fallbackReviewerSetting,
  pickAutoReviewer,
  reviewerHealth,
  reviewerOrder,
  type AutoReviewMode,
  type FallbackReviewerSetting,
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
// them (the engine itself, or the fleet's fallback reviewer).  This gate
// answers both, in the words the panel shows, and keeps the file's rule: an
// engine that has not reported yet is unknown, never "no".  Who reviews, and
// in what order, comes from shared/auto-review.ts, the same rule the server
// asks by, so the card can never name a reviewer the server would not ask.

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
  /** Who reviews first, or null when nobody can. */
  reviewer: (ReviewerOption & { role: ReviewerRole }) | null;
  /** Who is asked when the first reviewer produces no verdict, if anyone. */
  standIn: (ReviewerOption & { role: ReviewerRole }) | null;
  canWatch: boolean;
  canEnforce: boolean;
  /** Why Watch and On are disabled, or null when they are not. */
  disabledReason: string | null;
  /** The engine cannot review its own actions, so the fallback reviewer
   *  decides whether review is available. */
  needsFallback: boolean;
  /** How the fleet's fallback reviewer is set. */
  fallbackMode: FallbackReviewerSetting["kind"];
  /** The fallback reviewer in use: the chosen engine, or Automatic's pick. */
  fallback: ReviewerOption | null;
  /** The engine Automatic picks right now, or null when none can review. */
  automatic: ReviewerOption | null;
  /** Engines the owner may pick as the fallback reviewer. */
  fallbackOptions: ReviewerOption[];
  /** The card's description line. */
  summary: string;
  /** What the per-turn review limit does. */
  capNote: string;
  /** The tooltip for each mode button. */
  hints: Record<AutoReviewMode, string>;
  /** How Auto or Bypass Permissions combines with the current mode, or null
   *  when neither is on. */
  bypassNote: string | null;
}

/** Whether an engine can actually answer a review right now: it has an
 *  isolated reviewer, it is switched on, and its last probe found it usable
 *  (a keyless API engine or a missing CLI would fail every review).  A probe
 *  that is still answering counts, so a slow engine is not dropped. */
function canReview(instance: InstanceInfo | undefined): boolean {
  if (!instance || instance.capabilities?.approvalReview !== true || instance.enabled === false) return false;
  return reviewerHealth(instance.snapshot) !== "unhealthy";
}

/** Engines that can review for any bot. */
export function reviewerOptions(instances: InstanceInfo[]): ReviewerOption[] {
  return instances
    .filter((instance) => canReview(instance))
    .map((instance) => ({ instanceId: instance.instanceId, name: instance.displayName }));
}

/** The engine the fleet's Automatic fallback reviewer picks from this list,
 *  by the same rule the server uses (shared/auto-review.ts
 *  `pickAutoReviewer`). */
export function automaticReviewer(instances: InstanceInfo[]): ReviewerOption | null {
  const id = pickAutoReviewer(
    instances.map((instance) => ({
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      canReview: instance.capabilities?.approvalReview === true && instance.enabled !== false,
      health: reviewerHealth(instance.snapshot),
    })),
  );
  const instance = id ? instances.find((candidate) => candidate.instanceId === id) : undefined;
  return instance ? { instanceId: instance.instanceId, name: instance.displayName } : null;
}

/** What the Review Routine Approvals card offers this bot, and what it says.
 *
 *  `fallbackSetting` is the fleet's stored fallback reviewer from config
 *  (`autoReview.fallbackReviewer`): null for Automatic, "none", or an
 *  instance id.  `maxReviewsPerTurn` is the per-turn review limit. */
export function autoReviewGate(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection" | "autoReview" | "bypassPermissions" | "autoApprove">,
  fallbackSetting: string | null | undefined,
  maxReviewsPerTurn: number = DEFAULT_MAX_REVIEWS_PER_TURN,
): AutoReviewGate {
  const engine = configuredEngine(instances, bot);
  const name = engine?.displayName ?? "This engine";
  const capabilities = engine?.capabilities;
  const nativeHook: ReviewHook | "unknown" = capabilities?.reviewHook ?? "unknown";
  const asksWhenHeld = capabilities?.asksWhenHeld === true;
  const enforceHook: ReviewHook | "unknown" =
    nativeHook === "unknown" ? "unknown" : effectiveReviewHook(nativeHook, asksWhenHeld, true);
  const fallbackOptions = reviewerOptions(instances);
  const reviewsItself = canReview(engine);
  const setting = fallbackReviewerSetting(fallbackSetting);
  const automatic = automaticReviewer(instances);
  const fallback =
    setting.kind === "chosen"
      ? fallbackOptions.find((option) => option.instanceId === setting.instanceId) ?? null
      : setting.kind === "auto"
        ? automatic
        : null;
  const order = reviewerOrder({
    engine: engine ? { instanceId: engine.instanceId, driverKind: engine.driverKind, canReview: reviewsItself } : null,
    fallback: fallback ? { instanceId: fallback.instanceId, canReview: true } : null,
  });
  const named = (entry: { instanceId: string; role: ReviewerRole } | undefined) => {
    if (!entry) return null;
    const source = entry.role === "own" ? engine : instances.find((instance) => instance.instanceId === entry.instanceId);
    return source ? { instanceId: entry.instanceId, name: source.displayName, role: entry.role } : null;
  };
  const reviewer = named(order[0]);
  const standIn = named(order[1]);
  const needsFallback = engine !== undefined && !reviewsItself;

  const hints = {
    off: "Every undecided approval waits for you.",
    shadow:
      nativeHook === "after"
        ? "Record what the reviewer thinks of each step, without changing anything."
        : "Record the review without answering the card.",
    enforce:
      enforceHook === "after"
        ? "Stop the turn when the reviewer refuses a step or cannot check it."
        : "Answer only reviews that return a strict approval.",
  } satisfies Record<AutoReviewMode, string>;
  const capNote = `Up to ${maxReviewsPerTurn} reviews per turn.${GAP}Past that, On hands each approval to you or stops the turn, and Watch stops recording.`;
  const base = { reviewer, standIn, needsFallback, fallbackMode: setting.kind, fallback, automatic, fallbackOptions, capNote, hints };

  // Unknown engine: say so and keep every mode open.  A saved choice must
  // never look deleted because the instance list has not answered yet.
  if (nativeHook === "unknown") {
    return {
      ...base,
      hook: "unknown",
      watchHook: "unknown",
      canWatch: true,
      canEnforce: true,
      disabledReason: null,
      summary: `${name} has not reported how it handles approvals yet.`,
      bypassNote: bypassNote(bot, "unknown", false),
    };
  }

  let disabledReason: string | null = null;
  if (nativeHook === "none") {
    disabledReason = `${name} reports no actions, so there is nothing to review.`;
  } else if (!reviewer) {
    disabledReason = setting.kind === "none" && fallbackOptions.length > 0
      ? `${name} cannot review on its own, and the fallback reviewer is off.${GAP}Choose one below to turn this on.`
      : fallbackOptions.length > 0
        ? `${name} cannot review on its own.${GAP}Choose a fallback reviewer below to turn this on.`
        : `${name} cannot review on its own, and no engine that can review is set up.${GAP}Set up Claude or an API engine to review for it.`;
  }
  const available = disabledReason === null;

  const reviewerName = reviewer?.name ?? "the reviewer";
  // The server falls through to the next reviewer when the first produces no
  // verdict (no key, a dead CLI, a timeout), so say so: that reviewer then
  // sees this bot's action too.
  const who = reviewer?.role === "fallback" && !reviewsItself
    ? `${name} cannot review on its own, so ${reviewerName} reviews for it.${GAP}${reviewerName} sees each action it checks.`
    : reviewer?.role === "fallback" && standIn
      ? `${reviewerName} reviews this bot's actions first, so ${name} is not the first judge of its own work.${GAP}${standIn.name} stands in if that review fails.`
      : standIn
        ? `${name} reviews its own approvals, and ${standIn.name} stands in if that review fails.`
        : `${name} reviews its own approvals.`;
  let summary: string;
  if (!available) {
    summary = disabledReason!;
  } else if (nativeHook === "before") {
    summary = `${who}${GAP}Each approval it asks for is reviewed before it runs, including one Auto or Bypass would grant.${GAP}Steps it takes without asking are not reviewed.${GAP}Existing safety rules, unattended turns, local-computer access, and questions still wait for you.`;
  } else if (asksWhenHeld) {
    summary = `${name} is set to full auto.${GAP}On runs this bot's turns in asking mode, so what it asks about is reviewed before it runs.${GAP}Steps it still takes without asking, such as file edits and messages to other bots, are checked as they start, and On stops the turn when the reviewer refuses one or cannot check it.${GAP}The stop is not instant, so a few more steps can run first.${GAP}Watch only records each step, and turns nobody started are watched, not held.${GAP}${who}`;
  } else {
    summary = `${name} runs its tools without asking first, so review can only watch.${GAP}Each step is checked as it starts, and On stops the turn when the reviewer refuses one or cannot check it.${GAP}The stop is not instant, so a few more steps can run first, and it cannot undo a step that already started.${GAP}${who}`;
  }

  return {
    ...base,
    hook: enforceHook,
    watchHook: nativeHook,
    canWatch: available,
    canEnforce: available,
    disabledReason,
    summary,
    bypassNote: bypassNote(bot, nativeHook, asksWhenHeld),
  };
}

function bypassNote(
  bot: Pick<Bot, "autoReview" | "bypassPermissions" | "autoApprove">,
  nativeHook: ReviewHook | "unknown",
  asksWhenHeld: boolean,
): string | null {
  if (!bot.bypassPermissions && !bot.autoApprove) return null;
  const which = bot.bypassPermissions ? "Bypass Permissions" : "Auto";
  const mode = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
  if (mode === "off") {
    return `${which} is on, so routine actions run without approval cards or review.`;
  }
  if (mode === "shadow") {
    return `${which} is on, so routine actions are approved at once.${GAP}Watch only records what the reviewer would have done.`;
  }
  if (nativeHook === "after" && !asksWhenHeld) {
    return `${which} does not change this engine, which never asks.${GAP}On still stops the turn when the reviewer refuses a step or cannot check it.`;
  }
  const screened = `${which} is on, but the reviewer still checks each approval first, and anything it refuses or cannot check comes back to you as a card.`;
  return nativeHook === "after"
    ? `${screened}${GAP}Steps taken without asking are checked as they start.`
    : screened;
}

export { DEFAULT_MAX_TOOL_ROUNDS };
