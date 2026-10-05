import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NATIVE_PROBE_ATTEMPTS,
  NATIVE_PROBE_TIMEOUT_MS,
  classifyNativeProbe,
  nativeProbeFailureMessage,
  oneLine,
  probeNativeSync,
  probeNativeVersion,
} from "./native-version-probe.mjs";
import {
  CUA_RELEASE,
  cachedDriverAction,
  cuaDriverFailureMessage,
  matchCuaDriverVersion,
  probeCuaDriver,
} from "./prepare-cua.mjs";

/** The shape `spawnSync` really returns, so the classifier is exercised
 * against Node's contract rather than a convenient shape of our own.  A
 * timeout is `error.code === "ETIMEDOUT"` with the child killed: `status` is
 * null and `signal` is set. */
function probeResult(overrides = {}) {
  return { status: 0, signal: null, stdout: "", stderr: "", ...overrides };
}

function timedOutResult(binary = "/staged/binary") {
  return probeResult({
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error(`spawnSync ${binary} ETIMEDOUT`), { code: "ETIMEDOUT" }),
  });
}

function fakeSpawn(responses) {
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push({ binary, args, options });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  return { spawn, calls };
}

const quiet = { log: () => {} };
const matchCua = matchCuaDriverVersion;

describe("the shared native version probe", () => {
  it("waits 60s and allows one retry by default, not a few-second ceiling", () => {
    expect(NATIVE_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(NATIVE_PROBE_ATTEMPTS).toBe(2);
    const { spawn, calls } = fakeSpawn([probeResult({ stdout: "cua-driver 1.2.3\n" })]);
    probeNativeVersion("/staged/binary", { spawn, matchVersion: matchCua, ...quiet });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeout).toBe(60_000);
  });

  it("refuses to guess a matcher, so a caller cannot silently probe nothing", () => {
    expect(() => probeNativeVersion("/staged/binary", { spawn: () => probeResult(), ...quiet })).toThrow(
      /matchVersion/,
    );
  });

  it("retries a timeout and accepts whatever the retry found", () => {
    const { spawn, calls } = fakeSpawn([timedOutResult(), probeResult({ stdout: "cua-driver 1.2.3\n" })]);
    const probe = probeNativeVersion("/staged/binary", { spawn, matchVersion: matchCua, ...quiet });
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe("1.2.3");
    expect(calls).toHaveLength(2);
  });

  it("never spends a second attempt on a deterministic failure", () => {
    for (const [reason, response] of [
      ["status", probeResult({ status: 3, stderr: "no such architecture\n" })],
      ["signal", probeResult({ status: null, signal: "SIGKILL" })],
      ["version", probeResult({ stdout: "cua-driver 0.1.0\n" })],
      ["spawn", probeResult({ status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) })],
    ]) {
      const { spawn, calls } = fakeSpawn([response]);
      const probe = probeNativeVersion("/staged/binary", { spawn, matchVersion: matchCua, ...quiet });
      expect(probe.reason).toBe(reason);
      expect(calls).toHaveLength(1);
    }
  });

  it("reads the version from either stream and names all four failure causes", () => {
    expect(classifyNativeProbe(probeResult({ stderr: "cua-driver 2.0.0\n" }), matchCua)).toMatchObject({
      ok: true,
      version: "2.0.0",
    });
    expect(classifyNativeProbe(timedOutResult(), matchCua).reason).toBe("timeout");
    expect(classifyNativeProbe(probeResult({ status: 7 }), matchCua).reason).toBe("status");
    expect(classifyNativeProbe(probeResult({ status: null, signal: "SIGTERM" }), matchCua).reason).toBe("signal");
    expect(classifyNativeProbe(probeResult({ status: 0, stdout: "unrelated\n" }), matchCua).reason).toBe("version");
  });

  it("appends the evidence a person needs and truncates a chatty binary", () => {
    const message = nativeProbeFailureMessage("tool did not identify", {
      reason: "timeout",
      attempt: 2,
      attempts: 2,
      timeoutMs: 60_000,
      result: timedOutResult(),
    });
    expect(message).toMatch(/tool did not identify \(the version probe timed out on attempt 2 of 2 at 60s each;/);
    expect(message).toContain("status=null");
    expect(message).toContain("signal=SIGTERM");
    expect(message).toContain("ETIMEDOUT");
    expect(oneLine("x".repeat(500), 200)).toHaveLength(200);
    expect(oneLine("")).toBe("");
  });

  it("lets a caller keep its own wording for a cause", () => {
    const message = nativeProbeFailureMessage("thing was wrong", { reason: "version", result: {} }, {
      causes: { version: () => "it ran but did not report the pinned version" },
    });
    expect(message).toContain("it ran but did not report the pinned version");
  });

  it("exposes the sync entry point under the name execFileSync call sites expect", () => {
    expect(probeNativeSync).toBe(probeNativeVersion);
  });

  it("forwards spawnOptions such as env into the child", () => {
    const { spawn, calls } = fakeSpawn([probeResult({ stdout: "cua-driver 1.2.3\n" })]);
    probeNativeVersion("/staged/binary", {
      spawn,
      matchVersion: matchCua,
      spawnOptions: { env: { LANG: "C" } },
      ...quiet,
    });
    expect(calls[0].options.env).toEqual({ LANG: "C" });
  });

  it("announces the retry so a stalled build says why it paused", () => {
    const lines = [];
    probeNativeVersion("/staged/binary", {
      spawn: fakeSpawn([timedOutResult()]).spawn,
      matchVersion: matchCua,
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/timed out after 60s .* retrying \(attempt 2 of 2\)/);
  });
});

describe("the CUA driver version probe", () => {
  it("reads the version out of the driver's own output", () => {
    expect(matchCuaDriverVersion("cua-driver 0.20.0 (universal)\n")).toBe("0.20.0");
    expect(matchCuaDriverVersion("something else\n")).toBeNull();
  });

  it("reports a missing file as missing instead of running anything", () => {
    const probe = probeCuaDriver(join(tmpdir(), "botfleet-cua-absent-binary"));
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("missing");
  });

  it("retries a timeout and takes the retry's answer", () => {
    const directory = mkdtempSync(join(tmpdir(), "botfleet-cua-probe-"));
    const binary = join(directory, "cua-driver");
    writeFileSync(binary, "", { mode: 0o700 });
    const { spawn, calls } = fakeSpawn([
      timedOutResult(binary),
      probeResult({ stdout: `cua-driver ${CUA_RELEASE.version}\n` }),
    ]);
    const probe = probeCuaDriver(binary, { spawn, ...quiet });
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe(CUA_RELEASE.version);
    expect(calls[0].args).toEqual(["--version"]);
    expect(calls[0].options.timeout).toBe(60_000);
    expect(calls).toHaveLength(2);
  });

  it("survives a pinned binary on a busy host: the Oct 1 regression", () => {
    // The old code returned null for a timeout, which the cache then read as
    // "this binary is wrong". Two 5s probes in a row, both timing out, was the
    // Oct 1 failure with a 40MB download in the middle of it.
    const directory = mkdtempSync(join(tmpdir(), "botfleet-cua-probe-"));
    const binary = join(directory, "cua-driver");
    writeFileSync(binary, "", { mode: 0o700 });
    const { spawn, calls } = fakeSpawn([timedOutResult(binary)]);
    const probe = probeCuaDriver(binary, { spawn, ...quiet });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("timeout");
    expect(calls).toHaveLength(2);
    // The cause a person can act on, not "the wrong version".
    const message = cuaDriverFailureMessage(binary, probe, CUA_RELEASE.version);
    expect(message).toMatch(/the version probe timed out on attempt 2 of 2 at 60s each/);
    expect(message).not.toMatch(/did not report the expected version/);
  });
});

describe("what an unverified cached CUA driver should trigger", () => {
  it("reuses a cache the probe confirmed", () => {
    expect(cachedDriverAction({ ok: true, version: "0.20.0" })).toEqual({
      reuse: true,
      redownload: false,
      reason: "verified",
    });
  });

  it("does not re-download on a timeout: the same bytes would arrive again", () => {
    const action = cachedDriverAction({ ok: false, reason: "timeout" });
    expect(action).toEqual({ reuse: false, redownload: false, reason: "timeout" });
  });

  it("re-downloads when the cache is genuinely wrong or unrunnable", () => {
    for (const reason of ["version", "spawn", "status", "signal", "missing"]) {
      expect(cachedDriverAction({ ok: false, reason })).toEqual({
        reuse: false,
        redownload: true,
        reason,
      });
    }
  });
});
