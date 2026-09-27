/**
 * Credentials an agent may ask the person to provide through an inline
 * card. The id is the entire authority surface: agents never choose a
 * config path, label, URL, or arbitrary field name.
 */
export const CREDENTIAL_TARGETS = {
  xaiApiKey: {
    label: "xAI API key",
    description: "Used by the built-in Grok provider.",
    placeholder: "xai-…",
    helpUrl: "https://console.x.ai/",
  },
  deepseekApiKey: {
    label: "DeepSeek API key",
    description: "Used by the built-in DeepSeek provider.",
    placeholder: "sk-…",
    helpUrl: "https://platform.deepseek.com/api_keys",
  },
  boxToken: {
    label: "Box API key",
    description: "Gives bots an isolated cloud computer when Box is selected.",
    placeholder: "Paste your Box API key",
    helpUrl: "https://docs.ascii.dev/box/api-keys",
  },
  opencodeGoApiKey: {
    label: "OpenCode API key",
    description: "Used for OpenCode Go and other key-backed OpenCode providers.",
    placeholder: "Paste your OpenCode API key",
    helpUrl: "https://opencode.ai/docs/providers/",
  },
  ttsKey: {
    label: "MiniMax API key",
    description: "Enables MiniMax text-to-speech voices in calls when the MiniMax provider is selected.",
    placeholder: "Paste your MiniMax API key",
    helpUrl: "https://platform.MiniMax.io/account/api-keys",
  },
  openaiImageApiKey: {
    label: "OpenAI API key (avatar fallback)",
    description: "Used only when avatar generation is set to OpenAI instead of MiniMax.",
    placeholder: "sk-…",
    helpUrl: "https://platform.openai.com/api-keys",
  },
} as const;

export type CredentialTargetId = keyof typeof CREDENTIAL_TARGETS;
export type CredentialConfig = {
  xai?: { key?: string };
  deepseek?: { key?: string };
  box?: { token?: string };
  opencodeGo?: { apiKey?: string };
  tts?: { key?: string; provider?: string };
  imageGen?: { key?: string };
};

export function isCredentialTargetId(value: unknown): value is CredentialTargetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREDENTIAL_TARGETS, value);
}

export function credentialConfigPatch(id: CredentialTargetId, value: string): CredentialConfig {
  switch (id) {
    case "xaiApiKey":
      return { xai: { key: value } };
    case "deepseekApiKey":
      return { deepseek: { key: value } };
    case "boxToken":
      return { box: { token: value } };
    case "opencodeGoApiKey":
      return { opencodeGo: { apiKey: value } };
    case "ttsKey":
      return { tts: { key: value, provider: "minimax" } };
    case "openaiImageApiKey":
      return { imageGen: { key: value } };
  }
}

export function credentialIsConfigured(config: CredentialConfig, id: CredentialTargetId): boolean {
  switch (id) {
    case "xaiApiKey":
      return Boolean(config.xai?.key);
    case "deepseekApiKey":
      return Boolean(config.deepseek?.key);
    case "boxToken":
      return Boolean(config.box?.token);
    case "opencodeGoApiKey":
      return Boolean(config.opencodeGo?.apiKey);
    case "ttsKey":
      return Boolean(config.tts?.key);
    case "openaiImageApiKey":
      return Boolean(config.imageGen?.key);
  }
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
