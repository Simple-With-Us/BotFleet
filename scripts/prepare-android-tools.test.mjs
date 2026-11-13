// Where the packager looks for Android Platform Tools before it reaches for
// the network, and what it does when the network is the only option left.
//
// The Mac updater stages a fresh copy of the source for every run, so the
// `dist-native` short-circuit never fires for it: without these lookups every
// packaging run re-downloads 15 MB from Google, and on a slow link that one
// step failed the whole update.  Everything here is driven through injected
// `exists`, `fetchImpl` and `env` so it asserts the same thing on macOS,
// Ubuntu and Windows runners.
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  adbName,
  describeDownloadFailure,
  downloadArchive,
  platformToolsSources,
  sharedCacheDirectory,
  usableSources,
} from "./prepare-android-tools.mjs";

const HOME = join("/home", "jay");

describe("where a copy might already be", () => {
  it("names adb for the platform, not for the runner", () => {
    expect(adbName("darwin")).toBe("adb");
    expect(adbName("linux")).toBe("adb");
    expect(adbName("win32")).toBe("adb.exe");
  });

  it("keeps the shared cache outside any checkout, per platform", () => {
    expect(sharedCacheDirectory({ platform: "darwin", home: HOME }))
      .toBe(join(HOME, "Library", "Caches", "BotFleet", "android-platform-tools"));
    expect(sharedCacheDirectory({ platform: "linux", home: HOME }))
      .toBe(join(HOME, ".cache", "botfleet", "android-platform-tools"));
    expect(sharedCacheDirectory({ platform: "linux", home: HOME, env: { XDG_CACHE_HOME: join("/x", "cache") } }))
      .toBe(join("/x", "cache", "botfleet", "android-platform-tools"));
    expect(sharedCacheDirectory({ platform: "win32", home: HOME, env: { LOCALAPPDATA: join("C:", "local") } }))
      .toBe(join("C:", "local", "BotFleet", "Cache", "android-platform-tools"));
    // An explicit cache wins everywhere, which is how a test rig or a CI
    // runner points the whole thing at scratch space.
    expect(sharedCacheDirectory({ platform: "darwin", home: HOME, env: { BOTFLEET_ANDROID_TOOLS_CACHE: "/tmp/c" } }))
      .toBe("/tmp/c");
  });

  it("orders the places to look, override first and the checkout last", () => {
    const sources = platformToolsSources({
      platform: "darwin",
      home: HOME,
      env: { OMB_ANDROID_PLATFORM_TOOLS_SOURCE: "/opt/tools" },
    });
    expect(sources[0].path).toBe("/opt/tools");
    expect(sources[1].path).toBe(join(HOME, "Library", "Caches", "BotFleet", "android-platform-tools", "darwin"));
    expect(sources[2].path)
      .toBe(join("/Applications", "BotFleet.app", "Contents", "Resources", "android-platform-tools", "darwin"));
    expect(sources.at(-1).path).toBe(join(HOME, "apps", "botfleet-server", "dist-native", "android-platform-tools", "darwin"));
  });

  it("looks in the packaged resources directory on Windows and Linux too", () => {
    const windows = platformToolsSources({
      platform: "win32",
      home: HOME,
      env: { LOCALAPPDATA: join("C:", "local") },
    }).map((source) => source.path);
    expect(windows).toContain(join("C:", "local", "Programs", "BotFleet", "resources", "android-platform-tools", "win32"));

    const linux = platformToolsSources({ platform: "linux", home: HOME }).map((source) => source.path);
    expect(linux).toContain(join("/opt", "BotFleet", "resources", "android-platform-tools", "linux"));
  });

  it("keeps only the places that hold an adb, in the same order", () => {
    const sources = platformToolsSources({ platform: "darwin", home: HOME });
    const cache = join(HOME, "Library", "Caches", "BotFleet", "android-platform-tools", "darwin");
    const checkout = join(HOME, "apps", "botfleet-server", "dist-native", "android-platform-tools", "darwin");
    const present = new Set([join(cache, "adb"), join(checkout, "adb")]);
    const usable = usableSources(sources, { platform: "darwin", exists: (path) => present.has(path) });
    expect(usable.map((source) => source.path)).toEqual([cache, checkout]);

    // Nothing anywhere is the only case that has to go to the network.
    expect(usableSources(sources, { platform: "darwin", exists: () => false })).toEqual([]);
  });
});

describe("the download of last resort", () => {
  it("names the network cause rather than the exception class", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeDownloadFailure(timeout, 600_000)).toBe("the download timed out after 600s");
    expect(describeDownloadFailure(new Error("getaddrinfo ENOTFOUND dl.google.com")))
      .toBe("getaddrinfo ENOTFOUND dl.google.com");
  });

  it("retries a transfer that drops before it gives up", async () => {
    let calls = 0;
    const body = await downloadArchive("https://example.invalid/tools.zip", {
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode("zip").buffer };
      },
      wait: async () => {},
      log: () => {},
    });
    expect(calls).toBe(3);
    expect(body.toString()).toBe("zip");
  });

  it("gives up after the last attempt, saying what the network did", async () => {
    let calls = 0;
    await expect(downloadArchive("https://example.invalid/tools.zip", {
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
    await expect(downloadArchive("https://example.invalid/tools.zip", {
      fetchImpl: async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }),
      attempts: 2,
      wait: async () => {},
      log: () => {},
    })).rejects.toThrow(/HTTP 503/);
  });
});
