// The Maximum Tool Rounds gate: when the control is shown, when it is
// editable, and what it says.
//
// The bug these pin: the panel asked `engine?.capabilities?.toolLoop === true`
// inline, where `undefined` — an instance list that has not answered yet, or an
// engine the client has never heard of — collapsed to "this engine cannot use
// the setting".  So the control vanished for most bots, and a ceiling saved on
// a tool-loop engine became invisible and un-clearable the moment the bot
// switched to a CLI engine.  "Only a couple of bots have the setting" was the
// symptom; the cause was an unanswered question being read as a "no".
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS,
  toolRoundsCaption,
} from "../../shared/bot-profile";
import {
  activeEngine,
  autoReviewGate,
  botCapabilityGates,
  configuredEngine,
  honorsToolRounds,
  reviewerOptions,
  toolRoundsGate,
} from "./bot-settings-gates";
import type { Bot, InstanceInfo, ModelSelection } from "@/state/store";

const selection = (instanceId: string, model = "m"): ModelSelection => ({ instanceId, model });

/** Only the fields these gates read, so a test cannot pass by accident on
 *  something unrelated the real `InstanceInfo` also carries. */
function instance(
  instanceId: string,
  capabilities: Partial<NonNullable<InstanceInfo["capabilities"]>> = {},
  extra: { driverKind?: string; displayName?: string; state?: "available" | "unavailable" } = {},
): InstanceInfo {
  return {
    instanceId,
    driverKind: extra.driverKind ?? "openai-compat",
    displayName: extra.displayName ?? instanceId,
    snapshot: { state: extra.state ?? "available" },
    capabilities: {
      computerMcp: false,
      agentsMcp: false,
      localComputerMcp: false,
      toolLoop: false,
      ...capabilities,
    },
  } as InstanceInfo;
}

const TOOL_LOOP = instance("minimax", { toolLoop: true, agentsMcp: true }, { displayName: "MiniMax" });
const CLI = instance("claude", { toolLoop: false, agentsMcp: true }, { displayName: "Claude Code" });

describe("the default is one number, said once", () => {
  it("the caption a person reads is built from the real constants", () => {
    expect(toolRoundsCaption()).toBe(
      `Per turn.  Empty uses ${DEFAULT_MAX_TOOL_ROUNDS}.  Cap is ${MAX_TOOL_ROUNDS}.`,
    );
  });

  it("no longer claims 12 — that was the number the loop stopped at, not the one in force", () => {
    // Kept as an explicit regression: the copy, the prompt and the hard stop
    // were three separate literals and they drifted apart.
    expect(toolRoundsCaption()).not.toContain("Empty uses 12.");
  });
});

describe("which engine the gates describe", () => {
  it("is the CONFIGURED engine, not the one a fallback last ran on", () => {
    const bot = {
      modelSelection: selection("minimax"),
      activeModelSelection: selection("claude"),
      maxToolRounds: null,
    };
    expect(configuredEngine([TOOL_LOOP, CLI], bot)?.instanceId).toBe("minimax");
    expect(honorsToolRounds(configuredEngine([TOOL_LOOP, CLI], bot))).toBe(true);
  });

  it("reports the rollover so the panel can say a different engine is running", () => {
    const { engine, rolledOver } = activeEngine([TOOL_LOOP, CLI], {
      modelSelection: selection("minimax"),
      activeModelSelection: selection("claude"),
    });
    expect(rolledOver).toBe(true);
    expect(engine?.instanceId).toBe("claude");
  });

  it("is not a rollover when the active engine matches the configured one", () => {
    const { rolledOver } = activeEngine([TOOL_LOOP], {
      modelSelection: selection("minimax"),
      activeModelSelection: selection("minimax"),
    });
    expect(rolledOver).toBe(false);
  });
});

describe("toolRoundsGate", () => {
  it("is visible and editable on a tool-loop engine", () => {
    const gate = toolRoundsGate([TOOL_LOOP], {
      modelSelection: selection("minimax"),
      maxToolRounds: null,
    });
    expect(gate.visible).toBe(true);
    expect(gate.editable).toBe(true);
    expect(gate.note).toBeNull();
  });

  it("is hidden on a CLI engine when nothing is saved — nothing to say, nothing to set", () => {
    const gate = toolRoundsGate([CLI], {
      modelSelection: selection("claude"),
      maxToolRounds: null,
    });
    expect(gate.visible).toBe(false);
  });

  it("STAYS VISIBLE but read-only when a value is saved on an engine that ignores it", () => {
    // The regression: this value used to become invisible and un-clearable.
    const gate = toolRoundsGate([CLI], {
      modelSelection: selection("claude"),
      maxToolRounds: 40,
    });
    expect(gate.visible).toBe(true);
    expect(gate.editable).toBe(false);
    expect(gate.note).toContain("Claude Code");
    expect(gate.note).toContain("runs its own tool loop");
    expect(gate.note).toContain("Clear it to stop carrying it");
  });

  it("names the engine actually running when a fallback moved off the configured one", () => {
    const gate = toolRoundsGate([TOOL_LOOP, CLI], {
      modelSelection: selection("claude"),
      activeModelSelection: selection("minimax"),
      maxToolRounds: 20,
    });
    expect(gate.editable).toBe(false);
    expect(gate.note).toContain("Claude Code");
    expect(gate.note).toContain("MiniMax");
  });

  it("does not answer 'no' for an engine it has never heard of", () => {
    // Instances still loading, or an engine the client does not know.  We must
    // not claim the setting is inapplicable on an unanswered lookup.
    const gate = toolRoundsGate([], {
      modelSelection: selection("some-new-engine"),
      maxToolRounds: 25,
    });
    expect(gate.visible).toBe(true);
    expect(gate.editable).toBe(false);
    expect(gate.note).toContain("has not reported its capabilities yet");
  });

  it("treats 0 and null as 'nothing saved' rather than a value to preserve", () => {
    for (const saved of [null, undefined]) {
      const gate = toolRoundsGate([CLI], {
        modelSelection: selection("claude"),
        maxToolRounds: saved,
      });
      expect(gate.visible, String(saved)).toBe(false);
    }
  });
});

describe("botCapabilityGates reads the engine once for the whole panel", () => {
  it("maps each capability off the same engine", () => {
    const rich = instance("grok", {
      toolLoop: true,
      agentsMcp: true,
      composioMcp: true,
      computerMcp: true,
      approvalReview: true,
    });
    const gates = botCapabilityGates([rich], { modelSelection: selection("grok") });
    expect(gates).toMatchObject({
      canCoordinate: true,
      canAutoReview: true,
      canUseConnectedApps: true,
      canUseVps: true,
      toolLoop: true,
    });
  });

  it("withholds the VPS destination from a boxAgent even when it declares computerMcp", () => {
    const box = instance("box", { computerMcp: true }, { driverKind: "boxAgent" });
    const gates = botCapabilityGates([box], { modelSelection: selection("box") });
    expect(gates.canUseVps).toBe(false);
  });

  it("reports every capability false for an engine it cannot find", () => {
    const gates = botCapabilityGates([], { modelSelection: selection("ghost") });
    expect(gates.engine).toBeUndefined();
    expect(gates.canCoordinate).toBe(false);
    expect(gates.canAutoReview).toBe(false);
    expect(gates.canUseConnectedApps).toBe(false);
    expect(gates.canUseVps).toBe(false);
    expect(gates.toolLoop).toBe(false);
  });
});

// Auto-review used to be greyed out with "This engine cannot run an isolated
// review safely" on every engine but Claude.  The owner asked for it to work
// everywhere; these pin what each kind of engine is offered and what it is
// told.
describe("autoReviewGate: auto-review on every engine", () => {
  const CLAUDE = instance("claude", { approvalReview: true, reviewHook: "before", asksWhenHeld: true }, { displayName: "Claude Code" });
  const CODEX = instance("codex", { reviewHook: "before", asksWhenHeld: true }, { displayName: "Codex" });
  const CODEX_AUTO = instance("codex-auto", { reviewHook: "after", asksWhenHeld: true }, { displayName: "Codex Full Auto" });
  const AGY = instance("agy", { reviewHook: "after" }, { displayName: "Antigravity" });
  const WRAPPER = instance("wrap", { reviewHook: "none" }, { displayName: "CLI Wrapper" });
  const COMPAT = instance("compat", { approvalReview: true, reviewHook: "before" }, { displayName: "OpenRouter" });
  const bot = (instanceId: string, patch: Partial<Pick<Bot, "autoReview" | "bypassPermissions">> = {}) => ({
    modelSelection: selection(instanceId),
    ...patch,
  });
  const all = [CLAUDE, CODEX, CODEX_AUTO, AGY, WRAPPER, COMPAT];
  const NBSP_GAP = /\.  [A-Z]/;

  it("an engine that reviews itself is reviewed before each ask, by itself", () => {
    const gate = autoReviewGate(all, bot("claude"), null);
    expect(gate).toMatchObject({ hook: "before", canWatch: true, canEnforce: true, needsFallback: false });
    expect(gate.reviewer).toEqual({ instanceId: "claude", name: "Claude Code", role: "own" });
    expect(gate.summary).toContain("reviewed before it runs");
  });

  it("an engine that cannot review itself is greyed out only until a fallback reviewer is chosen", () => {
    const without = autoReviewGate(all, bot("codex"), null);
    expect(without).toMatchObject({ canWatch: false, canEnforce: false, needsFallback: true, reviewer: null });
    expect(without.disabledReason).toContain("Choose a fallback reviewer");
    expect(without.fallbackOptions.map((option) => option.instanceId)).toEqual(["claude", "compat"]);

    const withFallback = autoReviewGate(all, bot("codex"), "compat");
    expect(withFallback).toMatchObject({ hook: "before", canWatch: true, canEnforce: true, disabledReason: null });
    expect(withFallback.reviewer).toEqual({ instanceId: "compat", name: "OpenRouter", role: "fallback" });
    expect(withFallback.summary).toContain("OpenRouter reviews for it");
    expect(withFallback.summary).toMatch(NBSP_GAP);
  });

  it("a full-auto instance that can ask is held under On and only watched under Watch", () => {
    const gate = autoReviewGate(all, bot("codex-auto"), "claude");
    expect(gate.hook).toBe("before");
    expect(gate.watchHook).toBe("after");
    expect(gate.summary).toContain("asking mode");
    expect(gate.hints.enforce).toBe("Answer only reviews that return a strict approval.");
  });

  it("an engine with no hook can only watch, and On says it stops the turn rather than holding anything", () => {
    const gate = autoReviewGate(all, bot("agy"), "claude");
    expect(gate).toMatchObject({ hook: "after", watchHook: "after", canWatch: true, canEnforce: true });
    expect(gate.summary).toContain("can only watch");
    expect(gate.summary).toContain("cannot undo a step that already started");
    expect(gate.hints.enforce).toBe("Stop the turn when the reviewer refuses a step.");
  });

  it("an engine that reports no actions says so, whoever could review", () => {
    const gate = autoReviewGate(all, bot("wrap"), "claude");
    expect(gate).toMatchObject({ hook: "none", canWatch: false, canEnforce: false });
    expect(gate.disabledReason).toBe("CLI Wrapper reports no actions, so there is nothing to review.");
  });

  it("names the gap when nothing in the fleet can review", () => {
    const gate = autoReviewGate([CODEX], bot("codex"), null);
    expect(gate.disabledReason).toContain("no engine that can review is set up");
    expect(gate.fallbackOptions).toEqual([]);
  });

  it("ignores a fallback reviewer that is disabled, cannot review, or cannot run", () => {
    const disabled: InstanceInfo = { ...COMPAT, enabled: false };
    expect(autoReviewGate([CODEX, disabled], bot("codex"), "compat").reviewer).toBeNull();
    expect(autoReviewGate([CODEX, AGY], bot("codex"), "agy").reviewer).toBeNull();
    // a keyless API engine reports approvalReview but would fail every review
    const keyless = instance("minimax", { approvalReview: true, reviewHook: "before" }, { displayName: "MiniMax", state: "unavailable" });
    expect(reviewerOptions([CODEX, keyless])).toEqual([]);
    expect(autoReviewGate([CODEX, keyless], bot("codex"), "minimax").reviewer).toBeNull();
  });

  it("says when the fallback reviewer stands in for an engine that reviews itself", () => {
    const gate = autoReviewGate(all, bot("claude"), "compat");
    expect(gate.reviewer?.role).toBe("own");
    expect(gate.summary).toContain("OpenRouter stands in if that review fails");
  });

  it("an engine that has not reported yet keeps every mode open instead of reading as 'no'", () => {
    const gate = autoReviewGate([], bot("ghost", { autoReview: "enforce" }), null);
    expect(gate).toMatchObject({ hook: "unknown", canWatch: true, canEnforce: true, disabledReason: null });
    expect(gate.summary).toContain("has not reported");
  });

  it("states the Bypass Permissions rule for each mode", () => {
    expect(autoReviewGate(all, bot("claude"), null).bypassNote).toBeNull();
    expect(autoReviewGate(all, bot("claude", { bypassPermissions: true }), null).bypassNote).toContain("without approval cards or review");
    const screened = autoReviewGate(all, bot("claude", { bypassPermissions: true, autoReview: "enforce" }), null).bypassNote;
    expect(screened).toContain("the reviewer still checks each action first");
    expect(screened).toContain("comes back to you as a card");
    expect(screened).toMatch(NBSP_GAP);
    expect(autoReviewGate(all, bot("claude", { bypassPermissions: true, autoReview: "shadow" }), null).bypassNote).toContain(
      "Watch only records",
    );
    expect(autoReviewGate(all, bot("agy", { bypassPermissions: true, autoReview: "enforce" }), "claude").bypassNote).toContain(
      "stops the turn",
    );
  });

  it("never calls a bot an agent", () => {
    for (const engine of all) {
      for (const fallback of [null, "claude"]) {
        const gate = autoReviewGate(all, bot(engine.instanceId, { bypassPermissions: true, autoReview: "enforce" }), fallback);
        for (const text of [gate.summary, gate.disabledReason ?? "", gate.bypassNote ?? "", ...Object.values(gate.hints)]) {
          expect(text).not.toMatch(/\bagents?\b/i);
        }
      }
    }
  });
});
