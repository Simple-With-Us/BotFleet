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

  it("derives that flag from the provider-scoped tts.configured, not from a raw key check", () => {
    // Server-side `configured` means: MiniMax -> a key is on file; system -> Mac voices exist.
    // Reading it (rather than inventing a key check) is what keeps built-in voices working.
    expect(SRC).toMatch(/const configured = Boolean\(state\.config\?\.tts\?\.configured\);/);
    expect(SRC).toMatch(/const voiceProviderConfigured = configured;/);
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
    // remaining unavailable reasons (no macOS desktop app, capabilities loading, no voice picked).
    expect(SRC).toMatch(/Pick a voice in a bot profile to make calls/);
    expect(SRC).toMatch(/Calls currently need the macOS desktop app/);
  });
});
