// Which voice a bot speaks with on which device.
//
// A bot has one shared `voice` (every client has always written it) and an
// optional per-device override in `voices`.  Apple Personal Voice ids are
// device-local, so the Mac and the iPhone each need their own choice; a
// MiniMax voice works anywhere, so either device can pick one for the other.
//
// The Swift mirror is `ios/Sources/CompanionCore` (`Bot.voice(for:)`), and
// both sides assert the same cases in
// `ios/Tests/CompanionCoreTests/Fixtures/bot-voice.json`.  Change the rules
// here and in Swift together, then add the case to that fixture.

export const SPEECH_DEVICES = ["mac", "iphone"] as const;

export type SpeechDevice = (typeof SPEECH_DEVICES)[number];

/** The stored per-device override.  A device that is absent uses `voice`. */
export type BotVoices = { mac?: string; iphone?: string };

/** A PATCH of `voices`: an absent device is left alone, `null` (or an empty
 * string) clears that device, and `voices: null` clears both. */
export type BotVoicesPatch = { mac?: string | null; iphone?: string | null } | null;

export function isSpeechDevice(value: string | null | undefined): value is SpeechDevice {
  return value === "mac" || value === "iphone";
}

/** Apple Personal Voice ids carry one of two prefixes.  They are spoken on
 * the device that owns the voice and are never sent to a hosted engine. */
export function isPersonalVoiceId(voiceId: string | null | undefined): boolean {
  if (!voiceId) return false;
  return voiceId.startsWith("personal:") || voiceId.startsWith("apple-personal:");
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The voice this bot uses on `device`: the device's own choice when it has
 * one, otherwise the shared `voice` (which may itself be empty, meaning the
 * workspace default). */
export function voiceForDevice(
  bot: { voice?: string | null; voices?: { mac?: string | null; iphone?: string | null } | null } | null | undefined,
  device: SpeechDevice,
): string | undefined {
  const own = bot?.voices?.[device];
  if (present(own)) return own;
  return bot?.voice ?? undefined;
}

/** Apply a `voices` PATCH to the stored record.  Returns `undefined` when no
 * device keeps an override, so the stored bot drops the field entirely. */
export function mergeBotVoices(existing: BotVoices | null | undefined, patch: BotVoicesPatch): BotVoices | undefined {
  if (patch === null) return undefined;
  const next: BotVoices = { ...existing };
  for (const device of SPEECH_DEVICES) {
    if (!Object.prototype.hasOwnProperty.call(patch, device)) continue;
    const value = patch[device];
    if (present(value)) next[device] = value.trim();
    else delete next[device];
  }
  return next.mac === undefined && next.iphone === undefined ? undefined : next;
}
