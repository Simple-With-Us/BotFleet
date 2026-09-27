import { afterEach, describe, expect, it } from "vitest";
import { applySentryConfig, isSentryActive, resetSentryForTests, setSentryLoaderForTests } from "./sentry.ts";
import {
  checkInRoutineFinish,
  checkInRoutineStart,
  routineMonitorConfig,
  routineMonitorSlug,
} from "./sentry-crons.ts";
import type { Routine, RoutineRun } from "./routines.ts";

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
    const checkIns: Array<{ checkIn: unknown; monitorConfig?: unknown }> = [];
    const sdk = {
      init() {},
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
      captureCheckIn(checkIn: unknown, monitorConfig?: unknown) {
        checkIns.push({ checkIn, monitorConfig });
        return "check-in-id-1";
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => sdk);
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

  it("never throws when the SDK call itself throws", async () => {
    setSentryLoaderForTests(async () =>
      ({
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
      }) as unknown as typeof import("@sentry/node"),
    );
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
