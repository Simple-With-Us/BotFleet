import { useEffect, useRef, useState } from "react";
import { CheckCircle, Database, RefreshCw, XCircle } from "lucide-react";
import { api, useSecretSources, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { SecretSourceBadge } from "./SecretSourceBadge";
import {
  qdrantAccessWarning,
  qdrantLastSuccessLabel,
  qdrantRouteLabel,
  qdrantStateLabel,
  qdrantTestResultIfCurrent,
  settleQdrantSaveWithStatusFence,
  waitForLatestQdrantSave,
  type QdrantStatus,
} from "@/lib/qdrant-status";

export function QdrantRagConnection() {
  const { state, dispatch } = useStore();
  const qdrant = state.config?.qdrant;

  const secretSources = useSecretSources();
  const infisicalConfigured = Boolean(state.config?.infisical?.configured);
  const writeThrough = Boolean(state.config?.infisical?.writeThrough);
  const urlSource = secretSources.get("qdrant.url");
  const apiKeySource = secretSources.get("qdrant.apiKey");
  const collectionSource = secretSources.get("qdrant.collection");
  const accessClientIdSource = secretSources.get("qdrant.accessClientId");
  const accessClientSecretSource = secretSources.get("qdrant.accessClientSecret");
  // A 409 the operator cannot explain is the failure this prevents: with
  // Write Through off, Infisical is the only place a managed field can
  // change, so each one disables outright and is stripped from every save
  // this component makes — `save()` below fires on every field's onBlur
  // carrying the other fields' *current* values along with it, so a locked
  // field would otherwise ride along into an unrelated save and hit the
  // refusal gate for no reason the operator asked for.
  const urlLocked = (urlSource?.managed ?? false) && !writeThrough;
  const apiKeyLocked = (apiKeySource?.managed ?? false) && !writeThrough;
  const collectionLocked = (collectionSource?.managed ?? false) && !writeThrough;
  const accessClientIdLocked = (accessClientIdSource?.managed ?? false) && !writeThrough;
  const accessClientSecretLocked = (accessClientSecretSource?.managed ?? false) && !writeThrough;

  const [enabled, setEnabled] = useState(qdrant?.enabled ?? true);
  const [url, setUrl] = useState(qdrant?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [collection, setCollection] = useState(qdrant?.collection ?? "");
  const [accessClientId, setAccessClientId] = useState(qdrant?.accessClientId ?? "");
  const [accessClientSecret, setAccessClientSecret] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<QdrantStatus | null>(null);
  const testRevision = useRef(0);
  const enabledRevision = useRef(0);
  const saveFailed = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (qdrant) {
      setEnabled(qdrant.enabled);
      if (qdrant.url !== undefined) setUrl(qdrant.url);
      if (qdrant.collection) setCollection(qdrant.collection);
      if (qdrant.accessClientId !== undefined) setAccessClientId(qdrant.accessClientId);
    }
  }, [qdrant]);

  const performSave = async (
    overrides: {
      enabled?: boolean;
      url?: string;
      apiKey?: string;
      collection?: string;
      accessClientId?: string;
      accessClientSecret?: string;
    } = {},
  ) => {
    const patchBody: {
      qdrant: {
        enabled?: boolean;
        url?: string;
        apiKey?: string;
        collection?: string;
        accessClientId?: string;
        accessClientSecret?: string;
      };
    } = {
      qdrant: {
        enabled: overrides.enabled !== undefined ? overrides.enabled : enabled,
        url: (overrides.url !== undefined ? overrides.url : url).trim() || undefined,
        collection: (overrides.collection !== undefined ? overrides.collection : collection).trim() || undefined,
        accessClientId:
          (overrides.accessClientId !== undefined ? overrides.accessClientId : accessClientId).trim() || undefined,
      },
    };
    if (overrides.apiKey !== undefined || apiKey.trim()) {
      patchBody.qdrant.apiKey = (overrides.apiKey !== undefined ? overrides.apiKey : apiKey).trim() || undefined;
    }
    // The stored Access secret is never sent back to the client, so an
    // untouched field must not be echoed as an empty string — that would
    // clear a working service token on the next unrelated save.
    if (overrides.accessClientSecret !== undefined || accessClientSecret.trim()) {
      patchBody.qdrant.accessClientSecret =
        (overrides.accessClientSecret !== undefined ? overrides.accessClientSecret : accessClientSecret).trim() ||
        undefined;
    }

    // Every field above rides along into every save, whichever one blurred —
    // see the lock computations near the top of this component.  Strip a
    // locked field out here, at the one place all of them are assembled,
    // rather than trying to catch it at each of the five onBlur call sites.
    if (urlLocked) delete patchBody.qdrant.url;
    if (collectionLocked) delete patchBody.qdrant.collection;
    if (accessClientIdLocked) delete patchBody.qdrant.accessClientId;
    if (apiKeyLocked) delete patchBody.qdrant.apiKey;
    if (accessClientSecretLocked) delete patchBody.qdrant.accessClientSecret;

    setSaving(true);
    setSaveError(null);
    saveFailed.current = false;
    const testRevisionAtStart = testRevision.current;
    const result = await settleQdrantSaveWithStatusFence<ConfigStatus>(
      () => api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patchBody),
      }),
      testRevisionAtStart,
      () => testRevision.current,
    );
    setSaving(false);
    if (!result.ok) {
      saveFailed.current = true;
      setSaveError(result.error);
      return false;
    }
    if (result.clearTestResult) setTestResult(null);
    dispatch({ type: "configStatus", config: result.value });
    return true;
  };

  const save = (
    overrides: Parameters<typeof performSave>[0] = {},
  ): Promise<boolean> => {
    testRevision.current += 1;
    const previous = pendingSave.current;
    const operation = previous
      ? previous.then(() => performSave(overrides), () => performSave(overrides))
      : performSave(overrides);
    pendingSave.current = operation;
    const clear = () => {
      if (pendingSave.current === operation) pendingSave.current = null;
    };
    void operation.then(clear, clear);
    return operation;
  };

  const runTest = async () => {
    setTesting(true);
    if (!(await waitForLatestQdrantSave(() => pendingSave.current, () => saveFailed.current))) {
      setTesting(false);
      return;
    }
    const currentTestRevision = ++testRevision.current;
    setTestResult(null);
    try {
      const data: QdrantStatus = await api("/api/qdrant/status");
      const current = qdrantTestResultIfCurrent(currentTestRevision, () => testRevision.current, data);
      if (current) setTestResult(current);
    } catch (err) {
      const current = qdrantTestResultIfCurrent(currentTestRevision, () => testRevision.current, {
        ready: false,
        error: err instanceof Error ? err.message : String(err),
      });
      if (current) setTestResult(current);
    } finally {
      setTesting(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  // Half an Access pair sends no Access headers at all, so a service behind
  // Access answers a login page and the panel reads like an outage.  The
  // saved values decide this, not the fields being typed into, so the
  // warning does not flicker between the id and the secret being entered; a
  // fresh probe's verdict wins once there is one.
  const accessWarning = qdrantAccessWarning(testResult?.accessTokenState ?? qdrant?.accessTokenState);

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Database size={17} className="text-accent" />
          <div>
            <div className="text-[14.5px] font-medium text-ink">Bot RAG &amp; Shared Memory</div>
            <div className="text-[12.5px] text-ink-secondary">
              Connect your bots to a shared vector memory service for semantic retrieval, runbooks, and lessons.  Leave the URL blank to use this Mac's <code>recall</code> CLI, or to keep this off.
            </div>
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Enable shared memory"
          aria-busy={saving}
          onClick={async () => {
            const previous = enabled;
            const next = !enabled;
            const revision = ++enabledRevision.current;
            setEnabled(next);
            if (!(await save({ enabled: next })) && enabledRevision.current === revision) setEnabled(previous);
          }}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
            enabled ? "bg-accent" : "bg-hairline/60"
          )}
        >
          <span
            className={cn(
              "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out",
              enabled ? "translate-x-4" : "translate-x-0"
            )}
          />
        </button>
      </div>

      {saveError && (
        <div role="alert" className="mt-3 text-[12.5px] text-danger">
          Shared memory settings were not saved.{"\u00A0 "}{saveError}
        </div>
      )}

      {enabled && (
        <div className="mt-4 flex flex-col gap-3 border-t border-hairline/30 pt-3">
          <div className="grid gap-1 rounded-lg border border-hairline/30 bg-inset/40 px-3 py-2 text-[12px] text-ink-secondary sm:grid-cols-3">
            <span><span className="font-medium text-ink">Selected route:</span> {qdrantRouteLabel(testResult, qdrant?.url ?? "")}</span>
            <span><span className="font-medium text-ink">State:</span> {qdrantStateLabel(testResult)}</span>
            <span><span className="font-medium text-ink">Last successful check:</span> {qdrantLastSuccessLabel(testResult)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <label className="text-[12px] font-medium text-ink-secondary">Service URL</label>
              <SecretSourceBadge source={urlSource?.source} infisicalConfigured={infisicalConfigured} />
            </div>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => void save({ url })}
              placeholder={urlLocked ? "Managed by Infisical." : "Leave blank for this Mac's recall CLI"}
              disabled={urlLocked}
              className={cn(inputClass, urlLocked && "cursor-not-allowed opacity-60")}
            />
            {urlLocked && <div className="text-[11px] text-ink-secondary">Managed by Infisical.</div>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary">API Key / Bearer Token (Optional)</label>
                <SecretSourceBadge source={apiKeySource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => void save({ apiKey })}
                placeholder={apiKeyLocked ? "Managed by Infisical." : qdrant?.hasApiKey ? "••••••••" : "Leave blank for mesh / local auth"}
                disabled={apiKeyLocked}
                className={cn(inputClass, apiKeyLocked && "cursor-not-allowed opacity-60")}
              />
              {apiKeyLocked && <div className="text-[11px] text-ink-secondary">Managed by Infisical.</div>}
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary">Collection Name</label>
                <SecretSourceBadge source={collectionSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                type="text"
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                onBlur={() => void save({ collection })}
                placeholder={collectionLocked ? "Managed by Infisical." : "agent-memory"}
                disabled={collectionLocked}
                className={cn(inputClass, collectionLocked && "cursor-not-allowed opacity-60")}
              />
              {collectionLocked && <div className="text-[11px] text-ink-secondary">Managed by Infisical.</div>}
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-hairline/30 bg-inset/40 p-3">
            <div>
              <div className="text-[12.5px] font-medium text-ink">Cloudflare Access Service Token (Optional)</div>
              <div className="text-[12px] text-ink-secondary">
                Only for a service published behind Cloudflare Access.  If a test returns a 302 or a login page, that is
                Access asking who you are — it ignores the API key above and wants this header pair instead.  Create one
                under Zero Trust → Access → Service Auth.
              </div>
            </div>
            {accessWarning && (
              <div
                role="status"
                className="rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-[12px] leading-[1.4] text-warning"
              >
                {accessWarning}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <label className="text-[12px] font-medium text-ink-secondary">Access Client Id</label>
                  <SecretSourceBadge source={accessClientIdSource?.source} infisicalConfigured={infisicalConfigured} />
                </div>
                <input
                  type="text"
                  value={accessClientId}
                  onChange={(e) => setAccessClientId(e.target.value)}
                  onBlur={() => void save({ accessClientId })}
                  placeholder={accessClientIdLocked ? "Managed by Infisical." : "xxxxxxxx.access"}
                  disabled={accessClientIdLocked}
                  className={cn(inputClass, accessClientIdLocked && "cursor-not-allowed opacity-60")}
                />
                {accessClientIdLocked && <div className="text-[11px] text-ink-secondary">Managed by Infisical.</div>}
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <label className="text-[12px] font-medium text-ink-secondary">Access Client Secret</label>
                  <SecretSourceBadge source={accessClientSecretSource?.source} infisicalConfigured={infisicalConfigured} />
                </div>
                <input
                  type="password"
                  value={accessClientSecret}
                  onChange={(e) => setAccessClientSecret(e.target.value)}
                  onBlur={() => void save({ accessClientSecret })}
                  placeholder={
                    accessClientSecretLocked
                      ? "Managed by Infisical."
                      : qdrant?.hasAccessClientSecret
                        ? "••••••••"
                        : "Paste the service token secret"
                  }
                  disabled={accessClientSecretLocked}
                  className={cn(inputClass, accessClientSecretLocked && "cursor-not-allowed opacity-60")}
                />
                {accessClientSecretLocked && <div className="text-[11px] text-ink-secondary">Managed by Infisical.</div>}
              </div>
            </div>
          </div>

          <div className="mt-1 flex items-center justify-between">
            <button
              onClick={() => void runTest()}
              disabled={testing}
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control disabled:opacity-50"
            >
              <RefreshCw size={13} className={cn(testing && "animate-spin")} />
              {testing ? "Testing..." : "Test Connection"}
            </button>

            {testResult?.ready && (
              <div className="flex items-center gap-1.5 text-[12.5px] text-success">
                <CheckCircle size={14} />
                <span>
                  Connected · {(testResult.pointsCount ?? 0).toLocaleString()} points in {testResult.collection || collection}
                </span>
              </div>
            )}
          </div>

          {/* A failure gets a full-width, wrapping row rather than one
              truncated line: the useful messages name a cause ("behind
              Cloudflare Access", "timed out after 30s"), and truncation hid
              exactly the part worth reading.  Nothing here is clipped
              anymore, so unlike the readable-on-hover rule elsewhere there
              is no hidden text for a title to reveal — see PR #206, which
              dropped this same repeat-what-is-already-visible tooltip
              elsewhere in the app. */}
          {testResult && !testResult.ready && (
            <div className="flex items-start gap-1.5 text-[12.5px] text-danger">
              <XCircle size={14} className="mt-0.5 shrink-0" />
              <span>{testResult.error || "Not reachable"}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
