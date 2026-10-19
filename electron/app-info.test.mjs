import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { appRuntimeInfo, appRuntimeSummary, buildNumberFromVersion } = require("./app-info.cjs");

describe("build number", () => {
  it("reads the build number off the 1.0.<commit_count> scheme", () => {
    expect(buildNumberFromVersion("1.0.1284")).toBe("1284");
    expect(buildNumberFromVersion("1.0.7")).toBe("7");
  });

  it("refuses to invent a build number from a version that is not x.y.z", () => {
    expect(buildNumberFromVersion("1.0.0-beta.3")).toBeNull();
    expect(buildNumberFromVersion("1.0")).toBeNull();
    expect(buildNumberFromVersion("")).toBeNull();
    expect(buildNumberFromVersion(undefined)).toBeNull();
  });
});

describe("runtime info", () => {
  it("carries the versions the running process reported", () => {
    const info = appRuntimeInfo({
      version: "1.0.1284",
      platform: "darwin",
      arch: "arm64",
      electron: "38.1.0",
      node: "22.14.0",
      packaged: true,
    });
    expect(info).toEqual({
      version: "1.0.1284",
      build: "1284",
      platform: "darwin",
      arch: "arm64",
      electron: "38.1.0",
      node: "22.14.0",
      packaged: true,
      harness: null,
    });
  });

  it("never invents a build number when the version is missing", () => {
    const info = appRuntimeInfo();
    expect(info.version).toBe("unknown");
    expect(info.build).toBeNull();
    expect(appRuntimeSummary(info)).not.toContain("build 0");
  });
});

describe("runtime summary", () => {
  it("puts the version first and marks an unpackaged run", () => {
    const summary = appRuntimeSummary(
      appRuntimeInfo({
        version: "1.0.1284",
        platform: "darwin",
        arch: "arm64",
        electron: "38.1.0",
        node: "22.14.0",
        packaged: false,
      }),
    );
    expect(summary).toBe("1.0.1284  ·  build 1284  ·  electron 38.1.0  ·  node 22.14.0  ·  darwin arm64  ·  dev build");
  });

  it("omits the build segment rather than printing a bare dash for an odd version", () => {
    const summary = appRuntimeSummary(appRuntimeInfo({ version: "1.0.0-beta.3", packaged: true }));
    expect(summary).toContain("1.0.0-beta.3");
    expect(summary).not.toContain("build ");
    expect(summary).not.toContain("—");
  });

  it("is empty for a missing record, so the panel can hide itself", () => {
    expect(appRuntimeSummary(null)).toBe("");
  });
});