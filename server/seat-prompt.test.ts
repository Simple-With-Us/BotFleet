/// <reference types="vitest/config" />
import { describe, expect, it } from "vitest";

import {
  composeFleetSeatPrompt,
  countMarker,
  FLEET_SEAT_IDS,
  FLEET_SHARED_RULE_MARKERS,
  fleetComposedPromptBytes,
  fleetSeatPromptPart,
  fleetSeatPromptsEnabled,
  fleetSharedPreambleBytes,
  legacyDuplicatedSharedBytesPerTurn,
  resetFleetSeatPromptCacheForTests,
  resolveFleetSeatId,
  type FleetSeatId,
} from "./seat-prompt.ts";

describe("fleet seat prompt composition", () => {
  it("loads every seat file with each shared rule exactly once", () => {
    for (const seatId of FLEET_SEAT_IDS) {
      const composed = composeFleetSeatPrompt(seatId);
      for (const marker of FLEET_SHARED_RULE_MARKERS) {
        expect(countMarker(composed, marker), `${seatId} → ${marker}`).toBe(1);
      }
      expect(composed).toContain(seatTag(seatId));
    }
  });

  it("reports byte counts for PR math", () => {
    const shared = fleetSharedPreambleBytes();
    expect(shared).toBeGreaterThan(900);
    expect(shared).toBeLessThan(2500);
    const composed = fleetComposedPromptBytes("cursor");
    expect(composed).toBeGreaterThan(shared);
    expect(legacyDuplicatedSharedBytesPerTurn(2)).toBe(shared);
  });

  it("resolves seat ids from BF- names and @fleet-seat hints", () => {
    expect(resolveFleetSeatId({ name: "BF-Claude" })).toBe("claude");
    expect(resolveFleetSeatId({ name: "BF Oracle", description: "@fleet-seat: oracle" })).toBe("oracle");
    expect(resolveFleetSeatId({ name: "Kiwi" })).toBeNull();
  });

  it("returns a prompt part only when the harness flag is on", () => {
    const prev = process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
    try {
      delete process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
      expect(fleetSeatPromptsEnabled()).toBe(false);
      expect(fleetSeatPromptPart({ name: "BF-Grok" })).toBeNull();
      process.env.BOTFLEET_FLEET_SEAT_PROMPTS = "1";
      expect(fleetSeatPromptsEnabled()).toBe(true);
      const part = fleetSeatPromptPart({ name: "BF-Grok" });
      expect(part?.seatId).toBe("grok");
      expect(part?.text).toContain("fleet Slack coordination channel");
      for (const marker of FLEET_SHARED_RULE_MARKERS) {
        expect(countMarker(part!.text, marker)).toBe(1);
      }
    } finally {
      if (prev === undefined) delete process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
      else process.env.BOTFLEET_FLEET_SEAT_PROMPTS = prev;
      resetFleetSeatPromptCacheForTests();
    }
  });

  it("returns null when seat assets are missing instead of crashing the turn", () => {
    const prevFlag = process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
    const prevDir = process.env.OMB_BOTS_DIR;
    try {
      process.env.BOTFLEET_FLEET_SEAT_PROMPTS = "1";
      process.env.OMB_BOTS_DIR = "/nonexistent/bots-root";
      resetFleetSeatPromptCacheForTests();
      expect(fleetSeatPromptPart({ name: "BF-Grok" })).toBeNull();
    } finally {
      if (prevFlag === undefined) delete process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
      else process.env.BOTFLEET_FLEET_SEAT_PROMPTS = prevFlag;
      if (prevDir === undefined) delete process.env.OMB_BOTS_DIR;
      else process.env.OMB_BOTS_DIR = prevDir;
      resetFleetSeatPromptCacheForTests();
    }
  });
});

function seatTag(seatId: FleetSeatId): string {
  switch (seatId) {
    case "claude":
      return "[CLAUDE]";
    case "cursor":
      return "[CURSOR]";
    case "grok":
      return "[GROK]";
    case "codex":
      return "[CODEX]";
    case "ag":
      return "[AG]";
    case "minimax":
      return "[MINIMAX]";
    case "monet":
      return "[MONET]";
    case "producer":
      return "[PRODUCER]";
    case "oracle":
      return "[GB-ORACLE]";
    case "deployer":
      return "[GB-DEPLOYER]";
    case "fixer":
      return "[GB-FIXER]";
    default: {
      const _exhaustive: never = seatId;
      return _exhaustive;
    }
  }
}
