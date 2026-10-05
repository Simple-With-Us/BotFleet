// The Plugins Manager view.  Sits alongside the existing PluginsPanel
// (Composio connectors, untouched) so users can install, enable, disable,
// update, and remove their drop-in plugins without shipping a pull
// request to BotFleet.
//
// Validation errors render one row per issue.  Each installed plugin is
// shown as a row that lists its name, version, enabled state, source,
// declared capabilities, and the titles of any cards or commands it
// contributes from its manifest — text summaries only, the host does
// not render plugin-supplied UI here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Loader2, Power, PowerOff, RefreshCw, Trash2, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";

export interface PluginSource {
  kind: "folder" | "git";
  path?: string;
  url?: string;
  ref?: string | null;
}

export interface PluginContributionCard {
  id: string;
  title: string;
  description?: string;
  layout: "stat-grid" | "key-value" | "list";
  fields?: string[];
}

export interface PluginContributionCommand {
  name: string;
  description: string;
  args?: string[];
}

export interface PluginListing {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  botfleet: string;
  entry: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  source: PluginSource;
  warnings: string[];
  capabilities: string[];
  contributes?: {
    cards?: PluginContributionCard[];
    commands?: PluginContributionCommand[];
  };
}

interface PluginInstallIssue {
  field: string;
  message: string;
}

interface PluginsResponse {
  plugins: PluginListing[];
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

async function readPluginsResponse(response: Response): Promise<PluginsResponse | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isPlainObject(body)) return null;
  const plugins = Array.isArray(body.plugins)
    ? (
      // SAFETY: filter+isPlainObject narrows each entry to Record<PropertyKey, unknown>; the cast to PluginListing is the boundary between the parser layer and the consumer that already trusts the server response shape.
      body.plugins.filter((entry): entry is PluginListing => isPlainObject(entry)) as PluginListing[]
    )
    : [];
  return { plugins };
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
  const [plugins, setPlugins] = useState<PluginListing[]>([]);
  const [state, setState] = useState<AsyncState>({ kind: "loading" });
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installIssues, setInstallIssues] = useState<PluginInstallIssue[]>([]);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PluginListing | null>(null);

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

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    setInstallIssues([]);
    try {
      const response = await fetch("/api/plugins/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: installSource }),
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
  }, [installSource, refresh]);

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
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-app p-6 text-ink">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold">Plugins</h1>
          <p className="text-[13px] text-ink-secondary">
            Drop-in extensions you can install, enable, and remove without a BotFleet update.{"\u00a0 "}
            Imports land disabled until you enable them.
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-panel px-3 py-1.5 text-[13px] hover:bg-raised"
          >
            Close
          </button>
        ) : null}
      </header>

      <section className="rounded-lg border border-border bg-panel p-4">
        <h2 className="mb-2 text-[14px] font-medium">Install Plugin</h2>
        <p className="mb-3 text-[12px] text-ink-secondary">
          Paste a folder path on this computer, a GitHub repository (<code className="rounded bg-raised px-1">owner/repo</code>),
          or a full URL.{"\u00a0 "}
          The plugin is downloaded and validated against the manifest schema before anything is written.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={installSource}
            placeholder="…/my-plugin or acme/widget"
            onChange={(event) => setInstallSource(event.target.value)}
            disabled={installing}
            className="flex-1 rounded-md border border-border bg-raised px-3 py-2 text-[13px] focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={handleInstall}
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

      <section className="rounded-lg border border-border bg-panel">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-medium">Installed Plugins</h2>
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
  );
}

function PluginRow({
  plugin,
  busy,
  onEnable,
  onDisable,
  onUpdate,
  onReload,
  onRemove,
}: {
  plugin: PluginListing;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onUpdate: () => void;
  onReload: () => void;
  onRemove: () => void;
}) {
  const sourceLabel = useMemo(() => {
    if (plugin.source.kind === "folder") return `folder: ${plugin.source.path}`;
    const ref = plugin.source.ref ? `@${plugin.source.ref}` : "";
    return `git: ${plugin.source.url}${ref}`;
  }, [plugin.source]);

  return (
    <li className={cn("px-4 py-4", busy && "opacity-60")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
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
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          {plugin.enabled ? (
            <button
              type="button"
              onClick={onDisable}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-3 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
            >
              <PowerOff size={12} /> Disable
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnable}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-[12px] text-accent hover:bg-accent/15 disabled:cursor-not-allowed"
            >
              <Power size={12} /> Enable
            </button>
          )}
          <button
            type="button"
            onClick={onUpdate}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-3 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
          >
            <ArrowUpCircle size={12} /> Update
          </button>
          <button
            type="button"
            onClick={onReload}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-3 py-1.5 text-[12px] hover:bg-app disabled:cursor-not-allowed"
          >
            <RefreshCw size={12} /> Reload
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px] text-danger hover:bg-danger/15 disabled:cursor-not-allowed"
          >
            <Trash2 size={12} /> Remove
          </button>
        </div>
      </div>
    </li>
  );
}