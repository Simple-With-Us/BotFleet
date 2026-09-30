// execCli's deadlines, and what a failed probe means.  Children here are
// plain /bin tools in a temp dir: nothing touches a real engine CLI.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyVersionProbeFailure, execCli, isProbeTimeout } from "./procs.ts";

type Result = { err: (Error & { timedOut?: boolean; killed?: boolean }) | null; stdout: string };

function run(cli: string, args: string[], timeout: number, killSignal?: NodeJS.Signals): Promise<Result> {
  return new Promise((resolve) => {
    execCli(cli, args, { timeout, ...(killSignal ? { killSignal } : {}) }, (err, stdout) =>
      resolve({ err: err as Result["err"], stdout }),
    );
  });
}

/** Block the event loop — what a paged-out harness does — until the child has
 * finished its work AND the soft deadline is well past. */
function stallUntil(marker: string, minMs: number): void {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (existsSync(marker) && Date.now() - started >= minMs) return;
  }
}

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
    const pending = run(process.execPath, ["-e", `process.stdout.write("2.1.284"); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], 300);
    stallUntil(marker, 1_000);
    const { err, stdout } = await pending;
    expect(err).toBeNull();
    expect(stdout).toBe("2.1.284");
  });

  it("keeps the answer even when the stall outlasts the hard deadline", async () => {
    const marker = join(scratch, "done");
    const pending = run(process.execPath, ["-e", `process.stdout.write("2.1.284"); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], 200);
    stallUntil(marker, 2_600);
    const { err, stdout } = await pending;
    expect(err).toBeNull();
    expect(stdout).toBe("2.1.284");
  });

  it("reports a typed timeout for a child that is genuinely still running", async () => {
    const { err, stdout } = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 300);
    expect(stdout).toBe("");
    expect(err?.timedOut).toBe(true);
    expect(err?.killed).toBe(true);
    expect(isProbeTimeout(err)).toBe(true);
  });

  // Ignoring the kill needs a POSIX signal handler; Windows terminates
  // unconditionally.
  it.skipIf(process.platform === "win32")("settles through the hard deadline when the child ignores the kill", async () => {
    const started = Date.now();
    const { err } = await run(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3000)"], 300);
    expect(Date.now() - started).toBeLessThan(2_900);
    expect(err?.message).toMatch(/did not exit within 300ms/);
    expect(err?.timedOut).toBe(true);
    expect(isProbeTimeout(err)).toBe(true);
  });

  it("settles an exited child whose grandchild still holds the pipes, keeping what it printed", async () => {
    // The child answers and exits; a background process inherits stdout and
    // keeps it open.  The probe must still settle near its soft deadline with
    // the output it read, not hang until the grandchild lets go.
    const started = Date.now();
    const { err, stdout } = await run(process.execPath, ["-e", `process.stdout.write("2.1.284"); require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref()`], 300);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(stdout).toBe("2.1.284");
    expect(err).toBeNull();
  });

  // A signal death (SIGSEGV) has no Windows equivalent.
  it.skipIf(process.platform === "win32")("does not call a child that died on a signal a timeout", async () => {
    const { err } = await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGSEGV')"], 5_000);
    expect(err).not.toBeNull();
    expect(err?.timedOut).not.toBe(true);
    expect(isProbeTimeout(err)).toBe(false);
  });

  it("does not call a fast non-zero exit a timeout", async () => {
    const { err } = await run(process.execPath, ["-e", "process.exit(3)"], 5_000);
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
