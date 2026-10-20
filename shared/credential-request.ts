/**
 * Credentials an agent may ask the person to provide through an inline
 * card. The id is the entire authority surface: agents never choose a
 * config path, label, URL, or arbitrary field name.
 *
 * Data-driven (BF-2437): every target is one row in
 * CREDENTIAL_TARGET_SPECS. The card metadata, the config patch, and the
 * configured check are all derived from that row, so adding a target is
 * a one-row change instead of edits in four places. Each row names the
 * server registry field it feeds (`secretFieldId` in
 * server/secret-map.ts SECRET_FIELDS); a test keeps the two in sync.
 * Which registered fields appear here at all is a security decision for
 * the owner, not a code default: a bot that can name a field can ask
 * the owner for it through an official-looking card.
 */
export interface CredentialTargetSpec {
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  /** Field in server/secret-map.ts SECRET_FIELDS this target feeds. */
  secretFieldId: string;
  /** Config location the saved value lands in. */
  configPath: readonly string[];
  /** Extra fields written alongside the value (e.g. a provider pin). */
  configExtra?: Readonly<Record<string, string>>;
}

export const CREDENTIAL_TARGET_SPECS = {
  xaiApiKey: {
    label: "xAI API key",
    description: "Used by the built-in Grok provider.",
    placeholder: "xai-…",
    helpUrl: "https://console.x.ai/",
    secretFieldId: "xai.key",
    configPath: ["xai", "key"],
  },
  deepseekApiKey: {
    label: "DeepSeek API key",
    description: "Used by the built-in DeepSeek provider.",
    placeholder: "sk-…",
    helpUrl: "https://platform.deepseek.com/api_keys",
    secretFieldId: "deepseek.key",
    configPath: ["deepseek", "key"],
  },
  boxToken: {
    label: "Box API key",
    description: "Gives bots an isolated cloud computer when Box is selected.",
    placeholder: "Paste your Box API key",
    helpUrl: "https://docs.ascii.dev/box/api-keys",
    secretFieldId: "box.token",
    configPath: ["box", "token"],
  },
  opencodeGoApiKey: {
    label: "OpenCode API key",
    description: "Used for OpenCode Go and other key-backed OpenCode providers.",
    placeholder: "Paste your OpenCode API key",
    helpUrl: "https://opencode.ai/docs/providers/",
    secretFieldId: "opencodeGo.apiKey",
    configPath: ["opencodeGo", "apiKey"],
  },
  ttsKey: {
    label: "MiniMax API key",
    description: "Enables MiniMax text-to-speech voices in calls when the MiniMax provider is selected.",
    placeholder: "Paste your MiniMax API key",
    helpUrl: "https://platform.MiniMax.io/account/api-keys",
    secretFieldId: "tts.key",
    configPath: ["tts", "key"],
    configExtra: { provider: "minimax" },
  },
  openaiImageApiKey: {
    label: "OpenAI API key (avatar fallback)",
    description: "Used only when avatar generation is set to OpenAI instead of MiniMax.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
    secretFieldId: "imageGen.key",
    configPath: ["imageGen", "key"],
  },
} as const satisfies Record<string, CredentialTargetSpec>;

export type CredentialTargetId = keyof typeof CREDENTIAL_TARGET_SPECS;

export const CREDENTIAL_TARGETS: Readonly<
  Record<
    CredentialTargetId,
    { label: string; description: string; placeholder: string; helpUrl: string }
  >
> = Object.fromEntries(
  Object.entries(CREDENTIAL_TARGET_SPECS).map(([id, spec]) => [
    id,
    {
      label: spec.label,
      description: spec.description,
      placeholder: spec.placeholder,
      helpUrl: spec.helpUrl,
    },
  ]),
) as Record<
  CredentialTargetId,
  { label: string; description: string; placeholder: string; helpUrl: string }
>;

export type CredentialConfig = {
  xai?: { key?: string };
  deepseek?: { key?: string };
  box?: { token?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; provider?: string };
  imageGen?: { key?: string };
};

export function isCredentialTargetId(value: unknown): value is CredentialTargetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREDENTIAL_TARGET_SPECS, value);
}

export function credentialConfigPatch(id: CredentialTargetId, value: string): CredentialConfig {
  const spec: CredentialTargetSpec = CREDENTIAL_TARGET_SPECS[id];
  const patch: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = patch;
  for (let i = 0; i < spec.configPath.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[spec.configPath[i]] = next;
    cursor = next;
  }
  cursor[spec.configPath[spec.configPath.length - 1]] = value;
  if (spec.configExtra) {
    let parent: Record<string, unknown> = patch;
    for (let i = 0; i < spec.configPath.length - 1; i++) {
      parent = parent[spec.configPath[i]] as Record<string, unknown>;
    }
    Object.assign(parent, spec.configExtra);
  }
  return patch as CredentialConfig;
}

export function credentialIsConfigured(config: CredentialConfig, id: CredentialTargetId): boolean {
  const spec: CredentialTargetSpec = CREDENTIAL_TARGET_SPECS[id];
  let cursor: unknown = config;
  for (const key of spec.configPath) {
    if (cursor === null || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Boolean(cursor);
}

export function isReusableCredentialRequest(
  message: {
    kind?: unknown;
    secret?: { target?: unknown; provided?: unknown; dismissed?: unknown };
    from?: { botId?: unknown };
  },
  target: CredentialTargetId,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "secret" &&
    message.secret?.target === target &&
    message.secret.provided !== true &&
    message.secret.dismissed !== true &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}

export function credentialResumeOutcome(state: {
  provided?: unknown;
  dismissed?: unknown;
}): "provided" | "dismissed" | null {
  const provided = state.provided === true;
  const dismissed = state.dismissed === true;
  if (provided === dismissed) return null;
  return provided ? "provided" : "dismissed";
}
