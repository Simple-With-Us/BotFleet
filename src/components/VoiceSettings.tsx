// Per-bot voice profile.  The key is shared; the voices and autoplay choice
// belong to the selected bot.
//
// A bot has a voice per device (shared/bot-voice.ts): "Voice on This Mac"
// writes voices.mac and "Voice on iPhone" writes voices.iphone, and either
// falls back to the bot's shared `voice`, which older apps still write.  An
// Apple Personal Voice belongs to the device that made it, so this Mac lists
// only its own; the iPhone's Personal Voice is shown greyed with the reason,
// and a MiniMax voice can be chosen for either device from here.
//
// The MiniMax list comes from the harness, which holds the key — the
// renderer never talks to MiniMax itself.  The Personal Voice list comes
// from this Mac's speech helper.  The two load independently, so a helper
// that never answers cannot hold the MiniMax list back.
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Mic, Plus, Trash2, Volume2, X } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import type { DeviceVoicesPatch } from "@/state/bot-patch-queue";
import { speaker } from "@/lib/tts";
import {
  CustomVoiceResponseSchema,
  parsePersonalVoiceList,
  parseTtsVoicesResponse,
  type PersonalVoiceInfo,
  type TtsVoicesResponse,
} from "@/lib/tts/schema";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { resolveVoiceSummaryMode } from "../../shared/voice-summary";
import { isPersonalVoiceId, voiceForDevice } from "../../shared/bot-voice";

const SAMPLE = "Morning.  Overnight the tests went green, and I left two notes for you in the thread.";

function personalVoiceDisabledReasonFor(ready: boolean, reasonCode: string | undefined): string {
  if (!ready) return "Checking Personal Voice availability";
  if (reasonCode === "requires-macos-14") return "Personal Voices need macOS 14 or later, or an iPhone";
  if (reasonCode === "unsupported-platform") return "Personal Voices play on-device on a Mac or iPhone";
  return "Personal Voice is not available on this computer";
}

const MINIMAX_KEY_URL = "https://platform.minimax.io/user/basic-information/interface-key";

/** The speech helper's Personal Voice list can park on an authorization
 * prompt that never shows.  Past this, the picker stops waiting for it. */
export const PERSONAL_VOICE_LIST_TIMEOUT_MS = 8_000;

export const IPHONE_PERSONAL_VOICE_REASON = "Personal Voice from your iPhone.\u00A0 Choose it on the iPhone.";
export const MAC_PERSONAL_VOICE_ON_IPHONE_REASON =
  "This Personal Voice is from this Mac.\u00A0 Choose a Personal Voice on the iPhone.";
export const PERSONAL_VOICE_NOT_ON_MAC = "This Personal Voice is not on this Mac.\u00A0 Pick a voice for this Mac.";

type VoiceOption = { id: string; label: string; description?: string };

export type VoiceSettingsPatch = Partial<Pick<Bot, "voice" | "speakReplies" | "speechDevices" | "voiceSummaryMode">> & {
  /** Only the device being changed; never the wire's `voices: null`. */
  voices?: DeviceVoicesPatch;
};

const personalName = (id: string) => id.replace(/^(personal|apple-personal):/, "");

/** The harness behind this card stores per-device voices.  A current
 * harness always sends `voices` (null when unset); one that predates them
 * sends no key at all, and its non-strict PATCH would drop a `voices` change
 * without an error.  Against that harness the Mac picker writes the shared
 * voice, as it always did, and the iPhone picker is not offered. */
export const deviceVoicesSupported = (bot: Bot): boolean => bot.voices !== undefined;

export const DEVICE_VOICES_NEED_UPDATE =
  "The iPhone uses this voice too.\u00A0 A separate iPhone voice needs an update to the bot server on this computer.";

/** A per-device override counts only when it is a non-blank string, the
 * same rule voiceForDevice applies. */
const overrideFor = (bot: Bot, device: "mac" | "iphone"): string => {
  const own = bot.voices?.[device];
  return typeof own === "string" && own.trim() ? own : "";
};

export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: VoiceSettingsPatch) => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const tts = state.config?.tts;

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Personal Voice refusal is a condition, not a stored sentence.  The
  // visible copy is whatever the current reason code says, so a refresh
  // from "not available" to "not available on this computer" cannot leave
  // the previous sentence stuck, and a later accepted voice clears it
  // without comparing those strings.
  const [personalVoiceDenied, setPersonalVoiceDenied] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  // This Mac's Personal Voices.  null is "not known": not allowed here, not
  // loaded yet, or the helper failed or timed out.  The helper also answers
  // an empty list for every failure, so only a non-empty list is evidence.
  const [personalVoices, setPersonalVoices] = useState<PersonalVoiceInfo[] | null>(null);
  const [loadingPersonalVoices, setLoadingPersonalVoices] = useState(false);

  // ── custom voice identifier state ───────────────────────────────────
  const [customOpen, setCustomOpen] = useState(false);
  const [customVoiceId, setCustomVoiceId] = useState("");
  const [customVoiceLabel, setCustomVoiceLabel] = useState("");
  const [customAdding, setCustomAdding] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  // ── voice clone state ───────────────────────────────────────────────
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneLabel, setCloneLabel] = useState("");
  const [cloneCloning, setCloneCloning] = useState(false);
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneSuccess, setCloneSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const configured = Boolean(tts?.configured);

  // Personal Voice is only a real choice when the desktop gate says so.
  // Listing it on every Mac (appleSpeech) and saving it anyway is a picker
  // that cannot speak here.
  const personalVoiceAllowed = capabilities.dictation.personalVoice === true;

  const isPersonalVoice = isPersonalVoiceId;
  // `requires-macos-14` means this computer is a Mac, just not new enough.
  // Naming only "Mac or iPhone" is false there, and naming any platform
  // before capabilities arrive is a guess.  The code, not a previously
  // rendered sentence, decides the copy.
  const personalVoiceDisabledReason = personalVoiceDisabledReasonFor(
    capabilitiesReady,
    capabilities.dictation.reasonCode,
  );

  // initialDesktopCapabilities() hardcodes personalVoice false, then the
  // effect runs again when the real flag arrives.  Add and clone await the
  // network and loadVoices before they commit, and that await is long
  // enough for capabilities to resolve.  Read the gate at call time so the
  // commit function from the render that started the request cannot drop a
  // Personal Voice that is allowed now, or hide the denial because ready
  // was still false then.
  const personalVoiceAllowedRef = useRef(personalVoiceAllowed);
  personalVoiceAllowedRef.current = personalVoiceAllowed;
  const capabilitiesReadyRef = useRef(capabilitiesReady);
  capabilitiesReadyRef.current = capabilitiesReady;
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const loadRequestRef = useRef(0);
  const personalRequestRef = useRef(0);

  // One gate for every way a voice id becomes this bot's Mac voice: the
  // picker, a typed custom id, and a clone result.  Free text can start with
  // personal: or apple-personal:, and saving that on a computer that cannot
  // speak it is the same refusal as picking it.  False means the id was
  // refused.  The picker reports that on the shared banner.  Add Voice ID
  // passes reportDenial false and keeps the message in the still-open form.
  // "" clears the Mac override, so the Mac uses the shared voice again.
  const commitVoice = (next: string, reportDenial = true): boolean => {
    const allowed = personalVoiceAllowedRef.current;
    const ready = capabilitiesReadyRef.current;
    if (isPersonalVoice(next) && !allowed) {
      if (ready && reportDenial) setPersonalVoiceDenied(true);
      return false;
    }
    setPersonalVoiceDenied(false);
    if (deviceVoicesSupported(bot)) onPatch({ voices: { mac: next || null } });
    else onPatch({ voice: next });
    return true;
  };

  // The iPhone picker offers MiniMax voices only.  A Personal Voice for the
  // iPhone is chosen on the iPhone, which can list its own.
  const commitIphoneVoice = (next: string) => {
    if (isPersonalVoice(next) || !deviceVoicesSupported(bot)) return;
    onPatch({ voices: { iphone: next || null } });
  };

  // The harness list.  Every refresh path (mount, key save, add, clone,
  // delete) goes through here.  Only the latest request may write, so a slow
  // first response cannot overwrite a newer list or wipe it from its catch.
  const loadVoices = () => {
    const requestId = ++loadRequestRef.current;
    setLoadingVoices(true);
    return api("/api/tts/voices")
      .catch(() => ({}))
      .then((raw) => {
        if (requestId !== loadRequestRef.current) return;
        let r: TtsVoicesResponse;
        try {
          r = parseTtsVoicesResponse(raw);
        } catch {
          r = { voices: [] };
        }
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .finally(() => {
        if (requestId === loadRequestRef.current) setLoadingVoices(false);
      });
  };

  // This Mac's Personal Voices, on their own clock.  The gate is read at
  // call time.  The helper can park on the authorization prompt, which the
  // owner may take a while to answer: after PERSONAL_VOICE_LIST_TIMEOUT_MS
  // the picker stops showing a spinner, but the list is still applied when
  // it arrives, as long as no newer request has started.
  const loadPersonalVoices = () => {
    const requestId = ++personalRequestRef.current;
    const list = window.ogb?.personalVoice?.list;
    if (!personalVoiceAllowedRef.current || !list) {
      setPersonalVoices(null);
      setLoadingPersonalVoices(false);
      return Promise.resolve();
    }
    setLoadingPersonalVoices(true);
    const current = () => requestId === personalRequestRef.current;
    let stopWaiting: () => void = () => {};
    const gaveUp = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (current()) setLoadingPersonalVoices(false);
        resolve();
      }, PERSONAL_VOICE_LIST_TIMEOUT_MS);
      stopWaiting = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const listed = list()
      .then((raw) => {
        if (!current()) return;
        try {
          setPersonalVoices(parsePersonalVoiceList(raw));
        } catch {
          setPersonalVoices(null);
        }
      }, () => {
        if (current()) setPersonalVoices(null);
      })
      .finally(() => {
        stopWaiting();
        if (current()) setLoadingPersonalVoices(false);
      });
    return Promise.race([listed, gaveUp]);
  };

  // Two sources, settled independently: neither list waits for the other.
  useEffect(() => {
    void loadVoices();
  }, [configured]);

  useEffect(() => {
    void loadPersonalVoices();
  }, [personalVoiceAllowed]);

  // personalVoiceDenied is only cleared by a later accepted voice or a
  // delete.  A capability event can open the gate while this card stays
  // mounted, and the banner would keep the old "not available" sentence.
  useEffect(() => {
    if (personalVoiceAllowed) setPersonalVoiceDenied(false);
  }, [personalVoiceAllowed]);

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential("ttsKey", nextKey, "minimax")
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey, provider: "minimax" } }) });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
        void loadVoices();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const handleAddCustomVoice = async () => {
    const id = customVoiceId.trim();
    if (!id) {
      setCustomError("Voice ID is required.");
      return;
    }
    // Capture whether the typed id was already in the list the user saw.  The
    // addCustomVoice server path upserts on voiceId, so a re-typed id is a
    // no-op POST followed by a refusal that must not trigger a compensating
    // DELETE.  Reading voices at the start of this handler is the only
    // pre-POST list we have — state can change during the await.
    const existedBeforePost = voices.some((voice) => voice.id === id);
    setCustomAdding(true);
    setCustomError(null);
    try {
      const raw = await api("/api/tts/custom-voice", {
        method: "POST",
        body: JSON.stringify({ voiceId: id, label: customVoiceLabel.trim() || undefined }),
      });
      // The destructive DELETE URL below is built from this response, so it
      // cannot be trusted through a cast.  Parse it through the strict
      // CustomVoiceResponseSchema, stop on failure, and derive both the
      // committed voice id and the encoded DELETE path from parsed.data.
      const parsed = CustomVoiceResponseSchema.safeParse(raw);
      if (!parsed.success) {
        // The POST already persisted the row server-side; refresh the list so
        // the user can see and remove it instead of it becoming an orphan.
        // Surface a failure in the still-open custom-voice form so the typed
        // id and label remain for the user to retry or correct.
        await loadVoices();
        setCustomError("Failed to add voice identifier.");
        return;
      }
      if ("error" in parsed.data) {
        setCustomError(parsed.data.error);
        return;
      }
      const addedId = parsed.data.voice.id;
      // Refuse before clearing.  A personal: id on a computer that cannot
      // speak it must leave the typed id and label in the open form.  Only
      // compensate the POST when the gate is confirmed closed (ready true,
      // not the unresolved initial state) and the row is one we just
      // created — a re-typed id that already lived in voices must stay.
      if (addedId && !commitVoice(addedId, false)) {
        let cleanupFailed = false;
        const shouldCleanup =
          isPersonalVoice(addedId) &&
          capabilitiesReadyRef.current &&
          !existedBeforePost;
        if (shouldCleanup) {
          try {
            await api(`/api/tts/custom-voice/${encodeURIComponent(addedId)}`, { method: "DELETE" });
          } catch {
            // The row is still on the server; say so instead of letting it
            // reappear silently in the picker after loadVoices.
            cleanupFailed = true;
          }
        }
        await loadVoices();
        const reason = personalVoiceDisabledReasonFor(
          capabilitiesReadyRef.current,
          capabilitiesRef.current.dictation.reasonCode,
        );
        setCustomError(
          cleanupFailed
            ? `${reason}.\u00A0 The saved voice could not be removed; remove it from the list.`
            : reason,
        );
        return;
      }
      await loadVoices();
      setCustomVoiceId("");
      setCustomVoiceLabel("");
      setCustomOpen(false);
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : "Failed to add voice identifier.");
    } finally {
      setCustomAdding(false);
    }
  };

  const handleDeleteVoice = async (voiceId: string) => {
    try {
      await api(`/api/tts/custom-voice/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
      // Deleting is not a voice save, but it does leave the previous
      // Personal Voice refusal behind if nothing clears that condition.
      setPersonalVoiceDenied(false);
      // Clear every place this bot still names the deleted voice.
      const patch: VoiceSettingsPatch = {};
      if (bot.voice === voiceId) patch.voice = "";
      const cleared: DeviceVoicesPatch = {};
      if (bot.voices?.mac === voiceId) cleared.mac = null;
      if (bot.voices?.iphone === voiceId) cleared.iphone = null;
      if (Object.keys(cleared).length) patch.voices = cleared;
      if (Object.keys(patch).length) onPatch(patch);
      await loadVoices();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete voice.");
    }
  };

  const handleCloneFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setCloneFile(file);
    setCloneError(null);
    setCloneSuccess(null);
  };

  const handleClone = async () => {
    const label = cloneLabel.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{6,62}[A-Za-z0-9]$/.test(label)) {
      setCloneError("Voice ID must be 8–64 characters, start with a letter, and contain only letters, numbers, - or _ (not at the end).");
      return;
    }
    if (!cloneFile) {
      setCloneError("Select an audio file first.");
      return;
    }
    if (cloneFile.size > 20 * 1024 * 1024 || !/\.(mp3|m4a|wav)$/i.test(cloneFile.name)) {
      setCloneError("Use an MP3, M4A or WAV clip under 20 MB (10 seconds to 5 minutes).");
      return;
    }
    setCloneCloning(true);
    setCloneError(null);
    setCloneSuccess(null);
    try {
      const arrayBuffer = await cloneFile.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      const base64 = btoa(binary);
      const result = await api("/api/tts/voice-clone", {
        method: "POST",
        body: JSON.stringify({ voiceId: label, audioFile: base64, filename: cloneFile.name }),
      }) as { voiceId?: string; error?: string };
      if (result.error) {
        setCloneError(result.error);
      } else {
        setCloneSuccess(`Voice "${label}" cloned and ready.\u00A0 Pick it from the list below.`);
        setCloneLabel("");
        setCloneFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        await loadVoices();
        if (result.voiceId) commitVoice(result.voiceId);
      }
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setCloneCloning(false);
    }
  };

  if (!tts) return null;

  const canSpeakPersonal =
    capabilities.dictation.personalVoice === true &&
    Boolean(typeof window !== "undefined" && window.ogb?.personalVoice?.speak);

  // This Mac's Personal Voices, offered only where they can speak.  The
  // harness entries win, so a Personal Voice the server also lists is never
  // shown twice under two labels.
  const macPersonal = personalVoiceAllowed ? personalVoices ?? [] : [];
  const macPersonalIds = new Set(macPersonal.map((voice) => voice.id));
  const harnessIds = new Set(voices.map((voice) => voice.id));
  const macOptions: VoiceOption[] = [
    ...macPersonal
      .filter((voice) => !harnessIds.has(voice.id))
      .map((voice) => ({
        id: voice.id,
        label: voice.name,
        description: `Apple Personal Voice (${voice.locale ?? "en-US"})`,
      })),
    ...voices,
  ];
  // A Personal Voice cannot be spoken on a device that did not make it, so
  // the iPhone picker offers hosted voices only.
  const iphoneOptions = voices.filter((voice) => !isPersonalVoice(voice.id));
  // The helper reports a failure or a timeout as an empty list, so only a
  // list with voices in it says which Personal Voices this Mac has.
  const personalKnown = personalVoiceAllowed && Boolean(personalVoices?.length);
  /** A Personal Voice this Mac is known not to have.  `personal:` alone means
   * "the first Personal Voice on the device", which any device can satisfy. */
  const notOnThisMac = (id: string) =>
    isPersonalVoice(id) && personalName(id) !== "" && personalKnown && !macPersonalIds.has(id);

  const defaultVoiceRecord = tts.voice ? voices.find((v) => v.id === tts.voice) : null;
  const defaultVoiceDisplay = defaultVoiceRecord
    ? `${defaultVoiceRecord.label} (default)`
    : tts.voice
      ? `${tts.voice} (default)`
      : "Workspace default";

  // ── Voice on This Mac ──
  // Against a harness that predates per-device voices, the Mac picker shows
  // and writes the shared voice, exactly as it did before.
  const perDevice = deviceVoicesSupported(bot);
  const macOverride = perDevice ? overrideFor(bot, "mac") : bot.voice?.trim() ? bot.voice : "";
  const macVoice = voiceForDevice(bot, "mac") || tts.voice;
  const isMacPersonal = isPersonalVoice(macVoice);
  const macPersonalMissing = isMacPersonal && personalVoiceAllowed && notOnThisMac(macVoice);
  const macReady = configured && Boolean(macVoice);
  // Try stays available on a missing-voice guess: if the voice really is not
  // here, the helper's own refusal says so.
  const previewDisabled = isMacPersonal ? !canSpeakPersonal : !macReady;
  const previewTitle = isMacPersonal
    ? !canSpeakPersonal
      ? personalVoiceDisabledReason
      : "Hear this Apple Personal Voice"
    : macReady
      ? "Hear this voice"
      : "Pick a voice first";
  // How the Mac picker names a voice it shows but does not list.
  const macLabelFor = (id: string): string => {
    const listed = macOptions.find((voice) => voice.id === id);
    if (listed) return listed.label;
    if (!isPersonalVoice(id)) return id;
    // A Personal Voice this Mac lists is in macOptions.  One it does not
    // list is named without claiming a device until the list is known.
    if (notOnThisMac(id)) return "Personal Voice not on this Mac";
    return `Apple Personal Voice: ${personalName(id)}`;
  };
  const sharedVoice = bot.voice?.trim() ? bot.voice : "";
  const macSharedLabel = loadingVoices
    ? "Loading voices…"
    : sharedVoice && perDevice
      ? `${macLabelFor(sharedVoice)} (bot default)`
      : defaultVoiceDisplay;

  // ── Voice on iPhone ──
  const iphoneOverride = overrideFor(bot, "iphone");
  const iphoneVoice = voiceForDevice(bot, "iphone") || tts.voice;
  const isIphonePersonal = isPersonalVoice(iphoneVoice);
  // A Personal Voice for the iPhone is the iPhone's own, unless this Mac
  // made it, which the iPhone cannot speak.
  const iphonePersonalReason = !isIphonePersonal
    ? null
    : macPersonalIds.has(iphoneVoice)
      ? MAC_PERSONAL_VOICE_ON_IPHONE_REASON
      : IPHONE_PERSONAL_VOICE_REASON;
  const iphoneLabelFor = (id: string): string => {
    const listed = iphoneOptions.find((voice) => voice.id === id);
    if (listed) return listed.label;
    if (!isPersonalVoice(id)) return id;
    return macPersonalIds.has(id) ? "Personal Voice from this Mac" : "Personal Voice from your iPhone";
  };
  const iphoneSharedLabel = loadingVoices
    ? "Loading voices…"
    : sharedVoice
      ? `${iphoneLabelFor(sharedVoice)} (bot default)`
      : defaultVoiceDisplay;
  const iphoneReady = configured && Boolean(iphoneVoice);
  const iphonePreviewDisabled = isIphonePersonal || !iphoneReady;
  const iphonePreviewTitle = iphonePersonalReason ?? (iphoneReady ? "Hear this voice" : "Pick a voice first");

  const customVoices = voices.filter((v) => v.description === "Custom");

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Give this bot a voice for calls and spoken replies.{"\u00A0 "}Each device can use its own voice: an Apple Personal Voice stays on the device that made it, and a MiniMax voice plays anywhere.{"\u00A0 "}The voices belong to this bot; the MiniMax key is shared by the workspace.
      </div>

      {/* ── MiniMax Key Input ── */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>MiniMax API Key</span>
          {configured && <span className="text-[11px] text-success">Connected</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
            placeholder={configured ? "••••••••  (paste to replace)" : "Paste your MiniMax API key"}
            aria-label="MiniMax Key"
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={saving || !key.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        </div>
        {!configured && (
          <a
            href={MINIMAX_KEY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
          >
            Get a Key
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        )}
      </div>

      {/* ── Voice on This Mac ── */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between text-[13px] text-ink-secondary">
          <span>Voice on This Mac</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setCustomOpen((o) => !o);
                setCloneOpen(false);
              }}
              className="flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              {customOpen ? <X size={12} /> : <Plus size={12} />}
              {customOpen ? "Close ID" : "Add Voice ID"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCloneOpen((o) => !o);
                setCustomOpen(false);
              }}
              className="flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              {cloneOpen ? <X size={12} /> : <Mic size={12} />}
              {cloneOpen ? "Close Clone" : "Clone Audio"}
            </button>
          </div>
        </div>

        {/* Inline Add Voice ID panel */}
        {customOpen && (
          <div className="mb-3 rounded-lg border border-hairline/40 bg-inset p-3">
            <div className="text-[12.5px] font-medium text-ink">Add Voice Identifier</div>
            <p className="mt-0.5 mb-2 text-[12px] text-ink-secondary">
              Enter an existing MiniMax voice identifier (such as your cloned voice ID) and an optional friendly display name.
            </p>
            <div className="space-y-2">
              <input
                type="text"
                value={customVoiceId}
                onChange={(e) => setCustomVoiceId(e.target.value)}
                placeholder="Voice ID (e.g. my-custom-voice-001)"
                aria-label="Custom Voice ID"
                className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <input
                type="text"
                value={customVoiceLabel}
                onChange={(e) => setCustomVoiceLabel(e.target.value)}
                placeholder="Display Name (e.g. Jay Wedgeworth)"
                aria-label="Custom Voice Display Name"
                className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              {customError && <div role="alert" className="text-[12px] text-danger">{customError}</div>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleAddCustomVoice()}
                  disabled={customAdding || !customVoiceId.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {customAdding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  Add Voice
                </button>
                <button
                  type="button"
                  onClick={() => setCustomOpen(false)}
                  className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Inline Clone Audio panel */}
        {cloneOpen && (
          <div className="mb-3 rounded-lg border border-hairline/40 bg-inset p-3">
            <div className="text-[12.5px] font-medium text-ink">Clone Voice From Audio</div>
            <p className="mt-0.5 mb-2 text-[12px] text-ink-secondary">
              Upload a short audio clip (10 seconds to 5 minutes, MP3/M4A/WAV, under 20 MB) to create a voice clone.{"\u00A0 "}The clone appears in the voice list below.
            </p>
            <div className="mb-2 flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/mpeg,audio/mp4,audio/wav,.mp3,.m4a,.wav"
                onChange={handleCloneFile}
                aria-label="Audio file for voice clone"
                className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink file:mr-2 file:rounded file:border-0 file:bg-control file:px-2 file:py-1 file:text-[12px] file:text-ink file:shadow-none"
              />
            </div>
            <div className="mb-2">
              <input
                type="text"
                value={cloneLabel}
                onChange={(e) => setCloneLabel(e.target.value)}
                maxLength={64}
                placeholder="Voice ID (e.g. My-Voice-01)"
                aria-label="Clone voice ID"
                className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
            </div>
            {cloneError && (
              <div role="alert" className="mb-2 text-[12px] text-danger">{cloneError}</div>
            )}
            {cloneSuccess && (
              <div role="status" className="mb-2 text-[12px] text-success">{cloneSuccess}</div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleClone()}
                disabled={cloneCloning || !cloneFile || !cloneLabel.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cloneCloning ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                {cloneCloning ? "Cloning…" : "Clone Voice"}
              </button>
              <button
                type="button"
                onClick={() => setCloneOpen(false)}
                className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <select
            value={macOverride}
            onChange={(e) => {
              commitVoice(e.target.value);
            }}
            aria-label={`${bot.name}'s voice on this Mac`}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
          >
            <option value="">{macSharedLabel}</option>
            {macOverride && !macOptions.some((voice) => voice.id === macOverride) && (
              <option value={macOverride}>
                {isPersonalVoice(macOverride) ? macLabelFor(macOverride) : `${macOverride} (Current)`}
              </option>
            )}
            {macOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.description ? ` — ${v.description}` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => void speaker.speak(SAMPLE, { voiceId: macVoice, botId: bot.id })}
            disabled={previewDisabled}
            title={previewTitle}
            aria-label={previewTitle}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Volume2 size={14} /> Try
          </button>
        </div>
        {isMacPersonal && (
          macPersonalMissing ? (
            <div role="status" className="mt-2 text-[12px] text-warning">{PERSONAL_VOICE_NOT_ON_MAC}</div>
          ) : (
            <div className="mt-2 text-[12px] text-ink-secondary">
              This bot uses an Apple Personal Voice.
              {canSpeakPersonal
                ? <>{"\u00A0 "}It plays on-device on this Mac.</>
                : <>{"\u00A0 "}{personalVoiceDisabledReason}.</>}
            </div>
          )
        )}
        {personalVoiceAllowed && loadingPersonalVoices && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" />
            Loading Personal Voices on this Mac…
          </div>
        )}
      </div>

      {/* ── Voice on iPhone ── */}
      <div className="mt-4">
        <div className="mb-1.5 text-[13px] text-ink-secondary">Voice on iPhone</div>
        {!perDevice ? (
          <div role="status" className="text-[12px] text-ink-secondary">{DEVICE_VOICES_NEED_UPDATE}</div>
        ) : (
        <>
        <div className="flex gap-2">
          <select
            value={iphoneOverride}
            onChange={(e) => commitIphoneVoice(e.target.value)}
            aria-label={`${bot.name}'s voice on iPhone`}
            aria-describedby={iphonePersonalReason ? `${bot.id}-iphone-voice-reason` : undefined}
            className={cn(
              "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] focus:border-hairline focus:outline-none",
              // The iPhone's own Personal Voice is shown, not offered: greyed.
              isIphonePersonal ? "text-ink-secondary" : "text-ink",
            )}
          >
            <option value="">{iphoneSharedLabel}</option>
            {iphoneOverride && !iphoneOptions.some((voice) => voice.id === iphoneOverride) && (
              <option value={iphoneOverride} disabled={isPersonalVoice(iphoneOverride)}>
                {isPersonalVoice(iphoneOverride) ? iphoneLabelFor(iphoneOverride) : `${iphoneOverride} (Current)`}
              </option>
            )}
            {iphoneOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.description ? ` — ${v.description}` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => void speaker.speak(SAMPLE, { voiceId: iphoneVoice, botId: bot.id })}
            disabled={iphonePreviewDisabled}
            title={iphonePreviewTitle}
            aria-label={iphonePersonalReason ?? (iphoneReady ? "Hear the iPhone voice" : "Pick a voice first")}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Volume2 size={14} /> Try
          </button>
        </div>
        {iphonePersonalReason && (
          <div id={`${bot.id}-iphone-voice-reason`} className="mt-2 text-[12px] text-ink-secondary">
            {iphonePersonalReason}
          </div>
        )}
        </>
        )}
      </div>

      {/* ── Custom Voices List with Delete Option ── */}
      {customVoices.length > 0 && (
        <div className="mt-3 space-y-1 rounded-lg border border-hairline/30 bg-inset/50 p-2.5">
          <div className="text-[11.5px] font-medium uppercase tracking-wider text-ink-secondary/70">Custom &amp; Cloned Voices</div>
          <div className="space-y-1">
            {customVoices.map((v) => (
              <div key={v.id} className="flex items-center justify-between rounded-md px-2 py-1 text-[12.5px] hover:bg-card/60">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-ink truncate">{v.label}</span>
                  <span className="text-[11px] font-mono text-ink-secondary/70 truncate">{v.id}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => void speaker.speak(SAMPLE, { voiceId: v.id, botId: bot.id })}
                    className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                    title={`Hear ${v.label}`}
                  >
                    <Volume2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteVoice(v.id)}
                    className="rounded p-1 text-ink-secondary hover:bg-danger/10 hover:text-danger"
                    title={`Remove ${v.label} from list`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Speech to Text ── */}
      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[13px] font-medium text-ink">Speech to Text</div>
        <p className="mt-1 text-[12px] text-ink-secondary">iPhone microphone dictation uses Apple on-device recognition when this language and device support it.{"\u00A0 "}Recordings sent from iPhone keep the original audio and transcript on their message.</p>
        <p className="mt-1 text-[12px] text-ink-secondary">Cloud fallback and translation are not configured.</p>
      </div>

      {/* ── Play Replies On ── */}
      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[13px] font-medium text-ink">Play Replies On</div>
        <p className="mt-0.5 text-[11.5px] text-ink-secondary">Choose where this bot speaks as answers arrive.{"\u00A0 "}Voice clips stay on their messages for replay.</p>
        <div className="mt-3 flex gap-4">
          {([['mac', 'Mac'], ['iphone', 'Play on iPhone (while app is open)']] as const).map(([device, label]) => {
            const selected = bot.speechDevices ? bot.speechDevices.includes(device) : device === 'mac' && Boolean(bot.speakReplies);
            return <label key={device} className="flex items-center gap-2 text-[13px] text-ink cursor-pointer">
              <input type="checkbox" checked={selected} onChange={() => {
                const devices = bot.speechDevices ?? (bot.speakReplies ? ['mac'] : []);
                onPatch({ speechDevices: selected ? devices.filter((item) => item !== device) : [...devices, device] });
              }} />{label}
            </label>;
          })}
        </div>
      </div>

      {/* ── Per-Bot Voice Summary Mode ── */}
      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-medium text-ink">Voice Summary</div>
            <p className="mt-1 text-[11.5px] text-ink-secondary">
              Condenses code, links, and markdown into a conversational verbal update before synthesis with MiniMax.
            </p>
          </div>
          <a
            href="https://github.com/Simple-With-Us/BotFleet/blob/main/docs/tts-post-processing-benchmark.md"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (window.ogb?.openExternal) {
                e.preventDefault();
                void window.ogb.openExternal(
                  "https://github.com/Simple-With-Us/BotFleet/blob/main/docs/tts-post-processing-benchmark.md"
                );
              }
            }}
            className="flex shrink-0 items-center gap-1 rounded-md border border-hairline px-2.5 py-1 text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
          >
            <span>Benchmark Findings</span>
            <ExternalLink size={12} />
          </a>
        </div>

        {/* 3-way Mode Selector */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(
            [
              {
                id: "on_demand",
                title: "On-Demand",
                desc: "Distill only when you play or speak",
              },
              {
                id: "always",
                title: "All Messages",
                desc: "Pre-summarize every response from this bot",
              },
              {
                id: "off",
                title: "Off",
                desc: "Speak raw written output directly",
              },
            ] as const
          ).map((mode) => {
            const currentMode = resolveVoiceSummaryMode(bot);
            const isSelected = currentMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => onPatch({ voiceSummaryMode: mode.id })}
                className={cn(
                  "flex flex-col items-start rounded-lg border p-2.5 text-left transition-colors",
                  isSelected
                    ? "border-accent bg-accent/5 text-ink"
                    : "border-hairline bg-surface text-ink-secondary hover:bg-raised/40 hover:text-ink",
                )}
              >
                <div className="flex items-center gap-1.5 font-medium text-[12px]">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      isSelected ? "bg-accent" : "bg-hairline",
                    )}
                  />
                  <span>{mode.title}</span>
                </div>
                <span className="mt-1 text-[10.5px] leading-snug opacity-80">
                  {mode.desc}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {personalVoiceDenied && (
        <div role="alert" className="mt-2 text-[12px] text-danger">{personalVoiceDisabledReason}</div>
      )}
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
