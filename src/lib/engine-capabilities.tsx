// Engine capability + pricing registry.  The settings panel, the Usage tab,
// the API-vs-subscription projection, and the capability matrix all read
// from here.  Adding an engine is one row, not four.
//
// Sources for every entry:
//   - `server/contracts.ts` for the canonical DriverKind ids
//   - `server/quota-window-map.ts` for which engines have a real quota window
//   - `server/drivers/{grok,claude,codex,minimax,antigravity}.ts` and the
//     acp/{cursor,deepseek,grok}.ts shims for the model + driver-kind surface
//   - `src/components/ProviderIcons.tsx` for the badge accent colors
//
// User-facing copy states the product: plan name, pricing mode, and which
// capabilities this build exposes.  Public API rates are a what-if catalog,
// not an invoice.  A capability this build does not wire is a BotFleet gap,
// not a claim that the model cannot do it.

import * as React from "react";

export type CapabilityKey =
  | "files"
  | "terminal"
  | "thisComputer"
  | "webAccess"
  | "imageAttachments"
  | "connectedApps"
  | "crossBotCoordination"
  | "roomCoordination"
  | "voiceChat"
  | "computerUse"
  | "longContext"
  | "liveResearch";

export type CapabilityState = "yes" | "no" | "limited" | "yes-pro-only";

export interface ApiRates {
  /** USD per 1k input tokens. */
  inputPer1k: number;
  /** USD per 1k output tokens. */
  outputPer1k: number;
  /** USD per 1k cached-input tokens when the provider bills them separately. */
  cachedInputPer1k?: number;
  /** Long-context tier: a request whose prompt reaches `minPromptTokens` is
   *  billed at these rates for all of its tokens (xAI's "≥ 200k prompt
   *  tokens" rows). */
  longContext?: {
    minPromptTokens: number;
    inputPer1k: number;
    outputPer1k: number;
    cachedInputPer1k?: number;
  };
  notes?: string;
}

export interface SubscriptionTier {
  tierLabel: string;
  costPerMonth: number | null;
  /** Human-readable quota line, e.g. "20x usage", "100 messages / 5h". */
  includedQuota?: string;
  notes?: string;
}

export type PricingMode =
  | { kind: "subscription"; subscription: SubscriptionTier; notes?: string }
  | { kind: "api"; api: ApiRates; notes?: string }
  | {
      kind: "subscription+api";
      subscription: SubscriptionTier;
      api: ApiRates;
      notes?: string;
    }
  | { kind: "free"; notes?: string }
  | { kind: "unknown"; notes?: string };

export interface EngineModel {
  id: string;
  display: string;
  ctxTokens?: number;
}

export interface WhyThisEngine {
  headline: string;
  /** Multi-paragraph prose; rendered in <p> blocks. */
  prose: string[];
}

export interface EngineCapabilityEntry {
  id: string;
  displayName: string;
  /** Tailwind utility classes for the badge chip — matched to ProviderIcons. */
  capabilityBadgeColor: string;
  /** Group label shown by `<EngineCapabilitiesMatrix>`. */
  group: "Cloud" | "Local Computer";
  pricing: PricingMode;
  capabilities: Partial<Record<CapabilityKey, CapabilityState>>;
  whyThisEngine: WhyThisEngine;
  /** Default model ids surfaced by the Usage section when no per-session
   *  override exists.  Always at least one entry — registry invariants
   *  enforce this in `engine-capabilities.test.ts`. */
  defaultModels: EngineModel[];
}

// Cursor has no separate API block.  costPerMonth stays unset so the
// pricing chip does not invent a billed amount.  The plan name is the label.
const CURSOR_ULTRA_NOTE =
  "Cursor Ultra subscription.  BotFleet does not register a separate Cursor API rate.";

const CLAUDE_MAX_NOTE =
  "Claude Max 20× subscription.  BotFleet does not register an Anthropic API rate for this engine.";

const CODEX_PRO_LITE_NOTE =
  "ChatGPT Pro Lite subscription.  BotFleet does not register a separate OpenAI API rate for this engine.";

const MINIMAX_TOKEN_PLAN_NOTE =
  "MiniMax Token Plan Max subscription.  PAYG API rates below are the public catalog for the what-if projection, not an invoice.";

const GROK_SUPER_NOTE =
  "xAI SuperGrok Heavy subscription.  API rates below are the public catalog for the what-if projection, not an invoice.";

const ANTIGRAVITY_ULTRA_NOTE =
  "Google AI Ultra subscription.  Gemini API rates below are the public catalog for the what-if projection, not an invoice.";

const DEEPSEEK_HARNESS_NOTE =
  "DeepSeek Harness runs DeepSeek models over the harness ACP bridge.  Billing is DeepSeek pay-as-you-go at the public API catalog.  There is no subscription line on this engine.";

export const ENGINE_CAPABILITIES: Record<string, EngineCapabilityEntry> = {
  grok: {
    id: "grok",
    displayName: "Grok",
    capabilityBadgeColor: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "xAI SuperGrok Heavy",
        costPerMonth: 99,
        includedQuota: "SuperGrok Heavy plan quota",
        notes: GROK_SUPER_NOTE,
      },
      api: {
        inputPer1k: 0.002,
        cachedInputPer1k: 0.0005,
        outputPer1k: 0.006,
        // Grok 4.7 API rates: $2 input / $0.50 cached / $6 output per million tokens
        // under 200k prompt tokens; $4 / $1 / $12 at or above 200k (xAI's
        // long-context tier, billed on every token of that request).  xAI's
        // pricing page lists the grok-4.6 card; 4.7 uses the same rates.
        // Keep these API projections separate from Grok Build subscription billing.
        longContext: {
          minPromptTokens: 200_000,
          inputPer1k: 0.004,
          cachedInputPer1k: 0.001,
          outputPer1k: 0.012,
        },
        notes:
          "Grok 4.7 public API rates.  Prompts at or above 200,000 tokens use the long-context rates.  " +
          "Catalog reference for the what-if projection, not an invoice.  " +
          "Source:  https://docs.x.ai/developers/models/grok-4.7 and https://docs.x.ai/developers/pricing.",
      },
      notes: "Subscription is the pricing mode.  API rates are a what-if catalog, not an invoice.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      longContext: "yes",
      liveResearch: "yes",
      crossBotCoordination: "limited",
    },
    whyThisEngine: {
      headline: "Grok 4.7 with long context and live research.",
      prose: [
        "Grok 4.7 is available on an xAI subscription.  Files, terminal, this computer, web access, image attachments, long context, and live research are available.",
        "Cross-bot coordination is limited on this build.  BotFleet does not support connected apps, rooms, voice chat, or computer use on Grok yet.",
        "A public xAI API rate card is kept for the what-if projection.  Those rates are a catalog reference, not an invoice.",
      ],
    },
    defaultModels: [
      { id: "grok-4.7", display: "Grok 4.7", ctxTokens: 500_000 },
      { id: "grok-4.6", display: "Grok 4.6" },
      // The Grok Build (ACP) catalog id — see server/drivers/acp/grok.ts.
      { id: "grok-4.7-build-fast", display: "Grok 4.7 Build Fast" },
      { id: "grok-3-mini", display: "Grok 3 mini", ctxTokens: 131_072 },
      // Retired id kept so legacy tasks banked as model "grok-4" (no engine
      // metadata) still attribute to Grok via uniqueModelToEngineId.
      { id: "grok-4", display: "Grok 4", ctxTokens: 1_000_000 },
    ],
  },

  cursor: {
    id: "cursor",
    displayName: "Cursor",
    capabilityBadgeColor: "bg-amber-500 text-black",
    group: "Cloud",
    pricing: {
      kind: "subscription",
      subscription: {
        tierLabel: "Cursor Ultra",
        costPerMonth: null,
        includedQuota: "Cursor Ultra plan quota",
        notes: CURSOR_ULTRA_NOTE,
      },
      // No outer `notes`: UsageSection shows `pricing.notes` ahead of the
      // subscription note.  The plan sentence lives on the subscription block.
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      longContext: "yes",
      crossBotCoordination: "yes",
    },
    whyThisEngine: {
      headline: "Cursor's coding agent, driven over ACP.",
      prose: [
        "BotFleet drives the Cursor CLI over ACP.  Files, terminal, this computer, web access, image attachments, and long context are available.",
        "Cross-bot coordination is available.  BotFleet does not support connected apps, rooms, voice chat, or computer use on Cursor yet.",
        "Pricing mode is a Cursor subscription.  BotFleet does not register a separate Cursor API rate.",
      ],
    },
    defaultModels: [
      { id: "cursor-default", display: "Cursor Default", ctxTokens: 200_000 },
      { id: "claude-sonnet-4.5", display: "Claude Sonnet 4.5 (via Cursor)", ctxTokens: 200_000 },
    ],
  },

  claude: {
    id: "claude",
    displayName: "Claude",
    capabilityBadgeColor: "bg-orange-500 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription",
      subscription: {
        tierLabel: "Claude Max 20×",
        costPerMonth: 213.2,
        includedQuota: "20× plan usage on the Max tier",
        notes: CLAUDE_MAX_NOTE,
      },
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      // Driver declares composioMcp (server/drivers/claude.ts) — the
      // matrix used to render "-" here because the registry omitted it.
      connectedApps: "yes",
      longContext: "yes",
      crossBotCoordination: "yes",
      roomCoordination: "yes",
      voiceChat: "yes",
      computerUse: "yes",
    },
    whyThisEngine: {
      headline: "Files, terminal, web, images, rooms, voice, and computer use.",
      prose: [
        "Claude runs on a subscription.  Files, terminal, this computer, web access, image attachments, connected apps, and long context are available.",
        "Cross-bot coordination, rooms, voice chat, and computer use are available.",
        "Pricing mode is a Claude subscription.  BotFleet does not register an Anthropic API rate for this engine.",
      ],
    },
    defaultModels: [
      { id: "claude-opus-4", display: "Claude Opus 4", ctxTokens: 200_000 },
      { id: "claude-sonnet-4.5", display: "Claude Sonnet 4.5", ctxTokens: 200_000 },
      { id: "claude-haiku-4", display: "Claude Haiku 4", ctxTokens: 200_000 },
    ],
  },

  codex: {
    id: "codex",
    displayName: "Codex",
    capabilityBadgeColor: "bg-emerald-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription",
      subscription: {
        tierLabel: "ChatGPT Pro Lite",
        costPerMonth: 100,
        includedQuota: "Codex CLI quota on the Pro Lite plan",
        notes: CODEX_PRO_LITE_NOTE,
      },
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      // Driver declares composioMcp (server/drivers/codex.ts) — the
      // matrix used to render "-" here because the registry omitted it.
      connectedApps: "yes",
      longContext: "yes",
      computerUse: "yes",
    },
    whyThisEngine: {
      headline: "OpenAI coding models with files, terminal, and computer use.",
      prose: [
        "Codex runs OpenAI coding models on a ChatGPT subscription.  Files, terminal, this computer, web access, image attachments, connected apps, and long context are available.",
        "Computer use is available.  BotFleet does not support cross-bot coordination, rooms, voice chat, or live research on Codex yet.",
        "Pricing mode is a ChatGPT subscription.  BotFleet does not register a separate OpenAI API rate for this engine.",
      ],
    },
    defaultModels: [
      { id: "gpt-5-codex", display: "GPT-5 Codex", ctxTokens: 400_000 },
      { id: "gpt-5", display: "GPT-5", ctxTokens: 400_000 },
    ],
  },

  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    capabilityBadgeColor: "bg-blue-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "Google AI Ultra",
        costPerMonth: 105.79,
        includedQuota: "Google AI Ultra plan quota",
        notes: ANTIGRAVITY_ULTRA_NOTE,
      },
      api: {
        // Gemini 2.5 Pro public API rates.  Cached input is the public
        // context-caching tier.  Used only by the what-if projection.
        inputPer1k: 0.00125,
        outputPer1k: 0.01,
        cachedInputPer1k: 0.00031,
        notes: "Gemini 2.5 Pro public API rates.  Catalog reference for the what-if projection, not an invoice.",
      },
      notes: "Subscription is the pricing mode.  API rates are a what-if catalog, not an invoice.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      imageAttachments: "yes",
      // Driver declares composioMcp (server/drivers/antigravity.ts) —
      // the matrix used to render "-" here because the registry omitted it.
      connectedApps: "yes",
      liveResearch: "yes",
    },
    whyThisEngine: {
      headline: "Gemini models with files, web, images, and live research.",
      prose: [
        "Antigravity runs Gemini models on a Google AI subscription.  Files, terminal, this computer, web access, image attachments, and connected apps are available.",
        "Live research is available.  Quota is reported as four windows:  Gemini Models and Third-Party Models, each across a 5-hour period and a weekly period.",
        "BotFleet does not support cross-bot coordination, rooms, voice chat, or computer use on Antigravity yet.  Public Gemini API rates are a catalog reference for the what-if projection, not an invoice.",
      ],
    },
    defaultModels: [
      { id: "gemini-2.5-pro", display: "Gemini 2.5 Pro", ctxTokens: 1_000_000 },
      { id: "gemini-2.5-flash", display: "Gemini 2.5 Flash", ctxTokens: 1_000_000 },
    ],
  },

  "deepseek-harness": {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    capabilityBadgeColor: "bg-rose-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "api",
      api: {
        inputPer1k: 0.00027,
        outputPer1k: 0.0011,
        cachedInputPer1k: 0.00007,
        notes: "DeepSeek public API catalog rates for pay-as-you-go billing.",
      },
      notes: DEEPSEEK_HARNESS_NOTE,
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      webAccess: "yes",
      // DSH driver's adapter contract (`server/drivers/acp/dsh.test.ts`)
      // pins `instance.adapter.capabilities.images` to `false`, so the
      // composer rejects image input.  Render "no" rather than "yes" so
      // the matrix doesn't overclaim — Codex caught this in the review.
      imageAttachments: "no",
      // The DSH ACP adapter declares composioMcp
      // (server/drivers/acp/dsh.test.ts) — the matrix used to render
      // "-" here because the registry omitted it.
      connectedApps: "yes",
      crossBotCoordination: "yes",
    },
    whyThisEngine: {
      headline: "DeepSeek models over the harness ACP bridge, billed pay-as-you-go.",
      prose: [
        "DeepSeek Harness runs DeepSeek models through BotFleet's harness ACP bridge.  Files, terminal, this computer, web access, connected apps, and cross-bot coordination are available.",
        "Billing is DeepSeek pay-as-you-go.  The rates in Pricing Mode are the public API catalog, not a subscription invoice.",
        "BotFleet does not support image attachments on DeepSeek Harness yet.",
      ],
    },
    defaultModels: [
      { id: "deepseek-chat", display: "DeepSeek Chat", ctxTokens: 64_000 },
      { id: "deepseek-reasoner", display: "DeepSeek Reasoner", ctxTokens: 64_000 },
    ],
  },

  minimax: {
    id: "minimax",
    displayName: "MiniMax",
    capabilityBadgeColor: "bg-violet-600 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "MiniMax Token Plan Max",
        costPerMonth: 132,
        includedQuota: "MiniMax Token Plan Max quota",
        notes: MINIMAX_TOKEN_PLAN_NOTE,
      },
      api: {
        inputPer1k: 0.001,
        outputPer1k: 0.004,
        cachedInputPer1k: 0.0002,
        notes:
          "MiniMax M3 public API rates.  Prompts over 512,000 input tokens use 2x these rates.  " +
          "Catalog reference for the what-if projection, not an invoice.",
      },
      notes: "Subscription is the pricing mode.  API rates are a what-if catalog, not an invoice.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      crossBotCoordination: "yes",
      roomCoordination: "yes",
      voiceChat: "yes",
      // Connected Apps is the Composio bridge, and the MiniMax driver's
      // declared capabilities (server/drivers/minimax.ts) carry no
      // composioMcp — unlike Claude, Codex, Antigravity, pi, and the DSH
      // ACP adapter, which all declare it.  Driving THIS Mac is the
      // "thisComputer" row above (localComputerMcp + the tool loop), a
      // different thing from Connected Apps.  Render "no" so the matrix
      // stops claiming a channel the driver does not wire.
      connectedApps: "no",
      longContext: "yes",
    },
    whyThisEngine: {
      headline: "Files, terminal, rooms, voice, and long context.",
      prose: [
        "MiniMax runs on a Token Plan subscription.  Files, terminal, this computer, long context, cross-bot coordination, and rooms are available.",
        "Voice chat is available.  BotFleet does not support connected apps on MiniMax yet.",
        "Public PAYG API rates are kept for the what-if projection.  They are a catalog reference, not an invoice.",
      ],
    },
    defaultModels: [
      { id: "MiniMax-M3", display: "MiniMax M3", ctxTokens: 1_000_000 },
      { id: "MiniMax-H3", display: "MiniMax H3", ctxTokens: 256_000 },
    ],
  },
};

/** Every capability key the matrix exposes, in display order. */
export const CAPABILITY_KEYS: CapabilityKey[] = [
  "files",
  "terminal",
  "thisComputer",
  "webAccess",
  "imageAttachments",
  "connectedApps",
  "crossBotCoordination",
  "roomCoordination",
  "voiceChat",
  "computerUse",
  "longContext",
  "liveResearch",
];

/** Display labels for the matrix header cells. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  files: "Files",
  terminal: "Terminal",
  thisComputer: "This Computer",
  webAccess: "Web Access",
  imageAttachments: "Image Attachments",
  connectedApps: "Connected Apps",
  crossBotCoordination: "Cross-Bot Coordination",
  roomCoordination: "Rooms",
  voiceChat: "Voice Chat",
  computerUse: "Computer Use",
  longContext: "Long Context",
  liveResearch: "Live Research",
};

/** Engine ids in display order (Cloud group first, then Local Computer). */
export const ENGINE_DISPLAY_ORDER: string[] = [
  "grok",
  "cursor",
  "claude",
  "codex",
  "antigravity",
  "deepseek-harness",
  "minimax",
];

/** Resolve the engine id from a driver-kind string when the registry and
 *  the runtime disagree.  Examples:
 *    "grokAgent"  → "grok"
 *    "claudeAgent" → "claude"
 *    "dshAgent"    → "deepseek-harness"
 *    "antigravityAgent" → "antigravity"
 *    "deepseekAgent" → "deepseek-harness"  (legacy alias — the old
 *    `deepseekAgent` driver predates the Harness bridge and ships on
 *    users who haven't updated)
 *  Unknown driver kinds return `null` so the caller can decide whether to
 *  fall back to a generic entry instead of crashing on `undefined`. */
export function engineIdFromDriverKind(driverKind: string | undefined | null): string | null {
  if (!driverKind) return null;
  const normalized = driverKind.replace(/Agent$/i, "").toLowerCase();
  // Aliases the driver layer uses today:
  if (normalized === "dsh") return "deepseek-harness";
  if (normalized === "deepseek") return "deepseek-harness";
  if (normalized === "minimax") return "minimax";
  // antigravity / cursor / claude / codex / grok / deepseek all collapse
  // to their registry id after the Agent suffix strip.
  if (ENGINE_CAPABILITIES[normalized]) return normalized;
  return null;
}

/** Lookup helper with a friendly fallback — used by `<EngineCallout>` when
 *  the engine id is not in the registry yet.  Falls through to MiniMax's
 *  capability set so the panel still renders something useful instead of
 *  crashing on a newer engine the registry does not yet know. */
export function engineCapability(id: string): EngineCapabilityEntry {
  return (
    ENGINE_CAPABILITIES[id] ??
    {
      id,
      displayName: id,
      capabilityBadgeColor: "bg-control text-ink-secondary",
      group: "Cloud" as const,
      pricing: { kind: "unknown" as const },
      capabilities: {},
      whyThisEngine: {
        headline: "Engine not in the capability registry yet.",
        prose: [
          "This engine id is not registered in `src/lib/engine-capabilities.tsx`.",
          "Add an entry there before shipping a new engine — the settings panel, the Usage tab, and the API-vs-subscription projection all read from the same registry.",
        ],
      },
      defaultModels: [],
    }
  );
}

/** Pretty label for a pricing mode — used by both `<EngineCallout>` and
 *  `<EngineCapabilitiesMatrix>` so the wording is consistent everywhere. */
export function pricingModeLabel(pricing: PricingMode): string {
  switch (pricing.kind) {
    case "subscription": {
      const cost =
        typeof pricing.subscription.costPerMonth === "number"
          ? ` · $${pricing.subscription.costPerMonth.toFixed(2)}/mo`
          : "";
      return `Subscription${cost}`;
    }
    case "api":
      return `API · $${pricing.api.inputPer1k.toFixed(5)}/1k in`;
    case "subscription+api": {
      const cost =
        typeof pricing.subscription.costPerMonth === "number"
          ? ` · $${pricing.subscription.costPerMonth.toFixed(2)}/mo`
          : "";
      return `Subscription + API${cost}`;
    }
    case "free":
      return "Free";
    case "unknown":
      return "Pricing unknown";
  }
}

/** Cell text for the matrix — keeps the wording identical to what the
 *  legacy `<MiniMaxCallout>` used (yes / no / limited / pro only) so the
 *  visual vocabulary of the panel stays familiar. */
export function capabilityCellLabel(state: CapabilityState | undefined): string {
  switch (state) {
    case "yes":
      return "✓";
    case "no":
      return "✗";
    case "limited":
      return "limited";
    case "yes-pro-only":
      return "pro only";
    default:
      return "—";
  }
}

/** `<EngineCallout>` prose component — extracted so the matrix can also use
 *  the same `<strong>` headline + paragraph copy the legacy MiniMax callout
 *  used, instead of inventing a second block of wording. */
export function EngineCalloutBody(props: {
  entry: EngineCapabilityEntry;
  className?: string;
}): React.ReactElement {
  const { entry, className } = props;
  return (
    <div
      className={className ?? "rounded-xl border border-hairline/30 bg-inset/30 p-3 text-[12.5px] leading-relaxed text-ink-secondary"}
    >
      <p className="mb-1.5 text-ink">
        <strong>Why This Engine?</strong> {entry.whyThisEngine.headline}
      </p>
      {entry.whyThisEngine.prose.map((line, index) => (
        <p key={index} className="mb-1 last:mb-0">
          {line}
        </p>
      ))}
      <p className="mt-1.5 text-[11px] text-ink-secondary/80">
        Pricing: {pricingModeLabel(entry.pricing)}.
      </p>
    </div>
  );
}

/** Model id -> engine id for ids listed under exactly ONE engine's
 *  defaultModels list.  A model id shared across engines (for example
 *  claude-sonnet-4.5, listed under Cursor AND Claude) is left unmapped:
 *  first-wins would credit the wrong engine with a legacy task's usage,
 *  so ambiguous ids fall through to the unattributed total instead. */
export function uniqueModelToEngineId(): Map<string, string> {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [engineId, entry] of Object.entries(ENGINE_CAPABILITIES)) {
    for (const m of entry.defaultModels ?? []) {
      if (seen.has(m.id)) {
        if (seen.get(m.id) !== engineId) ambiguous.add(m.id);
      } else {
        seen.set(m.id, engineId);
      }
    }
  }
  for (const id of ambiguous) seen.delete(id);
  return seen;
}
