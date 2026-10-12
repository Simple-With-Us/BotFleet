// Settings panel for speech-to-speech (STS) calls.
//
// Mirrors TranscriptionSettings: it hydrates from GET /api/config, writes the
// `sts` slice back with PUT /api/config, and reads per-provider key state from
// the Electron bridge rather than from config.json, because the keys live in
// the credential store and only their presence crosses the bridge.
//
// Two things are deliberately honest here rather than convenient:
//
//  * A provider with no key is still selectable.  pickStsProvider degrades a
//    preference pinned to a keyless provider to Auto, so the panel says which
//    key is missing and what will actually happen instead of implying the call
//    will fail.
//  * `frontEngine` defaults to on.  prepareStsSession reads
//    `config.frontEngine !== false`, so an absent value is on, and an absent
//    value must render as on.

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { cn } from "@/lib/cn";
import { STS_PROVIDERS, type StsProvider } from "@/lib/sts";

/** What the radios offer: Auto plus one entry per STS provider. */
export type StsOption = "auto" | StsProvider;

/** The `sts` slice of AppConfig, as it arrives from GET /api/config. */
export interface StsConfigSlice {
  provider?: "xai" | "gemini" | null;
  frontEngine?: boolean;
}

/**
 * The trust boundary for GET /api/config as this panel reads it.
 *
 * A TypeScript annotation is not a runtime check: the harness, a proxy, or a
 * config.json hand-edited on disk can all answer with a `provider` this build
 * has never heard of, or a `frontEngine` that arrived as the string "false".
 * Both used to land straight in UI state and render as a real setting — the
 * panel would claim Auto was chosen while the config said something else.
 * Parsing first turns that into the same visible note a failed fetch already
 * shows, instead of a confident wrong toggle.
 *
 * The envelope is deliberately not `.strict()`, because this panel reads one
 * slice of a response that legitimately carries many others (`tts`, `vps`,
 * `composio`, …) and must not reject a config for carrying them.  The `sts`
 * object itself is strict: an unexpected field there is drift worth reporting.
 * Every key is optional, because an older server predates the slice entirely
 * and an absent value already has a defined meaning — Auto, engine on.
 */
export const StsConfigResponseSchema = z.object({
  sts: z
    .object({
      provider: z.enum(["xai", "gemini"]).nullish(),
      frontEngine: z.boolean().optional(),
    })
    .strict()
    .optional(),
});

/**
 * One line the panel can show for a body the schema refused.
 *
 * A raw ZodError stringifies to a multi-line JSON issue dump, which the alert
 * renders as a wall of braces; this keeps the field and the complaint and drops
 * the rest.  Sentence case, like every other status string in this panel.
 */
export function describeStsConfigFailure(failure: z.ZodError): string {
  const first = failure.issues[0];
  if (!first) return "These settings did not load.  Try again.";
  const where = first.path.join(".");
  const complaint = first.message.toLowerCase();
  return `These settings did not load.  ${where ? `${where}: ` : ""}${complaint}.`;
}

const PROVIDER_TITLES = {
  xai: "xAI",
  gemini: "Google Gemini",
} satisfies Record<StsProvider, string>;

const PROVIDER_BLURBS = {
  xai: "Realtime speech on one connection.",
  gemini: "Gemini Live speech on one connection.",
} satisfies Record<StsProvider, string>;

/** The human-readable name for each provider's missing key, for the panel copy. */
const PROVIDER_KEY_NAMES = {
  xai: "xAI API key",
  gemini: "Gemini API key",
} satisfies Record<StsProvider, string>;

/** Narrow a config or radio value without a cast, off the list the picker uses. */
function isStsProvider(value: string | null | undefined): value is StsProvider {
  return STS_PROVIDERS.some((provider) => provider === value);
}

/**
 * The provider choice actually in force.  Absent and `null` both mean Auto,
 * which is what the config schema stores when the picker has no preference.
 */
export function stsEffectiveProvider(slice?: StsConfigSlice | null): StsOption {
  const provider = slice?.provider;
  return isStsProvider(provider) ? provider : "auto";
}

/**
 * Whether real work is handed to the bot's own engine.  Only an explicit
 * `false` turns it off, matching prepareStsSession's `frontEngine !== false`,
 * so an unset config renders as on rather than as an off toggle.
 */
export function stsEffectiveFrontEngine(slice?: StsConfigSlice | null): boolean {
  return slice?.frontEngine !== false;
}

/** Per-provider key state; null means "not known", never "no key". */
export type StsKeyState = Partial<Record<StsProvider, boolean>> | null;

/**
 * What the panel says under a provider about its credential.
 *
 * A missing key is named rather than swallowed: pickStsProvider degrades a
 * preference pinned to a keyless provider to Auto, so the honest line says
 * which key is absent and that Auto will take the call until it is added.
 * `null` means the state is still unknown, which must not read as "no key".
 */
export function stsKeyNotice(provider: StsProvider, keys: StsKeyState): string | null {
  if (!keys) return null;
  return keys[provider]
    ? "Key configured."
    : `No ${PROVIDER_KEY_NAMES[provider]}.  Calls stay on Auto until you add one.`;
}

export function StsSettings() {
  const bridge = window.ogb?.sts;
  const [keys, setKeys] = useState<StsKeyState>(null);
  const [keysFailed, setKeysFailed] = useState(false);
  const [provider, setProvider] = useState<StsOption>("auto");
  const [frontEngine, setFrontEngine] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!bridge) {
      setKeysFailed(true);
      return;
    }
    bridge
      .status()
      .then((status) => {
        if (!alive) return;
        setKeys({ xai: status.xai, gemini: status.gemini });
      })
      .catch(() => {
        if (!alive) return;
        setKeysFailed(true);
      });
    return () => { alive = false; };
  }, [bridge]);

  // Hydrate the STS section from AppConfig once on mount; later edits go back
  // through PUT /api/config rather than the bridge.  The body is parsed before
  // a single field is read, so no annotation can quietly become the only gate
  // again; a body that will not parse throws into the same catch a failed
  // fetch does, and the panel shows the note rather than rendering defaults
  // as if the server had sent them.
  useEffect(() => {
    let alive = true;
    fetch("/api/config")
      .then((res) => {
        if (!res.ok) throw new Error("These settings did not load.  Try again.");
        return res.json();
      })
      .then((body) => StsConfigResponseSchema.parse(body))
      .then((cfg) => {
        if (!alive) return;
        setProvider(stsEffectiveProvider(cfg.sts));
        setFrontEngine(stsEffectiveFrontEngine(cfg.sts));
        setLoaded(true);
      })
      .catch((failure) => {
        if (!alive) return;
        setError(
          failure instanceof z.ZodError
            ? describeStsConfigFailure(failure)
            : failure instanceof Error ? failure.message : String(failure),
        );
        setLoaded(true);
      });
    return () => { alive = false; };
  }, []);

  // One writer for the whole slice, so a second click mid-save is dropped
  // rather than racing the first PUT.  Reports whether the write landed, so
  // a failed save leaves the shown choice where it was.
  const save = async (patch: StsConfigSlice): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sts: patch }),
      });
      if (!res.ok) throw new Error("These settings did not save.  Try again.");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveProvider = async (next: StsOption) => {
    // Only a confirmed write advances the shown choice.
    if (await save({ provider: next === "auto" ? null : next })) setProvider(next);
  };

  const saveFrontEngine = async (next: boolean) => {
    if (await save({ frontEngine: next })) setFrontEngine(next);
  };

  const configured = STS_PROVIDERS.filter((p) => keys?.[p]);

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured.length > 0 ? "bg-success" : "bg-raised-hover")} />
          <span className="text-ink">Speech-to-Speech Calls</span>
          {configured.length > 0 && (
            <span className="text-[11px] text-success">
              {configured.length === STS_PROVIDERS.length
                ? "All keys ready"
                : `1 key ready`}
            </span>
          )}
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
          The model hears the caller and speaks back on one connection, instead of transcribing
          and re-synthesizing each turn.{"\u00A0 "}Add a provider key to turn it on.
        </p>

        <fieldset className="space-y-1.5">
          <legend className="sr-only">Speech-to-speech provider</legend>

          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2 hover:border-hairline",
              provider === "auto" && "border-accent",
              (saving || !loaded) && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="radio"
              name="sts-provider"
              value="auto"
              checked={provider === "auto"}
              onChange={() => void saveProvider("auto")}
              disabled={!loaded || saving}
              className="mt-1 size-3 accent-accent"
            />
            <div>
              <div className="text-[13px] text-ink">Auto</div>
              <div className="text-[11px] text-ink-secondary">
                Use whichever provider has a key, preferring {PROVIDER_TITLES[STS_PROVIDERS[0]]}.
                {keys && configured.length === 0 && " No provider key is configured yet."}
              </div>
            </div>
          </label>

          {STS_PROVIDERS.map((option) => {
            const notice = stsKeyNotice(option, keys);
            return (
              <label
                key={option}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2 hover:border-hairline",
                  provider === option && "border-accent",
                  (saving || !loaded) && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="sts-provider"
                  value={option}
                  checked={provider === option}
                  onChange={() => void saveProvider(option)}
                  disabled={!loaded || saving}
                  className="mt-1 size-3 accent-accent"
                />
                <div>
                  <div className="text-[13px] text-ink">{PROVIDER_TITLES[option]}</div>
                  <div className="text-[11px] text-ink-secondary">
                    {notice ? `${PROVIDER_BLURBS[option]} ${notice}` : PROVIDER_BLURBS[option]}
                  </div>
                </div>
              </label>
            );
          })}
        </fieldset>

        {!bridge && (
          <div className="mt-2 text-[12px] text-warning">Calls need the installed desktop app.</div>
        )}
        {bridge && keysFailed && (
          <div className="mt-2 text-[12px] text-warning">
            Could not read the key status.{"  "}The desktop app stores provider keys.
          </div>
        )}
      </section>

      <section>
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className="text-ink">Hand Real Work To The Bot's Engine</span>
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
          The model hands real work to the bot's own coding engine.{"\u00A0 "}When that engine is
          slow or unavailable, the model answers that turn alone instead.
        </p>
        <label
          className={cn(
            "flex items-center gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2",
            (saving || !loaded) ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-hairline",
          )}
        >
          <input
            type="checkbox"
            checked={frontEngine}
            onChange={(event) => void saveFrontEngine(event.target.checked)}
            disabled={!loaded || saving}
            className="size-3 accent-accent"
            aria-label="Use The Bot's Coding Engine"
          />
          <div className="text-[13px] text-ink">Use The Bot's Coding Engine</div>
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-secondary">
            {saving && <Loader2 size={12} className="animate-spin" />}
            {frontEngine ? "On" : "Off"}
          </div>
        </label>
        <div className="mt-1 text-[11px] text-ink-secondary">On by default.</div>
      </section>

      {error && (
        <div role="alert" className="text-[12px] text-danger">
          {error}
        </div>
      )}
    </div>
  );
}