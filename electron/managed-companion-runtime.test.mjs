import fs from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adoptableCompanionTarget,
  clearManagedCompanionRuntime,
  liveManagedCompanionRuntime,
  managedCompanionRuntimeDirectory,
  managedCompanionRuntimePath,
  readManagedCompanionRuntime,
  validManagedCompanionRuntime,
  writeManagedCompanionRuntime,
} from "./managed-companion-runtime.mjs";

const SOCKET = "/tmp/omb-companion-origin-runtime/origin.sock";

const claim = (overrides = {}) => ({
  version: 1,
  supervisorPid: 500,
  sidecarPid: 501,
  socketPath: SOCKET,
  companionPort: 8810,
  controlPort: 8811,
  startedAt: "2026-10-15T00:00:00.000Z",
  ...overrides,
});

let home;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "omb-runtime-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("managed companion runtime state", () => {
  it("round-trips a claim and reads it back as a frozen copy", () => {
    writeManagedCompanionRuntime(claim(), { home });
    const read = readManagedCompanionRuntime({ home });
    expect(read).toMatchObject({ sidecarPid: 501, socketPath: SOCKET, controlPort: 8811 });
    expect(Object.isFrozen(read)).toBe(true);
  });

  it("writes the file 0600 inside a private directory", () => {
    writeManagedCompanionRuntime(claim(), { home });
    const file = statSync(managedCompanionRuntimePath(home));
    const directory = statSync(managedCompanionRuntimeDirectory(home));
    expect(file.mode & 0o777).toBe(0o600);
    expect(directory.mode & 0o777).toBe(0o700);
  });

  // The published file is a claim, never a capability. Every way of forging one
  // has to read back as "no supervised sidecar" so the app falls through to
  // forking a sidecar it genuinely owns.
  it.each([
    ["null", null],
    ["a wrong version", claim({ version: 2 })],
    ["a supervisor pid of zero", claim({ supervisorPid: 0 })],
    ["a non-integer sidecar pid", claim({ sidecarPid: 12.5 })],
    ["a socket outside the allocated shape", claim({ socketPath: "/tmp/evil.sock" })],
    ["a TCP address in place of a socket", claim({ socketPath: "http://127.0.0.1:8810" })],
    ["a port out of range", claim({ companionPort: 70_000 })],
    ["port zero", claim({ controlPort: 0 })],
  ])("refuses to write %s", (_label, value) => {
    expect(() => writeManagedCompanionRuntime(value, { home })).toThrow();
    expect(readManagedCompanionRuntime({ home })).toBeNull();
  });

  it.each([
    ["a truncated file", "{", null],
    ["an unrelated JSON file", '{"hello":"world"}', null],
    ["an array", "[]", null],
  ])("reads %s as no claim", (_label, contents) => {
    mkdirSync(managedCompanionRuntimeDirectory(home), { recursive: true });
    writeFileSync(managedCompanionRuntimePath(home), contents);
    expect(readManagedCompanionRuntime({ home })).toBeNull();
  });

  it("rejects a world-readable file rather than adopting it", () => {
    writeManagedCompanionRuntime(claim(), { home });
    chmodSync(managedCompanionRuntimePath(home), 0o644);
    expect(readManagedCompanionRuntime({ home })).toBeNull();
  });

  it("clears the claim and leaves nothing behind", () => {
    writeManagedCompanionRuntime(claim(), { home });
    expect(clearManagedCompanionRuntime({ home })).toBe(true);
    expect(readManagedCompanionRuntime({ home })).toBeNull();
    expect(clearManagedCompanionRuntime({ home })).toBe(false);
  });

  it("never lets a directory or symlink stand in for the claim", () => {
    const target = managedCompanionRuntimePath(home);
    mkdirSync(managedCompanionRuntimeDirectory(home), { recursive: true });
    mkdirSync(target);
    expect(readManagedCompanionRuntime({ home })).toBeNull();
    expect(clearManagedCompanionRuntime({ home })).toBe(false);
  });

  // The published pids are the difference between "the supervisor is running"
  // and "a file survived a crash". Only the former may be adopted.
  it("requires both pids to be alive before a claim is live", () => {
    writeManagedCompanionRuntime(claim(), { home });
    const bothAlive = (pid) => pid === 500 || pid === 501;
    expect(liveManagedCompanionRuntime({ home, isProcessAlive: bothAlive })).not.toBeNull();
    // Supervisor gone: the sidecar is an orphan even though it still answers.
    expect(liveManagedCompanionRuntime({ home, isProcessAlive: (pid) => pid === 501 })).toBeNull();
    // Sidecar gone: the socket is stale even though the supervisor still runs.
    expect(liveManagedCompanionRuntime({ home, isProcessAlive: (pid) => pid === 500 })).toBeNull();
    expect(liveManagedCompanionRuntime({ home, isProcessAlive: () => false })).toBeNull();
  });

  it("exposes a validator that agrees with itself", () => {
    expect(validManagedCompanionRuntime(claim())).not.toBeNull();
    expect(validManagedCompanionRuntime(claim({ socketPath: undefined }))).toBeNull();
  });
});

// This is the security decision the whole fix rests on: the app may only treat
// a sidecar it did not fork as its own once that sidecar proves, over its
// socket, that it is the companion for that exact pid.
describe("adopting a supervised sidecar", () => {
  const bothAlive = (pid) => pid === 500 || pid === 501;

  it("adopts a claim whose pids are alive and whose socket answers as the companion", async () => {
    writeManagedCompanionRuntime(claim(), { home });
    const probed = [];
    const adopted = await adoptableCompanionTarget({
      home,
      isProcessAlive: bothAlive,
      probeOwnership: async (target) => {
        probed.push(target);
        return true;
      },
    });
    expect(adopted).toMatchObject({ sidecarPid: 501, supervisorPid: 500 });
    expect(adopted.target).toEqual({ pid: 501, socketPath: SOCKET });
    expect(probed).toEqual([{ pid: 501, socketPath: SOCKET }]);
  });

  it.each([
    ["the socket does not answer as the companion", bothAlive, async () => false],
    ["the supervisor is gone", (pid) => pid === 501, async () => true],
    ["the sidecar is gone", (pid) => pid === 500, async () => true],
    ["nothing is alive", () => false, async () => true],
  ])("refuses to adopt when %s", async (_label, isProcessAlive, probeOwnership) => {
    writeManagedCompanionRuntime(claim(), { home });
    const adopted = await adoptableCompanionTarget({ home, isProcessAlive, probeOwnership });
    expect(adopted).toBeNull();
  });

  it("refuses to adopt a socket that throws rather than answering false", async () => {
    writeManagedCompanionRuntime(claim(), { home });
    const adopted = await adoptableCompanionTarget({
      home,
      isProcessAlive: bothAlive,
      probeOwnership: async () => {
        throw new Error("probe exploded");
      },
    });
    // A probe that cannot answer has not proven ownership, and "not proven" must
    // never read as "proven".
    expect(adopted).toBeNull();
  });

  it("refuses to adopt when there is no runtime file at all", async () => {
    const probe = vi.fn(async () => true);
    const adopted = await adoptableCompanionTarget({
      home,
      isProcessAlive: bothAlive,
      probeOwnership: probe,
    });
    expect(adopted).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  // The guardian inherits its fail-closed guarantees from the app, so the
  // adopted target has to be the same shape the app always validated before
  // pointing the guardian at a sidecar it had forked.
  it("hands back a target the guardian's own validator accepts", async () => {
    writeManagedCompanionRuntime(claim(), { home });
    const adopted = await adoptableCompanionTarget({
      home,
      isProcessAlive: bothAlive,
      probeOwnership: async () => true,
    });
    const { validCompanionOriginTarget } = await import("./companion-origin-gateway.mjs");
    expect(validCompanionOriginTarget(adopted.target)).toBe(true);
  });
});

describe("managed companion supervisor", () => {
  /** A fake sidecar child that records its kills and can be ended on demand. */
  function sidecar(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    return child;
  }

  it("refuses to publish a sidecar whose private origin does not answer", async () => {
    const { runSupervisedCompanion } = await import("./managed-companion-supervisor.mjs");
    const child = sidecar(4242);

    const outcome = await runSupervisedCompanion({
      entry: "/nonexistent/companion.js",
      endpoint: { pid: process.pid, socketPath: SOCKET, directory: null },
      spawnProcess: vi.fn(() => child),
      readControlState: async () => ({ pid: child.pid }),
      // The control port answers with our pid, but the ownership probe — the
      // check that actually proves the socket belongs to this sidecar — fails.
      probeOwnership: async () => false,
      readyTimeoutMs: 40,
      readyIntervalMs: 5,
      home,
      log: () => {},
    });

    expect(outcome.status).toBe("unverified");
    // Nothing was published, so no app can adopt a sidecar that was never proven.
    expect(readManagedCompanionRuntime({ home })).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });

  // A listener on the control port is not proof of identity. A leftover or
  // hand-started sidecar answers the same request with a different pid, and
  // adopting it would leave two processes fighting over the device port.
  it("refuses to publish when the control port answers with another pid", async () => {
    const { runSupervisedCompanion } = await import("./managed-companion-supervisor.mjs");
    const child = sidecar(4343);

    const outcome = await runSupervisedCompanion({
      entry: "/nonexistent/companion.js",
      endpoint: { pid: process.pid, socketPath: SOCKET, directory: null },
      spawnProcess: vi.fn(() => child),
      readControlState: async () => ({ pid: 999_999 }),
      probeOwnership: async () => true,
      readyTimeoutMs: 40,
      readyIntervalMs: 5,
      home,
      log: () => {},
    });

    expect(outcome.status).toBe("unverified");
    expect(readManagedCompanionRuntime({ home })).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });

  it("publishes a verified sidecar and clears the claim when it exits", async () => {
    const { runSupervisedCompanion } = await import("./managed-companion-supervisor.mjs");
    const child = sidecar(4444);

    const run = runSupervisedCompanion({
      entry: "/nonexistent/companion.js",
      endpoint: { pid: process.pid, socketPath: SOCKET, directory: null },
      spawnProcess: vi.fn(() => child),
      readControlState: async () => ({ pid: child.pid }),
      probeOwnership: async () => true,
      readyTimeoutMs: 200,
      readyIntervalMs: 5,
      home,
      log: () => {},
    });

    // Give the readiness loop a tick to publish, then end the sidecar.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const published = readManagedCompanionRuntime({ home });
    expect(published).toMatchObject({ sidecarPid: 4444, socketPath: SOCKET });
    expect(published.supervisorPid).toBe(process.pid);

    child.exitCode = 0;
    child.emit("exit", 0, null);

    const outcome = await run;
    expect(outcome).toMatchObject({ status: "exited", code: 0 });
    // A claim left behind after exit is what would let a dead sidecar be adopted.
    expect(readManagedCompanionRuntime({ home })).toBeNull();
  });

  it("stops the sidecar and publishes nothing when the runtime file cannot be written", async () => {
    const { runSupervisedCompanion } = await import("./managed-companion-supervisor.mjs");
    const child = sidecar(4545);

    // A runtime file cannot be written under a path whose parent is a file.
    const blocked = path.join(home, "blocked");
    writeFileSync(blocked, "not a directory");

    const outcome = await runSupervisedCompanion({
      entry: "/nonexistent/companion.js",
      endpoint: { pid: process.pid, socketPath: SOCKET, directory: null },
      spawnProcess: vi.fn(() => child),
      readControlState: async () => ({ pid: child.pid }),
      probeOwnership: async () => true,
      readyTimeoutMs: 200,
      readyIntervalMs: 5,
      home: blocked,
      log: () => {},
    });

    // Unpublished is fail-closed: an unverifiable sidecar must not keep running
    // unsupervised, because the app would then fork a second one onto its port.
    expect(outcome.status).toBe("unpublished");
    expect(child.kill).toHaveBeenCalled();
  });

  it("strips inherited origin variables from the sidecar environment", async () => {
    const { supervisedCompanionEnvironment } = await import("./managed-companion-supervisor.mjs");
    const child = supervisedCompanionEnvironment(
      {
        entry: "/x/companion.js",
        harnessPort: 8799,
        companionPort: 8810,
        controlPort: 8811,
        socketPath: SOCKET,
      },
      {
        environment: {
          HOME: "/Users/jay",
          PATH: "/usr/bin",
          OMB_COMPANION_INTERNAL_ORIGIN: "/tmp/attacker/origin.sock",
          OMB_COMPANION_HOSTED_URL: "https://evil.example",
        },
      },
    );
    // The supervisor's own allocation must win over anything inherited.
    expect(child.OMB_COMPANION_INTERNAL_ORIGIN).toBe(SOCKET);
    expect(child.OMB_COMPANION_HOSTED_URL).toBeUndefined();
    expect(child.OMB_COMPANION_PORT).toBe("8810");
    expect(child.HOME).toBe("/Users/jay");
  });
});

describe("managed companion supervisor arguments", () => {
  it("defaults the harness port and accepts an explicit one", async () => {
    const { supervisorArguments } = await import("./managed-companion-supervisor.mjs");
    expect(supervisorArguments([])).toMatchObject({ harnessPort: 8799 });
    expect(supervisorArguments(["--harness-port", "9000"])).toMatchObject({ harnessPort: 9000 });
  });

  // An argument this build does not understand is a mistake in the plist, and
  // quietly ignoring it would run the supervisor against the wrong port.
  it("rejects an unsupported flag, a missing value and a bad port", async () => {
    const { supervisorArguments } = await import("./managed-companion-supervisor.mjs");
    expect(() => supervisorArguments(["--sidecar-port", "8810"])).toThrow(/not supported/);
    expect(() => supervisorArguments(["--harness-port"])).toThrow(/no value/);
    expect(() => supervisorArguments(["--harness-port", "0"])).toThrow(/invalid/);
    expect(() => supervisorArguments(["--harness-port", "abc"])).toThrow(/invalid/);
  });
});