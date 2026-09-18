// App settings → Secrets: the machine identity for an optional Infisical
// vault, and — right underneath it — where every mapped credential in this
// app actually came from (server/infisical.ts, server/secret-map.ts).  With
// no project id and identity saved, this card is inert: nothing is fetched,
// nothing changes, and the values on this computer keep working exactly as
// they did before this feature existed.
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
  splitInfisicalPatch,
} from "@/lib/secret-source";

const secretsInputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;

export function SecretsSection() {
  const { state, dispatch } = useStore();
  const infisicalConfig = state.config?.infisical;

  const [status, setStatus] = React.useState<InfisicalStatusPayload | null>(null);
  const [statusFetchError, setStatusFetchError] = React.useState<string | null>(null);

  // Not `infisicalConfig?.enabled ?? true`: the wire value conflates the kill
  // switch with the configured state, so an unconfigured install would render
  // this switch off and the first Save would persist a hard `enabled: false`.
  // See `infisicalSwitchDefault`.
  const [enabled, setEnabled] = React.useState(infisicalSwitchDefault(infisicalConfig));
  const [writeThrough, setWriteThrough] = React.useState(infisicalConfig?.writeThrough ?? false);
  const [siteUrl, setSiteUrl] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [environment, setEnvironment] = React.useState(infisicalConfig?.environment ?? "");
  const [secretPath, setSecretPath] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
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

  const refreshStatus = React.useCallback(async () => {
    try {
      const data = await fetchSecrets();
      setStatus(data);
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
      siteUrl,
      projectId,
      environment,
      secretPath,
      clientId,
      clientSecret,
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
      // The client secret takes the same road every other credential in this
      // app takes on the desktop: `window.ogb.setCredential` commits it to
      // the OS-encrypted store first and only then makes it live, and the
      // PATCH below carries the plain settings.  Sent in the PATCH body
      // instead, it would land in plaintext `~/.botfleet/config.json` (the
      // request has no `?secretStorage=external`) and only migrate into
      // `credentials.bin` on a later launch — for the one credential that can
      // read every name in the project.  See `splitInfisicalPatch`.
      const { configPatch, bridgeSecret } = splitInfisicalPatch(built.patch, Boolean(window.ogb?.setCredential));
      // Settings first, so the server's re-login — which the bridge save
      // triggers — runs against the project and environment being saved.
      let config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ infisical: configPatch }),
      });
      // Non-null only where the split found a bridge to hand it to.
      if (bridgeSecret) {
        config = await window.ogb!.setCredential!("infisicalClientSecret", bridgeSecret);
      }
      dispatch({ type: "configStatus", config });
      if (built.patch.clientId) setClientId("");
      if (built.patch.clientSecret) setClientSecret("");
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
        error: result.ok ? null : (result.error || "Infisical did not accept the identity."),
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

  const canTest =
    Boolean(projectId.trim() || vault?.projectId) &&
    Boolean(clientId.trim() || vault?.hasClientId) &&
    Boolean(clientSecret.trim() || vault?.hasClientSecret);

  const fields = status?.fields ?? [];
  const unusedNames = vault?.unusedVaultNames ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Secret Store"
        subtitle={"Point BotFleet at an Infisical project and it becomes the source of truth for every credential it holds — before the environment, before the value saved on this computer.\u00A0 Leave this unset and nothing changes."}
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
                <p className="text-[11px] leading-snug text-ink-secondary">One Project for Now.</p>
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
                  placeholder={vault?.hasClientId ? "••••••••  (paste to replace)" : "Machine identity client id"}
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
                  placeholder={vault?.hasClientSecret ? "••••••••  (paste to replace)" : "Machine identity client secret"}
                  autoComplete="off"
                  className={secretsInputClass}
                />
              </div>
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
                        ? `Infisical accepted the identity (${testResult.secretCount ?? 0} secrets)`
                        : testResult.error || "Not reachable"
                    }
                  >
                    {testResult.ok
                      ? `Infisical accepted the identity (${testResult.secretCount ?? 0} secrets)`
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
              Infisical is optional.{'\u00A0'} With no project id and machine identity, BotFleet uses the values on this computer and nothing changes.{'\u00A0'} When Infisical holds a name, it wins over the environment and over this computer, and the badge beside each value says so.{'\u00A0'} Write Through lets Settings save back into Infisical; with it off, a value Infisical manages can only be changed there.{'\u00A0'} Values are never logged or shown here — names and counts only.
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
