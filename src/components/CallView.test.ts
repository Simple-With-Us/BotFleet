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
    // A speech-to-speech provider is a provider too: it speaks on the call itself, so a
    // workspace with an STS key and no chained TTS setup must still get the button.  The
    // chained readiness rule is still what decides the chained half.
    expect(SRC).toMatch(/const voiceProviderConfigured = stsCall \|\| readiness\.engineAvailable;/);
  });

  it("leaves the chained gates off the speech-to-speech path", () => {
    // An STS call brings its own dictation and its own voice, so the dictation and
    // voice gates describe a path it is not taking.  Pinning the shape keeps a
    // later edit from re-gating the button behind a chained requirement.
    expect(SRC).toMatch(/const unavailable = !active && \(!capabilitiesReady \|\| \(!stsCall && \(!supported \|\| !voiceReady\)\)\);/);
    expect(SRC).toMatch(/const voiceSetupRequired = capabilitiesReady && !stsCall && supported && !voiceReady;/);
    expect(SRC).toMatch(/const stsCall = stsDecision\?\.mode === "sts";/);
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

/**
 * Approvals by voice, on a speech-to-speech call.
 *
 * Source-level for the same reason as the rest of this file: the decision logic
 * is a pure function and is unit-tested in `call-session.test.ts`, while what is
 * worth protecting here is the wiring — that a spoken answer reaches the same
 * action the card's own buttons dispatch, and that the call view never settles
 * a card itself.
 */
describe("approvals by voice", () => {
  it("reads a spoken answer with the shared anchored rules", () => {
    // The chained path and the speech-to-speech path must judge an answer by
    // the same standard, so the rules live with the policy rather than here.
    expect(SRC).not.toMatch(/\bYES\s*=\s*\/\^/);
    expect(SRC).not.toMatch(/\bNO\s*=\s*\/\^/);
    expect(SRC).toMatch(/const spoken = spokenApprovalDecision\(said\);/);
    expect(SRC).toMatch(/if \(spoken !== "unclear"\)/);
  });

  it("records the same denial note whichever path heard it", () => {
    expect(SRC).toMatch(/message: allow \? undefined : VOICE_DENIAL_MESSAGE/);
  });

  it("submits a voice decision through the card's own action", () => {
    // `decideRequest` is what PendingApprovalActions dispatches, so a spoken
    // "yes" and a clicked "Allow Once" are one decision with one record.
    const decisions = SRC.match(/type: "decideRequest"/g) ?? [];
    expect(decisions.length).toBe(2);
    expect(SRC).toMatch(/type: "decideRequest",\n\s*threadId: bot\.threadId,\n\s*requestId,\n\s*behavior: decision,/);
  });

  it("never lets the call itself answer or hide a card", () => {
    // The card stays in the chat whatever the voice decided; the call only
    // submits, and the server's patch is what settles it.
    expect(SRC).not.toMatch(/dismissCard/);
    expect(SRC).not.toMatch(/answered:/);
    expect(SRC).not.toMatch(/alwaysAllow/);
  });

  it("answers nothing until the policy has read the user's words", () => {
    expect(SRC).toMatch(/const outcome = resolveStsApproval\(request, approvalsRef\.current, decidedRef\.current\);/);
    expect(SRC).toMatch(/if \(outcome\.kind !== "decided"\) return outcome\.text;/);
  });

  it("claims a request before submitting it, and hands the claim back on failure", () => {
    expect(SRC).toMatch(/decidedRef\.current\.add\(requestId\);/);
    expect(SRC).toMatch(/decidedRef\.current\.delete\(requestId\);/);
    expect(SRC).toMatch(/waiter\?\.note\(/);
  });

  it("turns a turn blocked on a permission into the question to ask out loud", () => {
    // The stall this replaces: the engine was waiting on the user and the wait
    // used to time out into a bypass instead of reaching the model.
    expect(SRC).toMatch(/if \(result\.kind !== "approval"\) return result\.text;/);
    expect(SRC).toMatch(/\{ action: "ask", requestId: result\.requestId \}/);
    expect(SRC).toMatch(/if \(call\.approval\) return runVoiceApproval\(call\.approval, signal\);/);
  });

  it("reads the prompt the card already renders rather than inventing one", () => {
    expect(SRC).toMatch(/prompt: spokenApprovalPrompt\(pending, botName\),/);
    expect(SRC).toMatch(/approvalsRef\.current = pendingApprovals\(messages\)\.map/);
  });

  it("teaches the model the rule only when the tool is offered", () => {
    expect(SRC).toMatch(
      /const instructions = frontEngine\s*\? `\$\{prepared\.instructions\}\\n\\n\$\{stsApprovalInstructions\(\)\}`\s*: prepared\.instructions;/,
    );
  });

  it("leaves the chained narration early-return alone", () => {
    // An STS call still speaks for itself; the chained path still reads
    // approvals aloud, and neither is changed by this.
    expect(SRC).toMatch(/if \(stsModeRef\.current\) \{\s*for \(const m of messages\) spokenIds\.current\.add\(m\.id\);\s*return;/);
    expect(SRC).toMatch(/void sayThenListen\(spokenApprovalPrompt\(approval, bot\.name\)\);/);
  });
});
