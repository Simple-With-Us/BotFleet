/**
 * Cross-platform bot profile settings: which client may edit a field, and why
 * a control is read-only while still showing the synced value from the other
 * platform.
 *
 * Companion field allowlist lives in `companion/src/routes.ts`; keep the set in
 * sync when either side changes.
 */

export type SpeechDeviceId = "mac" | "iphone";

export type ClientPlatform = "mac" | "ios" | "web" | "linux" | "windows";

/** Fields a paired phone may PATCH through the companion proxy. */
export const COMPANION_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "voice",
  "speakReplies",
  "speechDevices",
  "modelSelection",
] as const;

export type CompanionProfilePatchField = (typeof COMPANION_PROFILE_PATCH_FIELDS)[number];

const COMPANION_PROFILE_PATCH_FIELD_SET = new Set<string>(COMPANION_PROFILE_PATCH_FIELDS);

export function isCompanionProfilePatchField(field: string): boolean {
  return COMPANION_PROFILE_PATCH_FIELD_SET.has(field);
}

export function computersMacOnlyReason(desktopProductName = "BotFleet"): string {
  return `Computer grants can only be changed in ${desktopProductName} on your computer.`;
}

export function isPersonalVoiceId(voice: string | undefined): boolean {
  return Boolean(voice?.startsWith("personal:") || voice?.startsWith("apple-personal:"));
}

/** Normalized speech-device selection for display and patch builders. */
export function effectiveSpeechDevices(bot: {
  speakReplies?: boolean;
  speechDevices?: string[];
}): SpeechDeviceId[] {
  if (bot.speechDevices?.length) {
    return bot.speechDevices.filter((d): d is SpeechDeviceId => d === "mac" || d === "iphone");
  }
  if (bot.speakReplies) return ["mac"];
  return [];
}

export function speechDeviceSelected(bot: { speakReplies?: boolean; speechDevices?: string[] }, device: SpeechDeviceId): boolean {
  return effectiveSpeechDevices(bot).includes(device);
}

export interface SpeechDeviceRowModel {
  device: SpeechDeviceId;
  selected: boolean;
  editable: boolean;
  /** When `editable` is false, the sentence under the control. */
  disabledReason: string | null;
}

export interface SpeechDeviceRowContext {
  platform: ClientPlatform;
  voice: string | undefined;
  /** Whether the chosen agent voice can be spoken on this client right now. */
  agentVoiceCanSpeakOnClient: boolean;
  /** Desktop gate for Personal Voice playback (macOS 14+, iPhone, etc.). */
  personalVoicePlaybackAllowed?: boolean;
}

/**
 * Whether a Play Replies On row accepts local toggles.  Remote values still
 * render checked/unchecked from the bot record when not editable.
 */
export function speechDeviceRow(
  device: SpeechDeviceId,
  bot: { speakReplies?: boolean; speechDevices?: string[]; voice?: string },
  ctx: SpeechDeviceRowContext,
): SpeechDeviceRowModel {
  const selected = speechDeviceSelected(bot, device);
  const voice = bot.voice ?? ctx.voice;
  const reason = speechDeviceDisabledReason(device, { ...ctx, voice });

  let editable = reason === null;
  if (!ctx.agentVoiceCanSpeakOnClient) {
    editable = false;
  }

  return { device, selected, editable, disabledReason: editable ? null : reason };
}

export function speechDeviceDisabledReason(
  device: SpeechDeviceId,
  ctx: SpeechDeviceRowContext & { voice?: string },
): string | null {
  const voice = ctx.voice;
  const personal = isPersonalVoiceId(voice);
  const onPhone = ctx.platform === "ios";

  if (!ctx.agentVoiceCanSpeakOnClient) {
    return "Pick a voice this agent can speak before enabling playback.";
  }

  if (device === "mac" && personal) {
    if (onPhone) {
      return "Personal Voice plays on this iPhone only.  Mac playback stays off while this voice is selected.";
    }
    if (ctx.personalVoicePlaybackAllowed === false) {
      return "Personal Voice is not available on this computer.  Enable Play on iPhone instead.";
    }
    return null;
  }

  if (device === "iphone" && !onPhone) {
    // Symmetric remote control: Mac (and web) may toggle iPhone playback.
    return null;
  }

  return null;
}

export type ComputerGrantId = "local" | "cloud" | "vm";

export interface ComputerGrantRowModel {
  id: ComputerGrantId;
  label: string;
  selected: boolean;
  editable: boolean;
  disabledReason: string | null;
}

const COMPUTER_ROW_LABELS: Record<ComputerGrantId, string> = {
  local: "Local Mac desktop",
  cloud: "Self-hosted VPS / Box",
  vm: "Local VM",
};

export function computerGrantRows(
  bot: { computers?: string[] },
  platform: ClientPlatform,
  desktopProductName = "BotFleet",
): ComputerGrantRowModel[] {
  const macOnly = platform === "ios";
  const reason = macOnly ? computersMacOnlyReason(desktopProductName) : null;
  const grants = new Set((bot.computers ?? []).filter((c): c is ComputerGrantId => c === "local" || c === "cloud" || c === "vm"));

  return (["local", "cloud", "vm"] as const).map((id) => ({
    id,
    label: COMPUTER_ROW_LABELS[id],
    selected: grants.has(id),
    editable: !macOnly,
    disabledReason: macOnly ? reason : null,
  }));
}

/** Caption when `computers` is omitted on the bot (auto / inherit). */
export function computersAutoCaption(): string {
  return "Where this bot runs is inherited from your computer (auto).  Grants you change on the computer sync here.";
}
