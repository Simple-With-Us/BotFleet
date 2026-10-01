// Tests for VoiceSettings component covering Apple Personal Voice display.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const baseTts: NonNullable<ConfigStatus["tts"]> = {
  provider: "minimax",
  configured: true,
  ready: true,
  voice: "standard-default",
};

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        config: {
          tts: baseTts,
        },
      },
      dispatch: vi.fn(),
      api: vi.fn().mockResolvedValue({}),
      reloadConfig: vi.fn(),
    }),
  };
});

import { VoiceSettings } from "./VoiceSettings";
import type { Bot, ConfigStatus } from "@/state/store";

describe("VoiceSettings", () => {
  const sampleBot = (voice?: string): Bot => ({
    id: "bot-1",
    name: "Assistant",
    threadId: "t1",
    voice,
  } as unknown as Bot);

  it("renders Apple Personal Voice label and iOS helper note when configured on bot", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettings, {
        bot: sampleBot("personal:com.apple.speech.voice.Jay"),
        onPatch: () => {},
      })
    );

    expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay (On-device iOS)");
    expect(html).toContain("This bot uses an Apple Personal Voice on iOS.  Synthesis runs on-device on your authorized iPhone.");
    expect(html).toContain("title=\"Personal Voices play on-device on iOS\"");
  });

  it("renders standard current voice for non-personal custom voice", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettings, {
        bot: sampleBot("custom-voice-id"),
        onPatch: () => {},
      })
    );

    expect(html).toContain("custom-voice-id (Current)");
    expect(html).not.toContain("Apple Personal Voice");
  });

  it("renders voice summary mode options and benchmark findings button", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettings, {
        bot: sampleBot("voice-1"),
        onPatch: () => {},
      })
    );

    expect(html).toContain("Voice Summary (DeepSeek V4.1 Flash)");
    expect(html).toContain("View Benchmark Findings");
    expect(html).toContain("On-Demand");
    expect(html).toContain("All Messages");
    expect(html).toContain("Off");
  });
});

