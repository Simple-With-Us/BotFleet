import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { appRuntimeInfo, appRuntimeSummary, cleanVersion } = require("./app-info.cjs");

describe("version reporting", () => {
  it("reports the version the running process gave us, untouched", () => {
    expect(cleanVersion("1.0.31")).toBe("1.0.31");
    expect(cleanVersion("v1.0.31")).toBe("v1.0.31");
  });

  it("says unknown rather than inventing a version", () => {
    expect(cleanVersion(undefined)).toBe("unknown");
    expect(cleanVersion("")).toBe("unknown");
    expect(cleanVersion("   ")).toBe("unknown");
  });

  it("caps an absurd version instead of rendering it whole", () => {
    expect(cleanVersion("9".repeat(500))).toHaveLength(64);
  });
});

describe("runtime info", () => {
  it("carries the versions the running process reported", () => {
    const info = appRuntimeInfo({
      version: "1.0.31",
      platform: "darwin",
      arch: "arm64",
      electron: "44.7.2",
      node: "22.14.0",
      packaged: true,
      harness: "server:8799",
    });
    expect(info).toEqual({
      version: "1.0.31",
      platform: "darwin",
      arch: "arm64",
      electron: "44.7.2",
      node: "22.14.0",
      packaged: true,
      harness: "server:8799",
    });
  });

  it("exposes no build number, because the Mac version is not one", () => {
    // The iOS client ships as 1.0.<commit_count>, but the Mac app carries a
    // hand-maintained semver (latest release v0.1.38). Calling that patch
    // component a build number would print something confidently wrong.
    expect(appRuntimeInfo({ version: "1.0.31" })).not.toHaveProperty("build");
  });
});

describe("runtime summary", () => {
  it("puts the version first and marks an unpackaged run", () => {
    const summary = appRuntimeSummary(
      appRuntimeInfo({
        version: "1.0.31",
        platform: "darwin",
        arch: "arm64",
        electron: "44.7.2",
        node: "22.14.0",
        packaged: false,
        harness: "dev",
      }),
    );
    expect(summary).toBe("1.0.31  ·  electron 44.7.2  ·  node 22.14.0  ·  darwin arm64  ·  dev  ·  dev build");
  });

  it("never labels the patch component as a build number", () => {
    const summary = appRuntimeSummary(appRuntimeInfo({ version: "1.0.31", packaged: true }));
    expect(summary).not.toContain("build 31");
    expect(summary).not.toMatch(/build \d/);
  });

  it("is empty for a missing record, so the panel can hide itself", () => {
    expect(appRuntimeSummary(null)).toBe("");
  });
});