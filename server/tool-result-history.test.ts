import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { estimateTokens } from "./drivers/acp/prompt-budget.ts";
import { toolsFor } from "./tools/registry.ts";
import {
  DEFAULT_TOOL_RESULT_HISTORY_CHARS,
  READ_TOOL_RESULT_TOOL,
  ToolResultArtifactStore,
  compactDeliveredToolResults,
  readToolResultArtifact,
  renderToolResultHistory,
  resolveToolResultHistoryChars,
  takeHead,
  takeTail,
} from "./tool-result-history.ts";

const MARKER = "MIDDLE-MARKER-2664";

function oversizedResult(): string {
  return `${"H".repeat(40_000)}${MARKER}${"T".repeat(40_000)}`;
}

describe("resolveToolResultHistoryChars", () => {
  it("defaults to 8000 and treats 0 as off", () => {
    expect(DEFAULT_TOOL_RESULT_HISTORY_CHARS).toBe(8_000);
    expect(resolveToolResultHistoryChars(undefined)).toBe(8_000);
    expect(resolveToolResultHistoryChars(0)).toBeNull();
    expect(resolveToolResultHistoryChars(1500.9)).toBe(1500);
    expect(resolveToolResultHistoryChars(Number.NaN)).toBe(8_000);
    expect(resolveToolResultHistoryChars(-4)).toBe(8_000);
  });
});

describe("surrogate-safe cuts", () => {
  it("does not split an emoji", () => {
    const text = `${"a".repeat(3)}😀${"b".repeat(3)}`;
    expect(takeHead(text, 4)).toBe("aaa");
    expect(takeTail(text, 4)).toBe("bbb");
    expect(takeHead(text, 5)).toBe("aaa😀");
    expect(takeTail(text, 5)).toBe("😀bbb");
  });
});

describe("renderToolResultHistory", () => {
  it("keeps a head and a tail inside the threshold and names the artifact", () => {
    const text = oversizedResult();
    const stored = renderToolResultHistory(text, "call_1", 8_000);
    expect(stored.length).toBeLessThanOrEqual(8_000);
    expect(stored.length).toBeGreaterThan(7_000);
    expect(stored.startsWith("[Tool result truncated for later turns. 80018 characters stored as artifact call_1.")).toBe(true);
    expect(stored).toContain(`Call ${READ_TOOL_RESULT_TOOL} with artifact_id "call_1"`);
    expect(stored).toContain("H".repeat(64));
    expect(stored.endsWith("T".repeat(64))).toBe(true);
    expect(stored).not.toContain(MARKER);
    expect(stored).toContain("characters omitted");
  });

  it("returns a short result unchanged when the caller compacts", () => {
    const store = new ToolResultArtifactStore();
    const messages = [{ role: "tool", tool_call_id: "c1", content: "ok" }];
    expect(compactDeliveredToolResults(messages, 1, { threshold: 8_000, store })).toBe(0);
    expect(messages[0].content).toBe("ok");
    expect(store.size).toBe(0);
  });
});

describe("compactDeliveredToolResults", () => {
  it("stores the full text and replaces only delivered tool messages", () => {
    const store = new ToolResultArtifactStore();
    const full = oversizedResult();
    const messages = [
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "seen", content: full },
      { role: "tool", tool_call_id: "fresh", content: full },
    ];
    expect(compactDeliveredToolResults(messages, 2, { threshold: 8_000, store })).toBe(1);
    expect(messages[1].content.length).toBeLessThanOrEqual(8_000);
    expect(messages[1].content).not.toContain(MARKER);
    expect(messages[2].content).toBe(full);
    expect(store.get("seen")).toBe(full);
    expect(store.has("fresh")).toBe(false);
    expect(readToolResultArtifact("seen", { store }) ).toEqual({ ok: true, text: full, chars: full.length });
    const window = readToolResultArtifact("seen", { store, offset: 40_000, limit: MARKER.length });
    expect(window).toEqual({ ok: true, text: MARKER, chars: full.length });
  });

  it("does not replace the stored original when compacting the excerpt again", () => {
    const store = new ToolResultArtifactStore();
    const full = oversizedResult();
    const messages = [{ role: "tool", tool_call_id: "seen", content: full }];
    compactDeliveredToolResults(messages, 1, { threshold: 8_000, store });
    const excerpt = messages[0].content;
    expect(compactDeliveredToolResults(messages, 1, { threshold: 8_000, store })).toBe(0);
    expect(messages[0].content).toBe(excerpt);
    expect(store.get("seen")).toBe(full);
  });

  it("drops the oldest artifact when the byte cap is exceeded and keeps the newest", () => {
    const store = new ToolResultArtifactStore(100);
    store.put("old", "a".repeat(80));
    store.put("new", "b".repeat(80));
    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")).toBe("b".repeat(80));
  });
});

describe("token reduction on a synthetic transcript", () => {
  it("measures later-round savings for an 80,018 character tool result", () => {
    const text = oversizedResult();
    const threshold = DEFAULT_TOOL_RESULT_HISTORY_CHARS;
    const stored = renderToolResultHistory(text, "call_synth", threshold);
    const laterRounds = 4;
    const originalTokens = estimateTokens(text);
    const storedTokens = estimateTokens(stored);
    const laterRoundTokensBefore = laterRounds * originalTokens;
    const laterRoundTokensAfter = laterRounds * storedTokens;
    const tokensSaved = laterRoundTokensBefore - laterRoundTokensAfter;
    const charsSaved = laterRounds * (text.length - stored.length);
    const report = {
      threshold,
      originalChars: text.length,
      storedChars: stored.length,
      laterRounds,
      originalTokens,
      storedTokens,
      laterRoundTokensBefore,
      laterRoundTokensAfter,
      tokensSaved,
      charsSaved,
      reductionPercent: Math.round((tokensSaved / laterRoundTokensBefore) * 1000) / 10,
      estimator: "estimateTokens (ASCII at 3 characters per token)",
    };
    expect(stored.length).toBeLessThanOrEqual(threshold);
    expect(tokensSaved).toBeGreaterThan(90_000);
    expect(report.reductionPercent).toBeGreaterThan(85);
    const dir = "/opt/cursor/artifacts";
    if (existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/tool-result-savings.json`, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(`tool-result-history savings ${JSON.stringify(report)}`);
  });
});

describe("read_tool_result catalog", () => {
  const gate = {
    agents: true,
    commsDepth: 0,
    maxCommsDepth: 1,
    chiefOfStaff: false,
    localComputer: true,
  };

  it("is offered on the HTTP tool loop only, and only when another tool is mounted", () => {
    expect(toolsFor("http", gate).map((tool) => tool.name)).not.toContain(READ_TOOL_RESULT_TOOL);
    expect(toolsFor("http", { ...gate, toolResultArchive: true }).map((tool) => tool.name)).toContain(READ_TOOL_RESULT_TOOL);
    expect(toolsFor("mcp", { ...gate, toolResultArchive: true }).map((tool) => tool.name)).not.toContain(READ_TOOL_RESULT_TOOL);
    expect(toolsFor("http", { ...gate, agents: false, localComputer: false, toolResultArchive: true })).toEqual([]);
  });
});
