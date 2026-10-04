// Per-bot voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key — the
// renderer never talks to MiniMax itself.
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Mic, Plus, Trash2, Volume2, X } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { speaker } from "@/lib/tts";
import { parsePersonalVoiceList, parseTtsVoicesResponse } from "@/lib/tts/schema";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { resolveVoiceSummaryMode } from "../../shared/voice-summary";

const SAMPLE = "Morning.  Overnight the tests went green, and I left two notes for you in the thread.";
const MINIMAX_KEY_URL = "https://platform.minimax.io/user/basic-information/interface-key";

export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies" | "speechDevices" | "voiceSummaryMode">>) => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const tts = state.config?.tts;

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

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

  // The single loader. Every refresh path (mount, key save, add, clone,
  // delete) goes through here, so the Personal Voice merge can never be
  // dropped by a refresh that only reloads the harness list.
  const loadVoices = () => {
    setLoadingVoices(true);
    const personalVoices = window.ogb?.personalVoice?.list
      ? window.ogb.personalVoice.list().catch(() => [])
      : Promise.resolve([]);
    return Promise.all([
      api("/api/tts/voices").catch(() => ({})),
      personalVoices,
    ]).then(([raw, personal]) => {
      let r: { voices?: Array<{ id: string; label: string; description?: string }>; error?: string };
      try {
        r = parseTtsVoicesResponse(raw);
      } catch {
        r = { voices: [] };
      }
      const apiVoices = r.voices ?? [];
      // Entries the harness already knows about win, so a Personal Voice that
      // the server also lists is never shown twice under two labels.
      const existing = new Set(apiVoices.map((voice) => voice.id));
      let parsedPersonal: ReturnType<typeof parsePersonalVoiceList> = [];
      try {
        parsedPersonal = parsePersonalVoiceList(personal);
      } catch {
        parsedPersonal = [];
      }
      const personalEntries = parsedPersonal
        .filter((voice) => !existing.has(voice.id))
        .map((voice) => ({
          id: voice.id,
          label: voice.name,
          description: `Apple Personal Voice (${voice.locale ?? "en-US"})`,
        }));
      setVoices([...personalEntries, ...apiVoices]);
      if (r.error) setError(r.error);
    }).catch(() => setVoices([])).finally(() => setLoadingVoices(false));
  };

  useEffect(() => {
    void loadVoices();
  }, [configured]);

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
    setCustomAdding(true);
    setCustomError(null);
    try {
      const res = (await api("/api/tts/custom-voice", {
        method: "POST",
        body: JSON.stringify({ voiceId: id, label: customVoiceLabel.trim() || undefined }),
      })) as { ok?: boolean; error?: string; voice?: { id: string; label: string } };
      if (res.error) {
        setCustomError(res.error);
      } else {
        setCustomVoiceId("");
        setCustomVoiceLabel("");
        setCustomOpen(false);
        await loadVoices();
        if (res.voice?.id) {
          onPatch({ voice: res.voice.id });
        }
      }
    } catch (e) {
      setCustomError(e instanceof Error ? e.message : "Failed to add voice identifier.");
    } finally {
      setCustomAdding(false);
    }
  };

  const handleDeleteVoice = async (voiceId: string) => {
    try {
      await api(`/api/tts/custom-voice/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
      if (bot.voice === voiceId) {
        onPatch({ voice: "" });
      }
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
        if (result.voiceId) {
          onPatch({ voice: result.voiceId });
        }
      }
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setCloneCloning(false);
    }
  };

  if (!tts) return null;

  const selectedVoice = bot.voice ?? "";
  const isPersonalVoice = (id: string) => id.startsWith("personal:") || id.startsWith("apple-personal:");
  const isSelectedPersonal = isPersonalVoice(selectedVoice);
  const canSpeakPersonal =
    capabilities.dictation.personalVoice === true &&
    Boolean(typeof window !== "undefined" && window.ogb?.personalVoice?.speak);
  const ready = configured && Boolean(selectedVoice || tts.voice);
  const previewDisabled = isSelectedPersonal ? !canSpeakPersonal : !ready;
  // `requires-macos-14` means this computer is a Mac, just not new enough.
  // Naming only "Mac or iPhone" is false there, and naming any platform
  // before capabilities arrive is a guess.
  const personalVoiceDisabledReason = !capabilitiesReady
    ? "Checking Personal Voice availability"
    : capabilities.dictation.reasonCode === "requires-macos-14"
      ? "Personal Voices need macOS 14 or later, or an iPhone"
      : capabilities.dictation.reasonCode === "unsupported-platform"
        ? "Personal Voices play on-device on a Mac or iPhone"
        : "Personal Voice is not available on this computer";
  const previewTitle = isSelectedPersonal
    ? canSpeakPersonal
      ? "Hear this Apple Personal Voice"
      : personalVoiceDisabledReason
    : ready
      ? "Hear this voice"
      : "Pick a voice first";

  const defaultVoiceRecord = tts.voice ? voices.find((v) => v.id === tts.voice) : null;
  const defaultVoiceDisplay = defaultVoiceRecord
    ? `${defaultVoiceRecord.label} (default)`
    : tts.voice
      ? `${tts.voice} (default)`
      : "Workspace default";

  const customVoices = voices.filter((v) => v.description === "Custom");

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Give this bot a voice for calls and spoken replies using MiniMax.{"\u00A0 "}The voice choice belongs to this bot; the MiniMax key is shared by the workspace.
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

      {/* ── Voice Dropdown ── */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between text-[13px] text-ink-secondary">
          <span>Voice</span>
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
            value={selectedVoice}
            onChange={(e) => onPatch({ voice: e.target.value })}
            aria-label={`${bot.name}'s voice`}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
          >
            <option value="">
              {loadingVoices
                ? "Loading voices…"
                : defaultVoiceDisplay}
            </option>
            {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
              <option value={selectedVoice}>
                {isSelectedPersonal
                  ? `Apple Personal Voice: ${selectedVoice.replace(/^(personal|apple-personal):/, "")} (On-device Mac / iOS)`
                  : `${selectedVoice} (Current)`}
              </option>
            )}
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.description ? ` — ${v.description}` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => void speaker.speak(SAMPLE, { voiceId: selectedVoice || tts?.voice, botId: bot.id })}
            disabled={previewDisabled}
            title={previewTitle}
            aria-label={previewTitle}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Volume2 size={14} /> Try
          </button>
        </div>
        {isSelectedPersonal && (
          <div className="mt-2 text-[12px] text-ink-secondary">
            This bot uses an Apple Personal Voice.{"\u00A0 "}Synthesis runs on-device on your authorized Mac or iPhone.
          </div>
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
            href="https://github.com/jaywedgeworth22/BotFleet/blob/main/docs/tts-post-processing-benchmark.md"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (window.ogb?.openExternal) {
                e.preventDefault();
                void window.ogb.openExternal(
                  "https://github.com/jaywedgeworth22/BotFleet/blob/main/docs/tts-post-processing-benchmark.md"
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
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
