import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ROLE_TIERS, stateForBot, stateWithSpeech } from "./mascot";

describe("stateForBot role tiers", () => {
  it("matches the iOS app's tiers word for word and in order", () => {
    // A bot has to wear the same face on the phone as on the laptop, so the
    // Swift port may not add, drop or reorder a tier on its own.
    const swift = readFileSync(new URL("../../ios/App/MascotState.swift", import.meta.url), "utf8");
    const ios = [...swift.matchAll(/if matches\((\[[^\]]*\])\) \{ return \.(\w+) \}/g)].map(
      ([, words, state]) => [state, JSON.parse(words) as string[]],
    );
    expect(ios).toEqual(ROLE_TIERS.map(([state, words]) => [state, [...words]]));
  });

  it("matches whole words, including the full form of a role", () => {
    expect(stateForBot({ name: "Orchestrator" })).toBe("fleet");
    expect(stateForBot({ name: "Bot", title: "fleet orchestration" })).toBe("fleet");
    // A word that only contains a keyword is not a match.
    expect(stateForBot({ name: "Pricing analyst" })).toBe("idle");
  });

  it("lets the specific TV-Face tiers win over the general ones", () => {
    expect(stateForBot({ name: "Builder", description: "build and deploy" })).toBe("git");
    expect(stateForBot({ name: "UI designer" })).toBe("screen");
    expect(stateForBot({ name: "Coder", description: "writes software" })).toBe("working");
  });
});

describe("stateWithSpeech", () => {
  it("draws the bot that is speaking as speaking", () => {
    // The mouth moving is the thing a listener is watching, so the state
    // that says so wins over whatever else the bot happens to be doing.
    expect(stateWithSpeech("working", "a", "a")).toBe("speaking");
  });

  it("leaves the other bots alone", () => {
    // Only one voice plays at a time, so only that bot changes.
    expect(stateWithSpeech("working", "a", "b")).toBe("working");
  });

  it("keeps the state while no voice is playing", () => {
    // Nothing is audible yet, so there is no mouth to move.
    expect(stateWithSpeech("working", undefined, "a")).toBe("working");
  });

  it("keeps the state when the bot has no id to be named by", () => {
    // Without an id the speaker cannot say which bot is talking, so nothing
    // changes rather than every bot claiming to be the one speaking.
    expect(stateWithSpeech("working", "a", undefined)).toBe("working");
  });

  it("has no state of its own to give when the caller had none", () => {
    expect(stateWithSpeech(undefined, undefined, "a")).toBeUndefined();
  });

  it("draws a bot with no state of its own as speaking while it talks", () => {
    // The caller named no state, so the avatar is free to pick one, and the
    // mouth is the thing a listener is watching.  A bot that is speaking is
    // drawn as speaking whatever else it is doing, and having no state at
    // all is the least of what it is doing.
    expect(stateWithSpeech(undefined, "a", "a")).toBe("speaking");
  });
});
