// Per-bot voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key — the
// renderer never talks to MiniMax itself.
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Mic, Plus, Volume2, X } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";

const SAMPLE = "Morning.  Overnight the tests went green, and I left two notes for you in the thread.";
const MINIMAX_KEY_URL = "https://platform.minimax.io/user/basic-information/interface-key";
const ELEVENLABS_KEY_URL = "https://elevenlabs.io/app/settings/api-keys";
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
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  // ── voice clone state ───────────────────────────────────────────────
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneLabel, setCloneLabel] = useState("");
  const [cloneCloning, setCloneCloning] = useState(false);
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneSuccess, setCloneSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { capabilities } = useDesktopCapabilities();
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const provider = tts?.provider ?? "minimax";
  const configured = Boolean(tts?.configured);

  useEffect(() => {
    if (!configured) {
      setVoices([]);
      return;
    }
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
  }, [configured, provider]);

  const setProvider = (next: "minimax" | "elevenlabs" | "system") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: next, voice: "" } }) })
      .then((status: ConfigStatus) => { dispatch({ type: "configStatus", config: status }); setVoices([]); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential("ttsKey", nextKey, provider)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey, provider } }) });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
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
        // Refresh voice list.
        const voicesResult = await api("/api/tts/voices") as { voices?: typeof voices; error?: string };
        if (voicesResult.voices) setVoices(voicesResult.voices);
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

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Give this bot a voice for calls and spoken replies.  The voice choice belongs to this bot;
        {provider === "system"
          ? systemVoicesAvailable
            ? " the voices are the ones already installed on this Mac."
            : " built-in Mac voices are unavailable here.  Switch to MiniMax to keep using voice."
          : provider === "elevenlabs" ? " the ElevenLabs key is shared by the workspace." : " the MiniMax key is shared by the workspace."}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[13px] text-ink-secondary">Voice Engine</div>
        <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice Engine">
          {([
            { value: "minimax" as const, label: "MiniMax", available: true },
            { value: "elevenlabs" as const, label: "ElevenLabs", available: true },
            { value: "system" as const, label: "Built-in Mac voices", available: systemVoicesAvailable },
          ]).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={provider === option.value}
              disabled={switching || !option.available}
              title={!option.available ? "Built-in voices are available only on macOS" : undefined}
              onClick={() => setProvider(option.value)}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-50",
                provider === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {provider !== "system" && (
        <>
          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
              <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
              <span>{provider === "elevenlabs" ? "ElevenLabs Key" : "MiniMax Key"}</span>
              {configured && <span className="text-[11px] text-success">Connected</span>}
            </div>
            <p className="mb-2 text-[11.5px] text-ink-secondary">Switching engines keeps the saved key.  Replace it here if the new engine uses a different account.</p>
            <div className="flex gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
                placeholder={configured ? "••••••••  (paste to replace)" : `Paste your ${provider === "elevenlabs" ? "ElevenLabs" : "MiniMax"} API key`}
                aria-label={`${provider === "elevenlabs" ? "ElevenLabs" : "MiniMax"} Key`}
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
                href={provider === "elevenlabs" ? ELEVENLABS_KEY_URL : MINIMAX_KEY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
              >
                Get a Key
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </div>

          {configured && provider === "minimax" && (
            <>
              {/* ── Voice clone panel ── */}
              <div className="mt-4 border-t border-hairline/40 pt-4">
                <div className="mb-1.5 flex items-center justify-between text-[13px] text-ink-secondary">
                  <span>Clone a Voice</span>
                  <button
                    type="button"
                    onClick={() => setCloneOpen((o) => !o)}
                    className="flex items-center gap-1 text-accent hover:underline"
                  >
                    {cloneOpen ? <X size={12} /> : <Plus size={12} />}
                    {cloneOpen ? "Close" : "Add From Audio"}
                  </button>
                </div>

                {cloneOpen && (
                  <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-3">
                    <p className="mb-2 text-[12px] text-ink-secondary">
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
                    <button
                      type="button"
                      onClick={() => void handleClone()}
                      disabled={cloneCloning || !cloneFile || !cloneLabel.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {cloneCloning ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                      {cloneCloning ? "Cloning…" : "Clone Voice"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
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
                  : tts.voice
                    ? "Workspace default"
                    : "Pick a voice"}
              </option>
              {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                <option value={selectedVoice}>Current bot voice</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
              disabled={!ready}
              title={ready ? "Hear this voice" : "Pick a voice first"}
              aria-label="Hear this voice"
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[13px] font-medium text-ink">Speech to Text</div>
        <p className="mt-1 text-[12px] text-ink-secondary">iPhone microphone dictation uses Apple on-device recognition when this language and device support it.  Recordings sent from iPhone keep the original audio and transcript on their message.</p>
        <p className="mt-1 text-[12px] text-ink-secondary">Cloud fallback and translation are not configured.  Siri and iOS 27 speech features still need device testing.</p>
      </div>

      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[13px] font-medium text-ink">Play Replies On</div>
        <p className="mt-0.5 text-[11.5px] text-ink-secondary">Choose where this bot speaks as answers arrive.  Voice clips stay on their messages for replay.</p>
        <div className="mt-3 flex gap-4">
          {([['mac', 'Mac'], ['iphone', 'Play on iPhone (while app is open)']] as const).map(([device, label]) => {
            const selected = bot.speechDevices ? bot.speechDevices.includes(device) : device === 'mac' && Boolean(bot.speakReplies);
            return <label key={device} className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={selected} onChange={() => {
                const devices = bot.speechDevices ?? (bot.speakReplies ? ['mac'] : []);
                onPatch({ speechDevices: selected ? devices.filter((item) => item !== device) : [...devices, device] });
              }} />{label}
            </label>;
          })}
        </div>
      </div>

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
