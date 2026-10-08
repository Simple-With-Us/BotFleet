import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySentryConfig,
  isSentryActive,
  resetSentryForTests,
  sentryTestLoader,
  setSentryLoaderForTests,
  type SentryNode,
} from "./sentry.ts";
import {
  awaitPendingCheckInCloses,
  checkInRoutineFinish,
  checkInRoutineStart,
  routineMonitorConfig,
  routineMonitorSlug,
} from "./sentry-crons.ts";
import type { Routine, RoutineRun } from "./routines.ts";

type SentryCheckIn = Parameters<SentryNode["captureCheckIn"]>[0];
type SentryMonitorConfig = Parameters<SentryNode["captureCheckIn"]>[1];

interface FakeSentryClient {
  getDsn(): { host?: string } | undefined;
  getOptions(): { enabled: boolean };
  getTransport(): undefined;
}

interface FakeSentrySdk {
  init(): void;
  close(): Promise<boolean>;
  addIntegration(): void;
  consoleLoggingIntegration(): { name: string };
  captureCheckIn(checkIn: SentryCheckIn, monitorConfig?: SentryMonitorConfig): string;
  isEnabled?(): boolean;
  getClient?(): FakeSentryClient;
}

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    name: "Housekeeper sweep",
    prompt: "check disk and RAM",
    botId: "bot-1",
    runOn: "bot",
    enabled: true,
    schedule: { type: "daily", time: "09:30", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    durationMinutes: 30,
    nextRunAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function run(over: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: "run-1",
    routineId: "routine-1",
    routineName: "Housekeeper sweep",
    botId: "bot-1",
    runOn: "bot",
    scheduledFor: 0,
    status: "running",
    manual: false,
    triggerSource: "schedule",
    createdAt: 0,
    ...over,
  };
}

afterEach(() => {
  resetSentryForTests();
});

describe("routineMonitorSlug", () => {
  it("slugifies the routine name and appends a short id so same-named routines never collide", () => {
    const a = routineMonitorSlug(run({ routineId: "aaaaaaaa-1111", routineName: "Monitor" }));
    const b = routineMonitorSlug(run({ routineId: "bbbbbbbb-2222", routineName: "Monitor" }));
    expect(a).toMatch(/^botfleet-monitor-/);
    expect(b).toMatch(/^botfleet-monitor-/);
    expect(a).not.toBe(b);
  });

  it("falls back to a safe slug for a blank or unicode-only name", () => {
    expect(routineMonitorSlug(run({ routineName: "" }))).toMatch(/^botfleet-routine-/);
  });
});

describe("routineMonitorConfig", () => {
  it("returns undefined for a one-off routine — nothing recurs for Sentry to watch", () => {
    expect(routineMonitorConfig(routine({ schedule: { type: "once", at: 12345 } }))).toBeUndefined();
  });

  it("builds a crontab schedule from a daily routine's own time and weekdays", () => {
    const config = routineMonitorConfig(
      routine({ schedule: { type: "daily", time: "09:05", weekdays: [1, 2, 3, 4, 5], timeZone: "America/Chicago" } }),
    );
    expect(config?.schedule).toEqual({ type: "crontab", value: "5 9 * * 1,2,3,4,5" });
    expect(config?.timezone).toBe("America/Chicago");
    expect(config?.maxRuntime).toBeGreaterThanOrEqual(30);
  });

  it("uses a wildcard day field for every day, not an explicit 0-6 list", () => {
    const config = routineMonitorConfig(
      routine({ schedule: { type: "daily", time: "00:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } }),
    );
    expect(config?.schedule).toEqual({ type: "crontab", value: "0 0 * * *" });
  });

  it("falls back to the host timezone when the routine has none stored", () => {
    const config = routineMonitorConfig(routine({ schedule: { type: "daily", time: "01:00", weekdays: [1] } }));
    expect(config?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("checkInRoutineStart / checkInRoutineFinish", () => {
  it("is a no-op without an active Sentry client", () => {
    expect(isSentryActive()).toBe(false);
    expect(checkInRoutineStart(run(), routine())).toBeUndefined();
    // Must never throw even though nothing was opened.
    checkInRoutineFinish(run(), "whatever", true);
  });

  async function activateFakeSentry() {
    const checkIns: Array<{ checkIn: SentryCheckIn; monitorConfig?: SentryMonitorConfig }> = [];
    // SAFETY: empty object shell — runtime only calls the members stamped below.
    const sdk = Object.assign({} as FakeSentrySdk, {
      init() {},
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
      captureCheckIn(checkIn: SentryCheckIn, monitorConfig?: SentryMonitorConfig) {
        checkIns.push({ checkIn, monitorConfig });
        return "check-in-id-1";
      },
    });
    setSentryLoaderForTests(sentryTestLoader(sdk));
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 1,
      logsEnabled: false,
      source: "config",
    });
    return checkIns;
  }

  it("upserts a monitor and opens an in_progress check-in for a recurring routine", async () => {
    const checkIns = await activateFakeSentry();
    const theRun = run();
    const id = checkInRoutineStart(theRun, routine());
    expect(id).toBe("check-in-id-1");
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0].checkIn).toMatchObject({
      monitorSlug: routineMonitorSlug(theRun),
      status: "in_progress",
    });
    expect(checkIns[0].monitorConfig).toMatchObject({ schedule: { type: "crontab" } });
  });

  it("opens nothing for a one-off routine even with Sentry active", async () => {
    const checkIns = await activateFakeSentry();
    const id = checkInRoutineStart(run(), routine({ schedule: { type: "once", at: 1 } }));
    expect(id).toBeUndefined();
    expect(checkIns).toHaveLength(0);
  });

  it("closes with ok on success and error on failure, using the same monitor slug", async () => {
    const checkIns = await activateFakeSentry();
    const theRun = run();
    checkInRoutineFinish(theRun, "check-in-id-1", true);
    checkInRoutineFinish(theRun, "check-in-id-1", false);
    expect(checkIns).toHaveLength(2);
    expect(checkIns[0].checkIn).toMatchObject({
      monitorSlug: routineMonitorSlug(theRun),
      status: "ok",
      checkInId: "check-in-id-1",
    });
    expect(checkIns[1].checkIn).toMatchObject({ status: "error", checkInId: "check-in-id-1" });
  });

  it("returns undefined when captureCheckIn would fabricate an id on a disabled client", async () => {
    // SAFETY: empty object shell — runtime only calls the members stamped below.
    const sdk = Object.assign({} as FakeSentrySdk, {
      init() {},
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
      isEnabled: () => false,
      getClient: () => ({
        getDsn: () => ({}),
        getOptions: () => ({ enabled: true }),
        getTransport: () => undefined,
      }),
      captureCheckIn() {
        return "fabricated-check-in-id";
      },
    });
    setSentryLoaderForTests(sentryTestLoader(sdk));
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 1,
      logsEnabled: false,
      source: "config",
    });
    expect(isSentryActive()).toBe(false);
    expect(checkInRoutineStart(run(), routine())).toBeUndefined();
  });

  it("never throws when the SDK call itself throws", async () => {
    const sdk = Object.assign({} as FakeSentrySdk, {
      init() {},
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
      captureCheckIn() {
        throw new Error("ingest unreachable");
      },
    });
    setSentryLoaderForTests(sentryTestLoader(sdk));
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 1,
      logsEnabled: false,
      source: "config",
    });
    expect(checkInRoutineStart(run(), routine())).toBeUndefined();
    expect(() => checkInRoutineFinish(run(), "x", true)).not.toThrow();
  });
});

/** A fake SDK whose check-in close can be made to fail its way out of the
 *  transport, the way a saturated host drops a buffered envelope.  `flush`
 *  answers from `flushResults` and repeats the last answer forever once that
 *  list runs out. */
async function activateFlushableSentry(flushResults: boolean[]) {
  const checkIns: SentryCheckIn[] = [];
  const flushCalls: Array<number | undefined> = [];
  // SAFETY: empty object shell — runtime only calls the members stamped below.
  const sdk = Object.assign({} as FakeSentrySdk, {
    init() {},
    close() {
      return Promise.resolve(true);
    },
    addIntegration() {},
    consoleLoggingIntegration() {
      return { name: "ConsoleLogs" };
    },
    captureCheckIn(checkIn: SentryCheckIn) {
      checkIns.push(checkIn);
      return "check-in-id-1";
    },
    async flush(timeout?: number) {
      flushCalls.push(timeout);
      return flushResults[Math.min(flushCalls.length - 1, flushResults.length - 1)] ?? true;
    },
  });
  setSentryLoaderForTests(sentryTestLoader(sdk));
  await applySentryConfig({
    dsn: "https://abc123@o0.ingest.sentry.io/1",
    enabled: true,
    environment: "test",
    tracesSampleRate: 1,
    logsEnabled: false,
    source: "config",
  });
  return { checkIns, flushCalls };
}

/** Let the detached close run to completion: 4 flush attempts, 3 backoffs
 *  (5s + 30s + 2m), well inside this budget. */
const RETRY_BUDGET_MS = 200_000;

describe("checkInRoutineFinish close delivery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends the same close until a flush confirms it left the process", async () => {
    vi.useFakeTimers();
    const { checkIns, flushCalls } = await activateFlushableSentry([false, false, true]);
    const theRun = run();
    checkInRoutineFinish(theRun, "check-in-id-1", true);
    const settled = awaitPendingCheckInCloses();
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS);
    await settled;

    // The first close, then one re-send per refused flush — all the same id,
    // so Sentry treats a duplicate as the same check-in, not a new one.
    expect(checkIns).toHaveLength(3);
    expect(checkIns.map((checkIn) => ("checkInId" in checkIn ? checkIn.checkInId : undefined))).toEqual([
      "check-in-id-1",
      "check-in-id-1",
      "check-in-id-1",
    ]);
    expect(checkIns.every((checkIn) => checkIn.status === "ok")).toBe(true);
    expect(checkIns.every((checkIn) => checkIn.monitorSlug === routineMonitorSlug(theRun))).toBe(true);
    expect(flushCalls).toHaveLength(3);
    // A 10s budget per attempt: long enough for a slow WAN, short enough
    // that the run is never gated on it.
    expect(new Set(flushCalls)).toEqual(new Set([10_000]));
  });

  it("gives up after three retries and logs one line naming the slug and run", async () => {
    vi.useFakeTimers();
    const { checkIns } = await activateFlushableSentry([false]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const theRun = run({ id: "run-471ead38" });
    try {
      checkInRoutineFinish(theRun, "check-in-id-1", false);
      const settled = awaitPendingCheckInCloses();
      await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS);
      await settled;

      expect(checkIns).toHaveLength(4);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual([
        `[sentry-crons] check-in close failed slug=${routineMonitorSlug(theRun)} run=run-471ead38`,
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("is a no-op — no close, no flush, no retry — when Sentry is inactive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(isSentryActive()).toBe(false);
      checkInRoutineFinish(run(), "check-in-id-1", true);
      await awaitPendingCheckInCloses();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
