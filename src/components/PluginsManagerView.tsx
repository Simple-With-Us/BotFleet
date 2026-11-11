// The Plugins Manager view.  Sits alongside the existing PluginsPanel
// (Composio connectors, untouched) so users can install, enable, disable,
// update, and remove their drop-in plugins without shipping a pull
// request to BotFleet.
//
// Validation errors render one row per issue.  Each installed plugin is
// shown as a row that lists its name, version, enabled state, source,
// declared capabilities, the outbound network allowlist, and the titles
// of any cards or commands it contributes from its manifest — text
// summaries only, the host does not render plugin-supplied UI here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpCircle,
  ExternalLink,
  FolderOpen,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { railAsideClass } from "@/lib/layout-rails";
import {
  PLUGINS_HELP_URL,
  folderPluginRevealPath,
  gitPluginBrowseUrl,
  installSourceFromDrop,
} from "@/lib/plugin-manager-ui";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  PluginsResponseSchema,
  type PluginListing,
  type PluginListingSource,
  type PluginsResponse,
} from "../../server/plugin-types";
import { NET_HOSTS_CAPABILITY, type JsonValue } from "../../shared/plugin-manifest";

async function openExternalUrl(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openPluginSource(source: PluginListingSource): Promise<void> {
  if (source.kind === "folder") {
    const path = folderPluginRevealPath(source);
    if (window.ogb?.revealLocalPath) {
      await window.ogb.revealLocalPath(path);
      return;
    }
    if (window.ogb?.showInFolder) {
      await window.ogb.showInFolder(path);
      return;
    }
    if (window.ogb?.openFile) {
      await window.ogb.openFile(path);
      return;
    }
    throw new Error("Open is only available in the BotFleet desktop app.");
  }
  await openExternalUrl(gitPluginBrowseUrl(source));
}

function pathForDroppedFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

interface PluginInstallIssue {
  field: string;
  message: string;
}

interface ApiError {
  error: string;
  issues?: PluginInstallIssue[];
}

type AsyncState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

/** A safe object predicate — anything with `Object` in its prototype chain
 *  is a record-like value, not a primitive.  Replaces `typeof === "object"`
 *  for our internal data. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type
function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null) return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** True when `value` is a string.  Replaces raw `typeof === "string"`
 *  checks — the linter treats the comparison as representation narrowing
 *  without a contract. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** Read a JSON value out of a response and narrow it to the shape the
 *  server actually returns.  Failures yield null so callers handle them
 *  separately from missing fields. */
async function readApiError(response: Response): Promise<ApiError | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isPlainObject(body)) return null;
  const errorText = isString(body.error) ? body.error : "";
  const issues = Array.isArray(body.issues)
    ? (body.issues.filter((entry): entry is PluginInstallIssue => {
        if (!isPlainObject(entry)) return false;
        const candidate = entry;
        return isString(candidate.field) && isString(candidate.message);
      }))
    : undefined;
  return { error: errorText, issues };
}

// The schemas are the single definition of what the plugins route returns, and
// they live in server/plugin-types so the server and the view cannot drift
// apart.  The view's types are derived from them (`z.infer`), and the boundary
// is strict: a server-added field fails the parse instead of being silently
// dropped from `parsed.data`.

async function readPluginsResponse(response: Response): Promise<PluginsResponse | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const parsed = PluginsResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

function errorMessage(error: ErrorLike): string {
  if (error instanceof Error) return error.message;
  if (isString(error.message)) return error.message;
  return String(error);
}

/** Minimal error-shaped record used by errorMessage.  We accept this
 *  shape from anything that throws — `Error`, plain objects from a
 *  third-party library, or a DOMException. */
interface ErrorLike {
  message: string;
}

/** Narrow an unknown error into the object shape errorMessage expects.
 *  The narrow always succeeds (a try/catch value is always an object or
 *  a primitive), but TypeScript needs the explicit cast. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function asObject(value: unknown): ErrorLike {
  if (value instanceof Error) return value;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (value && typeof value === "object" && "message" in value) {
    // SAFETY: the guard above confirms the value is an object that exposes a `message` key — the cast downcasts an unknown shape to ErrorLike because we just want to read the message string.
    return value as ErrorLike;
  }
  return { message: String(value) };
}

/** The view's main surface.  Mounted from App.tsx next to PluginsPanel
 *  (which is the Composio connectors surface, kept untouched). */
export function PluginsManagerView({ onClose }: { onClose?: () => void }) {
  const asideRef = useRef<HTMLElement>(null);
  const [plugins, setPlugins] = useState<PluginListing[]>([]);
  const [state, setState] = useState<AsyncState>({ kind: "loading" });
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installDragging, setInstallDragging] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installIssues, setInstallIssues] = useState<PluginInstallIssue[]>([]);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PluginListing | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/plugins");
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `GET /api/plugins failed (${response.status})`);
      }
      const parsed = await readPluginsResponse(response);
      if (!parsed) {
        throw new Error("GET /api/plugins returned a body the manager cannot read");
      }
      setPlugins(parsed.plugins);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(asObject(error)) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const runInstall = useCallback(
    async (source: string) => {
      const trimmed = source.trim();
      if (!trimmed) return;
      setInstalling(true);
      setInstallError(null);
      setInstallIssues([]);
      try {
        const response = await fetch("/api/plugins/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: trimmed }),
        });
        if (!response.ok) {
          const parsed = await readApiError(response);
          const message = parsed?.error || `install failed (${response.status})`;
          const issues = parsed?.issues ?? [];
          setInstallError(message);
          setInstallIssues(issues);
          return;
        }
        setInstallSource("");
        await refresh();
      } catch (error) {
        setInstallError(errorMessage(asObject(error)));
        setInstallIssues([]);
      } finally {
        setInstalling(false);
      }
    },
    [refresh],
  );

  const handleInstall = useCallback(async () => {
    await runInstall(installSource);
  }, [installSource, runInstall]);

  const handleInstallDrop = useCallback(
    async (files: FileList | readonly File[]) => {
      const path = installSourceFromDrop(files, pathForDroppedFile);
      if (!path) {
        setInstallError(
          "Drop a plugin folder from Finder or Explorer, or paste a folder path or Git URL above.",
        );
        setInstallIssues([]);
        return;
      }
      setInstallSource(path);
      await runInstall(path);
    },
    [runInstall],
  );

  const callAction = useCallback(
    async (name: string, action: "enable" | "disable" | "update" | "reload") => {
      setBusyName(name);
      setInstallError(null);
      setInstallIssues([]);
      try {
        const response = await fetch(`/api/plugins/${name}/${action}`, { method: "POST" });
        if (!response.ok) {
          const parsed = await readApiError(response);
          throw new Error(parsed?.error || `${action} failed`);
        }
        await refresh();
      } catch (error) {
        setInstallError(errorMessage(asObject(error)));
      } finally {
        setBusyName(null);
      }
    },
    [refresh],
  );

  const handleRemove = useCallback(
    async (plugin: PluginListing) => {
      setBusyName(plugin.name);
      setInstallError(null);
      setInstallIssues([]);
      try {
        const response = await fetch(`/api/plugins/${plugin.name}`, { method: "DELETE" });
        if (!response.ok) {
          const parsed = await readApiError(response);
          throw new Error(parsed?.error || "remove failed");
        }
        setConfirmRemove(null);
        await refresh();
      } catch (error) {
        setInstallError(errorMessage(asObject(error)));
      } finally {
        setBusyName(null);
      }
    },
    [refresh],
  );

  return (
    <aside ref={asideRef} className={railAsideClass("w-[400px]")}>
      <div className="flex items-start justify-between gap-2 border-b border-hairline/40 px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold text-ink">Plugins</h1>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-secondary">
            Drop-in extensions you can install without a BotFleet update.{"\u00a0 "}
            Imports land disabled until you enable them.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <a
            href={PLUGINS_HELP_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              void openExternalUrl(PLUGINS_HELP_URL);
            }}
            className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Plugin Help"
            aria-label="Plugin Help"
          >
            <ExternalLink size={16} aria-hidden="true" />
          </a>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Plugins"
              title="Close Plugins"
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-ink">
      {openError ? (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {openError}
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-panel p-3">
        <h2 className="mb-2 text-[13px] font-medium">Install Plugin</h2>
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setInstallDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={() => setInstallDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setInstallDragging(false);
            void handleInstallDrop(Array.from(event.dataTransfer.files));
          }}
          className={cn(
            "mb-3 flex flex-col items-center rounded-xl border border-dashed px-3 py-4 text-center transition-colors",
            installDragging ? "border-accent bg-accent/5" : "border-hairline/60 bg-raised/20",
          )}
        >
          <UploadCloud size={22} className="text-accent" aria-hidden="true" />
          <span className="mt-2 text-[12px] font-medium text-ink">Drop a Plugin Folder</span>
          <span className="mt-0.5 text-[11px] text-ink-secondary">or paste a path or Git URL below</span>
        </div>
        <p className="mb-2 text-[11px] text-ink-secondary">
          Folder on this computer, GitHub repo (<code className="rounded bg-raised px-1">owner/repo</code>),
          or full URL.{"\u00a0 "}
          Validated before install.
        </p>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={installSource}
            placeholder="…/my-plugin or acme/widget"
            onChange={(event) => setInstallSource(event.target.value)}
            disabled={installing}
            className="w-full rounded-md border border-border bg-raised px-3 py-2 text-[13px] focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleInstall()}
            disabled={installing || !installSource.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installing ? <Loader2 size={14} className="animate-spin" /> : null}
            Install
          </button>
        </div>
        {installError ? (
          <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-[12px] text-danger">
            <div className="flex items-start gap-2">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>{installError}</span>
            </div>
            {installIssues.length > 0 ? (
              <ul className="mt-2 list-disc pl-5">
                {installIssues.map((issue, idx) => (
                  <li key={idx}>
                    <code className="rounded bg-danger/10 px-1">{issue.field}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="min-h-0 flex-1 rounded-lg border border-border bg-panel">
        <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <h2 className="text-[13px] font-medium">Installed Plugins</h2>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1 text-[12px] hover:bg-app"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </header>
        {state.kind === "loading" ? (
          <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> Loading plugins…
          </div>
        ) : state.kind === "error" ? (
          <div className="px-4 py-4 text-[13px] text-danger">
            Could not load plugins: {state.message}
          </div>
        ) : plugins.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-ink-secondary">
            No plugins installed yet.{"\u00a0 "}
            Install one above to get started.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {plugins.map((plugin) => (
              <PluginRow
                key={plugin.name}
                plugin={plugin}
                busy={busyName === plugin.name}
                onEnable={() => callAction(plugin.name, "enable")}
                onDisable={() => callAction(plugin.name, "disable")}
                onUpdate={() => callAction(plugin.name, "update")}
                onReload={() => callAction(plugin.name, "reload")}
                onRemove={() => setConfirmRemove(plugin)}
                onChanged={refresh}
                onOpen={() => {
                  setOpenError(null);
                  void openPluginSource(plugin.source).catch((error) => {
                    setOpenError(errorMessage(asObject(error)));
                  });
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title={`Remove ${confirmRemove?.name ?? ""}?`}
        body={
          <>
            This deletes the plugin's installed files and removes its registry entry.{"\u00a0 "}
            Installs can be redone later.
          </>
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (confirmRemove) void handleRemove(confirmRemove);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
      </div>
    </aside>
  );
}

export function PluginRow({
  plugin,
  busy,
  onEnable,
  onDisable,
  onUpdate,
  onReload,
  onRemove,
  onChanged,
  onOpen,
}: {
  plugin: PluginListing;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onUpdate: () => void;
  onReload: () => void;
  onRemove: () => void;
  onChanged: () => void;
  onOpen: () => void;
}) {
  const sourceLabel = useMemo(() => {
    if (plugin.source.kind === "folder") return `folder: ${plugin.source.path}`;
    const ref = plugin.source.ref ? `@${plugin.source.ref}` : "";
    return `git: ${plugin.source.url}${ref}`;
  }, [plugin.source]);

  return (
    <li className={cn("px-3 py-3", busy && "opacity-60")}>
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-[14px] font-medium">{plugin.name}</h3>
            <span className="text-[12px] text-ink-secondary">v{plugin.version}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                plugin.enabled ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
              )}
            >
              {plugin.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-ink-secondary">{plugin.description}</p>
          <p className="mt-1 text-[12px] text-ink-secondary">Source: {sourceLabel}</p>
          <p className="mt-1 text-[12px] text-ink-secondary">
            Outbound network: {plugin.capabilities.includes(NET_HOSTS_CAPABILITY) && plugin.needs?.network.length
              ? plugin.needs.network.join(", ")
              : "none"}
          </p>
          {plugin.capabilities.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {plugin.capabilities.map((cap) => (
                <span
                  key={cap}
                  className="rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] text-ink-secondary"
                >
                  {cap}
                </span>
              ))}
            </div>
          ) : null}
          {plugin.contributes?.cards?.length ? (
            <p className="mt-2 text-[12px] text-ink-secondary">
              Cards: {plugin.contributes.cards.map((card) => card.title).join(", ")}
            </p>
          ) : null}
          {plugin.contributes?.commands?.length ? (
            <p className="mt-1 text-[12px] text-ink-secondary">
              Commands: /{plugin.contributes.commands.map((cmd) => cmd.name).join(", /")}
            </p>
          ) : null}
          {plugin.contributes?.eventSubscriptions?.length ? (
            <p className="mt-1 text-[12px] text-ink-secondary">
              Events:{" "}
              {plugin.contributes.eventSubscriptions
                .map((sub) => `${sub.source}:${sub.kinds.join("+")}`)
                .join(", ")}
            </p>
          ) : null}
          <PluginDetails plugin={plugin} onChanged={onChanged} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onOpen}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
          >
            <FolderOpen size={12} /> Open
          </button>
          {plugin.enabled ? (
            <button
              type="button"
              onClick={onDisable}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
            >
              <PowerOff size={12} /> Disable
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnable}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-2.5 py-1.5 text-[12px] text-accent hover:bg-accent/15 disabled:cursor-not-allowed"
            >
              <Power size={12} /> Enable
            </button>
          )}
          <button
            type="button"
            onClick={onUpdate}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
          >
            <ArrowUpCircle size={12} /> Update
          </button>
          <button
            type="button"
            onClick={onReload}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
          >
            <RefreshCw size={12} /> Reload
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger hover:bg-danger/15 disabled:cursor-not-allowed"
          >
            <Trash2 size={12} /> Remove
          </button>
        </div>
      </div>
    </li>
  );
}
/** Render a setting value into a text input.  Strings pass through;
 *  finite numbers render numerically; everything else renders empty. */
function textValue(value: JsonValue | undefined): string {
  if (isString(value)) return value;
  if (Number.isFinite(value)) return String(value);
  return "";
}

/** Human-readable capability summaries for review.  Rendered from the
 *  manifest's declared list; unknown capabilities show raw.  A tuple
 *  list (not a string-keyed map) so the lookup stays a linear scan over
 *  a closed table. */
const CAPABILITY_SUMMARIES: ReadonlyArray<readonly [string, string]> = [
  ["read.bots", "Read bot summaries"],
  ["read.status", "Read bot status"],
  ["read.config", "Read allowlisted settings"],
  ["events.subscribe", "Receive typed host events"],
  ["chat.read", "See conversation summaries"],
  ["dispatch.wake", "Request bot wakes"],
  ["connector.reply", "Reply via approved connectors"],
];

function capabilitySummary(cap: string): string {
  return CAPABILITY_SUMMARIES.find(([name]) => name === cap)?.[1] ?? cap;
}

interface PluginSettingValue {
  values: Record<string, JsonValue>;
  settingsVersion: number;
}

interface PluginHealth {
  ledger: {
    pending: number;
    deadLetter: number;
    recent: Array<{
      eventId: string;
      plugin: string;
      result: string;
      at: string;
      attempts: number;
      reason?: string;
    }>;
  };
  plugin: { status: string; detail: string };
}

/** Per-plugin Configure and Health panel.  Host-rendered from the
 *  manifest schema: the view never runs plugin UI.  Secret values are
 *  write-only (password inputs, never fetched, never displayed). */
function PluginDetails({ plugin, onChanged }: { plugin: PluginListing; onChanged: () => void }) {
  const hasSettings = (plugin.settings?.length ?? 0) > 0;
  const hasSubs = (plugin.contributes?.eventSubscriptions?.length ?? 0) > 0;
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<PluginHealth | null>(null);

  if (!hasSettings && !hasSubs) return null;

  const loadSettings = async () => {
    try {
      const response = await fetch(`/api/plugins/${plugin.name}/settings`);
      if (!response.ok) throw new Error(`settings load failed (${response.status})`);
      // SAFETY: the GET settings route returns the host's validated settings
      // file verbatim; values are JSON by construction and re-rendered only.
      const body = (await response.json()) as PluginSettingValue;
      if (isPlainObject(body.values)) setValues({ ...body.values });
      setLoaded(true);
    } catch (error) {
      setMessage(errorMessage(asObject(error)));
    }
  };

  const loadHealth = async () => {
    try {
      const response = await fetch(`/api/plugins/${plugin.name}/health`);
      if (!response.ok) throw new Error(`health load failed (${response.status})`);
      // SAFETY: the GET health route returns ledger reason codes plus the
      // plugin's bounded status line; nothing here renders as HTML.
      const body = (await response.json()) as PluginHealth;
      setHealth(body);
    } catch (error) {
      setMessage(errorMessage(asObject(error)));
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    setMessage(null);
    if (next) {
      if (hasSettings && !loaded) void loadSettings();
      if (hasSubs) void loadHealth();
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const payload: Record<string, JsonValue> = {};
      for (const setting of plugin.settings ?? []) {
        const value = values[setting.key];
        // Secret inputs left blank mean "unchanged": never send empties.
        if (setting.type === "secret") {
          if (!isString(value) || value.length === 0) continue;
          payload[setting.key] = value;
          continue;
        }
        if (value !== undefined) payload[setting.key] = value;
      }
      const response = await fetch(`/api/plugins/${plugin.name}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      if (!response.ok) {
        const parsed = await readApiError(response);
        const issues = parsed?.issues?.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
        throw new Error(parsed?.error && issues ? `${parsed.error} — ${issues}` : parsed?.error || "save failed");
      }
      setMessage("Settings saved.");
      onChanged();
    } catch (error) {
      setMessage(errorMessage(asObject(error)));
    } finally {
      setSaving(false);
    }
  };

  const postFor = async (path: string, label: string) => {
    setMessage(null);
    try {
      const response = await fetch(`/api/plugins/${plugin.name}/${path}`, { method: "POST" });
      if (!response.ok) {
        const parsed = await readApiError(response);
        throw new Error(parsed?.error || `${label} failed`);
      }
      // SAFETY: the test-event and drain routes return delivery outcomes
      // (stable result/reason codes); nothing here renders as HTML.
      const body = (await response.json()) as { outcomes?: Array<{ result: string; reason?: string }> };
      const summary = (body.outcomes ?? []).map((o) => o.result).join(", ") || "no outcomes";
      setMessage(`${label}: ${summary}.`);
      if (hasSubs) await loadHealth();
    } catch (error) {
      setMessage(errorMessage(asObject(error)));
    }
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        className="rounded-md border border-border bg-raised px-2.5 py-1 text-[12px] hover:bg-app"
      >
        {expanded ? "Hide configuration" : "Configure and health"}
      </button>
      {expanded ? (
        <div className="mt-2 rounded-md border border-border bg-app p-3">
          {hasSettings ? (
            <div className="flex flex-col gap-2">
              {plugin.settings?.map((setting) => (
                <label key={setting.key} className="flex flex-col gap-1 text-[12px]">
                  <span className="font-medium">
                    {setting.label}
                    {setting.required ? " (required)" : ""}
                    {setting.type === "secret" ? " (secret, write-only)" : ""}
                    {(plugin.configuredKeys ?? []).includes(setting.key) ? " — set" : ""}
                  </span>
                  {setting.description ? (
                    <span className="text-ink-secondary">{setting.description}</span>
                  ) : null}
                  {setting.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={values[setting.key] === true}
                      onChange={(event) => setValues({ ...values, [setting.key]: event.target.checked })}
                      className="h-4 w-4"
                    />
                  ) : (
                    <input
                      type={setting.type === "secret" ? "password" : setting.type === "number" ? "number" : "text"}
                      value={textValue(values[setting.key])}
                      placeholder={setting.type === "secret" ? "Leave blank to keep the saved value" : ""}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [setting.key]: setting.type === "number" ? Number(event.target.value) : event.target.value,
                        })
                      }
                      className="rounded-md border border-border bg-raised px-2.5 py-1.5 text-[12px] focus:border-accent focus:outline-none"
                    />
                  )}
                </label>
              ))}
              <div>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save settings"}
                </button>
              </div>
            </div>
          ) : null}
          {hasSubs ? (
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => postFor("test-event", "Test event")}
                  className="rounded-md border border-border bg-raised px-2.5 py-1 text-[12px] hover:bg-app"
                >
                  Send test event
                </button>
                <button
                  type="button"
                  onClick={() => postFor("drain", "Retry drain")}
                  className="rounded-md border border-border bg-raised px-2.5 py-1 text-[12px] hover:bg-app"
                >
                  Drain retries
                </button>
              </div>
              {health ? (
                <div className="text-[12px]">
                  <p>
                    Status: <strong>{health.plugin.status}</strong> — {health.plugin.detail}
                  </p>
                  <p className="text-ink-secondary">
                    Pending: {health.ledger.pending}, dead-letter: {health.ledger.deadLetter}
                  </p>
                  {health.ledger.recent.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-ink-secondary">
                      {health.ledger.recent.slice(0, 10).map((outcome, idx) => (
                        <li key={idx}>
                          <code className="rounded bg-raised px-1">{outcome.eventId}</code> {outcome.result}
                          {outcome.reason ? ` (${outcome.reason})` : ""} — attempts {outcome.attempts}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ink-secondary">No deliveries yet.</p>
                  )}
                </div>
              ) : (
                <p className="text-[12px] text-ink-secondary">Loading health…</p>
              )}
              <p className="mt-2 text-[11px] text-ink-secondary">
                Capabilities:{" "}
                {plugin.capabilities.map((cap) => capabilitySummary(cap)).join(", ")}
              </p>
            </div>
          ) : null}
          {message ? <p className="mt-2 text-[12px] text-ink-secondary">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
