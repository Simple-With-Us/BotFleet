// Paste-a-key rows. Packaged Electron saves secrets in the OS-backed store;
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values.
import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleHelp, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { api, useSecretSources, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { productErrorHeadline } from "@/lib/product-error";
import { SecretSourceBadge } from "./SecretSourceBadge";
import {
  applyEngineKeySave,
  apiKeyEngineSpec,
  engineKeyStatus,
  splitEngineKeySave,
  type ApiKeyEngineId,
} from "@/lib/engine-key-config";

export type ConfigSection = "composio" | "box" | "opencodeGo" | "deepseek";

/** `server/secret-map.ts`'s `SecretFieldSpec.id` for each key this panel
 * saves — the join key `useSecretSources()` returns rows by. */
const SECRET_FIELD_ID: Record<ConfigSection, string> = {
  composio: "composio.apiKey",
  box: "box.token",
  opencodeGo: "opencodeGo.apiKey",
  deepseek: "deepseek.key",
};

const SECTIONS: Record<
  ConfigSection,
  { body: (value: string) => unknown; flag: (config: ConfigStatus) => boolean }
> = {
  composio: {
    body: (v) => ({ composio: { apiKey: v } }),
    flag: (c) => c.composio.configured,
  },
  box: { body: (v) => ({ box: { token: v } }), flag: (c) => c.box.configured },
  opencodeGo: { body: (v) => ({ opencodeGo: { apiKey: v } }), flag: (c) => c.opencodeGo?.configured ?? false },
  // The deepseek key lives at the user level and is used only to fetch the
  // account balance for the engine row chip — never injected into any
  // engine's process environment, so a bot can run on Clutch
  // without this key set.
  deepseek: { body: (v) => ({ deepseek: { key: v } }), flag: (c) => c.deepseek?.configured ?? false },
};

const ELECTRON_CREDENTIAL: Record<ConfigSection, "composioApiKey" | "boxToken" | "opencodeGoApiKey" | "deepseekApiKey"> = {
  composio: "composioApiKey",
  box: "boxToken",
  opencodeGo: "opencodeGoApiKey",
  // No Electron credential key yet — for now the deepseek key rides through
  // PUT /api/config (the Vite dev path), which `cfg.deepseek.key` reads.
  // When the desktop shell grows a dedicated keychain entry, add the
  // matching name to the ogb.d.ts credential union at the same time.
  deepseek: "deepseekApiKey",
};

const CREDENTIALS: Record<
  ConfigSection,
  {
    label: string;
    placeholder: string;
    description: string;
    href: string;
    linkLabel: string;
    optional: boolean;
    warning?: string;
  }
> = {
  composio: {
    label: "Composio Project Key",
    placeholder: "ak_…",
    description: "Connect Gmail, GitHub, Slack, Notion, and other apps through your own Composio project.",
    href: "https://dashboard.composio.dev",
    linkLabel: "Create or copy a project key",
    optional: true,
  },
  box: {
    label: "Box API key",
    placeholder: "Paste your Box API key",
    description: "Give bots an isolated remote Linux computer with a desktop and terminal.",
    href: "https://docs.ascii.dev/box/api-keys",
    linkLabel: "Open Box API key guide",
    optional: true,
    warning: "Box is a paid service after its trial. Usage may incur charges.",
  },
  opencodeGo: {
    label: "OpenCode API key",
    placeholder: "Paste an OpenCode API key",
    description: "Optional. Existing OpenCode Zen, Go, and other provider connections are detected automatically.",
    href: "https://opencode.ai/docs/providers/",
    linkLabel: "Open the OpenCode provider guide",
    optional: true,
  },
  deepseek: {
    label: "DeepSeek API key (balance display only)",
    placeholder: "sk-…",
    description: "Used only to display your account balance under the DeepSeek engine row. Never sent to the engine itself, so the harness works without it.",
    href: "https://platform.deepseek.com/api_keys",
    linkLabel: "Open the DeepSeek API key page",
    optional: true,
  },
};

function CredentialHelp({ section }: { section: ConfigSection }) {
  const credential = CREDENTIALS[section];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${credential.label}`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className="flex size-6 items-center justify-center rounded-md text-ink-secondary outline-none transition-colors hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={popoverId}
          role="group"
          aria-label={`${credential.label} help`}
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[270px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[12px] leading-[1.45] text-ink-secondary">{credential.description}</div>
          {credential.warning && (
            <div className="mt-2 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>{credential.warning}</span>
            </div>
          )}
          <a
            href={credential.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {credential.linkLabel}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}

export function ApiKeyRow({
  section,
  onSaved,
}: {
  section: ConfigSection;
  /** Called after a successful save with the section's new configured flag. */
  onSaved?: (configured: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = state.config ? SECTIONS[section].flag(state.config) : false;
  const clearing = !value.trim() && configured;
  const credential = CREDENTIALS[section];

  const secretSources = useSecretSources();
  const provenance = secretSources.get(SECRET_FIELD_ID[section]);
  const managed = provenance?.managed ?? false;
  const infisicalConfigured = Boolean(state.config?.infisical?.configured);
  const writeThrough = Boolean(state.config?.infisical?.writeThrough);
  // A 409 the operator cannot explain is the failure this prevents: with
  // Write Through off, Infisical is the only place this key can change, so
  // the field disables outright rather than letting a save fail silently
  // confusing.  With Write Through on the field stays editable — a save
  // there writes the vault first, then tombstones the local copy.
  const locked = managed && !writeThrough;

  const save = () => {
    if (locked || saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential(ELECTRON_CREDENTIAL[section], value.trim())
      : api("/api/config", {
          method: "PUT",
          body: JSON.stringify(SECTIONS[section].body(value.trim())),
        });
    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setValue("");
        onSaved?.(SECTIONS[section].flag(status));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{credential.label}</span>
        {credential.optional && (
          <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
            Optional
          </span>
        )}
        {configured && <span className="text-[11px] text-success">Connected</span>}
        <SecretSourceBadge
          source={provenance?.source}
          elsewhere={provenance?.elsewhere}
          infisicalConfigured={infisicalConfigured}
        />
        <CredentialHelp section={section} />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={locked ? "Managed by Infisical." : configured ? "••••••••  (paste to replace)" : credential.placeholder}
          aria-label={credential.label}
          autoComplete="off"
          disabled={locked}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          onClick={save}
          disabled={locked || saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing
              ? "bg-control text-danger hover:bg-raised-hover"
              : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={locked ? "Managed by Infisical." : clearing ? "Remove the Saved Key" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {locked && <div className="mt-1 text-[12px] text-ink-secondary">Managed by Infisical.</div>}
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** Non-secret Docker-over-SSH target. Keys and passwords stay with SSH. */
export function VpsConnection() {
  const { state, dispatch } = useStore();
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(state.config?.vps?.configured);

  useEffect(() => {
    setAlias(state.config?.vps?.sshAlias ?? "");
  }, [state.config?.vps?.sshAlias]);

  const save = () => {
    if (saving || (!alias.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ vps: { sshAlias: alias.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setAlias(status.vps?.sshAlias ?? "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>Self-hosted VPS</span>
        <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          Optional
        </span>
        {configured && <span className="text-[11px] text-success">Connected</span>}
      </div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">
        SSH config alias for the Linux VPS. BotFleet uses your normal SSH config and agent; it does not store keys or passwords.{" "}
        See the{" "}
        <a
          href="https://github.com/jaywedgeworth22/BotFleet/blob/main/docs/byo-vps.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          setup guide
        </a>{" "}
        for the required SSH alias shape.
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="my-vps"
          aria-label="Self-Hosted VPS SSH Config Alias"
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || (!alias.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            !alias.trim() && configured ? "bg-control text-danger hover:bg-raised-hover" : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={!alias.trim() && configured ? "Remove the Saved Alias" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && configured ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** A row for an engine that is configured with an endpoint AND a key rather
 * than a CLI login — the `install.apiKeyOnly` drivers, OpenAI-compatible and
 * MiniMax.  A sibling of ApiKeyRow rather than a `ConfigSection` of it: the
 * fixed rows above carry exactly one secret, and `credential:set` can only
 * carry one string, so the endpoint has to travel separately.  Which half
 * goes where is decided by `splitEngineKeySave` in src/lib/engine-key-config.ts,
 * where it is unit-tested. */
export function EngineKeyRow({ engine: engineId }: { engine: ApiKeyEngineId }) {
  const { state, dispatch } = useStore();
  const engine = apiKeyEngineSpec(engineId);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const status = state.config?.[engineId];
  const savedUrl = status?.url ?? "";
  // The endpoint is not a secret, so unlike the key it IS echoed back and the
  // field shows what is in effect.  Re-seeded whenever the saved value
  // changes — another window, or this row's own save — but never while the
  // operator is mid-edit, which is what the untouched ref guards.
  const untouched = useRef(true);
  useEffect(() => {
    if (untouched.current) setUrl(savedUrl);
  }, [savedUrl]);

  const secretSources = useSecretSources();
  const keyProvenance = secretSources.get(engine.keyFieldId);
  const urlProvenance = secretSources.get(engine.urlFieldId);
  const infisicalConfigured = Boolean(state.config?.infisical?.configured);
  const writeThrough = Boolean(state.config?.infisical?.writeThrough);
  // Same rule as ApiKeyRow: with Write Through off, the vault is the only
  // place a managed value can change, so the field disables rather than
  // letting a save fail in a way the operator cannot explain.
  const keyLocked = (keyProvenance?.managed ?? false) && !writeThrough;
  const urlLocked = (urlProvenance?.managed ?? false) && !writeThrough;

  const keyState = engineKeyStatus(status);
  const hasSavedKey = Boolean(status?.configured || status?.pending);
  // Clearing is its own button, never a mode Save falls into.  Inferring it
  // from an empty field was a data-loss bug: the field is blank on every
  // visit (a key is never echoed back), so editing only the endpoint and
  // pressing Save deleted the saved key.  A locked key cannot be cleared
  // from here at all — the vault is the only place it can change.
  const canClear = hasSavedKey && !keyLocked;
  const urlChanged = url.trim() !== savedUrl.trim();
  const nothingToSave = !key.trim() && !urlChanged;

  const commit = (clear: boolean) => {
    if (saving) return;
    const split = splitEngineKeySave({
      engine,
      key,
      url: clear ? savedUrl : url,
      savedUrl,
      hasBridge: Boolean(window.ogb?.setCredential),
      clear,
    });
    if (!split.ok) {
      setError(split.error);
      return;
    }
    setSaving(true);
    setError(null);
    // Ordering, and what a half-applied save reports, live in
    // applyEngineKeySave — see its own note on why the key half goes first.
    void applyEngineKeySave(split.save, {
      patchConfig: (patch) => api("/api/config", { method: "PUT", body: JSON.stringify(patch) }),
      setCredential: (name, value) => window.ogb!.setCredential!(name, value),
    })
      .then((outcome) => {
        if (!outcome.ok) {
          setError(outcome.error);
          // The key really did land, so the field must not keep offering it
          // for a retry that would send it a second time.
          if (outcome.keySaved) setKey("");
          return;
        }
        if (outcome.status) dispatch({ type: "configStatus", config: outcome.status as ConfigStatus });
        setKey("");
        untouched.current = true;
      })
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (nothingToSave) return;
    commit(false);
  };

  const clear = () => {
    if (!canClear) return;
    setConfirmClear(true);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span
          className={cn(
            "size-1.5 rounded-full",
            keyState.tone === "ok" ? "bg-success" : keyState.tone === "waiting" ? "bg-warning" : "bg-raised-hover",
          )}
        />
        <span>{engine.label} API key</span>
        <span
          className={cn(
            "text-[11px]",
            keyState.tone === "ok" ? "text-success" : keyState.tone === "waiting" ? "text-warning" : "text-ink-secondary",
          )}
        >
          {keyState.label}
        </span>
        <SecretSourceBadge
          source={keyProvenance?.source}
          elsewhere={keyProvenance?.elsewhere}
          infisicalConfigured={infisicalConfigured}
          className="ml-auto"
        />
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={
            keyLocked
              ? "Managed by Infisical."
              : status?.configured
                ? "••••••••  (paste to replace)"
                : engine.keyPlaceholder
          }
          aria-label={`${engine.label} API key`}
          autoComplete="off"
          disabled={keyLocked}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          onClick={save}
          disabled={saving || nothingToSave}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title="Save"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
        </button>
        {canClear && (
          <button
            onClick={clear}
            disabled={saving}
            className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-danger hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            title="Remove the Saved Key"
          >
            Clear
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
        <span>Endpoint</span>
        <SecretSourceBadge
          source={urlProvenance?.source}
          elsewhere={urlProvenance?.elsewhere}
          infisicalConfigured={infisicalConfigured}
          className="ml-auto"
        />
      </div>
      <input
        type="text"
        value={url}
        onChange={(e) => {
          untouched.current = false;
          setUrl(e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && save()}
        placeholder={urlLocked ? "Managed by Infisical." : engine.urlPlaceholder}
        aria-label={`${engine.label} endpoint`}
        autoComplete="off"
        disabled={urlLocked}
        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">
        {engine.defaultUrlNote}{" "}
        <a
          href={engine.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
        >
          Get a key
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      </div>
      {error && <div className="mt-1 text-[12px] text-danger" title={error}>{productErrorHeadline(error)}</div>}
      <ConfirmDialog
        open={confirmClear}
        title="Remove Saved Key?"
        body={`Remove the saved ${engine.label} API key?  BotFleet will stop using it on this computer.`}
        confirmLabel="Remove Key"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          commit(true);
        }}
      />
    </div>
  );
}
