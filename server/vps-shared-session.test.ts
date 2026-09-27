import { describe, expect, it } from "vitest";

import { CUA_SOCKET, DISPLAY } from "./container-computer.ts";
import {
  ensureSharedVpsSessionExecArgs,
  isSharedVpsMode,
  vpsDriverDisplay,
  vpsDriverSocket,
  vpsOccupancyKey,
  vpsSharedBotSession,
} from "./vps-shared-session.ts";
import { SHARED_VPS_TARGET, perBotVpsTarget, vpsTargetFor } from "./vps-computer.ts";
import type { AppConfig } from "./config.ts";
import { ExactTurnLeases } from "./turn-safety.ts";

const sharedCfg = { botDefaults: { vpsMode: "shared" } } as AppConfig;
const perBotCfg = { botDefaults: { vpsMode: "per-bot" } } as AppConfig;

describe("vps shared session identity", () => {
  it("keeps one shared container target while giving each bot its own occupancy key", () => {
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

  it("falls back to the container default socket and display in per-bot mode", () => {
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
