import { describe, expect, it } from "vitest";

import { CUA_SOCKET, DISPLAY } from "./container-computer.ts";
import {
  ensureSharedVpsSessionExecArgs,
  isSharedVpsMode,
  sharedVpsContainerLifecycleBlocked,
  vpsDriverDisplay,
  vpsDriverSocket,
  vpsOccupancyKey,
  vpsSharedBotSession,
  vpsSharedDisplayForBot,
} from "./vps-shared-session.ts";
import { SHARED_VPS_TARGET, perBotVpsTarget, vpsTargetFor } from "./vps-computer.ts";
import type { AppConfig } from "./config.ts";
import { ExactTurnLeases } from "./turn-safety.ts";

function cfgWithVpsMode(mode: "shared" | "per-bot"): AppConfig {
  // SAFETY: AppConfig's remaining sections are optional; this test supplies
  // only botDefaults.vpsMode for shared vs per-bot routing.
  return { botDefaults: { vpsMode: mode } } as AppConfig;
}

describe("vps shared session identity", () => {
  it("keeps one shared container target while giving each bot its own occupancy key", () => {
    const sharedCfg = cfgWithVpsMode("shared");
    expect(vpsTargetFor(sharedCfg, "bot-a")).toBe(SHARED_VPS_TARGET);
    expect(vpsTargetFor(sharedCfg, "bot-b")).toBe(SHARED_VPS_TARGET);
    expect(vpsOccupancyKey(sharedCfg, "bot-a")).not.toBe(vpsOccupancyKey(sharedCfg, "bot-b"));
    expect(vpsOccupancyKey(sharedCfg, "bot-a")).toBe(perBotVpsTarget("bot-a").key);
  });

  it("derives distinct display and socket identities per bot on shared mode", () => {
    const a = vpsSharedBotSession("bot-a");
    const b = vpsSharedBotSession("bot-b");
    expect(a.display).not.toBe(b.display);
    expect(a.socket).not.toBe(b.socket);
    expect(a.display).toMatch(/^:\d+$/);
    expect(a.display).not.toBe(":1");
    expect(a.socket).toMatch(/^\/run\/user\/1000\/botfleet-cua-[a-f0-9]+\.sock$/);
  });

  it("never maps distinct bot ids to the same X display (regression: bot-11 vs bot-16)", () => {
    expect(vpsSharedDisplayForBot("bot-11")).not.toBe(vpsSharedDisplayForBot("bot-16"));
    expect(vpsSharedBotSession("bot-11").display).not.toBe(vpsSharedBotSession("bot-16").display);
    const displays = new Set(["bot-11", "bot-16", "bot-a", "bot-b", "bot-ensure"].map((id) => vpsSharedDisplayForBot(id)));
    expect(displays.size).toBe(5);
  });

  it("falls back to the container default socket and display in per-bot mode", () => {
    const perBotCfg = cfgWithVpsMode("per-bot");
    expect(isSharedVpsMode(perBotCfg)).toBe(false);
    expect(vpsDriverSocket(perBotCfg, "bot-x")).toBe(CUA_SOCKET);
    expect(vpsDriverDisplay(perBotCfg, "bot-x")).toBe(DISPLAY);
    expect(vpsOccupancyKey(perBotCfg, "bot-x")).toBe(perBotVpsTarget("bot-x").key);
  });

  it("builds a session ensure exec that targets the bot's display and socket", () => {
    const session = vpsSharedBotSession("bot-ensure");
    const args = ensureSharedVpsSessionExecArgs("botfleet-vps-shared", session);
    expect(args).toContain("botfleet-vps-shared");
    expect(args.join("\n")).toContain(session.display);
    expect(args.join("\n")).toContain(session.socket);
    expect(args.join("\n")).toContain("Xvfb");
  });
});

describe("shared VPS concurrent leases", () => {
  it("lets two bots claim the shared container at once with distinct occupancy keys", () => {
    const leases = new ExactTurnLeases();
    const sharedCfg = cfgWithVpsMode("shared");
    const a = leases.claim("bot-a", "thread-a", 10, vpsOccupancyKey(sharedCfg, "bot-a"));
    const b = leases.claim("bot-b", "thread-b", 11, vpsOccupancyKey(sharedCfg, "bot-b"));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(leases.size).toBe(2);
  });

  it("still refuses a second occupancy claim on the same per-bot key from another bot", () => {
    const leases = new ExactTurnLeases();
    const key = perBotVpsTarget("bot-a").key;
    expect(leases.claim("bot-a", "thread-a", 1, key)).not.toBeNull();
    expect(leases.claim("bot-b", "thread-b", 2, key)).toBeNull();
  });

  it("still serializes the legacy shared target key when used directly", () => {
    const leases = new ExactTurnLeases();
    expect(leases.claim("bot-a", "thread-a", 1, "shared")).not.toBeNull();
    expect(leases.claim("bot-b", "thread-b", 2, "shared")).toBeNull();
  });
});

describe("shared VPS container lifecycle guard", () => {
  it("blocks sleep/remove/stop when any bot holds a lease but this bot does not", () => {
    const sharedCfg = cfgWithVpsMode("shared");
    expect(
      sharedVpsContainerLifecycleBlocked(sharedCfg, "bot-b", 2, false, false),
    ).toBe(true);
    expect(
      sharedVpsContainerLifecycleBlocked(sharedCfg, "bot-b", 0, false, false),
    ).toBe(false);
    expect(
      sharedVpsContainerLifecycleBlocked(sharedCfg, "bot-b", 1, true, false),
    ).toBe(true);
    expect(
      sharedVpsContainerLifecycleBlocked(sharedCfg, "bot-b", 1, false, true),
    ).toBe(true);
  });

  it("does not block per-bot mode based on foreign lease count alone", () => {
    const perBotCfg = cfgWithVpsMode("per-bot");
    expect(sharedVpsContainerLifecycleBlocked(perBotCfg, "bot-b", 3, false, false)).toBe(false);
  });
});
