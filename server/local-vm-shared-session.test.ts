import { describe, expect, it } from "vitest";

import { botDesktopSession } from "./bot-desktop-session.ts";
import { containerComputerMcp, SHARED_LOCAL_VM_TARGET, type LocalVmTarget } from "./container-computer.ts";
import {
  ensureLocalVmSessionExecArgs,
  localVmSharedBotSession,
  localVmSharedLaneKey,
} from "./local-vm-shared-session.ts";

/** The shared container target, carrying one bot's per-bot desktop identity —
 * exactly the shape `localVmTargetForBot` builds in shared mode. */
function sharedTargetFor(botId: string): LocalVmTarget {
  const session = localVmSharedBotSession(botId);
  return { ...SHARED_LOCAL_VM_TARGET, laneKey: `localvm-bot:${session.short}`, session };
}

describe("shared Local VM per-bot sessions", () => {
  it("gives two bots distinct displays, sockets and screenshot paths", () => {
    const a = localVmSharedBotSession("bot-a");
    const b = localVmSharedBotSession("bot-b");

    expect(a.display).not.toBe(b.display);
    expect(a.socket).not.toBe(b.socket);
    expect(a.screenshotPath).not.toBe(b.screenshotPath);
    // Both stay inside the bounded display range, and both sockets stay on the
    // per-bot path rather than the shared one the supervisor owns.
    expect(a.display).toMatch(/^:\d+$/);
    expect(b.display).toMatch(/^:\d+$/);
    expect(a.socket).toMatch(/^\/run\/user\/1000\/botfleet-cua-[a-f0-9]{12}\.sock$/);
    expect(b.socket).not.toBe("/run/user/1000/botfleet-cua.sock");
    // Neither bot may land on the supervisor's :1 desktop.
    expect(a.display).not.toBe(":1");
    expect(b.display).not.toBe(":1");
  });

  it("is deterministic per bot id", () => {
    expect(localVmSharedBotSession("bot-a")).toEqual(localVmSharedBotSession("bot-a"));
    expect(localVmSharedLaneKey("bot-a")).toBe(localVmSharedLaneKey("bot-a"));
    expect(localVmSharedLaneKey("bot-a")).not.toBe(localVmSharedLaneKey("bot-b"));
  });

  it("threads each bot's socket into its own MCP bridge", () => {
    const a = containerComputerMcp("podman", undefined, sharedTargetFor("bot-a"));
    const b = containerComputerMcp("podman", undefined, sharedTargetFor("bot-b"));

    // The bridge argv carries the socket last; the two bots must not collide.
    expect(a.args.at(-1)).toBe(localVmSharedBotSession("bot-a").socket);
    expect(b.args.at(-1)).toBe(localVmSharedBotSession("bot-b").socket);
    expect(a.args.at(-1)).not.toBe(b.args.at(-1));
    // Same shared container, different desktops.
    expect(a.args[2]).toBe(b.args[2]);
  });

  it("leaves the historical shared target on the :1 desktop and its socket", () => {
    const launch = containerComputerMcp("docker", undefined, SHARED_LOCAL_VM_TARGET);
    expect(launch.args.at(-1)).toBe("/run/user/1000/botfleet-cua.sock");
  });

  it("builds an idempotent, runtime-agnostic ensure argv that never touches :1", () => {
    const session = localVmSharedBotSession("bot-a");
    const argv = ensureLocalVmSessionExecArgs("botfleet-vm", session);
    const script = argv[argv.length - 1];

    // Built through cuaExecArgs, so the runtime is supplied by the caller and
    // this works on podman as well as docker.
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("botfleet-vm");
    // cuaExecArgs passes the display as a DISPLAY env pair, not a bare arg.
    expect(argv).toContain(`DISPLAY=${session.display}`);
    // It runs a shell script (`sh -ec <script>`), not the driver binary.
    expect(argv[argv.length - 3]).toBe("sh");
    expect(argv[argv.length - 2]).toBe("-ec");
    // Exits 0 when the socket already answers — that is what makes it safe to
    // call on every turn.
    expect(script).toContain("set -eu");
    expect(script).toContain("status --socket");
    expect(script).toContain("exit 0");
    // The supervisor's own desktop is never a target of this script.
    expect(script).not.toContain('DISPLAY=":1"');
    expect(script).not.toContain("botfleet-cua.sock");
  });
});

describe("shared Local VM lease lanes", () => {
  it("keys lanes by bot while the container key stays shared", () => {
    // The container identity must NOT become per-bot: lifecycle and idle
    // teardown resolve containers by it.
    const a = sharedTargetFor("bot-a");
    const b = sharedTargetFor("bot-b");
    expect(a.key).toBe(b.key);
    expect(a.laneKey).not.toBe(b.laneKey);
  });
});

describe("bot desktop session scheme", () => {
  it("matches the established shared-VPS scheme for the same bot", () => {
    // One hash scheme for both runtimes, distinguished only by screenshot prefix.
    const vps = botDesktopSession("bot-a", "vps");
    const local = botDesktopSession("bot-a", "local-vm");
    expect(local.display).toBe(vps.display);
    expect(local.socket).toBe(vps.socket);
    expect(local.session).toBe(vps.session);
    expect(local.screenshotPath).not.toBe(vps.screenshotPath);
  });
});
