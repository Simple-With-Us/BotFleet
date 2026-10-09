// The renderer half: which update path the card uses, and the sentences it
// says.  Both are pure, which is the point — the components render them and
// the phone renders the same server fields, so the wording is checked once.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableLabel,
  bannerDismissKey,
  bannerIsActionable,
  fetchUpdateStatus,
  idleLabel,
  installPausesWork,
  PAUSES_WORK_COPY,
  installBlockedReason,
  installBlockedReasonDetail,
  installedLabel,
  isUpdateStatus,
  keepLocalError,
  lastRunDetail,
  lastRunLabel,
  mayUseLegacyLocalUpdate,
  requestUpdateCheck,
  requestUpdateRun,
  runningLabel,
  scheduleStatusRetries,
  shortCommit,
  STATUS_RETRY_DELAYS_MS,
  STATUS_RETRY_STEADY_MS,
  statusRetryDelay,
  updateSource,
  visibleUpdateError,
  type UpdateStatus,
} from "./update-control";

const COMMIT = "ae8abe7d5d595b427164ddf37fecebcf7da65c05";
const NEXT = "3b30294e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    installed: { version: "1.0.30", sourceCommit: COMMIT },
    available: null,
    checkedAt: "2026-09-13T12:00:00.000Z",
    running: null,
    lastRun: null,
    checkError: null,
    capabilities: { canCheck: true, canRun: true, reasons: [] },
    ...patch,
  };
}

const response = (body: unknown, init: { status?: number } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

describe("which path drives the card", () => {
  it("prefers the harness whenever this computer can check or install", () => {
    expect(updateSource(status(), true)).toBe("harness");
    expect(updateSource(status(), false)).toBe("harness");
    expect(updateSource(
      status({ capabilities: { canCheck: true, canRun: false, reasons: ["An update is already running."] } }),
      true,
    )).toBe("harness");
  });

  it("falls back to the release feed only when the bridge is there", () => {
    const useless = status({ capabilities: { canCheck: false, canRun: false, reasons: ["macOS only."] } });
    expect(updateSource(useless, true)).toBe("feed");
    expect(updateSource(useless, false)).toBe("none");
    expect(updateSource(null, true)).toBe("feed");
    expect(updateSource(null, false)).toBe("none");
  });
});

describe("retrying a status that did not arrive", () => {
  afterEach(() => vi.useRealTimers());

  it("backs off on the published schedule and then heartbeats", () => {
    expect(statusRetryDelay(0)).toBe(STATUS_RETRY_DELAYS_MS[0]);
    expect(statusRetryDelay(1)).toBe(STATUS_RETRY_DELAYS_MS[1]);
    expect(statusRetryDelay(2)).toBe(STATUS_RETRY_DELAYS_MS[2]);
    expect(statusRetryDelay(3)).toBe(STATUS_RETRY_STEADY_MS);
    expect(statusRetryDelay(99)).toBe(STATUS_RETRY_STEADY_MS);
  });

  it("keeps asking until the harness answers, then stops", async () => {
    vi.useFakeTimers();
    const answers: (UpdateStatus | null)[] = [null, null, null, null, status()];
    const delays: number[] = [];
    let attempt = 0;
    const seen: UpdateStatus[] = [];
    const stop = scheduleStatusRetries({
      fetchStatus: async () => answers[attempt++] ?? null,
      onStatus: (next) => seen.push(next),
      setTimer: (handler, ms) => {
        delays.push(ms);
        return setTimeout(handler, ms);
      },
    });
    // One failed fetch used to leave the UI on the release feed for the whole
    // session; four here, and it still recovers.
    for (let round = 0; round < 4; round += 1) {
      await vi.advanceTimersByTimeAsync(STATUS_RETRY_STEADY_MS);
    }
    expect(delays).toEqual([5_000, 15_000, 60_000, STATUS_RETRY_STEADY_MS]);
    expect(seen).toHaveLength(1);
    // Answered: no further timer is armed.
    const armed = delays.length;
    await vi.advanceTimersByTimeAsync(STATUS_RETRY_STEADY_MS * 3);
    expect(delays).toHaveLength(armed);
    stop();
  });

  it("stops asking once disposed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stop = scheduleStatusRetries({
      fetchStatus: async () => {
        calls += 1;
        return null;
      },
      onStatus: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(STATUS_RETRY_STEADY_MS * 3);
    expect(calls).toBe(1);
  });
});

describe("what a banner dismissal is remembered against", () => {
  const finished = (runId: string, finishedAt: string) => ({
    runId,
    startedAt: "",
    finishedAt,
    outcome: "failed" as const,
    message: "",
  });

  it("gives a finished run its own key, so a dismissed offer does not hide it", () => {
    const offered = status({ available: { sourceCommit: NEXT, aheadBy: 2, commits: [] } });
    const afterFailure = status({
      available: { sourceCommit: NEXT, aheadBy: 2, commits: [] },
      lastRun: finished("run_one", "2026-09-13T12:30:00.000Z"),
    });
    // The available answer survives an unsuccessful run, so a key built from
    // it alone stayed put across the failure and the banner never came back.
    expect(bannerDismissKey(offered)).not.toBe(bannerDismissKey(afterFailure));
    // A second failure is a third key.
    const afterSecond = status({
      available: { sourceCommit: NEXT, aheadBy: 2, commits: [] },
      lastRun: finished("run_two", "2026-09-13T13:00:00.000Z"),
    });
    expect(bannerDismissKey(afterSecond)).not.toBe(bannerDismissKey(afterFailure));
  });

  it("is stable while nothing changes, and follows the run while one is going", () => {
    const offered = status({ available: { sourceCommit: NEXT, aheadBy: 2, commits: [] } });
    expect(bannerDismissKey(offered)).toBe(bannerDismissKey(status({
      available: { sourceCommit: NEXT, aheadBy: 2, commits: [] },
    })));
    const running = status({
      available: { sourceCommit: NEXT, aheadBy: 2, commits: [] },
      running: { runId: "run_one", startedAt: "", step: "Building", logTail: [] },
    });
    expect(bannerDismissKey(running)).toBe("running:run_one");
  });
});

describe("the old untracked local updater", () => {
  it("survives only when the harness gave no answer at all", () => {
    // No harness answer: an old or down harness, where `updater.local()` is
    // still the only local path there is.
    expect(mayUseLegacyLocalUpdate(null, true)).toBe(true);
    expect(mayUseLegacyLocalUpdate(null, false)).toBe(false);
    expect(mayUseLegacyLocalUpdate(null, undefined)).toBe(false);
    // A harness that answered has made a decision, either way — an untracked
    // update must not talk past it.
    expect(mayUseLegacyLocalUpdate(status(), true)).toBe(false);
    expect(mayUseLegacyLocalUpdate(
      status({ capabilities: { canCheck: false, canRun: false, reasons: ["macOS only."] } }),
      true,
    )).toBe(false);
  });
});

describe("what it says", () => {
  it("names the installed build by version and commit", () => {
    expect(installedLabel(status())).toBe("1.0.30 (ae8abe7)");
    expect(shortCommit("local")).toBe("local");
  });

  it("leads with the version when there is one, and the commit when there is not", () => {
    expect(availableLabel(status())).toBeNull();
    expect(availableLabel(status({
      available: { sourceCommit: NEXT, version: "1.0.31", aheadBy: 12, commits: [] },
    }))).toBe("Update Available: 1.0.31, 12 commits ahead");
    expect(availableLabel(status({
      available: { sourceCommit: NEXT, aheadBy: 1, commits: [] },
    }))).toBe("Update Available: 3b30294, 1 commit ahead");
  });

  it("shows a percentage only when the updater reported one", () => {
    expect(runningLabel({ runId: "r", startedAt: "", step: "Building and signing the app", logTail: [] }))
      .toBe("Building and signing the app…");
    expect(runningLabel({
      runId: "r",
      startedAt: "",
      step: "Installing dependencies",
      progress: 0.25,
      logTail: [],
    })).toBe("Installing dependencies (25%)…");
    // What the step is waiting on reads better than the step's own name.
    expect(runningLabel({
      runId: "r",
      startedAt: "",
      step: "Holding new work",
      detail: "Waiting for 3 bots to finish",
      progress: 0.4,
      logTail: [],
    })).toBe("Waiting for 3 bots to finish (40%)…");
  });

  it("distinguishes the four outcomes", () => {
    const base = { runId: "r", startedAt: "", finishedAt: "", message: "" };
    expect(lastRunLabel({ ...base, outcome: "verified" })).toBe("The last update installed and verified.");
    expect(lastRunLabel({ ...base, outcome: "rolled-back" })).toBe("The last update failed and rolled back.");
    expect(lastRunLabel({ ...base, outcome: "refused" })).toBe("The last update was refused.");
    expect(lastRunLabel({ ...base, outcome: "failed" })).toBe("The last update did not finish.");
    expect(lastRunLabel(null)).toBeNull();
  });

  it("adds when a run finished, and keeps the updater's own message off the card", () => {
    const finishedAt = "2026-09-13T18:04:00.000Z";
    const when = new Date(finishedAt)
      .toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const run = {
      runId: "r",
      startedAt: "",
      finishedAt,
      outcome: "failed" as const,
      message: "bash update-botfleet-mac.mjs: pnpm package:mac:local failed with exit 1",
    };
    // The headline gets a "when", never the updater's own sentence.
    expect(lastRunLabel(run)).toBe(`The last update did not finish.\u00a0 ${when}`);
    // The raw message lives here instead, for a hover or a details view.
    expect(lastRunDetail(run)).toBe(run.message);
    expect(lastRunDetail({ ...run, message: "" })).toBeNull();
    expect(lastRunDetail(null)).toBeNull();
    // A malformed or missing timestamp falls back to the headline alone,
    // rather than printing "Invalid Date".
    expect(lastRunLabel({ ...run, finishedAt: "not a date" })).toBe("The last update did not finish.");
    expect(lastRunLabel({ ...run, finishedAt: "" })).toBe("The last update did not finish.");
  });

  it("explains an idle card without pretending it checked", () => {
    expect(idleLabel(status({ checkedAt: null }))).toBe("This computer has not checked for a newer build yet.");
    expect(idleLabel(status())).toBe("BotFleet is on the newest build this computer knows about.");
    expect(idleLabel(status({
      capabilities: { canCheck: false, canRun: false, reasons: ["Updating from this computer is macOS only."] },
    }))).toBe("Updating from this computer is macOS only.");
  });

  it("keeps a failed check on screen across a remount", () => {
    const reason = "Could not reach the update source.\u00a0 fatal: unable to access origin.";
    // Right after the failed check: the hook holds the 502's reason.
    expect(visibleUpdateError(reason, status({ checkError: reason }))).toBe(reason);
    // After Settings is closed and reopened: only the hydrated status knows.
    expect(visibleUpdateError(null, status({ checkError: reason }))).toBe(reason);
    // A stale "up to date" must never be the only thing a remount shows.
    expect(idleLabel(status({ checkError: reason }))).toBe("BotFleet is on the newest build this computer knows about.");
    // A check that worked, and a status from a harness that never sends the
    // field, both say nothing is wrong.
    expect(visibleUpdateError(null, status())).toBeNull();
    expect(visibleUpdateError(null, status({ checkError: undefined }))).toBeNull();
    expect(visibleUpdateError(null, null)).toBeNull();
    // An install failure is this session's own, and outranks the older check.
    expect(visibleUpdateError("Could not start the update.", status({ checkError: reason })))
      .toBe("Could not start the update.");
  });

  it("says why Install Update is down, from the harness's own sentence", () => {
    const busy = "BotFleet is working right now.\u00a0 The updater will not interrupt a turn in flight.";
    const offer = { sourceCommit: NEXT, aheadBy: 2, commits: [] };
    // Nothing to install, so nothing to explain.
    expect(installBlockedReason(null)).toBeNull();
    expect(installBlockedReason(status())).toBeNull();
    expect(installBlockedReason(status({
      capabilities: { canCheck: true, canRun: false, reasons: [busy] },
    }))).toBeNull();
    // An offer this Mac can take needs no sentence either.
    expect(installBlockedReason(status({ available: offer }))).toBeNull();
    // An offer it cannot: the card used to say "This Mac can build and
    // install it." while the button was conditioned away, and the sidebar's
    // install button quietly ran a check instead.
    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [busy] },
    }))).toBe(busy);
    // A harness that refused without saying why still gets a sentence.
    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [] },
    }))).toBe("This Mac cannot install the update right now.");
    // A run already going is described by the run, not by this.
    expect(installBlockedReason(status({
      available: offer,
      running: { runId: "r", startedAt: "", step: "Building", logTail: [] },
      capabilities: { canCheck: true, canRun: false, reasons: ["An update is already running."] },
    }))).toBeNull();
    // No detail for a run already in flight either.
    expect(installBlockedReasonDetail(status({
      available: offer,
      running: { runId: "r", startedAt: "", step: "Building", logTail: [] },
      capabilities: { canCheck: true, canRun: false, reasons: ["An update is already running."] },
    }))).toBeNull();
  });

  it("says an install pauses busy bots only when Install is actually available", () => {
    const updaterOutdated = "The updater in /Users/jay/Code/BotFleet predates this build."
      + "  Run it once from a terminal to pick up the new one.";
    const offer = { sourceCommit: NEXT, aheadBy: 2, commits: [] };
    // Busy is not a blocker: Install stays available and says it will pause.
    expect(installPausesWork(status({
      available: offer,
      capabilities: { canCheck: true, canRun: true, reasons: [], codes: [], busy: true },
    }))).toBe(true);
    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: true, canRun: true, reasons: [], codes: [], busy: true },
    }))).toBeNull();
    // A structural blocker wins, and the busy copy never replaces its guidance.
    expect(installPausesWork(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [updaterOutdated], codes: ["updater-outdated"], busy: true },
    }))).toBe(false);
    // Nothing to install, a run in flight, an idle Mac, or an older harness
    // that never says `busy`: nothing to pause.
    expect(installPausesWork(null)).toBe(false);
    expect(installPausesWork(status({ capabilities: { canCheck: true, canRun: true, reasons: [], busy: true } }))).toBe(false);
    expect(installPausesWork(status({
      available: offer,
      running: { runId: "r", startedAt: "", step: "Building", logTail: [] },
      capabilities: { canCheck: true, canRun: true, reasons: [], busy: true },
    }))).toBe(false);
    expect(installPausesWork(status({ available: offer }))).toBe(false);
    expect(PAUSES_WORK_COPY).not.toMatch(/agent/i);
  });

  it("maps a structural refusal to product copy, and keeps the harness's own sentence for hover", () => {
    const offer = { sourceCommit: NEXT, aheadBy: 2, commits: [] };
    const checkoutMissing = "The always-on checkout is not at /Users/jay/Code/BotFleet.";
    const updaterMissing = "The updater is not installed at "
      + "/Users/jay/Code/BotFleet/scripts/update-botfleet-mac.mjs.";
    const updaterOutdated = "The updater in /Users/jay/Code/BotFleet predates this build."
      + "  Run it once from a terminal to pick up the new one.";

    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: false, canRun: false, reasons: [checkoutMissing], codes: ["checkout-missing"] },
    }))).toBe("This Mac's BotFleet folder is missing.");
    expect(installBlockedReasonDetail(status({
      available: offer,
      capabilities: { canCheck: false, canRun: false, reasons: [checkoutMissing], codes: ["checkout-missing"] },
    }))).toBe(checkoutMissing);

    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [updaterMissing], codes: ["updater-missing"] },
    }))).toBe("The updater is not installed on this Mac.");
    expect(installBlockedReasonDetail(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [updaterMissing], codes: ["updater-missing"] },
    }))).toBe(updaterMissing);

    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [updaterOutdated], codes: ["updater-outdated"] },
    }))).toBe("This Mac's updater is out of date.  Update from this Mac once to pick up the new one.");
    expect(installBlockedReasonDetail(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [updaterOutdated], codes: ["updater-outdated"] },
    }))).toBe(updaterOutdated);

    // An older harness with no `codes` array falls back to its own sentence,
    // unchanged — and there is nothing extra to add on hover.
    const busy = "BotFleet is working right now.  The updater will not interrupt a turn in flight.";
    expect(installBlockedReason(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [busy] },
    }))).toBe(busy);
    expect(installBlockedReasonDetail(status({
      available: offer,
      capabilities: { canCheck: true, canRun: false, reasons: [busy] },
    }))).toBeNull();
  });

  it("drops a failure the harness has already superseded", () => {
    const reason = "Could not reach the update source.\u00a0 fatal: unable to access origin.";
    // The check succeeded somewhere else — another window, or the sidebar —
    // and the status that arrived says so.  Without this the red sentence sat
    // next to a subtitle the successful check had already replaced.
    expect(keepLocalError(reason, status())).toBeNull();
    // A status that still carries the failure is not a recovery.
    expect(keepLocalError(reason, status({ checkError: reason }))).toBe(reason);
    // Nothing to keep is still nothing to keep.
    expect(keepLocalError(null, status({ checkError: reason }))).toBeNull();
    expect(keepLocalError(null, status())).toBeNull();
  });

  it("only floats the popup when something is worth interrupting for", () => {
    expect(bannerIsActionable(null)).toBe(false);
    expect(bannerIsActionable(status())).toBe(false);
    expect(bannerIsActionable(status({ available: { sourceCommit: NEXT, aheadBy: 2, commits: [] } }))).toBe(true);
    expect(bannerIsActionable(status({
      running: { runId: "r", startedAt: "", step: "Building", logTail: [] },
    }))).toBe(true);
    const finished = { runId: "r", startedAt: "", finishedAt: "", message: "" };
    expect(bannerIsActionable(status({ lastRun: { ...finished, outcome: "verified" } }))).toBe(false);
    expect(bannerIsActionable(status({ lastRun: { ...finished, outcome: "rolled-back" } }))).toBe(true);
  });
});

describe("talking to the harness", () => {
  it("treats a harness that has no such route as no answer at all", async () => {
    expect(await fetchUpdateStatus(async () => response({ error: "no route" }, { status: 404 }))).toBeNull();
    expect(await fetchUpdateStatus(async () => response({ hello: true }))).toBeNull();
    expect(await fetchUpdateStatus(async () => {
      throw new Error("offline");
    })).toBeNull();
    expect(await fetchUpdateStatus(async () => response(status()))).toMatchObject({ installed: { version: "1.0.30" } });
  });

  it("sends JSON so the request is never a simple cross-origin form post", async () => {
    let seen: RequestInit | undefined;
    await requestUpdateCheck(async (_input, init) => {
      seen = init;
      return response(status());
    });
    expect(seen?.method).toBe("POST");
    expect(seen?.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("carries the un-refreshed status through a failed check", async () => {
    const known = status({ available: { sourceCommit: NEXT, aheadBy: 2, commits: [] } });
    const failure = await requestUpdateCheck(async () =>
      response({ error: "Could not reach the update source.", status: known }, { status: 502 }))
      .then(() => null, (error: unknown) => error as Error & { status?: UpdateStatus });
    expect(failure?.message).toBe("Could not reach the update source.");
    // The card keeps saying what it last knew rather than blanking.
    expect(failure?.status).toEqual(known);
  });

  it("returns the harness's refusal WITH the status that explains it", async () => {
    // The 409 carries the status showing the run already in flight.  Throwing
    // the error and dropping it left the UI saying "already running" with no
    // run on screen.
    const running = status({
      running: { runId: "run_one", startedAt: "", step: "Building and signing the app", logTail: [] },
    });
    const refused = await requestUpdateRun({}, async () =>
      response({ error: "An update is already running.", status: running }, { status: 409 }));
    expect(refused).toEqual({
      ok: false,
      error: "An update is already running.",
      status: running,
    });
  });

  it("still answers when a refusal carries no status", async () => {
    const refused = await requestUpdateRun({}, async () => response({ error: "nope" }, { status: 409 }));
    expect(refused).toEqual({ ok: false, error: "nope", status: null });
    const unexplained = await requestUpdateRun({}, async () => response({}, { status: 503 }));
    expect(unexplained).toMatchObject({ ok: false, error: "Could not start the update (503)." });
  });

  it("asks for a forced run only when told to", async () => {
    const bodies: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return response({ runId: "run_one", status: status() }, { status: 202 });
    };
    const started = await requestUpdateRun({}, fetcher);
    expect(started.ok && started.runId).toBe("run_one");
    await requestUpdateRun({ force: true }, fetcher);
    expect(bodies).toEqual(["{}", '{"force":true}']);
  });

  it("rejects a 202 that does not describe the run it started", async () => {
    await expect(requestUpdateRun({}, async () => response({ runId: "run_one" }, { status: 202 })))
      .rejects.toThrow("did not describe it");
  });

  it("recognises a status by shape, not by trust", () => {
    expect(isUpdateStatus(status())).toBe(true);
    expect(isUpdateStatus({ installed: { version: "1.0.30" } })).toBe(false);
    expect(isUpdateStatus("<!doctype html>")).toBe(false);
  });
});
