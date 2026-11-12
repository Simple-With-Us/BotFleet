// Process-level crash handling for the harness.
//
// Without a handler, an unhandled rejection or uncaught exception kills the
// process under Node's defaults with no Sentry capture, and the log line is
// whatever Node prints.  This logs the failure, captures it to Sentry with
// the same flush-then-exit pattern the listen-error path uses, and exits 1
// so a supervisor restarts a wedged process instead of leaving it half-alive.
// A second crash while the first is being reported must not re-enter.

import type { SentryNode } from "./sentry.ts";

export type ProcessCrashKind = "uncaughtException" | "unhandledRejection";

export type CrashSentry = Pick<SentryNode, "captureException" | "flush">;

export interface ProcessCrashHandlerDeps {
  logError: (message: string, error: Error) => void;
  getSentry: () => CrashSentry | null;
  exit: (code: number) => void;
  flushTimeoutMs?: number;
}

export function createProcessCrashHandler(deps: ProcessCrashHandlerDeps) {
  const flushTimeoutMs = deps.flushTimeoutMs ?? 2000;
  let exiting = false;
  return async (kind: ProcessCrashKind, error: Error): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      deps.logError(`[process] ${kind}:`, error);
    } catch {
      // Logging must never stand between a crash and the exit.
    }
    try {
      const sentry = deps.getSentry();
      if (sentry) {
        sentry.captureException(error, { tags: { component: "harness-process", kind } });
        await sentry.flush(flushTimeoutMs);
      }
    } catch {
      // A Sentry failure must never stand between a crash and the exit.
    }
    deps.exit(1);
  };
}

export interface CrashHandlerTarget {
  on(event: "uncaughtException", listener: NodeJS.UncaughtExceptionListener): void;
  on(event: "unhandledRejection", listener: NodeJS.UnhandledRejectionListener): void;
}

export function installProcessCrashHandlers(
  deps: ProcessCrashHandlerDeps,
  target: CrashHandlerTarget = process,
): ReturnType<typeof createProcessCrashHandler> {
  const handle = createProcessCrashHandler(deps);
  target.on("uncaughtException", (error) => void handle("uncaughtException", error));
  target.on("unhandledRejection", (reason) => {
    // A rejection reason can be anything; normalize to an Error for the log
    // and Sentry, keeping the original as the cause.
    const error = reason instanceof Error
      ? reason
      : new Error("unhandled rejection", { cause: reason });
    return void handle("unhandledRejection", error);
  });
  return handle;
}
