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
  botCapabilityGates,
  configuredEngine,
  honorsToolRounds,
  toolRoundsGate,
} from "./bot-settings-gates";
import type { InstanceInfo, ModelSelection } from "@/state/store";

const selection = (instanceId: string, model = "m"): ModelSelection => ({ instanceId, model });

/** Only the fields these gates read, so a test cannot pass by accident on
 *  something unrelated the real `InstanceInfo` also carries. */
function instance(
  instanceId: string,
  capabilities: Partial<NonNullable<InstanceInfo["capabilities"]>> = {},
  extra: { driverKind?: string; displayName?: string } = {},
): InstanceInfo {
  return {
    instanceId,
    driverKind: extra.driverKind ?? "openai-compat",
    displayName: extra.displayName ?? instanceId,
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
