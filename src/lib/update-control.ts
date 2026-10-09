// The renderer's half of "check for a newer BotFleet, and install it".
//
// Two update paths exist and they answer different questions.  The signed
// release feed (electron-updater) asks "has a build been published?" and only
// works in a packaged, signed app that shipped with `app-update.yml`.  This
// one asks "is this Mac's own always-on checkout behind `origin/main`?" and
// is answered by the harness, which can also start the transactional local
// updater.  A locally built app has no release feed at all, so its Check for
// Updates used to fail silently — this is what it uses instead.
//
// Everything here is either a fetch or a pure string: the components own the
// markup, this file owns the wording and the decision about which path is
// live, so both can be tested without rendering anything.
import { useCallback, useEffect, useRef, useState } from "react";

/** The gap protocol's wide sentence break, for copy a person reads. */
const GAP = "\u00a0 ";

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateAvailable {
  sourceCommit: string;
  version?: string;
  aheadBy: number;
  commits: UpdateCommit[];
}

export interface UpdateRunning {
  runId: string;
  startedAt: string;
  step: string;
  /** What the step is waiting on ("Waiting for 3 bots to finish"), when the
   * updater says.  Absent from an older harness, and most of the time. */
  detail?: string;
  progress?: number;
  logTail: string[];
}

export type UpdateOutcome = "verified" | "rolled-back" | "failed" | "refused";

export interface UpdateLastRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcome: UpdateOutcome;
  message: string;
  receiptPath?: string;
}

export interface UpdateStatus {
  installed: { version: string; sourceCommit: string; installedAt?: string };
  available: UpdateAvailable | null;
  checkedAt: string | null;
  /** Why the last check produced no answer, or null when it did.  A failed
   * `git fetch` leaves a stale `origin/main` on disk, so "no error" is the
   * only thing that makes "up to date" mean anything. */
  checkError?: string | null;
  running: UpdateRunning | null;
  lastRun: UpdateLastRun | null;
  capabilities: {
    canCheck: boolean;
    canRun: boolean;
    reasons: string[];
    /** One code per `reasons` entry, same order — absent from an older
     * harness that has never heard of it, so every read of this falls back
     * to the harness's own sentence at that index. */
    codes?: string[];
    /** Bots are working.  Not a blocker: the update gives them a short grace,
     * then pauses and resumes them.  Absent from an older harness. */
    busy?: boolean;
  };
}

/** The event the store re-broadcasts when an `update.status` frame lands. */
export const UPDATE_STATUS_EVENT = "botfleet:update-status";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Null rather than a throw when this build has no harness answer for it —
 * a dev browser, an older harness, a non-Mac. */
export async function fetchUpdateStatus(request: Fetcher = fetch): Promise<UpdateStatus | null> {
  try {
    const response = await request("/api/update/status");
    if (!response.ok) return null;
    const body = await readJson(response);
    return isUpdateStatus(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * A check that could not reach the source answers 502 with the status and the
 * reason.  Both matter: the reason is what the person reads, and the status
 * still carries the previous answer and its timestamp, so the card keeps
 * saying what it last knew rather than blanking.
 */
export async function requestUpdateCheck(request: Fetcher = fetch): Promise<UpdateStatus> {
  const response = await request("/api/update/check", { method: "POST", headers: JSON_HEADERS, body: "{}" });
  const body = await readJson(response);
  if (!response.ok) {
    const failure = new Error(asError(body) ?? `Could not check for updates (${response.status}).`);
    if (isUpdateStatus(body.status)) Object.assign(failure, { status: body.status });
    throw failure;
  }
  if (!isUpdateStatus(body)) throw new Error(`Could not check for updates (${response.status}).`);
  return body;
}

/** Started, or refused with the reason and the status that goes with it. */
export type UpdateRunResult =
  | { ok: true; runId: string; status: UpdateStatus }
  | { ok: false; error: string; status: UpdateStatus | null };

/**
 * A refusal is an answer, not an exception.
 *
 * The harness sends `{ error, status }` with its 409, and that status is the
 * one that explains the refusal — the run already in flight, the busy
 * machine, the reason list.  Throwing the error and dropping the body left
 * the UI showing whatever it last knew while saying "an update is already
 * running", with no run on screen.  Only a transport or shape failure throws
 * now; a refusal comes back with the status folded in.
 */
export async function requestUpdateRun(
  options: { force?: boolean } = {},
  request: Fetcher = fetch,
): Promise<UpdateRunResult> {
  const response = await request("/api/update/run", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(options.force ? { force: true } : {}),
  });
  const body = await readJson(response);
  const status = isUpdateStatus(body.status) ? body.status : null;
  if (!response.ok) {
    return {
      ok: false,
      error: asError(body) ?? `Could not start the update (${response.status}).`,
      status,
    };
  }
  if (typeof body.runId !== "string" || !status) {
    throw new Error("The harness started an update but did not describe it.");
  }
  return { ok: true, runId: body.runId, status };
}

function asError(body: Record<string, unknown>): string | null {
  return typeof body.error === "string" && body.error ? body.error : null;
}

/** A shape check rather than a cast: this crosses a process boundary and an
 * older harness answers 404 with an HTML body. */
export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const installed = record.installed as Record<string, unknown> | undefined;
  const capabilities = record.capabilities as Record<string, unknown> | undefined;
  return Boolean(
    installed && typeof installed.version === "string" && typeof installed.sourceCommit === "string"
    && capabilities && typeof capabilities.canCheck === "boolean" && typeof capabilities.canRun === "boolean",
  );
}

export type UpdateSource = "harness" | "feed" | "none";

/**
 * Which path drives the Updates card.
 *
 * The harness wins whenever it says this computer can check or install,
 * because that answer already means macOS plus a real always-on checkout —
 * exactly "the app is attached to a local harness on a Mac".  The signed
 * release feed is the fallback, and it only exists at all when the preload's
 * updater bridge is there (a packaged build).  Neither, in a dev browser.
 */
export function updateSource(status: UpdateStatus | null, hasUpdaterBridge: boolean): UpdateSource {
  if (status && (status.capabilities.canCheck || status.capabilities.canRun)) return "harness";
  return hasUpdaterBridge ? "feed" : "none";
}

/** `1.0.30 (ae8abe7)` — the version alone is ambiguous between two builds of
 * the same version, and on this Mac that happens every day. */
export function installedLabel(status: UpdateStatus): string {
  return `${status.installed.version} (${shortCommit(status.installed.sourceCommit)})`;
}

export function shortCommit(sha: string): string {
  return /^[a-f0-9]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/** The headline when something is waiting to be installed. */
export function availableLabel(status: UpdateStatus): string | null {
  const available = status.available;
  if (!available) return null;
  const name = available.version ?? shortCommit(available.sourceCommit);
  const commits = available.aheadBy === 1 ? "1 commit ahead" : `${available.aheadBy} commits ahead`;
  return `Update Available: ${name}, ${commits}`;
}

/** Sentence case, present tense, and never a percentage the updater did not
 * actually report. */
export function runningLabel(running: UpdateRunning): string {
  const percent = typeof running.progress === "number"
    ? ` (${Math.round(Math.min(1, Math.max(0, running.progress)) * 100)}%)`
    : "";
  return `${running.detail ?? running.step}${percent}…`;
}

/** A short local date and time for a finished run, or null when there is
 * nothing usable to format — an empty or malformed `finishedAt`, mostly
 * seen only in tests. */
function finishedAtLabel(finishedAt: string): string | null {
  if (!finishedAt) return null;
  const date = new Date(finishedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The Updates card's last-run line: a short, stable product sentence for the
 * outcome, followed by when it finished.
 *
 * The updater's own message used to be appended here — for a failed run,
 * often a raw line straight from its log, like `bash …
 * update-botfleet-mac.mjs: pnpm package:mac:local failed with exit 1`.  That
 * is diagnostic text, not something to paint into the card, so it lives in
 * `lastRunDetail` instead, for a hover title or a details affordance.
 */
export function lastRunLabel(lastRun: UpdateLastRun | null): string | null {
  if (!lastRun) return null;
  const headline = lastRun.outcome === "verified"
    ? "The last update installed and verified."
    : lastRun.outcome === "rolled-back"
      ? "The last update failed and rolled back."
      : lastRun.outcome === "refused"
        ? "The last update was refused."
        : "The last update did not finish.";
  const when = finishedAtLabel(lastRun.finishedAt);
  return when ? `${headline}${GAP}${when}` : headline;
}

/** The updater's own message for the last run — the raw detail that belongs
 * on hover or in a details affordance, never inline.  See `lastRunLabel`. */
export function lastRunDetail(lastRun: UpdateLastRun | null): string | null {
  return lastRun?.message || null;
}

/** What the card says when there is nothing to install. */
export function idleLabel(status: UpdateStatus): string {
  if (!status.capabilities.canCheck) {
    return status.capabilities.reasons[0] ?? "Updating from this computer is not available here.";
  }
  if (!status.checkedAt) return "This computer has not checked for a newer build yet.";
  return "BotFleet is on the newest build this computer knows about.";
}

/**
 * The check failure a person should be reading, from either place it lives.
 *
 * A failed check leaves two traces, and only one of them survives a remount.
 * The hook catches the 502 and holds the reason in its own state; the harness
 * holds the same sentence on the status as `checkError` until a check
 * succeeds.  Closing and reopening Settings remounts the hook, which hydrates
 * from `GET /api/update/status` — so the local reason was gone while the
 * status still knew, and the card went back to "Update Available" or "on the
 * newest build this computer knows about" over a comparison that never
 * happened.  Reading both means the sentence after a remount is the sentence
 * from right after the failed check.
 *
 * The local error wins when there is one: it is the newer of the two, and an
 * install failure has no `checkError` of its own to be mistaken for.
 */
export function visibleUpdateError(local: string | null, status: UpdateStatus | null): string | null {
  return local ?? status?.checkError ?? null;
}

/**
 * Product copy for a structural refusal the harness can name by its stable
 * `code` — the reason the update path is missing on this Mac, not the
 * transient "already running" or "busy" ones, which already read as product
 * copy and are returned unchanged.
 *
 * Falls back to the harness's own sentence for a code this build does not
 * recognise: an older harness with no `codes` array at all, or a refusal
 * added after this build shipped.  Matching on the code rather than the
 * English text means a wording change on the harness side does not silently
 * stop being mapped.
 */
function structuralReasonCopy(code: string | undefined, reason: string): string {
  switch (code) {
    case "checkout-missing":
      return "This Mac's BotFleet folder is missing.";
    case "updater-missing":
      return "The updater is not installed on this Mac.";
    case "updater-outdated":
      return `This Mac's updater is out of date.${GAP}Update from this Mac once to pick up the new one.`;
    default:
      return reason;
  }
}

/**
 * Why **Install Update** is unavailable although there is something to
 * install, or null when it is available.
 *
 * `capabilities.reasons` carries the harness's own sentence for every refusal
 * it can see coming, and no surface rendered one: the floating card asserted
 * "This Mac can build and install it." while the button was conditioned away,
 * the Settings card simply lost its button, and the sidebar's install button
 * quietly ran a check instead.  All three ask this, so all three say the same
 * thing — now product copy for the refusals that have it, by way of
 * `structuralReasonCopy`.
 */
export function installBlockedReason(status: UpdateStatus | null): string | null {
  if (!status?.available || status.running) return null;
  if (status.capabilities.canRun) return null;
  const reason = status.capabilities.reasons[0];
  if (!reason) return "This Mac cannot install the update right now.";
  return structuralReasonCopy(status.capabilities.codes?.[0], reason);
}

/**
 * The harness's own sentence behind the copy above — a checkout path, a
 * script path, "run it once from a terminal" — for a hover title, never for
 * the label itself.  Null when there is nothing extra to say: no reason, or
 * the visible copy already IS the harness's sentence (an unmapped code, or
 * none at all), which is what an older harness with no `codes` array always
 * looks like.
 */
/**
 * Whether installing now would pause busy bots.  Busy is not a blocker any
 * more: the update holds new work, gives the bots a short grace to finish,
 * then pauses what is left and resumes it after the restart.  True only when
 * Install is actually available, so a structural blocker always wins.
 */
export function installPausesWork(status: UpdateStatus | null): boolean {
  return Boolean(status?.available && !status.running && status.capabilities.canRun && status.capabilities.busy);
}

/** What a surface says when installing would pause busy bots. */
export const PAUSES_WORK_COPY = "Busy bots get a minute to finish, then pause and resume after the update";

export function installBlockedReasonDetail(status: UpdateStatus | null): string | null {
  if (!status?.available || status.running || status.capabilities.canRun) return null;
  const reason = status.capabilities.reasons[0];
  if (!reason) return null;
  const mapped = structuralReasonCopy(status.capabilities.codes?.[0], reason);
  return mapped === reason ? null : reason;
}

/**
 * What is left of this session's remembered failure once a status arrives on
 * its own — a push frame, a refocus, the poll.
 *
 * `visibleUpdateError` gives the local sentence precedence because it is the
 * newer of the two, and it stops being newer the moment the harness answers
 * again.  Without this, a check that failed while the network was down kept
 * its red sentence on screen beside a subtitle the successful check had
 * already replaced.  A status still carrying `checkError` is not a recovery,
 * so that one leaves the local error alone and the same precedence goes on
 * showing it.
 */
export function keepLocalError(local: string | null, next: UpdateStatus): string | null {
  return next.checkError ? local : null;
}

/**
 * What a dismissal of the floating banner should be remembered against.
 *
 * Dismissing "1.0.31 is available" must not also dismiss "that install
 * failed" — but the available answer survives an unsuccessful run, so a key
 * built from the available commit alone stayed the same across it and the
 * failure was never shown.  The last run's identity is part of the key, so a
 * run finishing always produces a banner the person has not dismissed yet.
 */
export function bannerDismissKey(status: UpdateStatus): string {
  if (status.running) return `running:${status.running.runId}`;
  const offer = status.available ? `available:${status.available.sourceCommit}` : "idle";
  const lastRun = status.lastRun ? `${status.lastRun.runId}@${status.lastRun.finishedAt}` : "none";
  return `${offer}|${lastRun}`;
}

/** Whether the floating banner should show the harness card at all. */
export function bannerIsActionable(status: UpdateStatus | null): boolean {
  if (!status) return false;
  if (status.running) return true;
  if (status.available) return true;
  return status.lastRun !== null && status.lastRun.outcome !== "verified";
}

/**
 * May the old fire-and-forget local updater still be offered?
 *
 * `window.ogb.updater.local()` spawns `~/apps/update-botfleet.sh` with no
 * run id and no progress file, so nothing can describe it, no second caller
 * can be refused against it, and the harness never learns it happened.  It
 * stays reachable in exactly one case: the harness gave no answer at all —
 * an old harness, or one that is down — where it is the only local path
 * there is.  A harness that answered and said it cannot install has made a
 * decision, and an untracked update must not talk past it.
 */
export function mayUseLegacyLocalUpdate(
  status: UpdateStatus | null,
  canLocalUpdate: boolean | undefined,
): boolean {
  return Boolean(canLocalUpdate) && status === null;
}

/** How long to wait before asking again after a status fetch came back with
 * nothing.  A miss is usually a harness that is restarting — which is exactly
 * what an update does to it — so the first retries are quick and the tail is
 * a slow heartbeat rather than a poll. */
export const STATUS_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;
export const STATUS_RETRY_STEADY_MS = 5 * 60_000;

export function statusRetryDelay(attempt: number): number {
  return STATUS_RETRY_DELAYS_MS[attempt] ?? STATUS_RETRY_STEADY_MS;
}

/**
 * Keep asking until the harness answers, then stop.
 *
 * One failed fetch used to leave `status` null for the whole session, and a
 * null status means `updateSource` reports "feed" — so a single blip during
 * the restart an update performs would flip the UI back to the release feed
 * and re-enable the old untracked local updater.  The retry is what makes
 * "the harness is temporarily gone" temporary.
 *
 * Returns a disposer.  Injectable timers so the schedule is testable.
 */
export function scheduleStatusRetries(options: {
  fetchStatus: () => Promise<UpdateStatus | null>;
  onStatus: (status: UpdateStatus) => void;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: never) => void;
}): () => void {
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let stopped = false;
  let handle: unknown = null;
  let attempt = 0;

  const tick = () => {
    void options.fetchStatus().then((status) => {
      if (stopped) return;
      if (status) {
        options.onStatus(status);
        return;
      }
      handle = setTimer(tick, statusRetryDelay(attempt));
      attempt += 1;
    });
  };

  tick();
  return () => {
    stopped = true;
    if (handle !== null) clearTimer(handle as never);
  };
}

export interface UpdateControlView {
  status: UpdateStatus | null;
  error: string | null;
  busy: "check" | "install" | null;
  check: () => Promise<void>;
  install: (options?: { force?: boolean }) => Promise<void>;
}

/**
 * One live view of the harness's update status.
 *
 * Live updates arrive as `update.status` frames on the existing event stream
 * (the store re-broadcasts them as a window event, so this does not open a
 * second EventSource).  The poll is only a backstop for a dropped stream
 * while a run is actually going — an update takes minutes and the person is
 * watching it.
 */
export function useUpdateControl(pollMs = 5_000): UpdateControlView {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const running = Boolean(status?.running);
  const alive = useRef(true);

  // A status that arrived on its own supersedes this session's remembered
  // failure — see `keepLocalError`.
  const adopt = useCallback((next: UpdateStatus) => {
    setStatus(next);
    setError((current) => keepLocalError(current, next));
  }, []);

  useEffect(() => {
    alive.current = true;
    const stopRetries = scheduleStatusRetries({
      fetchStatus: () => fetchUpdateStatus(),
      onStatus: adopt,
    });
    const onPush = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isUpdateStatus(detail)) adopt(detail);
    };
    // Coming back to the window is the moment the answer is most likely to
    // have changed — an update finished, or a harness came back — and it is
    // free compared with polling for it.
    const onFocus = () => {
      void fetchUpdateStatus().then((next) => {
        if (alive.current && next) adopt(next);
      });
    };
    window.addEventListener(UPDATE_STATUS_EVENT, onPush);
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      stopRetries();
      window.removeEventListener(UPDATE_STATUS_EVENT, onPush);
      window.removeEventListener("focus", onFocus);
    };
  }, [adopt]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void fetchUpdateStatus().then((next) => {
        if (alive.current && next) adopt(next);
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, adopt]);

  const check = useCallback(async () => {
    setBusy("check");
    setError(null);
    try {
      setStatus(await requestUpdateCheck());
    } catch (failure) {
      // A 502 carries the status it could not refresh; keep showing it.
      const carried = (failure as { status?: unknown })?.status;
      if (isUpdateStatus(carried)) setStatus(carried);
      setError(failure instanceof Error ? failure.message : "Could not check for updates.");
    } finally {
      setBusy(null);
    }
  }, []);

  const install = useCallback(async (options?: { force?: boolean }) => {
    setBusy("install");
    setError(null);
    try {
      // No `force`: the harness's own default already never waits on busy
      // bots for long, and it gives them a grace before pausing them.
      const result = await requestUpdateRun(options ?? {});
      // The refusal's own status is the one that explains it — take it even
      // when the answer is no.
      if (result.status) setStatus(result.status);
      if (!result.ok) setError(result.error);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the update.");
    } finally {
      setBusy(null);
    }
  }, []);

  // `error` is this session's own failure; the status carries the harness's
  // memory of the last failed check.  A remount has only the second one.
  return { status, error: visibleUpdateError(error, status), busy, check, install };
}
