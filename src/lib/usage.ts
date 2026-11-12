// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { TaskUsage } from "@/state/store";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };

/** True when a stored cost is a real number (not null, NaN, or Infinity). */
export function hasFiniteCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Sum a set of usages; cost stays null until any of them has one. */
export function sumUsage(items: Array<TaskUsage | undefined>): TaskUsage {
  const out: TaskUsage = { ...EMPTY_USAGE };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input;
    out.output += u.output;
    out.turns += u.turns;
    if (hasFiniteCost(u.cachedInput)) out.cachedInput = (out.cachedInput ?? 0) + u.cachedInput;
    if (hasFiniteCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  return out;
}

export interface BotLikeForUsage {
  tasks?: ReadonlyArray<{
    threadId?: string;
    title?: string;
    createdAt?: number;
    usage?: TaskUsage;
    usageByInstance?: Record<string, TaskUsage & { engineId?: string; byModel?: Record<string, TaskUsage> }>;
    modelSelection?: { instanceId?: string; model?: string };
  }>;
  roomUsageByInstance?: Record<string, TaskUsage & { lastAt?: number; engineId?: string; byModel?: Record<string, TaskUsage> }>;
  modelSelection?: { instanceId?: string; model?: string };
}

export function botUsage(bot: BotLikeForUsage): TaskUsage {
  // Room turns bank per engine on the speaking bot (they have no task
  // thread of their own); the bot's totals include them.
  return sumUsage([
    ...(bot.tasks ?? []).map((t) => t.usage),
    ...Object.values(bot.roomUsageByInstance ?? {}),
  ]);
}

export interface ModelUsageSummary {
  model: string;
  usage: TaskUsage;
  perTurnCost: number | null;
}

/** Break down a bot's lifetime usage by the model that actually ran each turn.
 *  Attribution prefers per-instance banked `byModel` splits, falling back to
 *  the task/bot configured model for older unbanked turns so all history is
 *  accounted for. */
export function botUsageByModel(bot: BotLikeForUsage): ModelUsageSummary[] {
  const byModelMap = new Map<string, TaskUsage>();

  const recordUsage = (model: string, delta: TaskUsage) => {
    if ((delta.turns ?? 0) <= 0 && delta.input + delta.output <= 0) return;
    const existing = byModelMap.get(model);
    if (!existing) {
      byModelMap.set(model, {
        input: delta.input,
        output: delta.output,
        turns: delta.turns ?? 0,
        cachedInput: hasFiniteCost(delta.cachedInput) ? delta.cachedInput : undefined,
        costUsd: hasFiniteCost(delta.costUsd) ? delta.costUsd : null,
      });
    } else {
      existing.input += delta.input;
      existing.output += delta.output;
      existing.turns += delta.turns ?? 0;
      if (hasFiniteCost(delta.cachedInput)) {
        existing.cachedInput = (existing.cachedInput ?? 0) + delta.cachedInput;
      }
      if (hasFiniteCost(delta.costUsd)) {
        existing.costUsd = (existing.costUsd ?? 0) + delta.costUsd;
      }
    }
  };

  // 1. Walk every task and its per-instance byModel breakdown
  for (const task of bot.tasks ?? []) {
    const taskUsage = task.usage;
    if (!taskUsage || ((taskUsage.turns ?? 0) <= 0 && taskUsage.input + taskUsage.output <= 0)) {
      continue;
    }
    let bankedTurns = 0;
    let bankedInput = 0;
    let bankedOutput = 0;
    let bankedCached = 0;
    let bankedCost = 0;

    for (const bucket of Object.values(task.usageByInstance ?? {})) {
      for (const [modelName, mUsage] of Object.entries(bucket.byModel ?? {})) {
        const turns = mUsage.turns ?? 0;
        const input = mUsage.input ?? 0;
        const output = mUsage.output ?? 0;
        if (turns <= 0 && input + output <= 0) continue;
        recordUsage(modelName, mUsage);
        bankedTurns += turns;
        bankedInput += input;
        bankedOutput += output;
        bankedCached += cachedInput(mUsage);
        if (hasFiniteCost(mUsage.costUsd)) bankedCost += mUsage.costUsd;
      }
    }

    // Remainder not banked in byModel (e.g. pre-upgrade turns)
    const taskTurns = taskUsage.turns ?? 0;
    if (bankedTurns < taskTurns || bankedInput + bankedOutput < taskUsage.input + taskUsage.output) {
      const remTurns = Math.max(0, taskTurns - bankedTurns);
      const remInput = Math.max(0, taskUsage.input - bankedInput);
      const remOutput = Math.max(0, taskUsage.output - bankedOutput);
      const remCached = Math.max(0, cachedInput(taskUsage) - bankedCached);
      const remCost = hasFiniteCost(taskUsage.costUsd) ? Math.max(0, (taskUsage.costUsd ?? 0) - bankedCost) : null;
      const fallbackModel = task.modelSelection?.model || bot.modelSelection?.model || "default";
      recordUsage(fallbackModel, {
        input: remInput,
        output: remOutput,
        cachedInput: remCached > 0 ? remCached : undefined,
        costUsd: remCost,
        turns: remTurns,
      });
    }
  }

  // 2. Walk shared room turns
  for (const [instanceId, roomBucket] of Object.entries(bot.roomUsageByInstance ?? {})) {
    const roomTurns = roomBucket.turns ?? 0;
    if (roomTurns <= 0 && roomBucket.input + roomBucket.output <= 0) continue;
    let bankedTurns = 0;
    let bankedInput = 0;
    let bankedOutput = 0;
    let bankedCached = 0;
    let bankedCost = 0;

    for (const [modelName, mUsage] of Object.entries(roomBucket.byModel ?? {})) {
      const turns = mUsage.turns ?? 0;
      const input = mUsage.input ?? 0;
      const output = mUsage.output ?? 0;
      if (turns <= 0 && input + output <= 0) continue;
      recordUsage(modelName, mUsage);
      bankedTurns += turns;
      bankedInput += input;
      bankedOutput += output;
      bankedCached += cachedInput(mUsage);
      if (hasFiniteCost(mUsage.costUsd)) bankedCost += mUsage.costUsd;
    }

    if (bankedTurns < roomTurns || bankedInput + bankedOutput < roomBucket.input + roomBucket.output) {
      const remTurns = Math.max(0, roomTurns - bankedTurns);
      const remInput = Math.max(0, roomBucket.input - bankedInput);
      const remOutput = Math.max(0, roomBucket.output - bankedOutput);
      const remCached = Math.max(0, cachedInput(roomBucket) - bankedCached);
      const remCost = hasFiniteCost(roomBucket.costUsd) ? Math.max(0, (roomBucket.costUsd ?? 0) - bankedCost) : null;
      const fallbackModel = roomBucket.engineId || instanceId || "room";
      recordUsage(fallbackModel, {
        input: remInput,
        output: remOutput,
        cachedInput: remCached > 0 ? remCached : undefined,
        costUsd: remCost,
        turns: remTurns,
      });
    }
  }

  return Array.from(byModelMap.entries())
    .map(([model, usage]) => {
      const turnCount = usage.turns || 0;
      const perTurnCost = hasFiniteCost(usage.costUsd) && turnCount > 0 ? (usage.costUsd ?? 0) / turnCount : null;
      return { model, usage, perTurnCost };
    })
    .sort((a, b) => {
      const costOf = (v: number | null | undefined) => (hasFiniteCost(v) ? v : Number.NEGATIVE_INFINITY);
      return (
        costOf(b.usage.costUsd) - costOf(a.usage.costUsd) ||
        b.usage.input + b.usage.output - (a.usage.input + a.usage.output) ||
        b.usage.turns - a.usage.turns
      );
    });
}

/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M" */
export function formatTokens(n: number): string {
  if (!hasFiniteCost(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

/** Dollars, with enough precision that a cheap turn isn't "$0.00". */
export function formatUsd(usd: number): string {
  if (!hasFiniteCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** How much of `input` the provider served from its prompt cache. Clamped to
 * `input` so a provider that reports cache reads outside its input figure
 * can never produce a negative "fresh" number. */
export function cachedInput(u: TaskUsage): number {
  return hasFiniteCost(u.cachedInput) ? Math.min(Math.max(0, u.cachedInput), u.input) : 0;
}

/** The in/out breakdown behind the headline figure, with the cached share
 * called out when there is one: "88.2k in (79k cached) · 1.2k out". The
 * headline counts every token the model processed — five short messages
 * on a thread with a system prompt and tool schemas really do cost the
 * model ~17k tokens of reading each turn — so the breakdown is where the
 * "was that really 100k?" question gets answered. */
export function usageDetail(u: TaskUsage): string {
  const cached = cachedInput(u);
  const input = cached > 0 ? `${formatTokens(u.input)} in (${formatTokens(cached)} cached)` : `${formatTokens(u.input)} in`;
  return `${input} · ${formatTokens(u.output)} out`;
}

/** The chip text: tokens, and cost when known. Empty string when nothing
 * has been spent — a fresh task shows no chip. */
export function usageChip(u: TaskUsage): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  const parts = [`${formatTokens(u.input + u.output)} tok`];
  if (hasFiniteCost(u.costUsd)) parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return "equivalent — on your subscription, not billed";
  if (billing === "metered") return "billed to your API key";
  return "as reported by the engine";
}
