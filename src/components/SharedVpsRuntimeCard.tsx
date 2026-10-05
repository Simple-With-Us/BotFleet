import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { CliCredentialSyncPanel } from "./CliCredentialSyncPanel";

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
          Per-bot mode: each bot gets its own VPS container.{"\u00a0 "}Use <b className="text-ink">Sync CLI Credentials</b> on
          each bot&apos;s Computer panel to copy host logins into that bot&apos;s container.{"\u00a0 "}The VPS mode is set in the
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
              <div className="mt-2">
                <CliCredentialSyncPanel
                  syncUrl="/api/vps-computer/sync-credentials"
                  description="Copy host CLI login files from the VM CLI manifest (Infisical, SSH, Git, cloud CLIs, registries, and more) into the shared cloud VPS container."
                  autoSyncEnabled={Boolean(state.config?.localVm?.shareCliCredentials)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
