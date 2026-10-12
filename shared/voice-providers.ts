// Voice TTS/STT provider ids, credential checks, and fallback ladder order.
// Keys are resolved from the workspace config object after loadConfig() /
// Infisical — never read process.env here.

/** Slim config slice the ladder helpers need — keeps this module usable from
 *  the renderer without importing `server/config.ts`. */
export interface VoiceProviderConfig {
  xai?: { key?: string };
  azureSpeech?: { key?: string; region?: string };
  metaSpeech?: { key?: string };
  groq?: { key?: string };
  assemblyai?: { key?: string };
  tts?: { key?: string; provider?: string; ladder?: string[] };
  callStt?: { provider?: string | null; ladder?: string[] };
}

export const HOSTED_TTS_PROVIDERS = ["xai", "azure", "minimax"] as const;
export type HostedTtsProvider = (typeof HOSTED_TTS_PROVIDERS)[number];

export const TTS_PROVIDERS = [...HOSTED_TTS_PROVIDERS, "system"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export const CLOUD_STT_PROVIDERS = ["meta", "xai", "assemblyai", "azure", "groq"] as const;
export type CloudSttProvider = (typeof CLOUD_STT_PROVIDERS)[number];

export const CALL_STT_PROVIDERS = ["apple", ...CLOUD_STT_PROVIDERS] as const;
export type CallSttProvider = (typeof CALL_STT_PROVIDERS)[number];

/** Hosted TTS attempt order when the workspace does not override `tts.ladder`. */
export const DEFAULT_TTS_LADDER: readonly HostedTtsProvider[] = ["xai", "azure", "minimax"];

/** Cloud STT attempt order when `callStt.ladder` is absent. */
export const DEFAULT_CLOUD_STT_LADDER: readonly CloudSttProvider[] = [
  "meta",
  "xai",
  "assemblyai",
  "azure",
  "groq",
];

export type CloudSttCapabilities = Record<CloudSttProvider, boolean>;

export function emptyCloudSttCapabilities(): CloudSttCapabilities {
  return {
    meta: false,
    xai: false,
    assemblyai: false,
    azure: false,
    groq: false,
  };
}

export function anyCloudSttConfigured(cap: CloudSttCapabilities): boolean {
  return CLOUD_STT_PROVIDERS.some((id) => cap[id]);
}

function trimKey(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function ttsProviderHasCredential(cfg: VoiceProviderConfig, provider: HostedTtsProvider): boolean {
  switch (provider) {
    case "minimax":
      return Boolean(trimKey(cfg.tts?.key));
    case "xai":
      return Boolean(trimKey(cfg.xai?.key));
    case "azure":
      return Boolean(trimKey(cfg.azureSpeech?.key) && trimKey(cfg.azureSpeech?.region));
    default: {
      const _never: never = provider;
      return Boolean(_never);
    }
  }
}

export function cloudSttProviderHasCredential(cfg: VoiceProviderConfig, provider: CloudSttProvider): boolean {
  switch (provider) {
    case "assemblyai":
      return Boolean(trimKey(cfg.assemblyai?.key));
    case "xai":
      return Boolean(trimKey(cfg.xai?.key));
    case "meta":
      return Boolean(trimKey(cfg.metaSpeech?.key));
    case "azure":
      return Boolean(trimKey(cfg.azureSpeech?.key) && trimKey(cfg.azureSpeech?.region));
    case "groq":
      return Boolean(trimKey(cfg.groq?.key));
    default: {
      const _never: never = provider;
      return Boolean(_never);
    }
  }
}

export function cloudSttCapabilitiesFromConfig(cfg: VoiceProviderConfig): CloudSttCapabilities {
  const cap = emptyCloudSttCapabilities();
  for (const id of CLOUD_STT_PROVIDERS) cap[id] = cloudSttProviderHasCredential(cfg, id);
  return cap;
}

function normalizeLadder<T extends string>(allowed: readonly T[], ladder: readonly string[] | undefined): T[] {
  if (!ladder?.length) return [...allowed];
  const seen = new Set<T>();
  const out: T[] = [];
  for (const entry of ladder) {
    const id = entry.trim().toLowerCase() as T;
    if (!allowed.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of allowed) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** Ordered hosted TTS providers to try for synthesis, including fallbacks. */
export function resolveHostedTtsLadder(cfg: VoiceProviderConfig): HostedTtsProvider[] {
  const ladder = normalizeLadder(HOSTED_TTS_PROVIDERS, cfg.tts?.ladder);
  const explicit = cfg.tts?.provider;
  if (explicit === "system") return [];
  const pinned = explicit && HOSTED_TTS_PROVIDERS.includes(explicit as HostedTtsProvider)
    ? (explicit as HostedTtsProvider)
    : undefined;
  const ordered: HostedTtsProvider[] = [];
  const seen = new Set<HostedTtsProvider>();
  if (pinned) {
    ordered.push(pinned);
    seen.add(pinned);
  }
  for (const id of ladder) {
    if (seen.has(id)) continue;
    ordered.push(id);
    seen.add(id);
  }
  return ordered.filter((id) => ttsProviderHasCredential(cfg, id));
}

/** Ordered cloud STT providers with credentials on file. */
export function resolveCloudSttLadder(cfg: VoiceProviderConfig): CloudSttProvider[] {
  const ladder = normalizeLadder(CLOUD_STT_PROVIDERS, cfg.callStt?.ladder);
  const explicit = cfg.callStt?.provider;
  const pinned = explicit && CLOUD_STT_PROVIDERS.includes(explicit as CloudSttProvider)
    ? (explicit as CloudSttProvider)
    : undefined;
  const ordered: CloudSttProvider[] = [];
  const seen = new Set<CloudSttProvider>();
  if (pinned) {
    ordered.push(pinned);
    seen.add(pinned);
  }
  for (const id of ladder) {
    if (seen.has(id)) continue;
    ordered.push(id);
    seen.add(id);
  }
  return ordered.filter((id) => cloudSttProviderHasCredential(cfg, id));
}

export function parseTtsProvider(value: unknown): TtsProvider | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.trim().toLowerCase();
  return (TTS_PROVIDERS as readonly string[]).includes(folded) ? (folded as TtsProvider) : undefined;
}

export function parseCallSttProvider(value: unknown): CallSttProvider | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.trim().toLowerCase();
  return (CALL_STT_PROVIDERS as readonly string[]).includes(folded) ? (folded as CallSttProvider) : undefined;
}
