import { describe, expect, it } from "vitest";

import {
  isTransientProbeFailure,
  judgeDesktopProbeFailure,
  problemText,
  realDriverProblems,
  stripAnsi,
} from "./desktop-probe.ts";

const ESC = "\u001b";

/** What a healthy Driver 0.20.0 wrote to cua-driver.error.log on the owner's
 * VPS on 2026-10-07: its update notice (naming the NEWEST release, not the
 * running one), a coloured tracing WARN, and the readiness line. */
const HEALTHY_STARTUP_LOG = [
  "cua-driver v0.34.0 is available (you have v0.20.0)",
  "   Update with: cua-driver update",
  "   Release notes: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.0",
  `${ESC}[2m2026-10-07T13:54:42.869037Z${ESC}[0m ${ESC}[33m WARN${ESC}[0m ${ESC}[2mplatform_linux::overlay${ESC}[0m${ESC}[2m:${ESC}[0m X11 overlay: root reads cannot see this window's own pixels; the overlay will not be drawn`,
  "Cua Driver daemon listening on /opt/ogb/run/cua.sock",
].join("\n");

describe("stripAnsi and problemText", () => {
  it("removes colour codes and the orphaned codes left when ESC was lost", () => {
    expect(stripAnsi(`${ESC}[2m2026-10-07T13:54:42Z${ESC}[0m ${ESC}[33m WARN${ESC}[0m x`)).toBe(
      "2026-10-07T13:54:42Z  WARN x",
    );
    expect(stripAnsi("[2m2026-10-07T13:54:42Z[0m [33m WARN[0m x")).toBe("2026-10-07T13:54:42Z  WARN x");
  });

  it("leaves JSON arrays and bracketed words alone", () => {
    expect(stripAnsi("[1,2,3] [mem] [12 m]")).toBe("[1,2,3] [mem] [12 m]");
  });

  it("collapses whitespace and bounds the length", () => {
    expect(problemText(`  a\n\n b\t c  `)).toBe("a b c");
    expect(problemText("x".repeat(900), 50)).toHaveLength(50);
  });
});

describe("realDriverProblems", () => {
  it("is empty for a healthy startup: banner, WARN tracing and the readiness line", () => {
    expect(realDriverProblems(HEALTHY_STARTUP_LOG)).toBe("");
  });

  it("is empty for banner and WARN lines alone, with no readiness line yet", () => {
    const withoutReady = HEALTHY_STARTUP_LOG.split("\n").slice(0, 4).join("\n");
    expect(realDriverProblems(withoutReady)).toBe("");
  });

  it("is empty for INFO, DEBUG and TRACE tracing and the first-run telemetry notice", () => {
    const log = [
      "2026-10-07T13:54:41.000000Z  INFO cua_driver: starting",
      "2026-10-07T13:54:41.100000Z DEBUG cua_driver: probing",
      "TRACE socket: bound",
      "Cua Driver sends content-free product telemetry by default.  Run `cua-driver telemetry disable` to stop it.",
    ].join("\n");
    expect(realDriverProblems(log)).toBe("");
  });

  it("keeps an ERROR line and strips its colour", () => {
    const log = `${HEALTHY_STARTUP_LOG.split("\n")[0]}\n${ESC}[31m2026-10-07T13:55:00Z ERROR${ESC}[0m platform_linux: cannot open display :1`;
    const problem = realDriverProblems(log);
    expect(problem).toBe("2026-10-07T13:55:00Z ERROR platform_linux: cannot open display :1");
    expect(problem).not.toContain(ESC);
  });

  it("ignores a fault that a later readiness line recovered from, but not one after it", () => {
    const recovered = [
      "2026-10-07T13:54:00Z ERROR platform_linux: cannot open display :1",
      "Cua Driver daemon listening on /opt/ogb/run/cua.sock",
    ].join("\n");
    expect(realDriverProblems(recovered)).toBe("");
    const crashedAfter = `${recovered}\n2026-10-07T13:56:00Z ERROR cua_driver: worker panicked`;
    expect(realDriverProblems(crashedAfter)).toBe("2026-10-07T13:56:00Z ERROR cua_driver: worker panicked");
  });

  it("keeps lines it does not recognise, so a plain start-script message still surfaces", () => {
    expect(realDriverProblems("X display :1 did not become ready within 45 seconds\n")).toBe(
      "X display :1 did not become ready within 45 seconds",
    );
  });

  it("treats an indented line after a WARN as that WARN wrapping", () => {
    const log = "2026-10-07T13:54:42Z  WARN overlay: could not draw\n      the overlay on this display\n";
    expect(realDriverProblems(log)).toBe("");
  });
});

describe("isTransientProbeFailure", () => {
  it("recognises the VPS runner's own timeout and ssh-layer failures", () => {
    expect(isTransientProbeFailure(new Error("Docker-over-SSH command timed out"))).toBe(true);
    expect(isTransientProbeFailure(new Error("ssh: connect to host vps port 22: Operation timed out"))).toBe(true);
    expect(isTransientProbeFailure(new Error("kex_exchange_identification: Connection closed by remote host"))).toBe(true);
  });

  it("recognises an execFile timeout kill by its fields, since its message never says timed out", () => {
    const killed = Object.assign(new Error("Command failed: docker exec botfleet-computer-jay cua-driver --version"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    expect(isTransientProbeFailure(killed)).toBe(true);
  });

  it("does not call a real driver fault transient", () => {
    expect(isTransientProbeFailure(new Error("unexpected CUA Driver version"))).toBe(false);
    expect(isTransientProbeFailure(new Error("CUA health report is failed"))).toBe(false);
    // From `cua-driver status --socket` this means the daemon is down.
    expect(isTransientProbeFailure(new Error("connect: Connection refused"))).toBe(false);
    expect(isTransientProbeFailure(new Error("something else"))).toBe(false);
  });
});

describe("judgeDesktopProbeFailure", () => {
  const timeout = new Error("Docker-over-SSH command timed out");

  it("reports a timed-out probe with no readable log as unreachable, never a failed start", () => {
    expect(judgeDesktopProbeFailure(timeout, null)).toEqual({ desktopError: null, unreachable: true });
  });

  it("reports a timed-out probe with a healthy log as unreachable too", () => {
    expect(judgeDesktopProbeFailure(timeout, HEALTHY_STARTUP_LOG)).toEqual({ desktopError: null, unreachable: true });
  });

  it("lets a real fault in the log win over a timeout", () => {
    expect(judgeDesktopProbeFailure(timeout, "2026-10-07T13:56:00Z ERROR cua_driver: worker panicked")).toEqual({
      desktopError: "2026-10-07T13:56:00Z ERROR cua_driver: worker panicked",
      unreachable: false,
    });
  });

  it("never pastes a healthy log, and falls back to the probe's own message", () => {
    const verdict = judgeDesktopProbeFailure(new Error("CUA health report is failed"), HEALTHY_STARTUP_LOG);
    expect(verdict).toEqual({ desktopError: "CUA health report is failed", unreachable: false });
  });

  it("removes banner noise from the probe's own message too", () => {
    const failure = new Error(
      "cua-driver v0.34.0 is available (you have v0.20.0)\n   Update with: cua-driver update\n   Release notes: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.0\nerror: no daemon on /opt/ogb/run/cua.sock",
    );
    expect(judgeDesktopProbeFailure(failure, "")).toEqual({
      desktopError: "error: no daemon on /opt/ogb/run/cua.sock",
      unreachable: false,
    });
  });

  it("returns nothing when there is no usable reason at all", () => {
    expect(judgeDesktopProbeFailure(new Error(HEALTHY_STARTUP_LOG), null)).toEqual({
      desktopError: null,
      unreachable: false,
    });
  });
});
