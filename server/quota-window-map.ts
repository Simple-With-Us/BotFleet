/** Pure mapping from Usage Monitor quota windows onto BotFleet engines.
 *  Kept off usage-quota.ts so the Settings UI can import it without the poller. */

export type QuotaWindowMatch = {
  provider: string;
  providerKey?: string | null;
  sourceApp?: string | null;
  label: string;
  modelId?: string | null;
  modelType?: string | null;
  window?: string | null;
  skip: boolean;
  skipReason?: string | null;
  remainingPercent?: number | null;
};

export type QuotaPollerInstanceLike = {
  instanceId: string;
  driverKind: string;
  models?: { options?: Array<{ id: string }> };
};

/** Just enough of a window to name the provider it belongs to. */
export type QuotaProviderIdentity = {
  provider?: string | null;
  providerKey?: string | null;
  via?: string | null;
};

/** Read one dictionary entry without walking the prototype chain.
 *
 *  Every table below is indexed with text that arrives from the AgentBar
 *  handoff — an ordinary file any process running as this user can write —
 *  and a bare `TABLE[key]` answers `Object.prototype`'s own members too.  A
 *  `modelType` of "constructor" therefore resolves to the `Object` function,
 *  which is truthy, so a `??` fallback beside it never fires and the caller
 *  is handed a function where the type promises an array, a number or a
 *  string.  `modelsToSkip` then does `new Set(<function>)` and throws, and a
 *  window token of "constructor" made `windowLengthMs` return a function that
 *  turned a cooldown's end into NaN.  Every lookup keyed by parsed text goes
 *  through this, here and in server/usage-quota.ts and src/lib/quota-display.ts. */
export function lookupOwn<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The one provider allow-list for the AgentBar handoff and the Settings
 *  quota section.  The server parser (server/local-usage-monitor.ts) and the
 *  renderer (src/lib/usage-monitor-quota.ts) each used to declare their own,
 *  and the two disagreed: the server accepted `deepseek` but not `dsh`, the
 *  renderer accepted both, and this file mapped `kimi`/`moonshot` windows the
 *  renderer then dropped again.  One list, imported by both.
 *
 *  `dsh` sits BESIDE `deepseek` and is never aliased onto it: the DeepSeek
 *  Harness and the DeepSeek API are different engines here — driverKindsForWindow
 *  below answers `dshAgent` for one and `deepseekAgent`/`deepseek` for the
 *  other — so folding the two keys together would put a harness window on the
 *  API engine's row and cap the wrong thing. */
export const QUOTA_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google-antigravity",
  "cursor",
  "xai",
  "minimax",
  "deepseek",
  "dsh",
]);

/** Product and vendor spellings either app can emit, folded onto the
 *  canonical key above.  Grok Bot is deliberately absent: it is excluded by
 *  its own check in each of the three places that read a window, and aliasing
 *  it onto `xai` would hand Grok CLI another product's allowance. */
export const QUOTA_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  claude: "anthropic",
  "claude-code": "anthropic",
  chatgpt: "openai",
  codex: "openai",
  "openai-codex": "openai",
  antigravity: "google-antigravity",
  "antigravity-cli": "google-antigravity",
  "cursor-cli": "cursor",
  grok: "xai",
  "grok-build": "xai",
  "minimax-code": "minimax",
};

/** Providers a collector somewhere in the fleet reads but BotFleet has no
 *  engine for.  Kimi is here because AgentBar does implement a reader for it
 *  while BotFleet's Kimi instance is custom-only. */
export const EXCLUDED_QUOTA_PROVIDERS: ReadonlySet<string> = new Set([
  "gemini-cli",
  "github-copilot",
  "copilot",
  "windsurf",
  "kimi",
  "moonshot",
]);

export function normalizeQuotaProviderKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

/** The canonical provider key for one window.  `via: "antigravity"` wins —
 *  a window routed through Antigravity is an Antigravity window whatever
 *  vendor is underneath it — then the row's own providerKey, then the
 *  display name it reports as `provider`. */
export function canonicalQuotaProvider(window: QuotaProviderIdentity): string {
  if (normalizeQuotaProviderKey(window.via) === "antigravity") return "google-antigravity";
  const key = normalizeQuotaProviderKey(window.providerKey || window.provider);
  return lookupOwn(QUOTA_PROVIDER_ALIASES, key) ?? key;
}

/** The provider key whose quota an engine spends, for the cases where the
 *  answer has to run the other way: a provider the collector could not read
 *  publishes no window at all, so there is nothing to map onto a driver kind
 *  and the engine's own row is the only place its reason can be shown.
 *  Deliberately not derived from `driverKindsForWindow` — that function reads
 *  a window's text and cannot be asked "which provider is this engine?". */
const DRIVER_KIND_PROVIDERS: Readonly<Record<string, string>> = {
  claudeAgent: "anthropic",
  codex: "openai",
  codexAgent: "openai",
  cursorAgent: "cursor",
  grokAgent: "xai",
  grok: "xai",
  antigravityAgent: "google-antigravity",
  minimax: "minimax",
  minimaxAgent: "minimax",
  deepseek: "deepseek",
  deepseekAgent: "deepseek",
  dshAgent: "dsh",
};

export function quotaProviderForDriver(driverKind: string): string | null {
  return lookupOwn(DRIVER_KIND_PROVIDERS, driverKind) ?? null;
}

/** How little of a window may be left before it counts as near its cap:
 *  exactly `remainingPercent <= 20`, with 0 reported as exhausted rather than
 *  near-cap.  This is deliberately the producer's own boundary — AgentBar
 *  classifies a window it writes at the same 20% and the same 0 — so the
 *  status BotFleet derives from a percentage can never disagree with the
 *  `status` string sitting beside it in the very same row.  Moving it here
 *  would silently move the engine chip, the grid cell and the handoff apart.
 *
 *  MiniMax keeps its own 10% (server/minimax-balance.ts): that is a vendor
 *  reading of a real balance rather than a share inferred from a percentage. */
export const NEAR_CAP_PERCENT = 20;

/** Whether BotFleet has an engine for this window's provider at all. */
export function isSupportedQuotaProvider(window: QuotaProviderIdentity): boolean {
  const raw = normalizeQuotaProviderKey(window.providerKey || window.provider);
  const key = canonicalQuotaProvider(window);
  if (EXCLUDED_QUOTA_PROVIDERS.has(key) || EXCLUDED_QUOTA_PROVIDERS.has(raw)) return false;
  return QUOTA_PROVIDERS.has(key);
}

export function driverKindsForWindow(window: QuotaWindowMatch): string[] {
  const hay = `${window.provider} ${window.sourceApp ?? ""} ${window.label}`.toLowerCase();
  // Grok Bot has its own Cursor-hosted allowance and cannot run in BotFleet.
  if (/grok[-_ ]?bot/i.test(`${window.providerKey ?? ""} ${hay}`)) return [];
  if (hay.includes("cursor")) return ["cursorAgent"];
  if (hay.includes("antigravity") || hay.includes("gemini")) return ["antigravityAgent"];
  // "openai-compat" is the provider token Usage Monitor's own telemetry
  // ambiguity fallback emits for a custom OpenAI-compatible engine
  // (server/telemetry.ts's AMBIGUOUS_ENGINE, set when inferProviderAndService
  // can name no real vendor) — it contains "openai" as a literal substring,
  // so it must be excluded before any codex/openai check, or a skipped
  // monthly window on an unrelated custom engine would wildcard-cap the real
  // Codex instance, and an ordinary window would render under the wrong
  // engine's row. Custom instances share one driver kind ("openai-compat")
  // across possibly many instances, so there is no reliable way to attribute
  // this token to one specific instance from the label alone — it maps to
  // nothing here rather than to the wrong engine.
  if (hay.includes("openai-compat") || hay.includes("openai compatible")) return [];
  // The shipped fleet's default Codex instance rides driver kind "codex"
  // (server/drivers/codex.ts), not "codexAgent" — that name matches nothing
  // in instanceConfigs()'s DEFAULT_FLEET, so a Codex/OpenAI Usage Monitor
  // window was silently unreachable by windowsForDriver() for the one
  // instance most likely to want it.
  //
  // Deliberately "codex"/"chatgpt" (the PRODUCT), never a bare "openai"/
  // "gpt" (the VENDOR/model family): excluding the literal "openai-compat"
  // token above only catches the case where Usage Monitor could name no
  // vendor at all. When it CAN — because the custom engine's own model id
  // happens to look like a real OpenAI model ("gpt-4o" proxied through
  // OpenRouter, Azure, a self-hosted gateway, …) — its classification can
  // legitimately report provider "openai" for a window that has nothing to
  // do with the real app. A custom engine is free to proxy those same
  // models; only the product name is unique to the one BotFleet actually
  // ships as "codex".
  if (hay.includes("codex") || hay.includes("chatgpt")) return ["codex", "codexAgent"];
  if (hay.includes("anthropic") || hay.includes("claude")) return ["claudeAgent"];
  if (hay.includes("grok") || hay.includes("xai")) return ["grokAgent", "grok"];
  if (hay.includes("minimax")) return ["minimaxAgent", "minimax"];
  // inferProviderAndService (server/telemetry.ts) reports Kimi/Moonshot
  // windows under provider "moonshot"; the shipped fleet's Kimi instance
  // rides driver kind "kimiAgent" (instanceConfigs()'s DEFAULT_FLEET). The
  // raw Usage Monitor windows table this PR removed was the only place a
  // Kimi window stayed visible without this mapping.
  if (hay.includes("kimi") || hay.includes("moonshot")) return ["kimiAgent"];
  if (hay.includes("dsh")) return ["dshAgent"];
  if (hay.includes("deepseek")) return ["deepseekAgent", "deepseek"];
  // Factory is droid's real commercial product/subscription (droid.ts:
  // "the `droid` CLI over ACP stdio... on the Factory login... or a
  // FACTORY_API_KEY") — a genuine Usage Monitor provider a window can name,
  // unlike pi/qwen/hermes/opencodeGo/boxAgent below, which have no vendor of
  // their own for Usage Monitor to report on.
  if (hay.includes("droid") || hay.includes("factory")) return ["droidAgent"];
  return [];
}

/** How pi, qwen, hermes, opencodeGo and boxAgent bill, for engines that
 *  `driverKindsForWindow` above can never map to a Usage Monitor window:
 *  each is either BYOK against a provider Usage Monitor has no name for
 *  (pi: `~/.pi/agent/auth.json` against ollama-cloud, a local host, or
 *  whatever else the user registered; qwen: "Custom-only in BotFleet: the
 *  official pane has no Qwen Cloud catalog"; hermes: "a BYOK/local harness";
 *  opencodeGo: "Zen, Go, OpenRouter, and user-configured/local providers"),
 *  or billed on an account of its own that isn't a token quota at all
 *  (boxAgent: box.ascii.dev's own compute billing). Declared here, by
 *  driverKind, so their Fleet Quotas row says so explicitly instead of
 *  looking like an engine no one bothered to wire up. Keyed by driverKind,
 *  not by label matching — these are BotFleet's own driver kinds, never a
 *  Usage Monitor provider token. */
export type EngineMeterKind = "metered" | "unmetered";

export interface EngineMeterNote {
  kind: EngineMeterKind;
  /** Sentence-case, no trailing period — matches the rest of the Fleet
   *  Quotas row's status-line vocabulary. */
  copy: string;
}

export const ENGINE_METER_NOTES: Readonly<Record<string, EngineMeterNote>> = {
  piAgent: {
    kind: "metered",
    copy: "metered by whichever provider you've registered (cloud or local) — no fleet-wide quota window",
  },
  qwenAgent: {
    kind: "metered",
    // Never name Qwen/DashScope specifically: qwen.ts's injected-model path
    // (a `host::model` pick) can point at any local or remote endpoint the
    // owner registered, not only Alibaba's own API — the copy must not
    // claim who bills when BotFleet genuinely does not know.
    copy: "metered by whichever provider you've configured (Qwen Cloud, a local host, or another endpoint) — custom-only in BotFleet with no fleet-wide quota window",
  },
  hermesAgent: {
    kind: "metered",
    copy: "metered — a BYOK/local harness billed to your own key, with no fleet-wide quota window",
  },
  opencodeGo: {
    kind: "metered",
    copy: "metered by the model you pick — the default is free, a paid model bills to your own key",
  },
  boxAgent: {
    kind: "metered",
    copy: "billed on your Box account's own compute usage, not a token quota BotFleet tracks",
  },
};

export function engineMeterNote(driverKind: string): EngineMeterNote | null {
  return lookupOwn(ENGINE_METER_NOTES, driverKind) ?? null;
}

/** The Claude subscription's three model families, spelled the way
 *  `modelTypeFromId` below spells them. */
const CLAUDE_FAMILIES = ["claude-opus", "claude-sonnet", "claude-haiku", "claude"];
const GEMINI_FAMILIES = ["gemini-pro", "gemini-flash", "gemini"];
/** Antigravity's second pool is everything that is not Gemini: Claude and
 *  GPT models drawn from one shared allowance. */
const THIRD_PARTY_FAMILIES = [...CLAUDE_FAMILIES, "gpt"];

/** AgentBar names a window's model family in the producer's own vocabulary —
 *  "opus", "sonnet" and "haiku" for the Claude subscription, "gemini" and
 *  "third-party" for the two Antigravity pools — while BotFleet's catalog
 *  families (`modelTypeFromId` below) are spelled "claude-opus", "gemini-pro"
 *  and so on.  Without this map a family-level window matched no catalog model
 *  at all, so it could only ever cap an exact `modelId`: a spent Opus week
 *  arriving as `modelType: "opus"` capped nothing.
 *
 *  A family the map does not know is passed through unchanged rather than
 *  dropped, so a producer that starts publishing a new family name still
 *  matches any catalog model whose own type is spelled the same way. */
export const MODEL_TYPE_FAMILIES: Readonly<Record<string, string[]>> = {
  opus: ["claude-opus"],
  sonnet: ["claude-sonnet"],
  haiku: ["claude-haiku"],
  claude: CLAUDE_FAMILIES,
  anthropic: CLAUDE_FAMILIES,
  gemini: GEMINI_FAMILIES,
  "gemini-models": GEMINI_FAMILIES,
  "third-party": THIRD_PARTY_FAMILIES,
  thirdparty: THIRD_PARTY_FAMILIES,
  "third-party-models": THIRD_PARTY_FAMILIES,
  gpt: ["gpt"],
  codex: ["gpt"],
  grok: ["grok"],
  cursor: ["cursor"],
  deepseek: ["deepseek"],
};

export function familiesForWindow(window: QuotaWindowMatch): string[] {
  const label = window.label.toLowerCase();
  if (label.includes("claude and gpt") || label.includes("third-party")) return THIRD_PARTY_FAMILIES;
  if (label.includes("gemini")) return GEMINI_FAMILIES;
  if (label.includes("cursor")) return ["cursor"];
  if (!window.modelType) return [];
  // `normalizeQuotaProviderKey` is only a lowercase/space/underscore folder;
  // camelCase has to be split first so "thirdParty" reaches "third-party".
  const key = normalizeQuotaProviderKey(window.modelType.replace(/([a-z0-9])([A-Z])/g, "$1-$2"));
  return lookupOwn(MODEL_TYPE_FAMILIES, key) ?? [window.modelType];
}

export function modelTypeFromId(modelId: string): string {
  const raw = modelId.toLowerCase();
  if (/opus/.test(raw)) return "claude-opus";
  if (/sonnet/.test(raw)) return "claude-sonnet";
  if (/haiku/.test(raw)) return "claude-haiku";
  if (/claude/.test(raw)) return "claude";
  if (/gemini/.test(raw) && /pro/.test(raw)) return "gemini-pro";
  if (/gemini/.test(raw) && /flash/.test(raw)) return "gemini-flash";
  if (/gemini/.test(raw)) return "gemini";
  if (/gpt|codex/.test(raw)) return "gpt";
  if (/grok/.test(raw)) return "grok";
  if (/cursor|composer/.test(raw)) return "cursor";
  if (/deepseek|dsh/.test(raw)) return "deepseek";
  return raw;
}

/** Monthly / plan-limit windows cap the whole engine, not one model.
 *  A 5-hour or weekly remainder must not hide a spent monthly bar. */
export function isPlanLevelSkip(window: QuotaWindowMatch): boolean {
  if (!window.skip) return false;
  const hay = `${window.window ?? ""} ${window.label} ${window.skipReason ?? ""}`.toLowerCase();
  return window.window === "monthly" || /monthly|upgrade your plan|plan limit/.test(hay);
}

export function modelsToSkip(window: QuotaWindowMatch, instance: QuotaPollerInstanceLike): string[] {
  if (!window.skip) return [];
  if (isPlanLevelSkip(window)) return ["*"];
  if (window.modelId) return [window.modelId];
  const families = new Set(familiesForWindow(window));
  const options = instance.models?.options ?? [];
  return options.map((row) => row.id).filter((id) => families.has(modelTypeFromId(id)));
}

export function windowsForDriver(
  windows: QuotaWindowMatch[],
  driverKind: string,
): QuotaWindowMatch[] {
  return windows.filter((window) => driverKindsForWindow(window).includes(driverKind));
}
