// The Personal Voice spawn and the Swift helper it launches are two halves of
// one contract: `speakPersonalVoice()` builds argv, and speech-helper.swift
// parses it.  Nothing at runtime checks that they still agree — a rename on
// one side alone leaves every utterance failing with `missing-text` (or, worse
// before the fix, silently speaking the wrong voice), and neither file is
// exercised by a unit test because the helper only runs on a real Mac with a
// real Personal Voice installed.
//
// So the contract is pinned here, the same way `CallView.test.ts` pins a guard
// whose real behaviour needs the whole desktop stack.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const speechSource = readFileSync(join(HERE, "speech.mjs"), "utf8");
const helperSource = readFileSync(join(HERE, "resources", "speech-helper.swift"), "utf8");

describe("Personal Voice helper contract", () => {
  it("keeps reply text off argv", () => {
    // argv is world-readable through `ps` on macOS, and this text is a voice
    // summary of the user's own private messages.
    expect(speechSource).toMatch(/const textPath = path\.join\(sessionDir, "text\.txt"\);/);
    expect(speechSource).toMatch(/writeFileSync\(textPath, String\(text \?\? ""\), \{ mode: 0o600 \}\);/);
    expect(speechSource).toContain('"--text-file"');
    // The old shape put the reply itself in argv.
    expect(speechSource).not.toMatch(/^\s*"--text",$/m);
    expect(speechSource).not.toMatch(/^\s*String\(text \?\? ""\),\s*$/m);
  });

  it("reads the text from the file the main process writes", () => {
    expect(helperSource).toContain('args.firstIndex(of: "--text-file")');
    expect(helperSource).toMatch(/try\? String\(contentsOfFile: textPath, encoding: \.utf8\)/);
    // A missing or unreadable file must fail the way a missing arg did.
    expect(helperSource.match(/fail\("missing-text"\)/g)).toHaveLength(2);
  });

  it("only guesses a voice when the caller named none", () => {
    // A named-but-absent voice (not synced to this Mac) must fail rather than
    // be replaced by a different Personal Voice speaking the user's words.
    expect(helperSource).toMatch(/\?\? \(rawId\.isEmpty/);
    expect(helperSource).toContain('fail("voice-not-found")');
    // The unguarded fallback this replaced.
    expect(helperSource).not.toMatch(/\}\s*\?\?\s*allVoices\.first\(where: \{ \$0\.voiceTraits/);
  });

  it("bounds a Personal Voice utterance that never finishes", async () => {
    // The helper parks in RunLoop.main.run() until the synthesizer delegates or
    // the stop marker appears.  Without a deadline the promise never settles and
    // the call queue never drains again.
    expect(speechSource).toContain("const PERSONAL_VOICE_MIN_MS =");
    expect(speechSource).toContain("const PERSONAL_VOICE_MS_PER_CHAR =");
    expect(speechSource).toMatch(/const budgetMs = Math\.max\(PERSONAL_VOICE_MIN_MS/);
    expect(speechSource).toMatch(/clearTimeout\(timer\);/);
    expect(speechSource).toContain('settle(() => reject(new Error("Personal Voice did not finish speaking.")))');
  });

  it("stops a speaking helper on the same quit path that stops dictation", async () => {
    const mainSource = readFileSync(join(HERE, "main.mjs"), "utf8");
    const quitPath = mainSource.slice(mainSource.indexOf('app.on("before-quit"'), mainSource.indexOf("app.quit();", mainSource.indexOf('app.on("before-quit"')));
    expect(quitPath).toContain("stopSpeech()");
    expect(quitPath).toContain("stopPersonalVoice()");
  });
});
