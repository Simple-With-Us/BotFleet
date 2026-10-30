import { describe, expect, it, vi } from "vitest";
import { ProviderRouteActivity } from "./provider-route-activity.ts";
import { isTransientCapacityChip, transientCapacityRetryDelayMs } from "./model-fallback.ts";
import * as modelFallback from "./model-fallback.ts";
import type { RuntimeEvent } from "./contracts.ts";

type ToolStart = Extract<RuntimeEvent, { type: "item.started" }>;
type ToolCompletion = Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>;
const toolBase = { eventId: "event", provider: "codex" as const, threadId: "thread", turnId: "turn", createdAt: "2026-10-30T00:00:00Z", itemId: "read" };
const toolStart = (overrides: Partial<ToolStart> = {}): ToolStart => ({ ...toolBase, type: "item.started", itemType: "tool", title: "Read", ...overrides });
const toolCompletion = (overrides: Partial<ToolCompletion> = {}): ToolCompletion => ({ ...toolBase, type: "item.completed", itemType: "tool", ok: true, ...overrides });

describe("provider route activity evidence", () => {
  it("recognizes the complete capacity refusal used by the queued-routine fixture", () => {
    const chip = "HTTP 429: concurrency limit reached; retry after 120 seconds";
    expect(isTransientCapacityChip(chip)).toBe(true);
    expect(transientCapacityRetryDelayMs(chip)).toBe(120_000);
  });
  it("does not mistake fragmented error chips for healthy sibling activity", () => {
    const evidence = new ProviderRouteActivity();
    for (const [index, chunks] of [
      ["HTTP ", "429: Too Many Requests"],
      ["You've hit your ", "usage limit"],
      ["Con", "currency limit reached"],
      ["{\"error\":", "{\"code\":\"rate_limit_error\"}}"],
    ].entries()) {
      const owner = { dispatchId: index };
      for (const chunk of chunks) expect(evidence.observe(owner, "assistant_text", chunk)).toBe(false);
    }
  });

  it("recognizes normal progress as soon as an ambiguous prefix becomes ordinary output", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    expect(evidence.observe(owner, "assistant_text", "H")).toBe(false);
    expect(evidence.observe(owner, "assistant_text", "ello, the build is running.")).toBe(true);
    expect(evidence.observe(owner, "reasoning_text", "I am checking the failing test.")).toBe(true);
  });

  it("keeps dispatches and assistant/reasoning prefixes separate", () => {
    const evidence = new ProviderRouteActivity();
    const failing = { dispatchId: 1 };
    const sibling = { dispatchId: 2 };
    expect(evidence.observe(failing, "assistant_text", "HTTP ")).toBe(false);
    expect(evidence.observe(sibling, "assistant_text", "The next test is running.")).toBe(true);
    expect(evidence.observe(failing, "assistant_text", "429: concurrency limit reached")).toBe(false);
    expect(evidence.observe(failing, "reasoning_text", "Checking the source.")).toBe(true);
  });

  it("reuses classification after a stream prefix fills without changing its verdict", () => {
    const evidence = new ProviderRouteActivity();
    const classifier = vi.spyOn(modelFallback, "isShortProviderErrorText");
    try {
      for (const [dispatchId, prefix, expected] of [
        [1, "The build is running. ".padEnd(512, "x"), true],
        [2, "HTTP 429: Too Many Requests".padEnd(512, "x"), false],
      ] as const) {
        const owner = { dispatchId };
        classifier.mockClear();
        expect(evidence.observe(owner, "assistant_text", prefix)).toBe(expected);
        for (let index = 0; index < 20; index++) expect(evidence.observe(owner, "assistant_text", "more output")).toBe(expected);
        expect(classifier).toHaveBeenCalledTimes(1);
      }
    } finally {
      classifier.mockRestore();
    }
  });

  it("reuses unchanged trimmed prefixes while still classifying new fragments", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    const classifier = vi.spyOn(modelFallback, "isShortProviderErrorText");
    try {
      expect(evidence.observe(owner, "assistant_text", "H")).toBe(false);
      expect(evidence.observe(owner, "assistant_text", "")).toBe(false);
      expect(classifier).toHaveBeenCalledTimes(1);
      expect(evidence.observe(owner, "assistant_text", "ello")).toBe(true);
      expect(classifier).toHaveBeenCalledTimes(2);
      expect(evidence.observe(owner, "assistant_text", " \n")).toBe(true);
      expect(classifier).toHaveBeenCalledTimes(2);
      expect(evidence.observe(owner, "reasoning_text", "HTTP ")).toBe(false);
      expect(evidence.observe(owner, "reasoning_text", "429: Too Many Requests")).toBe(false);
      expect(classifier).toHaveBeenCalledTimes(4);
    } finally {
      classifier.mockRestore();
    }
  });

  it("counts only a matching successful tool completion once on its dispatch", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    const other = { dispatchId: 2 };
    expect(evidence.observeTool(owner, toolCompletion())).toBe(false);
    expect(evidence.observeTool(owner, toolStart())).toBe(false);
    expect(evidence.observeTool(other, toolCompletion())).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion({ detail: "Read 3 rows" }))).toBe(true);
    expect(evidence.observeTool(owner, toolCompletion())).toBe(false);
    evidence.observeTool(owner, toolStart());
    expect(evidence.observeTool(owner, toolCompletion({ ok: false }))).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion())).toBe(false);
  });

  it("ignores notice, helper, and lifecycle steps even when they report success", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    for (const started of [
      toolStart({ toolKind: "notice" }),
      toolStart({ parentItemId: "helper" }),
      toolStart({ subagentId: "helper" }),
      ...["hookRun: finished", "reminderChild", "workflow completed", "subagent: done"].map((title) => toolStart({ title })),
    ]) {
      expect(evidence.observeTool(owner, started)).toBe(false);
      expect(evidence.observeTool(owner, toolCompletion())).toBe(false);
    }
    for (const completed of [
      toolCompletion({ subagentId: "helper" }),
      toolCompletion({ title: "workflow completed" }),
      toolCompletion({ detail: "HTTP 429: concurrency limit reached" }),
    ]) {
      evidence.observeTool(owner, toolStart());
      expect(evidence.observeTool(owner, completed)).toBe(false);
    }
  });

  it("consumes lifecycle completions without counting them as model health", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    evidence.observeTool(owner, toolStart({ itemId: "lifecycle-tool" }));
    expect(evidence.observeTool(owner, toolCompletion({ itemId: "lifecycle-tool", title: "reminderChild" }))).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion({ itemId: "lifecycle-tool", title: "Read" }))).toBe(false);
  });

  it("requires the same item, thread, and turn on completion", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    expect(evidence.observeTool(owner, toolStart({ itemId: undefined }))).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion({ itemId: undefined }))).toBe(false);
    for (const completed of [toolCompletion({ threadId: "other" }), toolCompletion({ turnId: "other" })]) {
      evidence.observeTool(owner, toolStart());
      expect(evidence.observeTool(owner, completed)).toBe(false);
    }
    evidence.observeTool(owner, toolStart());
    expect(evidence.observeTool(owner, toolCompletion({ itemId: "other" }))).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion())).toBe(true);
  });

  it("accepts optional turn ids within the same dispatch and keeps helper collisions separate", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    evidence.observeTool(owner, toolStart({ turnId: undefined }));
    expect(evidence.observeTool(owner, toolCompletion())).toBe(true);
    evidence.observeTool(owner, toolStart());
    expect(evidence.observeTool(owner, toolCompletion({ turnId: undefined }))).toBe(true);
    evidence.observeTool(owner, toolStart());
    evidence.observeTool(owner, toolStart({ parentItemId: "helper", subagentId: "helper" }));
    expect(evidence.observeTool(owner, toolCompletion({ subagentId: "helper" }))).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion())).toBe(true);
    evidence.observeTool(owner, toolStart());
    evidence.observeTool(owner, toolStart({ toolKind: "notice" }));
    expect(evidence.observeTool(owner, toolCompletion())).toBe(false);
  });

  it("counts real tool names that merely share a lifecycle prefix", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    evidence.observeTool(owner, toolStart({ title: "workflowSearch" }));
    expect(evidence.observeTool(owner, toolCompletion({ title: "workflowSearch" }))).toBe(true);
  });

  it("bounds unfinished tool tracking per dispatch while retaining recent starts", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    for (let index = 0; index < 257; index++) evidence.observeTool(owner, toolStart({ itemId: `tool-${index}` }));
    expect(evidence.observeTool(owner, toolCompletion({ itemId: "tool-0" }))).toBe(false);
    expect(evidence.observeTool(owner, toolCompletion({ itemId: "tool-1" }))).toBe(true);
    expect(evidence.observeTool(owner, toolCompletion({ itemId: "tool-256" }))).toBe(true);
  });
});
