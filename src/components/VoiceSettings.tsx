// Per-bot voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key — the
// renderer never talks to MiniMax itself.
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Mic, Plus, Trash2, Volume2, X } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";

const SAMPLE = "Morning.  Overnight the tests went green, and I left two notes for you in the thread.";
const MINIMAX_KEY_URL = "https://platform.minimax.io/user/basic-information/interface-key";
const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies" | "speechDevices">>) => void;
}) {
  const { state, dispatch } = useStore();
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

  const loadVoices = () => {
    setLoadingVoices(true);
    return api("/api/tts/voices")
      .then((r: { voices?: typeof voices; error?: string }) => {
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => setVoices([]))
      .finally(() => setLoadingVoices(false));
  };

  useEffect(() => {
    let alive = true;
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((r: { voices?: typeof voices; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
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
        setCloneSuccess(`Voice "${label}" cloned and ready.  Pick it from the list below.`);
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
  const ready = configured && Boolean(selectedVoice || tts.voice);

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
        Give this bot a voice for calls and spoken replies using MiniMax.  The voice choice belongs to this bot; the MiniMax key is shared by the workspace.
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
              Upload a short audio clip (10 seconds to 5 minutes, MP3/M4A/WAV, under 20 MB) to create a voice
              clone.  The clone appears in the voice list below.
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
              <option value={selectedVoice}>{selectedVoice} (Current)</option>
            )}
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
                {v.description ? ` — ${v.description}` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => void speaker.speak(SAMPLE, { voiceId: selectedVoice || tts.voice, botId: bot.id })}
            disabled={!ready}
            title={ready ? "Hear this voice" : "Pick a voice first"}
            aria-label="Hear this voice"
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Volume2 size={14} /> Try
          </button>
        </div>
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
        <p className="mt-1 text-[12px] text-ink-secondary">iPhone microphone dictation uses Apple on-device recognition when this language and device support it.  Recordings sent from iPhone keep the original audio and transcript on their message.</p>
        <p className="mt-1 text-[12px] text-ink-secondary">Cloud fallback and translation are not configured.  Siri and iOS 27 speech features still need device testing.</p>
      </div>

      {/* ── Play Replies On ── */}
      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[13px] font-medium text-ink">Play Replies On</div>
        <p className="mt-0.5 text-[11.5px] text-ink-secondary">Choose where this bot speaks as answers arrive.  Voice clips stay on their messages for replay.</p>
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

      {/* ── Speech-Friendly Summaries ── */}
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Speech-Friendly Summaries</div>
          <p className="text-[11.5px] text-ink-secondary">Ask every bot to write a short spoken summary and a full written answer.  The summary appears when a message is expanded and is used for speech.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(tts.optimizedSummary)}
          aria-label="Speech-Friendly Summaries"
          onClick={() => {
            api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { optimizedSummary: !tts.optimizedSummary } }) })
              .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
              .catch((cause: Error) => setError(cause.message));
          }}
          className={cnSwitch(Boolean(tts.optimizedSummary))}
        >
          <span className={cnKnob(Boolean(tts.optimizedSummary))} />
        </button>
      </div>
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
