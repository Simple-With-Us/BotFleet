// speech.mjs drives the Personal Voice helper through files: `open -o` writes
// the helper's stdout to a file the main process tails.  These tests stand in
// for the helper by writing that file themselves, so the parsing, the
// staleness guard, and the listing deadline run for real without a Mac voice.
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  // Packaged mode skips the lazy swiftc build; the bundle path is never run.
  process.resourcesPath = "/nonexistent-botfleet-resources";
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  return { temp: "", spawned: [], realPlatform };
});

vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => state.temp } }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: (command, args) => {
      const proc = new EventEmitter();
      state.spawned.push({ command, args, proc });
      return proc;
    },
  };
});

state.temp = mkdtempSync(path.join(tmpdir(), "botfleet-pv-test-"));
const {
  MAX_PERSONAL_VOICE_TEXT_CHARS,
  listPersonalVoices,
  listPersonalVoicesResult,
  speakPersonalVoice,
  stopPersonalVoice,
  validatePersonalVoiceRequest,
} = await import("./speech.mjs");

afterAll(() => {
  if (state.realPlatform) Object.defineProperty(process, "platform", state.realPlatform);
});

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];
const lastSpawn = () => state.spawned[state.spawned.length - 1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("speakPersonalVoice request validation", () => {
  // The renderer chooses the text and the voice id.  A bad payload used to be coerced with
  // String(), spawn the helper, and wait out the speaking deadline.
  const bad = [
    ["text that is a number", 42, "personal:x"],
    ["no text", undefined, "personal:x"],
    ["blank text", "  \n ", "personal:x"],
    ["text past the cap", "x".repeat(12_001), "personal:x"],
    ["an ordinary voice name", "hi", "Samantha"],
    ["a voice id that is not a string", "hi", 7],
    ["a control character in the voice id", "hi", "personal:a\nb"],
    ["an overlong voice id", "hi", `personal:${"x".repeat(300)}`],
  ];

  it.each(bad)("rejects %s without spawning, writing files or stopping current speech", async (_name, text, voiceId) => {
    const live = speakPersonalVoice("a live reply", "personal:x", { onRange: () => {} });
    const running = lastSpawn();
    const stopMarker = argAfter(running.args, "--stop-file");
    const spawnedBefore = state.spawned.length;

    await expect(speakPersonalVoice(text, voiceId)).rejects.toThrow();

    expect(state.spawned.length).toBe(spawnedBefore);
    // a rejected request must not have told the running helper to stop
    expect(existsSync(stopMarker)).toBe(false);
    running.proc.emit("close", 0);
    await expect(live).resolves.toBeUndefined();
  });

  it("accepts a Personal Voice id, an apple-personal id, and no named voice", () => {
    expect(validatePersonalVoiceRequest("Hello", "personal:abc")).toEqual({ ok: true, text: "Hello", voiceId: "personal:abc" });
    expect(validatePersonalVoiceRequest("Hello", "apple-personal:abc").ok).toBe(true);
    // Nothing named: the helper picks the first Personal Voice.  The bridge declares the id
    // optional, so a missing one is the same as an empty one, as it was before validation.
    expect(validatePersonalVoiceRequest("Hello", "")).toEqual({ ok: true, text: "Hello", voiceId: "" });
    expect(validatePersonalVoiceRequest("Hello", undefined)).toEqual({ ok: true, text: "Hello", voiceId: "" });
    expect(validatePersonalVoiceRequest("Hello", null)).toEqual({ ok: true, text: "Hello", voiceId: "" });
    expect(validatePersonalVoiceRequest("x".repeat(MAX_PERSONAL_VOICE_TEXT_CHARS), "personal:abc").ok).toBe(true);
  });
});

describe("speakPersonalVoice word ranges", () => {
  it("delivers each range as its line lands, joining a line split across writes", async () => {
    const ranges = [];
    const done = speakPersonalVoice("Hello there friend", "personal:x", { onRange: (r) => ranges.push(r) });
    const { args, proc, command } = lastSpawn();
    expect(command).toBe("/usr/bin/open");
    const out = argAfter(args, "-o");

    appendFileSync(out, '{"range":[0,5],"elapsedMs":0}\n{"range":[6,');
    await vi.waitFor(() => expect(ranges).toHaveLength(1), { timeout: 10_000 });
    appendFileSync(out, '5],"elapsedMs":310}\nnot json\n{"range":[12,6]}\n');
    await vi.waitFor(() => expect(ranges).toHaveLength(3), { timeout: 10_000 });

    appendFileSync(out, '{"finished":true}\n');
    proc.emit("close", 0);
    await expect(done).resolves.toBeUndefined();
    expect(ranges).toEqual([
      { location: 0, length: 5, elapsedMs: 0 },
      { location: 6, length: 5, elapsedMs: 310 },
      { location: 12, length: 6, elapsedMs: null },
    ]);
    // the session directory, text file included, is gone
    expect(existsSync(path.dirname(out))).toBe(false);
  });

  it("rejects with the helper's reported error", async () => {
    const done = speakPersonalVoice("Hi", "personal:missing", { onRange: () => {} });
    const { args, proc } = lastSpawn();
    appendFileSync(argAfter(args, "-o"), '{"error":"voice-not-found"}\n');
    proc.emit("close", 1);
    await expect(done).rejects.toThrow("voice-not-found");
  });

  it("drops ranges from a session that was stopped or replaced", async () => {
    const first = [];
    const firstDone = speakPersonalVoice("one two", "personal:x", { onRange: (r) => first.push(r) });
    const a = lastSpawn();
    const secondDone = speakPersonalVoice("three four", "personal:x", { onRange: () => {} });
    const b = lastSpawn();
    // the replaced helper was told to stop through its marker
    expect(existsSync(argAfter(a.args, "--stop-file"))).toBe(true);
    appendFileSync(argAfter(a.args, "-o"), '{"range":[0,3],"elapsedMs":5}\n');
    await sleep(400);
    expect(first).toEqual([]);
    a.proc.emit("close", 0);
    b.proc.emit("close", 0);
    await expect(firstDone).resolves.toBeUndefined();
    await expect(secondDone).resolves.toBeUndefined();
    stopPersonalVoice();
  });

  it("still parses the final answer without a range listener", async () => {
    const done = speakPersonalVoice("plain", "personal:x");
    const { args, proc } = lastSpawn();
    appendFileSync(argAfter(args, "-o"), '{"range":[0,5],"elapsedMs":0}\n{"finished":true}\n');
    proc.emit("close", 0);
    await expect(done).resolves.toBeUndefined();
  });
});

describe("listPersonalVoices deadline", () => {
  it("answers an empty list and stops the helper when it never replies", async () => {
    const result = listPersonalVoicesResult({ timeoutMs: 50 });
    const { args, proc } = lastSpawn();
    expect(args).toContain("--list-personal-voices");
    await expect(result).resolves.toEqual({ voices: [], status: "timeout", timedOut: true });
    const stopFile = argAfter(args, "--stop-file");
    expect(existsSync(stopFile)).toBe(true);
    proc.emit("close", 0);
    expect(existsSync(path.dirname(stopFile))).toBe(false);
  });

  it("returns the voices the helper lists", async () => {
    const result = listPersonalVoices({ timeoutMs: 5_000 });
    const { args, proc } = lastSpawn();
    appendFileSync(
      argAfter(args, "-o"),
      '{"status":"authorized","voices":[{"id":"personal:abc","name":"My Voice","locale":"en-US"}]}\n',
    );
    proc.emit("close", 0);
    await expect(result).resolves.toEqual([{ id: "personal:abc", name: "My Voice", locale: "en-US" }]);
  });

  it("reports a denied authorization as an empty list, not a timeout", async () => {
    const result = listPersonalVoicesResult({ timeoutMs: 5_000 });
    const { args, proc } = lastSpawn();
    appendFileSync(argAfter(args, "-o"), '{"status":"denied","voices":[]}\n');
    proc.emit("close", 0);
    await expect(result).resolves.toEqual({ voices: [], status: "denied", timedOut: false });
  });
});
