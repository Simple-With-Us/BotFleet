import type { HostedTtsProvider } from "../../shared/voice-providers.ts";

type VoiceProviderId = HostedTtsProvider | "system";

function keyHint(provider: HostedTtsProvider): string {
  switch (provider) {
    case "minimax":
      return "Add a MiniMax key in Settings on the computer to turn on voice.";
    case "xai":
      return "Add an xAI API key in Connections to turn on voice.";
    case "azure":
      return "Add an Azure Speech key and region in Connections to turn on voice.";
    default: {
      const _never: never = provider;
      return _never;
    }
  }
}

export class NoVoiceConfigured extends Error {
  readonly reason: "key" | "voice";
  readonly provider?: VoiceProviderId;

  constructor(reason: "key" | "voice", provider: VoiceProviderId = "minimax") {
    super(
      reason === "key"
        ? (provider === "system"
          ? "Voice is not available on this computer."
          : keyHint(provider))
        : "Pick a voice in the agent profile.",
    );
    this.reason = reason;
    this.provider = provider;
  }
}
