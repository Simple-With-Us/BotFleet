import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import {
  clearPromptSplitReceipt,
  EMPTY_FINGERPRINT,
  joinedSystemPrompt,
  promptHalves,
  promptSplitFingerprints,
  readPromptSplitReceipt,
  splitSessionPrompt,
  sweepPromptSplitReceipts,
  VOLATILE_CONTEXT_CLEARED_NOTE,
  VOLATILE_CONTEXT_NOTE_PREFIX,
  volatileContextNote,
  withContextNote,
  writePromptSplitReceipt,
} from "./prompt-split.ts";

describe("promptHalves", () => {
  it("reads the split only when a turn carries both halves", () => {
    expect(promptHalves({ system: "all", systemStable: "keep", systemVolatile: "swap" })).toEqual({
      stable: "keep",
      volatile: "swap",
    });
    expect(promptHalves({ system: "all" })).toEqual({ stable: null, volatile: "" });
    expect(promptHalves({ system: "all", systemStable: "keep" })).toEqual({ stable: null, volatile: "" });
    expect(promptHalves({ system: "all", systemVolatile: "swap" })).toEqual({ stable: null, volatile: "" });
  });
});

describe("joinedSystemPrompt", () => {
  it("prefers the server's ordered join, then the halves back to back, then nothing", () => {
    // a volatile section can sit between two stable ones, so the ordered
    // join is what a pre-split driver keeps sending
    expect(joinedSystemPrompt({ system: "a b c", systemStable: "a c", systemVolatile: " b" })).toBe("a b c");
    expect(joinedSystemPrompt({ systemStable: "a c", systemVolatile: " b" })).toBe("a c b");
    expect(joinedSystemPrompt({})).toBeUndefined();
    expect(joinedSystemPrompt({ systemStable: "a" })).toBeUndefined();
  });
});

describe("volatileContextNote", () => {
  it("labels the current copy, announces a clearing, and stays quiet for never-set halves", () => {
    expect(volatileContextNote("Memory: likes quiet hours.", false)).toBe(
      `${VOLATILE_CONTEXT_NOTE_PREFIX}\n\nMemory: likes quiet hours.`,
    );
    expect(volatileContextNote("  ", true)).toBe(VOLATILE_CONTEXT_CLEARED_NOTE);
    expect(volatileContextNote("", false)).toBe("");
  });
});

describe("withContextNote", () => {
  it("prepends the note, keeps bare text bare, and passes through empty notes", () => {
    expect(withContextNote("note", "text")).toBe("note\n\ntext");
    expect(withContextNote("note", "")).toBe("note");
    expect(withContextNote("", "text")).toBe("text");
  });
});

describe("prompt-split receipts", () => {
  it("round-trips the halves a native session last carried", () => {
    const scope = "test-driver";
    const key = randomUUID();
    expect(readPromptSplitReceipt(scope, key)).toBeNull();
    const receipt = promptSplitFingerprints("stable rules", "memory");
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    expect(readPromptSplitReceipt(scope, randomUUID())).toBeNull();
    expect(readPromptSplitReceipt("other-driver", key)).toBeNull();
  });

  it("fingerprints an empty half to the shared empty fingerprint", () => {
    expect(promptSplitFingerprints("", "").volatile).toBe(EMPTY_FINGERPRINT);
    expect(promptSplitFingerprints("x", "y").volatile).not.toBe(EMPTY_FINGERPRINT);
  });

  it("forgets a receipt on request, and tolerates forgetting one that never existed", () => {
    const key = randomUUID();
    writePromptSplitReceipt("test-driver", key, promptSplitFingerprints("s", "v"));
    clearPromptSplitReceipt("test-driver", key);
    expect(readPromptSplitReceipt("test-driver", key)).toBeNull();
    expect(() => clearPromptSplitReceipt("test-driver", randomUUID())).not.toThrow();
  });

  it("reads a corrupt or misshapen receipt as unknown", () => {
    const dir = join(DATA_DIR, "prompt-split");
    mkdirSync(dir, { recursive: true });
    const key = randomUUID();
    // the file name is a digest of the scope and key, so find this case's
    // receipt by a marker in its body rather than by directory order — the
    // sibling cases above leave their own receipts in the same directory
    const marker = `corrupt-me-${key}`;
    writePromptSplitReceipt("test-driver", key, { stable: marker, volatile: "v" });
    const file = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .find((name) => readFileSync(join(dir, name), "utf8").includes(marker));
    expect(file).toBeDefined();
    writeFileSync(join(dir, file!), "{not json");
    expect(readPromptSplitReceipt("test-driver", key)).toBeNull();
    writePromptSplitReceipt("test-driver", key, { stable: "s", volatile: "v" });
    expect(readPromptSplitReceipt("test-driver", key)).toEqual({ stable: "s", volatile: "v" });
  });

  it("sweeps receipts untouched for longer than the window and keeps the rest", () => {
    const dir = join(DATA_DIR, "prompt-split");
    const stale = randomUUID();
    const fresh = randomUUID();
    writePromptSplitReceipt("sweep", stale, promptSplitFingerprints("s", "v"));
    writePromptSplitReceipt("sweep", fresh, promptSplitFingerprints("s", "v"));
    const now = Date.now();
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000);
    for (const name of readdirSync(dir)) {
      // only the stale one is aged; identify it by re-reading after the sweep
      if (name.endsWith(".json")) utimesSync(join(dir, name), old, old);
    }
    writePromptSplitReceipt("sweep", fresh, promptSplitFingerprints("s", "v2"));
    const removed = sweepPromptSplitReceipts(30 * 24 * 60 * 60 * 1000, now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(readPromptSplitReceipt("sweep", stale)).toBeNull();
    expect(readPromptSplitReceipt("sweep", fresh)).toEqual(promptSplitFingerprints("s", "v2"));
    expect(sweepPromptSplitReceipts(30 * 24 * 60 * 60 * 1000, now)).toBe(0);
  });
});

describe("splitSessionPrompt", () => {
  const fullSystem = "stable rules.\n\nmemory";

  it("delivers the full prompt to an untracked session, then sends later turns bare", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    expect(first.text).toBe(fullSystem + "\n\nfirst");
    const second = splitSessionPrompt("stable rules.", "memory", first.receipt, fullSystem, "second");
    expect(second.text).toBe("second");
  });

  it("rides a changed volatile half as a labelled note", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    const second = splitSessionPrompt("stable rules.", "moved to Toronto", first.receipt, fullSystem, "second");
    expect(second.text).toBe(`${VOLATILE_CONTEXT_NOTE_PREFIX}\n\nmoved to Toronto\n\nsecond`);
  });

  it("announces a cleared volatile half once", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    const cleared = splitSessionPrompt("stable rules.", "", first.receipt, fullSystem, "cleared");
    expect(cleared.text).toBe(`${VOLATILE_CONTEXT_CLEARED_NOTE}\n\ncleared`);
    const still = splitSessionPrompt("stable rules.", "", cleared.receipt, fullSystem, "still");
    expect(still.text).toBe("still");
  });

  it("redelivers an unchanged volatile half on a turn that carries its own mention context", () => {
    const first = splitSessionPrompt("stable rules.", "Tagged: @Testy", null, fullSystem, "first");
    const untagged = splitSessionPrompt("stable rules.", "Tagged: @Testy", first.receipt, fullSystem, "untagged");
    expect(untagged.text).toBe("untagged");
    const tagged = splitSessionPrompt("stable rules.", "Tagged: @Testy", first.receipt, fullSystem, "tagged", true);
    expect(tagged.text).toBe(`${VOLATILE_CONTEXT_NOTE_PREFIX}\n\nTagged: @Testy\n\ntagged`);
  });

  it("re-delivers the full prompt when the stable half changes", () => {
    const first = splitSessionPrompt("old rules.", "memory", null, fullSystem, "first");
    const second = splitSessionPrompt("new rules.", "memory", first.receipt, "new rules.\n\nmemory", "second");
    expect(second.text).toBe("new rules.\n\nmemory\n\nsecond");
  });
});
