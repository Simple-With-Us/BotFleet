import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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

  if (!vpsConfigured || vpsMode !== "shared") {
    return null;
  }

  const unavailable = Boolean(error);
  const running = status?.container === "running";

  return (
    <Card
      title="Shared VPS VM"
      subtitle="The shared Cua Linux sandbox running on your VPS. Bots take turns using it one at a time."
    >
      <div className="flex flex-col gap-4">
        {unavailable ? (
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>Could not inspect the VPS runtime. {error}</span>
          </div>
        ) : !status ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> Fetching VPS status...
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
                ? "Self-hosted VPS is disabled in workspace providers. Turn it on above to let bots use this."
                : running
                  ? "The VPS container is up and running."
                  : "The VPS container will be provisioned automatically when a bot needs it."}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
