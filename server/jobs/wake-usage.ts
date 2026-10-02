// What job wake turns cost (jobs P1,
// docs/plans/2026-10-01-background-jobs-and-subagents-decision.md, Risks:
// "Tokens per wake are tracked from P1").
//
// A wake turn starts with nobody watching and often with a cold prompt cache,
// so its cost is the number that decides whether jobs go on for CLI bots in
// P2.  The ordinary usage paths (task usage, the rolling spend window, Usage
// Monitor telemetry) cannot tell a wake from any other turn, so the turn fold
// hands every settled wake here as well: running totals, overall and per bot,
// kept in `<data folder>/jobs/wake-usage.json` and read back at
// `GET /api/jobs/wake-usage`.
//
// Totals only — never a prompt, a reply or any output.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

export interface WakeUsageTotals {
  wakes: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Turns that reported a cost, and what they cost in total. */
  pricedWakes: number;
  costUsd: number;
}

export interface WakeUsageSnapshot extends WakeUsageTotals {
  /** When the first wake was counted (epoch ms), or null before any. */
  since: number | null;
  byBot: Record<string, WakeUsageTotals>;
}

export interface WakeTurnUsage {
  botId: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number | null;
}

const Totals = z.object({
  wakes: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  pricedWakes: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});
const Stored = Totals.extend({ since: z.number().nullable(), byBot: z.record(z.string(), Totals) });

const empty = (): WakeUsageTotals => ({ wakes: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, pricedWakes: 0, costUsd: 0 });

const count = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 0);

function add(totals: WakeUsageTotals, usage: WakeTurnUsage): void {
  totals.wakes += 1;
  totals.inputTokens += count(usage.inputTokens);
  totals.outputTokens += count(usage.outputTokens);
  totals.cachedInputTokens += count(usage.cachedInputTokens);
  const cost = usage.costUsd ?? null;
  if (cost !== null && Number.isFinite(cost) && cost >= 0) {
    totals.pricedWakes += 1;
    totals.costUsd += cost;
  }
}

export class JobWakeUsage {
  private readonly path: string;
  private readonly now: () => number;
  private state: WakeUsageSnapshot;

  constructor(dir: string, now: () => number = Date.now) {
    this.path = join(dir, "wake-usage.json");
    this.now = now;
    this.state = this.load();
  }

  private load(): WakeUsageSnapshot {
    try {
      const parsed = Stored.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      /* none yet, or unreadable: start counting again */
    }
    return { ...empty(), since: null, byBot: {} };
  }

  /** One settled wake turn. */
  record(usage: WakeTurnUsage): void {
    this.state.since ??= this.now();
    add(this.state, usage);
    add((this.state.byBot[usage.botId] ??= empty()), usage);
    this.persist();
  }

  /** Drop the per-bot rows of bots that no longer exist.  The overall totals
   *  keep what their wakes cost: that money was spent. */
  retainBots(isKnown: (botId: string) => boolean): void {
    let changed = false;
    for (const botId of Object.keys(this.state.byBot)) {
      if (isKnown(botId)) continue;
      delete this.state.byBot[botId];
      changed = true;
    }
    if (changed) this.persist();
  }

  snapshot(): WakeUsageSnapshot {
    return structuredClone(this.state);
  }

  private persist(): void {
    try {
      writeFileAtomic(this.path, JSON.stringify(this.state), { mode: 0o600 });
    } catch {
      /* the totals are a measurement; losing one write never stops a turn */
    }
  }
}
