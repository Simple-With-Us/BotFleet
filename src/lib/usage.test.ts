import { describe, expect, it } from "vitest";

import { botUsage, botUsageByModel, cachedInput, costCaption, formatTokens, formatUsd, sumUsage, usageChip, usageDetail } from "./usage";

describe("usage formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
  });

  it("keeps small dollar amounts visible", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$0.004");
    expect(formatUsd(0.31)).toBe("$0.31");
  });

  it("does not throw on missing usage fields from older bots.json", () => {
    expect(formatUsd(undefined as unknown as number)).toBe("");
    expect(formatTokens(undefined as unknown as number)).toBe("0");
    expect(
      usageChip({ input: 100, output: 20, turns: 1 } as { input: number; output: number; costUsd: null; turns: number }),
    ).toBe("120 tok");
  });

  it("treats NaN and Infinity cost as missing", () => {
    expect(formatUsd(Number.NaN)).toBe("");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.NaN, turns: 1 })).toBe("120 tok");
    expect(usageChip({ input: 100, output: 20, costUsd: Number.POSITIVE_INFINITY, turns: 1 })).toBe("120 tok");
    expect(
      sumUsage([
        { input: 1, output: 1, costUsd: Number.NaN, turns: 1 },
        { input: 2, output: 2, costUsd: 0.01, turns: 1 },
      ]),
    ).toEqual({ input: 3, output: 3, costUsd: 0.01, turns: 2 });
  });

  it("carries the cached share through sums and names it in the breakdown", () => {
    // records from before the field existed simply don't contribute to it
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }, { input: 200, output: 20, cachedInput: 150, costUsd: null, turns: 1 }]))
      .toEqual({ input: 300, output: 30, cachedInput: 150, costUsd: null, turns: 2 });
    expect(sumUsage([{ input: 100, output: 10, costUsd: null, turns: 1 }])).toEqual({ input: 100, output: 10, costUsd: null, turns: 1 });
    // the headline stays the whole figure; the split is what explains it
    expect(usageDetail({ input: 88_200, output: 1_200, cachedInput: 79_000, costUsd: null, turns: 5 })).toBe("88.2k in (79k cached) · 1.2k out");
    expect(usageDetail({ input: 900, output: 50, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    expect(usageDetail({ input: 900, output: 50, cachedInput: 0, costUsd: null, turns: 1 })).toBe("900 in · 50 out");
    // a cached figure can never exceed the input it is part of, or go negative
    expect(cachedInput({ input: 100, output: 0, cachedInput: 250, costUsd: null, turns: 1 })).toBe(100);
    expect(cachedInput({ input: 100, output: 0, cachedInput: -3, costUsd: null, turns: 1 })).toBe(0);
    expect(cachedInput({ input: 100, output: 0, cachedInput: Number.NaN, costUsd: null, turns: 1 })).toBe(0);
  });

  it("builds the chip: tokens always, cost only when known, nothing when unused", () => {
    expect(usageChip({ input: 0, output: 0, costUsd: null, turns: 0 })).toBe("");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: null, turns: 3 })).toBe("12.4k tok");
    expect(usageChip({ input: 10_000, output: 2_400, costUsd: 0.06, turns: 3 })).toBe("12.4k tok · $0.06");
  });

  it("sums across tasks and leaves cost null until one reports it", () => {
    expect(sumUsage([{ input: 1, output: 1, costUsd: null, turns: 1 }, undefined, { input: 2, output: 2, costUsd: null, turns: 1 }])).toEqual({
      input: 3,
      output: 3,
      costUsd: null,
      turns: 2,
    });
    expect(
      botUsage({
        tasks: [
          { threadId: "a", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: 0.01, turns: 1 } },
          { threadId: "b", title: "", createdAt: 0 },
          { threadId: "c", title: "", createdAt: 0, usage: { input: 5, output: 5, costUsd: null, turns: 2 } },
        ],
      }),
    ).toEqual({ input: 10, output: 10, costUsd: 0.01, turns: 3 });
  });

  it("captions cost by billing", () => {
    expect(costCaption("subscription")).toMatch(/not billed/);
    expect(costCaption("metered")).toMatch(/API key/);
    expect(costCaption(undefined)).toMatch(/reported/);
  });

  describe("botUsageByModel", () => {
    it("breaks down usage by model with accurate turns, tokens, and costs", () => {
      const bot = {
        modelSelection: { instanceId: "claude", model: "claude-3-7-sonnet" },
        tasks: [
          {
            threadId: "task-1",
            title: "Task 1",
            createdAt: 100,
            usage: { input: 1000, output: 200, cachedInput: 500, costUsd: 0.05, turns: 5 },
            usageByInstance: {
              claude: {
                input: 1000,
                output: 200,
                costUsd: 0.05,
                turns: 5,
                byModel: {
                  "claude-3-7-sonnet": { input: 600, output: 120, cachedInput: 300, costUsd: 0.03, turns: 3 },
                  "claude-3-5-haiku": { input: 400, output: 80, cachedInput: 200, costUsd: 0.02, turns: 2 },
                },
              },
            },
          },
        ],
      };

      const breakdown = botUsageByModel(bot);
      expect(breakdown).toHaveLength(2);
      expect(breakdown[0]).toEqual({
        model: "claude-3-7-sonnet",
        usage: { input: 600, output: 120, cachedInput: 300, costUsd: 0.03, turns: 3 },
        perTurnCost: 0.01,
      });
      expect(breakdown[1]).toEqual({
        model: "claude-3-5-haiku",
        usage: { input: 400, output: 80, cachedInput: 200, costUsd: 0.02, turns: 2 },
        perTurnCost: 0.01,
      });

      // Verify the sum equals botUsage(bot)
      const totalFromModels = sumUsage(breakdown.map((m) => m.usage));
      expect(totalFromModels).toEqual(botUsage(bot));
    });

    it("attributes unbanked legacy turns to configured model", () => {
      const bot = {
        modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
        tasks: [
          {
            threadId: "legacy-task",
            title: "Legacy Task",
            createdAt: 100,
            usage: { input: 800, output: 100, cachedInput: 400, costUsd: 0.04, turns: 4 },
            modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
          },
        ],
      };

      const breakdown = botUsageByModel(bot);
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].model).toBe("MiniMax-M3");
      expect(breakdown[0].usage).toEqual({
        input: 800,
        output: 100,
        cachedInput: 400,
        costUsd: 0.04,
        turns: 4,
      });
      expect(breakdown[0].perTurnCost).toBe(0.01);
      expect(sumUsage(breakdown.map((m) => m.usage))).toEqual(botUsage(bot));
    });

    it("separates MiniMax-M3 from DeepSeek models in DSH usage", () => {
      const bot = {
        modelSelection: { instanceId: "dsh", model: "deepseek-chat" },
        tasks: [
          {
            threadId: "dsh-task",
            title: "DSH Multi-Model Task",
            createdAt: 100,
            usage: { input: 1500, output: 300, cachedInput: 600, costUsd: 0.03, turns: 3 },
            usageByInstance: {
              dsh: {
                engineId: "deepseek-harness",
                input: 1500,
                output: 300,
                costUsd: 0.03,
                turns: 3,
                byModel: {
                  "MiniMax-M3": { input: 1000, output: 200, cachedInput: 400, costUsd: 0.02, turns: 2 },
                  "deepseek-chat": { input: 500, output: 100, cachedInput: 200, costUsd: 0.01, turns: 1 },
                },
              },
            },
          },
        ],
      };

      const breakdown = botUsageByModel(bot);
      expect(breakdown).toHaveLength(2);
      expect(breakdown.map((m) => m.model)).toEqual(["MiniMax-M3", "deepseek-chat"]);
      expect(breakdown[0].usage.turns).toBe(2);
      expect(breakdown[1].usage.turns).toBe(1);
      expect(sumUsage(breakdown.map((m) => m.usage))).toEqual(botUsage(bot));
    });

    it("includes shared room turns and attributes byModel", () => {
      const bot = {
        modelSelection: { instanceId: "minimax", model: "MiniMax-M3" },
        tasks: [],
        roomUsageByInstance: {
          minimax: {
            input: 300,
            output: 50,
            costUsd: 0.01,
            turns: 2,
            lastAt: 200,
            byModel: {
              "MiniMax-M3": { input: 300, output: 50, costUsd: 0.01, turns: 2 },
            },
          },
        },
      };

      const breakdown = botUsageByModel(bot);
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].model).toBe("MiniMax-M3");
      expect(breakdown[0].usage.turns).toBe(2);
      expect(sumUsage(breakdown.map((m) => m.usage))).toEqual(botUsage(bot));
    });
  });
});
