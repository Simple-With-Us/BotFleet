import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  cloudflaredArchiveCacheDirectory,
  currentOnlyFromEnv,
  describeDownloadFailure,
  downloadRelease,
  executableTarget,
  parsePrepareCloudflaredArgs,
  sha256,
  targetForCurrentHost,
  targetsForHost,
  targetsForPreparation,
  verifyPinnedBinary,
  verifySha256,
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
