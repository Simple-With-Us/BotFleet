// execCli's deadlines, and what a failed probe means.  The children here are
// `node -e` one-liners spawned as process.execPath: nothing touches a real
// engine CLI, and nothing depends on a POSIX-only binary.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyVersionProbeFailure, execCli, isProbeTimeout } from "./procs.ts";

type Result = {
  err: (Error & { timedOut?: boolean; killed?: boolean; signal?: string | null }) | null;
  stdout: string;
};

function run(cli: string, args: string[], timeout: number, killSignal?: NodeJS.Signals): Promise<Result> {
  return new Promise((resolve) => {
    execCli(cli, args, { timeout, ...(killSignal ? { killSignal } : {}) }, (err, stdout) =>
      resolve({ err: err as Result["err"], stdout }),
    );
  });
}

/** Spawn `src` with the node binary running these tests.
 *
 * `process.execPath` is the one executable every runner has, on a path
 * env-path already resolves without a shell (an existing file wins over the
 * tokenizer, and whichWin passes a `.exe` through), so the fixture travels
 * the same resolve -> execFile path a real engine CLI takes instead of a
 * stand-in that only proves /bin/sh exists. */
function node(src: string, timeout: number, killSignal?: NodeJS.Signals): Promise<Result> {
  return run(process.execPath, ["-e", src], timeout, killSignal);
}

/** Answer on stdout, then drop `marker`.
 *
 * The marker is written from the write callback, so it only appears once the
 * answer is already in the pipe — the ordering a shell gave us for free with
 * `printf 2.1.284; : > marker`, and the ordering this test needs to be sure
 * the child finished its work before the event loop is stalled under it. */
function answerThen(marker: string): string {
  return `process.stdout.write("2.1.284", () => require("node:fs").writeFileSync(${JSON.stringify(marker)}, ""))`;
}

/** Block the event loop — what a paged-out harness does — until the child has
 * finished its work AND the soft deadline is well past. */
function stallUntil(marker: string, minMs: number): void {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (existsSync(marker) && Date.now() - started >= minMs) return;
  }
}

// These deadlines are about how execCli schedules a timer, blocks the event
// loop, and reaps a child, so the children are deliberately dumb: hold a pipe
// open, refuse to die, die on a signal.  node is the cheapest way to get all
// three and it exists on every OS in the CI matrix, so this suite is not
// quietly POSIX-only — with one exception noted on the test itself.
//
// The budgets below look generous because a `node -e` child costs a few
// hundred ms to reach its first line — two orders of magnitude more than the
// /bin/sh fixtures these replaced — and every case has to leave room for that
// bootstrap, including on a loaded runner.  A deadline that fires while the
// child is still starting does not test the deadline; it tests the spawn.
describe("execCli deadlines", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-procs-test-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps a fast child's answer when the event loop stalls past the soft deadline", async () => {
    // execFile's own timer fired before the poll phase that delivers the
    // finished child's output, destroyed the unread stdout, and reported
    // (null, "") — a working CLI read as "not found".
    const marker = join(scratch, "done");
    const pending = node(answerThen(marker), 2_000);
    stallUntil(marker, 2_800);
    const { err, stdout } = await pending;
    expect(err).toBeNull();
    expect(stdout).toBe("2.1.284");
  });

  it("keeps the answer even when the stall outlasts the hard deadline", async () => {
    const marker = join(scratch, "done");
    // The hard deadline lands at soft + 2000ms = 4000ms, and a deadline that
    // fires less than 500ms late is acted on immediately rather than re-armed,
    // so the stall has to clear 4500ms for the grace path to be the one under
    // test.
    const pending = node(answerThen(marker), 2_000);
    stallUntil(marker, 5_000);
    const { err, stdout } = await pending;
    expect(err).toBeNull();
    expect(stdout).toBe("2.1.284");
  });

  it("reports a typed timeout for a child that is genuinely still running", async () => {
    const { err, stdout } = await node(`setTimeout(() => {}, 5_000)`, 1_000);
    expect(stdout).toBe("");
    expect(err?.timedOut).toBe(true);
    expect(err?.killed).toBe(true);
    expect(isProbeTimeout(err)).toBe(true);
  });

  // The one case Windows cannot stage.  child.kill() there is TerminateProcess,
  // which no process can defer or refuse, so "a child that ignores the kill"
  // has no Windows equivalent and cannot be asserted there.  Windows still runs
  // every other test in this suite; the signal-free cousin of this case — a
  // child killed while a grandchild holds the pipe — is the next test and runs
  // everywhere, which is why the hard deadline is not Windows-only coverage.
  it.skipIf(process.platform === "win32")("settles through the hard deadline when the child ignores the kill", async () => {
    const started = Date.now();
    // The child must be past its bootstrap and have the handler installed
    // before the soft deadline looks for something to kill, so the budget is
    // generous.  The hard deadline lands at 4000ms, well inside the 8s the
    // child would otherwise run for.
    const { err } = await node(`process.on("SIGTERM", () => {}); setTimeout(() => {}, 8_000)`, 2_000);
    expect(Date.now() - started).toBeLessThan(5_500);
    expect(err?.message).toMatch(/did not exit within 2000ms/);
    expect(err?.timedOut).toBe(true);
    expect(isProbeTimeout(err)).toBe(true);
  });

  it("settles an exited child whose grandchild still holds the pipes, keeping what it printed", async () => {
    // The child answers and exits; a background process inherits stdout and
    // keeps it open.  The probe must still settle near its soft deadline with
    // the output it read, not hang until the grandchild lets go.
    const started = Date.now();
    const { err, stdout } = await node(
      `process.stdout.write("2.1.284", () => require("node:child_process")
         .spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { stdio: "inherit" })
         .unref())`,
      2_000,
    );
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(stdout).toBe("2.1.284");
    expect(err).toBeNull();
  });

  it("does not call a child that died on a signal a timeout", async () => {
    // process.abort() is SIGABRT on POSIX and an abnormal non-zero exit on
    // Windows, which has no signals to report.  Either way the child died on
    // its own rather than being timed out, which is what this asserts.
    const { err } = await node(`process.abort()`, 5_000);
    expect(err).not.toBeNull();
    expect(err?.timedOut).not.toBe(true);
    expect(isProbeTimeout(err)).toBe(false);
    if (process.platform !== "win32") expect(err?.signal).toBe("SIGABRT");
  });

  it("does not call a fast non-zero exit a timeout", async () => {
    const { err } = await node(`process.exit(3)`, 5_000);
    expect(err).not.toBeNull();
    expect(isProbeTimeout(err)).toBe(false);
  });
});

describe("classifyVersionProbeFailure", () => {
  const errno = (code: string) => Object.assign(new Error(`spawn x ${code}`), { code });

  it("calls only a missing or unrunnable binary a setup problem", () => {
    expect(classifyVersionProbeFailure(errno("ENOENT"), "codex", "Codex", 5, 20_000)).toEqual({
      kind: "setup",
      reason: "`codex` CLI not found",
    });
    expect(classifyVersionProbeFailure(errno("EACCES"), "codex", "Codex", 5, 20_000).kind).toBe("setup");
    // A node-shebang CLI whose node is gone.
    expect(
      classifyVersionProbeFailure(Object.assign(new Error("exit 127"), { code: 127 }), "codex", "Codex", 5, 20_000),
    ).toEqual({ kind: "setup", reason: "`codex` CLI not found" });
  });

  it("calls a timeout, a kill or no process slots transient — never 'CLI not found'", () => {
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", timedOut: true });
    expect(classifyVersionProbeFailure(killed, "claude", "Claude", 20_010, 20_000)).toEqual({
      kind: "transient",
      reason: "Claude did not answer in time",
    });
    expect(
      classifyVersionProbeFailure(new Error("`claude` did not exit within 20000ms"), "claude", "Claude", 22_000, 20_000).kind,
    ).toBe("transient");
    expect(classifyVersionProbeFailure(errno("EAGAIN"), "claude", "Claude", 5, 20_000)).toEqual({
      kind: "transient",
      reason: "Claude could not be checked right now",
    });
    // Empty output that only arrived after the deadline (an event-loop stall).
    expect(classifyVersionProbeFailure(null, "agy", "Antigravity", 20_500, 20_000).kind).toBe("transient");
  });

  it("calls a crash on a signal a failure, not a slow answer, however long it ran", () => {
    const segv = Object.assign(new Error("Command failed"), { killed: false, signal: "SIGSEGV" });
    expect(classifyVersionProbeFailure(segv, "pi", "Pi", 40, 20_000).kind).toBe("failed");
    expect(classifyVersionProbeFailure(segv, "pi", "Pi", 25_000, 20_000).kind).toBe("failed");
    const abrt = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGABRT" });
    expect(classifyVersionProbeFailure(abrt, "pi", "Pi", 40, 20_000).kind).toBe("failed");
    expect(isProbeTimeout(abrt)).toBe(false);
  });

  it("reports a CLI that ran and failed on its own as a failure, not as missing", () => {
    const exit1 = Object.assign(new Error("Command failed"), { code: 1 });
    const failed = classifyVersionProbeFailure(exit1, "mcode", "MiniMax Code", 40, 20_000);
    expect(failed).toEqual({ kind: "failed", reason: "`mcode --version` failed (exit 1)" });
    expect(classifyVersionProbeFailure(null, "mcode", "MiniMax Code", 40, 20_000).kind).toBe("failed");
  });
});
