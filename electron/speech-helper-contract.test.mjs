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
    expect(speechSource).toMatch(/writeFileSync\(textPath, request\.text, \{ mode: 0o600 \}\);/);
    expect(speechSource).toContain('"--text-file"');
    // The old shape put the reply itself in argv.
    expect(speechSource).not.toMatch(/^\s*"--text",$/m);
    expect(speechSource).not.toMatch(/^\s*request\.text,\s*$/m);
    expect(speechSource).not.toMatch(/^\s*String\(text \?\? ""\),\s*$/m);
  });

  it("matches only Personal Voices, never an ordinary voice of the same name", () => {
    // `personal:Samantha` used to select the system voice Samantha, because the match ran over
    // every installed voice by identifier or name.  The lookup narrows to the Personal Voice
    // trait first, for the named voice and for the no-voice-named guess alike.
    const start = helperSource.indexOf("let doSpeak = {");
    const end = helperSource.indexOf("let status = AVSpeechSynthesizer.personalVoiceAuthorizationStatus", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const lookup = helperSource.slice(start, end);
    expect(lookup).toMatch(/let personalVoices = AVSpeechSynthesisVoice\.speechVoices\(\)\s*\.filter \{ \$0\.voiceTraits\.contains\(\.isPersonalVoice\) \}/);
    expect(lookup).toMatch(/let matched = personalVoices\.first\(where:/);
    expect(lookup).toMatch(/\?\? \(rawId\.isEmpty \? personalVoices\.first : nil\)/);
    expect(lookup).not.toContain("allVoices");
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

  it("retries a canceled chunk from the unspoken remainder", () => {
    // didCancel used to call speakCurrentChunk() on the original chunk, so an
    // interruption replayed audio the user had already heard.  willSpeakRange
    // is UTF-16 and is relative to the utterance currently in flight.
    expect(helperSource).toContain("willSpeakRangeOfSpeechString");
    expect(helperSource).toContain("static func remainderAfterCancel(chunk: String, nextRangeLocation: Int)");
    expect(helperSource).toContain("return ns.substring(from: location)");
    const cancelStart = helperSource.indexOf("func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel");
    const cancelEnd = helperSource.indexOf("let speaker = PersonalVoiceSpeaker()");
    const cancel = helperSource.slice(cancelStart, cancelEnd);
    expect(cancel).toContain("remainderAfterCancel(");
    expect(cancel).not.toMatch(/attempts < 2 \{\s*speakCurrentChunk\(\)/);
  });

  it("streams word ranges against the caller's text, not the chunk", () => {
    // Karaoke maps these offsets onto the spoken script, so they must index
    // the text file as written: chunks are ranges into it, each range is
    // offset by its chunk's base, and a retried remainder moves the base.
    expect(helperSource).toContain("static func chunkRanges(_ text: String, maxCharacters: Int = 750) -> [NSRange]");
    expect(helperSource).toContain("self.chunkBases = ranges.map { $0.location }");
    const will = helperSource.slice(
      helperSource.indexOf("willSpeakRangeOfSpeechString characterRange: NSRange"),
      helperSource.indexOf("func advanceAfterChunk()"),
    );
    expect(will).toContain('"range": [chunkBases[currentChunkIndex] + characterRange.location, characterRange.length]');
    expect(will).toContain('"elapsedMs"');
    const cancelStart = helperSource.indexOf("func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel");
    const cancel = helperSource.slice(cancelStart, helperSource.indexOf("let speaker = PersonalVoiceSpeaker()"));
    expect(cancel).toContain("chunkBases[currentChunkIndex] += cut");
    // emit() flushes, which is what makes a line visible while speaking
    expect(helperSource).toMatch(/print\(line\)\s*\n\s*fflush\(stdout\)/);
  });

  it("tails the helper's output while it speaks and guards stale sessions", () => {
    const speak = speechSource.slice(
      speechSource.indexOf("export function speakPersonalVoice("),
      speechSource.indexOf("export function stopPersonalVoice()"),
    );
    expect(speak).toContain("watchFile(outputPath, { interval: PERSONAL_VOICE_POLL_MS, persistent: false }, drain)");
    expect(speak).toContain("setInterval(drain, PERSONAL_VOICE_POLL_MS)");
    expect(speak).toContain("personalVoiceChild === session");
    expect(speak).toContain("unwatchFile(outputPath, drain)");
  });

  it("bounds Personal Voice listing and stops the helper through its marker", () => {
    expect(speechSource).toContain("const PERSONAL_VOICE_LIST_TIMEOUT_MS = 8_000;");
    const list = speechSource.slice(
      speechSource.indexOf("export function listPersonalVoicesResult("),
      speechSource.indexOf("export async function listPersonalVoices("),
    );
    // \s+, not a literal newline and indent: a Windows checkout has CRLF here.
    expect(list).toMatch(/"--list-personal-voices",\s+"--stop-file",/);
    expect(list).toContain('settle({ voices: [], status: "timeout", timedOut: true });');
    // The helper's stop timer is installed before the list branch runs.
    expect(helperSource.indexOf("if let stopFile {")).toBeLessThan(helperSource.indexOf('contains("--list-personal-voices")'));
  });

  it("sends ranges only to the asking window, as numbers, and unsubscribes", () => {
    const mainSource = readFileSync(join(HERE, "main.mjs"), "utf8");
    const preloadSource = readFileSync(join(HERE, "preload.cjs"), "utf8");
    const handler = mainSource.slice(
      mainSource.indexOf('ipcMain.handle("personal-voice:speak"'),
      mainSource.indexOf('ipcMain.handle("personal-voice:stop"'),
    );
    expect(handler).toContain('sender.send("personal-voice:range", { id: progressId, location, length, elapsedMs })');
    expect(handler).not.toContain("webContents.send");
    expect(handler).not.toMatch(/send\([^)]*text/);
    expect(preloadSource).toContain('ipcRenderer.on("personal-voice:range", handler);');
    expect(preloadSource).toContain('.finally(() => ipcRenderer.removeListener("personal-voice:range", handler))');
  });
});
