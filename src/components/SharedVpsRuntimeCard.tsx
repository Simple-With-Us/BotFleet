import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Hammer, Loader2, RefreshCw } from "lucide-react";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { CliCredentialSyncPanel } from "./CliCredentialSyncPanel";
import { ConfirmDialog } from "./ConfirmDialog";

export interface VpsImageBuild {
  phase: "idle" | "building" | "failed" | "ready";
  startedAt: number | null;
  elapsedMs: number | null;
  error: string | null;
}

export interface VpsStatus {
  backend: string;
  configured: boolean;
  sshAlias: string | null;
  daemonUp: boolean;
  image: boolean;
  imageMatches?: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
  /** Absent on a harness older than the build-ahead; read as idle. */
  imageBuild?: VpsImageBuild;
  /** Absent on an older harness; read as not outdated. */
  imageOutdated?: boolean;
}

/** The header line and its dot.  A container on an older image is never a
 * clean "Running": bots refuse it until it is switched. */
export function sharedVpsStatusLabel(status: Pick<VpsStatus, "container" | "imageOutdated">): {
  label: string;
  tone: "ok" | "warn" | "idle";
} {
  const outdated = status.imageOutdated === true;
  if (status.container === "running") {
    return outdated ? { label: "Running (outdated image)", tone: "warn" } : { label: "Running", tone: "ok" };
  }
  if (status.container === "stopped") {
    return outdated ? { label: "Stopped (outdated image)", tone: "warn" } : { label: "Stopped", tone: "idle" };
  }
  return { label: "Missing", tone: "idle" };
}

/** Which image control the card offers.  With no container, a bot's next
 * provision builds the image itself, so only its progress is shown. */
export function sharedVpsImageAction(
  status: Pick<VpsStatus, "container" | "image" | "imageBuild" | "imageOutdated">,
): "none" | "building" | "prepare" | "switch" {
  if (status.imageBuild?.phase === "building") return "building";
  if (status.container === "missing" || status.imageOutdated !== true) return "none";
  return status.image ? "switch" : "prepare";
}

/** "42s", "3m 05s", "1h 02m": the build's elapsed time on the harness clock. */
export function formatBuildElapsed(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const SWITCH_CONFIRM_BODY =
  "This replaces the shared VPS container with a new one built from the new image, so bots lose the desktop for about a minute.\u00a0 " +
  "Everything saved inside the container is reset: files, browser sign-ins and cookies, and apps or CLI tools installed after it was created.\u00a0 " +
  "Move anything bots must keep off the VPS first.";

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
  const [pending, setPending] = useState<"prepare" | "switch" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
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

  const post = useCallback(
    async (action: "prepare" | "switch") => {
      setPending(action);
      setActionError(null);
      try {
        const response = await fetch(action === "prepare" ? "/api/vps-computer/prepare-image" : "/api/vps-computer/switch-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [refresh],
  );

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
  const outdated = status?.imageOutdated === true;
  const header = status ? sharedVpsStatusLabel(status) : null;
  const imageAction = status ? sharedVpsImageAction(status) : "none";

  return (
    <Card
      id="setting-computers-shared-vps"
      title="Shared VPS VM"
      subtitle={"The shared Linux sandbox running on your VPS, with a separate desktop for each bot.\u00a0 Bots share cookies, sign-ins, files, and installed apps/CLI tools."}
    >
      <div className="flex flex-col gap-4">
        {unavailable ? (
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>Could not inspect the VPS runtime.{"\u00a0 "}{error}</span>
          </div>
        ) : !status || !header ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> Fetching VPS status…
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  header.tone === "ok" ? "bg-accent" : header.tone === "warn" ? "bg-warning" : "bg-ink-secondary",
                )}
              />
              <span className="text-[13px] font-medium text-ink">{header.label}</span>
            </div>
            {status.problem && imageAction === "none" && (
              <div className="flex gap-2 text-[13px] text-warning">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{status.problem}</span>
              </div>
            )}
            <div className="text-[13px] text-ink-secondary">
              {!selfHostedVpsEnabled
                ? "Self-Hosted VPS is disabled in workspace providers.\u00a0 Turn it on above to let bots use this."
                : outdated
                  ? "This container was built from an older BotFleet image, so bots can't use it until it switches to the new one."
                  : running
                    ? "The VPS container is up and running."
                    : "The VPS container will be provisioned automatically when a bot needs it."}
            </div>
            {selfHostedVpsEnabled && imageAction === "building" && (
              <div className="flex items-start gap-2 text-[13px] text-ink-secondary" data-testid="shared-vps-image-building">
                <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" />
                <span>
                  Building the new image on the VPS: {formatBuildElapsed(status.imageBuild?.elapsedMs)} so far.{"\u00a0 "}
                  This usually takes 20 to 45 minutes{status.container === "missing" ? "." : ", and the current container stays as it is meanwhile."}
                </span>
              </div>
            )}
            {selfHostedVpsEnabled && imageAction === "prepare" && (
              <div className="flex flex-col items-start gap-2">
                {status.imageBuild?.phase === "failed" && (
                  <div className="flex gap-2 text-[13px] text-warning">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    <span>The last image build failed: {status.imageBuild.error ?? "no reason was given"}</span>
                  </div>
                )}
                <div className="text-[13px] text-ink-secondary">
                  {"Prepare the new image first.\u00a0 It builds on the VPS in 20 to 45 minutes while the current container stays as it is, then you switch in about a minute."}
                </div>
                <button
                  type="button"
                  onClick={() => void post("prepare")}
                  disabled={pending !== null}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {pending === "prepare" ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Prepare Image
                </button>
              </div>
            )}
            {selfHostedVpsEnabled && imageAction === "switch" && (
              <div className="flex flex-col items-start gap-2">
                <div className="text-[13px] text-ink-secondary">
                  {"The new image is ready.\u00a0 Switching replaces the container and resets its filesystem: files, browser sign-ins, and tools installed inside it do not carry over."}
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmSwitch(true)}
                  disabled={pending !== null}
                  className="flex items-center gap-1.5 rounded-lg bg-danger/15 px-3 py-1.5 text-[12.5px] font-medium text-danger hover:bg-danger/20 disabled:opacity-50"
                >
                  {pending === "switch" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Switch to New Image
                </button>
              </div>
            )}
            {actionError && (
              <div className="flex gap-2 text-[13px] text-warning">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{actionError}</span>
              </div>
            )}
            {running && !outdated && (
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
      <ConfirmDialog
        open={confirmSwitch}
        title="Switch to New Image?"
        body={SWITCH_CONFIRM_BODY}
        confirmLabel="Switch Image"
        onCancel={() => setConfirmSwitch(false)}
        onConfirm={() => {
          setConfirmSwitch(false);
          void post("switch");
        }}
      />
    </Card>
  );
}
