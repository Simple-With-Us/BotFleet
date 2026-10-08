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
import { personalVoiceDesktopBridge } from "./VoiceSettingsVisualFixture";
import type { Bot, ConfigStatus } from "@/state/store";

describe("VoiceSettings", () => {
  // A current harness always sends `voices` (null when unset).
  const sampleBot = (voice?: string, voices: Bot["voices"] = null): Bot => ({
    id: "bot-1",
    name: "Assistant",
    threadId: "t1",
    title: "",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "fixture", model: "default" },
    messages: [],
    voice,
    voices,
  });

  const render = (bot: Bot) => renderToStaticMarkup(createElement(VoiceSettings, { bot, onPatch: () => {} }));

  it("shows a picker for this Mac and one for the iPhone", () => {
    const html = render(sampleBot("voice-1"));
    expect(html).toContain("Voice on This Mac");
    expect(html).toContain("Voice on iPhone");
    expect(html).toContain("aria-label=\"Assistant&#x27;s voice on this Mac\"");
    expect(html).toContain("aria-label=\"Assistant&#x27;s voice on iPhone\"");
    // Neither device has its own choice, so both offer the shared voice.
    expect(html.match(/voice-1 \(bot default\)/g)).toHaveLength(2);
  });

  it("does not claim on-device synthesis when Personal Voice is off", () => {
    const html = render(sampleBot(undefined, { mac: "personal:com.apple.speech.voice.Jay" }));

    // Gate is off (requires-macos-14).  Naming on-device playback is false.
    expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay");
    expect(html).not.toContain("It plays on-device on this Mac");
    expect(html).toContain("This bot uses an Apple Personal Voice.");
    expect(html).toContain("Personal Voices need macOS 14 or later, or an iPhone");
    // In plain environment without window.ogb.personalVoice.speak, the button explains device requirement
    expect(html).toContain("title=\"Personal Voices need macOS 14 or later, or an iPhone\"");
    expect(html).toContain("aria-label=\"Personal Voices need macOS 14 or later, or an iPhone\"");
    expect(html).not.toContain("Personal Voices play on-device on a Mac or iPhone");
  });

  it("says the Mac's Personal Voice plays here only when Personal Voice can speak", () => {
    mockPersonalVoice = true;
    try {
      vi.stubGlobal("window", {
        ogb: personalVoiceDesktopBridge({ speak: () => Promise.resolve() }),
      });
      const html = render(sampleBot(undefined, { mac: "personal:com.apple.speech.voice.Jay" }));
      expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay");
      expect(html).toContain("This bot uses an Apple Personal Voice.\u00A0 It plays on-device on this Mac.");
      expect(html).toContain("title=\"Hear this Apple Personal Voice\"");
      expect(html).toContain("aria-label=\"Hear this Apple Personal Voice\"");
    } finally {
      mockPersonalVoice = false;
      vi.unstubAllGlobals();
    }
  });

  it("does not claim on-device while capabilities are still unknown", () => {
    mockPersonalVoice = false;
    mockCapabilitiesReady = false;
    try {
      const html = render(sampleBot(undefined, { mac: "personal:com.apple.speech.voice.Jay" }));
      // Optimistic personalVoice:false is not a confirmed denial, and it is
      // also not permission.  The checking sentence shows instead.
      expect(html).toContain("Apple Personal Voice: com.apple.speech.voice.Jay");
      expect(html).not.toContain("It plays on-device on this Mac");
      expect(html).toContain("Checking Personal Voice availability");
      expect(html).not.toContain("Personal Voices need macOS 14 or later, or an iPhone");
    } finally {
      mockPersonalVoice = false;
      mockCapabilitiesReady = true;
    }
  });

  it("renders a device's own hosted voice that the list does not have as current", () => {
    const html = render(sampleBot(undefined, { mac: "custom-voice-id", iphone: "phone-voice-id" }));

    expect(html).toContain("custom-voice-id (Current)");
    expect(html).toContain("phone-voice-id (Current)");
    expect(html).not.toContain("Apple Personal Voice:");
  });

  it("shows the iPhone's Personal Voice greyed with the reason, not as a choice", () => {
    const html = render(sampleBot(undefined, { iphone: "personal:iphone-voice" }));
    expect(html).toContain("Personal Voice from your iPhone.\u00A0 Choose it on the iPhone.");
    expect(html).toMatch(/<option value="personal:iphone-voice" disabled="" selected="">Personal Voice from your iPhone<\/option>/);
    // Its Try is off: the Mac cannot speak the iPhone's Personal Voice.
    expect(html).toContain("title=\"Personal Voice from your iPhone.\u00A0 Choose it on the iPhone.\"");
    // The Mac picker is unaffected: it still offers the shared voice.
    expect(html).toContain("standard-default (default)");
  });

  it("names an iPhone falling back to a shared Personal Voice as the iPhone's", () => {
    const html = render(sampleBot("personal:shared-voice"));
    expect(html).toContain("Personal Voice from your iPhone (bot default)");
    expect(html).toContain("Personal Voice from your iPhone.\u00A0 Choose it on the iPhone.");
  });

  it("renders the spoken text options with Read As Written as the default", () => {
    const html = render(sampleBot("voice-1"));

    expect(html).toContain("Spoken Text");
    expect(html).toContain("Benchmark Findings");
    expect(html).toContain("Read As Written");
    expect(html).toContain("Summary On Play");
    expect(html).toContain("Summary Every Reply");
    expect(html).toContain("highlights each word in the message as it is spoken.  A summary is shorter");
    expect(html).not.toContain("Voice Summary");
    // No saved mode: the first option is the selected one.
    const selected = html.indexOf("border-accent bg-accent/5");
    expect(selected).toBeGreaterThan(-1);
    expect(html.slice(selected, html.indexOf("</button>", selected))).toContain("Read As Written");
  });
});

/**
 * The two voice sources load on their own clocks.  The helper's Personal
 * Voice list can park on an authorization prompt that never shows; it used
 * to sit in a Promise.all with the harness list, so the MiniMax voices never
 * appeared either.
 *
 * Pinned at the source because these are data-flow properties of the
 * loaders, not of any rendered output; the same reasoning as
 * `CallView.test.ts`.  The rendered behavior is in
 * VoiceSettings.behavior.test.tsx.
 */
describe("VoiceSettings voice loading", () => {
  const SRC = readFileSync(join(__dirname, "VoiceSettings.tsx"), "utf8");
  const between = (start: string, end: string) => {
    const from = SRC.indexOf(start);
    const to = SRC.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`missing slice ${start} -> ${end}`);
    return SRC.slice(from, to);
  };

  it("loads the harness list and the Personal Voice list independently", () => {
    const harness = between("const loadVoices", "const loadPersonalVoices");
    const personal = between("const loadPersonalVoices", "useEffect");
    expect(harness).toContain("parseTtsVoicesResponse(raw)");
    expect(harness).not.toContain("personalVoice");
    expect(harness.match(/requestId !== loadRequestRef\.current/g)).toHaveLength(1);
    expect(harness).toContain("if (requestId === loadRequestRef.current) setLoadingVoices(false);");
    // Listing waits on the macOS 14 Personal Voice gate, read at call time,
    // and gives up on a helper that never answers.
    expect(personal).toContain("personalVoiceAllowedRef.current");
    // The deadline only clears the spinner: the list itself is never
    // dropped, so one that arrives after an authorization prompt still lands.
    expect(personal).toContain("PERSONAL_VOICE_LIST_TIMEOUT_MS");
    expect(personal).toContain("const listed = list()");
    expect(personal).toContain("Promise.race([listed, gaveUp])");
    expect(personal).not.toContain("reject(");
    expect(personal).toContain("parsePersonalVoiceList(raw)");
    expect(personal).toContain("requestId === personalRequestRef.current");
    expect(SRC).not.toContain("Promise.all([");
    expect(SRC).toContain("capabilities.dictation.personalVoice === true");
  });

  it("starts each loader from its own effect", () => {
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*void loadVoices\(\);\s*\}, \[configured\]\);/);
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*void loadPersonalVoices\(\);\s*\}, \[personalVoiceAllowed\]\);/);
    expect(SRC).toContain("if (personalVoiceAllowed) setPersonalVoiceDenied(false);");
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
    const guard = between("const commitVoice", "const commitIphoneVoice");
    const add = between("const handleAddCustomVoice", "const handleDeleteVoice");
    const clone = between("const handleClone =", "if (!tts) return null");

    expect(guard).toContain("personalVoiceAllowedRef.current");
    expect(guard).toContain("capabilitiesReadyRef.current");
    expect(guard).toContain("if (isPersonalVoice(next) && !allowed)");
    expect(guard).toContain("if (ready && reportDenial) setPersonalVoiceDenied(true);");
    expect(guard).not.toContain("current === personalVoiceDisabledReason");
    // The Mac picker writes only the Mac's override, never the shared voice,
    // unless the harness predates per-device voices and would drop it.
    expect(guard).toContain("if (deviceVoicesSupported(bot)) onPatch({ voices: { mac: next || null } })");
    expect(guard).toContain("else onPatch({ voice: next })");

    // The typed id is cleared only after commitVoice accepts.  A refusal
    // returns first and leaves the form fields alone.
    expect(add).toContain("if (addedId && !commitVoice(addedId, false))");
    expect(add.indexOf("commitVoice(addedId, false)")).toBeLessThan(add.indexOf('setCustomVoiceId("")'));
    expect(add).toContain('method: "DELETE"');
    expect(add).toContain("setCustomError(");
    expect(add).toContain("capabilitiesReadyRef.current");
    expect(add).not.toContain("onPatch(");
    // The refusal branch captures the pre-POST voices list, gates the
    // compensating DELETE on a confirmed closed gate and a non-pre-existing
    // id, and surfaces a cleanup-failure message when the DELETE throws.
    expect(add).toContain("existedBeforePost");
    expect(add).toContain("shouldCleanup");
    expect(add).toContain("cleanupFailed");
    expect(add).toContain("The saved voice could not be removed");
    const del = between("const handleDeleteVoice", "const handleCloneFile");
    expect(del).toContain("setPersonalVoiceDenied(false)");
    expect(clone).toContain("commitVoice(result.voiceId)");
    expect(clone).not.toContain("onPatch(");
    expect(SRC).toContain("commitVoice(e.target.value)");

    // The iPhone picker never saves a Personal Voice from this Mac.
    const iphone = between("const commitIphoneVoice", "const loadVoices");
    expect(iphone).toContain("if (isPersonalVoice(next) || !deviceVoicesSupported(bot)) return;");
    expect(iphone).toContain("onPatch({ voices: { iphone: next || null } })");
    // No path sends the wire's voices: null, which would clear both devices.
    expect(SRC).not.toMatch(/voices: null\s*[,}]/);
  });
});
