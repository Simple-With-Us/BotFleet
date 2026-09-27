import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTimestampedConsole, resetTimestampedConsoleForTests } from "./console-timestamps.ts";

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

interface ConsoleCallLog {
  log: unknown[][];
  info: unknown[][];
  warn: unknown[][];
  error: unknown[][];
}

beforeEach(() => {
  resetTimestampedConsoleForTests();
});

afterEach(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  if (originalIsTTYDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTYDescriptor);
  }
  resetTimestampedConsoleForTests();
});

describe("installTimestampedConsole", () => {
  it("prefixes console.log with an ISO timestamp when stdout is not a TTY", () => {
    setTTY(false);
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    installTimestampedConsole();

    console.log("[telemetry] hello");

    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[telemetry\] hello$/);
  });

  it("leaves console.log untouched when stdout is a TTY", () => {
    setTTY(true);
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    installTimestampedConsole();

    console.log("[telemetry] hello");

    expect(calls).toEqual([["[telemetry] hello"]]);
  });

  it("does not double-prefix a line the companion sidecar already timestamped", () => {
    setTTY(false);
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    installTimestampedConsole();

    console.log("[2026-09-24T12:00:00.000Z] [companion] already stamped");

    expect(calls).toEqual([["[2026-09-24T12:00:00.000Z] [companion] already stamped"]]);
  });

  it("passes through a non-string first argument unprefixed", () => {
    setTTY(false);
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    installTimestampedConsole();

    const obj = { hello: "world" };
    console.log(obj, "extra");

    expect(calls).toEqual([[obj, "extra"]]);
  });

  it("prefixes only the first argument, preserving the rest", () => {
    setTTY(false);
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    installTimestampedConsole();

    console.warn("[antigravity-quota] poll failed: %s", "boom");

    expect(calls).toHaveLength(1);
    const [first, ...rest] = calls[0]!;
    expect(String(first)).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] \[antigravity-quota\] poll failed: %s$/);
    expect(rest).toEqual(["boom"]);
  });

  it("covers log, info, warn, and error", () => {
    setTTY(false);
    const calls: ConsoleCallLog = { log: [], info: [], warn: [], error: [] };
    console.log = (...args: unknown[]) => {
      calls.log.push(args);
    };
    console.info = (...args: unknown[]) => {
      calls.info.push(args);
    };
    console.warn = (...args: unknown[]) => {
      calls.warn.push(args);
    };
    console.error = (...args: unknown[]) => {
      calls.error.push(args);
    };
    installTimestampedConsole();

    console.log("a");
    console.info("b");
    console.warn("c");
    console.error("d");

    for (const method of ["log", "info", "warn", "error"] as const) {
      expect(calls[method]).toHaveLength(1);
      expect(String(calls[method]![0]![0])).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] [a-d]$/);
    }
  });

  it("is idempotent: installing twice does not double-prefix", () => {
    setTTY(false);
    const calls: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    installTimestampedConsole();
    installTimestampedConsole();

    console.log("[telemetry] hello");

    expect(calls).toHaveLength(1);
    const timestampCount = (String(calls[0]![0]).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? []).length;
    expect(timestampCount).toBe(1);
  });
});
