// The gate on POST /api/desktop/open — the route that lets a paired phone put
// a window on the owner's Mac.
//
// Why this needs its own test rather than a comment: the route has TWO
// independent gates, and the one that looks like the protection is not the one
// doing the work. `isLoopbackAddress` answers "did this request arrive from
// this machine", which is true for every phone, because the Companion sidecar
// deliberately replays a device request to 127.0.0.1 and strips Host and
// Origin so the device cannot spoof either (companion/src/proxy.ts says this in
// its own header). So the loopback check is satisfied by the sidecar's design,
// and the owner's toggle is what actually decides. Both must stay.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { remoteDesktopLaunchAllowed } from "./config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SOURCE = readFileSync(join(ROOT, "server/index.ts"), "utf8");

/** The body of the `/api/desktop/open` branch, so ordering can be asserted. */
function desktopOpenBranch(): string {
  const start = SERVER_SOURCE.indexOf('path === "/api/desktop/open"');
  expect(start, "the /api/desktop/open route must still exist").toBeGreaterThan(-1);
  const end = SERVER_SOURCE.indexOf('path === "/api/system/shutdown"', start);
  expect(end, "the shutdown route must follow it").toBeGreaterThan(start);
  return SERVER_SOURCE.slice(start, end);
}

describe("remoteDesktopLaunchAllowed", () => {
  it("is off for a config that never mentions it", () => {
    // The whole point of the default: an existing config file, or a fresh one,
    // must not hand a phone the ability to open a window on this Mac.
    expect(remoteDesktopLaunchAllowed({})).toBe(false);
    expect(remoteDesktopLaunchAllowed({ server: {} })).toBe(false);
  });

  it("is off for anything that is not exactly true", () => {
    expect(remoteDesktopLaunchAllowed({ server: { allowRemoteDesktopLaunch: false } })).toBe(false);
    // A stored file is data, not a contract; a truthy-looking string must not
    // become permission.
    expect(remoteDesktopLaunchAllowed({ server: { allowRemoteDesktopLaunch: "true" as never } })).toBe(false);
    expect(remoteDesktopLaunchAllowed({ server: { allowRemoteDesktopLaunch: 1 as never } })).toBe(false);
  });

  it("is on only when the owner said so", () => {
    expect(remoteDesktopLaunchAllowed({ server: { allowRemoteDesktopLaunch: true } })).toBe(true);
  });
});

describe("the /api/desktop/open route", () => {
  const branch = desktopOpenBranch();

  it("keeps the loopback check", () => {
    expect(branch).toContain("isLoopbackAddress");
    expect(branch).toContain("the desktop can only be opened from this computer");
  });

  it("keeps the owner's toggle as a separate gate, checked after the loopback one", () => {
    const loopback = branch.indexOf("isLoopbackAddress");
    const policy = branch.indexOf("remoteDesktopLaunchAllowed");
    const opens = branch.indexOf("openBotFleetDesktop");

    expect(loopback).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(-1);
    expect(opens).toBeGreaterThan(-1);
    // Order is the behavior: local-only first, then the owner's setting, and
    // only then the physical action.
    expect(loopback).toBeLessThan(policy);
    expect(policy).toBeLessThan(opens);
  });

  it("answers the two refusals differently, so the phone can tell them apart", () => {
    // A generic failure string is what made this ambiguous in the first
    // place: the person could not tell "you are not allowed" from "something
    // broke", so there was nothing to act on.
    expect(branch).toContain("Opening the desktop app from iOS is disabled in Mac settings");
    expect(branch).toMatch(/json\(res, 403/);
  });

  it("never opens the desktop before both gates have run", () => {
    expect(branch.indexOf("openBotFleetDesktop")).toBeGreaterThan(branch.indexOf("remoteDesktopLaunchAllowed"));
  });
});

describe("the shutdown route", () => {
  it("is loopback-only like every route that stops something on this computer", () => {
    const start = SERVER_SOURCE.indexOf('path === "/api/system/shutdown"');
    expect(start).toBeGreaterThan(-1);
    const branch = SERVER_SOURCE.slice(start, start + 1200);
    expect(branch).toContain("isLoopbackAddress");
    expect(branch).toContain("requestHarnessShutdown");
  });
});