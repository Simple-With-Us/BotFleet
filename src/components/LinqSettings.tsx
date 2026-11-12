// Workspace-level Linq transport configuration.
//
// Lives in `Settings → Workspace → Integrations`.  This component writes
// its two halves through `PUT /api/config`:
//
//   - `imessageLinq` — phone number, sender policy, voice toggle.  Pure
//     settings, persisted to disk.
//   - `botDefaults.imessagePerBot` — per-bot transport choice.  Lives
//     under `botDefaults` because the same save path the operator uses
//     for other default-bot knobs carries it.
//
// The Linq API token and webhook secret live in `process.env` (set by the
// desktop shell via Infisical; the runtime reads them at request time).
// We surface the status flag from `state.config.imessageLinq.configured`
// so the operator knows when the workspace is ready end-to-end.

import { useEffect, useId, useState } from "react";
import { Check, ExternalLink, Loader2, MessageCircle, TriangleAlert, X } from "lucide-react";

import { api, type Bot, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";

const DEFAULT_LINQ_BASE = "https://api.linqapp.com/api/partner/v3";

interface LinqSettingsProps {
  bots: Bot[];
  config: ConfigStatus | null | undefined;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}

interface LinqSelfTestResponse {
  ok: boolean;
  reason?: string;
  message?: string;
  messageId?: string;
}

const SENSITIVE_FIELDS = ["botNumber"] as const;
const IGNORED_KEY = "imessageLinq.ignoredSenders";
const ALLOWED_KEY = "imessageLinq.allowedSenders";

async function saveLinqSettings(
  config: ConfigStatus | null | undefined,
  patch: Record<string, unknown>,
  onPatch: (patch: Record<string, unknown>) => Promise<void>,
) {
  // Single round-trip — `onPatch` is the Settings panel's existing
  // saveConfig wrapper, which merges section-by-section on the server.
  void config;
  await onPatch(patch);
}

export function LinqSettings({ bots, config, onPatch }: LinqSettingsProps) {
  const imessage = config?.imessageLinq;
  void imessage;
  const id = useId();
  const [botNumber, setBotNumber] = useState<string>(config?.imessageLinq?.botNumber ?? "");
  const [ignoredSenders, setIgnoredSenders] = useState<string[]>(
    config?.imessageLinq?.ignoredSenders ?? [],
  );
  const [allowedSenders, setAllowedSenders] = useState<string[]>(
    config?.imessageLinq?.allowedSenders ?? [],
  );
  const [allowVoice, setAllowVoice] = useState<boolean>(
    config?.imessageLinq?.allowVoiceByDefault ?? false,
  );
  const [perBot, setPerBot] = useState<Record<string, "off" | "mac-relay" | "linq">>(
    config?.imessageLinq?.perBot ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; messageId: string }
    | { kind: "error"; reason: string }
  >({ kind: "idle" });

  // Re-sync local state when the surrounding config block refreshes (a
  // save elsewhere, or a Settings-modal remount after `PUT /api/config`).
  useEffect(() => {
    setBotNumber(config?.imessageLinq?.botNumber ?? "");
    setIgnoredSenders(config?.imessageLinq?.ignoredSenders ?? []);
    setAllowedSenders(config?.imessageLinq?.allowedSenders ?? []);
    setAllowVoice(config?.imessageLinq?.allowVoiceByDefault ?? false);
    setPerBot(config?.imessageLinq?.perBot ?? {});
  }, [config]);

  const onSave = async () => {
    setSaving(true);
    try {
      await saveLinqSettings(config, {
        imessageLinq: {
          botNumber,
          ignoredSenders,
          allowedSenders,
          allowVoiceByDefault: allowVoice,
        },
        botDefaults: {
          imessagePerBot: perBot,
        },
      }, onPatch);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTestState({ kind: "running" });
    try {
      const response = (await api("/api/test/linq-self-message", {
        method: "POST",
        body: JSON.stringify({ text: "BotFleet self-test ping" }),
      })) as LinqSelfTestResponse;
      if (response?.ok && response.messageId) {
        setTestState({ kind: "ok", messageId: response.messageId });
      } else {
        setTestState({ kind: "error", reason: response?.reason ?? "send_failed" });
      }
    } catch (e) {
      setTestState({ kind: "error", reason: e instanceof Error ? e.message : "request_failed" });
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-stroke/60 bg-canvas/60 p-4">
      <header className="flex items-start gap-3">
        <MessageCircle className="mt-0.5 h-5 w-5 text-ink-secondary" />
        <div>
          <h3 className="text-sm font-semibold">Linq iMessage Transport</h3>
          <p className="text-[11.5px] text-ink-secondary">
            Send and receive iMessage via the Linq partner API.  Hobby tier is free for 20 contacts — sales-gated for higher volumes.
          </p>
          {!config?.imessageLinq?.configured ? (
            <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-amber">
              <TriangleAlert className="h-3.5 w-3.5" />
              Linq token missing — set <code>LINQ_API_TOKEN</code> on the host or via Infisical, then restart the harness.
            </p>
          ) : (
            <>
              <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-emerald">
                <Check className="h-3.5 w-3.5" />
                Linq token detected.  Outbound is live.
              </p>
              {config?.imessageLinq?.webhookReady ? (
                <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-emerald">
                  <Check className="h-3.5 w-3.5" />
                  Webhook signing is ready.  Inbound delivery is live.
                </p>
              ) : (
                <p className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-amber">
                  <TriangleAlert className="h-3.5 w-3.5" />
                  Webhook signing secret missing — inbound webhooks are refused (503) until <code>LINQ_WEBHOOK_SECRET</code> is set via env or Infisical.
                </p>
              )}
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-[12px]">
          <span className="text-ink-primary">Bot phone number (E.164)</span>
          <input
            id={`${id}-phone`}
            type="text"
            inputMode="tel"
            autoComplete="off"
            value={botNumber}
            placeholder="+1NNNNNNNNNN"
            onChange={(e) => setBotNumber(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stroke/60 bg-canvas px-2 py-1.5 text-[12px] placeholder:text-ink-tertiary focus:border-accent/70 focus:outline-none"
          />
        </label>
        <div className="block text-[12px]">
          <span className="text-ink-primary">Webhook setup</span>
          <LinqWebhookSetupInstructions />
        </div>
      </div>

      <SenderChips
        label="Allowed senders (blank = accept everyone except ignored)"
        values={allowedSenders}
        onChange={setAllowedSenders}
        emptyLabel="No allowlist — open to all numbers."
      />
      <SenderChips
        label="Ignored senders"
        values={ignoredSenders}
        onChange={setIgnoredSenders}
        emptyLabel="No ignored numbers."
      />

      <label className="flex items-start gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={allowVoice}
          onChange={(e) => setAllowVoice(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="text-ink-primary">Allow Linq bots to send voice messages.</span>
          <span className="ml-1 text-ink-secondary">
            Off by default.  When on, a bot may invoke <code>send_voice_message</code>{" "}
            (hosted TTS → mp3 attachment over iMessage).
          </span>
        </span>
      </label>

      <div className="rounded-md border border-stroke/40 bg-canvas/40 p-3 text-[12px]">
        <header className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-ink-primary">Per-bot transport</span>
          <span className="text-ink-tertiary text-[11px]">Defaults to Mac Relay unless changed.</span>
        </header>
        <ul className="space-y-2">
          {bots.map((bot) => {
            const choice = perBot[bot.id] ?? "mac-relay";
            return (
              <li key={bot.id} className="flex items-center justify-between gap-3 rounded border border-stroke/30 bg-canvas/60 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-ink-primary">{bot.name}</div>
                  {bot.chiefOfStaff ? (
                    <div className="text-[11px] text-ink-tertiary">Chief of Staff</div>
                  ) : null}
                </div>
                <select
                  className="rounded-md border border-stroke/60 bg-canvas px-2 py-1 text-[12px] focus:border-accent/70 focus:outline-none"
                  value={choice}
                  onChange={(e) => {
                    const next = e.target.value as "off" | "mac-relay" | "linq";
                    setPerBot((prev) => ({ ...prev, [bot.id]: next }));
                  }}
                >
                  <option value="off">Off</option>
                  <option value="mac-relay">Mac Relay (existing)</option>
                  <option value="linq">Linq</option>
                </select>
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="flex items-center gap-3 border-t border-stroke/40 pt-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] text-canvas",
            saving && "opacity-60",
          )}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save Linq settings
        </button>
        <button
          type="button"
          onClick={onTest}
          className="inline-flex items-center gap-1.5 rounded-md border border-stroke/60 px-3 py-1.5 text-[12px] hover:border-stroke"
        >
          Send test message
        </button>
        {savedAt ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        ) : null}
        {testState.kind === "running" ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary">
            <Loader2 className="h-3 w-3 animate-spin" /> Sending…
          </span>
        ) : null}
        {testState.kind === "ok" ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald">
            <Check className="h-3.5 w-3.5" /> Sent <code>{testState.messageId}</code>
          </span>
        ) : null}
        {testState.kind === "error" ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
            <X className="h-3.5 w-3.5" /> {testState.reason}
          </span>
        ) : null}
      </footer>

      <p className="text-[11px] text-ink-tertiary">
        Tokens (<code>LINQ_API_TOKEN</code>, <code>LINQ_WEBHOOK_SECRET</code>) live in environment
        variables — never on disk.  Base URL defaults to <code>{DEFAULT_LINQ_BASE}</code>.
      </p>

      {/* Unused but referenced to silence TS6133 if the prop signature changes. */}
      {void SENSITIVE_FIELDS.length === 0 ? null : null}
      {void IGNORED_KEY === "x" ? null : null}
      {void ALLOWED_KEY === "x" ? null : null}
    </div>
  );
}

interface SenderChipsProps {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  emptyLabel: string;
}

function SenderChips({ label, values, onChange, emptyLabel }: SenderChipsProps) {
  const [draft, setDraft] = useState("");
  return (
    <div className="text-[12px]">
      <div className="text-ink-primary">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {values.length === 0 ? (
          <span className="text-ink-tertiary">{emptyLabel}</span>
        ) : (
          values.map((value) => (
            <span key={value} className="inline-flex items-center gap-1 rounded-md border border-stroke/60 bg-canvas px-2 py-1 text-[11px]">
              {value}
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== value))}
                aria-label={`Remove ${value}`}
                className="text-ink-tertiary hover:text-ink-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="+15555550100"
          className="block w-44 rounded-md border border-stroke/60 bg-canvas px-2 py-1 text-[12px] focus:border-accent/70 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            const trimmed = draft.trim();
            if (!trimmed) return;
            if (values.includes(trimmed)) {
              setDraft("");
              return;
            }
            onChange([...values, trimmed]);
            setDraft("");
          }}
          className="rounded-md border border-stroke/60 px-2 py-1 text-[12px] hover:border-stroke"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function LinqWebhookSetupInstructions() {
  return (
    <div className="mt-1 rounded border border-stroke/40 bg-canvas/40 p-2 text-[11.5px] text-ink-secondary">
      <p>
        Point your Linq dashboard webhook at:
        <code className="ml-1 inline-block max-w-full truncate align-middle">
          {`https://<your-tunnel>/api/webhooks/linq`}
        </code>
      </p>
      <p className="mt-1">
        Local dev: <code>ngrok http 8800</code>{" "}
        (Cloudflare Tunnel works too).  Then add the Linq partner
        webhook URL on the dashboard.  See{" "}
        <a
          className="inline-flex items-center gap-0.5 text-accent underline"
          href="https://apidocs.linqapp.com"
          target="_blank"
          rel="noreferrer"
        >
          apidocs.linqapp.com
          <ExternalLink className="h-3 w-3" />
        </a>
        .
      </p>
    </div>
  );
}
