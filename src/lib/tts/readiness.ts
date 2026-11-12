// Whether this Mac can speak with a voice, decided once for the Play button
// and the call button.
//
// A hosted voice (MiniMax, or the built-in `say` voices) needs a voice
// engine on the harness: `tts.configured`.  An Apple Personal Voice is
// spoken on-device by the Mac's speech helper, so it needs only the
// desktop's Personal Voice capability (macOS 14 or later), never a MiniMax
// key.  An empty voice is the workspace default, which can itself be either.
import { isPersonalVoiceId, voiceForDevice, type BotVoices } from "../../../shared/bot-voice";

export type TtsStatusLike = { configured?: boolean; ready?: boolean; voice?: string } | null | undefined;

/** The id this Mac actually speaks: the bot's Mac voice, else the workspace
 * default.  "" means neither is set. */
export function effectiveVoice(voiceId: string | null | undefined, tts: TtsStatusLike): string {
  return voiceId?.trim() ? voiceId : tts?.voice ?? "";
}

export type SpeakReadinessReason = "ready" | "no-engine" | "no-voice" | "personal-unavailable";

export type SpeakReadiness = {
  ready: boolean;
  reason: SpeakReadinessReason;
  /** The effective voice is an Apple Personal Voice. */
  personal: boolean;
};

/** The Play button on one message. */
export function speakReadiness(input: {
  voiceId?: string | null;
  tts: TtsStatusLike;
  personalVoiceAvailable: boolean;
  hasAudio?: boolean;
}): SpeakReadiness {
  const voice = effectiveVoice(input.voiceId, input.tts);
  if (isPersonalVoiceId(voice)) {
    // Saved clips belong to a hosted voice; a Personal Voice is always
    // spoken here, so they do not make it playable.
    return input.personalVoiceAvailable
      ? { ready: true, reason: "ready", personal: true }
      : { ready: false, reason: "personal-unavailable", personal: true };
  }
  if (input.hasAudio) return { ready: true, reason: "ready", personal: false };
  if (!input.tts?.configured) return { ready: false, reason: "no-engine", personal: false };
  if (!voice) return { ready: false, reason: "no-voice", personal: false };
  return { ready: true, reason: "ready", personal: false };
}

export const PLAY_PERSONAL_UNAVAILABLE =
  "This bot's Personal Voice cannot play on this computer.\u00A0 Pick a voice for this Mac in settings.";

export type SpeakButtonState = {
  /** The voice this Mac speaks the message with (before the workspace default). */
  macVoice: string | undefined;
  ready: boolean;
  /** This message is the one being prepared or spoken. */
  mine: boolean;
  preparing: boolean;
  /** The last attempt at this message failed; `label` says why. */
  failed: boolean;
  label: string;
};

/** Everything the Play button on one message shows.  The store's copy of the
 * bot, resolved for this Mac, wins over the caller's `voiceId`, which is the
 * shared voice at the existing call site. */
export function speakButtonState(input: {
  owner?: { voice?: string | null; voices?: BotVoices | null } | null;
  voiceId?: string;
  tts: TtsStatusLike;
  personalVoiceAvailable: boolean;
  hasAudio?: boolean;
  messageId: string;
  speech: { status: "idle" | "preparing" | "speaking"; messageId?: string; error?: string };
}): SpeakButtonState {
  const { owner, tts, personalVoiceAvailable, hasAudio, messageId, speech } = input;
  const macVoice = owner ? voiceForDevice(owner, "mac") : input.voiceId;
  const readiness = speakReadiness({ voiceId: macVoice, tts, personalVoiceAvailable, hasAudio });
  const mine = speech.messageId === messageId && speech.status !== "idle";
  const preparing = mine && speech.status === "preparing";
  const failed = speech.status === "idle" && speech.messageId === messageId && Boolean(speech.error);
  const replay = Boolean(hasAudio) && !readiness.personal;
  const action = replay ? "Play Audio" : "Play (Speak Aloud)";
  // A failure keeps the action in the name, so a screen reader still hears
  // what the button does before why the last try did not work.
  const label = mine
    ? replay ? "Stop Audio" : "Stop Speaking"
    : failed
      ? `${action} failed: ${speech.error ?? ""}`
      : readiness.reason === "personal-unavailable"
        ? PLAY_PERSONAL_UNAVAILABLE
        : readiness.reason === "no-engine"
          ? "Add a voice engine key in settings to play audio"
          : readiness.reason === "no-voice"
            ? "Pick a voice in settings to play audio"
            : action;
  return { macVoice, ready: readiness.ready, mine, preparing, failed, label };
}

export type CallVoiceReadiness = {
  /** Some engine can speak for these targets on this Mac.  When false the
   * call button is not shown at all (owner 2026-09-03). */
  engineAvailable: boolean;
  /** A target (or the workspace default it falls back to) is a hosted voice,
   * so the call needs `tts.configured`. */
  needsHostedEngine: boolean;
  /** Every voice the call would use can be spoken here. */
  ready: boolean;
  /** A Personal Voice is involved, so a refusal names the Personal Voice gate. */
  personalVoiceChosen: boolean;
};

/** The call button for one bot (one voice) or a room (one per member).
 * `voices` are the targets' Mac voices, unresolved (undefined = no voice of
 * their own).  Rooms pass `requireExplicitVoices`: several speakers cannot
 * share one workspace fallback. */
export function callVoiceReadiness(input: {
  voices: Array<string | null | undefined>;
  tts: TtsStatusLike;
  personalVoiceAvailable: boolean;
  requireExplicitVoices: boolean;
}): CallVoiceReadiness {
  const { voices, tts, personalVoiceAvailable, requireExplicitVoices } = input;
  const configured = Boolean(tts?.configured);
  const defaultVoice = tts?.voice ?? "";
  const speakable = (voice: string) =>
    isPersonalVoiceId(voice) ? personalVoiceAvailable : configured && Boolean(voice);

  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice?.trim()));
  const everyTargetSpeakable = everyTargetHasVoice && voices.every((voice) => speakable(voice ?? ""));
  const fallbackSpeakable = isPersonalVoiceId(defaultVoice)
    ? personalVoiceAvailable
    : Boolean(tts?.ready);
  const effective = voices.map((voice) => effectiveVoice(voice, tts));
  const needsHostedEngine = effective.length === 0 || effective.some((voice) => !isPersonalVoiceId(voice));
  const personalVoiceChosen =
    voices.some((voice) => isPersonalVoiceId(voice)) ||
    (!everyTargetSpeakable && isPersonalVoiceId(defaultVoice));
  // A target with no voice of its own speaks the workspace default.
  const ready = requireExplicitVoices
    ? everyTargetSpeakable
    : voices.length > 0 && voices.every((voice) => (voice?.trim() ? speakable(voice) : fallbackSpeakable));
  return {
    engineAvailable: configured || (personalVoiceAvailable && !needsHostedEngine),
    needsHostedEngine,
    ready,
    personalVoiceChosen,
  };
}
