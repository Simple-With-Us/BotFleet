import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createProcessCrashHandler,
  installProcessCrashHandlers,
  type CrashSentry,
} from "./process-crash-handler.ts";

function fakeSentry(overrides: Partial<CrashSentry> = {}): CrashSentry {
  return {
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
    ...overrides,
  };
}

describe("process crash handler", () => {
  it("logs, captures to Sentry, flushes, then exits 1 on an uncaught exception", async () => {
    const order: string[] = [];
    const error = new Error("boom");
    const sentry = fakeSentry({
      captureException: vi.fn(() => { order.push("capture"); return "event-id"; }),
      flush: vi.fn(async () => {
        order.push("flush");
        return true;
      }),
    });
    const handle = createProcessCrashHandler({
      logError: (...args) => order.push(`log:${String(args[0])}`),
      getSentry: () => sentry,
      exit: (code) => order.push(`exit:${code}`),
    });
    await handle("uncaughtException", error);
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { component: "harness-process", kind: "uncaughtException" },
    });
    expect(sentry.flush).toHaveBeenCalledWith(2000);
    expect(order).toEqual(["log:[process] uncaughtException:", "capture", "flush", "exit:1"]);
  });

  it("exits 1 without Sentry on an unhandled rejection", async () => {
    const exit = vi.fn();
    const logError = vi.fn();
    const handle = createProcessCrashHandler({
      logError,
      getSentry: () => null,
      exit,
    });
    const reason = new Error("nope");
    await handle("unhandledRejection", reason);
    expect(logError).toHaveBeenCalledWith("[process] unhandledRejection:", reason);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits 1 when the Sentry flush fails", async () => {
    const exit = vi.fn();
    const handle = createProcessCrashHandler({
      logError: vi.fn(),
      getSentry: () => fakeSentry({ flush: vi.fn(async () => { throw new Error("down"); }) }),
      exit,
    });
    await handle("uncaughtException", new Error("boom"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("ignores a second crash while the first is being reported", async () => {
    const exit = vi.fn();
    const sentry = fakeSentry();
    const handle = createProcessCrashHandler({
      logError: vi.fn(),
      getSentry: () => sentry,
      exit,
    });
    await Promise.all([
      handle("uncaughtException", new Error("first")),
      handle("unhandledRejection", new Error("second")),
    ]);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("registers both process handlers when installed", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installProcessCrashHandlers(
      { logError: vi.fn(), getSentry: () => null, exit },
      target,
    );
    expect(target.listenerCount("uncaughtException")).toBe(1);
    expect(target.listenerCount("unhandledRejection")).toBe(1);
    target.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
