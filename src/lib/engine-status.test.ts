// Engine states that must not read as setup problems: a probe that did not
// answer in time is "Checking", and a Mac whose engines are only being
// re-checked is not an empty one.
import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { isCheckingEngine, isHiddenEngine, listedInEnginesSettings, noEngineCanRun } from "./engine-status";

const snap = (snapshot: InstanceInfo["snapshot"]) => ({ snapshot });

describe("isCheckingEngine / isHiddenEngine", () => {
  it("reads the snapshot flags and nothing else", () => {
    expect(isCheckingEngine(snap({ state: "unavailable", transient: true, reason: "Claude did not answer in time" }))).toBe(true);
    expect(isCheckingEngine(snap({ state: "unavailable", reason: "`claude` CLI not found" }))).toBe(false);
    expect(isCheckingEngine(undefined)).toBe(false);
    expect(isHiddenEngine(snap({ state: "unavailable", hidden: true, reason: "no Box token" }))).toBe(true);
    expect(isHiddenEngine(snap({ state: "available" }))).toBe(false);
  });
});

describe("noEngineCanRun", () => {
  it("is false before the first answer (an empty list means not asked yet)", () => {
    expect(noEngineCanRun([])).toBe(false);
  });

  it("is true only when every engine answered and none is available", () => {
    expect(
      noEngineCanRun([
        snap({ state: "unavailable", reason: "`claude` CLI not found" }),
        snap({ state: "unavailable", reason: "`codex` CLI not found" }),
      ]),
    ).toBe(true);
  });

  it("is false when one engine is available", () => {
    expect(
      noEngineCanRun([
        snap({ state: "unavailable", reason: "`claude` CLI not found" }),
        snap({ state: "available", version: "0.159.2" }),
      ]),
    ).toBe(false);
  });

  it("does not show the install screen while an engine is only being re-checked", () => {
    expect(
      noEngineCanRun([
        snap({ state: "unavailable", transient: true, reason: "Claude did not answer in time" }),
        snap({ state: "unavailable", reason: "`codex` CLI not found" }),
      ]),
    ).toBe(false);
  });
});

describe("listedInEnginesSettings", () => {
  it("lists CLI, MiniMax, OpenAI-compatible and custom engines", () => {
    expect(listedInEnginesSettings({ driverKind: "claudeAgent", cliDefault: "claude", snapshot: { state: "available" } })).toBe(true);
    expect(listedInEnginesSettings({ driverKind: "minimax", snapshot: { state: "available" } })).toBe(true);
    expect(listedInEnginesSettings({ driverKind: "openai-compat", snapshot: { state: "available" } })).toBe(true);
    expect(listedInEnginesSettings({ driverKind: "acpAgent", isCustom: true, snapshot: { state: "available" } })).toBe(true);
    expect(listedInEnginesSettings({ driverKind: "grok", snapshot: { state: "available" } })).toBe(false);
  });

  it("leaves out the ASCII.dev Box engine until a Box token is set up", () => {
    const box = { driverKind: "boxAgent", cliDefault: "box", snapshot: { state: "unavailable", hidden: true, reason: "no Box token" } } as const;
    expect(listedInEnginesSettings(box)).toBe(false);
    expect(listedInEnginesSettings({ ...box, snapshot: { state: "available" } })).toBe(true);
  });
});
