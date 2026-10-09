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

import { ProviderMark } from "../components/ProviderIcons.tsx";

/** Brand name for a driver kind, for the mark's tooltip.  Only the kinds a
 *  row actually lists need an entry; an unlisted kind falls back to its raw
 *  spelling rather than rendering an empty tooltip. */
const PROVIDER_MARK_LABELS: Readonly<Record<string, string>> = {
  deepseekAgent: "DeepSeek",
  dsh: "DeepSeek",
  dshAgent: "DeepSeek",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  minimaxAgent: "MiniMax",
  mcode: "MiniMax",
  mcodeAgent: "MiniMax",
};

function providerMarkLabel(driverKind: string): string {
  return PROVIDER_MARK_LABELS[driverKind] ?? driverKind;
}

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

/** Every verdict a cell can carry.  `unknown` is a real verdict, not the
 *  absence of one: nobody has audited this (engine, capability) pair, and
 *  the matrix must say so in its own voice instead of borrowing the "no"
 *  tone.  A registry key that is missing entirely resolves to the same
 *  word, so the old failure mode — an unaudited pair wearing the
 *  "not available" colour while printing a dash — cannot come back.
 *  `engine-capabilities.test.ts` fails the build when a registered engine
 *  omits a key, so the honest answer becomes explicit `"unknown"`. */
export type CapabilityState = "yes" | "no" | "limited" | "yes-pro-only" | "unknown";

/** The full state vocabulary, in the order the matrix legend lists it. */
export const CAPABILITY_STATES: readonly CapabilityState[] = [
  "yes",
  "limited",
  "yes-pro-only",
  "no",
  "unknown",
] as const;

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
  /** Per-engine explanation of one capability, used by the matrix detail
   *  strip.  Wins over the capability-level `CAPABILITY_NOTES` entry, which
   *  in turn wins over `whyThisEngine.headline`.  Write it about the
   *  *build*, never about the model: "BotFleet does not wire this here" is a
   *  gap in the wiring, not a claim that the model cannot do it. */
  capabilityNotes?: Partial<Record<CapabilityKey, string>>;
  /** Provider brands this engine actually serves, rendered as marks beside
   *  the "Why This Engine" headline.  More than one is normal and says
   *  something real: Clutch carries both DeepSeek and MiniMax because the
   *  bridge hosts models from both providers, which a single "Clutch" name
   *  hides completely.  Leave absent when the engine is one brand, because the
   *  row's own badge already names it. */
  providerKinds?: readonly string[];
  /** True when the model list comes from whatever local hosts the user has
   *  configured rather than from a catalog this build ships — the
   *  `host::model` inject ids behind `server/drivers/local-inject.ts`.  Such
   *  an engine has no fleet-wide default to name, so it declares an empty
   *  `defaultModels` and says so here instead of inventing a plausible id. */
  catalogIsHostDriven?: boolean;
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
  "Claude subscription.  BotFleet does not register an Anthropic API rate for this engine.";

const CODEX_PRO_LITE_NOTE =
  "ChatGPT subscription.  BotFleet does not register a separate OpenAI API rate for this engine.";

const MINIMAX_TOKEN_PLAN_NOTE =
  "MiniMax Token Plan subscription.  PAYG API rates below are the public catalog for the what-if projection, not an invoice.";

const MCODE_TOKEN_PLAN_NOTE =
  "MiniMax Code authenticates with the MiniMax Code CLI login and shares the MiniMax Token Plan with the MiniMax API engine.  PAYG API rates below are the public catalog for the what-if projection, not an invoice.";

const GROK_SUPER_NOTE =
  "xAI subscription.  API rates below are the public catalog for the what-if projection, not an invoice.";

const ANTIGRAVITY_ULTRA_NOTE =
  "Google AI subscription.  Gemini API rates below are the public catalog for the what-if projection, not an invoice.";

const DEEPSEEK_HARNESS_NOTE =
  "Clutch runs models over the Clutch ACP bridge.  Billing is DeepSeek pay-as-you-go at the public API catalog.  There is no subscription line on this engine.";

/** The registry's owner contract.  Named rather than spelled
 *  `Record<string, EngineCapabilityEntry>` at the binding so the string index
 *  signature stays open — custom engines add ids that are in no union this
 *  module declares — while every value in it still has to be a real
 *  `EngineCapabilityEntry`.  A named contract is what a reader has to keep
 *  honest; a bare `Record` says nothing about who owns the map. */
export interface EngineCapabilityRegistry
  extends Record<string, EngineCapabilityEntry> {}

export const ENGINE_CAPABILITIES: EngineCapabilityRegistry = {
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
      // The Grok driver mounts no Connected Apps channel and no computer-use
      // channel, and the prose below already recorded the rooms and voice
      // gaps.  All four are BotFleet gaps on this build, not limits on what
      // the model can do — hence "no" rather than "unknown" here.
      connectedApps: "no",
      roomCoordination: "no",
      voiceChat: "no",
      computerUse: "no",
    },
    capabilityNotes: {
      longContext:
        "Grok 4.7 holds half a million tokens in one turn.  Prompts at or above 200,000 tokens bill at the higher long-context rate.",
      crossBotCoordination:
        "Team tools are mounted, so a Grok bot can ask another bot for work.  The channel is partially built, so treat a long hand-off as less reliable than a direct ask.",
      connectedApps:
        "The Grok Build driver mounts the Connected Apps bridge, but nobody has run the end-to-end path on a real Grok turn yet.  The cell says not available because that is what a user would hit today, not because the wiring is missing.",
      computerUse:
        "The driver carries the screen channel and the matrix still calls it unavailable, because no turn on this engine has driven another computer's screen yet.  Say the word and it can be audited and flipped.",
    },
    whyThisEngine: {
      headline: "Grok 4.7 with long context and live research.",
      prose: [
        "Grok 4.7 is available on an xAI subscription.  Files, terminal, this computer, web access, image attachments, long context, and live research are available.",
        "Cross-bot coordination is limited on this build.  Connected apps, rooms, voice chat, and computer use are not available on the Grok engine yet.",
        "A public xAI API rate card is kept for the what-if projection.  Those rates are a catalog reference, not an invoice.",
      ],
    },
    defaultModels: [
      { id: "grok-4.7", display: "Grok 4.7", ctxTokens: 500_000 },
      { id: "grok-4.6", display: "Grok 4.6" },
      // The Grok Build (ACP) catalog id — see server/drivers/acp/grok.ts.
      { id: "grok-4.7-build-fast", display: "Grok 4.7 Build Fast" },
      // Composer 2.5 is Cursor's model, served through the Grok Build CLI on
      // accounts that have it.  It is listed under Cursor too, on purpose:
      // uniqueModelToEngineId() leaves an id shared across engines unmapped,
      // so a metadata-free Composer bucket still resolves through its own
      // instance (Cursor) instead of being credited to Grok.  Do not remove
      // it from the Cursor list without removing it from this one.
      { id: "composer-2.5", display: "Composer 2.5" },
      // xAI's coding model (also an API id).  Unique to this engine.  Priced
      // at its published beta rates ($1 input / $2 output per million tokens,
      // https://x.ai/news/grok-build-0-1), which differ from the Grok 4.7 card
      // above.  The what-if projection prices a whole engine from one card and
      // keeps no per-model rate table, so those rates are not recorded here.
      { id: "grok-build-0.1", display: "Grok Build 0.1" },
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
      // Recorded gaps, from the prose below: the registry deliberately
      // treats these as BotFleet work still to do on the Cursor CLI.
      connectedApps: "no",
      roomCoordination: "no",
      voiceChat: "no",
      computerUse: "no",
      // No verdict was ever recorded for a research pass on Cursor, so the
      // matrix says so rather than guessing in either direction.
      liveResearch: "unknown",
    },
    capabilityNotes: {
      connectedApps:
        "Cursor's ACP driver does mount the Connected Apps bridge — the same mount Claude and Codex use.  This engine stays marked unavailable because the path has not been walked end to end on a real Cursor turn, and a green cell on an unrun path is how a bot gets told to use a channel that has never worked for it.",
      computerUse:
        "The screen channel is mounted for this driver and unaudited on a real turn, so the cell stays unavailable until someone drives another computer's screen with Cursor and can report what happened.",
    },
    whyThisEngine: {
      headline: "Cursor's coding agent, driven over ACP.",
      prose: [
        "BotFleet drives the Cursor CLI over ACP.  Files, terminal, this computer, web access, image attachments, and long context are available.",
        "Cross-bot coordination is available.  Connected apps, rooms, voice chat, and computer use are not available on the Cursor engine yet.",
        "Pricing mode is a Cursor subscription.  BotFleet does not register a separate Cursor API rate.",
      ],
    },
    defaultModels: [
      { id: "cursor-default", display: "Cursor Default", ctxTokens: 200_000 },
      { id: "claude-sonnet-4.5", display: "Claude Sonnet 4.5 (via Cursor)", ctxTokens: 200_000 },
      // Also listed under Grok (Grok Build serves Composer 2.5 too).  Shared
      // on purpose — see the Grok list.  server/drivers/acp/cursor.ts carries
      // this id in STATIC_CURSOR_MODELS.
      { id: "composer-2.5", display: "Composer 2.5" },
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
      // The widest surface in the registry, and still one cell nobody
      // recorded a verdict for.  Claude is the engine most likely to grow
      // this, so it must not quietly read as unsupported.
      liveResearch: "unknown",
    },
    capabilityNotes: {
      computerUse:
        "The Claude driver drives another computer's screen itself, so the actions arrive as tool calls rather than as a remote session someone has to babysit.",
      voiceChat:
        "Claude is the one engine where a voice turn is a first-class turn, not a text turn with a voice skin on it.",
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
      // Recorded gaps, from the prose below.
      crossBotCoordination: "no",
      roomCoordination: "no",
      voiceChat: "no",
      liveResearch: "no",
    },
    capabilityNotes: {
      longContext:
        "GPT-5 Codex holds 400,000 tokens in one turn, enough to keep a large repository and its history in the same prompt.",
      computerUse:
        "The Codex driver drives another computer's screen, so clicks and typing arrive as tool calls under the same approval cards as everything else.",
      crossBotCoordination:
        "Team tools are mounted for this driver and have not been exercised on a Codex turn, so the cell stays unavailable rather than claiming a hand-off nobody has watched work.",
    },
    whyThisEngine: {
      headline: "OpenAI coding models with files, terminal, and computer use.",
      prose: [
        "Codex runs OpenAI coding models on a ChatGPT subscription.  Files, terminal, this computer, web access, image attachments, connected apps, and long context are available.",
        "Computer use is available.  Cross-bot coordination, rooms, voice chat, and live research are not available on the Codex engine yet.",
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
      // Recorded gaps, from the prose below.
      crossBotCoordination: "no",
      roomCoordination: "no",
      voiceChat: "no",
      computerUse: "no",
      // The driver mounts a computer-use channel, but no verdict was ever
      // recorded for holding a million tokens on a Gemini turn.  Flagged
      // rather than guessed: the model window and the wiring are different
      // questions, and only the first one is answered.
      longContext: "unknown",
    },
    capabilityNotes: {
      liveResearch:
        "Gemini runs the research pass itself, so a bot can sweep several sources inside one turn and come back with the answer rather than a list of links.",
      computerUse:
        "The driver mounts the screen channel and this engine has never driven another computer's screen, so the cell stays unavailable until someone does and can report the result.",
      crossBotCoordination:
        "Team tools ride the Antigravity mount but no Antigravity turn has asked a peer for work yet, so the cell stays unavailable rather than guessing from the wiring.",
    },
    whyThisEngine: {
      headline: "Gemini models with files, web, images, and live research.",
      prose: [
        "Antigravity runs Gemini models on a Google AI subscription.  Files, terminal, this computer, web access, image attachments, and connected apps are available.",
        "Live research is available.  Quota is reported as four windows:  Gemini Models and Third-Party Models, each across a 5-hour period and a weekly period.",
        "Cross-bot coordination, rooms, voice chat, and computer use are not available on the Antigravity engine yet.  Public Gemini API rates are a catalog reference for the what-if projection, not an invoice.",
      ],
    },
    defaultModels: [
      { id: "gemini-2.5-pro", display: "Gemini 2.5 Pro", ctxTokens: 1_000_000 },
      { id: "gemini-2.5-flash", display: "Gemini 2.5 Flash", ctxTokens: 1_000_000 },
    ],
  },

  "deepseek-harness": {
    id: "deepseek-harness",
    displayName: "Clutch",
    capabilityBadgeColor: "bg-rose-600 text-white",
    // The one row where the engine name hides something: the Clutch bridge
    // hosts models from BOTH providers, and "Clutch" says neither.  Its model
    // catalog is two DeepSeek tiers, two MiniMax tiers, and nothing else, so
    // both marks belong in the Why This Engine block.
    providerKinds: ["deepseekAgent", "minimax"],
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
      // The DSH ACP adapter declares images support (`server/drivers/acp/dsh.ts`
      // sets `images: true`, and `dsh.test.ts` pins the adapter capability),
      // so the composer accepts image input on this engine.  Whether a given
      // model takes the image is per model — see the prose below.
      imageAttachments: "yes",
      // The DSH ACP adapter declares composioMcp
      // (server/drivers/acp/dsh.test.ts) — the matrix used to render
      // "-" here because the registry omitted it.
      connectedApps: "yes",
      crossBotCoordination: "yes",
      // The ACP bridge mounts the channels, but four of these pairs have
      // never been audited against a real DeepSeek turn.  "unknown" is the
      // honest cell: the bridge being generic says nothing about whether a
      // DeepSeek model uses the channel well once it is mounted.
      longContext: "unknown",
      roomCoordination: "unknown",
      voiceChat: "unknown",
      computerUse: "unknown",
      liveResearch: "unknown",
    },
    capabilityNotes: {
      crossBotCoordination:
        "Team tools ride the same generic ACP mount, so a DeepSeek bot can hand work to a peer and take it back.",
    },
    whyThisEngine: {
      headline: "DeepSeek models over the Clutch ACP bridge, billed pay-as-you-go.",
      prose: [
        "Clutch runs DeepSeek models through BotFleet's Clutch ACP bridge.  Files, terminal, this computer, web access, image attachments, connected apps, and cross-bot coordination are available.  Image attachments are per model:  DeepSeek-V4.1-Flash accepts images, while DeepSeek-V4.1-Pro carries a No Vision badge.",
        "Billing is DeepSeek pay-as-you-go.  The rates in Pricing Mode are the public API catalog, not a subscription invoice.",
      ],
    },
    defaultModels: [
      { id: "deepseek-chat", display: "DeepSeek Chat", ctxTokens: 64_000 },
      { id: "deepseek-reasoner", display: "DeepSeek Reasoner", ctxTokens: 64_000 },
    ],
  },

  minimax: {
    id: "minimax",
    // "MiniMax API", not "MiniMax".  These two rows used to be "MiniMax" and
    // "MiniMax Code", which is a distinction the reader has to work out from
    // one word of difference — and the wrong guess is expensive, because the
    // API engine has no Connected Apps channel and the CLI engine has all of
    // them.  Naming the transport in both rows makes the pair self-explaining:
    // one is the HTTP driver, one is the CLI.  `minimax.ts` speaks the HTTP
    // driver here, and the comment above it already says the CLI's binary has
    // no bearing on whether a turn works.
    displayName: "MiniMax API",
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
      // The direct driver exposes neither a web tool nor image input, and
      // neither has been audited on a real turn.  Marked "unknown" so the
      // matrix does not claim a gap nobody measured.
      webAccess: "unknown",
      imageAttachments: "unknown",
      computerUse: "unknown",
      liveResearch: "unknown",
    },
    capabilityNotes: {
      connectedApps:
        "Connected Apps is the Composio bridge, and the direct MiniMax driver declares no such channel.  This engine reaches the outside world through its own tools and through this Mac instead.",
      roomCoordination:
        "Rooms and peers are both mounted here, which makes the MiniMax API engine the one that holds a channel conversation best across the fleet.",
    },
    whyThisEngine: {
      headline: "Files, terminal, rooms, voice, and long context.",
      prose: [
        "The MiniMax API engine runs on a Token Plan subscription.  Files, terminal, this computer, long context, cross-bot coordination, and rooms are available.",
        "Voice chat is available.  Connected apps are not available on the MiniMax API engine yet.",
        "Public PAYG API rates are kept for the what-if projection.  They are a catalog reference, not an invoice.",
      ],
    },
    defaultModels: [
      { id: "MiniMax-M3.1-Flash-Preview", display: "MiniMax M3.1 Flash Preview", ctxTokens: 1_000_000 },
      { id: "MiniMax-H3", display: "MiniMax H3", ctxTokens: 256_000 },
    ],
  },

  mcode: {
    id: "mcode",
    displayName: "MiniMax Code",
    // One shade off MiniMax's violet on purpose.  The two engines sit next to
    // each other in the matrix, run the same account, and offer the same
    // flagship model, so identical chips would read as one row.
    capabilityBadgeColor: "bg-violet-500 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        tierLabel: "MiniMax Token Plan Max",
        costPerMonth: 132,
        includedQuota: "MiniMax Token Plan Max quota",
        notes: MCODE_TOKEN_PLAN_NOTE,
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
      webAccess: "yes",
      // The driver declares `images: true`, so the composer accepts image
      // input on this engine the way it does on the other coding CLIs.
      imageAttachments: "yes",
      // The ACP core mounts MCP servers for this driver, and composioMcp
      // answers from that one question — so the Connected Apps channel is
      // present here even though the direct MiniMax engine does not have it.
      connectedApps: "yes",
      crossBotCoordination: "yes",
      longContext: "yes",
      // Recorded gaps, from the prose below.
      roomCoordination: "no",
      voiceChat: "no",
      computerUse: "no",
      liveResearch: "no",
    },
    capabilityNotes: {
      connectedApps:
        "The ACP core mounts the Connected Apps bridge for this driver, so the channel is present even though the direct MiniMax engine does not have it.",
      thisComputer:
        "MiniMax Code runs its own CLI on this Mac, so the bot reads and writes the same working folder the rest of the fleet does.",
      computerUse:
        "The ACP core mounts the screen channel for this driver, and no MiniMax Code turn has used it yet, so the cell stays unavailable instead of claiming a screen a bot has never driven with this engine.",
    },
    whyThisEngine: {
      headline: "MiniMax's own coding CLI, driven over the same Token Plan.",
      prose: [
        "MiniMax Code runs MiniMax's coding CLI inside BotFleet.  Files, terminal, this computer, web access, image attachments, connected apps, cross-bot coordination, and long context are available.",
        "It signs in with the CLI's own login and draws on the same Token Plan as the MiniMax engine, so the two rows report one subscription.",
        "Rooms, voice chat, computer use, and live research are not available on the MiniMax Code engine yet.",
      ],
    },
    defaultModels: [
      { id: "MiniMax-M3.1-Flash-Preview-thinking", display: "MiniMax M3.1 Flash Preview · thinking", ctxTokens: 1_000_000 },
      // Context length for the M2.7 tiers is not published in the CLI's own
      // catalog, so no figure is claimed here.
      { id: "MiniMax-M2.7-highspeed-thinking", display: "MiniMax M2.7 Highspeed · thinking" },
    ],
  },

  muse: {
    id: "muse",
    displayName: "Muse Code",
    capabilityBadgeColor: "bg-blue-500 text-white",
    group: "Cloud",
    pricing: {
      kind: "subscription+api",
      subscription: {
        // Everyday / High / Power.  Meta names the three plans and describes
        // the quota on each, and publishes no price for any of them, so
        // `costPerMonth` stays null and the chip states the plan without
        // inventing an amount — the same treatment Cursor Ultra gets.
        tierLabel: "Muse Code subscription",
        costPerMonth: null,
        includedQuota: "Everyday, High, and Power plans",
        notes:
          "Muse Code subscription.  Meta publishes plan names and quotas but no monthly price, so BotFleet does not state one.  PAYG rates below are the public Model API catalog, not an invoice.",
      },
      api: {
        // Muse Spark STANDARD tier, per 1M tokens: $1.25 in / $0.15 cached /
        // $4.25 out.  Divided by 1000 for the per-1k shape the projection
        // uses.  No long-context tier: Meta bills the same rate whether the
        // window is nearly empty or nearly full, which is unusual enough to
        // be worth saying in the note rather than encoding a tier.
        inputPer1k: 0.00125,
        outputPer1k: 0.00425,
        cachedInputPer1k: 0.00015,
        notes:
          "Muse Spark Standard pay-as-you-go rates.  These are Standard, not Contributor:  a live run on a Contributor account reported its model as muse-spark-1.3-contributor, and Contributor is roughly an order of magnitude cheaper per token, so treat this as an upper bound rather than your bill.  No long-context premium — a full 1M window costs the same per token as an empty one.  Catalog reference for the what-if projection, not an invoice.  Source:  https://dev.meta.ai/docs/pricing-rate-limits",
      },
      notes: "Subscription is the pricing mode.  API rates are a what-if catalog, not an invoice.",
    },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      longContext: "yes",
      imageAttachments: "yes",
      // Mounted by the ACP adapter, which forwards the MCP servers BotFleet
      // hands `session/new` into Muse through a private overlay.  Unaudited on
      // a real turn, so the cell says so rather than claiming a channel
      // nobody has watched work.
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      // The screen channel rides the same MCP mount as the row above.
      computerUse: "unknown",
      // Voice is a TUI affordance — Alt+V in the composer, off by default on
      // Linux, unavailable on Windows — and there is no MSP method for it, so
      // an external client cannot reach it.  That is a measured absence, not
      // an unaudited one.
      voiceChat: "no",
      // No first-party web tool appears anywhere in the Muse Code docs; the
      // official recipes reach the web through MCP.  Not proven absent, so
      // the honest cell is unaudited.
      webAccess: "unknown",
      liveResearch: "unknown",
    },
    capabilityNotes: {
      connectedApps:
        "The ACP adapter takes BotFleet's MCP servers off session/new and merges them into Muse through a private overlay, leaving the user's settings file untouched.  Two limits ride along:  SSE is not supported, and Muse reports MCP connection state as unknown, so a server that fails to start surfaces as a failed turn rather than a reported disconnect.",
      imageAttachments:
        "The adapter takes PNG, JPEG, GIF, and WebP image parts on a turn.  Audio is rejected, which is not a channel this matrix tracks.",
      longContext:
        "Muse Spark holds 1,048,576 tokens in one turn, and Meta bills no long-context premium, so filling the window costs the same per token as an empty one.",
      voiceChat:
        "Voice lives in Muse Code's own terminal composer and has no session-protocol method, so BotFleet cannot start a voice turn on this engine.",
      thisComputer:
        "Muse Code runs its CLI on this Mac, so the bot reads and writes the same working folder the rest of the fleet does.",
    },
    whyThisEngine: {
      headline: "Meta's coding CLI, over a 1M-token window with no long-context premium.",
      prose: [
        "Muse Code runs inside BotFleet through Meta's Muse Spark models.  Files, terminal, this computer, image attachments, and long context are available.",
        "The model a turn actually uses is your account's startup model, which the engine does not control yet; the matrix names Muse Spark 1.2 because that is the one this driver can point at.",
        "Connected apps, cross-bot coordination, rooms, and computer use are mounted through the adapter but have not completed a real turn yet, so the matrix marks them unaudited rather than claiming them.",
        "Voice chat is not available on this engine.  BotFleet drives Muse Code through a community ACP adapter, because Muse Code speaks its own session protocol rather than ACP.",
        "Signing in needs an API key:  a browser session stored in the Mac keychain is not readable by the adapter, so a keychain-only account cannot run a turn.",
      ],
    },
    defaultModels: [
      // The CLI's own documented default, not the best model on the card:
      // muse-spark-1.3 is "tuned for agentic workflows" and is the Model API
      // default, but the CLI defaults to 1.2, and no model switch is wired
      // yet.  Listing 1.3 would put a row in the picker a user can select and
      // cannot get.  See `server/drivers/acp/muse.ts`.
      { id: "muse-spark-1.2", display: "Muse Spark 1.2", ctxTokens: 1_048_576 },
    ],
  },

  kimi: {
    id: "kimi",
    displayName: "Kimi",
    capabilityBadgeColor: "bg-slate-700 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Pricing for this engine is not recorded in this build." },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      // The ACP core mounts MCP for this driver by default — the driver
      // declares no opt-out — so the channel is present and unaudited.
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      computerUse: "unknown",
      // The ACP core also defaults image input on when a driver does not
      // disable it.  That default is an omission rather than a declaration,
      // and no turn has confirmed the engine can read one.
      imageAttachments: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    capabilityNotes: {
      connectedApps:
        "The driver declares no MCP opt-out, so the ACP core mounts BotFleet's servers for it.  Nobody has run a Kimi turn against a real Connected Apps call yet.",
    },
    whyThisEngine: {
      headline: "Moonshot's coding CLI, driven over ACP.",
      prose: [
        "BotFleet drives the Kimi CLI over ACP.  Files, terminal, and this computer are available.",
        "Every other channel is mounted by the driver but unaudited on a real Kimi turn, so the matrix says not audited rather than guessing in either direction.",
        "Pricing for this engine is not recorded in this build.",
      ],
    },
    defaultModels: [
      { id: "kimi-code/k3", display: "Kimi K3" },
      { id: "kimi-code/k3-256k", display: "Kimi K3 256K" },
      { id: "kimi-code/kimi-for-coding", display: "Kimi for Coding" },
      { id: "kimi-code/kimi-for-coding-highspeed", display: "Kimi for Coding Highspeed" },
    ],
  },

  droid: {
    id: "droid",
    displayName: "Droid",
    capabilityBadgeColor: "bg-stone-800 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Pricing for this engine is not recorded in this build." },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      computerUse: "unknown",
      imageAttachments: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    capabilityNotes: {
      crossBotCoordination:
        "Factory's CLI ships a multi-provider catalog — Claude, GPT, Gemini, GLM, Kimi, and Grok models behind one engine.  The fleet tools are mounted by the same default the other ACP drivers use, and no Droid turn has asked a peer for work yet.",
    },
    whyThisEngine: {
      headline: "Factory's CLI, one engine over several providers' models.",
      prose: [
        "BotFleet drives the Droid CLI over ACP.  Files, terminal, and this computer are available.",
        "The engine's own catalog spans several providers, which is why its row carries one badge rather than a model-family claim.",
        "Every other channel is mounted but unaudited, and pricing for this engine is not recorded in this build.",
      ],
    },
    defaultModels: [
      { id: "claude-opus-5", display: "Claude Opus 5" },
      { id: "auto", display: "Auto (Factory picks)" },
      { id: "claude-sonnet-5", display: "Claude Sonnet 5" },
      { id: "gpt-5.6-sol", display: "GPT-5.6 Sol" },
      { id: "gemini-3.1-pro-preview", display: "Gemini 3.1 Pro" },
    ],
  },

  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    capabilityBadgeColor: "bg-teal-600 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Pricing for this engine is not recorded in this build." },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      computerUse: "unknown",
      imageAttachments: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    whyThisEngine: {
      headline: "The open-source coding CLI, driven over ACP.",
      prose: [
        "BotFleet drives the OpenCode CLI over ACP.  Files, terminal, and this computer are available.",
        "Every other channel is mounted by the driver but unaudited on a real OpenCode turn, so the matrix says not audited.",
        "Pricing for this engine is not recorded in this build.",
      ],
    },
    defaultModels: [{ id: "opencode/x-preview-f-free", display: "OpenCode Preview" }],
  },

  qwen: {
    id: "qwen",
    displayName: "Qwen",
    capabilityBadgeColor: "bg-purple-600 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Custom host, so pricing follows whichever endpoint is configured." },
    catalogIsHostDriven: true,
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      computerUse: "unknown",
      imageAttachments: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    whyThisEngine: {
      headline: "Qwen Code as a custom host, so you choose the endpoint.",
      prose: [
        "BotFleet drives the Qwen Code CLI over ACP.  Files, terminal, and this computer are available.",
        "The model list comes from whichever local host you have configured rather than from a catalog this build ships, so there is no default model to name here.",
        "Every other channel is mounted but unaudited, and pricing follows the endpoint you configure.",
      ],
    },
    defaultModels: [],
  },

  hermes: {
    id: "hermes",
    displayName: "Hermes",
    capabilityBadgeColor: "bg-orange-700 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Custom host, so pricing follows whichever endpoint is configured." },
    catalogIsHostDriven: true,
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      computerUse: "unknown",
      imageAttachments: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    whyThisEngine: {
      headline: "Hermes as a custom host, so you choose the endpoint.",
      prose: [
        "BotFleet drives the Hermes CLI over ACP.  Files, terminal, and this computer are available.",
        "The model list comes from whichever local host you have configured, so there is no default model to name here.",
        "Every other channel is mounted but unaudited, and pricing follows the endpoint you configure.",
      ],
    },
    defaultModels: [],
  },

  pi: {
    id: "pi",
    displayName: "pi",
    capabilityBadgeColor: "bg-neutral-800 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Custom host, so pricing follows whichever endpoint is configured." },
    catalogIsHostDriven: true,
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      connectedApps: "unknown",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      computerUse: "unknown",
      imageAttachments: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    capabilityNotes: {
      connectedApps:
        "pi has no MCP client of its own, so BotFleet mounts its servers through the pi MCP extension as stdio servers.  The channel is declared and unaudited on a real pi turn.",
    },
    whyThisEngine: {
      headline: "A custom-host engine whose channels arrive as mounted stdio servers.",
      prose: [
        "BotFleet drives the pi CLI.  Files, terminal, and this computer are available.",
        "pi takes no MCP client of its own, so every channel reaches it through an extension BotFleet mounts.",
        "Every other channel is declared but unaudited, and pricing follows the endpoint you configure.",
      ],
    },
    defaultModels: [],
  },

  "openai-compat": {
    id: "openai-compat",
    displayName: "OpenAI-Compatible",
    capabilityBadgeColor: "bg-green-700 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Custom host, so pricing follows whichever endpoint is configured." },
    capabilities: {
      files: "yes",
      terminal: "yes",
      thisComputer: "yes",
      // Measured absences: this driver declares no Composio bridge and no
      // screen channel, so these are real "no" cells rather than unknowns.
      connectedApps: "no",
      computerUse: "no",
      imageAttachments: "no",
      crossBotCoordination: "unknown",
      roomCoordination: "unknown",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    capabilityNotes: {
      connectedApps:
        "This driver reaches whatever endpoint you configure and nothing else — it mounts the agents and local-computer channels and no Composio bridge.",
    },
    whyThisEngine: {
      headline: "Any OpenAI-compatible endpoint, as a custom host.",
      prose: [
        "BotFleet drives any OpenAI-compatible endpoint — OpenRouter, Groq, or a local server.  Files, terminal, and this computer are available.",
        "Connected apps, computer use, and image attachments are not available, because this driver mounts only the agents and local-computer channels.",
        "Pricing follows the endpoint you configure rather than a plan this build ships.",
      ],
    },
    defaultModels: [
      { id: "meta-llama/llama-3.3-70b-instruct", display: "Llama 3.3 70B (OpenRouter)" },
      { id: "llama-3.3-70b-versatile", display: "Llama 3.3 70B (Groq)" },
    ],
  },

  box: {
    id: "box",
    displayName: "ASCII.dev Box",
    capabilityBadgeColor: "bg-cyan-700 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Pricing for this engine is not recorded in this build." },
    capabilities: {
      files: "yes",
      terminal: "yes",
      // Measured absence: the driver declares no local-computer channel.
      thisComputer: "no",
      connectedApps: "no",
      crossBotCoordination: "no",
      computerUse: "no",
      imageAttachments: "no",
      roomCoordination: "no",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    capabilityNotes: {
      computerUse:
        "Worth an audit:  this engine runs on a remote sandbox, yet its driver declares no screen channel at all.  A box you cannot see is a strange default, and it is the one cell on this row most likely to be wrong.",
    },
    whyThisEngine: {
      headline: "A remote sandbox reached over its own API.",
      prose: [
        "BotFleet drives ASCII.dev Box as a remote sandbox.  Files and terminal are available.",
        "This driver mounts no channel at all, so connected apps, peers, rooms, and computer use are all unavailable — including the screen channel, which is worth an audit on an engine that exists to be looked at.",
        "Pricing for this engine is not recorded in this build.",
      ],
    },
    defaultModels: [
      { id: "claude-fable-5", display: "Claude Fable 5 · on the box" },
      { id: "sonnet", display: "Claude Sonnet · on the box" },
      { id: "gpt-5.4", display: "GPT-5.4 (Codex) · on the box" },
    ],
  },

  "cli-wrapper": {
    id: "cli-wrapper",
    displayName: "Generic CLI Wrapper",
    capabilityBadgeColor: "bg-zinc-500 text-white",
    group: "Cloud",
    pricing: { kind: "unknown", notes: "Pricing depends entirely on the command this wrapper is pointed at." },
    capabilities: {
      files: "yes",
      terminal: "yes",
      // Every channel is a measured absence here, and not a close call: this
      // driver answers no requests at all, so BotFleet never hands it one.
      thisComputer: "no",
      connectedApps: "no",
      crossBotCoordination: "no",
      computerUse: "no",
      imageAttachments: "no",
      roomCoordination: "no",
      webAccess: "unknown",
      longContext: "unknown",
      liveResearch: "unknown",
      voiceChat: "unknown",
    },
    whyThisEngine: {
      headline: "Any command with a stdin, for the cases no named engine covers.",
      prose: [
        "The generic wrapper runs whatever command you point it at.  Files and terminal are available.",
        "It mounts no channel, and it cannot answer a request for permission, so every BotFleet channel is unavailable on it.",
        "Pricing depends entirely on the command behind the wrapper.",
      ],
    },
    defaultModels: [{ id: "default", display: "Default CLI" }],
  },
};

/** A named block of related capabilities.  The matrix renders one spanning
 *  header per category so twelve columns read as four groups rather than a
 *  flat wall of glyphs.  Order here is the column order. */
export interface CapabilityCategory {
  id: "local" | "thisComputer" | "web" | "fleet";
  label: string;
  keys: CapabilityKey[];
}

export const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  { id: "local", label: "Files & Shell", keys: ["files", "terminal"] },
  { id: "thisComputer", label: "This Computer", keys: ["thisComputer", "computerUse"] },
  {
    id: "web",
    label: "Web & Media",
    keys: ["webAccess", "imageAttachments", "liveResearch", "longContext"],
  },
  {
    id: "fleet",
    label: "Fleet & Voice",
    keys: ["connectedApps", "crossBotCoordination", "roomCoordination", "voiceChat"],
  },
];

/** Every capability key, in matrix column order.  Derived from the
 *  categories rather than listed beside them, so a column can never drift
 *  out of its group. */
export const CAPABILITY_KEYS: CapabilityKey[] = CAPABILITY_CATEGORIES.flatMap(
  (category) => category.keys,
);

/** Full display labels — the detail strip, the cell tooltip, and the
 *  accessible name all read these. */
export const CAPABILITY_LABELS = {
  files: "Files",
  terminal: "Terminal",
  thisComputer: "This Computer",
  webAccess: "Web Access",
  imageAttachments: "Image Attachments",
  connectedApps: "Connected Apps via Composio",
  crossBotCoordination: "Cross-Bot Coordination",
  roomCoordination: "Rooms",
  voiceChat: "Voice Chat",
  computerUse: "Computer Use",
  longContext: "Long Context",
  liveResearch: "Live Research",
} satisfies Record<CapabilityKey, string>;

/** Column labels for the matrix header.  One or two words, sized to fit a
 *  single 54px column (they wrap onto a second line where they must).  The
 *  full label stays in `CAPABILITY_LABELS` for the tooltip and the detail
 *  strip, so shortening here costs the reader nothing. */
export const CAPABILITY_SHORT_LABELS = {
  files: "Files",
  terminal: "Terminal",
  thisComputer: "This Computer",
  webAccess: "Web Access",
  imageAttachments: "Images",
  connectedApps: "Apps",
  crossBotCoordination: "Peers",
  roomCoordination: "Rooms",
  voiceChat: "Voice",
  computerUse: "Screen Use",
  longContext: "Long Context",
  liveResearch: "Research",
} satisfies Record<CapabilityKey, string>;

/** What each capability actually means in BotFleet — which wiring stands
 *  behind it.  This is the copy the detail strip shows, so a reader learns
 *  what Connected Apps *is* instead of re-reading the engine's pitch.  A key
 *  may be absent — `capabilityNoteFor` falls through to the engine headline
 *  when it is — so this keeps the partial contract under a named owner rather
 *  than a mapped type that would hide the fallthrough. */
export interface CapabilityNotes extends Partial<Record<CapabilityKey, string>> {}

export const CAPABILITY_NOTES: CapabilityNotes = {
  files:
    "Reading and writing files in the working folder.  Backed by the driver's own file tools, so the bot follows the same approval and permission rules as the rest of its turn.",
  terminal:
    "Running shell commands on the machine the turn runs on.  Backed by the driver's shell tool, which is where the approval cards and the permission guards come from.",
  thisComputer:
    "Driving the computer BotFleet itself is running on.  This is a different channel from Connected Apps via Composio, and a different one again from driving another computer's screen.",
  computerUse:
    "Clicking and typing on another computer's screen the way a person drives a desktop.  Every action still runs through the same approval cards.",
  webAccess:
    "Fetching pages from the web during a turn.  Backed by the driver's web or search tool.",
  imageAttachments:
    "Reading an image the bot was sent.  A driver that does not declare image input has the attachment rejected before the model ever sees it.",
  liveResearch:
    "Running a multi-step research pass across the web inside the turn, rather than answering from what the model already knows.",
  longContext:
    "Holding a very long prompt in a single turn without the conversation being cut off.",
  connectedApps:
    "Reaching third-party services through Connected Apps via Composio.  Only a driver that mounts that channel has it; it is not the same as driving this computer.",
  crossBotCoordination:
    "Asking another bot on the fleet for work, and answering when one asks back.  Backed by the team tools every driver can mount.",
  roomCoordination:
    "Posting into a shared room and reading the conversation around it, so a bot holds its place in a channel.",
  voiceChat:
    "Speaking to the user and hearing them back inside one turn.",
};

/** Resolve the sentence the detail strip shows for one (engine, capability)
 *  pair: the engine's own note wins, then the shared capability note, then
 *  the engine's headline so the strip is never blank. */
export function capabilityNoteFor(entry: EngineCapabilityEntry, key: CapabilityKey): string {
  return (
    entry.capabilityNotes?.[key] ??
    CAPABILITY_NOTES[key] ??
    entry.whyThisEngine.headline
  );
}

/** Engine ids in display order (Cloud group first, then Local Computer).
 *  The first eight are the engines the fleet had when this registry started;
 *  the rest arrived with drivers that shipped before anyone gave them a row,
 *  and are now listed rather than left to the unregistered fallback.  A new
 *  engine that has no entry here fails `engine-capabilities.test.ts`. */
export const ENGINE_DISPLAY_ORDER: string[] = [
  "grok",
  "cursor",
  "claude",
  "codex",
  "antigravity",
  "deepseek-harness",
  "minimax",
  "mcode",
  "muse",
  "kimi",
  "droid",
  "opencode",
  "qwen",
  "hermes",
  "pi",
  "openai-compat",
  "box",
  "cli-wrapper",
];

/** Resolve the engine id from a driver-kind string when the registry and
 *  the runtime disagree.  Examples:
 *    "grokAgent"  → "grok"
 *    "claudeAgent" → "claude"
 *    "dshAgent"    → "deepseek-harness"
 *    "antigravityAgent" → "antigravity"
 *    "deepseekAgent" → "deepseek-harness"  (legacy alias — the old
 *    `deepseekAgent` driver predates the Clutch bridge and ships on
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
  // The OpenCode driver keeps its historical kind (`opencodeGo`) so existing
  // bots and instance config do not break, while the product name expanded
  // from Go to OpenCode.  The registry id follows the product name, so the
  // kind needs spelling out here.
  if (normalized === "opencodego") return "opencode";
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
/** The monthly-cost suffix a subscription tier adds to its label, or the
 *  empty string when the tier has no billed monthly amount.  `costPerMonth`
 *  is null exactly when the engine ships no separate rate for that
 *  subscription, so a Cursor Ultra row states the plan name and nothing else
 *  rather than inventing an amount. */
function monthlyCost(tier: SubscriptionTier): string {
  const { costPerMonth } = tier;
  return costPerMonth === null ? "" : ` · $${costPerMonth.toFixed(2)}/mo`;
}

export function pricingModeLabel(pricing: PricingMode): string {
  switch (pricing.kind) {
    case "subscription": {
      const cost = monthlyCost(pricing.subscription);
      return `Subscription${cost}`;
    }
    case "api":
      return `API · $${pricing.api.inputPer1k.toFixed(5)}/1k in`;
    case "subscription+api": {
      const cost = monthlyCost(pricing.subscription);
      return `Subscription + API${cost}`;
    }
    case "free":
      return "Free";
    case "unknown":
      return "Pricing unknown";
  }
}

/** The compact glyph that goes in a matrix cell.  One character, so twelve
 *  columns of them stay inside one 54px column.  Kept separate from
 *  `capabilityCellLabel` because the glyph and the word answer different
 *  questions — one is a scan target, the other is what a screen reader, a
 *  `title` tooltip, and the detail strip need. */
export function capabilityCellGlyph(state: CapabilityState | undefined): string {
  switch (state) {
    case "yes":
      return "✓";
    case "no":
      return "✗";
    case "limited":
      return "~";
    case "yes-pro-only":
      return "★";
    default:
      // "unknown" and a missing key share this glyph on purpose: both mean
      // nobody has looked, and neither is a claim that the engine can't.
      return "?";
  }
}

/** The state in words — the cell's `title`, its accessible name, and the
 *  detail strip's verdict line.  Sentence case, because it is a value
 *  rather than a heading. */
export function capabilityCellLabel(state: CapabilityState | undefined): string {
  switch (state) {
    case "yes":
      return "Available";
    case "no":
      return "Not available";
    case "limited":
      return "Limited";
    case "yes-pro-only":
      return "Pro plan only";
    default:
      return "Not audited";
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
  // Only for engines whose name hides a brand.  One brand needs no mark here —
  // the row's badge already says it — and a mark invented for a brand we do
  // not hold official art for would be worse than none.
  const providers = entry.providerKinds ?? [];
  return (
    <div
      className={className ?? "rounded-xl border border-hairline/30 bg-inset/30 p-3 text-[12.5px] leading-relaxed text-ink-secondary"}
    >
      <p className="mb-1.5 flex items-start gap-1.5 text-ink">
        {providers.length > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1">
            {providers.map((kind) => (
              <span
                key={kind}
                className="inline-flex size-4 items-center justify-center rounded-[4px] border border-hairline/40 bg-surface"
                title={`${providerMarkLabel(kind)} models`}
              >
                <ProviderMark driverKind={kind} size={14} />
              </span>
            ))}
          </span>
        )}
        {/* The label and the headline share ONE inline box on purpose.  Making
         *  them separate flex items put a 6px `gap` where the rendered space
         *  used to be, and `flex-wrap` could drop the headline onto its own
         *  line away from the label that introduces it. */}
        <span>
          <strong>Why This Engine?</strong> {entry.whyThisEngine.headline}
        </span>
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
