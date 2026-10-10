/// <reference types="vitest/config" />
import { describe, expect, it } from "vitest";

import { BOTFLEET_ROLES } from "./launch-identity.ts";
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

  it("covers exactly the ten BotFleet roles, none of them a platform seat or a Grok Bot tag", () => {
    expect([...FLEET_SEAT_IDS].sort()).toEqual([
      "builder",
      "compiler",
      "deployer",
      "designer",
      "fixer",
      "housekeeper",
      "monitor",
      "oracle",
      "plumber",
      "publisher",
    ]);
    for (const seatId of FLEET_SEAT_IDS) {
      const composed = composeFleetSeatPrompt(seatId);
      expect(composed, seatId).not.toMatch(/\[GB-/);
      expect(composed, seatId).not.toMatch(/\[(CLAUDE|CODEX|CURSOR|GROK|AG|MINIMAX|MM|MONET|PRODUCER)\]/);
    }
  });

  it("opens with the assigned seat, which overrides an engine's default seat", () => {
    for (const role of BOTFLEET_ROLES) {
      const composed = composeFleetSeatPrompt(role.id);
      // The seat sentence comes before the shared coordination text.
      expect(composed.indexOf(`Your fleet seat is ${role.seat}.`), role.id).toBeGreaterThanOrEqual(0);
      expect(composed.indexOf(role.seat), role.id).toBeLessThan(composed.indexOf(FLEET_SHARED_RULE_MARKERS[0]));
      expect(composed).toContain(`BotFleet role bot ${role.name}`);
      expect(composed).toContain("assigned that seat when it launched you");
      expect(composed).toMatch(/overrides any default seat named in your engine's own rules files, skills, or memory/);
      expect(composed).toContain(`AGENT_LAUNCH_SEAT variable in your environment is missing or is not ${role.seat}`);
      expect(composed).not.toMatch(/\{(seat|name)\}/);
      // Every other role's seat is absent, so a bot is never told two seats.
      for (const other of BOTFLEET_ROLES) {
        if (other.id !== role.id) expect(composed, `${role.id} names ${other.seat}`).not.toContain(other.seat);
      }
    }
  });

  it("reports byte counts for PR math", () => {
    const shared = fleetSharedPreambleBytes();
    expect(shared).toBeGreaterThan(900);
    expect(shared).toBeLessThan(2500);
    const composed = fleetComposedPromptBytes("plumber");
    expect(composed).toBeGreaterThan(shared);
    expect(legacyDuplicatedSharedBytesPerTurn(2)).toBe(shared);
  });

  it("resolves seat ids from @fleet-seat hints, BF- names, and bare role names", () => {
    expect(resolveFleetSeatId({ name: "BF-Plumber" })).toBe("plumber");
    expect(resolveFleetSeatId({ name: "BF Oracle", description: "@fleet-seat: oracle" })).toBe("oracle");
    expect(resolveFleetSeatId({ name: "Anything", description: "Keeps CI green.  @fleet-seat: bf-fixer" })).toBe("fixer");
    // The real bots are named for the role alone.
    expect(resolveFleetSeatId({ name: "Plumber" })).toBe("plumber");
    expect(resolveFleetSeatId({ name: " housekeeper " })).toBe("housekeeper");
    expect(resolveFleetSeatId({ name: "Kiwi" })).toBeNull();
    expect(resolveFleetSeatId({ name: "Plumber 2" })).toBeNull();
  });

  it("no longer maps a BF- bot to a platform seat or a Grok Bot tag", () => {
    for (const name of ["BF-Claude", "BF-Codex", "BF-Grok", "BF-Cursor", "BF-Director", "BF-Monet"]) {
      expect(resolveFleetSeatId({ name }), name).toBeNull();
    }
    expect(resolveFleetSeatId({ name: "Claude" })).toBeNull();
    expect(resolveFleetSeatId({ name: "Kiwi", description: "@fleet-seat: claude" })).toBeNull();
  });

  it("returns a prompt part only when the harness flag is on", () => {
    const prev = process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
    try {
      delete process.env.BOTFLEET_FLEET_SEAT_PROMPTS;
      expect(fleetSeatPromptsEnabled()).toBe(false);
      expect(fleetSeatPromptPart({ name: "BF-Plumber" })).toBeNull();
      process.env.BOTFLEET_FLEET_SEAT_PROMPTS = "1";
      expect(fleetSeatPromptsEnabled()).toBe(true);
      const part = fleetSeatPromptPart({ name: "Plumber" });
      expect(part?.seatId).toBe("plumber");
      expect(part?.text).toContain("Your fleet seat is BF-PLUMBER.");
      expect(part?.text).toContain("fleet Zulip coordination channel");
      // A bot that names no role gets no seat sentence, and no prompt at all.
      expect(fleetSeatPromptPart({ name: "Kiwi" })).toBeNull();
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
      expect(fleetSeatPromptPart({ name: "BF-Plumber" })).toBeNull();
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
  return `[${BOTFLEET_ROLES.find((role) => role.id === seatId)!.seat}]`;
}
