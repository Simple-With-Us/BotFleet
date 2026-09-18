// recall.ts's wrapper has to translate RecallOutcome.ok into the right
// TurnToolOutcome.kind — a plain "did the underlying call succeed" string
// return was silently reported as a success to the driver loop and the
// transcript chip even on failure (Sentry bug_prediction, PR #465). These
// tests exercise that mapping, plus the collection-mismatch guard, against
// an intentionally unconfigured settings object — deterministic because
// vitest's global setup (server/testing/setup.ts) points HOME at a
// throwaway directory, so findRecallCli() never finds a real `recall` CLI
// here, and neither hardcoded fallback path (/opt/homebrew/bin/recall,
// /usr/local/bin/recall) exists on the test runner.
import { describe, expect, it } from "vitest";

import type { RecallSettings } from "../recall-transport.ts";
import { createRecallTools } from "./recall.ts";

const UNCONFIGURED: RecallSettings = { url: "", apiKey: "", collection: "", accessClientId: "", accessClientSecret: "" };

const ctx = { botId: "bot-1", threadId: "thread-1", commsDepth: 0 };
const runtime = { signal: new AbortController().signal, requestApproval: async () => "allowed-once" as const };

function tools(settings: RecallSettings = UNCONFIGURED) {
  return createRecallTools({ settings, defaultSeat: "TestSeat" });
}

describe("createRecallTools outcome mapping", () => {
  it("reports kind: error, not kind: result, when the underlying call failed", async () => {
    const result = await tools().recall_search({ id: "1", name: "recall_search", arguments: { query: "anything" } }, ctx, runtime);
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/not configured/i);
  });

  it("reports kind: error for recall_contribute when unconfigured", async () => {
    const result = await tools().recall_contribute(
      { id: "1", name: "recall_contribute", arguments: { text: "a".repeat(50), category: "lesson" } },
      ctx,
      runtime,
    );
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/not configured/i);
  });

  it("reports kind: error for recall_stats when unconfigured", async () => {
    const result = await tools().recall_stats({ id: "1", name: "recall_stats", arguments: {} }, ctx, runtime);
    expect(result.kind).toBe("error");
  });

  it("rejects an invalid query without ever calling the underlying transport", async () => {
    const result = await tools({ ...UNCONFIGURED, url: "http://127.0.0.1:1" }).recall_search(
      { id: "1", name: "recall_search", arguments: { query: "" } },
      ctx,
      runtime,
    );
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/query parameter is required/);
  });
});

describe("createRecallTools collection guard", () => {
  it("rejects a call that asks for a different collection than configured, mirroring qdrant-proxy.ts", async () => {
    const settings: RecallSettings = { ...UNCONFIGURED, collection: "selected-corpus" };
    const result = await tools(settings).recall_search(
      { id: "1", name: "recall_search", arguments: { query: "x", collection: "other-corpus" } },
      ctx,
      runtime,
    );
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/cannot select a different collection/);
  });

  it("allows a call that names the SAME collection as configured", async () => {
    const settings: RecallSettings = { ...UNCONFIGURED, collection: "selected-corpus" };
    const result = await tools(settings).recall_search(
      { id: "1", name: "recall_search", arguments: { query: "x", collection: "selected-corpus" } },
      ctx,
      runtime,
    );
    // Falls through to the real (unconfigured) path rather than being
    // rejected by the guard — proves the guard compares, not just blocks.
    expect(result.content).not.toMatch(/cannot select a different collection/);
  });
});
