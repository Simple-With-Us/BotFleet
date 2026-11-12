// The two Engine Quotas notices, split out of UsageSection so a visual spec can
// mount them with fixed data.  These pin what the split must not change: the
// notices draw nothing when there is nothing to say, and their headings count
// BOTS, not rows.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeldBotsNotice, RedundantChainsNotice } from "./UsageNotices";
import type { DoomedPair, RedundantChain } from "./UsageSection";

const pair = (botId: string, instanceId: string, extra: Partial<DoomedPair> = {}): DoomedPair => ({
  botId,
  instanceId,
  consecutiveFailures: 3,
  openedAt: 1,
  lastFailureAt: 2,
  ...extra,
});

const chain = (botId: string, extra: Partial<RedundantChain> = {}): RedundantChain => ({
  botId,
  name: "Atlas",
  total: 3,
  effective: 2,
  redundant: [{ instanceId: "dsh", model: "deepseek-v4", reason: "same-as-primary" }],
  ...extra,
});

describe("HeldBotsNotice", () => {
  it("draws nothing when no pair is held", () => {
    expect(renderToStaticMarkup(createElement(HeldBotsNotice, { heldPairs: [] }))).toBe("");
  });

  it("counts bots, so one bot held on two engines is still one bot", () => {
    const html = renderToStaticMarkup(
      createElement(HeldBotsNotice, { heldPairs: [pair("bot-a-0001", "dsh"), pair("bot-a-0001", "grok")] }),
    );
    expect(html).toContain("1 Bot Is Being Held");
    expect(html).toContain("failed to start");
  });

  it("pluralizes for several bots and carries the last error", () => {
    const html = renderToStaticMarkup(
      createElement(HeldBotsNotice, {
        heldPairs: [pair("bot-a-0001", "dsh", { lastError: "not signed in" }), pair("bot-b-0002", "grok")],
      }),
    );
    expect(html).toContain("2 Bots Are Being Held");
    expect(html).toContain(": not signed in");
  });

  it("keeps a visible gap between the two sentences of the explanation", () => {
    // Rendered copy: two ASCII spaces collapse to one in HTML, so the gap is a
    // real U+00A0 plus a space.
    const html = renderToStaticMarkup(createElement(HeldBotsNotice, { heldPairs: [pair("bot-a-0001", "dsh")] }));
    expect(html).toContain("comes back.\u00a0 Each attempt");
    expect(html).not.toContain("comes back.  Each attempt");
  });
});

describe("RedundantChainsNotice", () => {
  it("draws nothing when no chain is shorter than it looks", () => {
    expect(renderToStaticMarkup(createElement(RedundantChainsNotice, { redundantChains: [] }))).toBe("");
  });

  it("counts bots, so a bot chain plus a task override is one bot, and names the task", () => {
    const html = renderToStaticMarkup(
      createElement(RedundantChainsNotice, {
        redundantChains: [chain("bot-a"), chain("bot-a", { scope: "task", threadId: "9c1e5a77-2d40" })],
      }),
    );
    expect(html).toContain("1 Bot&#x27;s Fallback Chain Is Shorter Than It Looks");
    expect(html).toContain("task 9c1e5a77");
  });

  it("pluralizes for several bots and says why an entry is redundant", () => {
    const html = renderToStaticMarkup(
      createElement(RedundantChainsNotice, {
        redundantChains: [
          chain("bot-a"),
          chain("bot-b", { name: "Scout", redundant: [{ instanceId: "grok", model: "grok-4", reason: "duplicate" }] }),
        ],
      }),
    );
    expect(html).toContain("2 Bots&#x27; Fallback Chains Are Shorter Than They Look");
    expect(html).toContain("is the primary again");
    expect(html).toContain("repeats an earlier entry");
  });
});
