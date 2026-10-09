// The two workspace-wide voice settings, shown at the top and the foot of a
// bot's Voice card (src/components/VoiceSettings.tsx):
//
// - Default Voice: cfg.tts.voice, what every bot without a voice of its own
//   speaks with on every device.  Saved through PUT /api/config, the same
//   path and validation as every other workspace setting.  Personal Voices
//   are device-local, so they are never offered here.
// - Pronunciations: cfg.tts.pronunciations, terms the voice keeps saying
//   wrong and how to say them (shared/pronunciations.ts), kept the way the
//   list of words to always spell correctly (callStt.keyterms) is kept.  The
//   harness hands back the list in force, seeded defaults included, so this
//   card never needs to know them.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, Trash2, Volume2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";
import {
  isPersonalVoiceId,
  NO_DEFAULT_VOICE,
  PERSONAL_VOICE_NOT_DEFAULT,
  voiceDisplayName,
} from "../../shared/bot-voice";
import { checkPronunciations, PRONUNCIATION_SAY_MAX, PRONUNCIATION_TERM_MAX, PRONUNCIATIONS_MAX, type Pronunciation } from "../../shared/pronunciations";

export type WorkspaceVoiceOption = { id: string; label: string; description?: string };

export const DEFAULT_VOICE_SAMPLE = "Morning.  Overnight the tests went green, and I left two notes for you in the thread.";

export const DEFAULT_VOICE_HELP = "Every bot without a voice of its own speaks with this one, on this Mac and on iPhone.";
export const NO_DEFAULT_VOICE_HELP =
  "No default voice is picked.  A bot without a voice of its own stays silent until you pick one here.";
export const PRONUNCIATIONS_HELP =
  "How the voice says terms it keeps getting wrong, for every bot.  A change applies to replies voiced after you save; clips already made keep their sound.";

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

export function DefaultVoicePicker({ voices, loading }: { voices: WorkspaceVoiceOption[]; loading: boolean }) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!tts) return null;

  const current = tts.voice ?? "";
  // Hosted and built-in voices only: a Personal Voice speaks on one device.
  const options = voices.filter((voice) => !isPersonalVoiceId(voice.id));
  const listed = options.some((voice) => voice.id === current);
  const currentIsPersonal = isPersonalVoiceId(current);

  const save = (next: string) => {
    if (!next || next === current) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { voice: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const canTry = Boolean(current) && (currentIsPersonal || tts.configured);

  return (
    <div className="mt-4" data-testid="default-voice">
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span>Default Voice</span>
        {saving && <Loader2 size={12} className="animate-spin" aria-label="Saving" />}
      </div>
      <div className="flex gap-2">
        <select
          value={current}
          onChange={(e) => save(e.target.value)}
          disabled={saving}
          aria-label="Default voice for every bot"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none disabled:opacity-60"
        >
          {!current && (
            <option value="" disabled>
              {loading ? "Loading voices…" : NO_DEFAULT_VOICE}
            </option>
          )}
          {current && !listed && (
            <option value={current}>
              {voiceDisplayName(current, voices)}
              {currentIsPersonal ? " — Personal Voice" : ""}
            </option>
          )}
          {options.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voiceDisplayName(voice.id, options)}
              {voice.description ? ` — ${voice.description}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void speaker.speak(DEFAULT_VOICE_SAMPLE, { voiceId: current })}
          disabled={!canTry}
          title={canTry ? "Hear the default voice" : "Pick a default voice first"}
          aria-label={canTry ? "Hear the default voice" : "Pick a default voice first"}
          className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Volume2 size={14} /> Try
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-secondary">
        {current ? DEFAULT_VOICE_HELP : NO_DEFAULT_VOICE_HELP}
        {"  "}
        {PERSONAL_VOICE_NOT_DEFAULT}
      </p>
      {error && <div role="alert" className="mt-1.5 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

type Row = { key: number; term: string; say: string };

const sameList = (a: readonly Pronunciation[], b: readonly Pronunciation[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry.term === b[i].term && entry.say === b[i].say);

/** The rows a person means: a row with both fields blank is not an entry. */
const filled = (rows: readonly Row[]): Array<{ term: string; say: string }> =>
  rows.filter((row) => row.term.trim() || row.say.trim()).map((row) => ({ term: row.term, say: row.say }));

export function PronunciationSettings() {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;
  const saved = tts?.pronunciations;
  const nextKey = useRef(0);
  const toRows = (list: readonly Pronunciation[]): Row[] =>
    list.map((entry) => ({ key: nextKey.current++, term: entry.term, say: entry.say }));
  const [rows, setRows] = useState<Row[]>(() => toRows(saved ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useMemo(() => checkPronunciations(filled(rows)), [rows]);
  const dirty = !check.ok || !sameList(check.list, saved ?? []);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Adopt a list saved elsewhere (the iPhone, another window) unless this
  // draft has edits of its own, which a save would then replace.
  const savedKey = JSON.stringify(saved ?? null);
  useEffect(() => {
    if (!dirtyRef.current) setRows(toRows(saved ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- savedKey is the list's value
  }, [savedKey]);

  if (!tts) return null;
  if (!saved) {
    return (
      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[13px] font-medium text-ink">Pronunciations</div>
        <p role="status" className="mt-1 text-[12px] text-ink-secondary">
          Update the bot server on this computer to edit pronunciations.
        </p>
      </div>
    );
  }

  const update = (key: number, field: "term" | "say", value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  const remove = (key: number) => setRows((current) => current.filter((row) => row.key !== key));
  const add = () => setRows((current) => [...current, { key: nextKey.current++, term: "", say: "" }]);

  const save = () => {
    if (!check.ok) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { pronunciations: check.list } }) })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setRows(toRows(status.tts?.pronunciations ?? check.list));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const voiceId = tts.voice ?? "";
  const canTry = Boolean(voiceId) && (isPersonalVoiceId(voiceId) || tts.configured);
  const full = rows.length >= PRONUNCIATIONS_MAX;
  // A row still being typed is not an error yet: only say so once the
  // person has something to save.
  const problem = dirty && !check.ok ? check.error : null;

  return (
    <div className="mt-4 border-t border-hairline/40 pt-4" data-testid="pronunciations">
      <div className="text-[13px] font-medium text-ink">Pronunciations</div>
      <p className="mt-1 text-[12px] text-ink-secondary">{PRONUNCIATIONS_HELP}</p>
      {rows.length > 0 && (
        <div className="mt-3 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-2 gap-y-1.5">
          <div className="text-[11.5px] font-medium text-ink-secondary">Term</div>
          <div className="text-[11.5px] font-medium text-ink-secondary">Say It As</div>
          <div />
          {rows.map((row, index) => {
            const label = row.term.trim() || `term ${index + 1}`;
            return (
              <div key={row.key} className="contents">
                <input
                  type="text"
                  value={row.term}
                  onChange={(e) => update(row.key, "term", e.target.value)}
                  maxLength={PRONUNCIATION_TERM_MAX + 8}
                  placeholder="SQL"
                  aria-label={`Term ${index + 1}`}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
                <input
                  type="text"
                  value={row.say}
                  onChange={(e) => update(row.key, "say", e.target.value)}
                  maxLength={PRONUNCIATION_SAY_MAX + 8}
                  placeholder="sequel"
                  aria-label={`Say ${label} as`}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void speaker.speak(row.say.trim(), { voiceId })}
                    disabled={!canTry || !row.say.trim()}
                    title={canTry ? `Hear how ${label} is said` : "Pick a default voice first"}
                    aria-label={`Try ${label}`}
                    className="flex items-center gap-1 rounded-lg bg-control px-2.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Volume2 size={13} /> Try
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row.key)}
                    title={`Remove ${label}`}
                    aria-label={`Remove ${label}`}
                    className="rounded p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {rows.length === 0 && (
        <p className="mt-3 text-[12px] text-ink-secondary">The list is empty, so every term is read as written.</p>
      )}
      {problem && <div role="alert" className="mt-2 text-[12px] text-danger">{problem}</div>}
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={add}
          disabled={full}
          className="flex items-center gap-1 text-[12px] text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={12} /> Add Term
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty || !check.ok}
          className={cn(
            "flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          Save Pronunciations
        </button>
      </div>
    </div>
  );
}
