// Tests for VoiceSettings component covering Apple Personal Voice display.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

let mockPersonalVoice = false;
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "darwin", label: "macOS", session: "desktop", packaged: true },
      windowChrome: "mac-inset",
      screenPreview: { available: false, interaction: "none" },
      dictation: {
        available: true,
        engine: "apple-speech",
        onDevice: true,
        personalVoice: mockPersonalVoice,
        // A Mac that cannot speak Personal Voice is the version gate, not
        // "not a Mac".  The disabled control has to read that code.
        reasonCode: mockPersonalVoice ? undefined : "requires-macos-14",
      },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
    ready: true,
  }),
}));

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
    expect(html).toContain("title=\"Personal Voices need macOS 14 or later, or an iPhone\"");
    expect(html).toContain("aria-label=\"Personal Voices need macOS 14 or later, or an iPhone\"");
    expect(html).not.toContain("Personal Voices play on-device on a Mac or iPhone");
  });

  it("enables Try button when desktop personalVoice speak bridge is available", () => {
    mockPersonalVoice = true;
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
      mockPersonalVoice = false;
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

/**
 * The Personal Voice merge used to live only in the mount effect, while
 * `loadVoices()` — the path every add / clone / delete / key-save refresh
 * takes — overwrote the list with the harness voices alone. Those handlers
 * change `bot.voice` and credentials but not `tts.configured`, so the effect
 * never re-ran and the user's Personal Voices vanished from the picker until
 * the tab was unmounted.
 *
 * Pinned at the source because the merge is a data-flow property of one
 * loader, not of any rendered output; the same reasoning as `CallView.test.ts`.
 */
describe("VoiceSettings voice loading", () => {
  const SRC = readFileSync(join(__dirname, "VoiceSettings.tsx"), "utf8");

  it("performs the Personal Voice merge in the shared loader, not the effect", () => {
    const loader = SRC.slice(SRC.indexOf("const loadVoices"), SRC.indexOf("useEffect", SRC.indexOf("const loadVoices")));
    expect(loader).toContain("parsePersonalVoiceList(personal)");
    expect(loader).toContain("parseTtsVoicesResponse(raw)");
    expect(loader).toContain("setVoices([...personalEntries, ...apiVoices])");
  });

  it("has the mount effect call that loader instead of fetching on its own", () => {
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*void loadVoices\(\);\s*\}, \[configured\]\);/);
    // A second, effect-local fetch is exactly what dropped the personal entries.
    expect(SRC.match(/api\("\/api\/tts\/voices"\)/g)).toHaveLength(1);
  });
});

