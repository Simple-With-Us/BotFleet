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

/** What a picker's default option says when there is no workspace default
 * voice (cfg.tts.voice is empty). */
export const NO_DEFAULT_VOICE = "No default voice";

/** An id made readable: the Personal Voice prefix dropped, `-` and `_`
 * read as spaces, each word starting with a capital ("jay-wedgeworth-001"
 * is "Jay Wedgeworth 001"). */
export function readableVoiceId(voiceId: string): string {
  const bare = voiceId.replace(/^(?:personal|apple-personal):/, "");
  const words = bare.split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return voiceId;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** A voice's name for people: the label the voice list gives it, unless that
 * label is only the id again, in which case the id made readable.  MiniMax
 * ids are case-sensitive, so the lookup is exact. */
export function voiceDisplayName(
  voiceId: string,
  voices?: ReadonlyArray<{ id: string; label?: string | null }> | null,
): string {
  const label = voices?.find((voice) => voice.id === voiceId)?.label?.trim();
  return label && label !== voiceId ? label : readableVoiceId(voiceId);
}

/** `voices` with every label a person can read: a label that is only the id
 * again ("jay-wedgeworth-001", how a clone is saved) becomes the id made
 * readable, so one voice has one name in every picker. */
export function withDisplayNames<T extends { id: string; label?: string | null }>(voices: readonly T[]): Array<T & { label: string }> {
  return voices.map((voice) => ({ ...voice, label: voiceDisplayName(voice.id, [voice]) }));
}

/** The first option of every per-device picker: the workspace default by
 * name, "Jay Wedgeworth 001 (default)", never a bare "(default)". */
export function defaultVoiceOptionLabel(
  defaultVoice: string | null | undefined,
  voices?: ReadonlyArray<{ id: string; label?: string | null }> | null,
): string {
  return present(defaultVoice) ? `${voiceDisplayName(defaultVoice, voices)} (default)` : NO_DEFAULT_VOICE;
}

/** Longest workspace default voice id the phone's narrow route accepts. */
export const MAX_DEFAULT_VOICE_ID_LENGTH = 200;

/** Why the Default Voice pickers never list a Personal Voice, and what the
 * harness answers when one is sent anyway. */
export const PERSONAL_VOICE_NOT_DEFAULT =
  "Personal Voices stay on the device that made them, so they cannot be the default.";
