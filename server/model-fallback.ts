// Shared gate for the advertised model-fallback chain.  A primary that
// merely *started* a tool (or showed a working/retry chip) has not produced
// assistant output, so the next saved engine must still be tried.  Quota,
// usage-cap, and session-limit chips force the saved chain even when tools
// already ran — those turns did not finish the user's request.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { STATIC_ANTIGRAVITY_MODELS } from "./antigravity-models.ts";
import { STATIC_CLAUDE_MODELS } from "./claude-models.ts";
import { writeFileAtomic } from "./atomic.ts";
import { doomedDispatches } from "./doomed-dispatch.ts";
import { modelRejections, type ModelRejectionGate } from "./model-rejections.ts";
import type { ModelSelection, ProviderErrorCode } from "./contracts.ts";

/** Antigravity offers no 3.1 Flash, so a naive -pro -> -flash rewrite of
 *  gemini-3.1-pro-high/low yields ids the engine rejects.  Prefer the
 *  same-family Flash when the catalog has one (2.5), else the newest Flash
 *  at the same tier, else the catalog default. */
const ANTIGRAVITY_FLASH_BY_TIER: Record<string, string> = {
  high: "gemini-3.8-flash-high",
  medium: "gemini-3.8-flash-medium",
  low: "gemini-3.8-flash-low",
};

function antigravityFlashModel(model: string): string {
  // Only built-in catalog routes are swapped.  A custom or local-inject
  // model the operator configured (any id outside the static catalog, even
  // one containing "-pro") is their chosen route and stays as configured.
  if (!STATIC_ANTIGRAVITY_MODELS.options.some((option) => option.id === model)) return model;
  const candidate = model.replace("-pro", "-flash");
  if (candidate === model) return model;
  if (STATIC_ANTIGRAVITY_MODELS.options.some((option) => option.id === candidate)) {
    return candidate;
  }
  const tier = /-(high|medium|low)$/.exec(model)?.[1];
  return (tier && ANTIGRAVITY_FLASH_BY_TIER[tier]) || STATIC_ANTIGRAVITY_MODELS.default;
}

const OFFICIAL_CLAUDE_SONNET_OPUS_ID = /^claude-(sonnet|opus)-\d+(-\d+)?(-\d{8})?$/;

function isBuiltInClaudeSonnetOrOpus(model: string): boolean {
  if (!/^claude-(sonnet|opus)-/.test(model)) return false;
  return (
    STATIC_CLAUDE_MODELS.options.some((option) => option.id === model) ||
    OFFICIAL_CLAUDE_SONNET_OPUS_ID.test(model)
  );
}

/** A DSH Pro route cannot read images. Replace it throughout the saved chain
 * when switching an image turn to Flash so no stale Pro fallback can retry
 * the same image prompt. Other engines and models remain untouched. */
export function dshVisionSelection(chain: ModelSelection): ModelSelection {
  const switchPro = (entry: ModelSelection): ModelSelection =>
    entry.instanceId === "dsh" && entry.model === "DeepSeek-V4.1-Pro"
      ? { ...entry, model: "DeepSeek-V4.1-Flash" }
      : entry;
  return {
    ...switchPro(chain),
    ...(chain.fallbacks ? { fallbacks: chain.fallbacks.map(switchPro) } : {}),
  };
}

/** A turn inherits the bot's unattended mark only when it continues work that
 *  mark covers: a card continuation or delegated (commsDepth > 0) work.  A
 *  scheduled or manual run, or a typed turn, is decided by its own automation
 *  source, so a webhook's leftover mark (30 min TTL) cannot silently drop it
 *  to the unattended model.  An explicit caller flag always wins. */
export function inheritedUnattended(
  opts: { unattended?: boolean; cardContinuation?: boolean; commsDepth?: number } | undefined,
  isMarked: () => boolean,
): boolean {
  if (opts?.unattended !== undefined) return opts.unattended;
  const continues = Boolean(opts?.cardContinuation) || (opts?.commsDepth ?? 0) > 0;
  return continues && isMarked();
}

/** Downgrade the model for an unattended turn: explicit unattended turns
 *  and fresh automation deliveries (webhook/resource triggers pass
 *  automationSource, not unattended).  A caller-supplied modelSelection
 *  is the caller's choice and is never downgraded.
 *
 *  Effort goes only when the selected model offers "low": stamping it from
 *  engine-wide effortLevels alone 409s startTurn when the model-specific
 *  modelEffortLevels() list is nonempty but omits "low".  The caller may
 *  pass a static list or a per-model resolver (preferred; evaluated on the
 *  post-rewrite id). */
export function unattendedModelDowngrade(
  selection: ModelSelection,
  opts: {
    unattended?: boolean;
    automationSource?: string;
    hasExplicitSelection?: boolean;
    /** Model-specific allowed efforts for the (post-rewrite) model, or a
     *  resolver that returns them.  Engine-wide capabilities.effortLevels
     *  alone is not enough — gate "low" the same way startTurn does. */
    effortLevels?: readonly string[] | ((model: string) => readonly string[] | undefined);
    /** Driver kind of the selected instance (e.g. "claudeAgent").  Custom
     *  instances under arbitrary ids share their driver's downgrade family.
     *  When present but not a known family, do not fall back to instanceId
     *  (a reserved-looking id mapped to openai-compat must not get Claude
     *  Sonnet→Haiku).  Only use instanceId when driverKind is missing. */
    driverKind?: string;
    /** Quota cooldowns vetted the pre-downgrade model; the rewrite must not
     *  route onto a cheaper model that is itself cooling down. */
    isCooling?: (instanceId: string, model: string) => boolean;
  },
): ModelSelection {
  if (opts.hasExplicitSelection) return selection;
  const automated =
    Boolean(opts.unattended) ||
    opts.automationSource === "webhook" ||
    opts.automationSource === "resource";
  if (!automated) return selection;
  // Resolve the downgrade family from the driver kind so operator-added
  // instances ("claude2", "gravity") get the same cheaper-model treatment
  // as the reserved ids.  Fall back to the instance id only when no kind
  // is given (callers/tests that never resolve one).  A defined but unknown
  // kind must not inherit the instance id — that would rewrite models for
  // an openai-compat instance that happens to be named "claude".
  const kind = opts.driverKind;
  const family =
    kind === "claudeAgent" ? "claude"
    : kind === "antigravityAgent" ? "antigravity"
    : kind?.includes("gemini") ? "gemini"
    : kind != null && kind !== "" ? undefined
    : selection.instanceId;
  let model = selection.model;
  if (family === "gemini") {
    model = model.replace("-pro", "-flash");
  } else if (family === "antigravity") {
    model = antigravityFlashModel(model);
  } else if (family === "claude") {
    // Only built-in Claude Sonnet/Opus routes are swapped: ids in the static
    // catalog, plus older official version ids (claude-sonnet-4-5,
    // claude-opus-4-1-20250805) no longer listed there.  Local-inject ids
    // (ollama::my-sonnet-model) and custom ids (claude-sonnet-5-custom) are
    // the operator's chosen route; rewriting them would break
    // applyClaudeInject host routing.
    if (isBuiltInClaudeSonnetOrOpus(model)) {
      // The driver's own current Haiku — claude-3-5-haiku-latest was a
      // stale alias pinned before Haiku 4.5 shipped.
      model = STATIC_CLAUDE_MODELS.options.find((o) => o.id.includes("haiku"))?.id
        ?? "claude-haiku-4-5";
    }
  }
  if (model !== selection.model && opts.isCooling?.(selection.instanceId, model)) {
    return selection;
  }
  const levels =
    typeof opts.effortLevels === "function" ? opts.effortLevels(model) : opts.effortLevels;
  return levels?.includes("low")
    ? { ...selection, model, effort: "low" }
    : { ...selection, model };
}

export interface FallbackScanMessage {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean; kind?: string };
}

export interface TurnFallbackPick extends ModelSelection {
  /** Index in the saved chain to start from on the next failure. */
  nextUsed: number;
}

const SHORT_PROVIDER_ERROR =
  /^(?:error:\s*)?(?:internal server error|bad gateway|service unavailable|account_inactive|resource_exhausted|too many requests|(?:server|service|provider) (?:is )?(?:overloaded|at capacity)|capacity (?:reached|exceeded|unavailable))\b/i;

// Standalone terminal provider chips (docs + observed CLIs).  These patterns
// are deliberately anchored: a successful answer may discuss billing,
// subscriptions, quotas, or capacity without becoming a provider failure.
// Keep this in sync with the corpus in model-fallback.test.ts.  Do not match
// "approaching … limit" warnings — those are near-cap, not a hit.
const QUOTA_OR_CAP_TERMINAL = [
  /^(?:you(?:'ve| have)?|you are|you're)\s+(?:hit|reached|exceeded|exhausted|out of)\b.{0,120}\b(?:session|usage|message|messaging|quota|limit|allowance|credits?|funds?|balance|plan|tier|spend|budget|requests?)\b(?!\s+(?:session|usage|message|messaging|quota|limit|allowance|credits?|funds?|balance|plan|tier|spend|budget|requests?|fix|handling|parser|parsing|test|tests|coverage|review|work|logic|implementation|documentation|code)\b)/i,
  /^your\s+(?:credit|prepayment|message|messaging|usage|quota|plan|tier|spend|budget)\b.{0,120}\b(?:low|depleted|empty|exhausted|insufficient|exceeded|reached|limit|cap)\b(?!\s+(?:fix|handling|parser|parsing|test|tests|coverage|review|work|logic|implementation|documentation|code)\b)/i,
  /^this request would exceed\b.{0,120}\b(?:rate|usage|quota|plan|tier|spend|budget|token|request)\s+(?:limit|cap|quota|allowance|budget)\b(?:\s+of\s+[\d,.]+\s+(?:input\s+)?tokens?\s+per\s+(?:minute|hour|day))?[.!]?$/i,
  /^individual\s+quota\s+reached\b/i,
  /^(?:codex|claude|grok|cursor|deepseek|kimi|gemini|antigravity)\s+(?:session|usage|message)\s+(?:limit|cap|quota)\s+(?:reached|exceeded|exhausted)\b/i,
  /^(?:session|usage|message|monthly|daily|plan|tier|free tier|spend|budget|concurrency)\s+(?:limit|cap|quota)(?:\s+(?:reached|exceeded|exhausted))?(?:\s+(?:for|on|in|until)\b.{0,120})?[.!]?$/i,
  /^(?:session limit or usage cap reached|quota exceeded|daily quota exceeded)(?:\s*[.:,!·—-]|\s*$|\s+(?:for|please|retry|try|upgrade|check|on|at|because|due)\b)/i,
  /^(?:insufficient.?quota|insufficient.?balance|insufficient.?funds|zero balance|credits exhausted|out of (?:usage|credits)|payment required)(?:\s*[.:,!·—-]|\s*$|\s+(?:for|to|please|on)\b)/i,
  /^(?:resource.{0,24}exhausted|resource_exhausted|rate.?limit(?:_error|\s+(?:reached|exceeded|hit))|usage_limit_exceeded|enforced_spend_limit(?:_reached)?|account_inactive)\b/i,
  /^(?:http\s*)?(?:402|429)(?:\s*[:—-]\s*|\s+)(?:too many requests|rate limit|payment required|insufficient|resource_exhausted|quota|error\b)/i,
  /^5-hour limit reached\b/i,
  /^increase limits for faster responses\b/i,
  /^upgrade (?:your )?plan to continue\b/i,
  /^upgrade to (?:plus|pro)\b/i,
  /^we(?:'re| are) receiving too many requests\b/i,
  /^(?:the )?(?:server|service|provider) (?:is )?(?:overloaded|at capacity)\b/i,
  /^capacity (?:reached|exceeded|unavailable)\b/i,
];

const KNOWN_FAILURE_QUOTA_OR_CAP =
  /session limit|hit your usage limit|usage cap|usage limit|individual\s+quota\s+reached|quota exceeded|insufficient.?quota|insufficient.?balance|insufficient.?funds|zero balance|resource.?exhausted|credits exhausted|credits? (?:are )?depleted|out of (?:usage|credits)|credit balance (?:is )?(?:too )?low|message limit reached|messaging allowance|5-hour limit reached|monthly limit|weekly (?:\([^)]+\) )?usage limit|slow pool|payment required|plan limit|tier limit|free tier limit|spend limit|budget exceeded|rate.?limit|rate_limit_error|usage_limit_exceeded|too many requests|(?:server|service|provider) (?:is )?(?:overloaded|at capacity)|capacity (?:reached|exceeded|unavailable)|concurrency limit|account_inactive|enforced_spend_limit|\b402\b|\b429\b/i;

const LEGACY_PROVIDER_ERROR_PREFIX = /^(?:api request failed|provider error|request failed|http error):\s*/i;

const QUOTA_TEXT_MAX = 500;

export const DEFAULT_QUOTA_COOLDOWN_TTL_MS = 15 * 60 * 1000;

/** Short error-chip text that must not count as a real assistant reply. */
export function isShortProviderErrorText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 300 && (SHORT_PROVIDER_ERROR.test(trimmed) || isQuotaOrCapText(trimmed));
}

/** Quota, usage-cap, or session-limit chip — including Grok's
 * "You've hit your session limit · resets …" line. */
export function isQuotaOrCapText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length >= QUOTA_TEXT_MAX) return false;
  const stripped = trimmed.replace(
    /^(?:error:\s*)?(?:(?:antigravity|grok|claude|codex|gemini|cursor|deepseek|openai):\s*)?/i,
    "",
  );
  if (/^[>`"']/.test(stripped)) return false;
  return QUOTA_OR_CAP_TERMINAL.some((pattern) => pattern.test(stripped));
}

function isLegacyProseCooldown(text: string): boolean {
  const trimmed = text.trim();
  const isPrefixedProviderFailure = LEGACY_PROVIDER_ERROR_PREFIX.test(trimmed) && KNOWN_FAILURE_QUOTA_OR_CAP.test(trimmed);
  return !isQuotaOrCapText(trimmed) && !isPrefixedProviderFailure;
}

export interface QuotaOrCapEvidence {
  text: string;
  source: "provider-error" | "terminal-chip";
}

/** Finds the exact provider evidence used for cooldown, reset parsing, and
 * status.  Failed turns may use their explicit error activity; successful
 * turns require a standalone terminal chip rather than arbitrary prose. */
export function turnQuotaOrCapEvidence(
  messagesAfterUser: FallbackScanMessage[],
  turnOk: boolean,
): QuotaOrCapEvidence | undefined {
  if (!turnOk) {
    for (let i = messagesAfterUser.length - 1; i >= 0; i--) {
      const message = messagesAfterUser[i];
      if (message.role !== "bot" || message.kind !== "activity") continue;
      const name = message.tool?.name ?? "";
      if (!/^error:/i.test(name)) continue;
      const text = name.replace(/^error:\s*/i, "").trim();
      if (text && KNOWN_FAILURE_QUOTA_OR_CAP.test(text)) return { text, source: "provider-error" };
    }
  }

  const botTexts = messagesAfterUser.filter(
    (message) => message.role === "bot" && message.kind === "text" && typeof message.text === "string",
  );
  const text = botTexts.at(-1)?.text?.trim();
  if (!text) return undefined;
  if (isQuotaOrCapText(text)) return { text, source: "terminal-chip" };
  return undefined;
}

/** The last message that actually started a turn — a human's "user" message,
 * or an auto-delivered routine/webhook/resource instruction stored as
 * "system" (see server/index.ts's storedRole).  Both are turn prompts; only
 * "bot" replies and chips are not. */
export function lastTurnStartIndex(messages: FallbackScanMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].role === "user" || messages[i].role === "system") && messages[i].kind === "text") return i;
  }
  return -1;
}

/** Boot-recovery prompt when the in-flight turn has no persisted starter
 * (connector/secret cardContinuation is ephemeral). */
export const BOOT_RECOVERY_NOTICE =
  "[System notice: BotFleet was restarted while you were working on this task. Please review the conversation above and the current workspace state, and resume your work where you left off.]";

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
  return Boolean(turnQuotaOrCapEvidence(messagesAfterUser, false));
}

// ── a rejected model id is a failure, not a reply ───────────────────────
// The Claude CLI answers an unknown model with an assistant-shaped message
// ("There's an issue with the selected model (...)"), not a process failure.
// The driver now reports that structurally: an error row plus the
// `unknown_model` stop reason.  The text pattern below is only the backstop
// for a transcript row written before that, or by an engine that still
// forwards the prose.  It is anchored and length-capped on purpose: a real
// answer that mentions a missing model ("the staging model id was not found in
// the catalog, so I added it") must never read as a provider failure, and it
// is only consulted when the turn already failed.

/** Stop reason a driver settles with when the provider rejected the model id.
 *  `retry.ts` classifies the same word as terminal, so the two agree. */
export const MODEL_REJECTED_STOP_REASON = "unknown_model";

const MODEL_REJECTION_TEXT = /^There's an issue with the selected model\b/i;
const MODEL_REJECTION_TEXT_MAX = 400;

export function isModelRejectionText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length < MODEL_REJECTION_TEXT_MAX && MODEL_REJECTION_TEXT.test(trimmed);
}

export interface ModelRejectionEvidence {
  text: string;
  source: "stop-reason" | "terminal-text";
}

/** Did this FAILED turn end because the provider rejected the model id?
 *
 *  The stop reason decides when a driver reports one.  Otherwise only the LAST
 *  bot text counts, never the slice as a whole: the slice accumulates across
 *  fail-over attempts (the fallback re-uses the same user message), so a second
 *  dead entry would otherwise be hidden behind the first one's text. */
export function turnModelRejectionEvidence(
  messagesAfterUser: FallbackScanMessage[],
  turnOk: boolean,
  stopReason?: string | null,
): ModelRejectionEvidence | undefined {
  if (turnOk) return undefined;
  if (stopReason === MODEL_REJECTED_STOP_REASON) {
    for (let i = messagesAfterUser.length - 1; i >= 0; i--) {
      const message = messagesAfterUser[i];
      if (message.role !== "bot" || message.kind !== "activity") continue;
      const name = message.tool?.name ?? "";
      if (/^error:/i.test(name)) return { text: name.replace(/^error:\s*/i, "").trim(), source: "stop-reason" };
    }
    return { text: "The provider rejected the model.", source: "stop-reason" };
  }
  const botTexts = messagesAfterUser.filter(
    (message) => message.role === "bot" && message.kind === "text" && typeof message.text === "string",
  );
  const text = botTexts.at(-1)?.text?.trim();
  if (text && isModelRejectionText(text)) return { text, source: "terminal-text" };
  return undefined;
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
    if (message.tool.kind === "notice") return false;
    const name = message.tool.name ?? "";
    if (/^(retrying|working)\b/i.test(name)) return false;
    if (name.startsWith("Antigravity has no approval cards")) return false;
    return true;
  });
}

/** Replay the persisted turn-starter only when that turn never produced
 * assistant output.  A card-continuation crash leaves the previous
 * completed prompt on disk; replaying it would re-run already-finished
 * work (including tools). */
export function shouldReplayPersistedStarter(messages: FallbackScanMessage[], turnStartIdx: number): boolean {
  if (turnStartIdx < 0) return false;
  return !turnProducedAssistantOutput(messages.slice(turnStartIdx + 1));
}

/** Persisted trigger of an auto-delivered turn starter.  Mirrors
 * RoutineRunTrigger without importing routines.ts. */
export type BootRecoveryAutomationSource = "schedule" | "manual" | "webhook" | "resource" | "delegation" | "imessage";

export interface BootRecoveryResumeUser {
  role?: string;
  automationSource?: BootRecoveryAutomationSource;
}

export interface BootRecoveryTurnOpts {
  automationSource?: BootRecoveryAutomationSource;
  unattended?: boolean;
}

/**
 * startTurn options for boot recovery other than prompt / userMessage.
 * `replay` only gates the TEXT that is sent (persisted starter vs
 * BOOT_RECOVERY_NOTICE) and whether the persisted message is reused —
 * it must not drop automation context.  After restart `unattendedBots`
 * is empty, so this must not consult isUnattended.  Forwarding
 * automationSource also stores BOOT_RECOVERY_NOTICE as role=system.
 */
export function bootRecoveryTurnOpts(
  resumeUser: BootRecoveryResumeUser | undefined,
  replay: boolean,
): BootRecoveryTurnOpts {
  // Replay only chooses the prompt text / whether to reuse the persisted
  // message.  Attribution must not depend on it.
  void replay;
  const automationSource = resumeUser?.automationSource;
  const webhookOrResource = automationSource === "webhook" || automationSource === "resource";
  // Calendar `schedule` is the owner's saved prompt (Auto mode on a live
  // tick).  Recovery still prefers unattended for any system-attributed
  // starter so the notice is not treated as a person typing — that would
  // clear the guard and let always-allow authorize a request nobody is
  // watching.  A system row with no source gets the same treatment.
  const unattended = webhookOrResource || resumeUser?.role === "system" ? true : undefined;
  return { automationSource, unattended };
}

function sameEngine(a: { instanceId: string; model: string }, b: { instanceId: string; model: string }): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

// ── structured provider-error codes (chat-completions/errors.ts) ────────
// A chat-completions driver's loop (server/drivers/chat-completions/loop.ts)
// classifies an HTTP failure onto a ProviderErrorCode and reports it as an
// `error:<code>` terminal stopReason.  CLI/ACP engines have no such code —
// their turns end on a plain "error" or on chip prose the regexes above
// already parse — so these two helpers are strictly ADDITIVE: they return
// undefined whenever there is no structured code, and the caller is the one
// that falls back to the regex path in that case.

/** Parses the `error:<code>` stopReason a chat-completions driver's loop
 *  emits back into the ProviderErrorCode it was classified from.
 *  Undefined for every other stopReason, including a CLI engine's plain
 *  "error" (no colon) — it has no structured code at all. */
export function providerErrorCodeFromStopReason(stopReason: string | null | undefined): ProviderErrorCode | undefined {
  if (!stopReason || !stopReason.startsWith("error:")) return undefined;
  const code = stopReason.slice("error:".length).trim();
  return code ? (code as ProviderErrorCode) : undefined;
}

/** Whether a STRUCTURED provider-error code should consult the fallback
 *  chain.  True for a real quota/cap AND for an outage — model-fallback.ts's
 *  QUOTA_OR_CAP regex has never covered a bare "HTTP 502", which is exactly
 *  why a 5xx used to just fail instead of trying the next engine.
 *  invalid_credentials is deliberately NOT included: that failure is
 *  answered by the setup affordance (`runtime.error.setup`), not by
 *  wandering to a different engine with the same bad key story.  Returns
 *  undefined when there is no structured code, so the caller falls back to
 *  the regex path rather than this turning INTO false and suppressing a CLI
 *  engine's existing text-chip detection. */
export function quotaOrCapFromErrorCode(code: ProviderErrorCode | undefined): boolean | undefined {
  if (code === undefined) return undefined;
  return code === "quota_or_region_restriction" || code === "upstream_outage";
}

// ── setup-dead engines are not fallback candidates ──────────────────────
// The quota cooldown keeps a bot off a model that is BUSY: the engine starts
// fine and the provider is rate-limited or capped for a while.  The doomed
// breaker in doomed-dispatch.ts keeps a bot off an engine that is DEAD: the
// CLI is not installed, is not executable, or is waiting on an interactive
// login.  Both refuse the same (bot, engine) pair, and the second gap the
// breaker left open was the fallback chain: a bot whose primary failed over
// cleanly was still offered a chain entry naming an equally dead engine, so
// the turn died again having burned the whole chain.  Measured on the live
// Mac, 216 of 2,001 runs were `spawn_error` because the process never came
// up at all, and two bots whose primary is `antigravity` had already fallen
// back — the fail-over is the exact moment a second dead engine gets picked.
//
// Importing doomed-dispatch.ts here is acyclic: its only relative import is
// ./atomic.ts, which imports nothing but node builtins.

/** Is this (bot, engine) pair currently refusing dispatches?  Takes the same
 *  `now` the surrounding code already has so a caller can evaluate the whole
 *  chain against one instant. */
export type DoomedEngineGate = (botId: string, instanceId: string, now: number) => boolean;

const defaultDoomedGate: DoomedEngineGate = (botId, instanceId, now) =>
  doomedDispatches.isOpen(botId, instanceId, now);

/** The gate to consult for one call: the caller's own, or the process-wide
 *  breaker the dispatcher and `canStart` already read. */
function doomedGate(gate: DoomedEngineGate | undefined): DoomedEngineGate {
  return gate ?? defaultDoomedGate;
}

/** The rejection gate to consult for one call: the caller's own, or the
 *  process-wide registry the fold writes to. */
function rejectionGate(gate: ModelRejectionGate | undefined): ModelRejectionGate {
  return gate ?? ((botId, instanceId, model, now) => modelRejections.isRejected(botId, instanceId, model, now));
}

// ── #90 auto-failover priority (server/index.ts's autoFallbackChain) ────
// Most-preferred first, handed straight to turn-safety.ts's
// eligibleAutoFallbackChain.  It lives here rather than inline in index.ts
// so the ordering is unit-testable without booting the server.  minimax
// sits after codex and ahead of openaiCompat — the owner-approved default:
// the cheap metered lane a capped subscription engine should reach for
// first.  An instanceId absent from this array sorts last.
export const AUTO_FALLBACK_PRIORITY: readonly string[] = [
  "claude",
  "antigravity",
  "gemini",
  "codex",
  "minimax",
  "openaiCompat",
  "grok",
];

/** Next saved fallback engine, or undefined when this turn must not fail over.
 * Quota/cap chips ignore prior tool activity.  Chain entries that match the
 * current primary are skipped so a same-model fallback cannot loop, and a
 * chain entry the doomed breaker is refusing is skipped so a fail-over cannot
 * hand the turn to a second engine that cannot start.
 *
 * `botId` is what makes that last skip possible: the breaker is keyed on
 * (bot, engine), and no bot id means no answer, so a caller that has not
 * started threading one through gets today's behaviour unchanged. */
export function selectTurnFallback(input: {
  ok: boolean;
  stopReason?: string | null;
  produced: boolean;
  quotaOrCap?: boolean;
  fallbacks?: ModelSelection[] | null;
  used: number;
  current?: { instanceId: string; model: string } | null;
  /** Owning bot, for the doomed-dispatch breaker.  Omit and no entry is
   *  excluded on its account. */
  botId?: string;
  isDoomed?: DoomedEngineGate;
  /** Skips an entry the provider already rejected for this bot.  Like the
   *  doomed gate it needs `botId`; defaults to the process-wide registry. */
  isModelRejected?: ModelRejectionGate;
  now?: number;
}): TurnFallbackPick | undefined {
  if (input.ok) return undefined;
  if (input.stopReason === "interrupted" || input.stopReason === "cancelled") return undefined;
  // The next engine receives the same prompt.  Falling over is how Compiler
  // showed both `session/prompt timed out` and Antigravity's argv-only
  // "prompt too large" on one webhook turn.
  if (input.stopReason === "prompt_too_large") return undefined;
  if (input.produced && !input.quotaOrCap) return undefined;
  const chain = input.fallbacks;
  if (!chain?.length) return undefined;
  const start = Math.max(0, input.used);
  // One instant for the whole walk: a chain that crosses a TTL boundary
  // mid-scan must not decide its entries against two different clocks.
  const now = input.now ?? Date.now();
  const { botId } = input;
  const isDoomed = botId ? doomedGate(input.isDoomed) : undefined;
  const isRejected = botId ? rejectionGate(input.isModelRejected) : undefined;
  for (let i = start; i < chain.length; i++) {
    const next = chain[i];
    if (!next?.instanceId) continue;
    if (input.current && sameEngine(next, input.current)) continue;
    // Skip in place, never re-order: the remaining entries are still the
    // owner's saved preference order, and nextUsed still points past the
    // entry that was chosen so a later failure walks the same chain.
    if (botId && isDoomed?.(botId, next.instanceId, now)) continue;
    // A model the provider already said it does not have would only spend
    // another spawn to hear it again, and end the walk there.
    if (botId && isRejected?.(botId, next.instanceId, next.model, now)) continue;
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
  /** Who wrote this row: a terminal chip, provider error, or quota poller. */
  source?: string;
}

function computeNextOccurrence(targetHour: number, targetMinute: number, tz: string | undefined, now: number): number {
  if (tz) {
    try {
      // Built once per call, not once per candidate minute.  Constructing an
      // Intl.DateTimeFormat loads ICU zone data and is by far the costliest
      // step here; inside the loop it ran up to 2,160 times on the main
      // thread for every zoned reset chip.  An unrecognized zone still
      // throws from this constructor and still falls through to local time.
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      // Find candidate timestamp within the next 36 hours matching the hour:minute in that tz
      for (let offsetMinutes = 1; offsetMinutes <= 36 * 60; offsetMinutes++) {
        const candidate = new Date(now + offsetMinutes * 60 * 1000);
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

/** Parses quota reset time from provider error chips or text replies.  A
 * caller that already proved the text came from a provider failure can keep
 * that evidence while parsing a nested or prefixed reset message. */
export function parseQuotaResetTime(text: string, now = Date.now(), knownQuota = false): QuotaResetInfo {
  const isCap = knownQuota || isQuotaOrCapText(text);
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

  private isExpired(cd: BotQuotaCooldown, now: number): boolean {
    if (typeof cd.resetsAt === "number" && cd.resetsAt > 0) {
      return now >= cd.resetsAt;
    }
    if (cd.resetsAt === null && cd.source === "antigravity-usage") return false;
    const recorded = typeof cd.recordedAt === "number" && cd.recordedAt > 0 ? cd.recordedAt : now;
    return now >= recorded + DEFAULT_QUOTA_COOLDOWN_TTL_MS;
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
      let removed = false;
      for (const cd of parsed.cooldowns) {
        if (!cd || typeof cd !== "object") continue;
        if (
          typeof cd.botId !== "string" ||
          typeof cd.instanceId !== "string" ||
          typeof cd.model !== "string" ||
          typeof cd.error !== "string"
        ) {
          removed = true;
          continue;
        }
        if (this.isExpired(cd, now)) {
          removed = true;
          continue;
        }
        // Older turn-completion rows had no source and could contain a normal
        // successful reply selected by the former keyword matcher.  Retain
        // only standalone provider chips; usage-monitor and other named
        // producers already carry their own trusted source.
        if (!cd.source && !cd.resetsAt && isLegacyProseCooldown(cd.error)) {
          removed = true;
          continue;
        }
        this.cooldowns.set(`${cd.botId}:${cd.instanceId}:${cd.model}`, cd);
      }
      if (removed) this.persist();
    } catch {
      /* corrupt file = empty registry */
    }
  }

  record(cooldown: BotQuotaCooldown): void {
    const recordedAt = cooldown.recordedAt ?? Date.now();
    const resetsAt = cooldown.resetsAt != null ? cooldown.resetsAt : (recordedAt + DEFAULT_QUOTA_COOLDOWN_TTL_MS);
    const normalized: BotQuotaCooldown = { ...cooldown, recordedAt, resetsAt };
    this.cooldowns.set(`${normalized.botId}:${normalized.instanceId}:${normalized.model}`, normalized);
    this.persist();
  }

  recordInstanceCap(
    instanceId: string,
    model = "*",
    opts: { resetsAt?: number | null; error?: string; source?: string } = {},
  ): void {
    const recordedAt = Date.now();
    const resetsAt = opts.source === "antigravity-usage"
      ? (opts.resetsAt ?? null)
      : (opts.resetsAt != null ? opts.resetsAt : (recordedAt + DEFAULT_QUOTA_COOLDOWN_TTL_MS));
    const cd: BotQuotaCooldown = {
      botId: "*",
      instanceId,
      model,
      resetsAt,
      error: opts.error ?? "Session limit or usage cap reached",
      recordedAt,
      source: opts.source,
    };
    this.cooldowns.set(`*:${instanceId}:${model}`, cd);
    this.persist();
  }

  get(botId: string, instanceId: string, model: string, now = Date.now()): BotQuotaCooldown | undefined {
    const key = `${botId}:${instanceId}:${model}`;
    const cd = this.cooldowns.get(key) ?? this.cooldowns.get(`*:${instanceId}:${model}`) ?? this.cooldowns.get(`*:${instanceId}:*`);
    if (!cd) return undefined;
    if (this.isExpired(cd, now)) {
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
      if (this.isExpired(cd, now)) {
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
   *
   * A fallback the doomed breaker is refusing is skipped for the same reason a
   * cooling one is: handing the turn to an engine whose CLI is missing, is not
   * executable, or wants an interactive login is a turn that cannot finish.
   * The pair is left out, not moved — and a chain with nothing usable left
   * still returns the primary plus its cooldown, exactly as it did when every
   * entry was cooling.  The primary itself is never excluded here: refusing to
   * dispatch a doomed pair is `canStart`'s job, not a new failure mode here.
   */
  resolveModel(
    botId: string,
    primary: ModelSelection,
    now = Date.now(),
    opts: { isDoomed?: DoomedEngineGate; isModelRejected?: ModelRejectionGate } = {},
  ): { selection: ModelSelection; isFallback: boolean; cooldown?: BotQuotaCooldown } {
    const cd = this.get(botId, primary.instanceId, primary.model, now);
    const isRejected = rejectionGate(opts.isModelRejected);
    // A primary the provider rejected is routed around exactly like a cooling
    // one: it would fail again before doing any work.  Unlike a cooldown it
    // leaves no row for the Usage settings to show as a quota hit.
    const primaryRejected = isRejected(botId, primary.instanceId, primary.model, now);
    if (!cd && !primaryRejected) {
      return { selection: primary, isFallback: false };
    }
    const fallbacks = primary.fallbacks;
    if (fallbacks && fallbacks.length > 0) {
      const isDoomed = doomedGate(opts.isDoomed);
      for (const fb of fallbacks) {
        if (this.get(botId, fb.instanceId, fb.model, now)) continue;
        if (isDoomed(botId, fb.instanceId, now)) continue;
        if (isRejected(botId, fb.instanceId, fb.model, now)) continue;
        return { selection: fb, isFallback: true, ...(cd ? { cooldown: cd } : {}) };
      }
    }
    return { selection: primary, isFallback: false, ...(cd ? { cooldown: cd } : {}) };
  }
}

export const quotaCooldowns = new QuotaCooldownRegistry();

export function enableQuotaCooldownPersist(path: string): void {
  quotaCooldowns.enablePersist(path);
}
