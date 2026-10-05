// Local VM runtime setup — extracted from `LocalComputerSection.tsx` so
// the redesigned Computer settings section can swap the section's body
// for provider toggles + matrix without silently dropping the one-click
// container install that operators rely on.  Behavior is unchanged from
// the prior file: a status poll against `/api/local-computer`, four
// numbered setup steps (install runtime / open runtime / prepare BotFleet
// desktop / create VM), a per-bot-vs-shared switch that hits
// `/api/local-computer/mode`, and a Safety / Storage card with stop /
// delete controls.
//
// This file is the operational home of the VM.  The redesigned
// settings UI is the operator-facing home of "which providers are
// available".  Keeping them split lets a future ops change to the
// runtime not drag the settings UX with it, and vice versa.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, ExternalLink, Loader2, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card, CommandLine } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { productErrorHeadline } from "@/lib/product-error";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface Status {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  max_instances: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2 [&>*]:max-w-full">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || pending !== null}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function LocalVmRuntimeCard() {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; body: string; confirmLabel: string; action: Action }>(null);
  const [modePending, setModePending] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // The redesigned settings UI drives the per-bot-vs-shared switch
  // through `botDefaults.vpsMode`; this runtime card still owns the
  // shared Local VM mode that the legacy `localVm.mode` field used to
  // pick.  Both states are read so a button label that says "shared"
  // stays internally consistent with the rest of the section.
  const localVmMode = state.config?.localVm?.mode;
  const perBot = localVmMode === "per-bot";
  // The Local VM provider toggle in Computer settings.  When it is off the
  // server refuses run and start (409), so the controls that would create
  // or start the VM are disabled here too.  Stop and remove stay available.
  // An install with no `computerProviders` yet defers to the legacy
  // allowlist, same as the server.
  const computerProviders = state.config?.botDefaults?.computerProviders;
  const localVmOff = Boolean(computerProviders) && computerProviders?.localVm !== true;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/local-computer", { signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Status request failed (${response.status})`);
    setStatus(body as Status);
    setError(null);
  }, []);

  useEffect(() => {
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
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  const post = async (action: Exclude<Action, "recreate">) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${action} failed`);
    setStatus(body as Status);
  };

  const act = async (action: Action, confirmed = false) => {
    if (action === "remove" && !confirmed) {
      setConfirm({
        title: "Delete Local VM?",
        body: "Delete the Local VM?\u00a0 Files and browser sign-ins in its durable workspace will remain.",
        confirmLabel: "Delete VM",
        action,
      });
      return;
    }
    if (action === "recreate" && !confirmed) {
      setConfirm({
        title: "Replace Local VM?",
        body: "Replace the existing Local VM with the pinned image and safety limits?\u00a0 Files and browser sign-ins in its durable workspace will remain.",
        confirmLabel: "Replace VM",
        action,
      });
      return;
    }
    setPending(action);
    setError(null);
    try {
      if (action === "recreate") {
        await post("remove");
        await post("run");
      } else {
        await post(action);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = status?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (status?.container === "stopped" ||
        !status?.imageMatches ||
        !status?.managed ||
        status?.network === "unsafe" ||
        status?.security === "unsafe" ||
        status?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : "computer";
  const perBotRuntimeUnsupported = perBot && status?.runtime === "container";
  const headerReady = perBot ? Boolean(status?.daemonUp && status?.image && !perBotRuntimeUnsupported) : ready;

  const switchMode = (next: "shared" | "per-bot") => {
    if (modePending) return;
    setModePending(true);
    setModeError(null);
    api("/api/local-computer/mode", {
      method: "POST",
      body: JSON.stringify({ mode: next }),
    })
      .then((response: { config: ConfigStatus }) => {
        dispatch({ type: "configStatus", config: response.config });
      })
      .catch((e) => setModeError(e instanceof Error ? e.message : String(e)))
      .finally(() => setModePending(false));
  };

  return (
    <>
      <Card
        id="setting-computers-local-vm"
        title="Local VM"
        subtitle={perBot
          ? `Private Linux desktops on this ${host}, with one container and durable workspace per bot.\u00a0 Distinct bots can work concurrently and idle desktops stop after 8 hours.`
          : `A shared Linux sandbox on this ${host} for bots to browse and work in, each on its own desktop, backed by one durable workspace and automatically recycled after 8 hours without activity.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              headerReady ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : headerReady ? <Check size={12} /> : <Circle size={9} />}
            {loading
              ? "Checking…"
              : unavailable
                ? "Status unavailable"
                : perBot && headerReady
                  ? "Ready for per-bot desktops"
                  : perBotRuntimeUnsupported
                    ? "Per-bot mode requires Docker or Podman"
                  : ready
                    ? "Ready"
                    : (status?.problem ?? "Not ready")}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading || pending !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && !perBot && (
            <a
              href={status?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-control"
            >
              <ExternalLink size={12} /> Watch Screen
            </a>
          )}
        </div>
        {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger" title={error}>{productErrorHeadline(error)}</div>}
      </Card>

      <Card
        title="VM Mode"
        subtitle={
          perBot
            ? "Each bot gets its own private container, durable workspace, and loopback viewer.\u00a0 Idle desktops stop on their own after 8 hours."
            : "One shared container on this machine, with a separate desktop for each bot.\u00a0 Bots work at the same time, but they share cookies, sign-ins, files, and installed apps/CLI tools."
        }
      >
        {unavailable ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="text-warning" />
            Status is unavailable, so VM mode is greyed out.{"\u00a0 "}Re-check above.
          </div>
        ) : (
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            {(["shared", "per-bot"] as const).map((option, i) => (
              <button
                key={option}
                disabled={modePending}
                onClick={() => switchMode(option)}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  modePending && "opacity-60",
                  (perBot ? option === "per-bot" : option === "shared")
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                {option === "per-bot" ? "Per-Bot" : "Shared"}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 text-[11.5px] text-ink-secondary">
          Switching modes removes the existing desktop on the way out, so a shared workspace cannot be silently inherited by a per-bot one (or vice versa).
        </div>
        {modeError && <div className="mt-2 text-[11.5px] text-danger">{modeError}</div>}
      </Card>

      <Card title="Setup" subtitle="Once a container runtime is open, BotFleet prepares the Linux desktop and the VM for you.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a Container Runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free.{"\u00a0 "}Docker Desktop may require a paid licence for larger companies and government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? `Open and start ${status.runtime}` : "Start the container runtime"}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
            )}
          </Step>

          <Step n={3} title="Prepare the Linux Desktop (One-Time Download and Build)" done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare Linux Desktop</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show Base-Image Download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={perBot ? "Create a Private Desktop from Each Bot's Computer Panel" : needsRecreate ? "Replace the Older or Unsafe VM" : "Create and Start the Local VM"}
            done={!perBot && ready}
          >
            {perBot ? (
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {perBotRuntimeUnsupported
                  ? "Apple container requires an explicit host port, so BotFleet will not guess or expose one.\u00a0 Install or start Docker or Podman for safe per-bot dynamic loopback ports."
                  : <>
                      Choose <b className="text-ink">Local VM</b> for a bot, open that bot's Computer panel, then create its desktop there.{"\u00a0 "}BotFleet assigns a private workspace and an available loopback viewer port automatically.
                    </>}
              </div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{status?.problem}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger disabled={localVmOff}>
                    <RotateCcw size={13} /> Delete and Recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the pinned Linux desktop above before replacing this VM.</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")} disabled={localVmOff}>Start Local VM</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Waiting for the desktop…</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")} disabled={localVmOff}>Create Local VM</ActionButton>
            ) : null}
            {localVmOff && !perBot && (
              <div className="text-[13px] text-ink-secondary">Local VM is turned off in Computer settings.{"\u00a0 "}Turn it on above to create or start it.</div>
            )}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show Command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>BotFleet could not inspect the container runtime.{"\u00a0 "}Re-check, or review the app logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="Safety and Storage"
        subtitle={perBot
          ? `Computer Driver operates only this VM's desktop.\u00a0 Every bot gets a private host folder mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; its files and browser profile survive VM replacement.\u00a0 Viewers bind only to loopback, and exact bot-derived targets prevent one bot from attaching to another bot's container.\u00a0 Each VM keeps the existing 8 GB, 4 CPU, 512-process and dropped-capability limits.\u00a0 VMs can still reach the internet.`
          : `Computer Driver operates only the VM's desktop.\u00a0 Exactly one private host folder is mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; files and browser sign-ins there survive VM replacement, while everything elsewhere in the VM remains disposable.\u00a0 The password-protected viewer is available only on this machine.\u00a0 Docker and Podman runs are limited to 8 GB memory, 4 CPUs and 512 processes; all Linux capabilities are dropped except the two the desktop supervisor needs to switch to its unprivileged user.\u00a0 The VM can still reach the internet, and every bot sees the same files and sign-ins.`}
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? "Delete Legacy Shared VM" : "Delete VM"}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          Durable workspace: {status?.workspace_path ?? "not created"} ·{" "}
          Computer Driver: {status?.driver_version ?? "0.20.0"} · Local image: {status?.image_ref ?? "not prepared"}
          {status?.base_image_ref ? <> · Base: {status.base_image_ref}</> : null}
        </div>
      </Card>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.confirmLabel}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const next = confirm?.action;
          setConfirm(null);
          if (next) void act(next, true);
        }}
      />
    </>
  );
}
