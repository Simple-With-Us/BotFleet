// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge. Renders nothing in the browser/dev (no bridge)
// and while idle/checking; appears only when actionable: an update to
// download, a download in progress, a restart to apply, or an error.
import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";
import {
  activeDrain,
  availableLabel,
  bannerDismissKey,
  bannerIsActionable,
  drainLabel,
  HOLDING_COPY,
  installPausesWork,
  isUpdateDrain,
  PAUSES_WORK_COPY,
  installBlockedReason,
  installBlockedReasonDetail,
  lastRunDetail,
  lastRunLabel,
  mayUseLegacyLocalUpdate,
  runningLabel,
  runningPercent,
  updateSource,
  useNow,
  useUpdateControl,
} from "@/lib/update-control";
import { cn } from "@/lib/cn";

// The one action button in the card. Disabled drops the accent fill for the
// flat raised grey — the "I heard you" the click needs while the main process
// gets going.
const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name the two cases that actually happen and clip anything else to its
// first line.
function friendlyError(message?: string): string {
  if (!message) return "Something went wrong.";
  if (/cannot find .*\.yml|404/i.test(message))
    return "No update has been published for this platform yet.";
  if (/ENOENT.*app-update\.yml/i.test(message))
    return "No update configuration found for this build.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return "Couldn't reach the update server.";
  return message.split("\n")[0].slice(0, 140);
}

// The card clips the subtitle to one line, so the hover has to carry the
// whole thing.  For a failure that means the raw updater message, not the
// friendly one-liner the card shows — clipping is what hid the cause.
function subtitleTooltip(subtitle: string, status?: string, message?: string): string {
  if (status !== "error" || !message) return subtitle;
  const raw = message.trim();
  return raw && raw !== subtitle ? `${subtitle}\n\n${raw}` : subtitle;
}

import { loadUpdateNotificationsEnabled } from "@/lib/update-preferences";

export function UpdateBanner() {
  const s = useUpdaterState();
  // The local-harness path, which is the only one a locally built app has.
  const local = useUpdateControl();
  // dismissal is per status+version, so the popup returns for the next
  // update (and when an available one finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"download" | "install" | "check" | null>(null);
  
  // also respect global preference
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    const handlePrefChange = () => setEnabled(loadUpdateNotificationsEnabled());
    handlePrefChange();
    window.addEventListener("botfleet:update-pref-changed", handlePrefChange);
    return () => window.removeEventListener("botfleet:update-pref-changed", handlePrefChange);
  }, []);
  
  const status = s?.status;
  useEffect(() => setPending(null), [status]);

  // When this Mac can install from its own checkout, that path owns the
  // popup entirely: it is the one that can actually finish, it is the one
  // with progress to show while it runs, and a locally built app has no
  // release feed behind the other card — so its "check failed" is noise.
  if (updateSource(local.status, Boolean(window.ogb?.updater)) === "harness") {
    if (!enabled || !bannerIsActionable(local.status)) return null;
    return <LocalUpdateCard local={local} onDismiss={setDismissed} dismissed={dismissed} />;
  }

  if (!enabled || !s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;
  const legacyLocal = mayUseLegacyLocalUpdate(local.status, s.canLocalUpdate);

  // while busy the card owns the moment: no dismissing, no second click
  const installing = s.status === "installing";
  const busy = s.status === "downloading" || installing;

  const title =
    s.status === "available"
      ? `BotFleet ${s.version} is available`
      : s.status === "downloading"
        ? `Downloading ${s.version ?? "update"}…`
        : s.status === "downloaded"
          ? `${s.version} is ready`
          : installing
            ? "Restarting to update…"
            : "Update check failed";
  const subtitle =
    s.status === "available"
      ? "A newer version is ready to download."
      : s.status === "downloading"
        ? // no percent yet means the transfer hasn't reported in — don't imply 0
          s.percent == null
          ? "Starting download…"
          : `${Math.round(s.percent)}%`
        : s.status === "downloaded"
          ? "Restart to finish updating."
          : installing
            ? "BotFleet will reopen in a moment."
            : friendlyError(s.message);

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 max-md:bottom-24 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div
            className="mt-0.5 truncate text-[12.5px] text-ink-secondary"
            title={subtitleTooltip(subtitle, s.status, s.message)}
          >
            {subtitle}
          </div>
        </div>
        {!busy && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {s.status === "downloading" && (
        <div className="mb-1.5 mt-2.5 h-1 overflow-hidden rounded-full bg-control">
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width]",
              // before the first progress report, a sliver that breathes beats
              // a zero-width bar that looks stalled
              s.percent == null && "w-1/4 animate-pulse",
            )}
            style={s.percent == null ? undefined : { width: `${Math.min(100, Math.max(0, s.percent))}%` }}
          />
        </div>
      )}

      {installing && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> Restarting…
          </button>
        </div>
      )}

      {!busy && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && (
            <button
              onClick={() => {
                setPending("download");
                void updater.download();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "download" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <ArrowDownToLine size={13} /> Download
                </>
              )}
            </button>
          )}
          {s.status === "downloaded" && (
            <button
              onClick={() => {
                setPending("install");
                void updater.install();
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Restarting…
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> Restart to update
                </>
              )}
            </button>
          )}
          {s.status === "error" && (
            <button
              onClick={() => {
                setPending("check");
                // The old untracked local updater only survives for a harness
                // that gave no answer at all — see mayUseLegacyLocalUpdate.
                if (legacyLocal && updater.local) void updater.local();
                else void updater.check();
              }}
              disabled={pending !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:text-ink-secondary disabled:hover:bg-control"
            >
              {pending === "check" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Checking…
                </>
              ) : legacyLocal ? (
                "Update From This Mac"
              ) : (
                "Try Again"
              )}
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}

/** The same popup, driven by the harness rather than the release feed.
 *
 * A local update takes minutes and restarts both the harness and this app,
 * so unlike the feed card this one is mostly a progress report: the step the
 * updater is on, how far through it is, and what happened last time. */
function LocalUpdateCard({
  local,
  dismissed,
  onDismiss,
}: {
  local: ReturnType<typeof useUpdateControl>;
  dismissed: string | null;
  onDismiss: (key: string) => void;
}) {
  const status = local.status;
  // The hold an update has on new work: present whether or not the harness
  // started the run, so an update started from a terminal still shows here.
  // A countdown, so it ticks; a hook, so it comes before any early return.
  const now = useNow(isUpdateDrain(status?.drain) ? 1_000 : null);
  // Past its lease a hold is a harness that went away mid-update, not one
  // still holding anything.
  const holding = activeDrain(status, now);
  if (!status) return null;
  const running = status.running;
  // Not dismissible while it is happening: the card IS the report.
  const inProgress = Boolean(running) || holding !== null;
  const key = bannerDismissKey(status);
  if (!inProgress && dismissed === key) return null;
  const holdLine = drainLabel(holding, now);

  const title = inProgress
    ? "Updating BotFleet…"
    : (availableLabel(status) ?? "The last update did not finish");
  // The harness ships a reason with every refusal it can see coming, and no
  // surface rendered one: the card asserted this Mac could install the update
  // while the Install button was conditioned away, which read as a card that
  // had simply lost its button.  The reason takes the subtitle instead.
  const blockedReason = installBlockedReason(status);
  const isBlocked = blockedReason !== null;
  const subtitle = running
    ? runningLabel(running)
    : holding
      ? HOLDING_COPY
      : status.available
      ? (blockedReason ?? (installPausesWork(status) ? `${PAUSES_WORK_COPY}.` : "This Mac can build and install it."))
      : (lastRunLabel(status.lastRun) ?? "");
  // The harness's own diagnostic sentence — a checkout path, a script path,
  // an updater's raw failure line — for the hover only.  `subtitle` is
  // already what a person should read; this is a fallback so a truncated
  // subtitle is still readable on hover even when there is nothing extra to
  // add.
  const subtitleDetail = running || holding
    ? null
    : status.available
      ? installBlockedReasonDetail(status)
      : lastRunDetail(status.lastRun);
  // No percent while a step waits on something outside the run (bots
  // finishing): the run's own step count does not move then, and a bar parked
  // at 40% for a minute reads as stuck.  An indeterminate bar says "waiting".
  const percent = running ? runningPercent(running) : null;

  return (
    <div className="animate-panel-in fixed bottom-4 left-4 max-md:bottom-24 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary" title={subtitleDetail ?? subtitle}>
            {subtitle}
          </div>
          {holdLine && (
            <div data-testid="update-hold-line" className="mt-1 text-[12px] leading-snug text-ink-secondary">
              {holdLine}
            </div>
          )}
        </div>
        {!inProgress && (
          <button
            onClick={() => onDismiss(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {inProgress && (
        <div className="mb-1.5 mt-2.5 h-1 overflow-hidden rounded-full bg-control">
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width]",
              percent === null && "w-1/4 animate-pulse",
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}

      {local.error && (
        <div role="alert" className="mt-2 text-[12px] text-danger">
          {local.error}
        </div>
      )}

      {!inProgress && (
        <div className="mt-2.5 flex gap-2">
          {status.available && (
            <button
              onClick={() => void local.install()}
              disabled={local.busy !== null || isBlocked}
              className={primaryAction}
            >
              {local.busy === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <ArrowDownToLine size={13} /> Install Update
                </>
              )}
            </button>
          )}
          <button
            onClick={() => onDismiss(key)}
            disabled={local.busy !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}
