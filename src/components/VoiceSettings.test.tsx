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
let mockCapabilitiesReady = true;
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
    ready: mockCapabilitiesReady,
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

  it("does not claim on-device synthesis when Personal Voice is off", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettings, {
        bot: sampleBot("personal:com.apple.speech.voice.Jay"),
        onPatch: () => {},
      })
    );

    // Gate is off (requires-macos-14). Naming on-device Mac / iOS is false.
    expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay");
    expect(html).not.toContain("On-device Mac / iOS");
    expect(html).not.toContain("Synthesis runs on-device on your authorized Mac or iPhone");
    expect(html).toContain("This bot uses an Apple Personal Voice.");
    expect(html).toContain("Personal Voices need macOS 14 or later, or an iPhone");
    // In plain environment without window.ogb.personalVoice.speak, the button explains device requirement
    expect(html).toContain("title=\"Personal Voices need macOS 14 or later, or an iPhone\"");
    expect(html).toContain("aria-label=\"Personal Voices need macOS 14 or later, or an iPhone\"");
    expect(html).not.toContain("Personal Voices play on-device on a Mac or iPhone");
  });

  it("names on-device Mac / iOS only when Personal Voice can speak", () => {
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
      expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay (On-device Mac / iOS)");
      expect(html).toContain("This bot uses an Apple Personal Voice.\u00A0 Synthesis runs on-device on your authorized Mac or iPhone.");
    } finally {
      mockPersonalVoice = false;
      globalThis.window = origWindow;
    }
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

  it("keeps the on-device option label while capabilities are still unknown", () => {
    mockPersonalVoice = false;
    mockCapabilitiesReady = false;
    try {
      const html = renderToStaticMarkup(
        createElement(VoiceSettings, {
          bot: sampleBot("personal:com.apple.speech.voice.Jay"),
          onPatch: () => {},
        })
      );
      // Optimistic personalVoice:false is not a denial. The suffix stays
      // until capabilities confirm this computer cannot speak one.
      expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay (On-device Mac / iOS)");
      expect(html).toContain("Checking Personal Voice availability");
      expect(html).not.toContain("Personal Voices need macOS 14 or later, or an iPhone");
    } finally {
      mockPersonalVoice = false;
      mockCapabilitiesReady = true;
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
    // Listing must wait on the macOS 14 Personal Voice gate, not appleSpeech alone.
    expect(loader).toContain("personalVoiceAllowedRef.current");
    expect(loader).toContain("allowPersonal && window.ogb?.personalVoice?.list");
    expect(loader.match(/if \(requestId !== loadRequestRef\.current\) return;/g)).toHaveLength(2);
    expect(loader).toContain("if (requestId === loadRequestRef.current) setLoadingVoices(false);");
    expect(SRC).toContain("capabilities.dictation.personalVoice === true");
    expect(SRC).toContain("if (isPersonalVoice(next) && !personalVoiceAllowed)");
    expect(SRC).toContain("if (capabilitiesReady) setError(personalVoiceDisabledReason);");
    // On-device suffix is omitted only after a confirmed denial, not while
    // capabilities are still the optimistic personalVoice:false.
    expect(SRC).toContain("capabilitiesReady && !personalVoiceAllowed");
  });

  it("has the mount effect call that loader instead of fetching on its own", () => {
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*void loadVoices\(\);\s*\}, \[configured, personalVoiceAllowed\]\);/);
    // A second, effect-local fetch is exactly what dropped the personal entries.
    expect(SRC.match(/api\("\/api\/tts\/voices"\)/g)).toHaveLength(1);
  });
});


/**
 * A typed custom id and a clone result used to call onPatch directly.
 * Either id can start with personal: or apple-personal:, which the server
 * treats as Personal Voice and then refuses to synthesize. Those saves have
 * to take the same refusal as the picker.
 */
describe("VoiceSettings personal voice selection guard", () => {
  const SRC = readFileSync(join(__dirname, "VoiceSettings.tsx"), "utf8");
  const between = (start: string, end: string) => {
    const from = SRC.indexOf(start);
    const to = SRC.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`missing slice ${start} -> ${end}`);
    return SRC.slice(from, to);
  };

  it("routes add and clone through the select guard", () => {
    const guard = between("const commitVoice", "const loadVoices");
    const add = between("const handleAddCustomVoice", "const handleDeleteVoice");
    const clone = between("const handleClone =", "if (!tts) return null");

    expect(guard).toContain("if (isPersonalVoice(next) && !personalVoiceAllowed)");
    expect(guard).toContain("if (capabilitiesReady) setError(personalVoiceDisabledReason);");
    expect(guard).toContain("onPatch({ voice: next })");

    expect(add).toContain("commitVoice(res.voice.id)");
    expect(add).not.toContain("onPatch(");
    expect(clone).toContain("commitVoice(result.voiceId)");
    expect(clone).not.toContain("onPatch(");
    expect(SRC).toContain("commitVoice(e.target.value)");

    // Clearing a deleted voice is not a Personal Voice selection.
    expect(SRC.match(/onPatch\(\{ voice: [^}]+\}\)/g)).toEqual([
      "onPatch({ voice: next })",
      'onPatch({ voice: "" })',
    ]);
  });
});
