// Shared gate for the advertised model-fallback chain.  A primary that
// merely *started* a tool (or showed a working/retry chip) has not produced
// assistant output, so the next saved engine must still be tried.  Quota,
// usage-cap, and session-limit chips force the saved chain even when tools
// already ran — those turns did not finish the user's request.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";

/** Fleet priority for the one-step chain offered when a bot has configured no
 * fallbacks of its own (#90).  These are INSTANCE ids, not driver kinds, and
 * anything absent sorts last — which is exactly why both DeepSeek rails were
 * unreachable in practice: a fleet with any higher entry enabled never got
 * past it.  Order is deliberate, so changing it is a decision, not a tidy-up.
 */
export const AUTO_FALLBACK_PRIORITY: readonly string[] = [
  "claude",
  "antigravity",
  "gemini",
  "codex",
  "dsh",
  "deepseek",
  "openaiCompat",
  "grok",
];

export interface FallbackScanMessage {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

export interface TurnFallbackPick extends ModelSelection {
  /** Index in the saved chain to start from on the next failure. */
  nextUsed: number;
}

const SHORT_PROVIDER_ERROR =
  /session limit|rate.?limit|too many requests|overloaded|capacity|internal server error|bad gateway|service unavailable|account_inactive|quota|usage cap|usage limit|credits exhausted|insufficient.?balance|out of (?:usage|credits)|resource_exhausted|slow pool|daily limit|\b429\b/i;

// Official provider chips (docs + observed CLIs).  Keep this in sync with
// the corpus in model-fallback.test.ts.  Do not match "approaching … limit"
// warnings — those are near-cap, not a hit.
const QUOTA_OR_CAP =
  /session limit|hit your session limit|hit your usage limit|usage cap|usage limit|quota exceeded|insufficient.?quota|insufficient.?balance|insufficient.?funds|zero balance|resource.?exhausted|resource.{0,24}exhausted|resource_exhausted|exhausted your.*quota|daily quota|credits exhausted|credits? (?:are )?depleted|credits? (?:exhausted|depleted|empty|insufficient|zero)|out of (?:usage|credits)|credit balance (?:is )?(?:too )?low|message limit reached|messaging allowance|5-hour limit reached|reached your .{0,80}limit|monthly limit|weekly (?:\([^)]+\) )?usage limit|slow pool|upgrade (?:your )?plan|upgrade to (?:plus|pro)|\b402\b|\b429\b|\bbilling\b|\bsubscription\b|payment required|plan limit|tier limit|free tier limit|spend limit|budget exceeded|rate.?limit|rate_limit_error|usage_limit_exceeded|too many requests|overloaded|capacity|concurrency limit|account_inactive|enforced_spend_limit/i;

const QUOTA_TEXT_MAX = 500;

/** Short error-chip text that must not count as a real assistant reply. */
export function isShortProviderErrorText(text: string): boolean {
  const trimmed = text.trim();
  return SHORT_PROVIDER_ERROR.test(trimmed) && trimmed.length < 300;
}

/** Quota, usage-cap, or session-limit chip — including Grok's
 * "You've hit your session limit · resets …" line. */
export function isQuotaOrCapText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length >= QUOTA_TEXT_MAX) return false;
  return QUOTA_OR_CAP.test(trimmed);
}

export function lastUserTextIndex(messages: FallbackScanMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].kind === "text") return i;
  }
  return -1;
}

/** True when the only bot text after the user is a short provider error chip. */
export function sliceIsShortProviderError(messagesAfterUser: FallbackScanMessage[]): boolean {
  const botReplies = messagesAfterUser.filter(
    (message) => message.role === "bot" && message.kind === "text" && typeof message.text === "string",
  );
  if (botReplies.length !== 1 || typeof botReplies[0].text !== "string") return false;
  return isShortProviderErrorText(botReplies[0].text);
}

/** True when this turn ended on a quota / usage-cap / session-limit chip. */
export function turnHitQuotaOrCap(messagesAfterUser: FallbackScanMessage[]): boolean {
  const botTexts = messagesAfterUser.filter(
    (message) => message.role === "bot" && message.kind === "text" && typeof message.text === "string",
  );
  if (botTexts.length > 0) {
    const last = botTexts[botTexts.length - 1];
    if (typeof last.text === "string" && isQuotaOrCapText(last.text)) return true;
  }
  return messagesAfterUser.some((message) => {
    if (message.role !== "bot" || message.kind !== "activity") return false;
    const name = message.tool?.name ?? "";
    return /error:/i.test(name) && isQuotaOrCapText(name);
  });
}

/**
 * Whether this user turn already produced real assistant output.
 * Counts only non-error text and terminal tool results (`tool.ok === true`).
 * Tool-start chips (`ok` undefined), failed tools, screens, and working/retry
 * activity never count — those are how a 401 after a tool-start used to
 * skip the fallback chain.
 */
export function turnProducedAssistantOutput(
  messagesAfterUser: FallbackScanMessage[],
  opts: { textIsError?: boolean } = {},
): boolean {
  const textIsError = opts.textIsError === true;
  return messagesAfterUser.some((message) => {
    if (message.role !== "bot") return false;
    if (message.kind === "text") return !textIsError;
    if (message.kind !== "activity") return false;
    if (message.tool?.ok !== true) return false;
    const name = message.tool.name ?? "";
    if (/^(retrying|working)\b/i.test(name)) return false;
    return true;
  });
}

function sameEngine(a: { instanceId: string; model: string }, b: { instanceId: string; model: string }): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

/** Next saved fallback engine, or undefined when this turn must not fail over.
 * Quota/cap chips ignore prior tool activity.  Chain entries that match the
 * current primary are skipped so a same-model fallback cannot loop. */
export function selectTurnFallback(input: {
  ok: boolean;
  stopReason?: string | null;
  produced: boolean;
  quotaOrCap?: boolean;
  fallbacks?: ModelSelection[] | null;
  used: number;
  current?: { instanceId: string; model: string } | null;
}): TurnFallbackPick | undefined {
  if (input.ok) return undefined;
  if (input.stopReason === "interrupted" || input.stopReason === "cancelled") return undefined;
  if (input.produced && !input.quotaOrCap) return undefined;
  const chain = input.fallbacks;
  if (!chain?.length) return undefined;
  const start = Math.max(0, input.used);
  for (let i = start; i < chain.length; i++) {
    const next = chain[i];
    if (!next?.instanceId) continue;
    if (input.current && sameEngine(next, input.current)) continue;
    return { instanceId: next.instanceId, model: next.model, effort: next.effort, nextUsed: i + 1 };
  }
  return undefined;
}

export interface QuotaResetInfo {
  isQuotaOrCap: boolean;
  resetsAt?: number | null;
  rawTimeText?: string;
}

export interface BotQuotaCooldown {
  botId: string;
  instanceId: string;
  model: string;
  resetsAt?: number | null;
  error: string;
  recordedAt: number;
  /** Who wrote this row: a provider chip, or `antigravity-usage`. */
  source?: string;
}

function computeNextOccurrence(targetHour: number, targetMinute: number, tz: string | undefined, now: number): number {
  if (tz) {
    try {
      // Find candidate timestamp within the next 36 hours matching the hour:minute in that tz
      for (let offsetMinutes = 1; offsetMinutes <= 36 * 60; offsetMinutes++) {
        const candidate = new Date(now + offsetMinutes * 60 * 1000);
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "numeric",
          hour12: false,
        });
        const parts = formatter.formatToParts(candidate);
        const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "-1", 10);
        const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "-1", 10);
        if (h === targetHour && m === targetMinute) {
          candidate.setSeconds(0, 0);
          return candidate.getTime();
        }
      }
    } catch {
      // Timezone string unrecognized: fall through to local time
    }
  }
  const date = new Date(now);
  date.setHours(targetHour, targetMinute, 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

/** Parses quota reset time from provider error chips or text replies. */
export function parseQuotaResetTime(text: string, now = Date.now()): QuotaResetInfo {
  const isCap = isQuotaOrCapText(text);
  if (!isCap) return { isQuotaOrCap: false };

  // Relative duration: "resets in 35 minutes", "retry after 60s", "retry-after: 120"
  const relMatch = text.match(/\b(?:resets? in|try again in|retry after|retry-after:?)\s*(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)?/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = (relMatch[2] || "s").toLowerCase();
    let ms = amount * 1000;
    if (unit.startsWith("m") && !unit.startsWith("ms")) ms = amount * 60 * 1000;
    else if (unit.startsWith("h")) ms = amount * 3600 * 1000;
    else if (unit.startsWith("d")) ms = amount * 86400 * 1000;
    return { isQuotaOrCap: true, resetsAt: now + ms, rawTimeText: relMatch[0] };
  }

  // Time of day: "resets 12:10am (America/Chicago)", "resets at 3:00 PM"
  const timeMatch = text.match(/\bresets?(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(am|pm)(?:\s*\(([^)]+)\))?/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3].toLowerCase();
    const tz = timeMatch[4]?.trim();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const resetsAt = computeNextOccurrence(hour, minute, tz, now);
    return { isQuotaOrCap: true, resetsAt, rawTimeText: timeMatch[0] };
  }

  // Midnight UTC: "resets at midnight UTC", "resets 00:00 UTC"
  if (/\b(?:resets? (?:at )?midnight|resets? 00:00)\s*(?:UTC)?/i.test(text)) {
    const d = new Date(now);
    d.setUTCHours(24, 0, 0, 0);
    return { isQuotaOrCap: true, resetsAt: d.getTime(), rawTimeText: "midnight UTC" };
  }

  return { isQuotaOrCap: true, resetsAt: null };
}

export class QuotaCooldownRegistry {
  private readonly cooldowns = new Map<string, BotQuotaCooldown>();
  private persistPath: string | null = null;
  private persistImpl: ((path: string, json: string) => void) | null = null;

  enablePersist(path: string, write?: (path: string, json: string) => void): void {
    this.persistPath = path;
    this.persistImpl = write ?? null;
    this.load();
  }

  private persist(): void {
    if (!this.persistPath) return;
    const body = JSON.stringify({ version: 1, cooldowns: [...this.cooldowns.values()] });
    if (this.persistImpl) {
      this.persistImpl(this.persistPath, body);
      return;
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileAtomic(this.persistPath, body);
    } catch {
      /* a failed persist must not break a turn */
    }
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!existsSync(this.persistPath)) return;
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as {
        version?: number;
        cooldowns?: BotQuotaCooldown[];
      };
      if (!Array.isArray(parsed.cooldowns)) return;
      const now = Date.now();
      for (const cd of parsed.cooldowns) {
        if (!cd || typeof cd !== "object") continue;
        if (typeof cd.botId !== "string" || typeof cd.instanceId !== "string" || typeof cd.model !== "string") continue;
        if (cd.resetsAt && now >= cd.resetsAt) continue;
        this.cooldowns.set(`${cd.botId}:${cd.instanceId}:${cd.model}`, cd);
      }
    } catch {
      /* corrupt file = empty registry */
    }
  }

  record(cooldown: BotQuotaCooldown): void {
    this.cooldowns.set(`${cooldown.botId}:${cooldown.instanceId}:${cooldown.model}`, cooldown);
    this.persist();
  }

  recordInstanceCap(
    instanceId: string,
    model = "*",
    opts: { resetsAt?: number | null; error?: string; source?: string } = {},
  ): void {
    const cd: BotQuotaCooldown = {
      botId: "*",
      instanceId,
      model,
      resetsAt: opts.resetsAt ?? null,
      error: opts.error ?? "Session limit or usage cap reached",
      recordedAt: Date.now(),
      source: opts.source,
    };
    this.cooldowns.set(`*:${instanceId}:${model}`, cd);
    this.persist();
  }

  get(botId: string, instanceId: string, model: string, now = Date.now()): BotQuotaCooldown | undefined {
    const key = `${botId}:${instanceId}:${model}`;
    const cd = this.cooldowns.get(key) ?? this.cooldowns.get(`*:${instanceId}:${model}`) ?? this.cooldowns.get(`*:${instanceId}:*`);
    if (!cd) return undefined;
    if (cd.resetsAt && now >= cd.resetsAt) {
      if (this.cooldowns.get(key) === cd) this.cooldowns.delete(key);
      if (this.cooldowns.get(`*:${instanceId}:${model}`) === cd) this.cooldowns.delete(`*:${instanceId}:${model}`);
      if (this.cooldowns.get(`*:${instanceId}:*`) === cd) this.cooldowns.delete(`*:${instanceId}:*`);
      this.persist();
      return undefined;
    }
    return cd;
  }

  list(now = Date.now()): BotQuotaCooldown[] {
    const active: BotQuotaCooldown[] = [];
    let expired = false;
    for (const [key, cd] of [...this.cooldowns.entries()]) {
      if (cd.resetsAt && now >= cd.resetsAt) {
        this.cooldowns.delete(key);
        expired = true;
      } else {
        active.push(cd);
      }
    }
    if (expired) this.persist();
    return active;
  }

  /** Any live cooldown for this engine, including per-bot and per-model
   * records.  The picker used to look up only `*:instance:*`, so Cursor
   * and Antigravity stayed "Available" after a real cap on one model. */
  forInstance(instanceId: string, now = Date.now()): BotQuotaCooldown | undefined {
    return this.list(now).find((cd) => cd.instanceId === instanceId);
  }

  clear(botId: string, instanceId?: string, model?: string): void {
    if (instanceId && model) {
      this.cooldowns.delete(`${botId}:${instanceId}:${model}`);
      this.persist();
      return;
    }
    for (const key of this.cooldowns.keys()) {
      if (key.startsWith(`${botId}:`)) {
        this.cooldowns.delete(key);
      }
    }
    this.persist();
  }

  clearWhere(predicate: (cooldown: BotQuotaCooldown) => boolean): void {
    let changed = false;
    for (const [key, cd] of [...this.cooldowns.entries()]) {
      if (!predicate(cd)) continue;
      this.cooldowns.delete(key);
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * Returns the effective model selection for a bot.
   * If the primary model is on active quota cooldown (and has not reached its reset time),
   * returns the first available fallback model.
   * Once the reset time has passed, returns the primary model.
   */
  resolveModel(
    botId: string,
    primary: ModelSelection,
    now = Date.now(),
  ): { selection: ModelSelection; isFallback: boolean; cooldown?: BotQuotaCooldown } {
    const cd = this.get(botId, primary.instanceId, primary.model, now);
    if (!cd) {
      return { selection: primary, isFallback: false };
    }
    const fallbacks = primary.fallbacks;
    if (fallbacks && fallbacks.length > 0) {
      for (const fb of fallbacks) {
        if (!this.get(botId, fb.instanceId, fb.model, now)) {
          return { selection: fb, isFallback: true, cooldown: cd };
        }
      }
    }
    return { selection: primary, isFallback: false, cooldown: cd };
  }
}

export const quotaCooldowns = new QuotaCooldownRegistry();

export function enableQuotaCooldownPersist(path: string): void {
  quotaCooldowns.enablePersist(path);
}

