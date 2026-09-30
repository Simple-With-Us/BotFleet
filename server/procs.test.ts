// execCli's deadlines, and what a failed probe means.  Children here are
// plain /bin tools in a temp dir: nothing touches a real engine CLI.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyVersionProbeFailure, execCli, isProbeTimeout, KNOWN_VERSION_MAX_AGE_MS, LastKnownVersion } from "./procs.ts";

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

  // POSIX signals: SIGWINCH has no Windows equivalent.
  it.skipIf(process.platform === "win32")(
    "sends the requested kill signal, and settles through the hard deadline when the child ignores it",
    async () => {
      // SIGWINCH's default action is to ignore it, so the child survives the
      // soft kill from its very first instruction — no handler to install,
      // nothing that depends on how fast Node starts on a loaded Mac.  Had
      // execCli sent SIGTERM instead, the child would die and the error
      // would not be the hard deadline's.
      const started = Date.now();
      const { err } = await run(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], 300, "SIGWINCH");
      // Soft 300 ms + HARD_EXEC_GRACE_MS 2 s, with room for a late timer;
      // far short of the child's own 20 s.
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(err?.message).toMatch(/did not exit within 300ms/);
      expect(err?.timedOut).toBe(true);
      expect(isProbeTimeout(err)).toBe(true);
    },
    30_000,
  );

  it("settles an exited child whose grandchild still holds the pipes, keeping what it printed", async () => {
    // The child answers and exits; a background process inherits stdout and
    // keeps it open.  The probe must still settle soon after its soft
    // deadline with the output it read, not hang until the grandchild lets
    // go.  The loop is held until the child has printed and handed off (its
    // marker), so the deadline never lands before a slow Node start on a
    // loaded Mac has even run the child.
    const marker = join(scratch, "grandchild-pid");
    const child = [
      'process.stdout.write("2.1.284");',
      'const g = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });',
      "g.unref();",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(g.pid));`,
    ].join(" ");
    const started = Date.now();
    const pending = run(process.execPath, ["-e", child], 1_000);
    stallUntil(marker, 0);
    // And a moment more, for the child to finish exiting after its marker.
    const exitedBy = Date.now() + 500;
    while (Date.now() < exitedBy) {
      // hold the loop
    }
    try {
      const { err, stdout } = await pending;
      // Far short of the grandchild's 60 s.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(stdout).toBe("2.1.284");
      expect(err).toBeNull();
    } finally {
      try {
        process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 60_000);

  it("still times out a child that is running when a late soft deadline looks again", async () => {
    // The loop stalls past the soft deadline while the child keeps running:
    // the late deadline looks once more after a short grace, then kills it.
    const marker = join(scratch, "started");
    const pending = run(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, ""); setTimeout(() => {}, 20000)`], 300);
    stallUntil(marker, 1_000);
    const { err, stdout } = await pending;
    expect(stdout).toBe("");
    expect(err?.timedOut).toBe(true);
    expect(isProbeTimeout(err)).toBe(true);
  }, 30_000);

  // A signal death (SIGSEGV) has no Windows equivalent.
  it.skipIf(process.platform === "win32")("does not call a child that died on a signal a timeout", async () => {
    // A budget no Node start could outrun, even on a loaded Mac.
    const { err } = await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGSEGV')"], 20_000);
    expect(err).not.toBeNull();
    expect(err?.timedOut).not.toBe(true);
    expect(isProbeTimeout(err)).toBe(false);
  }, 60_000);

  it("does not call a fast non-zero exit a timeout", async () => {
    const { err } = await run(process.execPath, ["-e", "process.exit(3)"], 20_000);
    expect(err).not.toBeNull();
    expect(isProbeTimeout(err)).toBe(false);
  }, 60_000);
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

describe("LastKnownVersion", () => {
  it("stands in for a probe that gave no answer only until it is too old", () => {
    let now = 1_000;
    const remembered = new LastKnownVersion(KNOWN_VERSION_MAX_AGE_MS, () => now);
    expect(remembered.get()).toBeNull();
    remembered.record("2.1.284");
    now += KNOWN_VERSION_MAX_AGE_MS;
    expect(remembered.get()).toBe("2.1.284");
    // A CLI that has not answered for longer than that has wedged: its old
    // version no longer keeps it "available".
    now += 1;
    expect(remembered.get()).toBeNull();
    // A fresh answer restarts the clock.
    remembered.record("2.1.285");
    now += 10;
    expect(remembered.get()).toBe("2.1.285");
  });

  it("forgets on a definitive failure", () => {
    const remembered = new LastKnownVersion(60_000, () => 0);
    remembered.record("1.0.0");
    remembered.forget();
    expect(remembered.get()).toBeNull();
  });
});
