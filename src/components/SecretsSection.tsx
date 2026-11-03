// App settings → Secrets: optional Infisical authentication, scoped token
// routes, and the source of each mapped app credential.
import * as React from "react";
import { Check, CheckCircle, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, fetchSecrets, useStore, type ConfigStatus, type InfisicalStatusPayload } from "@/state/store";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";
import { SecretSourceBadge } from "./SecretSourceBadge";
import {
  buildInfisicalConfigPatch,
  infisicalStatusLabel,
  infisicalSwitchDefault,
  saveInfisicalSettings,
  sourceDraftsFromStatus,
  splitInfisicalPatch,
  type InfisicalSourceDraft,
} from "@/lib/secret-source";

const secretsInputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

const emptySource = (): InfisicalSourceDraft => ({
  name: "",
  projectId: "",
  environment: "prod",
  secretPath: "/",
  readSourceType: "env",
  readSource: "",
  writeSourceType: "env",
  writeSource: "",
});

export function SecretsSection() {
  const { state, dispatch } = useStore();
  const infisicalConfig = state.config?.infisical;

  const [status, setStatus] = React.useState<InfisicalStatusPayload | null>(null);
  const [statusFetchError, setStatusFetchError] = React.useState<string | null>(null);

  // The raw saved toggle survives even when no credential is configured.
  // `infisicalSwitchDefault` keeps older-server behavior compatible.
  const [enabled, setEnabled] = React.useState(infisicalSwitchDefault(infisicalConfig));
  const [writeThrough, setWriteThrough] = React.useState(infisicalConfig?.writeThrough ?? false);
  const [authMethod, setAuthMethod] = React.useState<"service-token" | "machine-identity">(
    infisicalConfig?.authMethod ?? "service-token",
  );
  const [siteUrl, setSiteUrl] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [environment, setEnvironment] = React.useState(infisicalConfig?.environment ?? "");
  const [secretPath, setSecretPath] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [token, setToken] = React.useState("");
  const [writeToken, setWriteToken] = React.useState("");
  const [readSources, setReadSources] = React.useState<InfisicalSourceDraft[]>([]);
  const [readSourcesLoaded, setReadSourcesLoaded] = React.useState(false);
  const [refreshMinutes, setRefreshMinutes] = React.useState(15);

  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveOk, setSaveOk] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error: string | null; secretCount?: number } | null>(null);
  const [syncing, setSyncing] = React.useState(false);

  React.useEffect(() => {
    // Same reason as the seed above: an unconfigured install's `false` is the
    // absence of a store, not an operator's decision, so it must not drive
    // this switch back off under them while they are filling the form in.
    if (infisicalConfig?.configured && infisicalConfig.enabled !== undefined) {
      setEnabled(infisicalConfig.enabled);
    }
  }, [infisicalConfig?.configured, infisicalConfig?.enabled]);
  React.useEffect(() => {
    if (infisicalConfig?.writeThrough !== undefined) setWriteThrough(infisicalConfig.writeThrough);
  }, [infisicalConfig?.writeThrough]);
  React.useEffect(() => {
    if (infisicalConfig?.authMethod) setAuthMethod(infisicalConfig.authMethod);
  }, [infisicalConfig?.authMethod]);
  React.useEffect(() => {
    if (infisicalConfig?.environment !== undefined) setEnvironment(infisicalConfig.environment);
  }, [infisicalConfig?.environment]);

  const vault = status?.infisical ?? null;

  React.useEffect(() => {
    if (vault?.siteUrl !== undefined && vault.siteUrl !== null) setSiteUrl(vault.siteUrl);
  }, [vault?.siteUrl]);
  React.useEffect(() => {
    if (vault?.projectId !== undefined && vault.projectId !== null) setProjectId(vault.projectId);
  }, [vault?.projectId]);
  React.useEffect(() => {
    if (vault?.secretPath !== undefined) setSecretPath(vault.secretPath);
  }, [vault?.secretPath]);
  React.useEffect(() => {
    if (vault?.refreshMinutes !== undefined) setRefreshMinutes(vault.refreshMinutes);
  }, [vault?.refreshMinutes]);
  React.useEffect(() => {
    if (vault?.enabledSetting === true || vault?.enabledSetting === false) setEnabled(vault.enabledSetting);
  }, [vault?.enabledSetting]);
  React.useEffect(() => {
    if (vault?.authMethod) setAuthMethod(vault.authMethod);
    if (vault?.readSources) {
      setReadSources(sourceDraftsFromStatus(vault.readSources));
      setReadSourcesLoaded(true);
    }
  }, [vault?.authMethod, vault?.readSources]);

  const refreshStatus = React.useCallback(async () => {
    try {
      const data = await fetchSecrets();
      setStatus(data);
      if (data.infisical.enabledSetting === true || data.infisical.enabledSetting === false) setEnabled(data.infisical.enabledSetting);
      setStatusFetchError(null);
    } catch (caught) {
      // A window without loopback access (or a very old harness) sees this
      // card sit on "Waiting" for good — the same honest failure mode
      // ObservabilitySection uses for its own status fetch.
      setStatusFetchError(caught instanceof Error ? caught.message : "Failed to fetch secret status");
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const pill = infisicalStatusLabel(vault, statusFetchError);

  const save = async (): Promise<boolean> => {
    const built = buildInfisicalConfigPatch({
      enabled,
      writeThrough,
      authMethod,
      siteUrl,
      projectId,
      environment,
      secretPath,
      clientId,
      clientSecret,
      token,
      writeToken,
      readSources: readSourcesLoaded ? readSources : undefined,
      refreshMinutes,
    });
    if (!built.ok) {
      setSaveError(built.error);
      setSaveOk(false);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      // Credential writes trigger a server reload, so stage the requested
      // destination with reads disabled before updating the encrypted store.
      const split = splitInfisicalPatch(built.patch, Boolean(window.ogb?.setCredential));
      if ("error" in split) {
        setSaveError(split.error);
        setSaveOk(false);
        return false;
      }
      const config = await saveInfisicalSettings<ConfigStatus>(
        split,
        (patch) => api("/api/config", {
          method: "PATCH",
          body: JSON.stringify({ infisical: patch }),
        }),
        async (name, value) => { await window.ogb!.setCredential!(name, value); },
      );
      dispatch({ type: "configStatus", config });
      if (built.patch.clientId) setClientId("");
      if (built.patch.clientSecret) setClientSecret("");
      if (built.patch.token) setToken("");
      if (built.patch.writeToken) setWriteToken("");
      await refreshStatus();
      setSaveOk(true);
      return true;
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await save();
      if (!saved) {
        setTestResult({ ok: false, error: "Fix the settings above before testing." });
        return;
      }
      const result = await api("/api/infisical/test", { method: "POST" });
      setTestResult({
        ok: Boolean(result.ok),
        error: result.ok ? null : (result.error || "Infisical did not accept the selected authentication method."),
        secretCount: result.secretCount,
      });
      await refreshStatus();
    } catch (caught) {
      setTestResult({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setSaveError(null);
    try {
      const data: InfisicalStatusPayload = await api("/api/infisical/sync", { method: "POST" });
      setStatus(data);
      if (data.infisical.enabledSetting === true || data.infisical.enabledSetting === false) setEnabled(data.infisical.enabledSetting);
      setStatusFetchError(null);
      // The sync route deliberately does not broadcast a config frame (other
      // open windows pick up fresh counts on their next fetch), so this
      // window re-reads /api/config itself rather than showing a stale
      // managedCount / lastSyncAt in the rest of the app until something
      // unrelated happens to trigger a broadcast.
      const config: ConfigStatus = await api("/api/config");
      dispatch({ type: "configStatus", config });
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncing(false);
    }
  };

  const testProjectId = projectId.trim() || vault?.projectId || "";
  const testEnvironment = environment.trim() || vault?.environment || "prod";
  const testPath = secretPath.trim() || vault?.secretPath || "/";
  const hasScopedReadSource = readSources.some((source) =>
    source.projectId.trim() === testProjectId &&
    source.environment.trim() === testEnvironment &&
    source.secretPath.trim().replace(/\/$/, "") === testPath.replace(/\/$/, "") &&
    Boolean(source.readSource.trim()),
  ) || Boolean(vault?.readSources?.some((source) =>
    source.projectId === testProjectId && source.environment === testEnvironment &&
    source.secretPath.replace(/\/$/, "") === testPath.replace(/\/$/, "") && source.hasReadToken,
  ));
  const canTest = enabled && Boolean(testProjectId) && (authMethod === "machine-identity"
    ? Boolean((clientId.trim() || vault?.hasClientId) && (clientSecret.trim() || vault?.hasClientSecret))
    : Boolean(token.trim() || vault?.hasToken || hasScopedReadSource));

  const updateSource = (index: number, patch: Partial<InfisicalSourceDraft>) => {
    setReadSources((current) => current.map((source, row) => row === index ? { ...source, ...patch } : source));
    setSaveOk(false);
  };

  const fields = status?.fields ?? [];
  const unusedNames = vault?.unusedVaultNames ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Secret Store"
        subtitle={"Point BotFleet at an Infisical project and it becomes the source of truth for every credential it holds — before the environment, before the value saved on this computer.\u00A0 Leave Infisical off and nothing changes."}
      >
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center justify-between rounded-xl border border-hairline/30 bg-inset/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span
                className={`flex size-2 rounded-full ${
                  pill.tone === "error"
                    ? "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    : pill.tone === "active"
                      ? "bg-success shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse"
                      : pill.tone === "waiting"
                        ? "bg-warning"
                        : "bg-ink-secondary/40"
                }`}
              />
              <span className="font-medium text-ink">Infisical</span>
            </div>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                pill.tone === "error"
                  ? "bg-danger/15 text-danger"
                  : pill.tone === "active"
                    ? "bg-success/15 text-success"
                    : "bg-inset text-ink-secondary"
              }`}
              title={statusFetchError || vault?.lastError || undefined}
            >
              {pill.label}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Environment</span>
              <span className="font-medium text-ink">{vault?.environment || "prod"}</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Path</span>
              <span className="font-medium text-ink">{vault?.secretPath || "/"}</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Last sync</span>
              <span className="font-medium text-ink">{vault?.lastSyncAt ? new Date(vault.lastSyncAt).toLocaleString() : "Never"}</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Secrets in vault</span>
              <span className="font-medium text-ink">{vault?.vaultCount ?? 0}</span>
            </div>
          </div>

          {vault?.pendingProviderReload && (
            <div className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              Changed keys apply after Sync Now.
            </div>
          )}

          <div className="flex flex-col gap-3 rounded-xl border border-hairline/30 bg-inset/20 p-3">
            <fieldset className="flex flex-col gap-2 border-b border-hairline/30 pb-3">
              <legend className="pb-1 text-[12px] font-medium text-ink-secondary">Authentication Method</legend>
              <label className="flex items-start gap-2 rounded-lg border border-hairline/30 bg-inset/40 px-3 py-2.5">
                <input
                  type="radio"
                  name="infisical-auth-method"
                  value="service-token"
                  checked={authMethod === "service-token"}
                  onChange={() => {
                    setAuthMethod("service-token");
                    setClientId("");
                    setClientSecret("");
                    setSaveOk(false);
                  }}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="block text-[13px] text-ink">Service Tokens</span>
                  <span className="block text-[11.5px] leading-relaxed text-ink-secondary">Use read and write tokens scoped to the project and folder they need.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-lg border border-hairline/30 bg-inset/40 px-3 py-2.5">
                <input
                  type="radio"
                  name="infisical-auth-method"
                  value="machine-identity"
                  checked={authMethod === "machine-identity"}
                  onChange={() => {
                    setAuthMethod("machine-identity");
                    setToken("");
                    setWriteToken("");
                    setSaveOk(false);
                  }}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="block text-[13px] text-ink">Machine Identity</span>
                  <span className="block text-[11.5px] leading-relaxed text-ink-secondary">Use this installation’s Universal Auth identity.{ '\u00A0'} BotFleet will not switch methods automatically.</span>
                </span>
              </label>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-site-url">
                  Site URL
                </label>
                <input
                  id="infisical-site-url"
                  type="url"
                  value={siteUrl}
                  onChange={(e) => {
                    setSiteUrl(e.target.value);
                    setSaveOk(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                  placeholder="https://app.infisical.com"
                  autoComplete="off"
                  className={secretsInputClass}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-project-id">
                  Project ID
                </label>
                <input
                  id="infisical-project-id"
                  type="text"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setSaveOk(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  autoComplete="off"
                  className={secretsInputClass}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-environment">
                  Environment
                </label>
                <input
                  id="infisical-environment"
                  type="text"
                  value={environment}
                  onChange={(e) => {
                    setEnvironment(e.target.value);
                    setSaveOk(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                  placeholder="prod"
                  autoComplete="off"
                  className={secretsInputClass}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-secret-path">
                  Secret Path
                </label>
                <input
                  id="infisical-secret-path"
                  type="text"
                  value={secretPath}
                  onChange={(e) => {
                    setSecretPath(e.target.value);
                    setSaveOk(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                  placeholder="/"
                  autoComplete="off"
                  className={secretsInputClass}
                />
              </div>
              {authMethod === "machine-identity" ? (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-client-id">
                      Client ID
                    </label>
                    <input
                      id="infisical-client-id"
                      type="text"
                      value={clientId}
                      onChange={(e) => {
                        setClientId(e.target.value);
                        setSaveOk(false);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && void save()}
                      placeholder={vault?.hasClientId ? "Saved (paste to replace)" : "Machine identity client ID"}
                      autoComplete="off"
                      className={secretsInputClass}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-client-secret">
                      Client Secret
                    </label>
                    <input
                      id="infisical-client-secret"
                      type="password"
                      value={clientSecret}
                      onChange={(e) => {
                        setClientSecret(e.target.value);
                        setSaveOk(false);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && void save()}
                      placeholder={vault?.hasClientSecret ? "Saved (paste to replace)" : "Machine identity client secret"}
                      autoComplete="new-password"
                      className={secretsInputClass}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-read-token">
                      Primary Read Token
                    </label>
                    <input
                      id="infisical-read-token"
                      type="password"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value);
                        setSaveOk(false);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && void save()}
                      placeholder={vault?.hasToken ? "Saved (paste to replace)" : "Infisical read-only service token"}
                      autoComplete="new-password"
                      className={secretsInputClass}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-write-token">
                      Primary Write Token
                    </label>
                    <input
                      id="infisical-write-token"
                      type="password"
                      value={writeToken}
                      onChange={(e) => {
                        setWriteToken(e.target.value);
                        setSaveOk(false);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && void save()}
                      placeholder={vault?.hasWriteToken ? "Saved (paste to replace)" : "Infisical write token, if needed"}
                      autoComplete="new-password"
                      className={secretsInputClass}
                    />
                  </div>
                </>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="infisical-refresh-minutes">
                  Refresh Minutes
                </label>
                <input
                  id="infisical-refresh-minutes"
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={refreshMinutes}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setRefreshMinutes(Number.isFinite(next) ? next : 15);
                    setSaveOk(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && void save()}
                  className={secretsInputClass}
                />
              </div>
            </div>

            {authMethod === "service-token" && (
              <section className="flex flex-col gap-3 rounded-lg border border-hairline/30 bg-inset/30 p-3" aria-labelledby="infisical-scoped-sources-heading">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 id="infisical-scoped-sources-heading" className="text-[12px] font-medium text-ink">Additional Project and Folder Tokens</h3>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">Each row names an exact project, environment, and folder scope. Add read and write token locations separately; token values stay in environment variables or owner-only files.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setReadSources((current) => [...current, { ...emptySource(), projectId: projectId.trim(), environment: environment.trim() || "prod" }]);
                      setReadSourcesLoaded(true);
                      setSaveOk(false);
                    }}
                    className="shrink-0 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12px] text-ink hover:bg-control"
                  >
                    Add Source
                  </button>
                </div>
                {readSources.length === 0 && <p className="text-[11px] text-ink-secondary">No additional token sources.</p>}
                {readSources.map((source, index) => {
                  const sourceStatus = vault?.readSources?.find((entry) => entry.name === source.name);
                  return (
                    <div key={source.name || `source-${index}`} className="flex flex-col gap-3 rounded-lg border border-hairline/30 bg-inset/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] font-medium text-ink">Source {index + 1}</span>
                        <div className="flex items-center gap-3">
                          {sourceStatus && <span className={cn("text-[11px]", sourceStatus.error ? "text-danger" : "text-ink-secondary")} title={sourceStatus.error || undefined}>{sourceStatus.error || [sourceStatus.hasReadToken ? "Read configured" : "Read missing", sourceStatus.hasWriteToken ? "Write configured" : "Write missing"].join(" · ")}</span>}
                          <button
                            type="button"
                            onClick={() => {
                              setReadSources((current) => current.filter((_, row) => row !== index));
                              setSaveOk(false);
                            }}
                            className="rounded px-2 py-1 text-[11px] text-ink-secondary hover:bg-control hover:text-ink"
                            aria-label={`Remove source ${index + 1}`}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-secondary">
                          Source Name
                          <input value={source.name} onChange={(e) => updateSource(index, { name: e.target.value })} placeholder="fleet-ops-cli-logins" autoComplete="off" className={secretsInputClass} />
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-secondary">
                          Project ID
                          <input value={source.projectId} onChange={(e) => updateSource(index, { projectId: e.target.value })} placeholder="Project ID" autoComplete="off" className={secretsInputClass} />
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-secondary">
                          Environment
                          <input value={source.environment} onChange={(e) => updateSource(index, { environment: e.target.value })} placeholder="prod" autoComplete="off" className={secretsInputClass} />
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-secondary">
                          Folder
                          <input value={source.secretPath} onChange={(e) => updateSource(index, { secretPath: e.target.value })} placeholder="/folder" autoComplete="off" className={secretsInputClass} />
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-secondary">
                          Read Token Source
                          <div className="flex gap-2">
                            <select aria-label={`Read token source type ${index + 1}`} value={source.readSourceType} onChange={(e) => {
                              const value = e.target.value;
                              if (value === "env" || value === "file") updateSource(index, { readSourceType: value });
                            }} className={cn(secretsInputClass, "w-[132px] shrink-0")}>
                              <option value="env">Environment</option>
                              <option value="file">File Path</option>
                            </select>
                            <input aria-label={`Read token source locator ${index + 1}`} value={source.readSource} onChange={(e) => updateSource(index, { readSource: e.target.value })} placeholder={source.readSourceType === "env" ? "INFISICAL_READ_TOKEN" : "/absolute/path/read-token"} autoComplete="off" className={cn(secretsInputClass, "min-w-0 flex-1")} />
                          </div>
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] font-medium text-ink-secondary">
                          Write Token Source
                          <div className="flex gap-2">
                            <select aria-label={`Write token source type ${index + 1}`} value={source.writeSourceType} onChange={(e) => {
                              const value = e.target.value;
                              if (value === "env" || value === "file") updateSource(index, { writeSourceType: value });
                            }} className={cn(secretsInputClass, "w-[132px] shrink-0")}>
                              <option value="env">Environment</option>
                              <option value="file">File Path</option>
                            </select>
                            <input aria-label={`Write token source locator ${index + 1}`} value={source.writeSource} onChange={(e) => updateSource(index, { writeSource: e.target.value })} placeholder={source.writeSourceType === "env" ? "INFISICAL_WRITE_TOKEN" : "/absolute/path/write-token"} autoComplete="off" className={cn(secretsInputClass, "min-w-0 flex-1")} />
                          </div>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">Use Infisical</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  The kill switch.  Turning this off falls straight back to the environment and this computer.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                aria-label="Use Infisical"
                onClick={() => {
                  setEnabled((v) => !v);
                  setSaveOk(false);
                }}
                className={cnSwitch(enabled)}
              >
                <span className={cnKnob(enabled)} />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink">Write Through to Infisical</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  Let a Settings save write a managed value back into Infisical.  Off by default: a managed value can
                  only be changed in Infisical.
                </div>
              </div>
              <button
                role="switch"
                aria-checked={writeThrough}
                aria-label="Write Through to Infisical"
                onClick={() => {
                  setWriteThrough((v) => !v);
                  setSaveOk(false);
                }}
                className={cnSwitch(writeThrough)}
              >
                <span className={cnKnob(writeThrough)} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save
              </button>
              <button
                type="button"
                onClick={() => void testConnection()}
                disabled={saving || testing || !canTest}
                title={!enabled ? "Enable Infisical to test the selected connection." : undefined}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={13} className={cn(testing && "animate-spin")} />
                {testing ? "Testing..." : "Test Connection"}
              </button>
              <button
                type="button"
                onClick={() => void syncNow()}
                disabled={syncing || !vault?.configured}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={13} className={cn(syncing && "animate-spin")} />
                {syncing ? "Syncing..." : "Sync Now"}
              </button>
              {saveOk && !saveError && (
                <span className="flex items-center gap-1 text-[12.5px] text-success">
                  <CheckCircle size={14} />
                  Saved
                </span>
              )}
              {testResult && (
                <span className={cn("flex items-center gap-1.5 text-[12.5px]", testResult.ok ? "text-success" : "text-danger")}>
                  {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  <span
                    className="max-w-[320px] truncate"
                    title={
                      testResult.ok
                        ? `Infisical accepted the selected authentication method (${testResult.secretCount ?? 0} secrets)`
                        : testResult.error || "Not reachable"
                    }
                  >
                    {testResult.ok
                      ? `Infisical accepted the selected authentication method (${testResult.secretCount ?? 0} secrets)`
                      : testResult.error || "Not reachable"}
                  </span>
                </span>
              )}
            </div>
            {saveError && (
              <div role="alert" className="text-[12px] text-danger">
                {saveError}
              </div>
            )}
            <div className="text-[12px] leading-relaxed text-ink-secondary">
              Infisical is optional.{'\u00A0'} Select Service Tokens or Machine Identity explicitly; BotFleet never picks a machine identity from an inherited environment.{'\u00A0'} Leave Infisical off to use the environment and this computer.{'\u00A0'} When Infisical holds a name, it wins over the environment and this computer.{'\u00A0'} Write Through lets Settings save managed values back into Infisical; keep it off unless a scoped write token is configured.{'\u00A0'} Token values are never returned by status or displayed after save.
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Where Each Credential Comes From"
        subtitle={"Every credential BotFleet knows how to consume, and which source is winning for it right now.\u00A0 Values are never shown — names and counts only."}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-hairline/40 text-left text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                <th className="pb-2 pr-3">Value</th>
                <th className="pb-2 pr-3">Source</th>
                <th className="pb-2">Infisical name</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.id} className="border-b border-hairline/20">
                  <td className="py-2 pr-3 text-ink">{field.label}</td>
                  <td className="py-2 pr-3">
                    <SecretSourceBadge
                      source={field.source}
                      elsewhere={field.elsewhere}
                      infisicalConfigured={vault?.configured ?? false}
                    />
                  </td>
                  <td className="py-2 font-mono text-[11.5px] text-ink-secondary">{field.infisicalName}</td>
                </tr>
              ))}
              {fields.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-3 text-ink-secondary">
                    {statusFetchError ? "Failed to load." : "Loading..."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {unusedNames.length > 0 && (
            <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
              In Infisical, not used by BotFleet: {unusedNames.join(", ")}.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
