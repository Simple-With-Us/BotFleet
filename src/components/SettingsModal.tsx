// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Activity, Coins, Globe, KeyRound, Layers, Monitor, Search, Smartphone, Terminal, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import {
  DEFAULT_ROOM_TERMINOLOGY,
  ROOM_LABEL_MAX_LENGTH,
  ROOM_TERMINOLOGY_OPTIONS,
  ROOM_TERMINOLOGY_PRESETS,
  suggestPlural,
  type RoomLabels,
  type RoomTerminology,
} from "../../shared/terminology";
import {
  CONVERSATION_MODE_COPY,
  CONVERSATION_MODES,
  parseConversationMode,
  type ConversationMode,
} from "../../shared/conversation-mode";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { showToolCallsEnabled, skillRecorderEnabled, summarizeToolCallsEnabled } from "@/lib/feature-flags";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { FleetModelsSection } from "./FleetModelsSection";
import { BotComputerDefaults } from "./BotComputerDefaults";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { RemoteAccessSection } from "./RemoteAccessSection";
import { Card } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { ObservabilitySection } from "./ObservabilitySection";
import { SecretsSection } from "./SecretsSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { QdrantRagConnection } from "./QdrantRagConnection";
import { ElevenLabsConnection } from "./ElevenLabsConnection";
import { cn } from "@/lib/cn";

const SECTIONS: Array<{
  id: AppSettingsSection;
  label: string;
  icon: typeof User;
  keywords: string[];
}> = [
  { id: "general", label: "General", icon: User, keywords: ["profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates", "tools", "tool calls", "simple", "projects", "threads", "workspace"] },
  { id: "connections", label: "Connections", icon: KeyRound, keywords: ["keys", "api", "composio", "box", "xai", "vps", "elevenlabs", "voice", "tts", "speech"] },
  { id: "remote", label: "Remote Access", icon: Globe, keywords: ["remote", "url", "tunnel", "cloudflare", "access", "jay's tunnel", "health"] },
  { id: "engines", label: "Engines", icon: Terminal, keywords: ["models", "claude", "grok", "providers", "cli"] },
  { id: "models", label: "Models", icon: Layers, keywords: ["model", "fallback", "primary", "engine", "per bot", "fleet"] },
  { id: "companion", label: "Phone", icon: Smartphone, keywords: ["companion", "phone", "pair", "mobile", "gateway", "sidecar"] },
  { id: "computers", label: "Local VM", icon: Monitor, keywords: ["vm", "virtual", "desktop"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
  { id: "observability", label: "Observability", icon: Activity, keywords: ["sentry", "errors", "crashes", "traces", "logs", "diagnostics"] },
  { id: "secrets", label: "Secrets", icon: KeyRound, keywords: ["infisical", "vault", "credentials", "secret", "provenance"] },
];

function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [section.label, ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

function CustomIngressFields() {
  const { state, dispatch } = useStore();
  // The persisted value drives the toggle and the input; the toggle defaults
  // to "on" so a config written by an older build keeps applying its URL.
  const persistedEnabled = state.config?.ingress?.enabled !== false;
  const persistedUrl = state.config?.ingress?.publicUrl ?? "";
  const [publicUrl, setPublicUrl] = useState(persistedUrl);
  const [enabled, setEnabled] = useState(persistedEnabled);
  // "dirty" means the user has typed or toggled something the server has
  // not yet seen.  Only the Save button publishes; the input never autosaves
  // on blur anymore.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [useFreeUrl, setUseFreeUrl] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  // Test Setup result.  `null` = never run, otherwise the server's reply.
  const [test, setTest] = useState<
    | null
    | { kind: "running" }
    | { kind: "ok"; reason: string; tunnel?: string }
    | { kind: "error"; reason: string; tunnel?: string }
  >(null);
  // Save failures render next to the Save button, not into the Test Setup
  // slot above -- the two actions are independent, so a failed Save must
  // not be mistaken for (or overwrite) a Test Setup result and vice versa.
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const bridge = (window as any).ogb?.companion;
    if (!bridge) return;

    // Poll the companion state
    const poll = async () => {
      try {
        const state = await bridge.state();
        if (active && state?.url) {
          setTunnelUrl(state.url);
        }
      } catch (e) {}
      if (active) setTimeout(poll, 2000);
    };
    poll();
    return () => { active = false; };
  }, []);


  // A remote config refresh (e.g. the harness broadcast a newer config)
  // resets the local draft so the fields never silently disagree with what
  // is on disk.  A pending edit wins until the user actually saves it.
  useEffect(() => {
    if (dirty) return;
    setPublicUrl(persistedUrl);
    setEnabled(persistedEnabled);
  }, [persistedUrl, persistedEnabled, dirty]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const trimmed = publicUrl.trim();
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ingress: {
            // Always send the trimmed value, including "" -- the server
            // reads an *absent* publicUrl as "no change" (so a stray
            // `|| undefined` here silently dropped the field from the JSON
            // body and clearing the input never reached disk), but an
            // explicit "" is the documented clear-the-URL path.
            publicUrl: trimmed,
            enabled,
          },
        }),
      });
      if (!response.ok) {
        setSaveError(`Save failed: HTTP ${response.status}`);
        return;
      }
      const config = await response.json();
      dispatch({ type: "configStatus", config });
      setDirty(false);
      setSavedAt(Date.now());
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  // Run Test Setup against either the unsaved draft (so the user can dry-run
  // a value before saving it) or, when the input is empty, the saved URL --
  // the more useful behaviour, and the one this comment already promised.
  // The input starts pre-filled from `persistedUrl`, so the only way it can
  // be empty while a saved URL still exists is the user having deliberately
  // cleared it -- silently testing the URL they just tried to remove would
  // be confusing, so that case is called out in the result text instead of
  // being folded in unannounced.
  const runTest = async () => {
    setSaveError(null);
    const draft = publicUrl.trim();
    const savedUrl = persistedUrl.trim();
    const usingSavedFallback = !draft && Boolean(savedUrl);
    const candidate = draft || savedUrl;
    if (!candidate) {
      setTest({ kind: "error", reason: "Enter a public URL first, then run Test Setup." });
      return;
    }
    setTest({ kind: "running" });
    try {
      const response = await fetch("/api/ingress/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicUrl: candidate }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        reason: string;
        tunnel?: string;
      };
      const reason = usingSavedFallback ? `${body.reason} (testing the saved URL -- the field is empty)` : body.reason;
      setTest(body.ok ? { kind: "ok", reason, ...(body.tunnel ? { tunnel: body.tunnel } : {}) } : { kind: "error", reason, ...(body.tunnel ? { tunnel: body.tunnel } : {}) });
    } catch (cause) {
      setTest({ kind: "error", reason: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    setDirty(true);
    setSaveError(null);
  };

  const toggleFreeUrl = () => {
    const next = !useFreeUrl;
    setUseFreeUrl(next);
    if ((window as any).ogb?.companion?.tryCloudflare) {
      (window as any).ogb.companion.tryCloudflare(next).catch(() => {});
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50";
  const buttonSecondary =
    "rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggleEnabled}
          className="accent-ink"
          aria-label="Enable custom webhook domain"
        />
        Enable Custom Webhook Domain
      </label>

      <div className="flex flex-col gap-1.5">
        <input
          type="url"
          value={publicUrl}
          onChange={(e) => {
            setPublicUrl(e.target.value);
            setDirty(true);
            setSaveError(null);
            // a new URL invalidates the previous test result
            if (test && test.kind !== "running") setTest(null);
          }}
          placeholder="https://agents.botfleet.app"
          disabled={!enabled || useFreeUrl}
          className={inputClass}
        />
        <div className="text-[12px] text-ink-secondary leading-relaxed">
          {enabled
            ? "If you run your own Cloudflare Tunnel (e.g. agents.botfleet.app), enter its public URL here to route webhooks."
            : `When this is off, the saved URL is kept on disk but BotFleet advertises its local webhook receiver instead.${"\u00A0 "}Flip the switch back on to apply it again.`}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          aria-label="Save custom webhook domain"
          className={buttonSecondary}
        >
          {saving ? "Saving…" : dirty ? "Save" : savedAt ? "Saved" : "Save"}
        </button>
        <button
          onClick={() => void runTest()}
          disabled={test?.kind === "running" || !(publicUrl.trim() || persistedUrl.trim())}
          aria-label="Test custom webhook domain"
          className={buttonSecondary}
        >
          {test?.kind === "running" ? "Testing…" : "Test Setup"}
        </button>
        {/* Independent, not mutually exclusive: Save and Test Setup can now
            overlap (Test Setup does not check `saving`), so a Save that
            fails AFTER a Test Setup result already rendered must not hide
            that result behind the save error — the two actions carry their
            own outcome and both are shown when both have one. */}
        {saveError ? (
          <span role="alert" data-testid="ingress-save-error" className="text-[12px] leading-relaxed text-danger">
            {saveError}
          </span>
        ) : null}
        {test && test.kind !== "running" ? (
          <span
            role={test.kind === "ok" ? "status" : "alert"}
            data-testid="ingress-test-result"
            className={`text-[12px] leading-relaxed ${test.kind === "ok" ? "text-success" : "text-danger"}`}
          >
            {test.reason}
          </span>
        ) : null}
      </div>

      <div className="h-px w-full bg-hairline/40" />

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[13px] text-ink cursor-pointer">
          <input
            type="checkbox"
            checked={useFreeUrl}
            onChange={toggleFreeUrl}
            className="accent-ink"
          />
          Enable Free URL (TryCloudflare)
        </label>

        <div className="text-[12px] text-ink-secondary leading-relaxed">
          Generates a free, temporary URL for quick phone pairing.{"\u00A0 "}This URL changes every time BotFleet restarts, so it is not recommended for permanent webhooks like Slack.
        </div>
        {useFreeUrl && tunnelUrl && (
          <div className="mt-2 flex items-center justify-between rounded-lg border border-hairline/50 bg-control px-3 py-2">
            <span className="text-[13px] font-mono text-ink">{tunnelUrl}</span>
            <button
              onClick={() => navigator.clipboard.writeText(tunnelUrl ?? "")}
              className="text-[12px] text-ink-secondary hover:text-ink"
            >
              Copy
            </button>
          </div>
        )}

      </div>
    </div>
  );
}

function UpdatesRow() {
  const { state, dispatch } = useStore();
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? `Downloading ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ready — restart to apply`
            : s?.status === "error"
              ? `Check failed: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card
      title="Updates"
      subtitle={`${label}${"\u00A0 "}Auto-checks at most once per 6 hours;${"\u00A0 "}you can manually check any time if an update is available.`}
    >
      <div className="flex flex-col items-end gap-3">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={state.config?.autoUpdate?.enabled ?? false}
            onChange={(e) => {
              const enabled = e.target.checked;
              void fetch("/api/config", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ autoUpdate: { enabled } }),
              })
                .then((r) => r.json())
                .then((config) => {
                  dispatch({ type: "configStatus", config });
                  void window.ogb?.updater?.setEnabled?.(enabled);
                });
            }}
          />
          Enable automatic update checks
        </label>
        <button
          onClick={() => {
            if (s?.status === "available") return void updater.download();
            if (s?.status === "downloaded") return void updater.install();
            void updater.check();
          }}
          disabled={s?.status === "checking" || s?.status === "downloading"}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {s?.status === "available"
            ? "Download"
            : s?.status === "downloaded"
              ? "Restart and Install"
              : "Check for Updates"}
        </button>
      </div>
    </Card>
  );
}

import { loadUpdateNotificationsEnabled, saveUpdateNotificationsEnabled } from "@/lib/update-preferences";

function UpdateNotificationsRow() {
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(loadUpdateNotificationsEnabled()); }, []);
  return (
    <Card
      title="Update Notifications"
      subtitle="Show a small popup when a new version of BotFleet is available to download."
    >
      <button
        role="switch"
        aria-checked={on}
        aria-label="Show update notifications"
        onClick={() => {
          const next = !on;
          saveUpdateNotificationsEnabled(next);
          setOn(next);
          // dispatch custom event to re-render banner immediately
          window.dispatchEvent(new Event("botfleet:update-pref-changed"));
        }}
        className={cnSwitch(on)}
      >
        <span className={cnKnob(on)} />
      </button>
    </Card>
  );
}

function ConversationModeRow() {
  const { state, dispatch } = useStore();
  const current = parseConversationMode(state.config?.conversationMode);
  const [saving, setSaving] = useState(false);
  const [pendingSimple, setPendingSimple] = useState(false);
  const save = async (conversationMode: ConversationMode, mergeThreads = false) => {
    if (saving) return;
    setSaving(true);
    setPendingSimple(false);
    try {
      const config: ConfigStatus = await api("/api/conversation-mode", {
        method: "PATCH",
        body: JSON.stringify({ conversationMode, ...(mergeThreads ? { mergeThreads: true } : {}) }),
      });
      dispatch({ type: "configStatus", config });
    } catch {
    } finally {
      setSaving(false);
    }
  };
  const choose = (conversationMode: ConversationMode) => {
    if (saving || conversationMode === current) return;
    if (conversationMode === "simple" && current === "projects") {
      setPendingSimple(true);
      return;
    }
    void save(conversationMode);
  };
  return (
    <Card
      title="Workspace Layout"
      subtitle="Simple is Grok-style: named bots with one conversation each, plus group threads.  Projects hide named bots and treat the room word as a category that any number of threads can sit under."
    >
      <div className="flex flex-col gap-2">
        {CONVERSATION_MODES.map((mode) => {
          const copy = CONVERSATION_MODE_COPY[mode];
          const selected = current === mode;
          return (
            <button
              key={mode}
              type="button"
              disabled={saving}
              aria-pressed={selected}
              onClick={() => void choose(mode)}
              className={cn(
                "rounded-lg border px-3 py-2.5 text-left",
                selected ? "border-accent bg-accent/10" : "border-hairline/40 hover:bg-raised/60",
              )}
            >
              <div className="text-[14px] font-medium text-ink">{copy.title}</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{copy.subtitle}</div>
            </button>
          );
        })}
        {pendingSimple && (
          <div className="rounded-lg border border-hairline/40 bg-raised/40 px-3 py-2.5">
            <div className="text-[14px] font-medium text-ink">Merge Extra Threads?</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
              Simple is one conversation per bot.{"\u00A0"} Merge extra threads into that conversation, or keep them saved but hidden.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => void save("simple", true)}
                className="rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-ink"
              >
                Merge All Threads
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save("simple")}
                className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised/60"
              >
                Keep Extra Threads Hidden
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setPendingSimple(false)}
                className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Usage analytics, on by default and switchable here. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function TerminologyRow() {
  const { state, dispatch } = useStore();
  const current = state.config?.terminology ?? DEFAULT_ROOM_TERMINOLOGY;
  const stored = state.config?.roomLabels;
  const [saving, setSaving] = useState(false);
  // Held locally so typing stays responsive; only a finished pair is saved.
  const [draft, setDraft] = useState<RoomLabels>(() =>
    current === "custom" && stored ? stored : { singular: "", plural: "" },
  );
  const [pluralEdited, setPluralEdited] = useState(
    () => current === "custom" && Boolean(stored?.plural),
  );

  const save = async (body: Record<string, unknown>) => {
    if (saving) return;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/terminology", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      dispatch({ type: "configStatus", config });
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const choose = async (terminology: RoomTerminology) => {
    if (terminology !== "custom") return save({ terminology });
    // Switching to Custom keeps whatever is already in the fields, and seeds
    // them from the current word so the boxes are never blank to start.
    const seed = draft.singular ? draft : (stored ?? { singular: "", plural: "" });
    setDraft(seed);
    await save({ terminology: "custom", terminologyCustom: seed });
  };

  const commitCustom = (next: RoomLabels) => {
    setDraft(next);
    if (!next.singular.trim()) return;
    void save({ terminology: "custom", terminologyCustom: next });
  };

  return (
    <Card
      title="Terminology"
      subtitle="Choose what you prefer to call multi-bot shared spaces across the app.  It applies on this computer and on your phone."
    >
      <div className="flex flex-wrap gap-1 rounded-lg border border-hairline/40 bg-inset p-0.5">
        {ROOM_TERMINOLOGY_OPTIONS.map((option) => {
          const label =
            option === "custom" ? "Custom" : ROOM_TERMINOLOGY_PRESETS[option].plural;
          return (
            <button
              key={option}
              disabled={saving}
              onClick={() => void choose(option)}
              aria-pressed={current === option}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                current === option
                  ? "bg-raised text-ink shadow-sm"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      {current === "custom" && (
        <div className="mt-3 space-y-2">
          <p className="text-[12px] text-ink-secondary">
            Enter both forms.{"\u00A0 "}The plural is not always just an added
            &ldquo;s&rdquo;, so it has its own box &mdash; Category and Categories.
          </p>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[12px] font-medium text-ink-secondary">
                One of them
              </span>
              <input
                value={draft.singular}
                disabled={saving}
                maxLength={ROOM_LABEL_MAX_LENGTH}
                placeholder="App"
                onChange={(event) => {
                  const singular = event.target.value;
                  // The plural follows along until it is edited by hand, so
                  // the usual case stays one thing to type.
                  setDraft({
                    singular,
                    plural: pluralEdited ? draft.plural : suggestPlural(singular),
                  });
                }}
                onBlur={() =>
                  commitCustom({
                    singular: draft.singular,
                    plural: draft.plural || suggestPlural(draft.singular),
                  })
                }
                className="w-full rounded-md border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] text-ink"
              />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-[12px] font-medium text-ink-secondary">
                More than one
              </span>
              <input
                value={draft.plural}
                disabled={saving}
                maxLength={ROOM_LABEL_MAX_LENGTH}
                placeholder="Apps"
                onChange={(event) => {
                  setPluralEdited(true);
                  setDraft({ singular: draft.singular, plural: event.target.value });
                }}
                onBlur={() => commitCustom(draft)}
                className="w-full rounded-md border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] text-ink"
              />
            </label>
          </div>
        </div>
      )}
    </Card>
  );
}

function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <Card
      title="Usage Analytics"
      subtitle="Anonymous product events — app opened, which features get used. Never conversations, prompts, file contents, or bot output. Your email is only attached if you shared it during setup."
    >
      <button
        role="switch"
        aria-checked={on}
        aria-label="Send usage analytics"
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
        className={cnSwitch(on)}
      >
        <span className={cnKnob(on)} />
      </button>
    </Card>
  );
}

function ToolCallsRow() {
  const { state, dispatch } = useStore();
  const showCalls = showToolCallsEnabled(state.config);
  const summarize = summarizeToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const patchFeatures = async (patch: { showToolCalls?: boolean; summarizeToolCalls?: boolean }) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: patch }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Tool Calls & Tasks"
      subtitle="Configure how tool executions and background tasks are displayed in the transcript."
    >
      <div className="flex flex-col gap-4 divide-y divide-hairline/30">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-ink">Show tool calls</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
              Named chips for Bash, search, and other tools. Errors and bot-to-bot messages still appear.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={showCalls}
            aria-label="Show tool calls in chat"
            disabled={saving}
            onClick={() => void patchFeatures({ showToolCalls: !showCalls })}
            className={`${cnSwitch(showCalls)} disabled:cursor-wait disabled:opacity-50`}
          >
            <span className={cnKnob(showCalls)} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-4 pt-4">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-ink">Summarize bot tasks</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
              Group consecutive tool actions into an expandable live summary card with real-time step counters and latest command status.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={summarize}
            aria-label="Summarize bot tasks"
            disabled={saving}
            onClick={() => void patchFeatures({ summarizeToolCalls: !summarize })}
            className={`${cnSwitch(summarize)} disabled:cursor-wait disabled:opacity-50`}
          >
            <span className={cnKnob(summarize)} />
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const enabled = skillRecorderEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { skillRecorder: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the experimental feature setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Experimental Features"
      subtitle="Early features may change while we test them. They stay off unless you enable them."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Teach a Skill</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Show the workflow recorder in the sidebar.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Show Teach a Skill"
          disabled={saving}
          onClick={() => void toggle()}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
function DiagnosticsRow() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: `Saved to ${path}` });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title="Diagnostics"
      subtitle="Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it."
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label="Export diagnostics to a text file"
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? "Exporting…" : "Export Diagnostics…"}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleSections = SECTIONS.filter((entry) => sectionMatches(entry, q));

  useEffect(() => {
    const visible = SECTIONS.filter((entry) => sectionMatches(entry, q));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[min(720px,calc(100dvh-3rem))] w-full max-w-[1100px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            Settings
          </div>
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder="Search"
              aria-label="Search Settings"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              Nothing matches “{query.trim()}”
            </div>
          )}
          {visibleSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close Settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle="Shown in the sidebar. Saved as you go.">
                  <ProfileFields />
                </Card>
                <Card title="Skin" subtitle="Applies instantly and is remembered on this machine.">
                  <SkinPicker />
                </Card>
                <ConversationModeRow />
                <TerminologyRow />
                <Card title="Channel Turns" subtitle="Set one maximum duration for every bot turn in a channel.">
                  <RoomTurnTimeoutSettings />
                </Card>
                <ToolCallsRow />
                <ExperimentalFeaturesRow />
                <UpdatesRow />
                <UpdateNotificationsRow />
                <DiagnosticsRow />
                <AnalyticsRow />
              </>
            )}

            {section === "connections" && (
              <Card
                title="Connections"
                subtitle={"Connected apps use a connected-apps service when one is configured, or your own Composio project key.\u00a0 Other optional service keys stay on this computer."}
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Connected apps service is ready
                    </div>
                  ) : state.config?.composio.managedSetup?.status === "failed" ? (
                    <div role="status" className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[13px] text-warning">
                      {state.config.composio.managedSetup.message ?? "Connected apps could not be set up."}
                    </div>
                  ) : null}
                  <ElevenLabsConnection />
                  <TranscriptionSettings />
                  <ApiKeyRow section="box" />
                  <VpsConnection />
                  <ApiKeyRow section="opencodeGo" />
                  <ApiKeyRow section="deepseek" />
                  <QdrantRagConnection />
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Custom Webhook Domain / Ingress</summary>
                    <div className="mt-3">
                      <CustomIngressFields />
                    </div>
                  </details>
                  <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                    <summary className="cursor-pointer text-[13px] text-ink-secondary">Self-Host Connected Apps</summary>
                    <div className="mt-3">
                      <ApiKeyRow section="composio" />
                    </div>
                  </details>
                </div>
              </Card>
            )}

            {section === "remote" && <RemoteAccessSection />}

            {section === "engines" && (
              <Card title="Engine CLIs" subtitle="Which binary each engine runs. Saved as you go.">
                <EnginesSettings />
              </Card>
            )}

            {section === "models" && <FleetModelsSection />}

            {section === "companion" && <CompanionSection profileEmail={state.config?.profile?.email} />}

            {section === "computers" && (
              <>
                <BotComputerDefaults />
                <LocalComputerSection />
              </>
            )}

            {section === "usage" && <UsageSection />}

            {section === "observability" && <ObservabilitySection />}

            {section === "secrets" && <SecretsSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
