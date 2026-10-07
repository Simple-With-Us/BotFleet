import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  VERSION_PROBE_ATTEMPTS,
  VERSION_PROBE_TIMEOUT_MS,
  classifyVersionProbe,
  cloudflaredArchiveCacheDirectory,
  currentOnlyFromEnv,
  describeDownloadFailure,
  downloadRelease,
  executableTarget,
  parsePrepareCloudflaredArgs,
  probePinnedVersion,
  sha256,
  targetForCurrentHost,
  targetsForHost,
  targetsForPreparation,
  verifyPinnedBinary,
  verifySha256,
  versionProbeFailureMessage,
} from "./prepare-cloudflared.mjs";

const PINNED_ASSETS = {
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442",
    binarySha256: "b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d",
    archive: true,
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4",
    binarySha256: "b0f770e1e0b281399a57219b840fd8eef1cc25387a404124248157ea2073727a",
    archive: true,
  },
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
    binarySha256: "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2",
    archive: false,
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    binarySha256: "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5",
    archive: false,
  },
};

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function executableFixture(target) {
  const bytes = Buffer.alloc(128);
  if (target === "darwin-arm64" || target === "darwin-x64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (target === "linux-x64") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(0x3e, 18);
  } else if (target === "win32-x64") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(0x8664, 0x44);
  }
  return bytes;
}

describe("pinned cloudflared packaging", () => {
  it("stages both macOS architectures and only shipped desktop targets elsewhere", () => {
    expect(targetsForHost("darwin")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(targetsForHost("linux")).toEqual(["linux-x64"]);
    expect(targetsForHost("win32")).toEqual(["win32-x64"]);
    expect(() => targetsForHost("freebsd")).toThrow(/unsupported/);
  });

  it("stages only the exact current desktop target in development mode", () => {
    expect(targetForCurrentHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(targetForCurrentHost("darwin", "x64")).toBe("darwin-x64");
    expect(targetForCurrentHost("linux", "x64")).toBe("linux-x64");
    expect(targetForCurrentHost("win32", "x64")).toBe("win32-x64");
    expect(targetsForPreparation({ current: true, platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
    ]);
    expect(targetsForPreparation({ current: false, platform: "darwin", arch: "arm64" })).toEqual([
      "darwin-arm64",
      "darwin-x64",
    ]);
    expect(() => targetForCurrentHost("linux", "arm64")).toThrow(/unsupported/);
  });

  it("accepts only the documented current-target CLI option", () => {
    expect(parsePrepareCloudflaredArgs([])).toEqual({ current: false });
    expect(parsePrepareCloudflaredArgs(["--current"])).toEqual({ current: true });
    expect(() => parsePrepareCloudflaredArgs(["--all"])).toThrow(/Usage:/);
    expect(() => parsePrepareCloudflaredArgs(["--current", "--current"])).toThrow(/Usage:/);
  });

  it("stages the current target for development without narrowing package preparation", () => {
    expect(packageJson.scripts["dev:desktop"]).toBe(
      "node scripts/prepare-cloudflared.mjs --current && electron .",
    );
    expect(packageJson.scripts["build:cloudflared"]).toBe(
      "node scripts/prepare-cloudflared.mjs",
    );
  });

  it("pins a complete release asset and digest for every packaged target", () => {
    expect(CLOUDFLARED_VERSION).toBe("2026.8.2");
    expect(CLOUDFLARED_ASSETS).toEqual(PINNED_ASSETS);
  });

  it("rejects altered release bytes", () => {
    const payload = Buffer.from("official bytes");
    const digest = sha256(payload);
    expect(verifySha256(payload, digest)).toBe(digest);
    expect(() => verifySha256(Buffer.from("altered"), digest)).toThrow(/SHA-256 verification/);
  });

  it("recognizes only the executable formats and architectures we ship", () => {
    for (const target of Object.keys(PINNED_ASSETS)) {
      expect(executableTarget(executableFixture(target))).toBe(target);
    }
    expect(() => executableTarget(Buffer.from("not an executable"))).toThrow(/unsupported/);
  });

  it("checks architecture before accepting a pinned executable", () => {
    const bytes = executableFixture("darwin-arm64");
    expect(() => verifyPinnedBinary(bytes, "darwin-x64")).toThrow(/architecture mismatch/);
    expect(() => verifyPinnedBinary(bytes, "darwin-arm64")).toThrow(/SHA-256 verification/);
  });
});

describe("the download of last resort", () => {
  it("names the network cause rather than the exception class", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeDownloadFailure(timeout, 600_000)).toBe("the download timed out after 600s");
    expect(describeDownloadFailure(new Error("getaddrinfo ENOTFOUND github.com")))
      .toBe("getaddrinfo ENOTFOUND github.com");
  });

  it("retries a transfer that drops before it gives up", async () => {
    let calls = 0;
    const body = await downloadRelease("https://example.invalid/cloudflared.tgz", "cloudflared-darwin-arm64.tgz", {
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode("tgz").buffer };
      },
      wait: async () => {},
      log: () => {},
    });
    expect(calls).toBe(3);
    expect(body.toString()).toBe("tgz");
  });

  it("gives up after the last attempt, saying what the network did", async () => {
    let calls = 0;
    await expect(downloadRelease("https://example.invalid/cloudflared.tgz", "cloudflared-darwin-arm64.tgz", {
      fetchImpl: async () => {
        calls += 1;
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
      timeoutMs: 600_000,
      wait: async () => {},
      log: () => {},
    })).rejects.toThrow(/timed out after 600s/);
    expect(calls).toBe(3);
  });

  it("treats a non-2xx answer as a failed attempt, not as an archive", async () => {
    await expect(downloadRelease("https://example.invalid/cloudflared.tgz", "cloudflared-darwin-arm64.tgz", {
      fetchImpl: async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }),
      attempts: 2,
      wait: async () => {},
      log: () => {},
    })).rejects.toThrow(/HTTP 503/);
  });
});

describe("where a downloaded archive is cached", () => {
  const HOME = join("/home", "jay");

  it("keeps the shared cache outside any checkout, per platform", () => {
    expect(cloudflaredArchiveCacheDirectory({ platform: "darwin", home: HOME, env: {} }))
      .toBe(join(HOME, "Library", "Caches", "BotFleet", "cloudflared-archives"));
    expect(cloudflaredArchiveCacheDirectory({ platform: "linux", home: HOME, env: {} }))
      .toBe(join(HOME, ".cache", "botfleet", "cloudflared-archives"));
    expect(cloudflaredArchiveCacheDirectory({ platform: "linux", home: HOME, env: { XDG_CACHE_HOME: join("/x", "cache") } }))
      .toBe(join("/x", "cache", "botfleet", "cloudflared-archives"));
    expect(cloudflaredArchiveCacheDirectory({ platform: "win32", home: HOME, env: { LOCALAPPDATA: join("C:", "local") } }))
      .toBe(join("C:", "local", "BotFleet", "Cache", "cloudflared-archives"));
    // The documented override still wins everywhere, which is how a
    // reviewed local download is used instead of the network.
    expect(cloudflaredArchiveCacheDirectory({ platform: "darwin", home: HOME, env: { OMB_CLOUDFLARED_ARCHIVE_DIR: "/tmp/c" } }))
      .toBe("/tmp/c");
  });
});

describe("the Mac updater's single-architecture staging", () => {
  it("only takes --current from the environment when it is exactly set", () => {
    expect(currentOnlyFromEnv({})).toBe(false);
    expect(currentOnlyFromEnv({ OMB_CLOUDFLARED_CURRENT: "1" })).toBe(true);
    expect(currentOnlyFromEnv({ OMB_CLOUDFLARED_CURRENT: "true" })).toBe(false);
    expect(currentOnlyFromEnv({ OMB_CLOUDFLARED_CURRENT: "" })).toBe(false);
  });
});

/** The shape `spawnSync` really returns, so the classifier is exercised
 * against Node's contract rather than a convenient shape of our own.  A
 * timeout is `error.code === "ETIMEDOUT"` with the child killed: `status` is
 * null and `signal` is set. */
function probeResult(overrides = {}) {
  return { status: 0, signal: null, stdout: "", stderr: "", ...overrides };
}

function timedOutResult(binary = "/staged/cloudflared") {
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

describe("identifying the staged cloudflared executable", () => {
  it("waits 60s and allows one retry by default, not the old 10s ceiling", () => {
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(VERSION_PROBE_ATTEMPTS).toBe(2);
    const { spawn, calls } = fakeSpawn([
      probeResult({ stdout: `cloudflared version ${CLOUDFLARED_VERSION} (abc)\n` }),
    ]);
    probePinnedVersion("/staged/cloudflared", { spawn, ...quiet });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["version"]);
    expect(calls[0].options.timeout).toBe(60_000);
  });

  it("retries once past a timeout and accepts the answer the retry gets", () => {
    // The Oct 1, 2026 incident: the binary was correct, the host was not.
    const { spawn, calls } = fakeSpawn([
      timedOutResult(),
      probeResult({ stdout: `cloudflared version ${CLOUDFLARED_VERSION} (abc)\n` }),
    ]);
    const probe = probePinnedVersion("/staged/cloudflared", { spawn, ...quiet });
    expect(probe.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reports a timeout as a timeout, not as a version mismatch", () => {
    const { spawn, calls } = fakeSpawn([timedOutResult()]);
    const probe = probePinnedVersion("/staged/cloudflared", { spawn, ...quiet });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("timeout");
    expect(calls).toHaveLength(2);

    const message = versionProbeFailureMessage("darwin-arm64", probe);
    expect(message).toContain(`darwin-arm64 executable did not identify as cloudflared ${CLOUDFLARED_VERSION}`);
    expect(message).toMatch(/timed out on attempt 2 of 2 at 60s each/);
    expect(message).toContain("status=null");
    expect(message).toContain("signal=SIGTERM");
    expect(message).toContain("ETIMEDOUT");
    // The cause a person can act on, not the "corrupt download" dead end.
    expect(message).not.toMatch(/did not report the pinned version/);
  });

  it("does not accept a pinned version mention on stderr alone", () => {
    const { spawn, calls } = fakeSpawn([
      probeResult({
        stdout: "cloudflared version 2026.7.1\n",
        stderr: `cloudflared version ${CLOUDFLARED_VERSION}\n`,
      }),
    ]);
    const probe = probePinnedVersion("/staged/cloudflared", { spawn, ...quiet });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("version");
    expect(calls).toHaveLength(1);
  });

  it("still reports a genuine version mismatch, without retrying", () => {
    const { spawn, calls } = fakeSpawn([
      probeResult({ stdout: "cloudflared version 2026.7.1\n" }),
    ]);
    const probe = probePinnedVersion("/staged/cloudflared", { spawn, ...quiet });
    expect(probe.reason).toBe("version");
    expect(calls).toHaveLength(1);

    const message = versionProbeFailureMessage("linux-x64", probe);
    expect(message).toMatch(/it ran but did not report the pinned version/);
    expect(message).toContain("output=cloudflared version 2026.7.1");
    expect(message).not.toMatch(/timed out/);
  });

  it("names a non-zero exit and a killed child distinctly, and never retries either", () => {
    const failed = probePinnedVersion("/staged/cloudflared", {
      spawn: fakeSpawn([probeResult({ status: 3, stderr: "cannot find the right architecture\n" })]).spawn,
      ...quiet,
    });
    expect(failed.reason).toBe("status");
    const failedMessage = versionProbeFailureMessage("linux-x64", failed);
    expect(failedMessage).toMatch(/exited with status 3/);
    expect(failedMessage).toContain("status=3");

    const killedSpawn = fakeSpawn([probeResult({ status: null, signal: "SIGKILL" })]);
    const killed = probePinnedVersion("/staged/cloudflared", { spawn: killedSpawn.spawn, ...quiet });
    expect(killed.reason).toBe("signal");
    expect(killedSpawn.calls).toHaveLength(1);
    expect(versionProbeFailureMessage("linux-x64", killed)).toMatch(/killed by SIGKILL/);
  });

  it("does not spend a second attempt on a binary that cannot be run at all", () => {
    const missing = fakeSpawn([
      probeResult({
        status: null,
        error: Object.assign(new Error("spawnSync /staged/cloudflared ENOENT"), { code: "ENOENT" }),
      }),
    ]);
    const probe = probePinnedVersion("/staged/cloudflared", { spawn: missing.spawn, ...quiet });
    expect(probe.reason).toBe("spawn");
    expect(missing.calls).toHaveLength(1);
    expect(versionProbeFailureMessage("linux-x64", probe)).toMatch(/could not be run/);
  });

  it("requires the version line on stdout and ignores stderr-only mentions", () => {
    expect(
      classifyVersionProbe(
        probeResult({ stdout: `cloudflared version ${CLOUDFLARED_VERSION} (abc)\n` }),
      ),
    ).toEqual({
      ok: true,
      reason: "version",
    });
    expect(
      classifyVersionProbe(probeResult({ stderr: `cloudflared version ${CLOUDFLARED_VERSION}\n` })),
    ).toEqual({
      ok: false,
      reason: "version",
    });
    expect(classifyVersionProbe(probeResult({ status: 0, stdout: "some other tunnel client\n" }))).toEqual({
      ok: false,
      reason: "version",
    });
  });

  it("announces the retry so a stalled build says why it paused", () => {
    const lines = [];
    probePinnedVersion("/staged/cloudflared", {
      spawn: fakeSpawn([timedOutResult()]).spawn,
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/timed out after 60s .* retrying \(attempt 2 of 2\)/);
  });
});
