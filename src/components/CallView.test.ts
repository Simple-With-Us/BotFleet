import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The call button lives in the chat header, top right (ChatView mounts <CallButton/>).
 * Owner 2026-09-03: with no voice provider configured it must not be in the header at all,
 * rather than rendered disabled with an explanatory tooltip, which is what it used to do.
 *
 * These are source-level assertions rather than a render test because CallTargetButton pulls in
 * the desktop-capabilities and speech stacks; the guard itself is a single unconditional branch,
 * so pinning its shape and its position relative to the hooks is what actually protects it.
 */
const SRC = readFileSync(join(__dirname, "CallView.tsx"), "utf8");

describe("CallTargetButton visibility", () => {
  it("returns null when no voice provider is configured", () => {
    expect(SRC).toMatch(/if \(!voiceProviderConfigured\) return null;/);
  });

  it("derives that flag from the shared readiness rule, not from a raw key check", () => {
    // Server-side `configured` means: MiniMax -> a key is on file; system -> Mac voices exist.
    // Reading it (rather than inventing a key check) is what keeps built-in voices working.  A
    // Personal Voice this Mac can speak is an engine too; callVoiceReadiness (unit-tested in
    // src/lib/tts/readiness.test.ts) folds both into engineAvailable.
    expect(SRC).toMatch(/const configured = Boolean\(state\.config\?\.tts\?\.configured\);/);
    expect(SRC).toMatch(/const readiness = callVoiceReadiness\(\{/);
    expect(SRC).toMatch(/const voiceProviderConfigured = readiness\.engineAvailable;/);
  });

  it("places the guard after every hook so hook order stays stable", () => {
    const guard = SRC.indexOf("if (!voiceProviderConfigured) return null;");
    expect(guard).toBeGreaterThan(-1);
    const before = SRC.slice(0, guard);
    const after = SRC.slice(guard);
    // Every hook call in this component must appear before the guard.
    for (const hook of ["useState(", "useRef<", "useId(", "useEffect("]) {
      expect(before).toContain(hook);
    }
    // And none may appear after it, which would be a conditional-hook bug.
    const afterBody = after.slice(0, after.indexOf("\nexport ") === -1 ? after.length : after.indexOf("\nexport "));
    for (const hook of ["useState(", "useEffect(", "useId("]) {
      expect(afterBody).not.toContain(hook);
    }
  });

  it("still explains the missing-voice case for the states it does render", () => {
    // Once a provider IS configured, the button stays visible and keeps its guidance for the
    // remaining unavailable reasons (no STT provider, capabilities loading, no voice picked).
    expect(SRC).toMatch(/Pick a voice in a bot profile to make calls/);
    expect(SRC).toMatch(/Set up dictation to make calls/);
    expect(SRC).toMatch(/Add an AssemblyAI API key in Settings to make calls on this computer/);
  });
});

describe("Personal Voice desktop call support", () => {
  it("calls with this Mac's voice for the bot", () => {
    // Personal Voice ids are device-local, so the call resolves the Mac's own choice.
    expect(SRC).toMatch(/voices=\{\[voiceForDevice\(bot, "mac"\)\]\}/);
    expect(SRC).toMatch(/const macVoice = voiceForDevice\(bot, "mac"\);/);
    expect(SRC).toMatch(/voiceId: macVoice/);
    expect(SRC).not.toMatch(/voiceId: bot\.voice/);
  });

  it("enables personal voice only when the host advertises the capability", () => {
    // The version gate lives in electron/capabilities.cjs (macOS 14+), so the
    // renderer reads the flag rather than re-deriving it from the platform.
    expect(SRC).toMatch(/const isPersonalSpeakable = capabilities\.dictation\.personalVoice === true;/);
    expect(SRC).not.toMatch(/const isPersonalSpeakable = isMac;/);
    expect(SRC).toMatch(/personalVoiceAvailable: isPersonalSpeakable,/);
    // A MiniMax key is required only when a hosted voice is in play.
    expect(SRC).toMatch(/const hostedEngineMissing = readiness\.needsHostedEngine && !configured;/);
  });

  it("reads requires-macos-14 instead of telling a Mac user they need a Mac", () => {
    expect(SRC).toMatch(/capabilities\.dictation\.reasonCode === "requires-macos-14"/);
    expect(SRC).toMatch(/Personal Voice needs macOS 14 or later, or an iPhone/);
    expect(SRC).toMatch(/Apple Personal Voice needs macOS 14 or later, or an iPhone/);
    // A non-Apple computer may still be told the feature is Mac or iPhone.
    expect(SRC).toMatch(/Personal Voice needs a Mac or iPhone/);
    expect(SRC).toMatch(/Apple Personal Voice speaks on Apple devices \(Mac and iPhone\)/);
  });
});
