// The OS backstop is separate from the in-process guard.  This spawns a
// plain Node script, with no guard installed, so a refused connect is
// the kernel boundary and not a patched Socket.prototype.connect.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { darwinNetworkProfile, killPluginProcess, pluginOsNetworkWrap, spawnPluginProcess } from "./plugin-net-isolate.ts";

const children: Array<{ pid: number | undefined; wrapped: boolean; kill: () => void }> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe("plugin network OS boundary", () => {
  it("does not ask seatbelt to name a host it cannot express", () => {
    const empty = darwinNetworkProfile([]);
    expect(empty).toContain("(deny network*)");
    expect(empty).not.toContain("network-outbound");
    expect(empty).not.toContain("api.example.com");
    expect(empty).not.toContain("127.0.0.1");

    // A hostname, an IP, and a quote-breaking token are all non-empty
    // lists.  Seatbelt would reject the first two and could be escaped
    // by the third, so none of them is turned into a profile.
    expect(darwinNetworkProfile(["api.example.com:443"])).toBeNull();
    expect(darwinNetworkProfile(["127.0.0.1:9"])).toBeNull();
    expect(darwinNetworkProfile(['evil"); (allow network*)'])).toBeNull();

    expect(pluginOsNetworkWrap({
      platform: "darwin",
      networkAllow: [],
      linuxNetns: false,
      darwinSandbox: true,
    })).toBe("seatbelt");
    expect(pluginOsNetworkWrap({
      platform: "darwin",
      networkAllow: ["api.example.com:443"],
      linuxNetns: false,
      darwinSandbox: true,
    })).toBe("none");
    expect(pluginOsNetworkWrap({
      platform: "darwin",
      networkAllow: ["127.0.0.1:9"],
      linuxNetns: false,
      darwinSandbox: true,
    })).toBe("none");
    expect(pluginOsNetworkWrap({
      platform: "linux",
      networkAllow: ["api.example.com:443"],
      linuxNetns: true,
      darwinSandbox: false,
    })).toBe("none");
    expect(pluginOsNetworkWrap({
      platform: "linux",
      networkAllow: [],
      linuxNetns: true,
      darwinSandbox: false,
    })).toBe("netns");
  });

  it("refuses a raw connect when this host has an OS network boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botfleet-net-os-"));
    const script = join(dir, "connect.mjs");
    writeFileSync(script, `
      import net from "node:net";
      const socket = net.connect({ host: "203.0.113.1", port: 80, timeout: 1000 });
      const finish = (code) => {
        if (process.send) process.send({ code });
        socket.destroy();
      };
      socket.on("connect", () => finish("connected"));
      socket.on("error", (error) => finish(error.code || "error"));
      socket.setTimeout(1000, () => finish("timeout"));
    `);
    const spawned = spawnPluginProcess({
      execPath: process.execPath,
      args: [script],
      networkAllow: [],
      options: { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
    });
    children.push({
      pid: spawned.child.pid,
      wrapped: spawned.wrapped,
      kill: () => killPluginProcess(spawned.child, spawned.wrapped),
    });
    if (!spawned.wrapped) return;

    const message = await new Promise<{ code: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("os boundary timed out")), 4_000);
      spawned.child.on("message", (value: { code: string }) => {
        clearTimeout(timer);
        resolve(value);
      });
      spawned.child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`wrapper exited ${code} before reporting`));
      });
    });
    expect(message.code).not.toBe("connected");
    expect(["ENETUNREACH", "EPERM", "EACCES", "EHOSTUNREACH", "ENETDOWN"]).toContain(message.code);

    const pid = spawned.child.pid;
    killPluginProcess(spawned.child, true);
    await new Promise((resolve) => spawned.child.on("exit", resolve));
    if (pid !== undefined && process.platform === "linux") {
      const leftover = spawn("ps", ["-p", String(pid)]);
      const status = await new Promise<number | null>((resolve) => leftover.on("exit", resolve));
      expect(status).not.toBe(0);
    }
  });
});
