import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

interface VpsStatus {
  backend: string;
  configured: boolean;
  sshAlias: string | null;
  daemonUp: boolean;
  image: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
}

interface SyncResult {
  ok: boolean;
  synced: string[];
  containerName: string;
  
}
/** Which face of the card a workspace gets: the live shared-runtime
 * panel, the per-bot caption, or nothing (VPS not configured). */
export function sharedVpsCardMode(vpsConfigured: boolean, vpsMode: string | null | undefined): "shared" | "per-bot" | "hidden" {
  if (!vpsConfigured) return "hidden";
  return vpsMode === "shared" ? "shared" : "per-bot";
}

export function SharedVpsRuntimeCard() {
  const { state } = useStore();
  const [status, setStatus] = useState<VpsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const providers = state.config?.botDefaults?.computerProviders;
  const selfHostedVpsEnabled = providers?.selfHostedVps === true;
  const vpsMode = state.config?.botDefaults?.vpsMode;
  const vpsConfigured = Boolean(state.config?.vps?.configured);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/vps-computer", { signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Status request failed (${response.status})`);
    setStatus(body as VpsStatus);
    setError(null);
  }, []);

  const handleSyncCredentials = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const response = await fetch("/api/vps-computer/sync-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? `Sync failed (${response.status})`);
      }
      setSyncResult(data as SyncResult);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    // Only poll if VPS is configured and mode is shared
    if (!vpsConfigured || vpsMode !== "shared") return;

    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (controller) controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, vpsConfigured, vpsMode]);

  if (!vpsConfigured) {
    return null;
  }

  // Per-bot is a live server mode with no settings control (the mode row
  // was simplified away; enabling the provider here always picks shared).
  // Say which mode the workspace is in instead of painting nothing, so an
  // operator looking at a per-bot workspace is not left guessing.
  if (vpsMode !== "shared") {
    return (
      <Card
        title="Self-Hosted VPS"
        subtitle="This workspace runs bots on your own VPS."
      >
        <div className="text-[13px] text-ink-secondary">
          Per-bot mode: each bot gets its own VPS container.{"\u00a0 "}The VPS mode is set in the
          server config (<code>botDefaults.vpsMode</code>); there is no settings control for it.
        </div>
      </Card>
    );
  }

  const unavailable = Boolean(error);
  const running = status?.container === "running";

  return (
    <Card
      id="setting-computers-shared-vps"
      title="Shared VPS VM"
      subtitle="The shared Linux sandbox running on your VPS, with a separate desktop for each bot.\u00a0 Bots share cookies, sign-ins, files, and installed apps/CLI tools."
    >
      <div className="flex flex-col gap-4">
        {unavailable ? (
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>Could not inspect the VPS runtime.{"\u00a0 "}{error}</span>
          </div>
        ) : !status ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> Fetching VPS status…
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className={cn("h-2.5 w-2.5 rounded-full", running ? "bg-accent" : "bg-ink-secondary")} />
              <span className="text-[13px] font-medium text-ink">
                {running ? "Running" : status.container === "stopped" ? "Stopped" : "Missing"}
              </span>
            </div>
            {status.problem && (
              <div className="flex gap-2 text-[13px] text-warning">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{status.problem}</span>
              </div>
            )}
            <div className="text-[13px] text-ink-secondary">
              {!selfHostedVpsEnabled
                ? "Self-Hosted VPS is disabled in workspace providers.\u00a0 Turn it on above to let bots use this."
                : running
                  ? "The VPS container is up and running."
                  : "The VPS container will be provisioned automatically when a bot needs it."}
            </div>
            {running && (
              <div className="mt-2 flex flex-col gap-2 rounded-lg border border-hairline/40 bg-surface-subtle/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-ink">Host CLI Credentials</div>
                    <div className="text-[12px] text-ink-secondary">
                      Copy local developer logins (~/.infisical, ~/.ssh, ~/.gitconfig, ~/.config/gh, ~/.aws, ~/.config/gcloud, ~/.npmrc, etc.) into the shared VPS container.{state.config?.localVm?.shareCliCredentials ? "\u00a0 Automatic sync is enabled in Host & CLI Integration." : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={handleSyncCredentials}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/60 bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control/80 disabled:opacity-50"
                  >
                    {syncing ? (
                      <>
                        <Loader2 size={13} className="animate-spin" /> Syncing…
                      </>
                    ) : (
                      <>Sync CLI Credentials</>
                    )}
                  </button>
                </div>
                {syncResult && (
                  <div className="flex items-center gap-2 text-[12px] text-success">
                    <Check size={13} className="shrink-0" />
                    <span>
                      {syncResult.synced.length > 0
                        ? `Synced ${syncResult.synced.length} credential group(s): ${syncResult.synced.join(", ")}`
                        : "No local CLI credentials found to sync."}
                    </span>
                  </div>
                )}
                {syncError && (
                  <div className="flex items-center gap-2 text-[12px] text-danger">
                    <AlertTriangle size={13} className="shrink-0" />
                    <span>{syncError}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
