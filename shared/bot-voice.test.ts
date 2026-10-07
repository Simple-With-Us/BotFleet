// The TypeScript half of the per-device voice parity check.  The cases live
// in the iOS fixture folder (already copied into the Swift test bundle by
// ios/Package.swift) so `swift test` and vitest read the same bytes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isPersonalVoiceId, isSpeechDevice, mergeBotVoices, voiceForDevice, type BotVoicesPatch, type SpeechDevice } from "./bot-voice.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = join(ROOT, "ios", "Tests", "CompanionCoreTests", "Fixtures", "bot-voice.json");

type Fixture = {
  voiceForDevice: Array<{
    name: string;
    bot: { voice?: string | null; voices?: { mac?: string | null; iphone?: string | null } | null };
    device: SpeechDevice;
    expected: string | null;
  }>;
  isPersonalVoiceId: Array<{ id: string | null; expected: boolean }>;
  mergeVoices: Array<{
    name: string;
    existing: { mac?: string; iphone?: string } | null;
    patch: BotVoicesPatch;
    expected: { mac?: string; iphone?: string } | null;
  }>;
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

describe("bot-voice parity fixture", () => {
  it("has cases for every rule", () => {
    expect(fixture.voiceForDevice.length).toBeGreaterThan(10);
    expect(fixture.isPersonalVoiceId.length).toBeGreaterThan(5);
    expect(fixture.mergeVoices.length).toBeGreaterThan(5);
  });

  for (const testCase of fixture.voiceForDevice) {
    it(`voiceForDevice: ${testCase.name}`, () => {
      expect(voiceForDevice(testCase.bot, testCase.device) ?? null).toBe(testCase.expected);
    });
  }

  for (const testCase of fixture.isPersonalVoiceId) {
    it(`isPersonalVoiceId(${JSON.stringify(testCase.id)})`, () => {
      expect(isPersonalVoiceId(testCase.id)).toBe(testCase.expected);
    });
  }

  for (const testCase of fixture.mergeVoices) {
    it(`mergeBotVoices: ${testCase.name}`, () => {
      expect(mergeBotVoices(testCase.existing, testCase.patch) ?? null).toEqual(testCase.expected);
    });
  }
});

describe("bot-voice helpers", () => {
  it("resolves nothing for a missing bot", () => {
    expect(voiceForDevice(undefined, "mac")).toBeUndefined();
    expect(voiceForDevice(null, "iphone")).toBeUndefined();
  });

  it("recognizes only the two speech devices", () => {
    expect(isSpeechDevice("mac")).toBe(true);
    expect(isSpeechDevice("iphone")).toBe(true);
    for (const value of ["ipad", "Mac", "", null, undefined]) expect(isSpeechDevice(value)).toBe(false);
  });

  it("does not mutate the stored record when merging", () => {
    const existing = { mac: "personal:m" };
    mergeBotVoices(existing, { iphone: "vx" });
    expect(existing).toEqual({ mac: "personal:m" });
  });
});
