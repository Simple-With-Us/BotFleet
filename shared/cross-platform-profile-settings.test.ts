import { describe, expect, it } from "vitest";

import {
  computerGrantRows,
  computersMacOnlyReason,
  effectiveSpeechDevices,
  speechDeviceDisabledReason,
  speechDeviceRow,
} from "./cross-platform-profile-settings";

describe("effectiveSpeechDevices", () => {
  it("prefers speechDevices over legacy speakReplies", () => {
    expect(effectiveSpeechDevices({ speakReplies: true, speechDevices: ["iphone"] })).toEqual(["iphone"]);
    expect(effectiveSpeechDevices({ speakReplies: true })).toEqual(["mac"]);
    expect(effectiveSpeechDevices({})).toEqual([]);
  });
});

describe("speechDeviceRow", () => {
  const bot = { voice: "standard-default", speechDevices: ["mac", "iphone"] as string[] };

  it("allows symmetric remote control for iPhone from Mac", () => {
    const row = speechDeviceRow("iphone", bot, {
      platform: "mac",
      voice: bot.voice,
      agentVoiceCanSpeakOnClient: true,
    });
    expect(row.editable).toBe(true);
    expect(row.selected).toBe(true);
  });

  it("keeps Mac playback editable on desktop when Personal Voice is allowed", () => {
    const row = speechDeviceRow("mac", { voice: "personal:pv-1", speechDevices: ["mac"] }, {
      platform: "mac",
      voice: "personal:pv-1",
      agentVoiceCanSpeakOnClient: true,
      personalVoicePlaybackAllowed: true,
    });
    expect(row.editable).toBe(true);
  });

  it("greys Mac playback on iOS for Personal Voice with a reason", () => {
    const personalBot = { voice: "personal:pv-1", speechDevices: ["mac"] as string[] };
    const row = speechDeviceRow("mac", personalBot, {
      platform: "ios",
      voice: personalBot.voice,
      agentVoiceCanSpeakOnClient: true,
    });
    expect(row.selected).toBe(true);
    expect(row.editable).toBe(false);
    expect(row.disabledReason).toMatch(/iPhone only/i);
  });

  it("blocks all devices when the agent voice cannot speak here", () => {
    const row = speechDeviceRow("iphone", { speechDevices: [] }, {
      platform: "ios",
      voice: "",
      agentVoiceCanSpeakOnClient: false,
    });
    expect(row.editable).toBe(false);
    expect(speechDeviceDisabledReason("iphone", {
      platform: "ios",
      voice: "",
      agentVoiceCanSpeakOnClient: false,
    })).toMatch(/Pick a voice/);
  });
});

describe("computerGrantRows", () => {
  it("marks every grant read-only on iOS with the Mac-only reason", () => {
    const rows = computerGrantRows({ computers: ["local", "cloud"] }, "ios");
    expect(rows.every((r) => !r.editable)).toBe(true);
    expect(rows.find((r) => r.id === "local")?.selected).toBe(true);
    expect(rows[0].disabledReason).toBe(computersMacOnlyReason());
  });

  it("keeps grants editable on Mac", () => {
    const rows = computerGrantRows({ computers: ["vm"] }, "mac");
    expect(rows.every((r) => r.editable)).toBe(true);
    expect(rows.find((r) => r.id === "vm")?.selected).toBe(true);
  });
});
