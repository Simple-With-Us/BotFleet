import { describe, expect, it } from "vitest";
import { derivedCapability, firstCommandWord, hostCanRunCommand, MAC_ONLY_COMMANDS } from "./mac-only-capabilities.ts";

describe("the Mac-only command table", () => {
  it("names the plan's commands and derives macos with the recorded reason", () => {
    expect(MAC_ONLY_COMMANDS).toEqual(["xcodebuild", "xcrun", "simctl", "codesign", "notarytool", "osascript", "open"]);
    expect(derivedCapability("xcodebuild -scheme App build")).toEqual({ capability: "macos", command: "xcodebuild", reason: "needs xcodebuild" });
    expect(derivedCapability("/usr/bin/codesign --sign - app")).toMatchObject({ capability: "macos", command: "codesign" });
    expect(derivedCapability("DEVELOPER_DIR=/x xcrun simctl list")).toMatchObject({ command: "xcrun" });
  });
  it("treats swift build as Mac-only only under a Mac path", () => {
    expect(derivedCapability("swift build", { cwd: "/Users/jay/app" })).toMatchObject({ capability: "macos", command: "swift build" });
    expect(derivedCapability("swift build", { cwd: "/srv/app" })).toBeNull();
    expect(derivedCapability("swift test", { cwd: "/Users/jay/app" })).toBeNull();
  });
  it("leaves ordinary commands automatic and checks a host's capabilities", () => {
    expect(firstCommandWord("  pnpm test && echo done")).toBe("pnpm");
    expect(derivedCapability("pnpm test")).toBeNull();
    expect(hostCanRunCommand(["shell"], "pnpm test")).toBe(true);
    expect(hostCanRunCommand(["shell"], "open .")).toBe(false);
    expect(hostCanRunCommand(["shell", "macos"], "open .")).toBe(true);
  });
});
