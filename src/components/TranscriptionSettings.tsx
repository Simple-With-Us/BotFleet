import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/cn";
import { announceTranscriptionStatus } from "@/lib/transcription-status";
import { KEYTERMS_MAX, formatKeyterms, keytermsDirty, parseKeyterms, persistKeyterms } from "@/lib/stt-keyterms";

type Provider = "auto" | "apple" | "assemblyai";

const MAX_INPUT_HEIGHT_PX = 220;

export function TranscriptionSettings() {
  const bridge = window.ogb?.transcription;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearing = configured === true && !value.trim();

  const [provider, setProvider] = useState<Provider>("auto");
  const [globalKeyterms, setGlobalKeyterms] = useState<string>("");
  const [lastSavedKeyterms, setLastSavedKeyterms] = useState<string[]>([]);
  const [callSttLoaded, setCallSttLoaded] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingKeyterms, setSavingKeyterms] = useState(false);

  useEffect(() => {
    let alive = true;
    bridge?.status()
      .then((status) => alive && setConfigured(status.configured))
      .catch(() => alive && setConfigured(false));
    return () => { alive = false; };
  }, [bridge]);

  // Hydrate the call-STT section from AppConfig once on mount; later edits
  // go back via PUT /api/config rather than through the bridge.
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => {
        if (!alive) return;
        const explicit = cfg?.callStt?.provider;
        setProvider(explicit === "apple" || explicit === "assemblyai" ? explicit : "auto");
        const saved = parseKeyterms(formatKeyterms(Array.isArray(cfg?.callStt?.keyterms) ? cfg.callStt.keyterms : []));
        setGlobalKeyterms(formatKeyterms(saved));
        setLastSavedKeyterms(saved);
        setCallSttLoaded(true);
      })
      .catch(() => alive && setCallSttLoaded(true));
    return () => { alive = false; };
  }, []);

  const parsedKeyterms = useMemo(() => parseKeyterms(globalKeyterms), [globalKeyterms]);
  const keytermsOverLimit = parsedKeyterms.length >= KEYTERMS_MAX;
  const vocabularyDirty = callSttLoaded && keytermsDirty(parsedKeyterms, lastSavedKeyterms);

  const save = async () => {
    if (!bridge || saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    try {
      const status = await bridge.setKey(value.trim());
      setConfigured(status.configured);
      setValue("");
      announceTranscriptionStatus(status.configured);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const saveProvider = async (next: Provider) => {
    setSavingProvider(true);
    setError(null);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callStt: { provider: next === "auto" ? null : next } }),
      });
      if (!res.ok) throw new Error(`PUT /api/config → ${res.status}`);
      setProvider(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingProvider(false);
    }
  };

  const saveKeyterms = async () => {
    setSavingKeyterms(true);
    setError(null);
    try {
      const saved = await persistKeyterms(parsedKeyterms);
      // Only a successful PUT advances the baseline, including a cleared list.
      setGlobalKeyterms(formatKeyterms(saved));
      setLastSavedKeyterms(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingKeyterms(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>AssemblyAI Transcription</span>
          {configured && <span className="text-[11px] text-success">Connected</span>}
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
          Live narration for recorded skills.{"\u00A0 "}Audio is sent to AssemblyAI while recording; the
          API key is protected by your operating system.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void save()}
            placeholder={configured ? "••••••••  (paste to replace)" : "Paste your AssemblyAI API key"}
            aria-label="AssemblyAI API Key"
            autoComplete="off"
            disabled={!bridge}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!bridge || saving || (!value.trim() && !configured)}
            title={clearing ? "Remove the saved key" : "Save"}
            className={cn(
              "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
              clearing ? "text-danger" : "text-ink",
            )}
          >
            {saving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : clearing ? (
              "Clear"
            ) : (
              <>
                <Check size={13} />Save
              </>
            )}
          </button>
        </div>
        <a
          href="https://www.assemblyai.com/dashboard"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          Open AssemblyAI dashboard <ExternalLink size={12} />
        </a>
        {!bridge && (
          <div className="mt-1 text-[12px] text-warning">Available in the installed desktop app.</div>
        )}
      </section>

      <section>
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className="text-ink">Voice Calls & Dictation</span>
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
          Voice mode works everywhere.{"\u00A0 "}macOS uses on-device Apple Speech Recognition until a
          key is added, then opts into the same cloud engine that powers skill narration —
          quicker turnaround, custom vocabulary, server-side turn detection.
        </p>
        <fieldset className="space-y-1.5">
          <legend className="sr-only">Voice call dictation provider</legend>
          {(
            [
              {
                value: "auto" as Provider,
                title: "Automatic",
                description:
                  "Use the best provider for this device — Apple on macOS, AssemblyAI on every other platform.",
              },
              {
                value: "apple" as Provider,
                title: "Apple Speech Recognition",
                description:
                  "macOS only.\u00A0 Audio never leaves the device.\u00A0 Lower accuracy on technical jargon.",
              },
              {
                value: "assemblyai" as Provider,
                title: "AssemblyAI Cloud Recognition",
                description:
                  "Cross-platform.\u00A0 Requires an API key above.\u00A0 Better accuracy and custom vocabulary.",
              },
            ]
          ).map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2 hover:border-hairline",
                provider === option.value && "border-accent",
              )}
            >
              <input
                type="radio"
                name="call-stt-provider"
                value={option.value}
                checked={provider === option.value}
                onChange={(event) => void saveProvider(event.target.value as Provider)}
                disabled={!callSttLoaded || savingProvider}
                className="mt-1 size-3 accent-accent"
              />
              <div>
                <div className="text-[13px] text-ink">{option.title}</div>
                <div className="text-[11px] text-ink-secondary">{option.description}</div>
              </div>
            </label>
          ))}
        </fieldset>
      </section>

      <section>
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className="text-ink">Spelled Correctly Every Time</span>
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
          Bot names, model handles, and product jargon added here are added to the model's
          recognition vocabulary.{"\u00A0 "}Comma-separated; up to {KEYTERMS_MAX} terms.
        </p>
        <textarea
          value={globalKeyterms}
          onChange={(event) => setGlobalKeyterms(event.target.value)}
          placeholder="BotFleet, Mavis, MiniMax, MiniMax, Custom Bot Name"
          rows={3}
          aria-label="Global keyterms vocabulary"
          disabled={!callSttLoaded}
          className="block w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
          style={{ minHeight: 72, maxHeight: MAX_INPUT_HEIGHT_PX }}
        />
        <div className="mt-1 flex items-center justify-between text-[11px] text-ink-secondary">
          <span>
            {parsedKeyterms.length} term{parsedKeyterms.length === 1 ? "" : "s"}
            {keytermsOverLimit ? " (cap reached)" : ""}
          </span>
          <button
            type="button"
            onClick={() => void saveKeyterms()}
            disabled={!callSttLoaded || savingKeyterms || !vocabularyDirty}
            className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {savingKeyterms ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Save Vocabulary
          </button>
        </div>
      </section>

      {error && (
        <div role="alert" className="text-[12px] text-danger">
          {error}
        </div>
      )}
    </div>
  );
}