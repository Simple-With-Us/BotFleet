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

  it("renders Apple Personal Voice label and Mac / iOS helper note when configured on bot", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettings, {
        bot: sampleBot("personal:com.apple.speech.voice.Jay"),
        onPatch: () => {},
      })
    );

    expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay (On-device Mac / iOS)");
    expect(html).toContain("This bot uses an Apple Personal Voice.\u00A0 Synthesis runs on-device on your authorized Mac or iPhone.");
    // In plain environment without window.ogb.personalVoice.speak, the button explains device requirement
    expect(html).toContain("title=\"Personal Voices play on-device on a Mac or iPhone\"");
    expect(html).toContain("aria-label=\"Personal Voices play on-device on a Mac or iPhone\"");
  });

  it("enables Try button when desktop personalVoice speak bridge is available", () => {
    const origWindow = globalThis.window;
    try {
      globalThis.window = {
        ogb: {
          personalVoice: {
            speak: vi.fn(),
          } as unknown as NonNullable<Window["ogb"]>["personalVoice"],
        } as unknown as Window["ogb"],
      } as unknown as Window & typeof globalThis;
      const html = renderToStaticMarkup(
        createElement(VoiceSettings, {
          bot: sampleBot("personal:com.apple.speech.voice.Jay"),
          onPatch: () => {},
        })
      );
      expect(html).toContain("title=\"Hear this Apple Personal Voice\"");
      expect(html).toContain("aria-label=\"Hear this Apple Personal Voice\"");
    } finally {
      globalThis.window = origWindow;
    }
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

    expect(html).toContain("Voice Summary");
    expect(html).toContain("Benchmark Findings");
    expect(html).toContain("On-Demand");
    expect(html).toContain("All Messages");
    expect(html).toContain("Off");
  });
});

