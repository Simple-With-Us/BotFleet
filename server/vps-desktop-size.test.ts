import { describe, expect, it } from "vitest";

import { dockerSecurityIsHardened } from "./container-computer.ts";
import {
  VPS_DEFAULT_CPUS,
  VPS_DEFAULT_MEMORY_GIB,
  normalizeVpsConfig,
  parseConfigPatch,
  vpsCpus,
  vpsMemoryGib,
} from "./config.ts";
import { vpsContainerName, vpsContainerRunArgs, vpsDesktopSize } from "./vps-computer.ts";

const GIB = 1024 * 1024 * 1024;

const hardenedHostConfig = (memoryGib: number, cpus: number) => ({
  Memory: memoryGib * GIB,
  MemorySwap: memoryGib * GIB,
  NanoCpus: cpus * 1_000_000_000,
  PidsLimit: 512,
  CapDrop: ["ALL"],
  CapAdd: ["SETUID", "SETGID"],
  Privileged: false,
  IpcMode: "private",
  ShmSize: 512 * 1024 * 1024,
  CgroupnsMode: "private",
  RestartPolicy: { Name: "unless-stopped" },
});

describe("VPS desktop size", () => {
  it("defaults to a share of a host, not a whole workstation", () => {
    // The Local VM is the only desktop on someone's own machine and gets
    // 8 GiB. A VPS runs one desktop PER BOT on one shared box, so the same
    // number there would fit two bots on a 30 GB server.
    expect(VPS_DEFAULT_MEMORY_GIB).toBeLessThan(8);
    expect(vpsDesktopSize({})).toEqual({ memoryGib: VPS_DEFAULT_MEMORY_GIB, cpus: VPS_DEFAULT_CPUS });
  });

  it("takes the operator's budget when they set one", () => {
    expect(vpsDesktopSize({ vps: { memoryGib: 6, cpus: 3 } })).toEqual({ memoryGib: 6, cpus: 3 });
    expect(vpsMemoryGib({ vps: { memoryGib: 16 } })).toBe(16);
    expect(vpsCpus({ vps: { cpus: 8 } })).toBe(8);
  });

  it("falls back per field, so setting one does not blank the other", () => {
    expect(vpsDesktopSize({ vps: { memoryGib: 6 } })).toEqual({ memoryGib: 6, cpus: VPS_DEFAULT_CPUS });
    expect(vpsDesktopSize({ vps: { cpus: 8 } })).toEqual({ memoryGib: VPS_DEFAULT_MEMORY_GIB, cpus: 8 });
  });

  it("rejects a budget that is a typo rather than an intent", () => {
    expect(() => normalizeVpsConfig({ memoryGib: 0 })).toThrow("vps.memoryGib");
    expect(() => normalizeVpsConfig({ memoryGib: 4096 })).toThrow("vps.memoryGib");
    expect(() => normalizeVpsConfig({ memoryGib: 3.5 })).toThrow("vps.memoryGib");
    expect(() => normalizeVpsConfig({ cpus: 0 })).toThrow("vps.cpus");
    expect(() => normalizeVpsConfig({ cpus: 99 })).toThrow("vps.cpus");
    expect(() => parseConfigPatch({ vps: { memoryGib: 1 } })).toThrow();
  });

  it("keeps a budget set before the host is named", () => {
    // Losing it here would silently discard the setting, and the operator
    // would have no way to tell it had not been saved.
    expect(normalizeVpsConfig({ memoryGib: 6, cpus: 3 })).toEqual({ memoryGib: 6, cpus: 3 });
    expect(normalizeVpsConfig({ sshAlias: "prod", memoryGib: 6 })).toEqual({ sshAlias: "prod", memoryGib: 6 });
  });

  it("builds the container with the budget it was given", () => {
    const args = vpsContainerRunArgs(vpsContainerName("bot-1"), undefined, "aaaaaaaaaaaa", { memoryGib: 6, cpus: 3 });
    expect(args[args.indexOf("--memory") + 1]).toBe("6g");
    expect(args[args.indexOf("--memory-swap") + 1]).toBe("6g");
    expect(args[args.indexOf("--cpus") + 1]).toBe("3");
  });

  it("grades a desktop against the budget asked for, not a constant", () => {
    const six = { memoryBytes: 6 * GIB, nanoCpus: 3_000_000_000, restartPolicy: "unless-stopped" } as const;
    expect(dockerSecurityIsHardened(hardenedHostConfig(6, 3), six)).toBe(true);
    // A container built to a different size is one the caller no longer
    // controls: it must be reported unsafe and replaced, never reused.
    expect(dockerSecurityIsHardened(hardenedHostConfig(8, 4), six)).toBe(false);
    expect(dockerSecurityIsHardened(hardenedHostConfig(6, 4), six)).toBe(false);
  });

  it("still defaults to the Local VM's budget when no caps are passed", () => {
    expect(dockerSecurityIsHardened(hardenedHostConfig(8, 4), { restartPolicy: "unless-stopped" })).toBe(true);
    expect(dockerSecurityIsHardened(hardenedHostConfig(3, 2), { restartPolicy: "unless-stopped" })).toBe(false);
  });
});
