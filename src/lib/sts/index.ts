// STS provider selection and construction.
//
// Two things are deliberately different here from the STT seam next door.
//
// First, this is its own seam rather than a third value on STTProvider: an STS
// provider replaces the entire chained loop, it does not swap one link of it.
// The chained call path stays exactly as it is, so STS can be turned on per
// workspace without putting the existing path at risk.
//
// Second, capability is a per-provider map rather than a single
// `cloudSttConfigured` boolean.  A boolean cannot say "an xAI key but no Gemini
// key", which is the normal state once more than one provider exists, and it is
// the reason a second cloud STT provider could never be offered honestly.  Here
// each provider carries its own flag and the picker can name which key is
// missing rather than returning a generic null.

import { composeStsInstructions, normalizeEngineTimeout } from "./engine-tool";
import { createGeminiLiveSession } from "./gemini-live";
import { createXaiStsSession } from "./xai-realtime";
import type { StsBotEngine, StsProvider, StsSession } from "./types";

export * from "./types";
export {
  callBotEngine,
  composeStsInstructions,
  engineGeminiToolDefinition,
  engineToolDefinition,
  normalizeEngineTimeout,
} from "./engine-tool";

/** Every STS provider BotFleet knows how to open, in preference order. */
export const STS_PROVIDERS: readonly StsProvider[] = ["xai", "gemini"];

export interface StsCapability {
  platform: string;
  /** One flag per provider; absent means "no credential configured". */
  keys: Partial<Record<StsProvider, boolean>>;
  /** `null`/absent means Auto. */
  explicitPreference?: StsProvider | null;
  /** Whether the bridge can mint a session token at all. */
  bridgeAvailable: boolean;
}

export type StsChoice =
  | { provider: StsProvider; reason: "user-preference" | "auto-only-key" | "auto-preference" }
  | { provider: null; reason: "not-supported"; missing: "bridge" }
  | { provider: null; reason: "no-provider"; missing: "key" | "bridge" };

/**
 * Decide which STS provider handles a call.
 *
 * An explicit preference wins only when that provider actually has a key —
 * mirroring pickSTTProvider, so a preference pinned to a provider whose key was
 * removed degrades to Auto instead of failing the call.  Auto prefers the first
 * provider in STS_PROVIDERS that has a key, which makes xAI the default while
 * Gemini is used once its key exists.
 */
export function pickStsProvider(cap: StsCapability): StsChoice {
  if (!cap.bridgeAvailable) return { provider: null, reason: "not-supported", missing: "bridge" };

  const preference = cap.explicitPreference ?? null;
  if (preference && cap.keys[preference]) {
    return { provider: preference, reason: "user-preference" };
  }

  for (const provider of STS_PROVIDERS) {
    if (cap.keys[provider]) {
      return { provider, reason: preference ? "auto-preference" : "auto-only-key" };
    }
  }
  return { provider: null, reason: "no-provider", missing: "key" };
}

/** Build a session for a provider. */
export function createStsSession(provider: StsProvider): StsSession {
  switch (provider) {
    case "xai":
      return createXaiStsSession();
    case "gemini":
      return createGeminiLiveSession();
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown STS provider: ${String(exhaustive)}`);
    }
  }
}

export interface StsCallConfig {
  /** The bot's persona as the model should speak it. */
  persona: string;
  language?: string;
  /** Hand real work to the bot's own engine. Defaults to true. */
  frontEngine?: boolean;
  engineTimeoutMs?: number;
  /** Injected by the call view; omitted when the engine is unavailable. */
  botEngine?: StsBotEngine;
}

export interface PreparedStsSession {
  session: StsSession;
  instructions: string;
  timeoutMs: number;
}

/** Assemble the session and its options from workspace config. */
export function prepareStsSession(
  provider: StsProvider,
  config: StsCallConfig,
): PreparedStsSession {
  const session = createStsSession(provider);
  const frontEngine = config.frontEngine !== false;
  const engine = frontEngine ? config.botEngine : undefined;
  return {
    session,
    instructions: composeStsInstructions(config.persona, {
      engineAvailable: Boolean(engine),
      language: config.language,
    }),
    timeoutMs: normalizeEngineTimeout(config.engineTimeoutMs),
  };
}